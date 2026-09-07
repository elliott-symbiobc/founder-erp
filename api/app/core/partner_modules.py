"""partner_modules.py — the single source of truth for partner-facing access.

Two lists used to describe the same thing in different vocabularies: the
frontend named the *modules* a cohort could be granted, and partner_guard named
the *URL segments* each permission unlocked. Nothing checked that they agreed,
so they drifted — `/reports` was reachable by anyone holding an unrelated grant even
though no cohort could be granted Reports at all, and adding a module meant
remembering to edit a file in the other language.

Now a permission declares its own URL footprint once, here:

  PERMISSION_SEGMENTS   permission key -> the API path segments it unlocks
  PARTNER_MODULES       the subset of those that a cohort can actually be
                        granted, with how they present in the sidebar

partner_guard derives its lookup by inverting PERMISSION_SEGMENTS, and the
frontend fetches PARTNER_MODULES over /partners/modules rather than keeping its
own copy. `check_consistency()` runs at import and complains loudly about a
module that grants nothing reachable, which is the failure that used to be
silent.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


# ── permission -> the URL segments it unlocks ─────────────────────────────────
#
# A segment is the first path element of an API route: /projects/abc -> "projects".
# Several permissions may list the same segment; holding ANY of them opens it,
# because one API legitimately serves more than one module. The Enzymes tab
# appears inside both Inventory and System Design, so either grant opens
# /enzymes.
#
# A segment that appears nowhere here is denied to partner accounts. That is
# deliberate: a new router is invisible to partners until someone decides which
# permission should open it.

PERMISSION_SEGMENTS: dict[str, tuple[str, ...]] = {
    # ── Collaboration ──
    "projects":      ("projects", "tasks", "milestones"),

    # ── Staff-only. Not grantable to a cohort, but an admin can still switch
    #    one of these on for one person, so their footprint is declared too. ──
    "contacts":      ("contacts", "advisors"),
    "view_fpa":      ("fpa",),
    "invoices":      ("invoices",),
    "notes":         ("notes",),
}


# ── the modules a cohort can be granted ───────────────────────────────────────

@dataclass(frozen=True)
class PartnerModule:
    """One row of the cohort grant list, and one item in a partner's sidebar.

    `label` is the module's real name as it appears in the staff sidebar, not a
    description invented for the admin screen.
    """
    key: str
    label: str
    href: str
    group: str
    covers: str | None = None

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "href": self.href,
            "group": self.group,
            "covers": self.covers,
        }


MODULE_GROUPS = ["Learning", "Collaboration"]

PARTNER_MODULES: list[PartnerModule] = [
    # Learning is always on for a partner account — it is the role's one
    # default — so it is listed for ordering but is not a real grant.
    PartnerModule("learn", "Learning", "/learn", "Learning"),

    PartnerModule("projects", "Projects", "/projects", "Collaboration"),
]

# `learn` is reached through ALWAYS_ALLOWED_PREFIXES rather than a grant, so it
# is exempt from the "every module must unlock something" check below.
UNGRANTED_MODULES = {"learn"}


# ── derived lookups ───────────────────────────────────────────────────────────

def build_segment_permission() -> dict[str, tuple[str, ...]]:
    """Invert PERMISSION_SEGMENTS into segment -> permissions that open it."""
    out: dict[str, list[str]] = {}
    for permission, segments in PERMISSION_SEGMENTS.items():
        for segment in segments:
            out.setdefault(segment, []).append(permission)
    return {segment: tuple(keys) for segment, keys in out.items()}


def check_consistency(permission_keys: set[str] | None = None) -> list[str]:
    """Report ways the lists could disagree. Returns the problems it found.

    Called at import so a mistake shows up in the logs on the next deploy
    rather than as a 403 a partner has to report.
    """
    problems: list[str] = []

    for module in PARTNER_MODULES:
        if module.key in UNGRANTED_MODULES:
            continue
        if module.key not in PERMISSION_SEGMENTS:
            problems.append(
                f"module {module.key!r} is grantable but unlocks no API segment — "
                f"granting it would put {module.href} in the sidebar and 403 on click"
            )
            continue
        # The page the sidebar links to should be inside what the grant opens,
        # otherwise the module's own landing page is unreachable.
        landing = module.href.strip("/").split("/", 1)[0]
        if landing and landing not in PERMISSION_SEGMENTS[module.key]:
            # Only a warning: some pages are served entirely by another
            # segment's API.
            logger.debug(
                "partner module %s links to /%s, which its own grant does not open",
                module.key, landing,
            )

    if permission_keys is not None:
        for key in PERMISSION_SEGMENTS:
            if key not in permission_keys:
                problems.append(f"PERMISSION_SEGMENTS names unknown permission {key!r}")
        for module in PARTNER_MODULES:
            if module.key not in permission_keys:
                problems.append(f"PARTNER_MODULES names unknown permission {module.key!r}")

    if module_groups := {m.group for m in PARTNER_MODULES} - set(MODULE_GROUPS):
        problems.append(f"modules use groups missing from MODULE_GROUPS: {sorted(module_groups)}")

    return problems


for _problem in check_consistency():
    logger.error("partner module config: %s", _problem)
