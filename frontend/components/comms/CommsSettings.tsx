"use client";

// Entity-generic comms settings: email templates (scoped) + shared document
// library. Extracted from the investor board's settings so both stay identical,
// then parameterised by `scope` so the CRM manages its own deal templates while
// sharing the same document shelf and signature.

import React, { useState, useEffect, useCallback } from "react";
import { AutoTextarea } from "@/components/AutoTextarea";


// ── Types ────────────────────────────────────────────────────────────────────
type Attachment = {
  id: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  /** 'drive' pulls at send time; 'upload' came off a computer. */
  source?: "drive" | "upload";
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

// ── Shared styles / helpers ─────────────────────────────────────────────────
const SETTINGS_INPUT = "w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/30";
function StyledSelect({
  className = "", children, ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const fullWidth = className.includes("w-full");
  return (
    <div className={`relative ${fullWidth ? "block w-full" : "inline-block"}`}>
      <select {...rest} className={`${className} appearance-none pr-8 ${rest.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
        {children}
      </select>
      <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

// ── Template attachment picker ──────────────────────────────────────────────
function TemplateAttachments({ picked, library, onChange }: {
  picked: Attachment[];
  library: LibraryDoc[];
  onChange: (next: Attachment[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const available = library.filter(d => !picked.some(p => p.id === d.id));

  return (
    <div className="space-y-1.5">
      {picked.map(f => (
        <div key={f.id} className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-white/10 px-2 py-1">
          <span className="text-[11px] text-gray-700 dark:text-gray-300 truncate flex-1">{f.name}</span>
          {f.size && <span className="text-[10px] text-gray-400 shrink-0">{Math.round(f.size / 1024)} KB</span>}
          <button onClick={() => onChange(picked.filter(x => x.id !== f.id))}
            className="text-[10px] text-gray-300 hover:text-red-500 shrink-0">✕</button>
        </div>
      ))}

      {adding && available.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
          {available.map(d => (
            <button key={d.id}
              onClick={() => {
                onChange([...picked, {
                  id: d.id, name: d.filename, mime_type: d.mime_type,
                  size: d.size, source: "upload" as const,
                }]);
                setAdding(false);
              }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              <span className="text-[11px] text-gray-700 dark:text-gray-300">{d.name}</span>
              {d.size && <span className="text-[10px] text-gray-400 ml-1.5">{Math.round(d.size / 1024)} KB</span>}
            </button>
          ))}
        </div>
      )}

      {library.length === 0 ? (
        <p className="text-[10px] text-gray-400">
          Upload something under Shared documents below to attach it to a template.
        </p>
      ) : available.length > 0 ? (
        <button onClick={() => setAdding(v => !v)}
          className="text-[11px] px-2 py-1 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
          {adding ? "Cancel" : "+ Attach document"}
        </button>
      ) : null}
    </div>
  );
}

// ── Shared documents shelf ──────────────────────────────────────────────────
function SharedDocuments() {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");

  const load = useCallback(() => {
    fetch("/api/proxy/comms/library").then(r => r.json()).then(setDocs).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const r = await fetch("/api/proxy/comms/library", { method: "POST", body: form });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          setError(typeof e.detail === "string" ? e.detail : `Could not upload ${file.name}.`);
        }
      }
      load();
    } finally { setBusy(false); }
  }

  async function rename(id: string) {
    await fetch(`/api/proxy/comms/library/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: renameTo }),
    });
    setRenaming(null); load();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove "${name}" from shared documents?`)) return;
    const r = await fetch(`/api/proxy/comms/library/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      // 409: something queued still attaches it, so deleting would break a send.
      setError(typeof e.detail === "string" ? e.detail : "Could not remove that document.");
      return;
    }
    setError(null); load();
  }

  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Shared documents</p>
      <p className="text-[10px] text-gray-400">
        Available as attachments in every email composer. Renaming changes only the name
        shown here — recipients still see the original filename.
      </p>

      {docs.map(d => (
        <div key={d.id} className="group flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1.5">
          {renaming === d.id ? (
            <>
              <input autoFocus value={renameTo} onChange={e => setRenameTo(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") rename(d.id); if (e.key === "Escape") setRenaming(null); }}
                className={SETTINGS_INPUT + " flex-1"} />
              <button onClick={() => rename(d.id)}
                className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Save</button>
              <button onClick={() => setRenaming(null)}
                className="text-[11px] px-1 text-gray-400 hover:text-gray-600">Cancel</button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-gray-700 dark:text-gray-300 truncate">{d.name}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  {d.filename}
                  {d.size ? ` · ${Math.round(d.size / 1024)} KB` : ""}
                  {d.uploaded_by ? ` · ${d.uploaded_by}` : ""}
                </p>
              </div>
              <button onClick={() => { setRenaming(d.id); setRenameTo(d.name); }}
                className="shrink-0 text-[10px] text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">Rename</button>
              <button onClick={() => remove(d.id, d.name)}
                className="shrink-0 text-[10px] text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
            </>
          )}
        </div>
      ))}

      {error && (
        <p className="rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}

      <label className="block w-full text-center text-[11px] px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer">
        {busy ? "Uploading…" : "+ Upload document"}
        <input type="file" multiple className="hidden"
          onChange={e => { upload(e.target.files); e.target.value = ""; }} />
      </label>
    </div>
  );
}

// ── Email templates settings (scoped) ───────────────────────────────────────
/** Your sign-off, editable here as well as from the composer. PUT
 *  /comms/signature only ever writes your own, so this is a second door to one
 *  setting — the same signature the investor board edits. */
type Signature = {
  signature: string;
  preview_html: string;
  editable: boolean;
  owner_name: string | null;
};

function SignatureSettings() {
  const [sig, setSig] = useState<Signature | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/proxy/comms/signature")
      .then(r => (r.ok ? r.json() : null)).then(setSig).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/proxy/comms/signature", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: draft }),
      });
      if (!r.ok) { setError("Could not save your signature."); return; }
      setSig(await r.json());
      setEditing(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Email signature</p>
      <p className="text-[10px] text-gray-400">
        Added to the bottom of every email you send from here. Yours alone — emails sent
        from someone else&apos;s mailbox carry theirs.
      </p>

      {editing ? (
        <div className="space-y-1.5 rounded-lg border border-gray-200 dark:border-white/10 p-2.5">
          <AutoTextarea autoFocus value={draft} onChange={e => setDraft(e.target.value)}
            rows={5} className={SETTINGS_INPUT + " w-full resize-y font-mono text-[11px]"} />
          <p className="text-[10px] text-gray-400">
            One line per line. <span className="font-mono">Label [https://…]</span> becomes a link.
            The Open ERP logo is added for you.
          </p>
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={busy}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy ? "Saving…" : "Save signature"}
            </button>
            <button onClick={() => setEditing(false)}
              className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-2 space-y-2">
          {sig?.preview_html ? (
            <div className="text-[11px]" dangerouslySetInnerHTML={{ __html: sig.preview_html }} />
          ) : (
            <p className="text-[11px] text-gray-400">No signature yet.</p>
          )}
          <button onClick={() => { setDraft(sig?.signature ?? ""); setEditing(true); }}
            className="text-[10px] text-gray-400 hover:text-blue-600">
            {sig?.preview_html ? "Edit signature" : "+ Add a signature"}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}
    </div>
  );
}


export function CommsSettings({ scope = "deal" }: { scope?: string }) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<EmailTemplate>>({});
  const [busy, setBusy] = useState(false);

  const [library, setLibrary] = useState<LibraryDoc[]>([]);

  const load = useCallback(() => {
    fetch(`/api/proxy/comms/templates?scope=${scope}`)
      .then(r => r.json()).then(setTemplates).catch(() => {});
  }, []);
  const loadLibrary = useCallback(() => {
    fetch("/api/proxy/comms/library").then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  function startNew() {
    setEditing("new");
    setDraft({ name: "", kind: "outreach", subject: "", body: "", default_delay_days: null, attachments: [] });
  }

  function startEdit(t: EmailTemplate) {
    setEditing(t.template_id);
    setDraft({ ...t });
  }

  async function save() {
    if (!draft.name?.trim()) return;
    setBusy(true);
    try {
      const isNew = editing === "new";
      await fetch(`/api/proxy/comms/templates${isNew ? "" : `/${editing}`}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name, kind: draft.kind ?? "outreach", scope,
          subject: draft.subject ?? "", body: draft.body ?? "",
          default_delay_days: draft.default_delay_days || null,
          attachments: draft.attachments ?? [],
        }),
      });
      setEditing(null);
      load();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Delete this template?")) return;
    await fetch(`/api/proxy/comms/templates/${id}`, { method: "DELETE" });
    load();
  }


  return (
    <div className="px-4 pb-4 pt-3 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] text-gray-400">
        Templates are a starting point — the composer&apos;s &ldquo;Rewrite&rdquo; button tailors the
        draft for the specific contact before it goes out. Attach shared documents so they
        ride along whenever the template is picked.
      </p>

      {templates.map(t => (
        <div key={t.template_id} className="border border-gray-200 dark:border-white/10 rounded-lg">
          {editing === t.template_id ? (
            <div className="p-3 space-y-2">
              <div className="flex gap-2">
                <input value={draft.name ?? ""} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  placeholder="Template name" className={SETTINGS_INPUT} />
                <StyledSelect value={draft.kind ?? "outreach"}
                  onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}
                  className={SETTINGS_INPUT + " w-36"}>
                  <option value="outreach">Outreach</option>
                  <option value="follow_up">Follow-up</option>
                </StyledSelect>
                <input type="number" min={1} max={90} value={draft.default_delay_days ?? ""}
                  onChange={e => setDraft(d => ({ ...d, default_delay_days: e.target.value ? Number(e.target.value) : null }))}
                  placeholder="Delay" title="Default days to wait when queued as a follow-up"
                  className={SETTINGS_INPUT + " w-20"} />
              </div>
              <input value={draft.subject ?? ""} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
                placeholder="Subject" className={SETTINGS_INPUT} />
              <AutoTextarea value={draft.body ?? ""} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
                rows={7} placeholder="Body" className={SETTINGS_INPUT + " resize-y"} />
              <TemplateAttachments picked={draft.attachments ?? []} library={library}
                onChange={next => setDraft(d => ({ ...d, attachments: next }))} />
              <div className="flex items-center gap-1.5">
                <button onClick={save} disabled={busy || !draft.name?.trim()}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">Save</button>
                <button onClick={() => setEditing(null)}
                  className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                t.kind === "follow_up"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              }`}>{t.kind === "follow_up" ? "Follow-up" : "Outreach"}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{t.name}</p>
                <p className="text-[11px] text-gray-400 truncate">{t.subject || "No subject"}</p>
              </div>
              {(t.attachments?.length ?? 0) > 0 && (
                <span className="text-[10px] text-gray-400 shrink-0"
                  title={t.attachments.map(f => f.name).join(", ")}>
                  📎 {t.attachments.length}
                </span>
              )}
              {t.default_delay_days && (
                <span className="text-[10px] text-gray-400 shrink-0">{t.default_delay_days}d</span>
              )}
              <button onClick={() => startEdit(t)}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline shrink-0">Edit</button>
              <button onClick={() => remove(t.template_id)}
                className="text-[11px] text-gray-400 hover:text-red-500 shrink-0">Delete</button>
            </div>
          )}
        </div>
      ))}

      {editing === "new" ? (
        <div className="border border-gray-200 dark:border-white/10 rounded-lg p-3 space-y-2">
          <div className="flex gap-2">
            <input autoFocus value={draft.name ?? ""} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              placeholder="Template name" className={SETTINGS_INPUT} />
            <StyledSelect value={draft.kind ?? "outreach"}
              onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}
              className={SETTINGS_INPUT + " w-36"}>
              <option value="outreach">Outreach</option>
              <option value="follow_up">Follow-up</option>
            </StyledSelect>
            <input type="number" min={1} max={90} value={draft.default_delay_days ?? ""}
              onChange={e => setDraft(d => ({ ...d, default_delay_days: e.target.value ? Number(e.target.value) : null }))}
              placeholder="Delay" title="Default days to wait when queued as a follow-up"
              className={SETTINGS_INPUT + " w-20"} />
          </div>
          <input value={draft.subject ?? ""} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
            placeholder="Subject" className={SETTINGS_INPUT} />
          <AutoTextarea value={draft.body ?? ""} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            rows={7} placeholder="Body" className={SETTINGS_INPUT + " resize-y"} />
          <TemplateAttachments picked={draft.attachments ?? []} library={library}
            onChange={next => setDraft(d => ({ ...d, attachments: next }))} />
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={busy || !draft.name?.trim()}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">Save</button>
            <button onClick={() => setEditing(null)}
              className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={startNew}
          className="w-full text-[11px] px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          + Add template
        </button>
      )}

      <SignatureSettings />
      <SharedDocuments />
    </div>
  );
}
