import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Warning, Concept, Code } from "../_components";

export default function AiAssistantPage() {
  return (
    <article>
      <H1>AI Assistant &amp; Dashboard Intelligence</H1>
      <Lead>
        The dashboard AI assistant is an omnipresent executive assistant with live access to every
        module — tasks, lab notebook, meeting notes, contacts, funding, financials, strains, and
        literature. It uses a semantic RAG pipeline to surface the most relevant information for
        each conversation turn.
      </Lead>

      <H2>What It Can Do</H2>
      <Ul>
        <Li><strong>Brain dumps</strong> — speak or type a stream of consciousness; the assistant extracts and creates tasks automatically.</Li>
        <Li><strong>Daily priorities</strong> — asks what you should focus on today using real task data, calendar commitments, and overdue items.</Li>
        <Li><strong>R&amp;D questions</strong> — retrieves semantically relevant ELN entries, papers, and notes to answer specific questions.</Li>
        <Li><strong>Business development</strong> — surfaces relevant contacts, funding opportunities, and project status.</Li>
        <Li><strong>Proactive flagging</strong> — warns about overdue tasks, low runway, stalled R&amp;D, or at-risk projects.</Li>
      </Ul>

      <Concept>
        Tasks extracted from brain dumps go to your <strong>task list</strong>, never the calendar.
        The assistant uses your calendar to understand time already committed, but does not modify it.
      </Concept>

      <H2>How It Works — The RAG Pipeline</H2>
      <P>
        Every message you send triggers a four-step context engineering pipeline before Claude
        sees your question:
      </P>
      <Ol>
        <Li><strong>Embed query</strong> — your message is converted to a 1536-dimensional vector using OpenAI <Code>text-embedding-3-small</Code>.</Li>
        <Li><strong>Retrieve chunks</strong> — the vector database (pgvector) finds the 12 most similar content chunks from your notes, lab entries, contacts, tasks, and papers using cosine similarity.</Li>
        <Li><strong>Hybrid re-score</strong> — chunks are re-ranked by a weighted score: 75% semantic similarity + 15% recency (half-life 30 days) + 10% source priority (tasks rank highest, papers lowest).</Li>
        <Li><strong>MMR rerank</strong> — Maximal Marginal Relevance selects 8 diverse, non-redundant chunks from the top 12 candidates, avoiding showing you five chunks from the same document.</Li>
      </Ol>

      <H2>System Prompt Architecture</H2>
      <P>
        The assistant receives three information blocks on every turn:
      </P>
      <Ul>
        <Li><strong>Block A — Static role context</strong> (prompt-cached): Your role as Open ERP founder, response format rules, behavior instructions. Identical across all turns so Anthropic caches it — saves ~70% of input token costs on multi-turn conversations.</Li>
        <Li><strong>Block B — Live structured data</strong>: Today&apos;s open tasks, calendar events, contact reminders, active projects, FP&A snapshot, recent ELN entries, meeting notes, strains, compound opportunities, key contacts, and funding opportunities — fetched fresh from the database on every request.</Li>
        <Li><strong>Block C — Semantic RAG results</strong>: The 8 retrieved chunks most relevant to your current message, formatted as labelled excerpts.</Li>
      </Ul>

      <H2>How Content Gets Into the RAG Index</H2>
      <P>
        Content is automatically embedded whenever you create or update records in these modules:
      </P>
      <Ul>
        <Li><strong>Meeting Notes</strong> — on create and every save</Li>
        <Li><strong>Lab Notebook entries</strong> — on create and every save</Li>
        <Li><strong>Contacts</strong> — on create and profile update</Li>
        <Li><strong>Tasks</strong> — on create and status update</Li>
        <Li><strong>Literature Papers</strong> — on metadata update</Li>
      </Ul>
      <P>
        A nightly job at 01:30 UTC also re-embeds anything updated in the last 25 hours as a
        safety net for any missed triggers.
      </P>

      <Tip>
        The more complete your notes, contacts, and task descriptions are, the better the assistant
        can retrieve relevant context. Short titles with no body will produce weak retrieval.
      </Tip>

      <H2>Response Format</H2>
      <P>
        The assistant always responds with a structured JSON object the UI unpacks:
      </P>
      <Ul>
        <Li><strong>reply</strong> — the visible response (supports markdown)</Li>
        <Li><strong>extracted_tasks</strong> — tasks to add to your task list (only populated when you give a brain dump or explicitly ask to add something)</Li>
        <Li><strong>suggest_replan</strong> — signals the UI to offer regenerating the daily plan when urgent tasks were captured</Li>
      </Ul>

      <H2>Daily &amp; Weekly Plans</H2>
      <P>
        Separate from the chat, the planner generates structured AI plans:
      </P>
      <Ul>
        <Li><strong>Daily plan</strong> — generated at 06:00 CST, creates time-blocked plan blocks from your tasks and calendar events.</Li>
        <Li><strong>Weekly plan</strong> — generated at 06:00 CST every Monday, sets theme and priorities for the week.</Li>
        <Li>Both auto-generate for all users with a connected Google account. You can also trigger manually from the dashboard.</Li>
      </Ul>

      <Warning>
        RAG retrieval requires <Code>OPENAI_API_KEY</Code> to be set in the environment. If it is
        not set (or if <Code>RAG_ENABLED=false</Code>), the assistant silently skips Block C and
        operates on the structured context alone — it still works, but cannot do semantic retrieval.
      </Warning>
    </article>
  );
}
