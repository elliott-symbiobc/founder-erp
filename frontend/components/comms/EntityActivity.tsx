"use client";

// Entity-generic communications Activity panel + linked-contacts manager.
// Extracted verbatim from the investor board's ActivitySection so the two stay
// behaviourally identical, then parameterised by { entityType, entityId } to
// drive /api/proxy/comms/<entityType>/<entityId>. Backed by the shared comms
// API (Gmail sync, scheduled sends, drafts, templates, signature).

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AutoTextarea } from "@/components/AutoTextarea";
import { Avatar } from "@/components/Avatar";


// ── Types ────────────────────────────────────────────────────────────────────
type CommMessage = {
  message_id: string;
  kind: "email" | "meeting" | "touch";
  direction: "inbound" | "outbound" | null;
  starts_at: string | null;
  attendees: string[];
  event_link: string | null;
  attachment_names: string[];
  subject: string | null;
  snippet: string | null;
  from_email: string | null;
  to_emails: string[];
  occurred_at: string;
  thread_id: string | null;
  gmail_message_id: string;
  sent_by_platform: boolean;
  /** Our own annotation on a message (e.g. a Granola link on a meeting). */
  notes?: string | null;
  /** Logged by hand rather than synced from Gmail — the only kind that can be
   *  corrected here, since a synced message would come back on the next sweep. */
  is_manual?: boolean;
};
type CommAddress = {
  address_id: string;
  email: string;
  contact_id: string | null;
  contact_name: string | null;
  is_primary: boolean;
  is_organizational: boolean;
  sendable: boolean;
};
type ScheduledEmail = {
  scheduled_id: string;
  to_email: string;
  subject: string;
  /** Carried so a queued email can be reopened in the composer and changed
   *  before it goes out, rather than only cancelled and rewritten. */
  body: string;
  cc_emails: string[];
  attachments: Attachment[];
  scheduled_for: string | null;
  cancel_on_reply: boolean;
  template_name: string | null;
  /** Written by the platform, so it waits for a person before it can send. */
  approval_required: boolean;
  approved_at: string | null;
};
/** The sign-off an email from this record will carry. Authored as plain text —
 *  one line per line, `Label [https://…]` for a link — and rendered to HTML
 *  server-side, so what the composer previews is what actually goes out. */
type Signature = {
  signature: string;
  preview_html: string;
  editable: boolean;
  owner_name: string | null;
};

/** A composed email parked before it goes anywhere. Physically the same row a
 *  queued send uses, but with no send time on it, so nothing will ever pick it
 *  up on a timer — it waits until someone opens it back up. */
type EmailDraft = {
  scheduled_id: string;
  to_email: string;
  subject: string;
  body: string;
  template_id: string | null;
  cancel_on_reply: boolean;
  cc_emails: string[];
  attachments: Attachment[];
  updated_at: string;
};
type FailedEmail = {
  scheduled_id: string;
  to_email: string;
  subject: string;
  error: string | null;
  updated_at: string;
};
type ActivityTask = {
  task_id: string;
  title: string;
  description?: string | null;
  created_at?: string | null;
  due_date: string | null;
  status: "open" | "done";
  priority: string | null;
  activity_type: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
};
type Attachment = {
  id: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  /** 'drive' pulls at send time; 'upload' came off a computer. */
  source?: "drive" | "upload";
};
type ContactHit = {
  contact_id: string;
  name: string;
  email: string | null;
  organization: string | null;
};
type EmailTemplate = {
  template_id: string;
  name: string;
  kind: string;
  subject: string;
  body: string;
  default_delay_days: number | null;
  /** Shared documents that come with the template. Picking it attaches them. */
  attachments: Attachment[];
};
type LibraryDoc = {
  id: string;
  name: string;
  filename: string;
  mime_type: string | null;
  size: number | null;
  uploaded_by: string | null;
};

// ── Shared team-user / self-email stores (self-contained copy) ───────────────
type AssignableUser = { user_id: string; email: string; display_name: string };

/** Shared, cached across every avatar and picker on the page. */
let _assignableUsers: AssignableUser[] = [];
const _assignableListeners = new Set<() => void>();
let _assignableLoaded = false;

async function refreshAssignableUsers() {
  try {
    const res = await fetch("/api/proxy/funding/users");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      _assignableUsers = data;
      _assignableListeners.forEach((l) => l());
    }
  } catch {}
}

function useAssignableUsers(): AssignableUser[] {
  const users = React.useSyncExternalStore(
    (cb) => { _assignableListeners.add(cb); return () => _assignableListeners.delete(cb); },
    () => _assignableUsers,
    () => _assignableUsers,
  );
  useEffect(() => {
    if (!_assignableLoaded) { _assignableLoaded = true; refreshAssignableUsers(); }
  }, []);
  return users;
}

/** The signed-in user's email, cached the same way. Used to work out who the
 *  *other* people on the team are — the ones a composed email should copy. */
let _myEmail: string | null = null;
const _myEmailListeners = new Set<() => void>();
let _myEmailLoaded = false;

function useMyEmail(): string | null {
  const email = React.useSyncExternalStore(
    (cb) => { _myEmailListeners.add(cb); return () => _myEmailListeners.delete(cb); },
    () => _myEmail,
    () => _myEmail,
  );
  useEffect(() => {
    if (_myEmailLoaded) return;
    _myEmailLoaded = true;
    fetch("/api/proxy/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.email) { _myEmail = d.email; _myEmailListeners.forEach(l => l()); } })
      .catch(() => {});
  }, []);
  return email;
}

// ── Small shared UI helpers (self-contained copy) ───────────────────────────
function UserAvatar({ name, size = 20 }: { name: string | null; size?: number }) {
  return <Avatar name={name} size={size / 4} />;
}
const D_CARD = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl";
const D_INPUT = "text-xs text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500/30";

/** `datetime-local` is wall-clock text carrying no zone; these are the two
 *  directions of that conversion, both through the browser's local time — which
 *  is what "send it at 9am" means to the person typing it. Seconds are dropped
 *  on purpose: the sweep that posts queued mail runs every 15 minutes, so a
 *  precise second is a promise the send could not keep. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Opens the picker on a sensible moment instead of an empty box. */
function inDays(days: number): string {
  return toLocalInput(new Date(Date.now() + days * 86400000));
}
function useAutoGrow(value: string, minPx = 0, active = true) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, minPx)}px`;
  }, [value, minPx, active]);
  return ref;
}
function QuietSelect({ value, onChange, className = "", tone = "text-zinc-700 dark:text-zinc-200", children }: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** Text colour — passed as one class so it never collides with the default. */
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`group relative inline-flex items-center ${className}`}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`peer w-full appearance-none cursor-pointer rounded-md border border-transparent bg-transparent py-1 pl-1.5 pr-5 text-xs transition-colors hover:border-zinc-200 hover:bg-white dark:hover:border-zinc-700 dark:hover:bg-zinc-800 focus:border-zinc-200 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500/30 dark:focus:border-zinc-700 dark:focus:bg-zinc-800 ${tone}`}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-1 h-3 w-3 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 peer-focus:opacity-100"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  );
}
function DetailSection({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={D_CARD}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors rounded-xl">
        <svg className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 shrink-0">{title}</h3>
        {!open && summary && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate ml-1 min-w-0">{summary}</span>
        )}
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

// ── Linked contacts (addresses) ─────────────────────────────────────────────

// A slim, entity-generic contacts panel: manages the email addresses linked to
// this record so the Gmail sync matches their mail and the composer can reach
// them. (The investor board's richer on-record block is intentionally omitted —
// a deal keeps its people in the CRM's own Company section.)
export function EntityContacts({ entityType, entityId, entityName = null, onChanged }: {
  entityType: "investor" | "deal" | "funding";
  entityId: string;
  entityName?: string | null;
  onChanged: () => void;
}) {
  const [addresses, setAddresses] = useState<CommAddress[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ContactHit | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}`);
    if (r.ok) setAddresses((await r.json()).addresses ?? []);
  }, [entityType, entityId]);
  useEffect(() => { load(); }, [load]);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setHits([]); return; }
    setSearching(true);
    try {
      const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(q)}&limit=15`);
      if (r.ok) {
        const data = await r.json();
        setHits((data.contacts ?? data ?? []).map((c: Record<string, unknown>) => ({
          contact_id: String(c.contact_id),
          name: String(c.name ?? ""),
          email: (c.email as string) ?? null,
          organization: (c.organization as string) ?? null,
        })));
      }
    } finally { setSearching(false); }
  }, []);

  function reset() {
    setName(""); setEmail(""); setRole("");
    setQuery(""); setHits([]); setPicked(null); setAdding(false);
  }

  async function add() {
    const payload = picked
      ? { contact_id: picked.contact_id, email: (picked.email ?? email).trim(), role: role.trim() || null }
      : { email: email.trim(), name: name.trim() || null, role: role.trim() || null };
    if (!payload.email) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/contacts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert(typeof e.detail === "string" ? e.detail : "Could not add that contact.");
        return;
      }
      reset();
      await load(); onChanged();
    } finally { setBusy(false); }
  }

  async function patchAddress(id: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/comms/addresses/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    await load(); onChanged();
  }
  async function remove(id: string) {
    await fetch(`/api/proxy/comms/addresses/${id}`, { method: "DELETE" });
    setConfirmRemove(null);
    await load(); onChanged();
  }

  return (
    <div className={D_CARD + " p-4 space-y-3"}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
          Contacts
          <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded">{addresses.length}</span>
        </span>
        <button onClick={() => setAdding(v => !v)}
          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">+ Add</button>
      </div>

      {adding && (
        <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
          {picked ? (
            <div className="flex items-center gap-2 rounded-md bg-zinc-50 dark:bg-zinc-800/50 px-2 py-1.5">
              <UserAvatar name={picked.name} size={24} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{picked.name}</p>
                <p className="text-[10px] text-zinc-400 truncate">
                  {[picked.email, picked.organization].filter(Boolean).join(" · ") || "No email on file"}
                </p>
              </div>
              <button onClick={() => { setPicked(null); setQuery(""); }}
                className="text-[10px] text-zinc-400 hover:text-zinc-600">Change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <input autoFocus value={query}
                  onChange={e => { setQuery(e.target.value); search(e.target.value); }}
                  placeholder="Search existing contacts…" className={D_INPUT + " w-full"} />
                {searching && <span className="absolute right-2 top-1.5 text-[10px] text-zinc-400">…</span>}
              </div>
              {hits.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {hits.map(h => (
                    <button key={h.contact_id}
                      onClick={() => { setPicked(h); setHits([]); setEmail(h.email ?? ""); }}
                      className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                      <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{h.name}</span>
                      {h.organization && <span className="text-[10px] text-zinc-400 ml-1.5">· {h.organization}</span>}
                      {h.email && <span className="block text-[10px] text-zinc-400 truncate">{h.email}</span>}
                    </button>
                  ))}
                </div>
              )}
              {query.trim().length >= 2 && !searching && hits.length === 0 && (
                <p className="text-[10px] text-zinc-400">No match — fill in the fields below to create a new contact.</p>
              )}
              <div className="grid grid-cols-2 gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-2">
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="Name (blank for a shared inbox)" className={D_INPUT} />
                <input value={role} onChange={e => setRole(e.target.value)}
                  placeholder="Role" className={D_INPUT} />
              </div>
              <input value={email} onChange={e => setEmail(e.target.value)} type="email"
                onKeyDown={e => { if (e.key === "Enter") add(); }}
                placeholder="name@company.com" className={D_INPUT + " w-full"} />
            </>
          )}
          {picked && (
            <input value={role} onChange={e => setRole(e.target.value)}
              placeholder="Role on this deal" className={D_INPUT + " w-full"} />
          )}
          <div className="flex items-center gap-2">
            <button onClick={add} disabled={busy || (!picked && !email.trim()) || (!!picked && !picked.email && !email.trim())}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy ? "Adding…" : picked ? "Link contact" : "Create contact"}
            </button>
            <button onClick={reset}
              className="text-xs px-2 py-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
          </div>
          <p className="text-[10px] text-zinc-400">
            Linking starts matching their email onto this record&apos;s Activity feed.
          </p>
        </div>
      )}

      {addresses.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No contacts linked yet — add one to sync their email here.</p>
      ) : (
        <div className="space-y-2">
          {addresses.map(a => (
            <div key={a.address_id} className="flex items-center gap-2 group/contact">
              <UserAvatar name={a.is_organizational ? (entityName ?? a.email) : (a.contact_name ?? a.email)} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {a.contact_id ? (
                    <a href={`/contacts/${a.contact_id}`}
                      className="text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 truncate">
                      {a.contact_name ?? a.email}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{a.email}</span>
                  )}
                  {a.is_primary && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Primary</span>
                  )}
                  {a.is_organizational && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                      title="A shared inbox rather than a person">Shared inbox</span>
                  )}
                  {!a.sendable && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      title="Tracked for incoming mail, but nothing can be sent here">No-reply</span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{a.email}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover/contact:opacity-100 transition-opacity">
                {a.sendable && <a href={`mailto:${a.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Email</a>}
                {!a.is_primary && a.sendable && (
                  <button onClick={() => patchAddress(a.address_id, { is_primary: true })}
                    className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 px-1">Set Primary</button>
                )}
                {confirmRemove === a.address_id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => remove(a.address_id)}
                      className="text-[10px] px-1.5 py-0.5 bg-red-600 text-white rounded font-medium">Remove</button>
                    <button onClick={() => setConfirmRemove(null)}
                      className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(a.address_id)}
                    title="Unlink from this record — the contact record is kept"
                    className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 px-1">✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Activity + email composer ───────────────────────────────────────────────
/** An Activity task row: reads compact, expands into an inline editor for the
 *  title, note, due date and assignee (or delete). */
function TaskRow({ t, assignableUsers, onToggle, onAssign, onPatch, onDelete }: {
  t: ActivityTask;
  assignableUsers: AssignableUser[];
  onToggle: (t: ActivityTask) => void;
  onAssign: (id: string, userId: string) => void;
  onPatch: (id: string, fields: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [desc, setDesc] = useState(t.description ?? "");
  const [due, setDue] = useState(t.due_date ?? "");
  const [busy, setBusy] = useState(false);
  const overdue = !!t.due_date && new Date(t.due_date) < new Date(new Date().toDateString());

  useEffect(() => {
    if (!editing) { setTitle(t.title); setDesc(t.description ?? ""); setDue(t.due_date ?? ""); }
  }, [editing, t.title, t.description, t.due_date]);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onPatch(t.task_id, { title: title.trim(), description: desc.trim() || null, due_date: due || null });
      setEditing(false);
    } finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5 space-y-1.5">
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          placeholder="Task title" className={D_INPUT + " w-full"} />
        <AutoTextarea value={desc} onChange={e => setDesc(e.target.value)} rows={2}
          placeholder="Description (optional)" className={D_INPUT + " w-full resize-none"} />
        <div className="flex flex-wrap items-center gap-1.5">
          <input type="date" value={due} onChange={e => setDue(e.target.value)}
            title="Due date" className={D_INPUT} />
          <QuietSelect value={t.assigned_to ?? ""} onChange={v => onAssign(t.task_id, v)} className="min-w-[130px]">
            <option value="">— Unassigned —</option>
            {assignableUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name}</option>)}
          </QuietSelect>
          <button onClick={save} disabled={busy || !title.trim()}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)}
            className="text-[11px] px-2 py-1.5 text-zinc-400 hover:text-zinc-600">Cancel</button>
          <button onClick={() => onDelete(t.task_id)}
            className="ml-auto text-[11px] px-2 py-1.5 text-zinc-400 hover:text-red-500">Delete</button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5">
      <input type="checkbox" checked={false} onChange={() => onToggle(t)}
        title="Mark done" className="accent-blue-600 cursor-pointer shrink-0" />
      <button onClick={() => setEditing(true)} title="Edit task" className="min-w-0 flex-1 text-left">
        <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate">{t.title}</p>
        {t.due_date && (
          <p className={`text-[10px] ${overdue ? "text-red-600 dark:text-red-400 font-medium" : "text-zinc-400 dark:text-zinc-500"}`}>
            {overdue ? `Overdue — due ${t.due_date}` : `Due ${t.due_date}`}
          </p>
        )}
      </button>
      <QuietSelect value={t.assigned_to ?? ""} onChange={v => onAssign(t.task_id, v)} className="shrink-0 max-w-[128px]">
        <option value="">— Unassigned —</option>
        {assignableUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name}</option>)}
      </QuietSelect>
      <button onClick={() => setEditing(true)} title="Edit task"
        className="shrink-0 text-[10px] text-zinc-300 hover:text-blue-500 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity">Edit</button>
    </div>
  );
}


export function EntityActivity({ entityType, entityId, assignedTo = null, outreachChannel = null, onChanged, onRemoveMessage, title = "Activity", feedExtras = [], planButtons = null, requireOpenTask = false }: {
  entityType: "investor" | "deal" | "funding";
  entityId: string;
  assignedTo?: string | null;
  outreachChannel?: string | null;
  onChanged: () => void;
  /** Supplied only where a synced message can be un-filed — funding records,
   *  whose mail is matched by guess and therefore has to be correctable.
   *  Omitted elsewhere, so no detach button appears on those boards. */
  onRemoveMessage?: (gmailMessageId: string, subject: string) => void;
  /** Section heading. The CRM folds its Plan in here and titles it
   *  "Plan & Activity"; everywhere else this stays "Activity". */
  title?: string;
  /** Extra to-do rows folded into the combined feed (the CRM Plan items),
   *  each with a date and an open flag so they interleave and sort right. */
  feedExtras?: Array<{ key: string; date: string | null; open: boolean; node: React.ReactNode }>;
  /** Extra quick-add buttons for the bottom toolbar (the CRM plan adders). */
  planButtons?: React.ReactNode;
  /** When true, warn if the record has no open task at all (plan + Activity). */
  requireOpenTask?: boolean;
}) {
  const [data, setData] = useState<{ messages: CommMessage[]; addresses: CommAddress[]; scheduled: ScheduledEmail[]; drafts: EmailDraft[]; failed: FailedEmail[]; tasks: ActivityTask[] } | null>(null);
  const [newTask, setNewTask] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");
  const [newTaskAssignee, setNewTaskAssignee] = useState<string>("");
  const [addingTask, setAddingTask] = useState(false);
  const assignableUsers = useAssignableUsers();
  const myEmail = useMyEmail();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [composing, setComposing] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [cc, setCc] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");
  const [sendAt, setSendAt] = useState(() => inDays(5));
  const [schedulePicker, setSchedulePicker] = useState(false);
  // Roughly six lines, so an empty composer still reads as an email box.
  const bodyRef = useAutoGrow(bodyText, 132, composing);
  const [editingTouch, setEditingTouch] = useState<string | null>(null);
  const [touchDraft, setTouchDraft] = useState({ subject: "", note: "", date: "" });
  // A note attached to a message — a Granola link today, the notebook eventually.
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  // Which synced activities are expanded to show their detail.
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
  const toggleMsg = (id: string) =>
    setExpandedMsgs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // Full email bodies, pulled from Gmail on demand when a message is expanded
  // (the sync only stores a snippet). Keyed by message_id.
  const [fullBodies, setFullBodies] = useState<Record<string, { text: string; loading: boolean }>>({});
  async function loadFullBody(id: string) {
    if (fullBodies[id]) return;
    setFullBodies(prev => (prev[id] ? prev : { ...prev, [id]: { text: "", loading: true } }));
    try {
      const r = await fetch(`/api/proxy/comms/message/${id}/body`);
      const j = await r.json().catch(() => ({}));
      setFullBodies(prev => ({ ...prev, [id]: { text: (j && j.body) || "", loading: false } }));
    } catch {
      setFullBodies(prev => ({ ...prev, [id]: { text: "", loading: false } }));
    }
  }

  async function saveNotes(id: string) {
    await fetch(`/api/proxy/comms/message/${id}/notes`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notesDraft.trim() }),
    });
    setNotesFor(null); setNotesDraft("");
    load();
  }
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [driveQuery, setDriveQuery] = useState("");
  const [driveHits, setDriveHits] = useState<Attachment[]>([]);
  const [library, setLibrary] = useState<LibraryDoc[]>([]);
  // One picker for every source of an attachment; drivePicker is the second
  // step inside it, not a separate control.
  const [attachOpen, setAttachOpen] = useState(false);
  const [drivePicker, setDrivePicker] = useState(false);
  // Set while the composer is editing a draft that already exists on the
  // server, so saving updates that one instead of leaving a trail of copies.
  const [draftId, setDraftId] = useState<string | null>(null);
  // Set when the composer is editing an email already in the queue. Mutually
  // exclusive with draftId — one row is being worked on, not two.
  const [queuedId, setQueuedId] = useState<string | null>(null);
  // The Email toolkit (compose / sync / log) open state, plus an optional
  // internal title used to label whatever email or activity is created next.
  const [emailOpen, setEmailOpen] = useState(false);
  const [activityTitle, setActivityTitle] = useState("");
  const [sig, setSig] = useState<Signature | null>(null);
  const [mailboxes, setMailboxes] = useState<{ user_id: string; name: string; email: string }[]>([]);
  const [senderId, setSenderId] = useState<string>("");
  const [editingSig, setEditingSig] = useState(false);
  const [sigDraft, setSigDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}`);
    if (r.ok) setData(await r.json());
  }, [entityType, entityId]);

  const loadSignature = useCallback(async () => {
    const q = senderId ? `?sender_id=${senderId}` : "";
    const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/signature${q}`);
    if (r.ok) setSig(await r.json());
  }, [entityType, entityId, senderId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSignature().catch(() => {}); }, [loadSignature]);
  useEffect(() => {
    fetch("/api/proxy/comms/mailboxes").then(r => (r.ok ? r.json() : [])).then(setMailboxes).catch(() => {});
  }, []);
  useEffect(() => {
    if (senderId || !mailboxes.length) return;
    setSenderId(assignedTo && mailboxes.some(m => m.user_id === assignedTo) ? assignedTo : mailboxes[0].user_id);
  }, [mailboxes, assignedTo, senderId]);
  useEffect(() => {
    fetch(`/api/proxy/comms/templates?scope=${entityType}`)
      .then(r => r.json()).then(setTemplates).catch(() => {});
    fetch("/api/proxy/comms/library")
      .then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);

  const sendable = (data?.addresses ?? []).filter(a => a.sendable);
  // Derived, not stored: the default recipient is the primary address until the
  // user picks another one.
  const toAddr = to || sendable.find(a => a.is_primary)?.email || sendable[0]?.email || "";

  // Everyone on the team except whoever is writing. Investor correspondence is
  // a two-person conversation on our side, so the other one is copied by
  // default — removable per email, but never something to remember to add.
  // The rest of the team is copied by default — everyone except whoever the
  // email is being SENT AS (the From mailbox), not whoever happens to be logged
  // in. So sending as Elliott copies Nikolai, and vice-versa.
  const senderEmail = useMemo(
    () => mailboxes.find(m => m.user_id === senderId)?.email ?? myEmail,
    [mailboxes, senderId, myEmail],
  );
  const teamCc = useMemo(
    () => assignableUsers
      .map(u => u.email)
      .filter(e => !!e && e.toLowerCase() !== (senderEmail ?? "").toLowerCase()),
    [assignableUsers, senderEmail],
  );
  // Switching the sender mid-compose keeps the team copy in step: drop the new
  // sender from Cc and make sure the others are on it.
  useEffect(() => {
    if (!composing) return;
    setCc(list => {
      const withoutSender = list.filter(e => e.toLowerCase() !== (senderEmail ?? "").toLowerCase());
      const missing = teamCc.filter(e => !withoutSender.some(c => c.toLowerCase() === e.toLowerCase()));
      return missing.length ? [...withoutSender, ...missing] : withoutSender;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderEmail]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find(x => x.template_id === id);
    if (!t) return;
    setSubject(t.subject);
    setBodyText(t.body);
    if (t.default_delay_days) setSendAt(inDays(t.default_delay_days));
    // Added to whatever is already attached, never replacing it — a file the
    // author picked by hand must survive changing their mind about a template.
    setAttached(a => [
      ...a,
      ...(t.attachments ?? []).filter(f => !a.some(x => x.id === f.id)),
    ]);
  }

  async function tailorWithAI() {
    setBusy("draft"); setError(null);
    try {
      const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/draft`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId || null, subject, body: bodyText }),
      });
      if (!r.ok) { setError("Could not draft that email."); return; }
      const d = await r.json();
      setSubject(d.subject); setBodyText(d.body);
    } finally { setBusy(null); }
  }

  async function post(path: string, payload: Record<string, unknown>, tag: string) {
    setBusy(tag); setError(null); setNotice(null);
    try {
      const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(typeof e.detail === "string" ? e.detail : "Request failed.");
        return false;
      }
      await load();
      onChanged();
      return true;
    } finally { setBusy(null); }
  }

  const searchDrive = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setDriveHits([]); return; }
    setBusy("drive");
    try {
      const r = await fetch(`/api/proxy/comms/drive/search?q=${encodeURIComponent(q)}`);
      if (r.ok) setDriveHits((await r.json()).map((f: Attachment) => ({ ...f, source: "drive" as const })));
    } finally { setBusy(null); }
  }, []);

  const attachmentPayload = attached.map(f => ({
    id: f.id, name: f.name, source: f.source ?? "drive",
  }));

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy("upload"); setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const r = await fetch("/api/proxy/comms/uploads", { method: "POST", body: form });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          setError(typeof e.detail === "string" ? e.detail : `Could not upload ${file.name}.`);
          continue;
        }
        const saved = await r.json();
        setAttached(a => [...a, { ...saved, source: "upload" as const }]);
      }
      closeAttach();
    } finally { setBusy(null); }
  }

  /** Open a blank composer, pre-copied to the rest of the team. */
  function openCompose() {
    setCc(teamCc);
    setCcInput("");
    setError(null); setNotice(null);
    setComposing(true);
  }

  function addCc(raw: string) {
    const entry = raw.trim().replace(/[,;]$/, "");
    if (!entry) return;
    setCc(list => list.some(e => e.toLowerCase() === entry.toLowerCase()) ? list : [...list, entry]);
    setCcInput("");
  }

  async function sendNow() {
    const ok = await post("send", {
      to: toAddr, cc, subject, body: bodyText, attachments: attachmentPayload,
      draft_id: draftId, scheduled_id: queuedId, sender_id: senderId || null,
    }, "send");
    if (ok) resetCompose();
  }

  async function schedule() {
    // A moment already gone by would sit in the queue until the next sweep and
    // then go out regardless — that is "Send now" wearing a disguise, so say so
    // rather than quietly doing it.
    const when = new Date(sendAt);
    if (!sendAt || Number.isNaN(when.getTime())) {
      setError("Pick a date and time."); return;
    }
    if (when.getTime() < Date.now() - 60_000) {
      setError("That time has already passed — pick a later one, or use Send now."); return;
    }
    // Already in the queue: this is a change of date, not a new send.
    if (queuedId) return saveScheduled(true);
    const ok = await post("schedule", {
      to: toAddr, cc, subject, body: bodyText, scheduled_for: when.toISOString(),
      // Always conditional now: chasing someone who already answered is never
      // what was wanted, so it is a property of scheduling rather than a choice.
      cancel_on_reply: true, template_id: templateId || null,
      attachments: attachmentPayload, draft_id: draftId, sender_id: senderId || null,
    }, "schedule");
    if (ok) resetCompose();
  }

  /** Park it. Nothing is sent, and the draft keeps its attachments so the deck
   *  does not have to be found again tomorrow. */
  async function saveDraft() {
    setBusy("save-draft"); setError(null); setNotice(null);
    try {
      const payload = {
        to: toAddr, cc, subject, body: bodyText,
        template_id: templateId || null, cancel_on_reply: true,
        attachments: attached, sender_id: senderId || null,
      };
      const r = draftId
        ? await fetch(`/api/proxy/comms/drafts/${draftId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/proxy/comms/${entityType}/${entityId}/drafts`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(typeof e.detail === "string" ? e.detail : "Could not save that draft.");
        return;
      }
      resetCompose();
      setNotice("Draft saved.");
      await load();
    } finally { setBusy(null); }
  }

  function openDraft(d: EmailDraft) {
    setDraftId(d.scheduled_id);
    setTo(d.to_email);
    setSubject(d.subject);
    setBodyText(d.body);
    setTemplateId(d.template_id ?? "");
    setAttached(d.attachments ?? []);
    // The draft's own copy list, even if empty — someone removed the default
    // for a reason, and reopening must not quietly put it back.
    setCc(d.cc_emails ?? []);
    setCcInput("");
    setError(null); setNotice(null);
    setComposing(true);
  }

  /** Open a queued email in the composer. Same box, same controls — the only
   *  difference is that saving updates the queue instead of creating a draft. */
  function openScheduled(q: ScheduledEmail) {
    setQueuedId(q.scheduled_id);
    setDraftId(null);
    setTo(q.to_email);
    setCc(q.cc_emails ?? []);
    setCcInput("");
    setSubject(q.subject);
    setBodyText(q.body ?? "");
    setAttached(q.attachments ?? []);
    // The moment it is actually due, so the picker opens on the real time
    // instead of re-deriving an offset from it.
    if (q.scheduled_for) setSendAt(toLocalInput(new Date(q.scheduled_for)));
    setError(null); setNotice(null);
    setComposing(true);
  }

  async function saveScheduled(withNewDate: boolean) {
    if (!queuedId) return;
    setBusy(withNewDate ? "schedule" : "save-queued"); setError(null);
    try {
      const r = await fetch(`/api/proxy/comms/scheduled/${queuedId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: toAddr, cc, subject, body: bodyText, attachments: attachmentPayload,
          ...(withNewDate ? { scheduled_for: new Date(sendAt).toISOString() } : {}),
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(typeof e.detail === "string" ? e.detail : "Could not save that change.");
        return;
      }
      resetCompose();
      setNotice(withNewDate ? `Rescheduled for ${new Date(sendAt).toLocaleString()}.` : "Queued email updated.");
      await load();
    } finally { setBusy(null); }
  }

  async function discardDraft(id: string) {
    await fetch(`/api/proxy/comms/drafts/${id}`, { method: "DELETE" });
    if (draftId === id) resetCompose();
    await load();
  }

  async function saveSignature() {
    setBusy("signature"); setError(null);
    try {
      const r = await fetch("/api/proxy/comms/signature", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: sigDraft }),
      });
      if (!r.ok) { setError("Could not save your signature."); return; }
      setSig(await r.json());
      setEditingSig(false);
    } finally { setBusy(null); }
  }

  /** Send what is on screen to yourself. Never to the recipient, and it leaves
   *  no mark on the timeline — it is a look at the email, not a send of it. */
  async function sendTest() {
    setBusy("test"); setError(null); setNotice(null);
    try {
      const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/send-test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body: bodyText, attachments: attachmentPayload, sender_id: senderId || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof d.detail === "string" ? d.detail : "Could not send the test.");
        return;
      }
      setNotice(`Test sent to ${d.sent_to}.`);
    } finally { setBusy(null); }
  }

  function closeAttach() {
    setAttachOpen(false); setDrivePicker(false);
    setDriveQuery(""); setDriveHits([]);
  }

  function resetCompose() {
    setComposing(false); setSubject(""); setBodyText(""); setTemplateId("");
    setAttached([]); setDriveQuery(""); setDriveHits([]); closeAttach();
    setDraftId(null); setQueuedId(null);
    setTo(""); setCc([]); setCcInput(""); setSchedulePicker(false);
  }

  async function addTask() {
    const title = newTask.trim();
    if (!title) return;
    setBusy("task");
    try {
      await fetch("/api/proxy/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          due_date: newTaskDue || null,
          source_ref: entityId,
          activity_type: "todo",
          // Defaults to whoever owns the investor; overridable in the form.
          assigned_to: newTaskAssignee || assignedTo || null,
        }),
      });
      setNewTask(""); setNewTaskDue(""); setNewTaskAssignee(""); setAddingTask(false);
      await load();
    } finally { setBusy(null); }
  }

  async function assignTask(taskId: string, userId: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_to: userId || null }),
    });
    load();
  }

  async function patchTask(taskId: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    await load();
    onChanged();
  }

  async function deleteTask(taskId: string) {
    if (!window.confirm("Delete this task? This can't be undone.")) return;
    await fetch(`/api/proxy/tasks/${taskId}`, { method: "DELETE" });
    await load();
    onChanged();
  }

  async function toggleTask(t: ActivityTask) {
    const next = t.status === "open" ? "done" : "open";
    await fetch(`/api/proxy/tasks/${t.task_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next, kanban_status: next === "done" ? "done" : "todo" }),
    });
    load();
  }

  /** Correct a touch that was logged by hand — the wrong channel, a typo, the
   *  wrong day. Gmail messages are not editable; the server says so. */
  async function saveTouch(id: string) {
    const subject = touchDraft.subject.trim();
    if (!subject) return;
    setBusy("touch-edit"); setError(null);
    try {
      const r = await fetch(`/api/proxy/comms/messages/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject, note: touchDraft.note,
          occurred_at: touchDraft.date ? new Date(touchDraft.date).toISOString() : undefined,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(typeof e.detail === "string" ? e.detail : "Could not save that change.");
        return;
      }
      setEditingTouch(null);
      await load();
    } finally { setBusy(null); }
  }

  async function deleteTouch(id: string) {
    if (!confirm("Delete this logged activity? The status it set stays as it is.")) return;
    const r = await fetch(`/api/proxy/comms/messages/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setError(typeof e.detail === "string" ? e.detail : "Could not delete that entry.");
      return;
    }
    setError(null);
    await load();
    onChanged();
  }

  async function approveScheduled(id: string) {
    setBusy("approve"); setError(null);
    try {
      const r = await fetch(`/api/proxy/comms/scheduled/${id}/approve`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        setError(typeof e.detail === "string" ? e.detail : "Could not approve that email.");
        return;
      }
      setNotice("Approved — it will send on its date.");
      await load();
      onChanged();   // its review task is done now
    } finally { setBusy(null); }
  }

  async function cancelScheduled(id: string) {
    await fetch(`/api/proxy/comms/scheduled/${id}`, { method: "DELETE" });
    load();
  }

  async function resendFailed(id: string) {
    setBusy("resend"); setError(null);
    try {
      await fetch(`/api/proxy/comms/scheduled/${id}/retry`, { method: "POST" });
      await load();
      onChanged();
    } finally { setBusy(null); }
  }

  const messages = data?.messages ?? [];
  const openTasks = (data?.tasks ?? []).filter(t => t.status === "open");
  const meetingCount = messages.filter(m => m.kind === "meeting").length;
  const emailCount = messages.length - meetingCount;
  const drafts = data?.drafts ?? [];
  const plannedCount = openTasks.length + (data?.scheduled ?? []).length + feedExtras.filter(e => e.open).length;
  const summary = [
    emailCount && `${emailCount} email${emailCount === 1 ? "" : "s"}`,
    meetingCount && `${meetingCount} meeting${meetingCount === 1 ? "" : "s"}`,
    plannedCount && `${plannedCount} planned`,
    drafts.length && `${drafts.length} draft${drafts.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ")
    || (outreachChannel === "linkedin" ? "LinkedIn only" : "None yet");

  // One combined to-do feed — plan items (handed down from the CRM), queued
  // follow-ups, drafts and tasks — newest first, with anything still open
  // pinned above the resolved. Emails and meetings keep their own timeline.
  const todayStart = new Date(new Date().toDateString());
  type FeedItem = { key: string; open: boolean; ts: number; node: React.ReactNode };
  const feed: FeedItem[] = [];

  for (const ex of feedExtras) {
    feed.push({ key: ex.key, open: ex.open,
      ts: ex.date ? new Date(ex.date).getTime() : 0, node: ex.node });
  }

  for (const s of (data?.scheduled ?? [])) {
    feed.push({
      key: `sched:${s.scheduled_id}`, open: true,
      ts: s.scheduled_for ? new Date(s.scheduled_for).getTime() : 0,
      node: (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 px-2.5 py-1.5">
          <svg className="w-3 h-3 shrink-0 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <button onClick={() => openScheduled(s)} title="Open in the composer to change it"
            className="min-w-0 flex-1 text-left">
            <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 truncate">{s.subject}</p>
            <p className="text-[10px] text-amber-700/80 dark:text-amber-400/80 truncate">
              {s.scheduled_for ? new Date(s.scheduled_for).toLocaleString() : "next sweep"} → {s.to_email}
              {(s.cc_emails?.length ?? 0) > 0 && ` · cc ${s.cc_emails.length}`}
              {(s.attachments?.length ?? 0) > 0 && ` · 📎 ${s.attachments.length}`}
              {s.cancel_on_reply && " · cancels if they reply"}
            </p>
            {s.approval_required && (
              <p className={`text-[10px] font-medium ${s.approved_at
                ? "text-green-700 dark:text-green-400"
                : "text-amber-800 dark:text-amber-300"}`}>
                {s.approved_at
                  ? "✓ Approved — will send"
                  : "Written automatically · needs review before it can send"}
              </p>
            )}
          </button>
          {s.approval_required && !s.approved_at && (
            <button onClick={() => approveScheduled(s.scheduled_id)} disabled={busy === "approve"}
              title="Release it — until you do, it stays in the queue past its date"
              className="text-[10px] px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 font-medium shrink-0 disabled:opacity-40">
              {busy === "approve" ? "…" : "Approve"}
            </button>
          )}
          <button onClick={() => openScheduled(s)}
            className="text-[10px] text-amber-700 hover:text-amber-900 dark:text-amber-400 shrink-0">Edit</button>
          <button onClick={() => cancelScheduled(s.scheduled_id)}
            className="text-[10px] text-amber-700 hover:text-red-600 dark:text-amber-400 shrink-0">Cancel</button>
        </div>
      ),
    });
  }

  for (const d of drafts) {
    feed.push({
      key: `draft:${d.scheduled_id}`, open: true,
      ts: d.updated_at ? new Date(d.updated_at).getTime() : 0,
      node: (
        <div className="group flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 px-2.5 py-1.5">
          <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <button onClick={() => openDraft(d)} title="Open this draft in the composer"
            className="min-w-0 flex-1 text-left">
            <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate">
              {d.subject || <span className="italic text-zinc-400">No subject yet</span>}
            </p>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
              {d.to_email || "no recipient"}
              {(d.cc_emails?.length ?? 0) > 0 && ` · cc ${d.cc_emails.length}`}
              {(d.attachments?.length ?? 0) > 0 && ` · 📎 ${d.attachments.length}`}
              {` · saved ${new Date(d.updated_at).toLocaleDateString()}`}
            </p>
          </button>
          <button onClick={() => discardDraft(d.scheduled_id)} title="Discard this draft"
            className="shrink-0 text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
        </div>
      ),
    });
  }

  for (const t of (data?.tasks ?? [])) {
    feed.push({
      key: `task:${t.task_id}`, open: t.status === "open",
      ts: t.created_at ? new Date(t.created_at).getTime()
        : (t.due_date ? new Date(t.due_date).getTime() : 0),
      node: t.status === "open" ? (
        <TaskRow t={t} assignableUsers={assignableUsers}
          onToggle={toggleTask} onAssign={assignTask} onPatch={patchTask} onDelete={deleteTask} />
      ) : (
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
          <input type="checkbox" checked readOnly onClick={() => toggleTask(t)}
            title="Re-open" className="accent-zinc-400 cursor-pointer shrink-0" />
          <span className="min-w-0 flex-1 text-[11px] text-zinc-400 dark:text-zinc-500 line-through truncate">{t.title}</span>
          {t.due_date && <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">{t.due_date}</span>}
        </div>
      ),
    });
  }

  for (const m of messages) {
    const isEditing = editingTouch === m.message_id;
    const isOpenMsg = isEditing || expandedMsgs.has(m.message_id);
    const _fb = fullBodies[m.message_id];
    const fullText = _fb && !_fb.loading ? _fb.text : "";
    const bodyLoading = !!(_fb && _fb.loading);
    feed.push({
      key: `msg:${m.message_id}`, open: false,
      ts: new Date(m.occurred_at).getTime(),
      node: isEditing ? (
        <div className="space-y-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2">
          <input autoFocus value={touchDraft.subject}
            onChange={e => setTouchDraft(td => ({ ...td, subject: e.target.value }))}
            placeholder="What it was" className={D_INPUT + " w-full"} />
          <AutoTextarea value={touchDraft.note} rows={2}
            onChange={e => setTouchDraft(td => ({ ...td, note: e.target.value }))}
            placeholder="Note" className={D_INPUT + " w-full resize-none"} />
          <div className="flex flex-wrap items-center gap-1.5">
            <input type="date" value={touchDraft.date}
              onChange={e => setTouchDraft(td => ({ ...td, date: e.target.value }))}
              className={D_INPUT + " cursor-pointer"} />
            <button onClick={() => saveTouch(m.message_id)}
              disabled={busy === "touch-edit" || !touchDraft.subject.trim()}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy === "touch-edit" ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditingTouch(null)}
              className="text-[11px] px-2 py-1.5 text-zinc-400 hover:text-zinc-600">Cancel</button>
            <button onClick={() => deleteTouch(m.message_id)}
              className="ml-auto text-[11px] px-2 py-1.5 text-zinc-400 hover:text-red-500">Delete</button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
          <button onClick={() => { const willOpen = !expandedMsgs.has(m.message_id); toggleMsg(m.message_id); if (willOpen && !m.is_manual && m.kind !== "meeting") loadFullBody(m.message_id); }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 rounded-lg">
            {m.kind === "meeting" ? (
              <svg className="w-3 h-3 shrink-0 text-violet-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M3 11h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            ) : (
              <span className={`text-xs font-bold shrink-0 ${m.direction === "inbound" ? "text-green-600 dark:text-green-400" : "text-zinc-400"}`}
                title={m.direction === "inbound" ? "From them" : "From us"}>
                {m.direction === "inbound" ? "↓" : "↑"}
              </span>
            )}
            <span className="min-w-0 flex-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate">
              {m.subject || <span className="italic text-zinc-400">(no subject)</span>}
            </span>
            <span className="text-[10px] text-zinc-400 shrink-0">{new Date(m.occurred_at).toLocaleDateString()}</span>
            {m.notes && <span title="Has notes" className="text-[10px] shrink-0">📝</span>}
            <svg className={`w-3 h-3 shrink-0 text-zinc-400 transition-transform ${isOpenMsg ? "" : "-rotate-90"}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {isOpenMsg && (
            <div className="px-2.5 pb-2 space-y-1">
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                {m.kind === "meeting"
                  ? (m.attendees ?? []).join(", ")
                  : m.direction === "inbound" ? m.from_email : (m.to_emails ?? []).join(", ")}
              </p>
              {fullText ? (
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed whitespace-pre-wrap max-h-80 overflow-y-auto pr-1">{fullText}</div>
              ) : m.snippet ? (
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-relaxed whitespace-pre-wrap">
                  {m.snippet}{bodyLoading && <span className="italic"> · loading full email…</span>}
                </p>
              ) : bodyLoading ? (
                <p className="text-[10px] italic text-zinc-400">Loading full email…</p>
              ) : null}
              {(m.attachment_names ?? []).length > 0 && (
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                  📎 {(m.attachment_names ?? []).join(", ")}
                </p>
              )}
              <div className="flex items-center gap-3 pt-0.5">
                {(m.event_link || m.thread_id || m.gmail_message_id) && (
                  <a href={m.event_link
                        ?? `https://mail.google.com/mail/u/0/#all/${m.thread_id || m.gmail_message_id}`}
                    target="_blank" rel="noopener noreferrer"
                    title={m.event_link ? "Open in Calendar" : "Open in Gmail"}
                    className="text-[10px] text-zinc-400 hover:text-blue-500 inline-flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    {m.event_link ? "Calendar" : "Gmail"}
                  </a>
                )}
                {onRemoveMessage && !m.is_manual && (
                  <button onClick={() => onRemoveMessage(m.gmail_message_id, m.subject ?? "")}
                    title="Detach from this record"
                    className="text-[10px] text-zinc-400 hover:text-red-500">Detach</button>
                )}
                {m.is_manual && (
                  <button onClick={() => {
                      setEditingTouch(m.message_id);
                      setTouchDraft({ subject: m.subject ?? "", note: m.snippet ?? "", date: m.occurred_at.slice(0, 10) });
                    }}
                    title="Edit or delete this logged activity"
                    className="text-[10px] text-zinc-400 hover:text-blue-500">Edit</button>
                )}
              </div>
              {m.kind === "meeting" && (
                <div className="pt-1 mt-1 border-t border-zinc-100 dark:border-zinc-800">
                  {notesFor === m.message_id ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input autoFocus value={notesDraft} onChange={e => setNotesDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveNotes(m.message_id); if (e.key === "Escape") setNotesFor(null); }}
                        placeholder="Notes, or paste a Granola link…" className={D_INPUT + " flex-1 min-w-[180px]"} />
                      <button onClick={() => saveNotes(m.message_id)}
                        className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium">Save</button>
                      <button onClick={() => setNotesFor(null)}
                        className="text-[10px] px-1.5 py-1 text-zinc-400 hover:text-zinc-600">Cancel</button>
                    </div>
                  ) : m.notes ? (
                    <div className="flex items-center gap-2">
                      {/^https?:\/\//i.test(m.notes) ? (
                        <a href={m.notes} target="_blank" rel="noopener noreferrer"
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 min-w-0">
                          <span className="shrink-0">📝</span><span className="truncate">Meeting notes</span>
                        </a>
                      ) : (
                        <span className="text-[10px] text-zinc-500 dark:text-zinc-400 min-w-0"><span className="mr-1">📝</span>{m.notes}</span>
                      )}
                      <button onClick={() => { setNotesFor(m.message_id); setNotesDraft(m.notes ?? ""); }}
                        className="text-[10px] text-zinc-400 hover:text-blue-500 shrink-0">Edit</button>
                    </div>
                  ) : (
                    <button onClick={() => { setNotesFor(m.message_id); setNotesDraft(""); }}
                      className="text-[10px] text-zinc-400 hover:text-blue-500">+ Add notes</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ),
    });
  }

  for (const f of (data?.failed ?? [])) {
    feed.push({
      key: `failed:${f.scheduled_id}`, open: true,
      ts: f.updated_at ? new Date(f.updated_at).getTime() : 0,
      node: (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-2.5 py-1.5">
          <svg className="w-3 h-3 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M10.29 3.86l-8.48 14.7A1.5 1.5 0 003.1 21h17.8a1.5 1.5 0 001.29-2.44l-8.48-14.7a1.5 1.5 0 00-2.62 0z" />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-red-800 dark:text-red-300 truncate">{f.subject || "(no subject)"}</p>
            <p className="text-[10px] text-red-700/80 dark:text-red-400/80 truncate">
              Send failed → {f.to_email}{f.error ? ` · ${f.error}` : ""}
            </p>
          </div>
          <button onClick={() => resendFailed(f.scheduled_id)} disabled={busy === "resend"}
            title="Try sending it again — now falls back to an un-threaded send if the reply thread is gone"
            className="text-[10px] px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 font-medium shrink-0 disabled:opacity-40">
            {busy === "resend" ? "…" : "Resend"}
          </button>
          <button onClick={() => cancelScheduled(f.scheduled_id)}
            className="text-[10px] text-red-700 hover:text-red-900 dark:text-red-400 shrink-0">Discard</button>
        </div>
      ),
    });
  }

  feed.sort((a, b) => (a.open === b.open ? b.ts - a.ts : a.open ? -1 : 1));
  const openCount = feedExtras.filter(e => e.open).length + openTasks.length;

  return (
    <DetailSection title={title} summary={summary} defaultOpen>
      {requireOpenTask && openCount === 0 && (
        <p className="mb-3 text-[11px] text-amber-600 dark:text-amber-400">
          Every open deal needs at least one open task.
        </p>
      )}

      {feed.length > 0 ? (
        <div className="mb-3 space-y-1.5 max-h-[36rem] overflow-y-auto pr-1">
          {feed.map(f => <React.Fragment key={f.key}>{f.node}</React.Fragment>)}
        </div>
      ) : (
        <p className="mb-3 text-xs text-zinc-400 dark:text-zinc-500 italic">
          {outreachChannel === "linkedin" ? "No email on file — outreach happens on LinkedIn." : "Nothing here yet."}
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}
      {notice && (
        <p className="mt-2 rounded-md bg-green-50 dark:bg-green-950/30 px-2 py-1 text-[11px] text-green-700 dark:text-green-300">{notice}</p>
      )}

      {/* Actions — the toolbar sits at the bottom of the card */}
      <div className="mt-3 border-t border-zinc-100 dark:border-zinc-800 pt-3 space-y-1.5">
        {/* Email — opening it reveals the compose / sync / log toolkit */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setEmailOpen(o => !o)}
            className={`text-[11px] px-2.5 py-1 rounded-lg border font-medium transition-colors ${emailOpen
              ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300"
              : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}>
            + Email
          </button>
        </div>

        {emailOpen && (
          <div className="space-y-1.5 rounded-lg border border-blue-100 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/20 p-1.5">
            {/* Internal title — labels this email/activity for the team; never sent to the recipient on a logged touch */}
            <input value={activityTitle} onChange={e => setActivityTitle(e.target.value)}
              placeholder="Title (internal — e.g. First touch, Pricing follow-up)"
              className={D_INPUT + " w-full"} />
            <div className="flex flex-wrap items-center gap-1.5">
              {sendable.length > 0 && !composing && (
                <button onClick={() => { openCompose(); if (activityTitle.trim()) setSubject(activityTitle.trim()); }}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium">
                  Compose
                </button>
              )}
              <button
                onClick={async () => {
                  setBusy("sync"); setError(null);
                  try {
                    await fetch("/api/proxy/comms/sync", { method: "POST" });
                    await fetch(`/api/proxy/comms/${entityType}/${entityId}/backfill`, { method: "POST" });
                    await load();
                    onChanged();
                  } finally { setBusy(null); }
                }}
                disabled={busy === "sync"}
                title="Pull Gmail now — new mail plus past threads for this record's contacts"
                className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                {busy === "sync" ? "Syncing…" : "Sync mail"}
              </button>
              <button
                onClick={async () => {
                  const ok = await post("log-touch", { channel: outreachChannel === "linkedin" ? "linkedin" : "other", direction: "outbound", subject: activityTitle.trim() || undefined }, "touch");
                  if (ok) setActivityTitle("");
                }}
                disabled={busy === "touch"}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                Log outreach
              </button>
              <button
                onClick={async () => {
                  const ok = await post("log-touch", { channel: outreachChannel === "linkedin" ? "linkedin" : "other", direction: "inbound", subject: activityTitle.trim() || undefined }, "touch-in");
                  if (ok) setActivityTitle("");
                }}
                disabled={busy === "touch-in"}
                title="Records a reply received outside email — also flips the status to Awaiting Open ERP"
                className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                Log reply
              </button>
            </div>
          </div>
        )}

        {/* Direct adders */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setAddingTask(a => !a)}
            className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">
            + Task
          </button>
          {planButtons}
        </div>
      </div>

      {addingTask && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
          <input autoFocus value={newTask} onChange={e => setNewTask(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addTask(); }}
            placeholder="What needs doing?" className={D_INPUT + " flex-1 min-w-[180px]"} />
          <input type="date" value={newTaskDue} onChange={e => setNewTaskDue(e.target.value)}
            title="Due date" className={D_INPUT} />
          <QuietSelect value={newTaskAssignee || assignedTo || ""} onChange={setNewTaskAssignee}
            className="min-w-[130px]">
            <option value="">— Unassigned —</option>
            {assignableUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name}</option>)}
          </QuietSelect>
          <button onClick={addTask} disabled={busy === "task" || !newTask.trim()}
            className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
            {busy === "task" ? "Adding…" : "Add"}
          </button>
          <button onClick={() => { setAddingTask(false); setNewTask(""); }}
            className="text-[11px] px-2 py-1.5 text-zinc-400 hover:text-zinc-600">Cancel</button>
        </div>
      )}

      {/* Compose */}
      {composing && (
        <div className="mt-3 space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {mailboxes.length > 1 && (
              <QuietSelect value={senderId} onChange={v => setSenderId(v)} className="min-w-[150px]">
                {mailboxes.map(m => (
                  <option key={m.user_id} value={m.user_id}>From: {m.name}</option>
                ))}
              </QuietSelect>
            )}
            <QuietSelect value={toAddr} onChange={setTo} className="min-w-[180px]">
              {sendable.map(a => (
                <option key={a.address_id} value={a.email}>
                  {a.contact_name && !a.is_organizational ? `${a.contact_name} <${a.email}>` : a.email}
                </option>
              ))}
            </QuietSelect>
            <QuietSelect value={templateId} onChange={applyTemplate} className="min-w-[150px]">
              <option value="">— Template —</option>
              {templates.map(t => <option key={t.template_id} value={t.template_id}>{t.name}</option>)}
            </QuietSelect>
            <button onClick={tailorWithAI} disabled={busy === "draft" || (!subject && !bodyText)}
              title="Rewrite using what we know about this contact"
              className="ml-auto text-[11px] px-2 py-1 rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 hover:bg-violet-100 disabled:opacity-50">
              {busy === "draft" ? "Tailoring…" : "Tailor with AI"}
            </button>
          </div>
          {/* Cc — starts with the rest of the team already on it */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Cc</span>
            {cc.map(addr => (
              <span key={addr}
                className="inline-flex items-center gap-1 rounded-md bg-zinc-100 dark:bg-zinc-800 pl-2 pr-1 py-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                {addr}
                <button onClick={() => setCc(list => list.filter(x => x !== addr))}
                  title="Remove from Cc"
                  className="text-zinc-400 hover:text-red-500 px-0.5">✕</button>
              </span>
            ))}
            <input value={ccInput}
              onChange={e => setCcInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === "," || e.key === ";") { e.preventDefault(); addCc(ccInput); }
                if (e.key === "Backspace" && !ccInput) setCc(list => list.slice(0, -1));
              }}
              onBlur={() => addCc(ccInput)}
              placeholder={cc.length ? "Add another…" : "Add an address…"}
              className={D_INPUT + " flex-1 min-w-[140px]"} />
            {teamCc.length > 0 && !teamCc.every(e => cc.some(c => c.toLowerCase() === e.toLowerCase())) && (
              <button onClick={() => setCc(list => [...list, ...teamCc.filter(e => !list.some(c => c.toLowerCase() === e.toLowerCase()))])}
                title="Put the rest of the team back on Cc"
                className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400">+ team</button>
            )}
          </div>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject"
            className={D_INPUT + " w-full"} />
          {/* Sized to whatever is in it — a two-line note is a two-line box, a
              long email grows as it is written, and neither needs dragging. */}
          <AutoTextarea ref={bodyRef} value={bodyText} onChange={e => setBodyText(e.target.value)}
            placeholder="Write the email…" className={D_INPUT + " w-full resize-none overflow-hidden"} />

          {/* Signature — below the box, outside it, because that is where it
              lands in the sent email. Added automatically at send time, so it
              is shown rather than typed. */}
          {editingSig ? (
            <div className="space-y-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
              <AutoTextarea autoFocus value={sigDraft} onChange={e => setSigDraft(e.target.value)}
                rows={5} className={D_INPUT + " w-full resize-y font-mono text-[11px]"} />
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
                One line per line. <span className="font-mono">Label [https://…]</span> becomes a link.
                The Open ERP logo is added for you.
              </p>
              <div className="flex items-center gap-1.5">
                <button onClick={saveSignature} disabled={busy === "signature"}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
                  {busy === "signature" ? "Saving…" : "Save signature"}
                </button>
                <button onClick={() => setEditingSig(false)}
                  className="text-[11px] px-2 py-1.5 text-zinc-400 hover:text-zinc-600">Cancel</button>
              </div>
            </div>
          ) : sig?.preview_html ? (
            <div
              role={sig.editable ? "button" : undefined}
              tabIndex={sig.editable ? 0 : undefined}
              onClick={() => { if (sig.editable) { setSigDraft(sig.signature); setEditingSig(true); } }}
              onKeyDown={e => { if (sig.editable && (e.key === "Enter" || e.key === " ")) { setSigDraft(sig.signature); setEditingSig(true); } }}
              title={sig.editable
                ? "Your signature — click to edit"
                : `Sent from ${sig.owner_name ?? "the record owner"}'s mailbox, so it carries their signature`}
              className={`rounded-md px-2 py-1 ${sig.editable
                ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:ring-1 hover:ring-zinc-200 dark:hover:ring-zinc-700"
                : "opacity-80"}`}
              dangerouslySetInnerHTML={{ __html: sig.preview_html }} />
          ) : (
            <button onClick={() => { setSigDraft(""); setEditingSig(true); }}
              className="text-[11px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400">
              + Add a signature
            </button>
          )}
          {/* Attachments — pulled from Drive when the mail actually goes out,
              so a scheduled follow-up sends the current version of a deck. */}
          <div className="space-y-1.5">
            {attached.map(f => (
              <div key={f.id} className="flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1">
                <svg className="w-3 h-3 shrink-0 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                <span className="text-[11px] text-zinc-700 dark:text-zinc-300 truncate flex-1">{f.name}</span>
                <span className="text-[10px] text-zinc-400 shrink-0">
                  {library.some(d => d.id === f.id) ? "shared"
                    : f.source === "upload" ? "uploaded" : "Drive"}
                </span>
                {f.size && <span className="text-[10px] text-zinc-400 shrink-0">{Math.round(f.size / 1024)} KB</span>}
                <button onClick={() => setAttached(a => a.filter(x => x.id !== f.id))}
                  className="text-[10px] text-zinc-300 hover:text-red-500 shrink-0">✕</button>
              </div>
            ))}
            {/* One way in. What is already on the shelf comes first, since a
                document someone deliberately kept is the usual answer; Drive
                and the computer are the exceptions below it. */}
            {attachOpen ? (
              <div className="space-y-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2">
                {library.length > 0 && (
                  <div className="max-h-32 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                    {library.map(d => {
                      const already = attached.some(a => a.id === d.id);
                      return (
                        <button key={d.id} disabled={already}
                          onClick={() => {
                            setAttached(a => [...a, {
                              id: d.id, name: d.filename, mime_type: d.mime_type,
                              size: d.size, source: "upload" as const,
                            }]);
                            closeAttach();
                          }}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:hover:bg-transparent">
                          <span className="text-[11px] text-zinc-700 dark:text-zinc-300">{d.name}</span>
                          {d.size && <span className="text-[10px] text-zinc-400 ml-1.5">{Math.round(d.size / 1024)} KB</span>}
                          {already && <span className="text-[10px] text-zinc-400 ml-1.5">attached</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

                {drivePicker ? (
                  <div className="space-y-1.5">
                    <input autoFocus value={driveQuery}
                      onChange={e => { setDriveQuery(e.target.value); searchDrive(e.target.value); }}
                      placeholder="Search Drive…" className={D_INPUT + " w-full"} />
                    {driveHits.length > 0 && (
                      <div className="max-h-32 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                        {driveHits.map(f => (
                          <button key={f.id}
                            onClick={() => {
                              setAttached(a => a.some(x => x.id === f.id) ? a : [...a, f]);
                              closeAttach();
                            }}
                            className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                            <span className="text-[11px] text-zinc-700 dark:text-zinc-300">{f.name}</span>
                            {f.size && <span className="text-[10px] text-zinc-400 ml-1.5">{Math.round(f.size / 1024)} KB</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button onClick={() => setDrivePicker(true)}
                      className="text-[11px] px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                      Attach from Drive
                    </button>
                    <label className="text-[11px] px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer">
                      {busy === "upload" ? "Uploading…" : "Upload from computer"}
                      <input type="file" multiple className="hidden"
                        onChange={e => { uploadFiles(e.target.files); e.target.value = ""; }} />
                    </label>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 flex-1">
                    {library.length === 0 && "No saved documents yet. "}
                    Drive files and uploads are attached to this email only — add documents
                    for reuse in Email Template settings.
                  </p>
                  <button onClick={closeAttach}
                    className="text-[10px] text-zinc-400 hover:text-zinc-600 shrink-0">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAttachOpen(true)}
                className="text-[11px] px-2 py-1 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                + Attach document
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={sendNow} disabled={busy !== null || !toAddr || !subject}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy === "send" ? "Sending…" : "Send now"}
            </button>
            {schedulePicker ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1">
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Send on</span>
                <input type="datetime-local" autoFocus value={sendAt} min={toLocalInput(new Date())}
                  onChange={e => setSendAt(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") schedule(); if (e.key === "Escape") setSchedulePicker(false); }}
                  className={D_INPUT + " w-[11.75rem]"} />
                <button onClick={schedule} disabled={busy !== null || !toAddr || !subject}
                  className="text-[11px] px-2 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
                  {busy === "schedule" ? "Scheduling…" : "Schedule"}
                </button>
                <button onClick={() => setSchedulePicker(false)}
                  className="text-[11px] px-1 text-zinc-400 hover:text-zinc-600">✕</button>
              </span>
            ) : (
              <button onClick={() => setSchedulePicker(true)} disabled={busy !== null || !toAddr || !subject}
                title="Queue it — it goes out at the time you pick unless they reply first"
                className="text-[11px] px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40">
                {queuedId ? "Reschedule" : "Schedule"}
              </button>
            )}
            {/* Editing something already queued: saving belongs to that row, and
                turning it into a draft would quietly take it out of the queue. */}
            {queuedId ? (
              <button onClick={() => saveScheduled(false)} disabled={busy !== null || !toAddr || !subject}
                title="Save the changes; it still goes out when it was due"
                className="text-[11px] px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40">
                {busy === "save-queued" ? "Saving…" : "Save changes"}
              </button>
            ) : (
              /* Saving needs no recipient and no subject — an unfinished email is
                 the whole reason to save one. */
              <button onClick={saveDraft}
                disabled={busy !== null || (!subject && !bodyText.trim() && !toAddr)}
                title={draftId ? "Update the saved draft" : "Save this for later without sending it"}
                className="text-[11px] px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40">
                {busy === "save-draft" ? "Saving…" : draftId ? "Update draft" : "Save draft"}
              </button>
            )}
            <button onClick={sendTest} disabled={busy !== null || (!subject && !bodyText.trim())}
              title="Send this to your own inbox only — the recipient and anyone on Cc get nothing, and nothing is logged"
              className="text-[11px] px-3 py-1.5 rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 hover:bg-violet-100 disabled:opacity-40">
              {busy === "test" ? "Sending test…" : "Send test to me"}
            </button>
            <button onClick={() => { resetCompose(); setError(null); setNotice(null); }}
              className="text-[11px] px-2 py-1.5 text-zinc-400 hover:text-zinc-600">
              {draftId ? "Close" : "Cancel"}
            </button>
          </div>
          {draftId && (
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
              Editing a saved draft. Sending or scheduling it clears it from the draft list.
            </p>
          )}
          {queuedId && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400">
              Editing a queued email. Schedule moves it to a new day; Send now sends it
              immediately and takes it out of the queue.
            </p>
          )}
        </div>
      )}
    </DetailSection>
  );
}
