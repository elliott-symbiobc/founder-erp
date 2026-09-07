"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Avatar } from "@/components/Avatar";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Company Picker ─────────────────────────────────────────────────────────

function CompanyPicker({ contactId, currentCompanyId, currentCompanyName, currentOrg, onChanged }: {
  contactId: string;
  currentCompanyId: string | null;
  currentCompanyName: string | null;
  currentOrg: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [companies, setCompanies] = useState<{ company_id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/proxy/contacts/companies").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.companies) setCompanies(d.companies);
    });
  }, [open]);

  const filtered = companies.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase())
  );
  const noMatch = search.trim() && !companies.some(c => c.name.toLowerCase() === search.trim().toLowerCase());

  async function selectCompany(companyId: string, companyName: string) {
    setSaving(true);
    await fetch(`/api/proxy/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, organization: companyName }),
    });
    setSaving(false);
    setOpen(false);
    onChanged();
  }

  async function createAndSelect(name: string) {
    setSaving(true);
    const r = await fetch("/api/proxy/contacts/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (r.ok) {
      const d = await r.json();
      await selectCompany(d.company_id, d.name);
    }
    setSaving(false);
  }

  async function unlink() {
    setSaving(true);
    await fetch(`/api/proxy/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: null }),
    });
    setSaving(false);
    setOpen(false);
    onChanged();
  }

  return (
    <div className="relative" ref={ref}>
      {currentCompanyId && currentCompanyName ? (
        <Link href={`/contacts/companies/${currentCompanyId}`}
          className="flex items-center gap-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-3 hover:bg-blue-50 dark:hover:bg-blue-950/30 hover:border-blue-200 dark:hover:border-blue-800 transition-colors group/comp">
          <div className="w-8 h-8 rounded-lg bg-gray-700 dark:bg-gray-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {currentCompanyName.slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Company</p>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate group-hover/comp:text-blue-600 dark:group-hover/comp:text-blue-400 transition-colors">
              {currentCompanyName}
            </p>
          </div>
          <button
            onClick={e => { e.preventDefault(); setOpen(o => !o); setSearch(""); }}
            className="text-zinc-300 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1"
            title="Change company"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        </Link>
      ) : (
        <button
          onClick={() => { setOpen(o => !o); setSearch(""); }}
          disabled={saving}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          {saving ? "Saving…" : "Assign to company"}
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-64 overflow-hidden">
          <div className="p-2 border-b border-zinc-100 dark:border-zinc-800">
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
              placeholder="Search companies…"
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.map(c => (
              <button key={c.company_id} onClick={() => selectCompany(c.company_id, c.name)}
                className={`w-full text-left flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                  c.company_id === currentCompanyId
                    ? "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 font-medium"
                    : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                }`}>
                <div className="w-5 h-5 rounded-md bg-gray-700 dark:bg-gray-600 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">
                  {c.name.slice(0, 2).toUpperCase()}
                </div>
                {c.name}
              </button>
            ))}
            {noMatch && (
              <button onClick={() => createAndSelect(search)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create "{search.trim()}"
              </button>
            )}
            {filtered.length === 0 && !noMatch && (
              <p className="px-3 py-2 text-xs text-zinc-400 italic">No companies yet</p>
            )}
          </div>
          {currentCompanyId && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 p-1">
              <button onClick={unlink}
                className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors">
                Unlink from company
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

interface Interaction {
  interaction_id: string;
  interaction_type: string;
  subject: string | null;
  content_preview: string | null;
  occurred_at: string;
  direction: string | null;
  metadata: Record<string, unknown>;
}

interface Reminder {
  reminder_id: string;
  reminder_type: string;
  title: string;
  description: string | null;
  due_date: string | null;
  auto_generated: boolean;
}

interface Relationship {
  rel_id: string;
  other_contact_id: string;
  other_contact_name: string;
  other_contact_org: string | null;
  other_contact_title: string | null;
  relationship_type: string;
  strength: number;
  description: string | null;
  direction: string;
}

interface LinkedProject {
  project_id: string;
  name: string;
  project_type: string;
  stage: string;
  status: string;
  role: string;
}

interface Contact {
  contact_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  organization: string | null;
  title: string | null;
  tagline: string | null;
  tags: string[];
  subject_areas: string[];
  notes: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  avatar_url: string | null;
  ai_summary: string | null;
  ai_summary_updated_at: string | null;
  enrichment_data: Record<string, unknown>;
  last_interaction_at: string | null;
  last_enriched_at: string | null;
  archived: boolean;
  company_id: string | null;
  company_name: string | null;
  interactions: Interaction[];
  reminders: Reminder[];
  relationships: Relationship[];
  linked_projects: LinkedProject[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtYear(iso: string): string {
  return new Date(iso).getFullYear().toString();
}

// ── Interaction helpers ────────────────────────────────────────────────────

const INTERACTION_CONFIG: Record<string, { bg: string; icon: JSX.Element; label: string }> = {
  meeting: {
    bg: "bg-purple-500",
    label: "Meeting",
    icon: (
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  call: {
    bg: "bg-green-500",
    label: "Call",
    icon: (
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
      </svg>
    ),
  },
  note: {
    bg: "bg-zinc-400",
    label: "Note",
    icon: (
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  email_received: {
    bg: "bg-blue-500",
    label: "Email received",
    icon: (
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  email_sent: {
    bg: "bg-sky-500",
    label: "Email sent",
    icon: (
      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
};

function getInteractionConfig(type: string, direction: string | null) {
  if (type === "email_received" || (type.startsWith("email") && direction === "inbound")) return INTERACTION_CONFIG.email_received;
  return INTERACTION_CONFIG[type] ?? INTERACTION_CONFIG.note;
}

function RemindTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    unanswered_email: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    unfinished_deal: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
    follow_up: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    custom: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  };
  const label = type.replace(/_/g, " ");
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[type] ?? styles.custom}`}>{label}</span>;
}

// ── Editable Field ────────────────────────────────────────────────────────────

function EditableField({ label, value, onSave, multiline = false }: {
  label: string; value: string | null; onSave: (v: string) => Promise<void>; multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div>
        <label className="block text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">{label}</label>
        {multiline ? (
          <AutoTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Escape") { setEditing(false); setDraft(value ?? ""); } }}
            className="w-full rounded-lg border border-blue-400 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        ) : (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setEditing(false); setDraft(value ?? ""); }
            }}
            className="w-full rounded-lg border border-blue-400 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
          />
        )}
        <div className="flex gap-2 mt-1.5">
          <button onClick={save} disabled={saving} className="text-xs text-blue-600 hover:text-blue-800 font-medium">{saving ? "…" : "Save"}</button>
          <button onClick={() => { setEditing(false); setDraft(value ?? ""); }} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group cursor-pointer" onClick={() => { setDraft(value ?? ""); setEditing(true); }}>
      <label className="block text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-0.5 cursor-pointer">{label}</label>
      <p className={`text-sm rounded px-1 -mx-1 py-0.5 transition-colors break-words [overflow-wrap:anywhere] group-hover:bg-zinc-50 dark:group-hover:bg-zinc-800 ${value ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-300 dark:text-zinc-600 italic"}`}>
        {value || "—"}
        <span className="ml-1 opacity-0 group-hover:opacity-40 text-[10px]">✎</span>
      </p>
    </div>
  );
}

// ── Inline Tag Editor ────────────────────────────────────────────────────────

function InlineTagEditor({ tags, onSave }: { tags: string[]; onSave: (tags: string[]) => Promise<void> }) {
  const [current, setCurrent] = useState<string[]>(tags);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [allTags, setAllTags] = useState<{ name: string; color: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetch("/api/proxy/contacts/tags").then(r => r.ok ? r.json() : null).then(d => {
        if (d?.tags) setAllTags(d.tags);
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const suggestions = allTags.filter(t =>
    !current.includes(t.name) &&
    (input === "" || t.name.toLowerCase().includes(input.toLowerCase()))
  ).slice(0, 8);

  async function addTag(name: string) {
    const clean = name.trim().toLowerCase();
    if (!clean || current.includes(clean)) return;
    const next = [...current, clean];
    setCurrent(next);
    setInput("");
    await onSave(next);
    inputRef.current?.focus();
  }

  async function removeTag(name: string) {
    const next = current.filter(t => t !== name);
    setCurrent(next);
    await onSave(next);
  }

  return (
    <div>
      <label className="block text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">Tags</label>
      <div className="flex flex-wrap gap-1 relative" ref={popoverRef}>
        {current.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 font-medium">
            {tag}
            <button onClick={() => removeTag(tag)} className="opacity-40 hover:opacity-100 leading-none ml-0.5">×</button>
          </span>
        ))}
        <button
          onClick={() => setOpen(v => !v)}
          className="text-xs px-2 py-0.5 rounded border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-400 dark:text-zinc-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          + tag
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-1 z-20 w-56 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-lg p-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && input.trim()) { addTag(input); e.preventDefault(); }
                if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Search or create…"
              className="w-full text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 mb-1"
            />
            {suggestions.length > 0 && (
              <div className="max-h-32 overflow-y-auto">
                {suggestions.map(t => (
                  <button
                    key={t.name}
                    onClick={() => addTag(t.name)}
                    className="w-full text-left flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} />
                    <span className="text-xs text-zinc-700 dark:text-zinc-300">{t.name}</span>
                  </button>
                ))}
              </div>
            )}
            {input.trim() && !allTags.find(t => t.name === input.trim().toLowerCase()) && (
              <button
                onClick={() => addTag(input)}
                className="w-full text-left px-2 py-1 rounded-lg text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950"
              >
                + Create "{input.trim()}"
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add Interaction Modal ─────────────────────────────────────────────────────

function AddInteractionModal({ contactId, onClose, onAdded }: { contactId: string; onClose: () => void; onAdded: () => void }) {
  const [type, setType] = useState("note");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/proxy/contacts/${contactId}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interaction_type: type, subject: subject || null, full_content: content || null }),
    });
    setSaving(false);
    onAdded();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Log Interaction</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">✕</button>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
              <option value="email_sent">Email Sent</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Subject</label>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Notes / Content</label>
            <AutoTextarea value={content} onChange={(e) => setContent(e.target.value)} rows={4}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Log"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Reminder Modal ────────────────────────────────────────────────────────

function AddReminderModal({ contactId, onClose, onAdded }: { contactId: string; onClose: () => void; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("follow_up");
  const [dueDate, setDueDate] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/proxy/contacts/${contactId}/reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, reminder_type: type, due_date: dueDate || null, description: desc || null }),
    });
    setSaving(false);
    onAdded();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add Reminder</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">✕</button>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Title</label>
            <input required type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="follow_up">Follow-up</option>
              <option value="unfinished_deal">Unfinished Deal</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Due Date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Notes</label>
            <AutoTextarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Email Detail Modal ────────────────────────────────────────────────────────

interface EmailDetail {
  interaction_id: string;
  gmail_id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  snippet: string;
  plain_body: string;
  html_body: string;
  metadata: Record<string, unknown>;
}

function EmailDetailModal({ contactId, interactionId, onClose }: {
  contactId: string; interactionId: string; onClose: () => void;
}) {
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHtml, setShowHtml] = useState(false);

  useEffect(() => {
    fetch(`/api/proxy/contacts/${contactId}/interactions/${interactionId}/email`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.detail || "Failed to load email");
        }
        return r.json();
      })
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [contactId, interactionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            {loading ? (
              <div className="h-4 w-48 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse" />
            ) : detail ? (
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 leading-tight">{detail.subject}</h2>
            ) : null}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 shrink-0 mt-0.5">✕</button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-zinc-400">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2" />
            Loading…
          </div>
        ) : error ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-red-500">{error}</p>
            <p className="text-xs text-zinc-400 mt-1">The email may no longer be available in Gmail.</p>
          </div>
        ) : detail ? (
          <>
            <div className="px-5 py-3 border-b border-zinc-50 dark:border-zinc-800 space-y-1 shrink-0 bg-zinc-50 dark:bg-zinc-950">
              <div className="grid grid-cols-[40px_1fr] gap-x-2 text-xs">
                <span className="text-zinc-400 font-medium pt-0.5">From</span>
                <span className="text-zinc-700 dark:text-zinc-300 break-words">{detail.from}</span>
              </div>
              <div className="grid grid-cols-[40px_1fr] gap-x-2 text-xs">
                <span className="text-zinc-400 font-medium pt-0.5">To</span>
                <span className="text-zinc-700 dark:text-zinc-300 break-words">{detail.to}</span>
              </div>
              {detail.cc && (
                <div className="grid grid-cols-[40px_1fr] gap-x-2 text-xs">
                  <span className="text-zinc-400 font-medium pt-0.5">CC</span>
                  <span className="text-zinc-700 dark:text-zinc-300 break-words">{detail.cc}</span>
                </div>
              )}
              <div className="grid grid-cols-[40px_1fr] gap-x-2 text-xs">
                <span className="text-zinc-400 font-medium pt-0.5">Date</span>
                <span className="text-zinc-500 dark:text-zinc-400">{detail.date}</span>
              </div>
              {(detail.metadata?.is_group_email as boolean) && (
                <div className="mt-1">
                  <span className="inline-block text-xs px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 font-medium">
                    Group email · {detail.metadata.recipient_count as number} recipients
                  </span>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detail.html_body ? (
                <div className="flex gap-2 mb-3">
                  <button onClick={() => setShowHtml(false)}
                    className={`text-xs px-2 py-1 rounded-lg ${!showHtml ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
                    Plain text
                  </button>
                  <button onClick={() => setShowHtml(true)}
                    className={`text-xs px-2 py-1 rounded-lg ${showHtml ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
                    Rich text
                  </button>
                </div>
              ) : null}
              {showHtml && detail.html_body ? (
                <iframe srcDoc={detail.html_body} className="w-full border-0 rounded" style={{ minHeight: "400px" }} sandbox="allow-same-origin" title="Email body" />
              ) : (
                <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                  {detail.plain_body || detail.snippet || "(No body content available)"}
                </pre>
              )}
            </div>

            <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0 flex justify-end">
              <a href={`https://mail.google.com/mail/u/0/#inbox/${detail.gmail_id}`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:text-blue-800 font-medium">
                Open in Gmail →
              </a>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Send Email Modal ──────────────────────────────────────────────────────────

function SendEmailModal({ contactId, contactEmail, contactName, onClose, onSent }: {
  contactId: string; contactEmail: string; contactName: string;
  onClose: () => void; onSent: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/proxy/contacts/${contactId}/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body,
          cc: cc ? cc.split(",").map((v) => v.trim()).filter(Boolean) : [],
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || "Failed to send");
      }
      onSent();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Send Email</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">✕</button>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3 flex-1 overflow-y-auto">
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">To</label>
            <input type="text" readOnly value={`${contactName} <${contactEmail}>`}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-600 dark:text-zinc-400 focus:outline-none" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">CC <span className="text-zinc-300 dark:text-zinc-600">(comma-separated)</span></label>
            <input type="text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Subject</label>
            <input required type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Body</label>
            <AutoTextarea required value={body} onChange={(e) => setBody(e.target.value)} rows={8}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">Cancel</button>
            <button type="submit" disabled={sending}
              className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Create Calendar Event Modal ────────────────────────────────────────────────

function CreateEventModal({ contactId, contactName, onClose, onCreated }: {
  contactId: string; contactName: string;
  onClose: () => void; onCreated: () => void;
}) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;

  const [title, setTitle] = useState(`Meeting with ${contactName}`);
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(dateStr);
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("11:00");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [extraAttendees, setExtraAttendees] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventLink, setEventLink] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/proxy/contacts/${contactId}/calendar-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || null,
          start_datetime: `${date}T${startTime}:00`,
          end_datetime: `${date}T${endTime}:00`,
          timezone: tz,
          attendee_emails: extraAttendees ? extraAttendees.split(",").map((v) => v.trim()).filter(Boolean) : [],
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || "Failed to create event");
      setEventLink(d.event_link || null);
      onCreated();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  if (eventLink) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-sm p-6 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-green-600 dark:text-green-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Event created!</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">An invite has been sent to {contactName}.</p>
          <div className="flex gap-2 justify-center">
            <a href={eventLink} target="_blank" rel="noopener noreferrer"
              className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700">
              Open in Google Calendar
            </a>
            <button onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Schedule Meeting</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">✕</button>
        </div>
        <form onSubmit={submit} className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Event Title</label>
            <input required type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Date</label>
            <input required type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Start</label>
              <input required type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">End</label>
              <input required type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Time Zone</label>
            <input type="text" value={tz} onChange={(e) => setTz(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">
              Additional Attendees <span className="text-zinc-300 dark:text-zinc-600">(comma-separated emails)</span>
            </label>
            <input type="text" value={extraAttendees} onChange={(e) => setExtraAttendees(e.target.value)} placeholder="optional"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400 block mb-1">Description / Agenda</label>
            <AutoTextarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm px-3 py-1.5 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {saving ? "Creating…" : "Create Event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ contact, onUpdated, onSummarize, summarizing }: {
  contact: Contact;
  onUpdated: () => void;
  onSummarize: () => void;
  summarizing: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(contact.ai_summary || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/proxy/contacts/${contact.contact_id}/summary`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai_summary: draft }),
    });
    setSaving(false);
    setEditing(false);
    onUpdated();
  }

  function renderSummary(text: string) {
    return text.split("\n").map((line, i) => {
      if (!line.trim()) return null;
      const heading = line.match(/^#{1,3}\s+(.+)/);
      if (heading) {
        return <p key={i} className="font-semibold text-zinc-900 dark:text-zinc-100 text-xs uppercase tracking-wide mt-3">{heading[1]}</p>;
      }
      const parts = line.split(/\*\*([^*]+)\*\*/g);
      return (
        <p key={i}>
          {parts.map((part, j) => j % 2 === 1 ? <strong key={j}>{part}</strong> : part)}
        </p>
      );
    });
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">AI Summary</p>
        <div className="flex items-center gap-2">
          {contact.ai_summary_updated_at && !editing && (
            <p className="text-xs text-zinc-300 dark:text-zinc-600">Updated {fmtDate(contact.ai_summary_updated_at)}</p>
          )}
          {!editing && (
            <button onClick={() => { setDraft(contact.ai_summary || ""); setEditing(true); }}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 px-1.5 py-0.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Edit
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <AutoTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full text-sm text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 leading-relaxed resize-y min-h-[120px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
          <div className="flex items-center gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="text-xs text-zinc-400 hover:text-zinc-600 px-2 py-1">Cancel</button>
            <button onClick={save} disabled={saving} className="text-xs px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : contact.ai_summary ? (
        <div className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed space-y-1.5">
          {renderSummary(contact.ai_summary)}
        </div>
      ) : (
        <div className="text-center py-4 text-zinc-400 dark:text-zinc-500">
          <p className="text-xs">No summary yet.</p>
          <button onClick={onSummarize} disabled={summarizing} className="mt-1 text-xs text-blue-600 hover:underline disabled:opacity-50">
            {summarizing ? "Generating…" : "Generate now"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Interaction Timeline ──────────────────────────────────────────────────────

function InteractionTimeline({ interactions, onAddClick, onEmailClick }: {
  interactions: Interaction[];
  onAddClick: () => void;
  onEmailClick: (id: string) => void;
}) {
  let lastYear = "";

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4">
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Activity
          {interactions.length > 0 && <span className="ml-1.5 font-normal text-zinc-400">({interactions.length})</span>}
        </p>
        <button
          onClick={onAddClick}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 font-medium transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Log
        </button>
      </div>

      {interactions.length === 0 ? (
        <div className="text-center py-10 text-zinc-400 dark:text-zinc-500">
          <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mx-auto mb-3">
            <svg className="w-5 h-5 text-zinc-300 dark:text-zinc-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </div>
          <p className="text-xs">No interactions yet</p>
          <p className="text-xs mt-0.5 text-zinc-300 dark:text-zinc-600">Sync Gmail or log manually</p>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-[13px] top-2 bottom-2 w-px bg-zinc-100 dark:bg-zinc-800" />

          <div className="space-y-1">
            {interactions.map((ix, idx) => {
              const isEmail = ix.interaction_type === "email_sent" || ix.interaction_type === "email_received";
              const isGroup = isEmail && (ix.metadata as any)?.is_group_email === true;
              const recipientCount = isGroup ? (ix.metadata as any)?.recipient_count : null;
              const config = getInteractionConfig(ix.interaction_type, ix.direction);
              const year = fmtYear(ix.occurred_at);
              const showYear = year !== lastYear;
              lastYear = year;

              return (
                <div key={ix.interaction_id}>
                  {showYear && idx > 0 && (
                    <div className="flex items-center gap-3 py-2 pl-8">
                      <span className="text-[11px] font-semibold text-zinc-300 dark:text-zinc-600 uppercase tracking-widest">{year}</span>
                    </div>
                  )}
                  <div
                    onClick={isEmail ? () => onEmailClick(ix.interaction_id) : undefined}
                    className={`relative flex gap-3 rounded-xl p-2.5 transition-colors ${isEmail ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60" : ""} ${isGroup ? "opacity-60" : ""}`}
                  >
                    {/* Icon dot */}
                    <div className={`relative z-10 w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${config.bg} shadow-sm`}>
                      {config.icon}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 leading-snug">
                          {ix.subject || config.label}
                        </p>
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">{fmtDateTime(ix.occurred_at)}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {isGroup && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                            Group · {recipientCount} recipients
                          </span>
                        )}
                        {ix.content_preview && (
                          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{ix.content_preview}</p>
                        )}
                        {isEmail && !ix.content_preview && (
                          <p className="text-[11px] text-blue-400 dark:text-blue-500">Click to view →</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Detail Page ──────────────────────────────────────────────────────────

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddInteraction, setShowAddInteraction] = useState(false);
  const [showAddReminder, setShowAddReminder] = useState(false);
  const [showSendEmail, setShowSendEmail] = useState(false);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [emailDetailId, setEmailDetailId] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [contactTasks, setContactTasks] = useState<{task_id: string; title: string; status: string; due_date: string|null; assigned_to_name: string|null}[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingContactTask, setAddingContactTask] = useState(false);

  const loadContactTasks = useCallback(async () => {
    if (!id) return;
    const r = await fetch(`/api/proxy/tasks?contact_id=${id}&limit=50`);
    if (r.ok) setContactTasks(await r.json());
  }, [id]);

  useEffect(() => { loadContactTasks(); }, [loadContactTasks]);

  async function addContactTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    setAddingContactTask(true);
    try {
      await fetch("/api/proxy/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTaskTitle.trim(), contact_id: id }),
      });
      setNewTaskTitle("");
      loadContactTasks();
    } finally { setAddingContactTask(false); }
  }

  async function toggleContactTask(taskId: string, currentStatus: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: currentStatus === "done" ? "open" : "done" }),
    });
    loadContactTasks();
  }

  async function deleteContactTask(taskId: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, { method: "DELETE" });
    setContactTasks(prev => prev.filter(t => t.task_id !== taskId));
  }

  const fetchContact = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/proxy/contacts/${id}`);
      if (r.ok) setContact(await r.json());
      else router.push("/contacts");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchContact(); }, [fetchContact]);

  async function patch(field: string, value: string) {
    await fetch(`/api/proxy/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    fetchContact();
  }

  async function patchArray(field: string, value: string) {
    const arr = value.split(",").map((v) => v.trim()).filter(Boolean);
    await fetch(`/api/proxy/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: arr }),
    });
    fetchContact();
  }

  async function resolveReminder(rid: string) {
    await fetch(`/api/proxy/contacts/reminders/${rid}/resolve`, { method: "PATCH" });
    fetchContact();
  }

  async function deleteReminder(rid: string) {
    await fetch(`/api/proxy/contacts/reminders/${rid}`, { method: "DELETE" });
    fetchContact();
  }

  async function enrich() {
    setEnriching(true);
    setActionMsg("Enrichment queued — AI will update this contact shortly.");
    await fetch(`/api/proxy/contacts/${id}/enrich`, { method: "POST" });
    setEnriching(false);
    // Enrichment runs on the worker (~10s). Poll a few times so the panel
    // picks up the result without a manual reload.
    [6000, 12000, 20000].forEach((ms) => setTimeout(fetchContact, ms));
    setTimeout(() => setActionMsg(null), 20000);
  }

  async function summarize() {
    setSummarizing(true);
    setActionMsg("Summary queued — will be ready in a moment.");
    await fetch(`/api/proxy/contacts/${id}/summarize`, { method: "POST" });
    setSummarizing(false);
    setTimeout(() => {
      setActionMsg(null);
      fetchContact();
    }, 8000);
  }

  async function archiveContact() {
    if (!confirm("Archive this contact? They won't appear in the list but can be restored.")) return;
    await fetch(`/api/proxy/contacts/${id}`, { method: "DELETE" });
    router.push("/contacts");
  }

  async function deleteContactPermanently() {
    if (!confirm(`Permanently delete ${contact?.name}? This cannot be undone — all interactions, reminders, and links will be removed.`)) return;
    await fetch(`/api/proxy/contacts/${id}/permanent`, { method: "DELETE" });
    router.push("/contacts");
  }

  async function convertToCompany() {
    if (!confirm(`Convert ${contact?.name} to a company? The contact will be archived and a company record will be created.`)) return;
    const res = await fetch(`/api/proxy/contacts/${id}/convert-to-company`, { method: "POST" });
    if (!res.ok) { alert("Conversion failed"); return; }
    const data = await res.json();
    router.push(`/contacts/companies/${data.company_id}`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!contact) return null;

  const enrichmentData = contact.enrichment_data || {};

  return (
    <div className="max-w-6xl">
      <div className="mb-4">
        <Link href="/contacts" className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          ← All Contacts
        </Link>
      </div>

      {actionMsg && (
        <div className="mb-4 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 text-sm text-blue-700 dark:text-blue-300">
          {actionMsg}
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">

        {/* ── Left Panel ── */}
        <div className="col-span-12 lg:col-span-3 space-y-4">

          {/* Avatar + name + actions */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4 space-y-4 min-w-0">
            <div className="flex flex-col items-center text-center gap-3 min-w-0">
              {/* Avatar */}
              <label className="relative cursor-pointer group" title="Click to change photo">
                <Avatar url={contact.avatar_url} name={contact.name} size={20} />
                <div className="absolute inset-0 rounded bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const img = new Image();
                  img.src = URL.createObjectURL(file);
                  await new Promise(r => { img.onload = r; });
                  const size = 256;
                  const canvas = document.createElement("canvas");
                  const scale = Math.min(size / img.width, size / img.height, 1);
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;
                  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
                  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                  await fetch(`/api/proxy/contacts/${contact.contact_id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ avatar_url: dataUrl }),
                  });
                  fetchContact();
                  e.target.value = "";
                }} />
              </label>

              <div className="w-full min-w-0">
                <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 break-words [overflow-wrap:anywhere]">{contact.name}</h1>
                {contact.title && <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 break-words [overflow-wrap:anywhere]">{contact.title}</p>}
                {contact.tagline && <p className="text-xs text-zinc-400 dark:text-zinc-500 italic mt-0.5 break-words [overflow-wrap:anywhere]">{contact.tagline}</p>}
                {contact.organization && !contact.company_id && (
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 break-words [overflow-wrap:anywhere]">{contact.organization}</p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-wrap gap-1.5 justify-center">
                {contact.email && (
                  <button onClick={() => setShowSendEmail(true)}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    Email
                  </button>
                )}
                <button onClick={() => setShowCreateEvent(true)}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Schedule
                </button>
                <button onClick={enrich} disabled={enriching}
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors">
                  {enriching ? "Enriching…" : "Enrich"}
                </button>
                <button onClick={summarize} disabled={summarizing}
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors">
                  {summarizing ? "Summarizing…" : "Summarize"}
                </button>
                <button onClick={convertToCompany}
                  className="text-xs px-2.5 py-1 rounded-lg border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors">
                  Convert to Company
                </button>
                <button onClick={archiveContact}
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                  Archive
                </button>
                <button onClick={deleteContactPermanently}
                  className="text-xs px-2.5 py-1 rounded-lg border border-red-200 dark:border-red-800 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
                  Delete
                </button>
              </div>
            </div>

            {/* Fields */}
            <div className="space-y-3 border-t border-zinc-100 dark:border-zinc-800 pt-3">
              <EditableField label="Name" value={contact.name} onSave={(v) => patch("name", v)} />
              {!contact.company_id && (
                <EditableField label="Organization" value={contact.organization} onSave={(v) => patch("organization", v)} />
              )}
              <EditableField label="Email" value={contact.email} onSave={(v) => patch("email", v)} />
              <EditableField label="Phone" value={contact.phone} onSave={(v) => patch("phone", v)} />
              <EditableField label="Title" value={contact.title} onSave={(v) => patch("title", v)} />
              <EditableField label="Tagline" value={contact.tagline} onSave={(v) => patch("tagline", v)} />
              {contact.linkedin_url && (
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-0.5">LinkedIn</label>
                  <a href={contact.linkedin_url} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:underline truncate block">
                    {contact.linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "")}
                  </a>
                </div>
              )}
              {!contact.linkedin_url && (
                <EditableField label="LinkedIn" value={contact.linkedin_url} onSave={(v) => patch("linkedin_url", v)} />
              )}
              <EditableField label="Website" value={contact.website_url} onSave={(v) => patch("website_url", v)} />
              <InlineTagEditor
                tags={contact.tags || []}
                onSave={async (newTags) => {
                  await fetch(`/api/proxy/contacts/${contact.contact_id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tags: newTags }),
                  });
                  fetchContact();
                }}
              />
              <EditableField
                label="Subject Areas"
                value={(contact.subject_areas || []).join(", ")}
                onSave={(v) => patchArray("subject_areas", v)}
              />
              <EditableField label="Notes" value={contact.notes} onSave={(v) => patch("notes", v)} multiline />
            </div>
          </div>

          {/* Company picker */}
          <CompanyPicker
            contactId={contact.contact_id}
            currentCompanyId={contact.company_id}
            currentCompanyName={contact.company_name}
            currentOrg={contact.organization}
            onChanged={fetchContact}
          />

          {/* Linked projects */}
          {(contact.linked_projects?.length ?? 0) > 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4 space-y-1.5">
              <p className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-2">
                Projects ({contact.linked_projects.length})
              </p>
              {contact.linked_projects.map((p) => (
                <Link key={p.project_id} href={`/projects/${p.project_id}`}
                  className="flex items-center justify-between gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg p-1.5 -mx-1.5 transition-colors group/proj">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate group-hover/proj:text-blue-600 dark:group-hover/proj:text-blue-400 transition-colors">
                      {p.name}
                    </p>
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 capitalize">{p.project_type?.replace(/_/g, " ")}</p>
                  </div>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 capitalize flex-shrink-0">{p.stage}</span>
                </Link>
              ))}
            </div>
          )}

          {/* Enrichment data */}
          {Object.keys(enrichmentData).length > 0 && (
            <div className="space-y-3">
              {(enrichmentData as any).professional_background && (
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4 space-y-2">
                  <p className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">AI Profile</p>
                  <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{(enrichmentData as any).professional_background}</p>
                  {(enrichmentData as any).industry_focus && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Industry: {(enrichmentData as any).industry_focus}</p>
                  )}
                  {(enrichmentData as any).relevance_to_business && (
                    <p className="text-xs text-blue-600 dark:text-blue-400 italic leading-relaxed">{(enrichmentData as any).relevance_to_business}</p>
                  )}
                  {(enrichmentData as any).verified_facts?.person_location && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{(enrichmentData as any).verified_facts.person_location}</p>
                  )}
                  {contact.last_enriched_at && (
                    <p className="text-[11px] text-zinc-300 dark:text-zinc-600 pt-1">
                      Updated {fmtDate(contact.last_enriched_at)}
                      {(enrichmentData as any).enrichment_sources?.length > 0 &&
                        ` · ${(enrichmentData as any).enrichment_sources.join(", ")}`}
                    </p>
                  )}
                </div>
              )}
              {((enrichmentData as any).company_focus || (enrichmentData as any).partnership_potential) && (
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4 space-y-2">
                  <p className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Company Profile</p>
                  {(enrichmentData as any).company_focus && (
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">{(enrichmentData as any).company_focus}</p>
                  )}
                  {(enrichmentData as any).partnership_potential && (
                    <p className="text-xs text-green-700 dark:text-green-400 italic leading-relaxed border-l-2 border-green-300 dark:border-green-700 pl-2">{(enrichmentData as any).partnership_potential}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Center: AI Summary + Timeline ── */}
        <div className="col-span-12 lg:col-span-6 space-y-4">
          <SummaryCard contact={contact} onUpdated={fetchContact} onSummarize={summarize} summarizing={summarizing} />
          <InteractionTimeline
            interactions={contact.interactions}
            onAddClick={() => setShowAddInteraction(true)}
            onEmailClick={(id) => setEmailDetailId(id)}
          />
        </div>

        {/* ── Right Panel: Reminders + Tasks ── */}
        <div className="col-span-12 lg:col-span-3 space-y-4">

          {/* Reminders */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Reminders</p>
              <button onClick={() => setShowAddReminder(true)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 font-medium transition-colors">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add
              </button>
            </div>

            {contact.reminders.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center py-4">No open reminders.</p>
            ) : (
              <div className="space-y-2.5">
                {contact.reminders.map((r) => (
                  <div key={r.reminder_id} className="bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/60 rounded-xl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{r.title}</p>
                        {r.due_date && (
                          <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">Due {fmtDate(r.due_date)}</p>
                        )}
                        {r.description && <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{r.description}</p>}
                        <div className="mt-1.5"><RemindTypeBadge type={r.reminder_type} /></div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        <button onClick={() => resolveReminder(r.reminder_id)} title="Mark resolved"
                          className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900 flex items-center justify-center text-xs font-bold transition-colors">✓</button>
                        <button onClick={() => deleteReminder(r.reminder_id)} title="Delete"
                          className="w-6 h-6 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-500 flex items-center justify-center text-xs transition-colors">✕</button>
                      </div>
                    </div>
                    {r.auto_generated && (
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 italic">Auto-generated</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tasks */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Tasks</p>
              <button onClick={() => setAddingContactTask(v => !v)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 font-medium transition-colors">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add
              </button>
            </div>

            {contactTasks.length === 0 && !addingContactTask ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center py-2">No tasks yet.</p>
            ) : (
              <div className="space-y-1">
                {contactTasks.map(t => (
                  <div key={t.task_id} className="flex items-start gap-2 py-1">
                    <button onClick={() => toggleContactTask(t.task_id, t.status)}
                      className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                        t.status === "done"
                          ? "bg-green-500 border-green-500 text-white"
                          : "border-zinc-300 dark:border-zinc-600 hover:border-green-400"
                      }`}>
                      {t.status === "done" && (
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs ${t.status === "done" ? "line-through text-zinc-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                        {t.title}
                      </p>
                      {t.due_date && (
                        <p className="text-xs text-zinc-400 dark:text-zinc-500">{fmtDate(t.due_date)}</p>
                      )}
                    </div>
                    <button onClick={() => deleteContactTask(t.task_id)}
                      className="text-zinc-300 dark:text-zinc-600 hover:text-red-400 text-xs flex-shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}

            {addingContactTask && (
              <form onSubmit={addContactTask} className="mt-2 flex gap-1">
                <input
                  autoFocus
                  value={newTaskTitle}
                  onChange={e => setNewTaskTitle(e.target.value)}
                  placeholder="Task title…"
                  onKeyDown={e => { if (e.key === "Escape") { setAddingContactTask(false); setNewTaskTitle(""); } }}
                  className="flex-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button type="submit"
                  className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded-lg hover:bg-blue-700">Add</button>
                <button type="button" onClick={() => { setAddingContactTask(false); setNewTaskTitle(""); }}
                  className="text-xs text-zinc-400 hover:text-zinc-600 px-1">✕</button>
              </form>
            )}

            {contactTasks.length > 0 && (
              <Link href={`/tasks?contact_id=${id}`}
                className="mt-3 block text-xs text-blue-600 hover:text-blue-800 text-center">
                View all in Tasks →
              </Link>
            )}
          </div>

        </div>
      </div>

      {showAddInteraction && (
        <AddInteractionModal contactId={id} onClose={() => setShowAddInteraction(false)} onAdded={fetchContact} />
      )}
      {showAddReminder && (
        <AddReminderModal contactId={id} onClose={() => setShowAddReminder(false)} onAdded={fetchContact} />
      )}
      {emailDetailId && (
        <EmailDetailModal contactId={id} interactionId={emailDetailId} onClose={() => setEmailDetailId(null)} />
      )}
      {showSendEmail && contact.email && (
        <SendEmailModal
          contactId={id}
          contactEmail={contact.email}
          contactName={contact.name}
          onClose={() => setShowSendEmail(false)}
          onSent={() => { fetchContact(); setActionMsg("Email sent and logged."); setTimeout(() => setActionMsg(null), 5000); }}
        />
      )}
      {showCreateEvent && (
        <CreateEventModal contactId={id} contactName={contact.name} onClose={() => setShowCreateEvent(false)} onCreated={() => { fetchContact(); }} />
      )}
    </div>
  );
}
