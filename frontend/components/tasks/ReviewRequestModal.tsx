"use client";

import { useState } from "react";

/**
 * Ask someone to review a task.
 *
 * The note is required, not optional. "Check my numbers", "does this read
 * right" and "is this the correct process" want completely different attention,
 * and a reviewer who has to infer which will infer wrong. Making it mandatory
 * is the whole difference between this and dragging a card to a column.
 */

interface User {
  user_id: string;
  name: string;
  email: string;
}

export default function ReviewRequestModal({
  taskTitle,
  users,
  currentUserId,
  onSubmit,
  onClose,
}: {
  taskTitle: string;
  users: User[];
  currentUserId: string;
  onSubmit: (reviewerId: string, note: string) => Promise<void>;
  onClose: () => void;
}) {
  // Reviewing your own work is not a review; the API rejects it too.
  const candidates = users.filter(u => u.user_id !== currentUserId);
  const [reviewerId, setReviewerId] = useState(candidates[0]?.user_id ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reviewerId || !note.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(reviewerId, note.trim());
    } catch {
      setError("Could not send that. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">Request review</p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{taskTitle}</p>
        </div>

        <div className="p-4 space-y-3">
          {candidates.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              There is nobody else on the team to review this.
            </p>
          ) : (
            <>
              <div>
                <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Who should review it?
                </label>
                <select
                  value={reviewerId}
                  onChange={e => setReviewerId(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                >
                  {candidates.map(u => (
                    <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  What kind of review or help do you need?
                </label>
                <textarea
                  autoFocus
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  rows={3}
                  placeholder="e.g. Check the burn figures against the model — the headcount line looks off to me."
                  className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-gray-900 dark:text-gray-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none"
                />
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-1">
                  Required — it is what tells the reviewer what to actually look at.
                </p>
              </div>
            </>
          )}

          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
          <button
            onClick={onClose}
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 px-2 py-1 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!reviewerId || !note.trim() || saving}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {saving ? "Sending…" : "Request review"}
          </button>
        </div>
      </div>
    </div>
  );
}
