"use client";

/**
 * The approved wording, condensed enough to sit alongside the asset library.
 *
 * This is the copy-and-paste view: find the right description, copy it, use it.
 * Editing is inline. Google Doc sync, category management and per-entry history
 * stay on the full editor, which this links to.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Entry {
  id: string;
  term: string;
  content: string;
  category: string;
  notes: string;
  sort_order: number;
  updated_at: string | null;
}

export default function KeyLanguagePanel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied]   = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft]     = useState("");
  const [saving, setSaving]   = useState(false);
  const [open, setOpen]       = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/proxy/marketing/key-language");
      if (r.ok) {
        // The endpoint returns {entries, doc, slots}, not a bare list.
        const d = await r.json();
        setEntries(Array.isArray(d?.entries) ? d.entries : []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Everything starts expanded — the point of the panel is to see the wording
  // without clicking, and there are only a handful of categories.
  useEffect(() => {
    if (!Array.isArray(entries)) return;
    setOpen(new Set(entries.map(e => e.category || "Uncategorised")));
  }, [entries]);

  async function save(id: string) {
    setSaving(true);
    const r = await fetch(`/api/proxy/marketing/key-language/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft }),
    });
    if (r.ok) { setEditing(null); await load(); }
    setSaving(false);
  }

  function copy(e: Entry) {
    navigator.clipboard.writeText(e.content).then(() => {
      setCopied(e.id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const byCategory = (Array.isArray(entries) ? entries : []).reduce<Record<string, Entry[]>>((acc, e) => {
    const k = e.category || "Uncategorised";
    (acc[k] ??= []).push(e);
    return acc;
  }, {});
  Object.values(byCategory).forEach(list =>
    list.sort((a, b) => a.sort_order - b.sort_order || a.term.localeCompare(b.term))
  );

  const toggle = (cat: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Key language
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            The approved wording. Click any line to copy it.
          </p>
        </div>
        <Link
          href="/marketing/key-language"
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0"
        >
          Full editor ↗
        </Link>
      </div>

      {loading ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
          <p className="text-sm text-gray-400">No wording saved yet.</p>
          <Link href="/marketing/key-language" className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block">
            Add some in the full editor
          </Link>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
          {Object.entries(byCategory).map(([category, list]) => {
            const expanded = open.has(category);
            return (
              <div key={category}>
                <button
                  onClick={() => toggle(category)}
                  className="w-full flex items-center gap-1.5 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                >
                  <svg
                    className={`w-3 h-3 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
                    fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{category}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums">{list.length}</span>
                </button>

                {expanded && (
                  <div className="divide-y divide-gray-50 dark:divide-gray-800/60">
                    {list.map(e => (
                      <div key={e.id} className="px-4 py-2.5 pl-9 group">
                        <div className="flex items-start gap-3">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400 w-16 shrink-0 pt-0.5">
                            {e.term}
                          </span>

                          {editing === e.id ? (
                            <div className="flex-1 min-w-0">
                              <textarea
                                value={draft}
                                onChange={ev => setDraft(ev.target.value)}
                                rows={3}
                                autoFocus
                                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                              />
                              <div className="flex gap-2 mt-1.5">
                                <button
                                  onClick={() => save(e.id)}
                                  disabled={saving}
                                  className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
                                >
                                  {saving ? "Saving…" : "Save"}
                                </button>
                                <button onClick={() => setEditing(null)} className="text-xs text-gray-400 hover:text-gray-600">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => copy(e)}
                                title="Copy"
                                className="flex-1 min-w-0 text-left text-sm text-gray-700 dark:text-gray-300 leading-relaxed hover:text-gray-900 dark:hover:text-gray-100"
                              >
                                {e.content || <span className="italic text-gray-300 dark:text-gray-600">Empty</span>}
                              </button>
                              <div className="flex items-center gap-2 shrink-0 pt-0.5">
                                <span className={`text-[10px] ${copied === e.id ? "text-green-600 dark:text-green-400" : "text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100"} transition-opacity`}>
                                  {copied === e.id ? "Copied" : "Click to copy"}
                                </span>
                                <button
                                  onClick={() => { setEditing(e.id); setDraft(e.content); }}
                                  className="text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                  Edit
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
