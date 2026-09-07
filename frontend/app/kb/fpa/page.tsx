'use client'

import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Concept, Warning, SimpleTable, Code } from "../_components";

export default function FpaKbPage() {
  return (
    <article>
      <H1>Financial Planning & Analysis (FP&A)</H1>
      <Lead>
        The FP&A module connects live bank data and accounting records to the platform, giving
        the team a real-time view of cash position, net burn, and P&amp;L — without leaving the
        research environment. Access requires the <Code>view_fpa</Code> permission.
      </Lead>

      <H2>What the FP&A Module Shows</H2>
      <Ul>
        <Li><strong>Cash position</strong> — current balances across connected bank accounts, pulled daily from Plaid</Li>
        <Li><strong>Net burn</strong> — monthly cash outflow net of revenue, calculated from Plaid transaction data</Li>
        <Li><strong>P&L summary</strong> — income statement from QuickBooks Online, available in monthly, weekly, quarterly, and yearly views</Li>
        <Li><strong>Runway estimate</strong> — months of runway at current burn rate based on current cash balance</Li>
      </Ul>

      <H2>Data Sources</H2>

      <H3>Plaid (Bank Data)</H3>
      <P>
        Plaid connects to the company's bank accounts via OAuth. Once connected, it syncs daily at
        07:00 UTC. The sync pulls:
      </P>
      <Ul>
        <Li>Account balances (current and available)</Li>
        <Li>Transaction history (used to compute net burn)</Li>
      </Ul>
      <P>
        OAuth tokens are stored in <Code>fpa_plaid_tokens</Code>. To reconnect a bank account,
        use the Plaid Link flow in the FP&A settings section.
      </P>
      <Tip>
        Plaid operates in sandbox mode by default (<Code>PLAID_ENV=sandbox</Code>). Switch to
        <Code>production</Code> in the environment variables for live bank data.
      </Tip>

      <H3>QuickBooks Online (P&L)</H3>
      <P>
        QuickBooks Online (QBO) syncs at 07:15 UTC daily via OAuth. It pulls the P&amp;L report
        for the current and prior periods. OAuth tokens are stored in <Code>fpa_qbo_tokens</Code>.
        If the QBO token expires, the sync silently fails — re-authenticate from the FP&A settings
        section.
      </P>

      <H2>Permissions</H2>
      <SimpleTable
        headers={["Permission", "What it enables"]}
        rows={[
          ["view_fpa", "Read-only access to FP&A dashboard, cash position, P&L"],
          ["edit_fpa", "Configure Plaid/QBO connections, upload financial models"],
        ]}
      />
      <Warning>
        FP&A permissions are not granted to the <Code>scientist</Code> role by default. Only admins
        and users explicitly granted <Code>view_fpa</Code> can access the FP&A module.
      </Warning>

      <H2>Financial Model Upload</H2>
      <P>
        In addition to live sync data, the FP&A module supports uploading financial model files
        (Excel/CSV) for scenario planning. Uploaded models are stored and can be viewed alongside
        actuals from Plaid and QBO.
      </P>

      <H2>Beat Schedule</H2>
      <SimpleTable
        headers={["Time (UTC)", "Task"]}
        rows={[
          ["07:00 daily", "Plaid bank sync — cash balances + transactions"],
          ["07:15 daily", "QuickBooks Online P&L sync (monthly, weekly, quarterly, yearly)"],
        ]}
      />

      <H2>Key API Endpoints</H2>
      <SimpleTable
        headers={["Method", "Endpoint", "Purpose"]}
        rows={[
          ["GET", "/api/fpa/dashboard", "FP&A summary: cash position, burn, runway, P&L snapshot"],
          ["GET", "/api/fpa/plaid/accounts", "List connected Plaid bank accounts"],
          ["POST", "/api/fpa/plaid/link", "Initiate Plaid Link OAuth flow"],
          ["POST", "/api/fpa/plaid/sync", "Manual Plaid sync trigger"],
          ["POST", "/api/fpa/qbo/connect", "Initiate QuickBooks OAuth flow"],
          ["POST", "/api/fpa/qbo/sync", "Manual QBO P&L sync trigger"],
          ["POST", "/api/fpa/model/upload", "Upload financial model file"],
        ]}
      />

      <H3>Database Tables</H3>
      <Ul>
        <Li><Code>fpa_plaid_tokens</Code> — Plaid OAuth tokens (one per connected institution)</Li>
        <Li><Code>fpa_qbo_tokens</Code> — QuickBooks OAuth tokens</Li>
        <Li><Code>fpa_actuals</Code> — Daily cash balance snapshots from Plaid</Li>
        <Li><Code>fpa_pl_data</Code> — P&L records from QBO (by period and granularity)</Li>
      </Ul>
    </article>
  );
}