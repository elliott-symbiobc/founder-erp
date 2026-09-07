"""Match synced Gmail messages onto pipeline entities (investors, deals).

Called from the per-message loop in contacts_sync so a single Gmail crawl feeds
both the contact timeline and the pipeline boards — no second API budget.

Matching is deliberately two-sided:

  * by address — covers mail sent straight from Gmail, which is how the team
    actually works today;
  * by thread — covers a reply from a colleague at the same firm, or from an
    address nobody had recorded, as long as we know the conversation.

An inbound message flips the investor to "Awaiting Us" (they answered, so
the ball is ours) and cancels any queued follow-up that was waiting on silence.
An outbound one flips it to "Awaiting Investor" — mail sent straight from Gmail
is the same act as sending from the panel, and the board should not disagree
with the mailbox about who owes the next move.
"""
import logging
import re

logger = logging.getLogger(__name__)

AWAITING_US = "Awaiting Us"


def is_our_address(email, our_domains) -> bool:
    """True for one of our own connected mailboxes.

    Our own address sits on every message we send and every reply we get, so
    registering it against a record makes that record match the entire mailbox.
    One investor imported with nikolai@example.com in its email field had
    collected 179 addresses and 806 messages that way before anyone noticed.
    """
    return (email or "").split("@")[-1].lower() in set(our_domains or ())


def existing_message_id(cur, entity_type, entity_id, rfc_message_id):
    """The row this record already holds for this email, or None.

    Gmail message ids and thread ids are per-mailbox: an email Cc'd to two
    connected accounts is crawled twice under two unrelated ids, and the
    (entity, gmail_message_id) key cannot see it is one email. The RFC822
    Message-ID is the identifier both copies share.
    """
    if not rfc_message_id:
        return None
    cur.execute(
        """SELECT message_id FROM comm_messages
           WHERE entity_type = %s AND entity_id = %s AND rfc_message_id = %s
           ORDER BY created_at LIMIT 1""",
        (entity_type, entity_id, rfc_message_id),
    )
    row = cur.fetchone()
    return row["message_id"] if row else None


def record_mailbox_copy(cur, message_id, mailbox_user_id, gmail_message_id,
                        thread_id):
    """Note that this mailbox holds this email, and what it calls it.

    The second mailbox's copy does not belong on the timeline twice, but the
    ids it carries are the only ones a send from that mailbox can thread
    against — hand Gmail another mailbox's threadId and it 404s.
    """
    if not (message_id and mailbox_user_id and gmail_message_id):
        return
    cur.execute(
        """INSERT INTO comm_message_mailboxes
             (message_id, mailbox_user_id, gmail_message_id, thread_id)
           VALUES (%s, %s, %s, %s)
           ON CONFLICT (message_id, mailbox_user_id) DO UPDATE
              SET thread_id = COALESCE(EXCLUDED.thread_id,
                                       comm_message_mailboxes.thread_id)""",
        (message_id, mailbox_user_id, gmail_message_id, thread_id),
    )


def _entities_for(cur, from_email, recipients, thread_id):
    """[(entity_type, entity_id)] this message belongs to."""
    hits: set[tuple[str, str]] = set()
    addresses = [a for a in ([from_email] + list(recipients)) if a]

    if addresses:
        cur.execute(
            """SELECT DISTINCT entity_type, entity_id::text
               FROM comm_addresses
               WHERE lower(email) = ANY(%s)""",
            ([a.lower() for a in addresses],),
        )
        hits.update((r["entity_type"], r["entity_id"]) for r in cur.fetchall())

    if thread_id:
        cur.execute(
            """SELECT DISTINCT entity_type, entity_id::text
               FROM comm_messages WHERE thread_id = %s""",
            (thread_id,),
        )
        hits.update((r["entity_type"], r["entity_id"]) for r in cur.fetchall())

    return sorted(hits)


# Words that carry no identifying weight in a funder's subject line. Three
# groups, and all three are needed: ordinary English, the vocabulary every
# funding programme shares, and the boilerplate of email subject lines. Without
# the first group a word like "your" appears in exactly one title, which the
# rarity test below would then read as a strong identifier.
_TITLE_STOPWORDS = {
    # ordinary English
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "by",
    "with", "from", "your", "yours", "our", "ours", "this", "that", "these",
    "those", "they", "them", "their", "there", "then", "than", "have", "has",
    "had", "been", "being", "will", "would", "could", "should", "about",
    "after", "before", "during", "into", "over", "under", "above", "below",
    "between", "through", "more", "most", "some", "such", "only", "also",
    "just", "very", "well", "were", "what", "when", "where", "which", "while",
    "here", "each", "both", "other", "another", "same", "does", "done",
    "make", "makes", "made", "next", "last", "first", "back", "down", "again",
    "once", "ever", "never", "always", "please", "thanks", "thank", "dear",
    "best", "regards", "hello", "know", "like", "want", "take", "help",
    # every funding programme says these
    "grant", "grants", "fund", "funds", "funding", "program", "programs",
    "programme", "programmes", "competition", "competitions", "challenge",
    "challenges", "award", "awards", "prize", "prizes", "accelerator",
    "fellowship", "application", "applications", "apply", "applying", "call",
    "calls", "open", "new", "innovation", "innovative", "initiative",
    "opportunity", "opportunities", "startup", "startups", "business",
    "company", "companies", "venture", "ventures", "cohort", "round",
    "phase", "stage", "seed", "early", "tech", "technology",
    # subject-line boilerplate
    "update", "updates", "updated", "news", "newsletter", "weekly", "monthly",
    "daily", "today", "tomorrow", "week", "month", "year", "years", "date",
    "dates", "deadline", "deadlines", "info", "information", "details",
    "detail", "contact", "email", "message", "reply", "sent", "send",
    "submit", "submitted", "submission", "submissions", "form", "forms",
    "link", "links", "click", "view", "read", "learn", "join", "register",
    "registration", "sign", "free", "soon", "live", "final", "draft",
    "review", "notice", "alert", "reminder", "invitation", "invite",
    "announcement", "announcing", "launch", "welcome", "congratulations",
    "2024", "2025", "2026", "2027", "2028",
}

# A token identifies an opportunity only if few titles contain it. 'ffar'
# appears in three (the same funder's three programmes) and should still match
# all three — an email from that funder is genuinely ambiguous between them, and
# offering all three is the honest answer. A token in more titles than this is
# describing a category, not a record.
_DISTINCTIVE_MAX_TITLES = 3

# Share of real subject lines a word may appear in and still identify anything.
# Measured on the live mailbox: 'arch' 0.27%, 'techrise' 0.19%, 'ffar' 0.01%
# against 'equipment' 1.89%, 'pitch' 1.37%, 'food' 3.17%. The cut sits below
# the first group of noise words with room to spare.
_CORPUS_RARE_MAX_SHARE = 0.005


def _title_tokens(title: str) -> set:
    """Distinctive words in an opportunity title, lowercased.

    Short and generic words are dropped so that "The Grant | TRANSFORM" matches
    on 'transform' alone rather than on 'grant', which would hit half the inbox.
    """
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    return {w for w in words if len(w) > 3 and w not in _TITLE_STOPWORDS}


def suggest_funding_matches(cur, *, msg_id, thread_id, from_email, to_emails,
                            subject, snippet, occurred_at, user_id, our_domains):
    """Offer a message to funding opportunities that plausibly own it.

    Applications have no contacts, so the exact-address rule that files investor
    mail never fires for them. Two weaker signals stand in:

      domain  — the sender's domain is one of the opportunity's match_domains,
                derived from its source_link (130)
      subject — a distinctive word from the opportunity title appears in the
                subject line

    Neither is strong enough to write into a timeline shared with thousands of
    investor emails, so this only ever writes to funding_email_suggestions. A
    human accepting one is what produces the real comm_messages row — and that
    also learns the address, after which the exact-address rule takes over and
    this heuristic is never consulted for that conversation again.
    """
    sender_domain = (from_email or "").split("@")[-1].lower().lstrip("<").strip()
    if not sender_domain:
        return 0
    # Our own outbound mail carries our domain; matching on it would offer every
    # message we send to every opportunity.
    if sender_domain in our_domains:
        recipient_domains = {
            (a or "").split("@")[-1].lower().strip() for a in (to_emails or [])
        } - set(our_domains)
        if not recipient_domains:
            return 0
        domains = sorted(d for d in recipient_domains if d)
        direction = "outbound"
    else:
        domains = [sender_domain]
        direction = "inbound"

    subject_norm = _normalise_subject(subject)

    # Strongest signal first, and it is not a guess: a human already attached
    # something from this thread to this opportunity. Everything below is
    # inference; this is a decision that was made.
    thread_owners: set = set()
    if thread_id:
        cur.execute(
            """SELECT DISTINCT opportunity_id::text AS id
                 FROM funding_email_suggestions
                WHERE thread_id = %s AND status = 'accepted'""",
            (thread_id,))
        thread_owners = {r["id"] for r in cur.fetchall()}

    cur.execute(
        """SELECT opportunity_id::text AS id, match_domains, match_phrases
           FROM funding_opportunities
           WHERE cardinality(match_domains) > 0
              OR cardinality(match_phrases) > 0
              OR opportunity_id::text = ANY(%s)""",
        (list(thread_owners) or [""],))
    rows = cur.fetchall()

    written = 0
    for r in rows:
        reasons = []
        if r["id"] in thread_owners:
            reasons.append("thread")
        if r["match_domains"] and any(d in r["match_domains"] for d in domains):
            reasons.append("domain")
        # One phrase, already filtered to something rare in the real mailbox
        # (132), so a single hit is evidence on its own.
        if r["match_phrases"] and any(f" {p} " in subject_norm for p in r["match_phrases"]):
            reasons.append("subject")

        if not reasons:
            continue

        cur.execute(
            """INSERT INTO funding_email_suggestions
                   (opportunity_id, gmail_message_id, thread_id, subject, snippet,
                    from_email, to_emails, occurred_at, direction, match_reason, seen_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (opportunity_id, gmail_message_id) DO NOTHING""",
            (r["id"], msg_id, thread_id, (subject or "")[:500], (snippet or "")[:500],
             from_email, list(to_emails or []), occurred_at, direction, reasons, user_id),
        )
        written += cur.rowcount
    return written


def _normalise_subject(subject: str) -> str:
    """' word word word ' — padded so a phrase test is a plain substring check
    that still respects word boundaries."""
    return " " + " ".join(re.findall(r"[a-z0-9]+", (subject or "").lower())) + " "


# Function words may not start or end a signature phrase. "the future" and
# "for food" are not names; "arch grants" is. Deliberately narrow — this is not
# _TITLE_STOPWORDS, because 'grants' is useless alone yet essential in
# "arch grants".
_PHRASE_EDGE_WORDS = {
    "the", "of", "for", "and", "or", "a", "an", "in", "on", "at", "to", "by",
    "with", "is", "are", "was", "were", "be", "been", "your", "our", "their",
    "its", "this", "that", "from", "us", "we", "you", "as", "it", "if", "has",
    "have", "how", "why", "all", "new", "my", "me", "s", "t",
}


def _candidate_phrases(title: str) -> list:
    """Two-word signatures from a title, plus the bare word for one-word titles.

    Single characters are kept inside a phrase: "SPACE-F" is only identifiable
    as "space f", and dropping the F leaves the generic word 'space', which
    matched "Vendor space available". The edge-word rule still stops a function
    word or a stray letter from anchoring a phrase.
    """
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    phrases = [
        " ".join(words[i:i + 2]) for i in range(len(words) - 1)
        if words[i] not in _PHRASE_EDGE_WORDS and words[i + 1] not in _PHRASE_EDGE_WORDS
    ]
    # A one-word title has no phrase; the word itself is the signature and
    # matches by the same padded-substring rule.
    return phrases or sorted(_title_tokens(title))


def recompute_funding_match_phrases(cur) -> int:
    """Give each opportunity one signature phrase, judged against the real mailbox.

    Rarity is measured on the subject lines we actually receive, not on the 121
    titles — 'equipment' is unique among titles and ubiquitous in the inbox.

    Every phrase rare enough to qualify is kept. Keeping only the rarest was
    tried and is wrong: "Arch Grants 2026 Startup Competition" then stored
    "2026 startup", which is rare because it is meaningless, and lost
    "arch grants" — the phrase that actually finds the mail. A phrase matching
    nothing costs nothing, so there is no reason to discard one.

    Phrases are safe to union in a way single words were not. The 108-message
    false positive that motivated this came from five ordinary WORDS being
    unioned; two-word phrases are specific enough that the union stays tight.

    Re-run on every backfill: a mailbox that starts receiving a new newsletter
    can turn a once-distinctive phrase into noise.
    """
    cur.execute(
        """SELECT DISTINCT external_id, subject
             FROM contact_interactions
            WHERE interaction_type IN ('email_received', 'email_sent')
              AND subject IS NOT NULL""")
    corpus = [_normalise_subject(r["subject"]) for r in cur.fetchall()]
    total = len(corpus)

    # Nothing to calibrate against; claiming a phrase is distinctive would be a
    # guess. Match on domain and attached threads until mail exists.
    if total == 0:
        cur.execute("UPDATE funding_opportunities SET match_phrases = '{}'")
        return 0

    ceiling = max(3, int(total * _CORPUS_RARE_MAX_SHARE))

    cur.execute("SELECT opportunity_id::text AS id, title FROM funding_opportunities")
    rows = cur.fetchall()

    # A phrase used by several titles names a category, not a record. "small
    # business" spans four opportunities and would hand each of them the same
    # forty messages; "arch grants" belongs to one.
    title_phrase_use: dict = {}
    for r in rows:
        for c in set(_candidate_phrases(r["title"])):
            title_phrase_use[c] = title_phrase_use.get(c, 0) + 1

    updated = 0
    for r in rows:
        candidates = [c for c in _candidate_phrases(r["title"])
                      if title_phrase_use.get(c, 0) < 3]

        scored = []
        for c in candidates:
            hits = sum(1 for s in corpus if f" {c} " in s)
            if hits <= ceiling:
                scored.append((hits, c))

        keep = sorted({c for _, c in scored})
        cur.execute(
            "UPDATE funding_opportunities SET match_phrases = %s WHERE opportunity_id = %s",
            (keep, r["id"]))
        updated += 1
    return updated


def _our_domains(cur) -> set:
    """Our own mail domains, so we never match an opportunity on our own address."""
    cur.execute(
        "SELECT DISTINCT lower(split_part(COALESCE(google_email, ''), '@', 2)) AS d "
        "FROM google_oauth_tokens WHERE google_email IS NOT NULL"
    )
    found = {r["d"] for r in cur.fetchall() if r["d"]}
    return found or {"example.com"}


def backfill_funding_suggestions(cur, opportunity_id=None, limit=20000):
    """Offer already-synced mail to funding opportunities.

    suggest_funding_matches only sees messages as the Gmail crawl discovers
    them, so it is blind to everything synced before an opportunity existed —
    which, for a board imported in bulk, is nearly everything. The contacts
    crawl has been recording mail since 2024 in contact_interactions, and that
    is enough to match on: subject, timing, direction and the addresses
    involved. No Gmail call is needed, so this costs no API quota and can be
    re-run freely.

    Idempotent: the UNIQUE (opportunity_id, gmail_message_id) key means an
    already-offered or already-dismissed message is never raised twice.
    """
    # Distinctiveness is judged against the mailbox, so it must be current
    # before anything is offered — a title added since the last sweep has no
    # signature at all until this runs.
    recompute_funding_match_phrases(cur)

    cur.execute(
        """SELECT opportunity_id::text AS id, match_domains, match_phrases
             FROM funding_opportunities
            WHERE (%s::uuid IS NULL OR opportunity_id = %s::uuid)
              AND (cardinality(match_domains) > 0 OR cardinality(match_phrases) > 0)""",
        (opportunity_id, opportunity_id),
    )
    opps = cur.fetchall()
    if not opps:
        return 0

    # One row per message. A message reaching several contacts appears several
    # times in contact_interactions; the addresses are collapsed back together
    # so domain matching sees the whole recipient set at once.
    cur.execute(
        """SELECT ci.external_id AS msg_id,
                  min(ci.subject) AS subject,
                  min(ci.occurred_at) AS occurred_at,
                  min(ci.direction) AS direction,
                  array_agg(DISTINCT lower(c.email)) FILTER (WHERE c.email IS NOT NULL) AS emails
             FROM contact_interactions ci
             JOIN contacts c USING (contact_id)
            WHERE ci.interaction_type IN ('email_received', 'email_sent')
              AND ci.external_id IS NOT NULL
            GROUP BY ci.external_id
            ORDER BY min(ci.occurred_at) DESC
            LIMIT %s""",
        (limit,),
    )
    messages = cur.fetchall()

    our_domains = _our_domains(cur)
    written = 0

    for m in messages:
        subject_norm = _normalise_subject(m["subject"])
        domains_full = {e for e in (m["emails"] or [])
                        if e and e.split("@")[-1] not in our_domains}
        domains = {e.split("@")[-1] for e in domains_full}

        for r in opps:
            reasons = []
            if r["match_domains"] and domains & set(r["match_domains"]):
                reasons.append("domain")
            if r["match_phrases"] and any(f" {p} " in subject_norm for p in r["match_phrases"]):
                reasons.append("subject")
            if not reasons:
                continue

            # contact_interactions records one address per row and no sender
            # column, so from_email stays NULL rather than being guessed at. The
            # outside addresses on the message are kept in to_emails though —
            # accepting learns from those, which is what stops this opportunity
            # needing the heuristic again.
            cur.execute(
                """INSERT INTO funding_email_suggestions
                       (opportunity_id, gmail_message_id, subject, occurred_at,
                        direction, match_reason, to_emails)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (opportunity_id, gmail_message_id) DO NOTHING""",
                (r["id"], m["msg_id"], (m["subject"] or "")[:500],
                 m["occurred_at"], m["direction"], reasons, sorted(domains_full)),
            )
            written += cur.rowcount

    return written


def record_message(cur, *, msg_id, thread_id, from_email, to_emails, subject,
                   snippet, occurred_at, user_id, our_domains, rfc_message_id=None):
    """Record one message against every entity it touches.

    Returns [(entity_type, entity_id, direction)] for the rows that were newly
    written — the ones whose status may need to move.
    """
    entities = _entities_for(cur, from_email, to_emails, thread_id)
    if not entities:
        # Nothing owns it by address or thread. Funding opportunities match on
        # weaker signals, and only ever as a suggestion.
        try:
            suggest_funding_matches(
                cur, msg_id=msg_id, thread_id=thread_id, from_email=from_email,
                to_emails=to_emails, subject=subject, snippet=snippet,
                occurred_at=occurred_at, user_id=user_id, our_domains=our_domains)
        except Exception:
            # A matcher fault must never cost the caller its Gmail crawl.
            logger.exception("funding suggestion matching failed for %s", msg_id)
        return []

    moved = []
    for entity_type, entity_id in entities:
        direction = attach_message(
            cur, entity_type, entity_id, msg_id=msg_id, thread_id=thread_id,
            from_email=from_email, to_emails=to_emails, subject=subject,
            snippet=snippet, occurred_at=occurred_at, user_id=user_id,
            our_domains=our_domains, rfc_message_id=rfc_message_id)
        if direction:
            moved.append((entity_type, entity_id, direction))

    return moved


def attach_message(cur, entity_type, entity_id, *, msg_id, thread_id, from_email,
                   to_emails, subject, snippet, occurred_at, user_id, our_domains,
                   rfc_message_id=None):
    """Put one message on one record, whether or not the matcher would have.

    This is the body of record_message's loop, lifted out so that a person can
    do deliberately what the matcher does by rule: attach a thread that no
    address, domain or subject line would ever have caught. Everything else
    about it is identical — same identity check, same mailbox bookkeeping, same
    address learning — because a hand-attached email that behaves differently
    from a matched one is a second kind of email nobody asked for.

    Returns the direction when a row was written, None when this record already
    held the message.
    """
    # Inbound means it came from outside our own domains — not merely "not from
    # the mailbox owner", so a message from a colleague is still outbound.
    sender_domain = (from_email or "").split("@")[-1].lower()
    inbound = bool(sender_domain) and sender_domain not in our_domains
    direction = "inbound" if inbound else "outbound"

    # Already held, from the other mailbox's crawl. One email, one timeline
    # row — but keep this mailbox's ids, which are the only ones it can
    # thread a reply against.
    held = existing_message_id(cur, entity_type, entity_id, rfc_message_id)
    if held:
        record_mailbox_copy(cur, held, user_id, msg_id, thread_id)
        return None

    cur.execute(
        """INSERT INTO comm_messages
             (entity_type, entity_id, gmail_message_id, thread_id, direction,
              subject, snippet, from_email, to_emails, occurred_at, seen_by,
              rfc_message_id, mailbox_user_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT DO NOTHING
           RETURNING message_id""",
        (entity_type, entity_id, msg_id, thread_id, direction,
         (subject or "(no subject)")[:500], (snippet or "")[:500],
         from_email, list(to_emails), occurred_at, user_id, rfc_message_id,
         # Whose crawl produced this row — and so whose mailbox that thread_id
         # and message id are valid in. They mean nothing in anyone else's.
         user_id),
    )
    if not cur.rowcount:
        return None

    record_mailbox_copy(cur, cur.fetchone()["message_id"], user_id, msg_id, thread_id)
    if inbound:
        _learn_address(cur, entity_type, entity_id, from_email, our_domains)
    else:
        # Mail sent straight from Gmail counts as outreach too, and the date it
        # deserves is the day it was sent, not the day the sync noticed it.
        from app.routers.comms import stamp_outreach_date
        stamp_outreach_date(cur, entity_type, entity_id, occurred_at)
    return direction


def _learn_address(cur, entity_type, entity_id, from_email, our_domains=()):
    """A reply from an unknown address at a known firm teaches us that address."""
    if not from_email or is_our_address(from_email, our_domains):
        return
    cur.execute(
        """INSERT INTO comm_addresses (entity_type, entity_id, email)
           VALUES (%s, %s, %s)
           ON CONFLICT (entity_type, entity_id, email) DO NOTHING""",
        (entity_type, entity_id, from_email.lower()),
    )


AWAITING_THEM = "Awaiting Investor"


def apply_outbound(cur, entity_type, entity_id):
    """We wrote to them, so the ball is theirs — whether the mail was sent from
    the panel or straight from Gmail."""
    if entity_type != "investor":
        return {"flipped": False}
    return {"flipped": _set_status(cur, entity_id, AWAITING_THEM)}


def apply_inbound(cur, entity_type, entity_id, occurred_at):
    """React to a reply: flip the status our way and stand down the chasers."""
    cancelled = _cancel_followups(cur, entity_type, entity_id, occurred_at)
    flipped = False
    if entity_type == "investor":
        flipped = _flip_investor_status(cur, entity_id)
    return {"flipped": flipped, "cancelled": cancelled}


def _flip_investor_status(cur, investor_id):
    return _set_status(cur, investor_id, AWAITING_US)


def _set_status(cur, investor_id, new_status):
    cur.execute(
        "SELECT status, is_priority FROM dilutive_investors WHERE investor_id = %s",
        (investor_id,),
    )
    row = cur.fetchone()
    # Only records actually being worked carry a status at all.
    if not row or not row["is_priority"] or row["status"] == new_status:
        return False

    cur.execute(
        "UPDATE dilutive_investors SET status = %s, updated_at = NOW() WHERE investor_id = %s",
        (new_status, investor_id),
    )
    # Logged so the History feed explains the change rather than the status
    # silently mutating overnight.
    cur.execute(
        """INSERT INTO dilutive_status_history (investor_id, status_from, status_to, changed_by)
           VALUES (%s, %s, %s, NULL)""",
        (investor_id, row["status"], new_status),
    )
    return True


def _cancel_followups(cur, entity_type, entity_id, occurred_at):
    """Kill queued sends that were only waiting for silence."""
    cur.execute(
        """UPDATE scheduled_emails
           SET status = 'cancelled',
               cancelled_reason = 'Reply received',
               updated_at = NOW()
           WHERE entity_type = %s AND entity_id = %s
             AND status = 'scheduled'
             AND cancel_on_reply
             AND watch_from <= %s""",
        (entity_type, entity_id, occurred_at),
    )
    return cur.rowcount


# ── Meetings ─────────────────────────────────────────────────────────────────

def record_meeting(cur, *, event_id, summary, description, attendees, starts_at,
                   ends_at, event_link, user_id, our_domains):
    """Record a calendar event against every entity one of its attendees maps to.

    A meeting is not directional — nobody "sends" it — so `direction` stays NULL
    and `kind` is 'meeting'. Attendees on our own domains are ignored for
    matching: an internal invite is not contact with an investor.
    """
    external = [
        a.lower() for a in attendees
        if a and a.split("@")[-1].lower() not in our_domains
    ]
    if not external:
        return []

    cur.execute(
        """SELECT DISTINCT entity_type, entity_id::text
           FROM comm_addresses WHERE lower(email) = ANY(%s)""",
        (external,),
    )
    entities = [(r["entity_type"], r["entity_id"]) for r in cur.fetchall()]

    recorded = []
    for entity_type, entity_id in entities:
        cur.execute(
            """INSERT INTO comm_messages
                 (entity_type, entity_id, gmail_message_id, kind, direction,
                  subject, snippet, occurred_at, starts_at, ends_at, attendees,
                  event_link, seen_by, mailbox_user_id)
               VALUES (%s, %s, %s, 'meeting', NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (entity_type, entity_id, f"cal:{event_id}",
             (summary or "Meeting")[:500], (description or "")[:500],
             starts_at, starts_at, ends_at, list(attendees), event_link, user_id,
             user_id),
        )
        if cur.rowcount:
            recorded.append((entity_type, entity_id))
    return recorded


# ── Contact promotion ────────────────────────────────────────────────────────

GENERIC_LOCAL = (
    "info", "hello", "contact", "general", "deals", "deal", "application",
    "applications", "apply", "noreply", "no-reply", "ventures", "team",
    "admin", "hi", "support", "inbound", "pitch", "pitches", "submissions",
    "founders", "invest",
)


def ensure_contact_address(cur, entity_type, entity_id, *, email, name=None,
                           role=None, organization=None):
    """Promote a hand-typed contact into a real contact + tracked address.

    Typing a name and email onto an investor used to write two plain columns and
    nothing else — no contact record, and nothing for the Gmail sync to match
    on, so mail with that person was invisible. This makes the fields feed the
    same model the backfill populates.

    Returns the contact_id, or None if there was no address to work with.
    """
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return None
    # Our own mailbox is not a way to reach the investor, and holding it would
    # match this record against every message we have ever sent or received.
    if is_our_address(email, _our_domains(cur)):
        return None

    local = email.split("@")[0]
    is_org = any(local == g or local.startswith(g + ".") or local.startswith(g + "-")
                 for g in GENERIC_LOCAL)
    # A shared inbox represents the firm, so it is named for the firm.
    contact_name = (organization or email) if is_org else ((name or "").strip() or email)

    cur.execute("SELECT contact_id FROM contacts WHERE LOWER(email) = %s LIMIT 1", (email,))
    hit = cur.fetchone()
    if hit:
        contact_id = hit["contact_id"]
        # Fill blanks only — never overwrite what someone curated in Contacts.
        cur.execute(
            """UPDATE contacts
               SET name = CASE WHEN name IS NULL OR name = '' OR LOWER(name) = LOWER(email)
                               THEN %s ELSE name END,
                   organization = COALESCE(organization, %s),
                   title = COALESCE(title, %s),
                   updated_at = NOW()
               WHERE contact_id = %s""",
            (contact_name, organization, role, contact_id),
        )
    else:
        cur.execute(
            """INSERT INTO contacts (name, email, organization, title, tags, notes)
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING contact_id""",
            (contact_name, email, organization, role, ["investor"],
             f"Added from the investor record for {organization or 'an investor'}."),
        )
        contact_id = cur.fetchone()["contact_id"]

    cur.execute(
        """INSERT INTO comm_addresses
             (entity_type, entity_id, email, contact_id, is_organizational)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (entity_type, entity_id, email)
           DO UPDATE SET contact_id = COALESCE(comm_addresses.contact_id, EXCLUDED.contact_id)""",
        (entity_type, entity_id, email, contact_id, is_org),
    )

    # An investor we can email is no longer "LinkedIn only" — the badge exists
    # to explain why there is no mail to track, and that reason has gone.
    if entity_type == "investor":
        cur.execute(
            """UPDATE dilutive_investors
               SET outreach_channel = 'email', updated_at = NOW()
               WHERE investor_id = %s AND outreach_channel <> 'email'""",
            (entity_id,),
        )

    # First address on a record becomes the one the compose box defaults to.
    cur.execute(
        """UPDATE comm_addresses SET is_primary = true
           WHERE entity_type = %s AND entity_id = %s AND lower(email) = %s
             AND NOT EXISTS (SELECT 1 FROM comm_addresses o
                              WHERE o.entity_type = %s AND o.entity_id = %s AND o.is_primary)""",
        (entity_type, entity_id, email, entity_type, entity_id),
    )
    return contact_id
