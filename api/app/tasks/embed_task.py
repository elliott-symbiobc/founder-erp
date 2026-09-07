"""
embed_task.py — Embed a content item into context_chunks for RAG retrieval.

Chunks text at ~400 tokens (~1600 chars) with 80-char overlap.
Uses OpenAI text-embedding-3-small (1536-dim).
"""
import logging
import os
import textwrap
from typing import Optional

import psycopg2

logger = logging.getLogger(__name__)

CHUNK_SIZE = 1600   # chars (~400 tokens)
CHUNK_OVERLAP = 80  # chars

SOURCE_QUERIES = {
    "notes": """
        SELECT n.note_id::text, n.user_id::text,
               coalesce(n.title,'') || E'\n' ||
               coalesce(n.ai_summary, n.raw_transcript, '') AS body
        FROM notes n WHERE n.note_id = %s::uuid
    """,
    "contacts": """
        SELECT c.contact_id::text, c.user_id::text,
               coalesce(c.name,'') || E'\n' ||
               coalesce(c.organization,'') || ' ' || coalesce(c.role,'') || E'\n' ||
               coalesce(c.ai_summary,'') AS body
        FROM contacts c WHERE c.contact_id = %s::uuid
    """,
    "tasks": """
        SELECT t.task_id::text, t.user_id::text,
               coalesce(t.title,'') || E'\n' ||
               coalesce(t.description,'') AS body
        FROM tasks t WHERE t.task_id = %s::uuid
    """,
}


def _chunk_text(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def _get_embedding(text: str) -> list[float]:
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:8192],
    )
    return resp.data[0].embedding


def embed_content(source_table: str, source_id: str, user_id: Optional[str] = None) -> dict:
    """Fetch content, chunk it, embed each chunk, upsert into context_chunks."""
    if source_table not in SOURCE_QUERIES:
        return {"status": "error", "reason": f"unknown table: {source_table}"}

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        cur = conn.cursor()
        cur.execute(SOURCE_QUERIES[source_table], (source_id,))
        row = cur.fetchone()
        if not row:
            return {"status": "skipped", "reason": "not_found"}

        src_id, src_user_id, body = row
        uid = user_id or src_user_id

        chunks = _chunk_text(body)
        if not chunks:
            return {"status": "skipped", "reason": "empty_body"}

        embedded = 0
        for idx, chunk in enumerate(chunks):
            try:
                vec = _get_embedding(chunk)
                vec_str = "[" + ",".join(str(v) for v in vec) + "]"
                cur.execute(
                    """
                    INSERT INTO context_chunks
                        (user_id, source_table, source_id, chunk_index, content, embedding, updated_at)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s::vector, now())
                    ON CONFLICT (source_table, source_id, chunk_index)
                    DO UPDATE SET
                        content   = EXCLUDED.content,
                        embedding = EXCLUDED.embedding,
                        updated_at = now()
                    """,
                    (uid, source_table, src_id, idx, chunk, vec_str),
                )
                embedded += 1
            except Exception as e:
                logger.warning("embed_content: chunk %d failed for %s/%s: %s", idx, source_table, source_id, e)

        # Remove stale chunks if doc shrank
        cur.execute(
            "DELETE FROM context_chunks WHERE source_table=%s AND source_id=%s AND chunk_index >= %s",
            (source_table, src_id, len(chunks)),
        )
        conn.commit()
        logger.info("embed_content: %s/%s → %d chunks embedded", source_table, source_id, embedded)
        return {"status": "ok", "chunks": embedded}

    except Exception as exc:
        logger.exception("embed_content failed for %s/%s", source_table, source_id)
        conn.rollback()
        return {"status": "error", "error": str(exc)}
    finally:
        conn.close()


def backfill_all(user_id: Optional[str] = None) -> dict:
    """Embed every row in all source tables. Used for initial backfill."""
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    totals: dict[str, int] = {}
    try:
        cur = conn.cursor()
        # uid_col=None means the table has no user_id column (papers are system content)
        table_pks = {
            "notes":       ("note_id",    "user_id"),
            "eln_entries": ("entry_id",   "user_id"),
            "papers":      ("paper_id",   None),
            "contacts":    ("contact_id", "user_id"),
            "tasks":       ("task_id",    "user_id"),
        }
        for table, (pk_col, uid_col) in table_pks.items():
            if user_id and uid_col:
                cur.execute(f"SELECT {pk_col}::text FROM {table} WHERE {uid_col} = %s::uuid", (user_id,))
            else:
                cur.execute(f"SELECT {pk_col}::text FROM {table}")
            ids = [r[0] for r in cur.fetchall()]
            totals[table] = len(ids)
            for sid in ids:
                embed_content(table, sid, user_id=user_id if uid_col else None)
    finally:
        conn.close()
    return {"status": "ok", "counts": totals}
