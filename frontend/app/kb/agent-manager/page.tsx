import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Warning, Concept, Code } from "../_components";

export default function AgentManagerPage() {
  return (
    <article>
      <H1>Agent Manager</H1>
      <Lead>
        The Agent Manager gives administrators visibility into and control over every AI agent
        in the platform — including the system prompt, context sources, tools, and sampling
        parameters for each one.
      </Lead>

      <H2>Accessing the Agent Manager</H2>
      <P>
        Navigate to <strong>Admin → Agent Manager</strong> in the sidebar. This page requires the
        <Code>manage_users</Code> permission. You will see a card for each of the 16 registered
        agents.
      </P>

      <H2>What You Can See Per Agent</H2>
      <P>Click the <strong>Inspect</strong> (eye) button on any agent card to reveal three sub-tabs:</P>
      <Ul>
        <Li><strong>System Prompt</strong> — The base prompt the agent uses. If you have set a custom override, it appears highlighted in amber above the default prompt.</Li>
        <Li><strong>Context (N)</strong> — The data sources the agent reads at runtime (e.g., &quot;Today&apos;s tasks&quot;, &quot;Calendar events&quot;, &quot;pgvector RAG results&quot;).</Li>
        <Li><strong>Tools (N)</strong> — External APIs or tools the agent calls (e.g., USDA search, eCFR regulatory search). Most agents have no external tools.</Li>
      </Ul>

      <H2>What You Can Configure Per Agent</H2>
      <P>Click <strong>Edit</strong> on any agent card to open the configuration modal:</P>
      <Ul>
        <Li><strong>Model</strong> — Override the Claude model (e.g., <Code>claude-opus-4-7</Code>, <Code>claude-sonnet-4-6</Code>, <Code>claude-haiku-4-5-20251001</Code>).</Li>
        <Li><strong>Max Tokens</strong> — Maximum tokens in the response.</Li>
        <Li><strong>Temperature</strong> — Controls randomness (0 = deterministic, 1 = creative). Use for open-ended generation tasks.</Li>
        <Li><strong>Top P</strong> — Nucleus sampling threshold. Alternative to temperature — do not use both simultaneously.</Li>
        <Li><strong>Top K</strong> — Limits sampling to the top K tokens. Used less commonly than temperature or top_p.</Li>
        <Li><strong>System Prompt Override</strong> — Text prepended to the agent&apos;s default prompt. Useful for adding company-specific context or changing tone without rewriting the base prompt.</Li>
      </Ul>

      <Warning>
        Do not set both Temperature and Top P at the same time. The Anthropic API treats them as
        mutually exclusive sampling strategies. Use one or the other, or neither (defaults are fine
        for most agents).
      </Warning>

      <H2>The Registered Agents</H2>

      <H3>Planning</H3>
      <Ul>
        <Li><strong>planner_generate</strong> — Generates prioritised daily work blocks from tasks, calendar and context.</Li>
        <Li><strong>planner_weekly</strong> — Generates the high-level weekly plan from tasks and objectives.</Li>
        <Li><strong>planner_chat</strong> — The dashboard assistant. Omnipresent context plus RAG; the primary user-facing agent.</Li>
        <Li><strong>tasks_extract</strong> — Extracts structured tasks from free text or a brain dump.</Li>
      </Ul>

      <H3>Notes &amp; Contacts</H3>
      <Ul>
        <Li><strong>note_analysis</strong> — Extracts action items, decisions and follow-ups from meeting transcripts.</Li>
        <Li><strong>contact_summary</strong> — Generates relationship summaries from email and calendar activity.</Li>
      </Ul>

      <H3>Funding</H3>
      <Ul>
        <Li><strong>funding_enrich</strong> — Fills missing fields on a funding opportunity, suggests tags and adds context.</Li>
        <Li><strong>dilutive_enrich</strong> — Enriches investor records with firm and fund details, focus, stage, check sizes and links.</Li>
      </Ul>

      <H2>How Overrides Are Stored</H2>
      <P>
        Overrides are persisted in the <Code>agent_config_overrides</Code> database table and
        merged with the default registry values at request time. If no override exists for a field,
        the registry default is used. Overrides survive container restarts.
      </P>

      <Tip>
        Changes take effect immediately — there is no need to restart the API after saving agent
        configuration changes.
      </Tip>
    </article>
  );
}
