"""
notifications.py — In-app notification inbox for task/project assignments.

GET    /notifications                   — list notifications for current user
POST   /notifications/{id}/respond      — approve or deny an assignment
PATCH  /notifications/{id}/read         — mark notification as read
GET    /notifications/preferences       — get current user's notification prefs
PATCH  /notifications/preferences       — update notify_email
"""
import logging
import os
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)

# Notification types that mean a person is waiting on you, as opposed to the
# ambient ones (notebook shares, portal views). Only these light the bell and
# raise a popup; everything else still lists in the panel.
ACTIONABLE_TYPES = ["task_assigned", "review_requested", "review_resolved"]

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _conn():
    return psycopg2.connect(os.environ["DATABASE_URL"])


class RespondBody(BaseModel):
    action: str  # 'approved' | 'denied'


class PreferencesBody(BaseModel):
    notify_email: Optional[bool] = None


class SendNotificationBody(BaseModel):
    recipient_ids: list[str]
    title: str
    message: Optional[str] = None


def _fmt(row: dict) -> dict:
    d = dict(row)
    for f in ("notification_id", "recipient_id", "sender_id", "entity_id"):
        if d.get(f):
            d[f] = str(d[f])
    for ts in ("created_at", "read_at"):
        if d.get(ts) and hasattr(d[ts], "isoformat"):
            d[ts] = d[ts].isoformat()
    return d


@router.get("")
def list_notifications(
    request: Request,
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        where = "WHERE n.recipient_id = %s::uuid"
        params = [user["user_id"]]
        if unread_only:
            where += " AND n.status = 'pending'"

        cur.execute(
            f"""
            SELECT n.*,
                   s.name  AS sender_name,
                   s.email AS sender_email
            FROM task_notifications n
            LEFT JOIN users s ON s.user_id = n.sender_id
            {where}
            ORDER BY
                CASE WHEN n.status = 'pending' THEN 0 ELSE 1 END,
                n.created_at DESC
            LIMIT %s
            """,
            params + [limit],
        )
        rows = [_fmt(r) for r in cur.fetchall()]

        # Two counts, because the bell badge and the list answer different
        # questions. The list still shows everything -- notebook shares, portal
        # views, messages someone sent you -- but the badge and the popup are
        # reserved for the types where a person is waiting on you: a task
        # handed over, a review asked of you, or a verdict on a review you
        # requested. Counted here rather than from `rows`, which is capped at
        # `limit` and would undercount.
        cur.execute(
            """
            SELECT COUNT(*) FILTER (WHERE status = 'pending')                AS unread,
                   COUNT(*) FILTER (WHERE status = 'pending'
                                      AND notification_type = ANY(%s))       AS actionable
            FROM task_notifications
            WHERE recipient_id = %s::uuid
            """,
            (ACTIONABLE_TYPES, user["user_id"]),
        )
        counts = cur.fetchone()

        return {
            "notifications": rows,
            "unread_count": int(counts["unread"]),
            "actionable_unread_count": int(counts["actionable"]),
            # Kept so an older cached bundle does not read undefined and blank
            # the badge mid-deploy.
            "assignment_unread_count": int(counts["actionable"]),
        }
    finally:
        conn.close()


@router.post("/{notification_id}/respond")
def respond_notification(notification_id: str, body: RespondBody, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if body.action not in ("approved", "denied"):
        raise HTTPException(status_code=422, detail="action must be 'approved' or 'denied'")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT * FROM task_notifications WHERE notification_id = %s::uuid AND recipient_id = %s::uuid",
            (notification_id, user["user_id"]),
        )
        notif = cur.fetchone()
        if not notif:
            raise HTTPException(status_code=404, detail="Notification not found")
        if notif["status"] not in ("pending",):
            raise HTTPException(status_code=409, detail="Notification already responded to")

        cur.execute(
            "UPDATE task_notifications SET status = %s, read_at = now() WHERE notification_id = %s::uuid RETURNING *",
            (body.action, notification_id),
        )
        row = _fmt(cur.fetchone())

        if body.action == "approved":
            # Accepting takes the task out of triage. Without this the Inbox
            # column never drains: the notification clears but the card stays
            # where it was, so the board keeps presenting a decision already
            # made. Only Inbox moves -- a task accepted from anywhere else is
            # already somewhere its owner put it.
            if notif["entity_type"] == "task":
                cur.execute(
                    """
                    UPDATE tasks SET kanban_status = 'todo', updated_at = now()
                    WHERE task_id = %s::uuid AND assigned_to = %s::uuid
                      AND kanban_status = 'inbox'
                    """,
                    (str(notif["entity_id"]), user["user_id"]),
                )

        # Declining hands the work back rather than dropping it.
        if body.action == "denied":
            if notif["entity_type"] == "task":
                # This used to set assigned_to = NULL, which cannot succeed:
                # migration 140 made the column NOT NULL precisely so a task
                # could never sit on nobody's board. So every decline threw and
                # rolled back the status update with it -- declining an
                # assignment has never worked since that migration landed.
                #
                # The task goes back to whoever sent it, which is migration
                # 140's own backfill rule (a task with no assignee falls to its
                # creator) and leaves someone accountable for it. It also
                # returns to their Inbox, so the hand-back is visible rather
                # than silent. sender_id is preferred over the task's creator:
                # the person who asked is the person to answer to.
                cur.execute(
                    """
                    UPDATE tasks t
                    SET assigned_to = COALESCE(%s::uuid, t.user_id),
                        kanban_status = 'inbox',
                        updated_at = now()
                    WHERE t.task_id = %s::uuid AND t.assigned_to = %s::uuid
                    """,
                    (
                        str(notif["sender_id"]) if notif.get("sender_id") else None,
                        str(notif["entity_id"]),
                        user["user_id"],
                    ),
                )
            elif notif["entity_type"] == "project":
                cur.execute(
                    "UPDATE projects SET assigned_to = NULL, updated_at = now() WHERE project_id = %s::uuid AND assigned_to = %s::uuid",
                    (str(notif["entity_id"]), user["user_id"]),
                )

        conn.commit()
        return row
    finally:
        conn.close()


@router.patch("/{notification_id}/read")
def mark_read(notification_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            """
            UPDATE task_notifications
            SET status = CASE WHEN status = 'pending' THEN 'read' ELSE status END,
                read_at = COALESCE(read_at, now())
            WHERE notification_id = %s::uuid AND recipient_id = %s::uuid
            RETURNING *
            """,
            (notification_id, user["user_id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Notification not found")
        conn.commit()
        return _fmt(row)
    finally:
        conn.close()


@router.delete("/{notification_id}", status_code=204)
def delete_notification(notification_id: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM task_notifications WHERE notification_id = %s::uuid AND recipient_id = %s::uuid",
            (notification_id, user["user_id"]),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Notification not found")
        conn.commit()
    finally:
        conn.close()


@router.delete("")
def clear_notifications(request: Request, include_pending: bool = False):
    """Clear the current user's notifications.

    Assignments still waiting on an accept/decline are kept by default. The
    Inbox column reads those pending rows to decide whether to offer Accept and
    Decline on a delegated task, so deleting them would take the decision away
    while leaving the task sitting there — the notification is the only record
    that an answer is still owed. Pass include_pending=true to wipe those too.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor()
        if include_pending:
            cur.execute(
                "DELETE FROM task_notifications WHERE recipient_id = %s::uuid",
                (user["user_id"],),
            )
        else:
            cur.execute(
                """
                DELETE FROM task_notifications
                WHERE recipient_id = %s::uuid
                  AND NOT (status = 'pending' AND notification_type = 'task_assigned')
                """,
                (user["user_id"],),
            )
        deleted = cur.rowcount
        conn.commit()

        cur.execute(
            """
            SELECT COUNT(*) FROM task_notifications
            WHERE recipient_id = %s::uuid
              AND status = 'pending' AND notification_type = 'task_assigned'
            """,
            (user["user_id"],),
        )
        kept = cur.fetchone()[0]
        return {"deleted": deleted, "kept_awaiting_response": kept}
    finally:
        conn.close()


@router.get("/preferences")
def get_preferences(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT notify_email FROM users WHERE user_id = %s::uuid",
            (user["user_id"],),
        )
        row = cur.fetchone()
        if not row:
            return {"notify_email": False}
        return dict(row)
    finally:
        conn.close()


@router.post("/send", status_code=201)
def send_notification(body: SendNotificationBody, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if not body.title.strip():
        raise HTTPException(status_code=422, detail="Title cannot be empty")
    if not body.recipient_ids:
        raise HTTPException(status_code=422, detail="At least one recipient required")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        sent = []
        for rid in body.recipient_ids:
            if rid == user["user_id"]:
                continue  # don't notify yourself
            try:
                cur.execute(
                    """
                    INSERT INTO task_notifications
                        (recipient_id, sender_id, notification_type, entity_type, title, message)
                    VALUES (%s::uuid, %s::uuid, 'general', 'general', %s, %s)
                    RETURNING notification_id::text
                    """,
                    (rid, user["user_id"], body.title.strip(), body.message),
                )
                row = cur.fetchone()
                if row:
                    sent.append(row["notification_id"])
            except Exception as e:
                logger.warning("Failed to send notification to %s: %s", rid, e)
        conn.commit()
        return {"sent": len(sent), "notification_ids": sent}
    finally:
        conn.close()


@router.patch("/preferences")
def update_preferences(body: PreferencesBody, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    sets = ["updated_at = now()"]
    params = []

    if body.notify_email is not None:
        sets.append("notify_email = %s"); params.append(body.notify_email)

    if len(sets) == 1:
        raise HTTPException(status_code=422, detail="No fields to update")

    conn = _conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        params.append(user["user_id"])
        cur.execute(
            f"UPDATE users SET {', '.join(sets)} WHERE user_id = %s::uuid RETURNING notify_email",
            params,
        )
        row = cur.fetchone()
        conn.commit()
        return dict(row) if row else {}
    finally:
        conn.close()


def create_notification(
    conn,
    recipient_id: str,
    sender_id: str,
    notification_type: str,
    entity_type: str,
    entity_id: str,
    title: str,
    message: Optional[str] = None,
):
    """Helper called from tasks/projects when assignments are made."""
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO task_notifications
                (recipient_id, sender_id, notification_type, entity_type, entity_id, title, message)
            VALUES (%s::uuid, %s::uuid, %s, %s, %s::uuid, %s, %s)
            """,
            (recipient_id, sender_id, notification_type, entity_type, entity_id, title, message),
        )
    except Exception as e:
        logger.warning("Failed to create notification: %s", e)
