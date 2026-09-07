"""
rag.py — Retrieval-Augmented Generation core for the Open ERP dashboard agent.

Pipeline:
  1. embed_query()         — embed the user's latest message
  2. retrieve_chunks()     — cosine ANN + recency + source-priority hybrid score
  3. mmr_rerank()          — Maximal Marginal Relevance deduplication
  4. format_retrieved_context() — assemble into a prompt-ready string
"""
import logging
import math
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Scoring weights
# ---------------------------------------------------------------------------
W_COSINE   = 0.75
W_RECENCY  = 0.15
W_PRIORITY = 0.10

SOURCE_PRIORITY = {
    "tasks":       1.0,
    "notes":       0.9,
    "eln_entries": 0.85,
    "contacts":    0.7,
    "papers":      0.6,
}

MMR_LAMBDA = 0.6   # trade-off relevance vs diversity
RETRIEVE_K = 12    # candidates from ANN search
FINAL_K    = 8     # chunks after MMR rerank

TOKEN_BUDGET_CHARS = 6000   # ~1500 tokens for retrieved context block


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_query(text: str) -> list[float]:
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8192],
    )
    return resp.data[0].embedding


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

def retrieve_chunks(
    conn,
    user_id: str,
    query_vec: list[float],
    k: int = RETRIEVE_K,
) -> list[dict]:
    """ANN cosine search + hybrid re-score.

    Returns list of dicts: {chunk_id, source_table, source_id, content,
                             cosine, recency_score, priority_score, hybrid_score}
    """
    vec_str = "[" + ",".join(str(v) for v in query_vec) + "]"
    cur = conn.cursor()
    cur.execute(
        """
        SELECT chunk_id::text,
               source_table,
               source_id,
               chunk_index,
               content,
               1 - (embedding <=> %s::vector) AS cosine,
               updated_at
        FROM context_chunks
        WHERE user_id = %s::uuid
          AND embedding IS NOT NULL
        ORDER BY embedding <=> %s::vector
        LIMIT %s
        """,
        (vec_str, user_id, vec_str, k * 3),   # fetch 3× to allow re-scoring
    )
    rows = cur.fetchall()
    cur.close()

    if not rows:
        return []

    # Recency score: exponential decay, half-life = 30 days
    import datetime
    now = datetime.datetime.utcnow()
    chunks = []
    for row in rows:
        chunk_id, src_table, src_id, chunk_idx, content, cosine, updated_at = row
        if updated_at and updated_at.tzinfo:
            updated_at = updated_at.replace(tzinfo=None)
        age_days = (now - updated_at).total_seconds() / 86400 if updated_at else 365
        recency = math.exp(-age_days / 30)
        priority = SOURCE_PRIORITY.get(src_table, 0.5)
        hybrid = W_COSINE * cosine + W_RECENCY * recency + W_PRIORITY * priority
        chunks.append({
            "chunk_id":    chunk_id,
            "source_table": src_table,
            "source_id":   src_id,
            "chunk_index": chunk_idx,
            "content":     content,
            "cosine":      cosine,
            "recency":     recency,
            "priority":    priority,
            "hybrid":      hybrid,
        })

    chunks.sort(key=lambda x: x["hybrid"], reverse=True)
    return chunks[:k]


# ---------------------------------------------------------------------------
# MMR rerank
# ---------------------------------------------------------------------------

def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def mmr_rerank(
    chunks: list[dict],
    query_vec: list[float],
    k: int = FINAL_K,
    lam: float = MMR_LAMBDA,
) -> list[dict]:
    """Select k chunks maximising relevance minus similarity to already-selected."""
    if not chunks:
        return []
    k = min(k, len(chunks))

    # We need chunk embeddings to compute inter-chunk similarity.
    # Since we don't store them in the result dict, approximate via content similarity
    # using cosine scores as proxy: penalise consecutive chunks from same source.
    selected: list[dict] = []
    remaining = list(chunks)

    while len(selected) < k and remaining:
        if not selected:
            # First pick: highest hybrid score
            best = remaining.pop(0)
            selected.append(best)
            continue

        # MMR score = λ * relevance - (1-λ) * max_sim_to_selected
        # Use hybrid as relevance proxy; penalise same source_id heavily
        best_score = -1.0
        best_idx = 0
        for i, cand in enumerate(remaining):
            relevance = cand["hybrid"]
            # Redundancy penalty: max fraction of selected with same source_id
            same_source = sum(1 for s in selected if s["source_id"] == cand["source_id"])
            redundancy = same_source / len(selected)
            score = lam * relevance - (1 - lam) * redundancy
            if score > best_score:
                best_score = score
                best_idx = i
        selected.append(remaining.pop(best_idx))

    return selected


# ---------------------------------------------------------------------------
# Format
# ---------------------------------------------------------------------------

def format_retrieved_context(chunks: list[dict]) -> str:
    if not chunks:
        return ""

    source_labels = {
        "notes":       "Meeting Note",
        "eln_entries": "Lab Notebook Entry",
        "papers":      "Research Paper",
        "contacts":    "Contact",
        "tasks":       "Task",
    }

    parts = ["### Semantically Retrieved Context\n"]
    total_chars = 0
    for chunk in chunks:
        label = source_labels.get(chunk["source_table"], chunk["source_table"].title())
        header = f"[{label}]"
        body = chunk["content"].strip()
        entry = f"{header}\n{body}\n"
        if total_chars + len(entry) > TOKEN_BUDGET_CHARS:
            break
        parts.append(entry)
        total_chars += len(entry)

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# High-level helper: query → formatted string
# ---------------------------------------------------------------------------

def rag_context_for_query(conn, user_id: str, query: str) -> str:
    """Full RAG pipeline: embed → retrieve → MMR → format."""
    if not os.environ.get("OPENAI_API_KEY"):
        logger.warning("rag_context_for_query: OPENAI_API_KEY not set, skipping RAG")
        return ""
    try:
        q_vec = embed_query(query)
        chunks = retrieve_chunks(conn, user_id, q_vec)
        reranked = mmr_rerank(chunks, q_vec)
        return format_retrieved_context(reranked)
    except Exception as exc:
        logger.warning("rag_context_for_query failed: %s", exc)
        return ""
