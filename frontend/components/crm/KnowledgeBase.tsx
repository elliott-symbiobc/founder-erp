"use client";

import { useState } from "react";
import { CRM_STAGE_GROUPS, STAGE_INFO } from "@/lib/contractStages";

// ── Styles ────────────────────────────────────────────────────────────────────
const CARD = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl";
const H2 = "text-sm font-semibold text-zinc-800 dark:text-zinc-100 uppercase tracking-wide";
const SUB = "text-xs text-zinc-500 dark:text-zinc-400";
const TH = "text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 py-1.5 px-2";
const TD = "align-top py-1.5 px-2 text-xs text-zinc-700 dark:text-zinc-200";
const REQ = "align-top py-1.5 px-2 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 whitespace-nowrap";

// ── Content ───────────────────────────────────────────────────────────────────

// Per-stage "actions that typically happen" + exit reasons, from the pipeline template.
const STAGE_ACTIONS: Record<string, { actions: string; advance: string; lost: string }> = {
  "Lead": {
    actions: "Create Company + Contact records, log the Deal Source, verify contact data, sanity-check ICP fit (feedstock, volume, sector, region), make the first outreach attempt.",
    advance: "Replied to outreach · interest expressed or a meeting scheduled · no ICP disqualifier surfaced.",
    lost: "No reply after the full ~3-week / 6-touch sequence — Expired · invalid contact or no route — Expired · outside ICP — Unqualified · explicit opt-out — No decision.",
  },
  "Prospect": {
    actions: "Create the deal record, capture known Contact/Company/Deal data, secure the initial meeting, confirm a real stream and a real problem exist.",
    advance: "Discovery call completed · a real, accessible feedstock stream and problem confirmed · contact is the decision-maker / key influencer (or routed us to one).",
    lost: "Meeting never scheduled or repeated no-shows — Expired · stream not accessible / committed elsewhere — Competitor · no capital for a paid assessment — Funding · timeline pushed out — Timing · 30 days no response after recap — Expired.",
  },
  "Qualification": {
    actions: "Discovery call; capture and confirm details in writing; align the close date with the project timeline; identify feedstock, tonnage, composition and TEA depth; walk through methodology and comparable work.",
    advance: "Agreed to an initial / computational analysis · feedstock data or sample provided or committed with a date · scope, budget range and decision process confirmed in writing.",
    lost: "Data / sample refused or deferred with no date — Expired · no budget or route — Funding · outside what we can model / deliver — Technical / methodology fit · no decision-maker — Unqualified · runs it internally / another provider — Competitor.",
  },
  "Initial Assessment": {
    actions: "Present and discuss the pricing proposal; technical scoping / flowsheet walkthrough; execute NDA and data-sharing agreement; receive and review sample or composition data; internal GO / HOLD / REDIRECT check; stakeholder alignment.",
    advance: "Verbal agreement on scope and price · proposal / SOW accepted in principle · NDA and data-sharing executed · target signature date set.",
    lost: "Declined on price with no workable scope — Pricing · awarded elsewhere / in-house — Competitor · viability fails on review — Technical / methodology fit · terms can't be agreed — Other · deprioritised — Timing · award needs unsecured funding — Funding · 30 days silent — Expired.",
  },
  "Contract Sent": {
    actions: "Contract sent for signature; procurement / legal engaged with a target signature date; final T&C / detail discussions.",
    advance: "Contract signed by both parties · PO issued or payment terms confirmed.",
    lost: "Refused or withdrawn at legal / procurement — Other · terms can't be reconciled — Other · budget withdrawn after issue — Funding · no signature 30 days past target — Expired.",
  },
  "Closed Won": {
    actions: "Finalize paperwork; set onboarding expectations; complete Success Criteria and handoff fields; create the project and schedule kickoff.",
    advance: "Exit from the CRM — handoff to Project Management. Company lifecycle set to Active.",
    lost: "Cancelled before kickoff — reopen and re-close as Closed Lost with category and reason; never leave it recorded as Won. Cancellation after kickoff is a delivery outcome, not a CRM stage.",
  },
  "Closed Lost": {
    actions: "Complete the Closed Lost Category and Reason with details.",
    advance: "The deal stays closed. Re-engagement starts a new deal on the same company — do not reopen the old one. Company lifecycle returns to Nurture.",
    lost: "Re-approach date is set by category (see the clock below). Unqualified and Technical / methodology fit carry no re-approach.",
  },
};

// "Actions that make other actions happen" — the system's derivation rules.
const AUTOMATIONS: { trigger: string; effect: string }[] = [
  {
    trigger: "Enter Qualification, Initial Assessment or Contract Sent",
    effect: "Expected Close Date is overwritten to the date of the stage change + the stage offset (+90 / +60 / +21 days). The standard always wins on a stage change; between changes a manual edit holds until the next change.",
  },
  {
    trigger: "Any stage change",
    effect: "Date Entered Current Stage is reset to today, and an append-only Stage History row (from → to, who, when) is written. Skipped stages show as a jump in the history.",
  },
  {
    trigger: "Enter Closed Won",
    effect: "End Date is stamped and Status is set to Won by the system (it cannot be typed).",
  },
  {
    trigger: "Enter Closed Lost",
    effect: "End Date is stamped; Status and Re-approach Date are derived from the Closed Lost Category clock — Nurture when the category carries a re-approach clock, Lost for Unqualified or Technical / methodology fit.",
  },
  {
    trigger: "Change the Closed Lost Category on a lost deal",
    effect: "Status (Nurture / Lost) and Re-approach Date are re-derived from the new category.",
  },
  {
    trigger: "Set Status by hand (New / Awaiting Open ERP / Awaiting Client)",
    effect: "The moment of the change is recorded. The Awaiting Client urgency clock runs from the instant Status was set to Awaiting Client.",
  },
  {
    trigger: "Reopen a closed deal (move out of Closed Won / Lost)",
    effect: "End Date and Re-approach Date are cleared and Status is handed back to the owner as Awaiting Open ERP.",
  },
  {
    trigger: "Recalculated on read (daily)",
    effect: "The Urgency Flag is recomputed from Status + dates and is never editable. New: purple days 0–7 from Start Date, red from day 8. Awaiting Open ERP: green until the earliest open plan item is overdue, then yellow, then red past the stage red-trigger. Awaiting Client: green 7 days from the status change, yellow from day 8, red past the red-trigger. Won / Nurture / Lost are grey.",
  },
  {
    trigger: "Red trigger, by stage",
    effect: "Qualification / Initial Assessment / Contract Sent — past the Expected Close Date. Lead — 21 days from Start Date. Prospect — 30 days from Date Entered Current Stage. Red fires on the Expired condition already written into the stage, so a red deal has met the documented condition for being closed out.",
  },
  {
    trigger: "An open deal has no open plan item",
    effect: "The No Open Task flag is raised. Every open deal (Lead → Contract Sent) must carry at least one open Next Step; the flag marks a breach, and is kept out of Status on purpose.",
  },
  {
    trigger: "Close a plan item that has no owner",
    effect: "It is assigned to the person who closed it. When an objective closes, the next open objective reverts to the Deal Lead.",
  },
  {
    trigger: "Delete a deal",
    effect: "An active deal is archived and stays recoverable. Deleting a deal that is already in the archive is permanent — the deal and its plan items, contacts and history are erased.",
  },
];

// Closed Lost categories and their re-approach clock (matches the system clock).
const LOST_CATEGORIES: { name: string; outcome: string; clock: string; note: string }[] = [
  { name: "Competitor", outcome: "Nurture", clock: "12 months", note: "Went to a competing provider, in-house, or kept the status quo. Re-approach at renewal if known." },
  { name: "No decision", outcome: "Nurture", clock: "6 months", note: "Decided to stay the same and/or not purchase now." },
  { name: "Expired", outcome: "Nurture", clock: "3–6 months", note: "Stopped responding past the deal's closing timeframe." },
  { name: "Pricing", outcome: "Nurture", clock: "90 days", note: "Cited pricing as the reason for not moving forward." },
  { name: "Timing", outcome: "Nurture", clock: "90 days", note: "Cited timing; project delayed significantly." },
  { name: "Funding", outcome: "Nurture", clock: "90 days", note: "Wanted but unfunded — pending a grant or investment. The most reliably reopenable loss." },
  { name: "Other", outcome: "Nurture", clock: "90 days", note: "Anything else — details required in the Closed Lost Reason." },
  { name: "Unqualified", outcome: "Lost", clock: "No re-approach", note: "Learned something that makes them a non-ideal customer." },
  { name: "Technical / methodology fit", outcome: "Lost", clock: "No re-approach", note: "Feedstock, target product or scale outside what we can credibly model or deliver." },
];

type Field = { name: string; req: string; what: string };
const FIELD_GROUPS: { section: string; blurb: string; fields: Field[] }[] = [
  {
    section: "General",
    blurb: "Identity, ownership, dates and outcome of the deal. Always visible.",
    fields: [
      { name: "Name", req: "Required, always", what: "The deal name — mirrors the company." },
      { name: "Deal Stage", req: "Required, always", what: "Position in the pipeline." },
      { name: "Status", req: "Required, always", what: "Who owes the next move. Set by hand while open; set by the system at close." },
      { name: "Urgency Flag", req: "Set automatically (daily)", what: "The system's read of how late the next move is. Read-only colour." },
      { name: "No Open Task Flag", req: "Set automatically", what: "Raised on any open deal with no open plan item." },
      { name: "Deal Lead", req: "Required at Prospect", what: "The Open ERP owner accountable for the next action. Exactly one per open deal." },
      { name: "Start Date", req: "Required, always", what: "Date the deal was opened. Measures stage and cycle time." },
      { name: "Expected Close Date", req: "Required at Qualification", what: "Forecast close. Re-seeded to today + the stage offset on each stage change." },
      { name: "End Date", req: "Set automatically at close", what: "Stamped at Closed Won / Closed Lost. Drives cycle time and forecast accuracy." },
      { name: "Date Entered Current Stage", req: "Set automatically per stage change", what: "Today minus this is time-in-stage." },
      { name: "Stage History", req: "Set automatically per stage change", what: "Append-only log: from → to, who, when." },
      { name: "Deal Source", req: "Required at Prospect", what: "Where the deal originated." },
      { name: "Projected Revenue", req: "Required at Contract Sent", what: "Approximate deal value." },
      { name: "Success Criteria", req: "Required at Closed Won", what: "The single record of the win. Replaces Closed Won Reason — do not add a separate field." },
      { name: "Closed Lost Category", req: "Required at Closed Lost", what: "Reason bucket; drives Status and Re-approach Date." },
      { name: "Closed Lost Reason", req: "Required when Category = Other", what: "Free-text detail for leadership review." },
      { name: "Re-approach Date", req: "Required when Status = Nurture", what: "When to come back. Set from the category clock." },
    ],
  },
  {
    section: "Company & Contact",
    blurb: "Transferred from Contacts. Company and primary Contact hyperlink to the Contacts tab.",
    fields: [
      { name: "Company", req: "Required, always", what: "The customer organisation the deal belongs to." },
      { name: "Contact (Primary)", req: "Required at Prospect", what: "The main person we are dealing with." },
      { name: "Site Country / Region", req: "Required at Qualification", what: "Location of the producing site; sets regulatory scope and logistics." },
      { name: "Role in Decision", req: "Required at Qualification (primary)", what: "Where the contact sits in the buying group." },
      { name: "Function", req: "Required at Qualification (primary)", what: "The departmental function the contact sits in." },
    ],
  },
  {
    section: "Plan",
    blurb: "A repeating child collection — one line per objective, each with its own Type, Owner, Due Date and Status. Working dates live here.",
    fields: [
      { name: "Type", req: "Required per item", what: "Next Step, NDA or Feasibility Study." },
      { name: "Owner", req: "Required per item", what: "Accountable person; may differ from the Deal Lead." },
      { name: "Due Date", req: "Required per item", what: "When the objective is due." },
      { name: "Status", req: "Required per item", what: "Open / Done / Cancelled." },
      { name: "Next Step", req: "≥ 1 open on every open deal", what: "The single next action, written so someone else could carry it out." },
      { name: "NDA", req: "Required at Initial Assessment", what: "Date the NDA and data-sharing agreement were signed." },
      { name: "Feasibility Study", req: "Required at Contract Sent", what: "Owner, target / completed / sent dates, status and analysis link. Numbers are never copied into the CRM." },
    ],
  }
];

// ── Component ─────────────────────────────────────────────────────────────────

function Dot({ cls }: { cls: string }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

function StageCard({ parent, dot, header }: { parent: string; dot: string; header: string }) {
  const info = STAGE_INFO[parent];
  const act = STAGE_ACTIONS[parent];
  const [open, setOpen] = useState(false);
  if (!info) return null;
  return (
    <div className={CARD + " p-3"}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 text-left">
        <Dot cls={dot} />
        <span className={`text-sm font-semibold ${header}`}>{parent}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" className={`ml-auto w-4 h-4 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}>
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
        </svg>
      </button>
      <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{info.description}</p>
      {open && act && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 dark:border-zinc-800 pt-2.5">
          <Line label="Actions" text={act.actions} />
          <Line label="Advance" text={info.requirements} />
          <Line label="Exit → Closed Lost" text={act.lost} />
        </div>
      )}
    </div>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className="block text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">{text}</span>
    </div>
  );
}

export default function KnowledgeBase() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-5 py-6 space-y-8">
        <header>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-white">CRM Knowledge Base</h1>
          <p className={SUB + " mt-1 max-w-2xl"}>
            How deals move and what the system does on its own. The rules below are enforced in the pipeline — stages, field
            requirements, and the automations that make one action trigger another.
          </p>
        </header>

        {/* Pipeline */}
        <section className="space-y-3">
          <div>
            <h2 className={H2}>Pipeline stages</h2>
            <p className={SUB + " mt-1"}>What each stage means, and what has to be true before a deal leaves it. Click a stage for actions and exit criteria.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {CRM_STAGE_GROUPS.map(g => (
              <StageCard key={g.parent} parent={g.parent} dot={g.color.dot} header={g.color.header} />
            ))}
          </div>
        </section>

        {/* Automations */}
        <section className="space-y-3">
          <div>
            <h2 className={H2}>Automations</h2>
            <p className={SUB + " mt-1"}>Actions that make other actions happen. Each trigger on the left drives the effect on the right — no user does it by hand.</p>
          </div>
          <div className={CARD + " divide-y divide-zinc-100 dark:divide-zinc-800"}>
            {AUTOMATIONS.map((a, i) => (
              <div key={i} className="grid sm:grid-cols-[minmax(0,11rem)_1fr] gap-1 sm:gap-4 p-3">
                <div className="flex items-start gap-2">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 mt-0.5 text-amber-500 shrink-0"><path d="M11.3 1.05 3.4 11.3a.6.6 0 0 0 .47.97h4.2l-1.4 6.68a.6.6 0 0 0 1.07.48l7.9-10.25a.6.6 0 0 0-.48-.97h-4.2l1.4-6.68a.6.6 0 0 0-1.06-.48Z" /></svg>
                  <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{a.trigger}</span>
                </div>
                <span className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{a.effect}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Closed Lost clock */}
        <section className="space-y-3">
          <div>
            <h2 className={H2}>Closed Lost categories &amp; re-approach clock</h2>
            <p className={SUB + " mt-1"}>The category chosen at Closed Lost sets both the outcome (Nurture vs Lost) and the date we come back.</p>
          </div>
          <div className={CARD + " overflow-x-auto"}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className={TH}>Category</th>
                  <th className={TH}>Outcome</th>
                  <th className={TH}>Re-approach</th>
                  <th className={TH}>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {LOST_CATEGORIES.map(c => (
                  <tr key={c.name} className="border-b border-zinc-50 dark:border-zinc-800/50 last:border-0">
                    <td className={TD + " font-medium whitespace-nowrap"}>{c.name}</td>
                    <td className={REQ}>
                      <span className={`inline-flex items-center gap-1.5 ${c.outcome === "Lost" ? "text-zinc-500" : "text-violet-600 dark:text-violet-300"}`}>
                        <Dot cls={c.outcome === "Lost" ? "bg-zinc-400" : "bg-violet-500"} />{c.outcome}
                      </span>
                    </td>
                    <td className={REQ}>{c.clock}</td>
                    <td className={TD}>{c.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Fields */}
        <section className="space-y-3">
          <div>
            <h2 className={H2}>Fields &amp; validation</h2>
            <p className={SUB + " mt-1"}>
              &ldquo;Required at &lt;stage&gt;&rdquo; blocks the stage change until the field is filled. &ldquo;Set automatically&rdquo; means the system writes it and the user cannot.
            </p>
          </div>
          {FIELD_GROUPS.map(grp => (
            <div key={grp.section} className={CARD + " overflow-hidden"}>
              <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30">
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{grp.section}</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{grp.blurb}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-100 dark:border-zinc-800">
                      <th className={TH}>Field</th>
                      <th className={TH}>Required / Default</th>
                      <th className={TH}>What it is</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grp.fields.map(f => (
                      <tr key={f.name} className="border-b border-zinc-50 dark:border-zinc-800/50 last:border-0">
                        <td className={TD + " font-medium whitespace-nowrap"}>{f.name}</td>
                        <td className={REQ}>{f.req}</td>
                        <td className={TD}>{f.what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>

        <p className="text-[11px] text-zinc-400 dark:text-zinc-600 pt-2">
          Source: Open ERP CRM Properties/Fields template and Sales Pipeline template.
        </p>
      </div>
    </div>
  );
}
