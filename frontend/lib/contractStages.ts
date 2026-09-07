export interface StageGroup {
  parent: string;
  stages: string[];
  autoCollapse?: boolean;
  color: {
    header: string;
    badge: string;
    card: string;
    dot: string;
    bg: string;
  };
}

export const RD_STAGE_GROUPS: StageGroup[] = [
  {
    parent: "Prospect",
    stages: ["Prospect"],
    color: {
      header: "text-blue-600 dark:text-blue-300",
      badge: "bg-blue-100 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700/60",
      card: "border-blue-200 dark:border-blue-800/40",
      dot: "bg-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/10",
    },
  },
  {
    parent: "Qualification",
    stages: ["Qualification"],
    color: {
      header: "text-purple-600 dark:text-purple-300",
      badge: "bg-purple-100 text-purple-700 border border-purple-300 dark:bg-purple-900/50 dark:text-purple-300 dark:border-purple-700/60",
      card: "border-purple-200 dark:border-purple-800/40",
      dot: "bg-purple-500",
      bg: "bg-purple-50 dark:bg-purple-900/10",
    },
  },
  {
    parent: "Initial Assessment",
    stages: ["Prelim. Report & TEA", "Initial Sample Analysis & POC Proposal"],
    color: {
      header: "text-amber-600 dark:text-amber-300",
      badge: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-700/60",
      card: "border-amber-200 dark:border-amber-800/40",
      dot: "bg-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/10",
    },
  },
  {
    parent: "Lab-Scale POC",
    stages: ["Lab-Scale POC"],
    color: {
      header: "text-orange-600 dark:text-orange-300",
      badge: "bg-orange-100 text-orange-700 border border-orange-300 dark:bg-orange-900/50 dark:text-orange-300 dark:border-orange-700/60",
      card: "border-orange-200 dark:border-orange-800/40",
      dot: "bg-orange-500",
      bg: "bg-orange-50 dark:bg-orange-900/10",
    },
  },
  {
    parent: "Pilot System",
    stages: ["Pilot System"],
    color: {
      header: "text-rose-600 dark:text-rose-300",
      badge: "bg-rose-100 text-rose-700 border border-rose-300 dark:bg-rose-900/50 dark:text-rose-300 dark:border-rose-700/60",
      card: "border-rose-200 dark:border-rose-800/40",
      dot: "bg-rose-500",
      bg: "bg-rose-50 dark:bg-rose-900/10",
    },
  },
  {
    parent: "Commercial Deployment",
    stages: ["Commercial Deployment"],
    color: {
      header: "text-teal-600 dark:text-teal-300",
      badge: "bg-teal-100 text-teal-700 border border-teal-300 dark:bg-teal-900/50 dark:text-teal-300 dark:border-teal-700/60",
      card: "border-teal-200 dark:border-teal-800/40",
      dot: "bg-teal-500",
      bg: "bg-teal-50 dark:bg-teal-900/10",
    },
  },
  {
    parent: "Active",
    stages: ["Active"],
    color: {
      header: "text-green-600 dark:text-green-300",
      badge: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-900/50 dark:text-green-300 dark:border-green-700/60",
      card: "border-green-200 dark:border-green-800/40",
      dot: "bg-green-500",
      bg: "bg-green-50 dark:bg-green-900/10",
    },
  },
  {
    parent: "Inactive",
    stages: ["Inactive"],
    autoCollapse: true,
    color: {
      header: "text-gray-500 dark:text-gray-400",
      badge: "bg-gray-100 text-gray-600 border border-gray-300 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700/60",
      card: "border-gray-200 dark:border-gray-700/40",
      dot: "bg-gray-400",
      bg: "bg-gray-50 dark:bg-gray-900/10",
    },
  },
];

export const PORTFOLIO_STAGE_GROUPS: StageGroup[] = [
  {
    parent: "Prospect",
    stages: ["Prospect"],
    color: {
      header: "text-blue-600 dark:text-blue-300",
      badge: "bg-blue-100 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700/60",
      card: "border-blue-200 dark:border-blue-800/40",
      dot: "bg-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/10",
    },
  },
  {
    parent: "Qualification",
    stages: ["Qualification"],
    color: {
      header: "text-purple-600 dark:text-purple-300",
      badge: "bg-purple-100 text-purple-700 border border-purple-300 dark:bg-purple-900/50 dark:text-purple-300 dark:border-purple-700/60",
      card: "border-purple-200 dark:border-purple-800/40",
      dot: "bg-purple-500",
      bg: "bg-purple-50 dark:bg-purple-900/10",
    },
  },
  {
    parent: "Prelim. TEA and Quote",
    stages: ["Prelim. TEA and Quote"],
    color: {
      header: "text-amber-600 dark:text-amber-300",
      badge: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-700/60",
      card: "border-amber-200 dark:border-amber-800/40",
      dot: "bg-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/10",
    },
  },
  {
    parent: "Engineering",
    stages: ["Engineering"],
    color: {
      header: "text-orange-600 dark:text-orange-300",
      badge: "bg-orange-100 text-orange-700 border border-orange-300 dark:bg-orange-900/50 dark:text-orange-300 dark:border-orange-700/60",
      card: "border-orange-200 dark:border-orange-800/40",
      dot: "bg-orange-500",
      bg: "bg-orange-50 dark:bg-orange-900/10",
    },
  },
  {
    parent: "Manufacturing",
    stages: ["Manufacturing"],
    color: {
      header: "text-rose-600 dark:text-rose-300",
      badge: "bg-rose-100 text-rose-700 border border-rose-300 dark:bg-rose-900/50 dark:text-rose-300 dark:border-rose-700/60",
      card: "border-rose-200 dark:border-rose-800/40",
      dot: "bg-rose-500",
      bg: "bg-rose-50 dark:bg-rose-900/10",
    },
  },
  {
    parent: "Active",
    stages: ["Active"],
    color: {
      header: "text-green-600 dark:text-green-300",
      badge: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-900/50 dark:text-green-300 dark:border-green-700/60",
      card: "border-green-200 dark:border-green-800/40",
      dot: "bg-green-500",
      bg: "bg-green-50 dark:bg-green-900/10",
    },
  },
  {
    parent: "Inactive",
    stages: ["Inactive"],
    autoCollapse: true,
    color: {
      header: "text-gray-500 dark:text-gray-400",
      badge: "bg-gray-100 text-gray-600 border border-gray-300 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700/60",
      card: "border-gray-200 dark:border-gray-700/40",
      dot: "bg-gray-400",
      bg: "bg-gray-50 dark:bg-gray-900/10",
    },
  },
];

// ── Stage guidance (board tooltip + Knowledge Base) ──────────────────────────
// Sourced from the Open ERP pipeline template: what each stage means and what has
// to be true before a deal leaves it.
export const STAGE_INFO: Record<string, { description: string; requirements: string }> = {
  "Lead": {
    description: "A named person at a company that plausibly fits our ICP has entered the system. Outreach has been one-directional so far \u2014 no reply yet, and nothing confirms or rules out fit.",
    requirements: "To Prospect: replied to outreach, interest expressed or a meeting scheduled, and no ICP disqualifier surfaced. Exit to Closed Lost as Expired (no reply after the full ~3-week sequence) or Unqualified (outside ICP).",
  },
  "Prospect": {
    description: "Responded and interested in a conversation to learn about the solution; nothing has ruled out their potential to become a customer.",
    requirements: "To Qualification: discovery call completed, a real accessible feedstock stream and problem confirmed, and the contact is a decision-maker / key influencer (or routed us to one).",
  },
  "Qualification": {
    description: "Attended an initial conversation, has the authority to launch a project, and has answered the qualifying criteria \u2014 feedstock identified, requirements and timeline gathered, decision process understood, and a plausible budget for a paid assessment.",
    requirements: "To Initial Assessment: agreed to an initial / computational analysis; feedstock data or a sample provided or committed with a date; scope, budget range and decision process confirmed in writing.",
  },
  "Initial Assessment": {
    description: "Prospect is evaluating a scoped, priced Initial Assessment against their criteria \u2014 methodology, price, IP, confidentiality and data-sharing terms under discussion.",
    requirements: "To Contract Sent: verbal agreement on scope and price, proposal / SOW accepted in principle, NDA and data-sharing agreement executed, and a target signature date set.",
  },
  "Contract Sent": {
    description: "Prospect has received the contract and is reviewing the legalese; procurement or legal is engaged with a target signature date.",
    requirements: "To Closed Won: contract signed by both parties, PO issued or payment terms confirmed.",
  },
  "Closed Won": {
    description: "Contract signed \u2014 new customer. Exit from the CRM and handoff to Project Management.",
    requirements: "Success Criteria and handoff fields complete, project created and kickoff scheduled; End Date is stamped automatically and the Company lifecycle is set to Active.",
  },
  "Closed Lost": {
    description: "The sales process is ending, at least for now. The reason is captured in the Closed Lost Category and Reason.",
    requirements: "Category (and Reason when Other) completed. The deal stays closed \u2014 re-engagement starts a new deal on the same company. Re-approach Date is set automatically from the category's clock.",
  },
};

export const CRM_STAGE_GROUPS: StageGroup[] = [
  {
    parent: "Lead",
    stages: ["Lead"],
    color: {
      header: "text-slate-600 dark:text-slate-300",
      badge: "bg-slate-100 text-slate-700 border border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-700/60",
      card: "border-slate-200 dark:border-slate-700/40",
      dot: "bg-slate-400",
      bg: "bg-slate-50 dark:bg-slate-900/10",
    },
  },
  {
    parent: "Prospect",
    stages: ["Prospect"],
    color: {
      header: "text-blue-600 dark:text-blue-300",
      badge: "bg-blue-100 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700/60",
      card: "border-blue-200 dark:border-blue-800/40",
      dot: "bg-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/10",
    },
  },
  {
    parent: "Qualification",
    stages: ["Qualification"],
    color: {
      header: "text-purple-600 dark:text-purple-300",
      badge: "bg-purple-100 text-purple-700 border border-purple-300 dark:bg-purple-900/50 dark:text-purple-300 dark:border-purple-700/60",
      card: "border-purple-200 dark:border-purple-800/40",
      dot: "bg-purple-500",
      bg: "bg-purple-50 dark:bg-purple-900/10",
    },
  },
  {
    parent: "Initial Assessment",
    stages: ["Initial Assessment"],
    color: {
      header: "text-amber-600 dark:text-amber-300",
      badge: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-700/60",
      card: "border-amber-200 dark:border-amber-800/40",
      dot: "bg-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/10",
    },
  },
  {
    parent: "Contract Sent",
    stages: ["Contract Sent"],
    color: {
      header: "text-orange-600 dark:text-orange-300",
      badge: "bg-orange-100 text-orange-700 border border-orange-300 dark:bg-orange-900/50 dark:text-orange-300 dark:border-orange-700/60",
      card: "border-orange-200 dark:border-orange-800/40",
      dot: "bg-orange-500",
      bg: "bg-orange-50 dark:bg-orange-900/10",
    },
  },
  {
    parent: "Closed Won",
    stages: ["Closed Won"],
    color: {
      header: "text-green-600 dark:text-green-300",
      badge: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-900/50 dark:text-green-300 dark:border-green-700/60",
      card: "border-green-200 dark:border-green-800/40",
      dot: "bg-green-500",
      bg: "bg-green-50 dark:bg-green-900/10",
    },
  },
  {
    parent: "Closed Lost",
    stages: ["Closed Lost"],
    autoCollapse: true,
    color: {
      header: "text-red-600 dark:text-red-400",
      badge: "bg-red-100 text-red-700 border border-red-300 dark:bg-red-900/50 dark:text-red-400 dark:border-red-800/60",
      card: "border-red-200 dark:border-red-800/40",
      dot: "bg-red-500",
      bg: "bg-red-50 dark:bg-red-900/10",
    },
  },
];

// ── Deal status (spec: GENERAL) ──────────────────────────────────────────────
// Only the first three are user-settable; Won / Nurture / Lost are driven by
// the stage change, never set by hand.
export const USER_SETTABLE_STATUSES = ["new", "awaiting_internal", "awaiting_client"] as const;

export const DEAL_STATUS_LABEL: Record<string, string> = {
  new:             "New",
  awaiting_internal: "Awaiting Us",
  awaiting_client: "Awaiting Client",
  won:             "Won",
  nurture:         "Nurture",
  lost:            "Lost",
};

export const DEAL_STATUS_DOT: Record<string, string> = {
  new:             "bg-green-500",
  awaiting_internal: "bg-[#C31010]",
  awaiting_client: "bg-amber-400",
  won:             "bg-emerald-600",
  nurture:         "bg-violet-500",
  lost:            "bg-zinc-400",
};

export const DEAL_STATUS_FALLBACK_DOT = "bg-zinc-400";

// -- Urgency Flag --------------------------------------------------------------
// Read-only colour signal computed by the API from Status + dates.
export const URGENCY_DOT: Record<string, string> = {
  purple:  "bg-purple-500",
  green:   "bg-green-500",
  yellow:  "bg-amber-400",
  red:     "bg-red-500",
  won:     "bg-emerald-600",
  nurture: "bg-violet-500",
  lost:    "bg-zinc-400",
};

// Accent bar uses the same colours as the dot.
export const URGENCY_BAR = URGENCY_DOT;

export const URGENCY_FALLBACK = "bg-zinc-300 dark:bg-zinc-600";

// Short human label for the flag (tooltip / chip text).
export const URGENCY_LABEL: Record<string, string> = {
  purple:  "New",
  green:   "On track",
  yellow:  "Attention",
  red:     "Overdue",
  won:     "Won",
  nurture: "Nurture",
  lost:    "Lost",
};

// Tinted pill styles for the read-only flag chip.
export const URGENCY_CHIP: Record<string, string> = {
  purple:  "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800/50",
  green:   "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800/50",
  yellow:  "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/50",
  red:     "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800/50",
  won:     "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800/50",
  nurture: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800/50",
  lost:    "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
};

// Why-explanation for the flag tooltip, by flag value.
export const URGENCY_HELP: Record<string, string> = {
  purple:  "New deal, within its first 7 days.",
  green:   "On track \u2014 nothing overdue.",
  yellow:  "Needs attention \u2014 past a due date or waiting too long.",
  red:     "Overdue \u2014 past the stage deadline.",
  won:     "Closed Won.",
  nurture: "Closed Lost \u2014 flagged to re-approach.",
  lost:    "Closed Lost.",
};

// ── Company section ──────────────────────────────────────────────────────────
export const SITE_REGIONS = [
  "United States", "Canada", "Latin America", "United Kingdom",
  "European Union", "Rest of Europe", "Middle East & Africa", "Asia-Pacific",
] as const;

export const ROLE_IN_DECISION = [
  "Decision-maker", "Economic buyer", "Technical evaluator",
  "Champion", "Blocker", "Introducer",
] as const;

export const CONTACT_FUNCTIONS = [
  "R&D", "Operations", "Sustainability", "Procurement", "Executive",
] as const;

// ── Closed Lost ──────────────────────────────────────────────────────────────
export const CLOSED_LOST_CATEGORIES = [
  "Competitor", "No decision", "Expired", "Pricing",
  "Technical / methodology fit", "Timing", "Unqualified", "Funding", "Other",
] as const;

export const CLOSED_LOST_OTHER = "Other";

// ── Plan ─────────────────────────────────────────────────────────────────────
export const PLAN_ITEM_TYPES: { key: string; label: string }[] = [
  { key: "first_touch",       label: "First Touch" },
  { key: "email",             label: "First Follow-up" },
  { key: "next_step",         label: "Next Step" },
  { key: "nda",               label: "NDA" },
  { key: "feasibility_study", label: "Feasibility Study" },
  { key: "task",              label: "Custom" },
];

export const PLAN_STATUSES = ["open", "done", "cancelled"] as const;

// Feasibility Study lines carry this extended list instead of the above.
export const FS_STATUSES = [
  "Not run", "Requested", "In progress", "Halted — no composition data",
  "GO", "HOLD", "REDIRECT",
] as const;

export function planStatusesFor(itemType: string): readonly string[] {
  return itemType === "feasibility_study" ? FS_STATUSES : PLAN_STATUSES;
}

export const LEAD_SOURCES = [
  "Referral",
  "Self-Prospecting: Networking",
  "Self-Prospecting: Cold Outreach",
  "Inbound (website, newsletter, etc.)",
  "Existing Customer (Cross/Upsell, Renewal)",
  "Conference/Trade Show",
  "Partner",
  "Other (Specify in Deal Description)",
] as const;

export const LEAD_SOURCE_OTHER = "Other (Specify in Deal Description)";

// Lead source becomes mandatory once a deal leaves "Lead" — i.e. Prospect and
// every later stage require it.
export function stageRequiresLeadSource(stage: string | null): boolean {
  if (!stage) return false;
  const order = CRM_STAGE_GROUPS.flatMap(g => g.stages);
  const prospectIdx = order.indexOf("Prospect");
  const stageIdx = order.indexOf(stage);
  return prospectIdx >= 0 && stageIdx >= prospectIdx;
}

export function findGroup(stage: string | null, groups: StageGroup[]): StageGroup | undefined {
  if (!stage) return undefined;
  return groups.find(g => g.stages.includes(stage));
}

export function allStages(groups: StageGroup[]): string[] {
  return groups.flatMap(g => g.stages);
}
