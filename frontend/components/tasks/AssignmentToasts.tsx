"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A popup when someone assigns you a task.
 *
 * The bell badge tells you a thing exists; it does not interrupt. An assignment
 * is the one notification that asks you to do something, so it gets a toast.
 * Everything else stays in the panel and waits to be looked at.
 *
 * Only genuinely new assignments pop. The first poll after mount seeds the
 * "seen" set without firing, or every reload would replay the whole backlog as
 * a stack of toasts.
 */

interface AssignmentNotification {
  notification_id: string;
  notification_type: string;
  status: string;
  entity_id: string | null;
  title: string;
  message: string | null;
  sender_name: string | null;
}

// Mirrors ACTIONABLE_TYPES on the API: the notifications where a person is
// waiting on you, as opposed to the ambient ones that only list in the panel.
const ACTIONABLE = new Set(["task_assigned", "review_requested", "review_resolved"]);

const EYEBROW: Record<string, (sender: string | null) => string> = {
  task_assigned:    s => (s ? `${s} assigned you a task` : "Task assigned to you"),
  review_requested: s => (s ? `${s} asked you to review` : "Review requested of you"),
  review_resolved:  s => (s ? `${s} reviewed your task` : "Your review came back"),
};

const POLL_MS = 30_000;
const DISMISS_MS = 10_000;
const MAX_VISIBLE = 3;

export default function AssignmentToasts() {
  const [toasts, setToasts] = useState<AssignmentNotification[]>([]);
  const seen = useRef<Set<string> | null>(null);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.notification_id !== id));
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/notifications");
      if (!res.ok) return;
      const d = await res.json();
      const pending: AssignmentNotification[] = (d.notifications ?? []).filter(
        (n: AssignmentNotification) =>
          ACTIONABLE.has(n.notification_type) && n.status === "pending"
      );

      // First poll: remember what was already there, pop nothing.
      if (seen.current === null) {
        seen.current = new Set(pending.map(n => n.notification_id));
        return;
      }

      const fresh = pending.filter(n => !seen.current!.has(n.notification_id));
      for (const n of pending) seen.current.add(n.notification_id);
      if (fresh.length) {
        setToasts(prev => [...fresh, ...prev].slice(0, MAX_VISIBLE));
      }
    } catch { /* a missed poll is not worth surfacing */ }
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => clearInterval(iv);
  }, [poll]);

  // One timer per toast, cleared if it is dismissed by hand first.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map(t =>
      setTimeout(() => dismiss(t.notification_id), DISMISS_MS)
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]"
      role="status"
      aria-live="polite"
    >
      {toasts.map(t => (
        <div
          key={t.notification_id}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg shadow-black/10 p-3 flex items-start gap-2.5"
        >
          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full shrink-0 ${
            t.notification_type === "task_assigned" ? "bg-indigo-500" : "bg-amber-500"
          }`} />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {(EYEBROW[t.notification_type] ?? (() => "Update on your task"))(t.sender_name)}
            </p>
            <p className="text-xs font-medium text-gray-900 dark:text-white leading-snug mt-0.5 line-clamp-2">
              {t.title.replace(/^(Task assigned|Review requested|Review approved|Changes requested):\s*/, "")}
            </p>
            {t.message && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">{t.message}</p>
            )}
            <Link
              href={t.entity_id ? `/tasks?task=${t.entity_id}` : "/tasks"}
              onClick={() => dismiss(t.notification_id)}
              className="inline-block text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 mt-1.5 transition-colors"
            >
              View
            </Link>
          </div>
          <button
            onClick={() => dismiss(t.notification_id)}
            aria-label="Dismiss"
            className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
