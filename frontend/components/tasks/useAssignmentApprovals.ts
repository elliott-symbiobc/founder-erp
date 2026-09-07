"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Pending "task assigned to you" notifications, keyed by the task they point at.
 *
 * This was previously reachable only from the My Work drawer in the shell
 * header, which made accepting a delegated task a thing you did somewhere other
 * than where the task was. The task itself now lives in the Inbox column, so the
 * accept lives on the card.
 *
 * Keyed by entity_id (the task) rather than by notification id, because the
 * caller has a task in hand and needs to ask "is this one still waiting on me?"
 */

interface AssignmentNotification {
  notification_id: string;
  notification_type: string;
  status: string;
  entity_id: string | null;
  message: string | null;
}

const POLL_MS = 60_000;

export function useAssignmentApprovals() {
  const [byTask, setByTask] = useState<Record<string, string>>({});
  const [responding, setResponding] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/notifications");
      if (!res.ok) return;
      const d = await res.json();
      const map: Record<string, string> = {};
      for (const n of (d.notifications ?? []) as AssignmentNotification[]) {
        if (n.notification_type === "task_assigned" && n.status === "pending" && n.entity_id) {
          map[n.entity_id] = n.notification_id;
        }
      }
      setByTask(map);
    } catch { /* the board is still usable without this */ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, POLL_MS);
    return () => clearInterval(iv);
  }, [load]);

  // "denied" is the wire value the endpoint validates against; the buttons say
  // Accept and Decline. Sending "declined" 422s.
  const respond = useCallback(async (
    taskId: string,
    action: "approved" | "denied",
  ): Promise<boolean> => {
    const notifId = byTask[taskId];
    if (!notifId) return false;
    setResponding(prev => new Set(prev).add(taskId));
    // Drop it locally first — the card's buttons should go away on click, not a
    // round-trip later. Put back on failure, rather than leaving the user
    // believing an answer was recorded that never reached the server.
    setByTask(prev => { const n = { ...prev }; delete n[taskId]; return n; });
    try {
      const res = await fetch(`/api/proxy/notifications/${notifId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        setByTask(prev => ({ ...prev, [taskId]: notifId }));
        setError("That did not go through. Try again.");
        return false;
      }
      setError(null);
      return true;
    } catch {
      load();
      setError("That did not go through. Try again.");
      return false;
    } finally {
      setResponding(prev => { const n = new Set(prev); n.delete(taskId); return n; });
    }
  }, [byTask, load]);

  return {
    isPending: (taskId: string) => !!byTask[taskId],
    isResponding: (taskId: string) => responding.has(taskId),
    error,
    respond,
  };
}
