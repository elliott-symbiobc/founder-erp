"""SMS integration via Twilio — inbound conversational task management.

Outbound sending was removed with the dashboard SMS widget: the daily digest
task, its Celery beat entries, and the send-digest endpoint. The inbound
webhook stays, because the Twilio number is still provisioned and pointed at
it, and /sms-consent stays with it for A2P registration. send_sms() is kept
because the webhook replies to incoming texts.
"""
import json
import logging
import os
from datetime import date, datetime, timezone

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, BackgroundTasks, Form, Request, Response
from twilio.request_validator import RequestValidator
from twilio.rest import Client as TwilioClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sms", tags=["sms"])


def _get_conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


def _twilio_client() -> TwilioClient:
    return TwilioClient(
        os.environ["TWILIO_ACCOUNT_SID"],
        os.environ["TWILIO_AUTH_TOKEN"],
    )


def send_sms(to: str, body: str) -> None:
    client = _twilio_client()
    client.messages.create(
        to=to,
        from_=os.environ["TWILIO_PHONE_NUMBER"],
        body=body,
    )


def _get_user_by_phone(conn, phone: str) -> dict | None:
    """Normalize phone and look up user."""
    digits = "".join(c for c in phone if c.isdigit())
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    # Match on last 10 digits to handle +1 prefix variants
    cur.execute(
        "SELECT user_id, full_name, name, phone FROM users WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = right(%s, 10) AND is_active = true",
        (digits,),
    )
    row = cur.fetchone()
    cur.close()
    return dict(row) if row else None


def _get_todays_tasks(conn, user_id: str) -> list[dict]:
    today = date.today()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT t.task_id::text, t.title, t.due_date, t.priority, t.status,
               t.kanban_status, t.project_id::text,
               p.name AS project_name
        FROM tasks t
        LEFT JOIN projects p ON p.project_id = t.project_id
        WHERE t.status = 'open'
          AND t.locked = false
          AND (t.assigned_to = %s::uuid OR t.user_id = %s::uuid)
        ORDER BY
          CASE WHEN t.due_date < CURRENT_DATE THEN 0 ELSE 1 END,
          CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          t.due_date NULLS LAST
        """,
        (user_id, user_id),
    )
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def _get_conversation_history(conn, user_id: str, limit: int = 10) -> list[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(
        """
        SELECT role, content FROM sms_conversations
        WHERE user_id = %s::uuid
        ORDER BY created_at DESC
        LIMIT %s
        """,
        (user_id, limit),
    )
    rows = cur.fetchall()
    cur.close()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def _save_message(conn, user_id: str, role: str, content: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO sms_conversations (user_id, role, content) VALUES (%s::uuid, %s, %s)",
        (user_id, role, content),
    )
    # Keep only last 20 messages per user
    cur.execute(
        """
        DELETE FROM sms_conversations
        WHERE user_id = %s::uuid AND id NOT IN (
            SELECT id FROM sms_conversations
            WHERE user_id = %s::uuid
            ORDER BY created_at DESC
            LIMIT 20
        )
        """,
        (user_id, user_id),
    )
    conn.commit()
    cur.close()


def _get_team_members(conn) -> list[dict]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT user_id::text, full_name, name FROM users WHERE is_active = true ORDER BY full_name")
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def _build_system_prompt(user_id: str, conn) -> str:
    tasks = _get_todays_tasks(conn, user_id)
    team = _get_team_members(conn)
    today = date.today().strftime("%Y-%m-%d")

    task_lines = []
    for i, t in enumerate(tasks, 1):
        task_lines.append(
            f'  {i}. task_id={t["task_id"]} | "{t["title"]}" | priority={t.get("priority","medium")} | '
            f'status={t.get("kanban_status","todo")} | project={t.get("project_name","none")} | due={t.get("due_date","none")}'
        )
    tasks_block = "\n".join(task_lines) if task_lines else "  (none)"

    team_lines = [f'  - user_id={m["user_id"]} | {m["full_name"] or m["name"]}' for m in team]
    team_block = "\n".join(team_lines)

    return f"""You are the Founder ERP platform assistant, responding via SMS. Today is {today}.

The user has {len(tasks)} open tasks total. Full list numbered for reference:
{tasks_block}

Team members available for assignment:
{team_block}

You can perform these actions by responding with a JSON action block followed by a plain-text reply:

Actions (include as JSON on first line if needed):
{{"action":"complete_tasks","task_ids":["<uuid>","<uuid>"]}}
{{"action":"create_task","title":"<title>","priority":"low|medium|high","due_date":"YYYY-MM-DD or null","project_id":"<uuid> or null","assigned_to":"<user_id> or null"}}
{{"action":"assign_task","task_id":"<uuid>","assigned_to":"<user_id>"}}
{{"action":"get_status","entity":"tasks|projects"}}
{{"action":"none"}}

Rules:
- CRITICAL: All task counts, task names, and task details MUST come from the numbered list above. Never use memory or prior conversation to answer questions about tasks — always reference the list in this prompt.
- Keep replies concise and SMS-friendly (under 320 chars when possible).
- Tasks are numbered above. If the user references tasks by number (e.g. "1 and 3 are done"), look up the task_ids by those numbers and use complete_tasks with all of them in task_ids.
- If user says things like "done", "finished", or "completed" for a task or tasks, use complete_tasks.
- If asked to assign a task to someone, match the name to the team member list and use assign_task.
- If asked to create a task, use create_task. If a person is mentioned, set assigned_to from the team list.
- Always end with the plain-text reply for the user on a new line after the JSON (or just reply text if no action).
- When listing tasks in your reply, always prefix each with its number from the list above (e.g. "1. Task title").
- If the user asks how to do something (e.g. "how do I file a 990"), use the web_search tool to look it up and give a SHORT summary (3-5 sentences max, under 600 chars total) referencing the relevant tasks by number.
- Do NOT include markdown, bullet symbols, or formatting beyond plain text."""


def _execute_action(conn, user_id: str, action: dict) -> str | None:
    """Execute a structured action and return a status string, or None."""
    act = action.get("action")
    if act in ("complete_task", "complete_tasks"):
        # Support both single task_id and list of task_ids
        task_ids = action.get("task_ids") or ([action.get("task_id")] if action.get("task_id") else [])
        if not task_ids:
            return None
        cur = conn.cursor()
        for task_id in task_ids:
            cur.execute(
                "UPDATE tasks SET status = 'done', kanban_status = 'done', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE task_id = %s::uuid AND (assigned_to = %s::uuid OR user_id = %s::uuid)",
                (task_id, user_id, user_id),
            )
        conn.commit()
        cur.close()
        return f"marked_done:{len(task_ids)}"
    elif act == "assign_task":
        task_id = action.get("task_id")
        assigned_to = action.get("assigned_to")
        if not task_id or not assigned_to:
            return None
        cur = conn.cursor()
        cur.execute(
            "UPDATE tasks SET assigned_to = %s::uuid, updated_at = now() WHERE task_id = %s::uuid",
            (assigned_to, task_id),
        )
        conn.commit()
        cur.close()
        return "assigned"
    elif act == "create_task":
        title = action.get("title", "New task")
        priority = action.get("priority", "medium")
        due_date = action.get("due_date") or None
        project_id = action.get("project_id") or None
        assigned_to = action.get("assigned_to") or user_id
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO tasks (user_id, assigned_to, title, priority, due_date, project_id, status, kanban_status)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s, %s, 'open', 'todo')
            RETURNING task_id
            """,
            (user_id, assigned_to, title, priority, due_date, project_id),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()
        return f"created:{row[0]}" if row else "created"
    return None


def _claude_reply(system: str, messages: list[dict], user_message: str) -> tuple[str, dict | None]:
    """Call Claude with web search tool support. Returns (reply_text, action_or_None)."""
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    msgs = messages + [{"role": "user", "content": user_message}]

    tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}]

    # Agentic loop: keep going until Claude stops calling tools
    while True:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=system,
            messages=msgs,
            tools=tools,
        )

        # If Claude wants to use a tool, the results come back automatically
        # in the content blocks — append them and continue
        if response.stop_reason == "tool_use":
            msgs.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in response.content:
                if block.type == "tool_result":
                    tool_results.append({"type": "tool_result", "tool_use_id": block.tool_use_id, "content": block.content})
            if tool_results:
                msgs.append({"role": "user", "content": tool_results})
            continue

        # Final text response — join all text blocks (web search returns multiple)
        raw = "".join(b.text for b in response.content if hasattr(b, "text")).strip()
        break

    # Parse optional leading JSON action
    action = None
    reply = raw
    if raw.startswith("{"):
        try:
            first_line = raw.split("\n")[0]
            action = json.loads(first_line)
            reply = raw[len(first_line):].strip()
        except Exception:
            pass

    return reply, action


_SEARCH_KEYWORDS = ("how do i", "how to", "what is", "how does", "explain", "help me", "what are", "can you look up", "search for")


def _looks_like_search(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in _SEARCH_KEYWORDS)


def _process_sms_async(from_number: str, body: str, user_id: str) -> None:
    """Run Claude, execute any action, and send reply via outbound SMS."""
    conn = _get_conn()
    try:
        history = _get_conversation_history(conn, user_id)
        system = _build_system_prompt(user_id, conn)
        reply, action = _claude_reply(system, history, body)

        if action and action.get("action") != "none":
            _execute_action(conn, user_id, action)

        _save_message(conn, user_id, "user", body)
        _save_message(conn, user_id, "assistant", reply)

        # Truncate to avoid carrier filtering of very long concatenated SMS
        if len(reply) > 1500:
            reply = reply[:1497] + "..."
        send_sms(from_number, reply)
    except Exception as exc:
        logger.exception("SMS async processing error: %s", exc)
        send_sms(from_number, "Sorry, something went wrong. Please try again.")
    finally:
        conn.close()


@router.post("/webhook")
async def twilio_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    From: str = Form(...),
    Body: str = Form(...),
):
    """Receive incoming SMS from Twilio."""
    # Validate Twilio signature
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "")
    if auth_token:
        validator = RequestValidator(auth_token)
        public_url = "https://erp.example.com/api/sms/webhook"
        form_data = dict(await request.form())
        signature = request.headers.get("X-Twilio-Signature", "")
        if not validator.validate(public_url, form_data, signature):
            logger.warning("Invalid Twilio signature from %s", From)
            return Response(content="", media_type="application/xml", status_code=403)

    conn = _get_conn()
    try:
        user = _get_user_by_phone(conn, From)
        if not user:
            logger.warning("SMS from unknown number %s", From)
            return Response(
                content='<?xml version="1.0"?><Response><Message>Sorry, your number is not registered on the Founder ERP platform.</Message></Response>',
                media_type="application/xml",
            )

        user_id = str(user["user_id"])

        # For search queries, send an immediate acknowledgment before the slow Claude call
        if _looks_like_search(Body):
            send_sms(From, "One second, let me search for that...")

        # Process the message in the background so Twilio gets a fast 200 response
        background_tasks.add_task(_process_sms_async, From, Body, user_id)

        # Return empty TwiML — the real reply comes via outbound send_sms above
        return Response(content='<?xml version="1.0"?><Response></Response>', media_type="application/xml")

    except Exception as exc:
        logger.exception("SMS webhook error: %s", exc)
        return Response(
            content='<?xml version="1.0"?><Response><Message>Sorry, something went wrong. Please try again.</Message></Response>',
            media_type="application/xml",
        )
    finally:
        conn.close()
