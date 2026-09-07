"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ──────────────────────────────────────────────────────────────────

interface Slot { category: string; terms: string[] }

interface Entry {
  id: string;
  term: string;
  content: string;
  category: string;
  notes: string;
}

interface HistoryRecord {
  id: string;
  content: string;
  saved_at: string;
}

interface DocInfo {
  key_language_doc_id: string | null;
  key_language_doc_url: string | null;
  key_language_synced_at: string | null;
}

// ── API ────────────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`/api/proxy${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    const detail = err.detail;
    // A refused sync answers with a structured body explaining which side
    // changed. Flattening it to a string would throw away the reason and the
    // diff, leaving only "Sync failed".
    if (detail && typeof detail === "object") {
      const e = new Error(detail.message ?? "Request failed") as SyncError;
      e.code = detail.code;
      e.status = detail.status;
      e.diff = detail.diff;
      throw e;
    }
    throw new Error(typeof detail === "string" ? detail : r.statusText);
  }
  return r.json();
}

/** An error carrying the server's explanation of a refused sync. */
interface SyncError extends Error {
  code?: string;
  status?: string;
  diff?: { only_in_doc: string[]; only_in_library: string[]; different: string[] };
}

interface SyncState {
  status: "no_doc" | "in_sync" | "doc_ahead" | "library_ahead" | "conflict" | "unknown" | "unavailable";
  needs_pull?: boolean;
  doc_entries?: number;
  library_entries?: number;
  diff?: { only_in_doc: string[]; only_in_library: string[]; different: string[] };
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── History Modal ──────────────────────────────────────────────────────────

function HistoryModal({ entry, onClose, onRestore }: {
  entry: Entry;
  onClose: () => void;
  onRestore: (entryId: string, historyId: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/marketing/key-language/${entry.id}/history`)
      .then(setHistory).finally(() => setLoading(false));
  }, [entry.id]);

  async function handleRestore(histId: string) {
    setRestoring(histId);
    try { await onRestore(entry.id, histId); onClose(); }
    finally { setRestoring(null); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Version History</h2>
            <p className="text-xs text-gray-400 mt-0.5">{entry.category} · {entry.term}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide block mb-2">Current</span>
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">{entry.content || <span className="text-gray-400 italic">Empty</span>}</p>
          </div>
          {loading && <p className="text-sm text-gray-400 text-center py-4">Loading…</p>}
          {!loading && history.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No previous versions.</p>}
          {history.map(h => (
            <div key={h.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">{fmtDate(h.saved_at)}</span>
                <button onClick={() => handleRestore(h.id)} disabled={restoring === h.id}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
                  {restoring === h.id ? "Restoring…" : "Restore"}
                </button>
              </div>
              <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">{h.content || <span className="text-gray-400 italic">Empty</span>}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Doc Link Modal ─────────────────────────────────────────────────────────

function DocLinkModal({ onClose, onLink }: { onClose: () => void; onLink: (url: string) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true); setError(null);
    try { await onLink(url.trim()); onClose(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Link Google Doc</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Paste a Google Doc URL. Changes sync automatically.</p>
          <input ref={ref} type="text" value={url} onChange={e => setUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/…"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={loading || !url.trim()} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60">
              {loading ? "Linking…" : "Link Doc"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Inline editable text (display → edit on click) ─────────────────────────

function InlineField({ value, placeholder, onSave, onViewHistory }: {
  value: string;
  placeholder: string;
  onSave: (v: string) => Promise<void>;
  onViewHistory?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  function startEdit() { setDraft(value); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }

  async function commit() {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); setEditing(false); }
  }

  function keyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setDraft(value); setEditing(false); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <AutoTextarea ref={ref} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={keyDown}
          rows={4} placeholder={placeholder}
          className="w-full resize-none rounded-lg border border-blue-400 dark:border-blue-500 bg-white dark:bg-gray-800 px-3 py-2.5 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        <div className="flex items-center gap-2">
          <button onClick={commit} disabled={saving}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => { setDraft(value); setEditing(false); }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Cancel
          </button>
          <span className="text-[11px] text-gray-400 ml-auto">⌘↵ to save · Esc to cancel</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2">
      <div onClick={startEdit}
        className={`flex-1 min-h-[2.5rem] rounded-lg px-3 py-2.5 cursor-text transition-colors ${
          value ? "hover:bg-gray-50 dark:hover:bg-gray-800/60" : "border border-dashed border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
        }`}>
        {value
          ? <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">{value}</p>
          : <p className="text-sm text-gray-400 dark:text-gray-500 italic">{placeholder}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0 pt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={startEdit} title="Edit"
          className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
        {onViewHistory && value && (
          <button onClick={onViewHistory} title="History"
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Inline editable category title ─────────────────────────────────────────

function EditableTitle({ value, onRename }: { value: string; onRename: (newName: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) { setEditing(false); setDraft(value); return; }
    setSaving(true);
    try { await onRename(trimmed); } finally { setSaving(false); setEditing(false); }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
          className="text-xs font-bold uppercase tracking-widest bg-transparent border-b border-blue-400 text-gray-700 dark:text-gray-300 focus:outline-none w-full" />
        <button onClick={commit} disabled={saving}
          className="text-xs text-blue-600 dark:text-blue-400 font-medium shrink-0 hover:underline disabled:opacity-50">
          {saving ? "…" : "Save"}
        </button>
        <button onClick={() => { setDraft(value); setEditing(false); }}
          className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Cancel</button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest">{value}</span>
      <button onClick={() => { setDraft(value); setEditing(true); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      </button>
    </div>
  );
}

// ── Tagline card (multiple entries) ────────────────────────────────────────

function TaglineCard({ entries, category, onSave, onViewHistory, onDelete, onRename }: {
  entries: Entry[];
  category: string;
  onSave: (category: string, term: string, content: string, existingId?: string) => Promise<void>;
  onViewHistory: (entry: Entry) => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (oldName: string, newName: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    const term = newLabel.trim() || `Tagline ${entries.length + 1}`;
    setSaving(true);
    try {
      await onSave(category, term, newContent.trim());
      setNewLabel(""); setNewContent(""); setAdding(false);
    } finally { setSaving(false); }
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <EditableTitle value={category} onRename={newName => onRename(category, newName)} />
        <button onClick={() => setAdding(true)}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add
        </button>
      </div>
      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {entries.length === 0 && !adding && (
          <div className="px-5 py-4">
            <InlineField value="" placeholder="Enter your tagline…"
              onSave={content => onSave(category, "Tagline 1", content)} />
          </div>
        )}
        {entries.map((entry, i) => (
          <div key={entry.id} className="group px-5 py-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{entry.term}</span>
              <button onClick={() => onDelete(entry.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity ml-auto text-gray-300 hover:text-red-500 dark:hover:text-red-400">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
            <InlineField value={entry.content} placeholder={`Enter tagline ${i + 1}…`}
              onSave={content => onSave(category, entry.term, content, entry.id)}
              onViewHistory={() => onViewHistory(entry)} />
          </div>
        ))}
        {adding && (
          <div className="px-5 py-4 space-y-3 bg-gray-50 dark:bg-gray-800/40">
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label (e.g. Primary, Short)"
              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400" />
            <AutoTextarea value={newContent} onChange={e => setNewContent(e.target.value)} rows={3}
              placeholder="Enter tagline text…"
              className="w-full resize-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
                {saving ? "Saving…" : "Add"}
              </button>
              <button onClick={() => { setAdding(false); setNewLabel(""); setNewContent(""); }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Description card (Sentence / Short / Long tabs) ────────────────────────

function DescriptionCard({ category, terms, entryMap, onSave, onViewHistory, onRename }: {
  category: string;
  terms: string[];
  entryMap: Record<string, Entry>;
  onSave: (category: string, term: string, content: string) => Promise<void>;
  onViewHistory: (entry: Entry) => void;
  onRename: (oldName: string, newName: string) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState(terms[0]);

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800">
        <EditableTitle value={category} onRename={newName => onRename(category, newName)} />
      </div>
      <div className="flex border-b border-gray-100 dark:border-gray-800 px-5">
        {terms.map(term => (
          <button key={term} onClick={() => setActiveTab(term)}
            className={`py-2 px-3 text-xs font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === term
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
            }`}>
            {term.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="p-5">
        <InlineField
          key={`${category}-${activeTab}`}
          value={entryMap[activeTab]?.content ?? ""}
          placeholder={`Enter your ${activeTab.toLowerCase()} ${category.toLowerCase()}…`}
          onSave={content => onSave(category, activeTab, content)}
          onViewHistory={entryMap[activeTab] ? () => onViewHistory(entryMap[activeTab]) : undefined}
        />
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function KeyLanguagePage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [doc, setDoc] = useState<DocInfo>({ key_language_doc_id: null, key_language_doc_url: null, key_language_synced_at: null });
  const [loading, setLoading] = useState(true);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [historyEntry, setHistoryEntry] = useState<Entry | null>(null);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "ok" | "err">("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [blocked, setBlocked] = useState<SyncError | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const data = await apiFetch("/marketing/key-language");
    setEntries(data.entries ?? []);
    setSlots(data.slots ?? []);
    setDoc(data.doc ?? {});
    setLoading(false);
    return data.doc as DocInfo | null;
  }, []);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await apiFetch("/marketing/key-language/doc/check"));
    } catch {
      setSync({ status: "unavailable" });
    }
  }, []);

  // Report the state rather than acting on it. This used to pull automatically
  // whenever the doc looked newer, which meant opening the page could replace
  // the library with whatever the document happened to contain.
  useEffect(() => {
    load().then((loadedDoc) => {
      if (loadedDoc?.key_language_doc_id) refreshSync();
    });
  }, [load, refreshSync]);

  // Build lookup: category → term → entry
  const lookup: Record<string, Record<string, Entry>> = {};
  const taglineEntries: Entry[] = [];
  for (const e of entries) {
    if (!lookup[e.category]) lookup[e.category] = {};
    lookup[e.category][e.term] = e;
  }
  // All entries in the Tagline category
  const taglineSlot = slots.find(s => s.terms.length === 1);
  if (taglineSlot) {
    for (const e of entries) {
      if (e.category === taglineSlot.category) taglineEntries.push(e);
    }
  }

  async function scheduleDocPush() {
    if (!doc.key_language_doc_id) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(async () => {
      setSyncStatus("syncing");
      setSyncError(null);
      try {
        await apiFetch("/marketing/key-language/doc/push", { method: "POST" });
        await refreshSync();
        setSyncStatus("ok");
        setTimeout(() => setSyncStatus("idle"), 3000);
      } catch (e: unknown) {
        const err = e as SyncError;
        if (err?.code) {
          // The doc has edits of its own. Stop auto-pushing and say so; a
          // transient "Sync failed" would leave the edit quietly unsaved.
          setBlocked(err);
          await refreshSync();
          setSyncStatus("idle");
        } else {
          setSyncError(err?.message ?? "Sync failed");
          setSyncStatus("err");
          setTimeout(() => { setSyncStatus("idle"); setSyncError(null); }, 6000);
        }
      }
    }, 1500);
  }

  /** Run a sync in one direction, surfacing a refusal instead of burying it. */
  async function runSync(dir: "push" | "pull", force = false) {
    if (!doc.key_language_doc_id) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    const setBusy = dir === "push" ? setPushing : setPulling;
    setBusy(true);
    setSyncError(null);
    setBlocked(null);
    try {
      await apiFetch(
        `/marketing/key-language/doc/${dir}${force ? "?force=true" : ""}`,
        { method: "POST" }
      );
      await load();
      await refreshSync();
      setSyncStatus("ok");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch (e: unknown) {
      const err = e as SyncError;
      if (err?.code) {
        // The server refused because the other side has unsynced changes.
        // Keep it on screen with the diff until it is acted on.
        setBlocked(err);
        await refreshSync();
      } else {
        setSyncError(err?.message ?? `${dir} failed`);
        setSyncStatus("err");
        setTimeout(() => { setSyncStatus("idle"); setSyncError(null); }, 6000);
      }
    } finally {
      setBusy(false);
    }
  }

  const handleManualPush = () => runSync("push");

  async function handleManualPull() {
    if (!confirm("Pull from Google Doc? This replaces every entry with the document's content.")) return;
    runSync("pull");
  }

  async function handleSave(category: string, term: string, content: string, existingId?: string) {
    const id = existingId ?? lookup[category]?.[term]?.id;
    if (id) {
      await apiFetch(`/marketing/key-language/${id}`, { method: "PATCH", body: JSON.stringify({ content }) });
    } else {
      await apiFetch("/marketing/key-language", { method: "POST", body: JSON.stringify({ category, term, content }) });
    }
    await load();
    scheduleDocPush();
  }

  async function handleDelete(id: string) {
    await apiFetch(`/marketing/key-language/${id}`, { method: "DELETE" });
    await load();
    scheduleDocPush();
  }

  async function handleRestore(entryId: string, historyId: string) {
    await apiFetch(`/marketing/key-language/${entryId}/restore`, {
      method: "POST", body: JSON.stringify({ history_id: historyId }),
    });
    await load();
    scheduleDocPush();
  }

  async function handleRename(oldName: string, newName: string) {
    const res = await apiFetch("/marketing/key-language/category/rename", {
      method: "POST", body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
    setSlots(res.slots ?? slots);
    await load();
    scheduleDocPush();
  }

  async function handleLinkDoc(url: string) {
    await apiFetch("/marketing/key-language/doc/link", { method: "POST", body: JSON.stringify({ doc_url: url }) });
    await load();
  }

  async function handleUnlinkDoc() {
    await apiFetch("/marketing/key-language/doc/unlink", { method: "DELETE" });
    setDoc({ key_language_doc_id: null, key_language_doc_url: null, key_language_synced_at: null });
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
      {/* Google Doc panel */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-4 bg-gray-50 dark:bg-gray-800/40 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <svg className="w-4 h-4 text-blue-500 shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z" />
          </svg>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Google Doc</span>
        </div>
        {doc.key_language_doc_id ? (
          <div className="flex flex-col gap-2 flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <a href={doc.key_language_doc_url ?? "#"} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-xs flex-1">
                {doc.key_language_doc_url}
              </a>
              <div className="flex items-center gap-2 shrink-0">
                {syncStatus === "syncing" && <span className="text-xs text-gray-400">Syncing…</span>}
                {syncStatus === "ok"      && <span className="text-xs text-green-500">✓ Synced</span>}
                {syncStatus === "err"     && <span className="text-xs text-red-500">Sync failed</span>}
                {sync && <SyncPill state={sync} />}
                <button
                  onClick={handleManualPush}
                  disabled={pushing || pulling}
                  title="Push all entries to Google Doc"
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 transition-colors font-medium">
                  {pushing ? "Pushing…" : "↑ Push"}
                </button>
                <button
                  onClick={handleManualPull}
                  disabled={pushing || pulling}
                  title="Pull entries from Google Doc into the app"
                  className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 transition-colors font-medium">
                  {pulling ? "Pulling…" : "↓ Pull"}
                </button>
                <button onClick={handleUnlinkDoc} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Unlink</button>
              </div>
            </div>
            {blocked && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2.5">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  {blocked.code === "library_has_changes" ? "The library has unsynced edits"
                    : blocked.code === "pull_would_lose_entries" ? "That pull would delete entries"
                    : "The Google Doc has unsynced edits"}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5 leading-relaxed">
                  {blocked.message}
                </p>
                <DiffSummary diff={blocked.diff} />
                <div className="flex items-center gap-3 mt-2">
                  {blocked.code === "doc_has_changes" ? (
                    <>
                      <button
                        onClick={() => runSync("pull")}
                        disabled={pulling || pushing}
                        className="text-xs px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 font-medium"
                      >
                        Take the doc&apos;s version
                      </button>
                      <button
                        onClick={() => { if (confirm("Overwrite the Google Doc with the library? The doc's edits will be lost.")) runSync("push", true); }}
                        disabled={pulling || pushing}
                        className="text-xs text-amber-700 dark:text-amber-400 hover:underline disabled:opacity-40"
                      >
                        Overwrite the doc anyway
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => runSync("push")}
                        disabled={pulling || pushing}
                        className="text-xs px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 font-medium"
                      >
                        Keep the library, update the doc
                      </button>
                      <button
                        onClick={() => { if (confirm("Replace the library with the document? Unsynced entries will be lost.")) runSync("pull", true); }}
                        disabled={pulling || pushing}
                        className="text-xs text-amber-700 dark:text-amber-400 hover:underline disabled:opacity-40"
                      >
                        Replace the library anyway
                      </button>
                    </>
                  )}
                  <button onClick={() => setBlocked(null)} className="text-xs text-gray-400 hover:text-gray-600 ml-auto">
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {!blocked && sync && (sync.status === "doc_ahead" || sync.status === "conflict") && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2">
                <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                  {sync.status === "conflict"
                    ? "Both the doc and the library have changed since the last sync. Syncing either way loses something — check the differences before choosing."
                    : "The Google Doc has been edited since the last sync. Nothing is pulled automatically."}
                </p>
                <DiffSummary diff={sync.diff} />
                {sync.status === "doc_ahead" && (
                  <button
                    onClick={() => runSync("pull")}
                    disabled={pulling || pushing}
                    className="text-xs px-2.5 py-1 mt-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40 font-medium"
                  >
                    {pulling ? "Pulling…" : "Bring those changes in"}
                  </button>
                )}
              </div>
            )}

            {syncError && (
              <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">{syncError}</p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-1">
            <span className="text-sm text-gray-400 dark:text-gray-500 flex-1">Not linked — changes won't sync to Google Docs.</span>
            <button onClick={() => setShowLinkModal(true)}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
              Link Doc
            </button>
          </div>
        )}
      </div>

      {/* Cards */}
      {slots.map(({ category, terms }) => {
        const isTagline = terms.length === 1;
        if (isTagline) {
          return (
            <TaglineCard
              key={category}
              category={category}
              entries={taglineEntries.filter(e => e.category === category)}
              onSave={handleSave}
              onViewHistory={setHistoryEntry}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          );
        }
        return (
          <DescriptionCard
            key={category}
            category={category}
            terms={terms}
            entryMap={lookup[category] ?? {}}
            onSave={handleSave}
            onViewHistory={setHistoryEntry}
            onRename={handleRename}
          />
        );
      })}

      {historyEntry && (
        <HistoryModal entry={historyEntry} onClose={() => setHistoryEntry(null)} onRestore={handleRestore} />
      )}
      {showLinkModal && (
        <DocLinkModal onClose={() => setShowLinkModal(false)} onLink={handleLinkDoc} />
      )}
    </div>
  );
}


// ── Sync status ────────────────────────────────────────────────────────────

const SYNC_PILL: Record<string, { label: string; className: string }> = {
  in_sync:       { label: "● In sync",        className: "text-green-600 dark:text-green-400" },
  doc_ahead:     { label: "● Doc ahead",      className: "text-amber-600 dark:text-amber-400" },
  library_ahead: { label: "● Library ahead",  className: "text-blue-600 dark:text-blue-400" },
  conflict:      { label: "● Conflict",       className: "text-red-600 dark:text-red-400" },
  unknown:       { label: "● Not compared",   className: "text-gray-400" },
  unavailable:   { label: "● Unavailable",    className: "text-gray-400" },
};

function SyncPill({ state }: { state: SyncState }) {
  const pill = SYNC_PILL[state.status];
  if (!pill) return null;
  const counts = state.doc_entries != null && state.library_entries != null
    ? ` · doc ${state.doc_entries} / library ${state.library_entries}`
    : "";
  return (
    <span className={`text-xs font-medium ${pill.className}`} title={`Google Doc sync${counts}`}>
      {pill.label}
    </span>
  );
}

/** What actually differs, so a choice is made on evidence rather than a guess. */
function DiffSummary({ diff }: { diff?: SyncState["diff"] }) {
  if (!diff) return null;
  const rows: [string, string[]][] = [
    ["Only in the doc", diff.only_in_doc],
    ["Only in the library", diff.only_in_library],
    ["Different wording", diff.different],
  ];
  const shown = rows.filter(([, list]) => list.length > 0);
  if (shown.length === 0) {
    return (
      <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1.5">
        No entry-level differences — the change is elsewhere in the document.
      </p>
    );
  }
  return (
    <ul className="mt-1.5 space-y-0.5">
      {shown.map(([label, list]) => (
        <li key={label} className="text-[11px] text-amber-700/90 dark:text-amber-400/90">
          <span className="font-medium">{label}:</span> {list.join(", ")}
        </li>
      ))}
    </ul>
  );
}
