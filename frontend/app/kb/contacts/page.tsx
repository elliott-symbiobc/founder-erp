'use client'

import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Concept, Warning, SimpleTable, Code } from "../_components";

export default function ContactsKbPage() {
  return (
    <article>
      <H1>Contacts & Relationship Management</H1>
      <Lead>
        The Contacts module is a lightweight CRM built specifically for Founder ERP's business development
        workflow. It tracks partners, investors, advisors, and clients — with automated Gmail and Calendar
        sync to keep interaction history current without manual data entry.
      </Lead>

      <H2>What Lives Here</H2>
      <P>
        Every person or organisation that matters to Founder ERP has a contact record. The module is divided
        into three views, all accessible from the Contacts nav item:
      </P>
      <SimpleTable
        headers={["View", "Path", "Who it shows"]}
        rows={[
          ["All Contacts", "/contacts", "Everyone — partners, investors, advisors, clients, leads"],
          ["Clients", "/contacts/clients", "Companies and individuals tagged as active clients"],
          ["Advisors", "/contacts/advisors", "Advisory board members (also appear in /advisors)"],
        ]}
      />
      <P>
        The <strong>Relationship Graph</strong> at <Code>/contacts/graph</Code> renders the entire contact
        network as a force-directed graph. Nodes are contacts; edges are inferred relationships based on
        email co-occurrence and explicit links.
      </P>

      <H2>Automated Sync</H2>
      <P>
        When a user connects their Google account (via Settings → Integrations), the platform syncs their
        Gmail and Google Calendar automatically:
      </P>
      <Ul>
        <Li><strong>Full Gmail sync</strong> — runs nightly at 03:00 UTC. Imports all threads involving known contacts and classifies each as an email interaction.</Li>
        <Li><strong>Incremental Gmail sync</strong> — runs hourly via the History API. Captures new messages since the last sync within minutes of arrival.</Li>
        <Li><strong>Calendar sync</strong> — runs hourly. Imports meetings where contact email addresses appear as attendees.</Li>
      </Ul>
      <Tip>
        You do not need to manually log emails or meetings. Once a contact record exists and your Google
        account is connected, all interactions with that email address appear automatically on the
        contact's timeline.
      </Tip>

      <H2>AI-Generated Follow-Ups</H2>
      <P>
        After each Gmail sync, the platform checks whether any contact is overdue for follow-up based on
        their last interaction date and a configurable follow-up interval. When a contact needs attention,
        the system asks Claude to generate a <em>specific</em> task — not a generic reminder — based on
        the actual content of recent email threads.
      </P>
      <P>
        For example, rather than "Follow up with Dr. Chen", the task might be: "Send Dr. Chen the
        Q3 pricing sheet she requested in the 4 April email." These tasks appear in the
        Tasks module and are linked to the contact record.
      </P>

      <H2>AI Contact Summaries & Enrichment</H2>
      <P>
        Each contact has an AI-generated summary that synthesises interaction history and any notes. Summaries are refreshed nightly for contacts where the underlying data has changed.
      </P>
      <P>
        The enrichment pipeline (triggered manually or automatically for new contacts) queries Semantic
        Scholar for publications and uses Claude to extract professional context — institution,
        expertise area, relevant publications.
      </P>

      <H2>Relationship Inference</H2>
      <P>
        Every night at 02:30 UTC, the relationship inference task scans email interactions across all
        synced users to find contact pairs that frequently appear in the same threads. When the
        co-occurrence score exceeds a threshold, a relationship edge is created in
        <Code>contact_relationships</Code>. These edges power the Relationship Graph.
      </P>
      <Concept>
        The relationship graph is inferred automatically from communication patterns — you don't
        need to manually define who knows whom. The more email history that's synced, the more
        accurate the graph becomes.
      </Concept>

      <H2>Permissions</H2>
      <SimpleTable
        headers={["Permission", "What it enables"]}
        rows={[
          ["contacts", "View contacts, interactions, graph, reminders"],
          ["manage_users", "Edit permissions for other users (admin only)"],
        ]}
      />

      <H2>Key API Endpoints</H2>
      <SimpleTable
        headers={["Method", "Endpoint", "Purpose"]}
        rows={[
          ["GET", "/api/contacts", "List contacts (with search, filter by type)"],
          ["POST", "/api/contacts", "Create contact"],
          ["GET", "/api/contacts/{id}", "Contact detail with interactions and reminders"],
          ["PATCH", "/api/contacts/{id}", "Update contact fields"],
          ["DELETE", "/api/contacts/{id}", "Delete contact"],
          ["POST", "/api/contacts/{id}/enrich", "Trigger AI enrichment"],
          ["GET", "/api/contacts/graph", "Relationship graph (nodes + edges)"],
          ["POST", "/api/contacts/google/connect", "Initiate Google OAuth flow"],
          ["POST", "/api/contacts/sync/gmail", "Manual Gmail sync for current user"],
        ]}
      />

      <H3>Database Tables</H3>
      <Ul>
        <Li><Code>contacts</Code> — core contact record</Li>
        <Li><Code>contact_interactions</Code> — email, meeting, and call interactions</Li>
        <Li><Code>contact_relationships</Code> — inferred or explicit contact-to-contact edges</Li>
        <Li><Code>contact_reminders</Code> — AI-generated and manual follow-up tasks</Li>
        <Li><Code>google_oauth_tokens</Code> — per-user Google OAuth credentials</Li>
      </Ul>
    </article>
  );
}