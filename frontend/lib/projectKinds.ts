/**
 * The kinds of project you can create, in the words they are called by.
 *
 * "Project type" alone never described these: the real shape is project_type ×
 * crm_type, with a stage sequence that differs per type, plus a tag for
 * partnerships. An R&D contract and a portfolio contract are both "contracts"
 * but differ on both columns; a grant and a marketing project share a
 * project_type shape but share no stages at all.
 *
 * Stage sequences are lifted from projects/page.tsx so the two creators cannot
 * drift. The projects page imports these rather than keeping its own copy.
 */

export interface ProjectKind {
  key: string;
  label: string;
  hint: string;
  project_type: string;
  crm_type?: string;
  section?: string;
  /** Partnerships carry an Academic/Commercial/... tag as well as a stage. */
  tagOptions?: string[];
  tagLabel?: string;
  dot: string;
}

export const STAGE_SEQUENCES: Record<string, string[]> = {
  portfolio:        ["Prospect", "Qualification", "Prelim. TEA and Quote", "Engineering", "Manufacturing", "Active", "Inactive"],
  crm_opportunity:  ["Prospect", "Qualification", "Prelim. Report & TEA", "Initial Sample Analysis & POC Proposal", "Lab-Scale POC", "Pilot System", "Commercial Deployment", "Active", "Inactive"],
  partnership:      ["Exploring", "Negotiating", "Agreement", "Active", "Complete"],
  grant:            ["Identified", "In Prep", "Submitted", "Under Review", "Won", "Lost"],
  internal:         ["Backlog", "Planning", "Active", "Validation", "Complete"],
  marketing:        ["Ideation", "Planning", "In Progress", "Review", "Live", "Complete"],
};

export const PARTNERSHIP_TAGS = ["Academic", "Commercial", "Accelerator", "Individual"];

export const PROJECT_KINDS: ProjectKind[] = [
  {
    key: "rd_contract",
    label: "R&D contract",
    hint: "Client work through the R&D pipeline",
    project_type: "crm_opportunity",
    crm_type: "rd_contract",
    section: "client",
    dot: "bg-blue-500",
  },
  {
    key: "portfolio_contract",
    label: "Portfolio contract",
    hint: "Portfolio company engagement",
    project_type: "portfolio",
    crm_type: "portfolio_contract",
    dot: "bg-zinc-400",
  },
  {
    key: "partnership",
    label: "Partnership",
    hint: "Academic or commercial partner",
    project_type: "partnership",
    crm_type: "lead",
    section: "partnership",
    tagOptions: PARTNERSHIP_TAGS,
    tagLabel: "Partnership type",
    dot: "bg-violet-500",
  },
  {
    key: "grant",
    label: "Grants & funding",
    hint: "Grant or non-dilutive funding",
    project_type: "grant",
    crm_type: "lead",
    dot: "bg-sky-500",
  },
  {
    key: "internal",
    label: "Operations",
    hint: "Internal work, no client",
    project_type: "internal",
    dot: "bg-teal-500",
  },
  {
    key: "marketing",
    label: "Marketing",
    hint: "Campaigns and content",
    project_type: "marketing",
    crm_type: "lead",
    dot: "bg-amber-500",
  },
];

export function stagesForKind(kind: ProjectKind): string[] {
  return STAGE_SEQUENCES[kind.project_type] ?? [];
}

/** The POST body for creating a project of this kind. */
export function kindToPayload(
  kind: ProjectKind,
  name: string,
  stage: string,
  tag?: string,
): Record<string, unknown> {
  return {
    name,
    project_type: kind.project_type,
    ...(kind.crm_type ? { crm_type: kind.crm_type } : {}),
    ...(kind.section ? { section: kind.section } : {}),
    ...(stage ? { stage } : {}),
    ...(tag ? { tags: [tag] } : {}),
    // Sent explicitly rather than left to the endpoint default, which produced
    // a status nothing in the system filters on.
    status: "in_progress",
  };
}
