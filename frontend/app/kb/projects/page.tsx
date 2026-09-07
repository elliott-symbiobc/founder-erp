'use client'

import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Concept, SimpleTable, Code } from "../_components";

export default function ProjectsKbPage() {
  return (
    <article>
      <H1>Projects</H1>
      <Lead>
        The Projects module tracks commercial and R&D opportunities through a defined stage pipeline —
        from initial qualification to closed deals. It connects to Contacts (for partner tracking)
        and Tasks (for action items) to keep deal progress and follow-ups in one place.
      </Lead>

      <H2>Stage Pipeline</H2>
      <P>
        Each project moves through a set of stages that reflect Open ERP's commercial process:
      </P>
      <SimpleTable
        headers={["Stage", "Meaning"]}
        rows={[
          ["New", "Initial lead or idea — not yet qualified"],
          ["Qualified", "Confirmed interest, substrate or strain identified, TEA initiated"],
          ["Proposal", "Commercial proposal or term sheet in progress"],
          ["Negotiation", "Terms being discussed, legal review underway"],
          ["Won", "Deal closed — partnership or contract signed"],
          ["Lost", "Opportunity did not close"],
          ["On Hold", "Paused pending external factors"],
        ]}
      />
      <P>
        Stage transitions are manual — a user moves a project forward or backward by editing
        the project card. The system records the timestamp and user for each stage change.
      </P>

      <H2>Contacts & Follow-Ups</H2>
      <P>
        Projects can be linked to one or more contact records. When a contact is linked to a project,
        follow-up tasks generated for that contact (by the AI or manually) can be associated with
        the project for traceability.
      </P>
      <P>
        The Projects page shows a summary of open tasks and recent interactions for each linked
        contact, so you can see deal activity without leaving the project view.
      </P>

      <H2>Project Cards</H2>
      <P>
        The Projects list (<Code>/projects</Code>) shows project cards with status, stage, linked
        contacts, and last-activity date. Clicking a card opens the project detail page
        (<Code>/projects/[id]</Code>) with full history, notes, tasks, and linked substrate/strain
        if applicable.
      </P>
      <Tip>
        If a project is linked to a substrate, the TEA results and ML model scores for that substrate
        are visible from the project detail page — useful for building the commercial case during
        the Proposal or Negotiation stage.
      </Tip>

      <H2>Permissions</H2>
      <SimpleTable
        headers={["Permission", "What it enables"]}
        rows={[
          ["projects", "View and edit all projects"],
        ]}
      />

      <H2>Key API Endpoints</H2>
      <SimpleTable
        headers={["Method", "Endpoint", "Purpose"]}
        rows={[
          ["GET", "/api/projects", "List all projects (with stage filter)"],
          ["POST", "/api/projects", "Create project"],
          ["GET", "/api/projects/{id}", "Project detail with contacts, tasks, interactions"],
          ["PATCH", "/api/projects/{id}", "Update project (stage, status, notes)"],
          ["DELETE", "/api/projects/{id}", "Delete project"],
          ["POST", "/api/projects/{id}/contacts", "Link a contact to a project"],
          ["DELETE", "/api/projects/{id}/contacts/{contact_id}", "Unlink a contact"],
        ]}
      />

      <H3>Database Tables</H3>
      <Ul>
        <Li><Code>projects</Code> — project records (name, stage, status, substrate_id, notes)</Li>
        <Li><Code>project_contacts</Code> — many-to-many join between projects and contacts</Li>
      </Ul>
    </article>
  );
}