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
        <Li><strong>Context (N)</strong> — The data sources the agent reads at runtime (e.g., &quot;Today&apos;s tasks&quot;, &quot;ELN entries&quot;, &quot;Calendar events&quot;, &quot;pgvector RAG results&quot;).</Li>
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

      <H2>The 16 Registered Agents</H2>

      <H3>Operations</H3>
      <Ul>
        <Li><strong>planner_chat</strong> — Dashboard AI assistant. Omnipresent context + RAG. The primary user-facing agent.</Li>
        <Li><strong>daily_plan</strong> — Generates the daily time-blocked plan from tasks and calendar events.</Li>
        <Li><strong>weekly_plan</strong> — Generates the Monday weekly priorities and theme.</Li>
        <Li><strong>note_analyzer</strong> — Extracts summary, action items, and decisions from meeting note transcripts.</Li>
        <Li><strong>entry_analyzer</strong> — Extracts structured data from ELN entry transcripts.</Li>
      </Ul>

      <H3>Contacts &amp; CRM</H3>
      <Ul>
        <Li><strong>contact_enricher</strong> — Searches Semantic Scholar and enriches contact profiles with publications and expertise.</Li>
        <Li><strong>contact_summarizer</strong> — Generates AI relationship summaries from interaction history.</Li>
        <Li><strong>relationship_infer</strong> — Infers contact-to-contact relationships from email co-occurrence.</Li>
      </Ul>

      <H3>R&amp;D &amp; Science</H3>
      <Ul>
        <Li><strong>literature_agent</strong> — Weekly PubMed/Scholar sweep; extracts and stages papers for review.</Li>
        <Li><strong>extraction_agent</strong> — Structured data extraction (strain, titer, conditions) from PDF paper text.</Li>
        <Li><strong>paper_summarizer</strong> — Generates plain-language paper summaries.</Li>
        <Li><strong>compound_discovery</strong> — Four-mode compound opportunity identification (enzymatic, substrate, pairing, enzyme-supplemented).</Li>
        <Li><strong>edit_prioritizer</strong> — SHAP-driven CRISPR edit candidate ranking + sgRNA design.</Li>
        <Li><strong>sop_generator</strong> — Claude-generated SOPs for approved genome edits.</Li>
      </Ul>

      <H3>Commercial</H3>
      <Ul>
        <Li><strong>tea_agent</strong> — BioSTEAM TEA + DCF analysis for compound routes.</Li>
        <Li><strong>regulatory_agent</strong> — US and EU regulatory pathway analysis; regulatory-adjusted NPV.</Li>
        <Li><strong>rnd_estimator</strong> — Phase durations, capital requirements, Monte Carlo simulation.</Li>
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
