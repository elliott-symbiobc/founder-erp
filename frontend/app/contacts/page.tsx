"use client";

import { Suspense } from "react";
import { Avatar } from "@/components/Avatar";
import Link from "next/link";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenReminder {
  reminder_id: string;
  title: string;
  reminder_type: string;
  due_date: string | null;
}

interface OpenTask {
  task_id: string;
  title: string;
  source: string;
  due_date: string | null;
}

interface Contact {
  contact_id: string;
  name: string;
  email: string | null;
  organization: string | null;
  title: string | null;
  tags: string[];
  subject_areas: string[];
  avatar_url: string | null;
  last_interaction_at: string | null;
  pending_reminder_count: number;
  open_reminders: OpenReminder[];
  open_tasks: OpenTask[];
  ai_summary: string | null;
  tagline: string | null;
  company_id: string | null;
  company_name: string | null;
  is_project_primary: boolean;
}

interface LinkedProjectSummary {
  project_id: string;
  name: string;
  project_type: string;
  stage: string;
}

interface CompanyData {
  company_id: string;
  name: string;
  tags: string[];
  projects: LinkedProjectSummary[];
  description: string | null;
  logo_url: string | null;
}

interface GoogleStatus {
  connected: boolean;
  google_email?: string;
}

interface TagDef {
  name: string;
  color: string;
}

interface SyncStatus {
  total_contacts: number;
  contacts_with_email: number;
  contacts_with_interactions: number;
  total_interactions: number;
  emails: number;
  meetings: number;
  last_sync: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Mutable tag color registry — populated from API
const tagColorRegistry: Record<string, string> = {};

const COLOR_PRESETS = ["#6b7280","#3b82f6","#22c55e","#a855f7","#f59e0b","#14b8a6","#ef4444","#f97316","#ec4899","#0ea5e9","#84cc16","#8b5cf6"];

function tagColor(name: string): string {
  return tagColorRegistry[name.toLowerCase()] ?? "#6b7280";
}

// ── Inline Tag Editor ─────────────────────────────────────────────────────────

function InlineTagEditor({ contact, allTags, onUpdated }: {
  contact: Contact;
  allTags: TagDef[];
  onUpdated: (contactId: string, tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function patchTags(next: string[]) {
    setSaving(true);
    onUpdated(contact.contact_id, next); // optimistic
    await fetch(`/api/proxy/contacts/${contact.contact_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
    setSaving(false);
  }

  function toggleTag(name: string) {
    const curr = contact.tags ?? [];
    patchTags(curr.includes(name) ? curr.filter(t => t !== name) : [...curr, name]);
  }

  async function createAndAdd(name: string) {
    let trimmed = name.trim();
    if (!trimmed) return;
    if (!tagColorRegistry[trimmed.toLowerCase()]) {
      const r = await fetch("/api/proxy/contacts/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (r.ok) {
        const d = await r.json();
        tagColorRegistry[trimmed.toLowerCase()] = d.color;
        trimmed = d.name; // use canonical casing from server
      }
    }
    patchTags([...(contact.tags ?? []), trimmed]);
    setSearch("");
  }

  const [localColors, setLocalColors] = useState<Record<string, string>>({});

  async function updateTagColor(tagName: string, color: string) {
    tagColorRegistry[tagName.toLowerCase()] = color;
    setLocalColors(prev => ({ ...prev, [tagName.toLowerCase()]: color }));
    setColorPickerFor(null);
    await fetch(`/api/proxy/contacts/tags/${encodeURIComponent(tagName)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
  }

  function resolvedColor(name: string) {
    return localColors[name.toLowerCase()] ?? tagColor(name);
  }

  const filtered = allTags.filter(t =>
    !search || t.name.toLowerCase().includes(search.toLowerCase())
  );
  const currentTags = contact.tags ?? [];
  const noMatch = search.trim() && !allTags.some(t => t.name.toLowerCase() === search.trim().toLowerCase());

  return (
    <div className="relative" ref={ref} onClick={e => e.stopPropagation()}>
      {/* Tag pills + edit trigger */}
      <div
        className="flex flex-wrap gap-1 items-center min-h-[24px] cursor-pointer group/tags"
        onClick={() => { setOpen(o => !o); setSearch(""); }}
      >
        {currentTags.length > 0 ? (
          <>
            {currentTags.map(tag => {
              const c = resolvedColor(tag);
              return (
                <span key={tag}
                  title={tag}
                  className="text-[11px] px-1.5 py-0.5 rounded border font-medium leading-none max-w-full truncate"
                  style={{ backgroundColor: c + "22", color: c, borderColor: c + "55" }}
                >
                  {tag}
                </span>
              );
            })}
            <span className={`text-[10px] text-zinc-300 dark:text-zinc-600 transition-opacity ${saving ? "opacity-100 animate-pulse" : "opacity-0 group-hover/tags:opacity-100"}`}>
              {saving ? "saving…" : "edit"}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-zinc-300 dark:text-zinc-600 opacity-0 group-hover/tags:opacity-100 transition-opacity">
            + tag
          </span>
        )}
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-40 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-56 overflow-hidden">
          {/* Search/create input */}
          <div className="p-2 border-b border-zinc-100 dark:border-zinc-800">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && noMatch) createAndAdd(search);
                if (e.key === "Escape") { setOpen(false); setSearch(""); }
              }}
              placeholder="Search or create tag…"
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          </div>

          {/* Tag list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.map(tag => {
              const active = currentTags.includes(tag.name);
              const pickerOpen = colorPickerFor === tag.name;
              const dotColor = localColors[tag.name.toLowerCase()] ?? tag.color;
              return (
                <div key={tag.name}>
                  <div
                    className={`w-full flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${
                      active ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); setColorPickerFor(pickerOpen ? null : tag.name); }}
                      className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-offset-1 ring-zinc-300 dark:ring-zinc-600 hover:ring-blue-400 transition-all"
                      style={{ backgroundColor: dotColor }}
                      title="Change color"
                    />
                    <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300 text-xs" onClick={() => toggleTag(tag.name)}>{tag.name}</span>
                    {active && (
                      <svg className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" onClick={() => toggleTag(tag.name)}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  {pickerOpen && (
                    <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-1.5 bg-zinc-50 dark:bg-zinc-800/60 border-t border-zinc-100 dark:border-zinc-800">
                      {COLOR_PRESETS.map(c => (
                        <button type="button" key={c} onClick={() => updateTagColor(tag.name, c)}
                          className={`w-4 h-4 rounded-full hover:scale-125 transition-transform ${dotColor === c ? "ring-2 ring-offset-1 ring-zinc-600 dark:ring-zinc-300" : ""}`}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {noMatch && (
              <button
                onClick={() => createAndAdd(search)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create &ldquo;{search.trim()}&rdquo;
              </button>
            )}
            {filtered.length === 0 && !noMatch && (
              <p className="px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500 italic">No tags yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline Company Tag Editor ─────────────────────────────────────────────────

function InlineCompanyTagEditor({ company, allTags, onUpdated }: {
  company: CompanyData;
  allTags: TagDef[];
  onUpdated: (companyId: string, tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  async function patchTags(next: string[]) {
    setSaving(true);
    onUpdated(company.company_id, next);
    await fetch(`/api/proxy/contacts/companies/${company.company_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
    setSaving(false);
  }

  function toggleTag(name: string) {
    const curr = company.tags ?? [];
    patchTags(curr.includes(name) ? curr.filter(t => t !== name) : [...curr, name]);
  }

  async function createAndAdd(name: string) {
    let trimmed = name.trim();
    if (!trimmed) return;
    if (!tagColorRegistry[trimmed.toLowerCase()]) {
      const r = await fetch("/api/proxy/contacts/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (r.ok) {
        const d = await r.json();
        tagColorRegistry[trimmed.toLowerCase()] = d.color;
        trimmed = d.name;
      }
    }
    patchTags([...(company.tags ?? []), trimmed]);
    setSearch("");
  }

  const [localColors, setLocalColors] = useState<Record<string, string>>({});

  async function updateTagColor(tagName: string, color: string) {
    tagColorRegistry[tagName.toLowerCase()] = color;
    setLocalColors(prev => ({ ...prev, [tagName.toLowerCase()]: color }));
    setColorPickerFor(null);
    await fetch(`/api/proxy/contacts/tags/${encodeURIComponent(tagName)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
  }

  function resolvedColor(name: string) {
    return localColors[name.toLowerCase()] ?? tagColor(name);
  }

  const filtered = allTags.filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()));
  const currentTags = company.tags ?? [];
  const noMatch = search.trim() && !allTags.some(t => t.name.toLowerCase() === search.trim().toLowerCase());

  return (
    <div className="relative" ref={ref} onClick={e => e.stopPropagation()}>
      <div
        className="flex flex-wrap gap-1 items-center cursor-pointer group/ctags min-h-[18px]"
        onClick={() => { setOpen(o => !o); setSearch(""); }}
      >
        {currentTags.length > 0 ? (
          <>
            {currentTags.map(tag => {
              const c = resolvedColor(tag);
              return (
                <span key={tag}
                  title={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded border font-medium leading-none max-w-full truncate"
                  style={{ backgroundColor: c + "22", color: c, borderColor: c + "55" }}
                >
                  {tag}
                </span>
              );
            })}
            <span className={`text-[10px] text-zinc-300 dark:text-zinc-600 transition-opacity ${saving ? "opacity-100 animate-pulse" : "opacity-0 group-hover/ctags:opacity-100"}`}>
              {saving ? "…" : "edit"}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-zinc-300 dark:text-zinc-600 opacity-0 group-hover/ctags:opacity-100 transition-opacity">+ tag</span>
        )}
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-52 overflow-hidden">
          <div className="p-2 border-b border-zinc-100 dark:border-zinc-800">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && noMatch) createAndAdd(search);
                if (e.key === "Escape") { setOpen(false); setSearch(""); }
              }}
              placeholder="Search or create…"
              className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          </div>
          <div className="max-h-44 overflow-y-auto py-1">
            {filtered.map(tag => {
              const active = currentTags.includes(tag.name);
              const pickerOpen = colorPickerFor === tag.name;
              const dotColor = localColors[tag.name.toLowerCase()] ?? tag.color;
              return (
                <div key={tag.name}>
                  <div className={`w-full flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors ${active ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"}`}>
                    <button type="button"
                      onClick={e => { e.stopPropagation(); setColorPickerFor(pickerOpen ? null : tag.name); }}
                      className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-offset-1 ring-zinc-300 dark:ring-zinc-600 hover:ring-blue-400 transition-all"
                      style={{ backgroundColor: dotColor }}
                      title="Change color"
                    />
                    <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300 text-xs" onClick={() => toggleTag(tag.name)}>{tag.name}</span>
                    {active && <svg className="w-3 h-3 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" onClick={() => toggleTag(tag.name)}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                  </div>
                  {pickerOpen && (
                    <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-1.5 bg-zinc-50 dark:bg-zinc-800/60 border-t border-zinc-100 dark:border-zinc-800">
                      {COLOR_PRESETS.map(c => (
                        <button type="button" key={c} onClick={() => updateTagColor(tag.name, c)}
                          className={`w-4 h-4 rounded-full hover:scale-125 transition-transform ${dotColor === c ? "ring-2 ring-offset-1 ring-zinc-600 dark:ring-zinc-300" : ""}`}
                          style={{ backgroundColor: c }}
                          title={c}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {noMatch && (
              <button onClick={() => createAndAdd(search)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                Create &ldquo;{search.trim()}&rdquo;
              </button>
            )}
            {filtered.length === 0 && !noMatch && (
              <p className="px-3 py-2 text-xs text-zinc-400 italic">No tags yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Contact Card ──────────────────────────────────────────────────────────────

function ContactCard({ contact, allTags, onTagsUpdated, onArchived }: {
  contact: Contact;
  allTags: TagDef[];
  onTagsUpdated: (contactId: string, tags: string[]) => void;
  onArchived?: (contactId: string) => void;
}) {
  const openItems = (contact.open_tasks?.length ?? 0) + (contact.open_reminders?.length ?? 0);
  const hasTask = (contact.open_tasks?.length ?? 0) > 0;
  const router = useRouter();

  async function quickArchive(e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/proxy/contacts/${contact.contact_id}`, { method: "DELETE" });
    onArchived?.(contact.contact_id);
  }

  return (
    <div
      onClick={() => router.push(`/contacts/${contact.contact_id}`)}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group/card cursor-pointer relative"
    >
      {/* Avatar */}
      <div className="flex-shrink-0">
        <Avatar url={contact.avatar_url} name={contact.name} size={8} />
      </div>

      {/* Name + title — wrap to 2 lines; long unbroken strings (emails, URLs)
          break mid-word rather than spilling past the card edge. */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <p
            title={contact.name}
            className="text-sm font-medium text-zinc-800 dark:text-zinc-100 leading-tight break-words [overflow-wrap:anywhere] line-clamp-2 group-hover/card:text-blue-600 dark:group-hover/card:text-blue-400 transition-colors"
          >
            {contact.name}
          </p>
          {contact.is_project_primary && (
            <span className="flex-shrink-0 mt-px text-[9px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-semibold leading-none tracking-wide uppercase">
              Primary
            </span>
          )}
        </div>
        {contact.title && (
          <p
            title={contact.title}
            className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight mt-px break-words [overflow-wrap:anywhere] line-clamp-2"
          >
            {contact.title}
          </p>
        )}
        {/* Tags — only rendered when contact has tags (avoids blank whitespace) */}
        {(contact.tags?.length ?? 0) > 0 && (
          <div className="mt-1" onClick={e => e.stopPropagation()}>
            <InlineTagEditor contact={contact} allTags={allTags} onUpdated={onTagsUpdated} />
          </div>
        )}
      </div>

      {/* Right meta */}
      <div className="flex-shrink-0 flex flex-col items-end gap-1 max-w-[38%]">
        {openItems > 0 && (
          <span
            title={hasTask ? `${openItems} open task${openItems !== 1 ? "s" : ""}` : `${openItems} reminder${openItems !== 1 ? "s" : ""}`}
            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold leading-none ${
              hasTask
                ? "bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-300"
                : "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300"
            }`}>
            {openItems} {hasTask ? "task" : "reminder"}{openItems !== 1 ? "s" : ""}
          </span>
        )}
        {timeAgo(contact.last_interaction_at) && (
          <span className="text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
            {timeAgo(contact.last_interaction_at)}
          </span>
        )}
      </div>

      {/* Quick archive — appears on hover */}
      <button
        onClick={quickArchive}
        title="Archive contact"
        className="absolute top-1.5 right-1.5 opacity-0 group-hover/card:opacity-100 transition-opacity w-5 h-5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-500 flex items-center justify-center text-[10px] leading-none"
      >
        ✕
      </button>
    </div>
  );
}

// ── Company Group ─────────────────────────────────────────────────────────────

function CompanyRow({ org, contacts, companyId, companyData, allTags, onTagsUpdated, onCompanyUpdated, onArchived, onAddContact }: {
  org: string;
  contacts: Contact[];
  companyId: string | null;
  companyData: CompanyData | null;
  allTags: TagDef[];
  onTagsUpdated: (contactId: string, tags: string[]) => void;
  onCompanyUpdated: (companyId: string, patch: Partial<CompanyData>) => void;
  onArchived: (contactId: string) => void;
  onAddContact: (org: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [creating, setCreating] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!plusOpen) return;
    const h = (e: MouseEvent) => { if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [plusOpen]);

  const people = contacts;

  async function enrich(e: React.MouseEvent) {
    e.stopPropagation();
    // Enrich needs a company row to attach to. If this org isn't a company yet,
    // create it first (same path as openCompany), then enrich the new id.
    let id = companyId;
    setEnriching(true);
    setEnrichMsg(null);
    try {
      if (!id) {
        const cr = await fetch("/api/proxy/contacts/companies", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: org }),
        });
        if (!cr.ok) throw new Error("create failed");
        id = (await cr.json()).company_id;
      }
      const r = await fetch(`/api/proxy/contacts/companies/${id}/enrich`, { method: "POST" });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail?.detail ?? "Enrichment failed");
      }
      const d = await r.json();
      if (d.status === "no_data") {
        setEnrichMsg("No brand data found for this domain.");
      } else {
        onCompanyUpdated(id!, {
          logo_url: d.company?.logo_url ?? null,
          description: d.company?.description ?? null,
          tags: d.company?.tags ?? undefined,
        });
        const bits = [...(d.filled ?? [])].filter((f: string) => f !== "tags");
        setEnrichMsg(
          `Filled ${bits.length ? bits.join(", ") : "nothing new"}` +
          (d.added_tags?.length ? ` · +${d.added_tags.join(", ")}` : "")
        );
      }
    } catch (err) {
      setEnrichMsg(err instanceof Error ? err.message : "Enrichment failed");
    } finally {
      setEnriching(false);
    }
  }

  async function openCompany() {
    if (companyId) { router.push(`/contacts/companies/${companyId}`); return; }
    setCreating(true);
    const r = await fetch("/api/proxy/contacts/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: org }),
    });
    if (r.ok) {
      const d = await r.json();
      router.push(`/contacts/companies/${d.company_id}`);
    }
    setCreating(false);
  }

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-sm">
      {/* Company header — overflow-visible so tag dropdowns aren't clipped */}
      <div className="flex items-start gap-2.5 px-3 py-2 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-800 rounded-t-xl">
        {/* Initials badge */}
        <button onClick={() => setExpanded(e => !e)} className="flex-shrink-0">
          {companyData?.logo_url ? (
            <img
              src={companyData.logo_url}
              alt=""
              className="w-9 h-9 rounded-md object-contain bg-white shrink-0"
              // Brand data can go stale (a rebrand, a pulled asset). Fall back to
              // the initials tile rather than leaving a broken-image glyph.
              onError={(e) => { e.currentTarget.style.display = "none"; e.currentTarget.nextElementSibling?.classList.remove("hidden"); }}
            />
          ) : null}
          {/* 36px: the company badge heads a group whose contact avatars are 32px.
              At its old 24px the parent tile was smaller than its own children. */}
          <div className={`w-9 h-9 rounded-md bg-blue-600 flex items-center justify-center text-xs font-bold text-white select-none shrink-0 ${companyData?.logo_url ? "hidden" : ""}`}>
            {org.slice(0, 2).toUpperCase()}
          </div>
        </button>

        {/* Name — click to navigate */}
        <div className="flex-1 min-w-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={openCompany}
            disabled={creating}
            title={org}
            className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100 max-w-full text-left block leading-tight break-words [overflow-wrap:anywhere] line-clamp-2 hover:text-blue-600 dark:hover:text-blue-400 transition-colors disabled:opacity-50"
          >
            {creating ? "Creating…" : org}
          </button>

          {/* Company tags */}
          {companyId && companyData && (
            <InlineCompanyTagEditor company={companyData} allTags={allTags} onUpdated={(id, tags) => onCompanyUpdated(id, { tags })} />
          )}

          {/* Project links — visually distinct from tags */}
          {companyData?.projects?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800" onClick={e => e.stopPropagation()}>
              {companyData.projects.slice(0, 3).map(p => (
                <Link key={p.project_id} href={`/projects/${p.project_id}`}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors truncate max-w-[130px] min-w-0 font-medium"
                  title={p.name}>
                  <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                  {p.name}
                </Link>
              ))}
            </div>
          )}

          {/* Description */}
          {companyData?.description && (
            <p
              title={companyData.description}
              className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-snug mt-1 line-clamp-2 break-words [overflow-wrap:anywhere]"
            >
              {companyData.description}
            </p>
          )}

          {/* Enrichment feedback */}
          {enrichMsg && (
            <p className="text-[10px] text-violet-500 dark:text-violet-400 mt-1 leading-snug break-words [overflow-wrap:anywhere]" onClick={e => e.stopPropagation()}>
              {enrichMsg}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={enrich}
            disabled={enriching}
            className="w-5 h-5 rounded-full flex items-center justify-center text-zinc-400 hover:text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/40 transition-colors disabled:opacity-50"
            title="Auto-fill logo, description, industry & tags from the web"
          >
            {enriching ? (
              <span className="w-3 h-3 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
            ) : (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-6.714 2.143L12 21l-2.286-6.857L3 12l6.714-2.143L12 3z" />
              </svg>
            )}
          </button>
          {/* + menu: add a contact, or attach a CRM project / funding opportunity */}
          <div className="relative" ref={plusRef} onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setPlusOpen(o => !o)}
              className="w-5 h-5 rounded-full flex items-center justify-center text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/40 transition-colors"
              title="Add contact or attach a project"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
            {plusOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-44 py-1 overflow-hidden">
                <button
                  onClick={() => { setPlusOpen(false); onAddContact(org); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                  Add contact
                </button>
                <button
                  onClick={() => { setPlusOpen(false); setAttachOpen(true); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m6.828-6.828l3-3a4 4 0 015.656 5.656l-1.5 1.5" /></svg>
                  Attach project…
                </button>
              </div>
            )}
          </div>
          <button onClick={() => setExpanded(e => !e)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-150 ${expanded ? "" : "-rotate-90"}`}
              fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* People — overflow-hidden here clips hover backgrounds to rounded-b-xl */}
      {expanded && people.length > 0 && (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60 overflow-hidden rounded-b-xl">
          {people.map(c => (
            <ContactCard key={c.contact_id} contact={c} allTags={allTags} onTagsUpdated={onTagsUpdated} onArchived={onArchived} />
          ))}
        </div>
      )}
      {expanded && people.length === 0 && companyId && (
        <div className="px-4 py-3 text-[11px] text-zinc-400 dark:text-zinc-500 italic rounded-b-xl">
          <Link href={`/contacts/companies/${companyId}`} className="text-blue-500 hover:underline">View company →</Link>
        </div>
      )}
      {attachOpen && (
        <AttachProjectModal
          people={people}
          org={org}
          onClose={() => setAttachOpen(false)}
        />
      )}
    </div>
  );
}

// ── Attach a CRM project / funding opportunity to a contact ───────────────────

function AttachProjectModal({ people, org, onClose }: {
  people: Contact[];
  org: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ source: string; id: string; title: string; subtitle: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<{ source: string; id: string; title: string } | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Debounced search
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(async () => {
      const r = await fetch(`/api/proxy/contacts/attachables?q=${encodeURIComponent(q)}`);
      if (r.ok) setResults((await r.json()).results ?? []);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function attach(contactId: string, contactName: string) {
    if (!picked) return;
    setAttaching(contactId);
    const r = await fetch(`/api/proxy/contacts/${contactId}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: picked.source, id: picked.id }),
    });
    setAttaching(null);
    setDone(r.ok ? `Attached “${picked.title}” to ${contactName}` : "Attach failed");
    if (r.ok) setTimeout(onClose, 1100);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24 bg-black/20" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl flex flex-col max-h-[70vh]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {picked ? "Attach to which contact?" : `Attach project to ${org}`}
          </span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg leading-none">✕</button>
        </div>

        {done ? (
          <p className="px-4 py-6 text-sm text-center text-emerald-600 dark:text-emerald-400">{done}</p>
        ) : !picked ? (
          <>
            <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
              <input
                autoFocus
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search CRM projects & funding…"
                className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {loading && <p className="px-4 py-4 text-xs text-zinc-400 text-center">Searching…</p>}
              {!loading && results.length === 0 && <p className="px-4 py-4 text-xs text-zinc-400 text-center">No matches.</p>}
              {results.map(r => (
                <button
                  key={`${r.source}:${r.id}`}
                  onClick={() => setPicked(r)}
                  className="w-full text-left px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors border-b border-zinc-50 dark:border-zinc-800/40"
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                      r.source === "funding"
                        ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400"
                        : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400"
                    }`}>{r.source === "funding" ? "Funding" : "CRM"}</span>
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate">{r.title}</span>
                  </div>
                  {r.subtitle && <p className="text-[10px] text-zinc-400 mt-0.5 ml-[38px]">{r.subtitle}</p>}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
              <button onClick={() => setPicked(null)} className="text-xs text-zinc-400 hover:text-zinc-600">← back</button>
              <span className="text-xs text-zinc-500 truncate">{picked.title}</span>
            </div>
            <div className="overflow-y-auto flex-1">
              {people.length === 0 && <p className="px-4 py-4 text-xs text-zinc-400 text-center">No contacts in this company yet.</p>}
              {people.map(c => (
                <button
                  key={c.contact_id}
                  onClick={() => attach(c.contact_id, c.name)}
                  disabled={attaching !== null}
                  className="w-full text-left px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors border-b border-zinc-50 dark:border-zinc-800/40 flex items-center justify-between disabled:opacity-50"
                >
                  <div>
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{c.name}</span>
                    {c.title && <span className="text-[10px] text-zinc-400 ml-1.5">{c.title}</span>}
                  </div>
                  {attaching === c.contact_id && <span className="w-3 h-3 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Contact Suggestions ───────────────────────────────────────────────────────

interface ContactSuggestion {
  suggestion_id: string;
  suggestion_type: "new_contact" | "enrichment";
  // Set when the suggested email already belongs to a live contact — approving
  // merges into that contact rather than creating a second one.
  duplicate_of_contact_id?: string | null;
  duplicate_of_name?: string | null;
  status: "pending" | "approved" | "rejected";
  suggested_name: string | null;
  suggested_email: string | null;
  suggested_org: string | null;
  suggested_title: string | null;
  target_contact_id: string | null;
  target_contact_name: string | null;
  target_name: string | null;
  target_email: string | null;
  enrichment_fields: Record<string, string> | null;
  source_subject: string | null;
  source_from: string | null;
  reason: string | null;
  created_at?: string;
}

function SuggestionsLink({ onContactCreated }: { onContactCreated: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

  // On mount: load existing suggestions, auto-scan if last scan was >24h ago
  useEffect(() => {
    fetch("/api/proxy/contacts/suggestions")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setSuggestions(d.suggestions ?? []);
        setPendingCount(d.pending_count ?? 0);
        // Auto-scan if no suggestions exist or last one is older than 24h
        const newest = (d.suggestions ?? []).reduce((latest: number, s: ContactSuggestion) => {
          const t = new Date(s.created_at ?? 0).getTime();
          return t > latest ? t : latest;
        }, 0);
        const stale = Date.now() - newest > 24 * 60 * 60 * 1000;
        if (stale) scan();
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openModal() {
    setModalOpen(true);
    // Always refetch. Guarding on `suggestions.length === 0` meant a non-empty
    // list was never refreshed after mount, so the modal kept showing its
    // mount-time snapshot even as new scans landed.
    setLoading(true);
    const r = await fetch("/api/proxy/contacts/suggestions", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      setSuggestions(d.suggestions ?? []);
      setPendingCount(d.pending_count ?? 0);
    }
    setLoading(false);
  }

  async function scan() {
    setScanning(true);
    setScanMsg(null);
    const r = await fetch("/api/proxy/contacts/suggestions/scan");
    if (r.ok) {
      const d = await r.json();
      setSuggestions(d.suggestions ?? []);
      const pc = (d.suggestions ?? []).filter((s: ContactSuggestion) => s.status === "pending").length;
      setPendingCount(pc);
      setScanMsg(`Scanned ${d.emails_scanned ?? 0} emails · ${d.suggestions?.length ?? 0} suggestion${d.suggestions?.length !== 1 ? "s" : ""}`);
    } else {
      setScanMsg("Scan failed — make sure Google is connected.");
    }
    setScanning(false);
  }

  async function review(id: string, action: "approve" | "reject") {
    setReviewedIds(prev => new Set([...prev, id]));
    const r = await fetch(`/api/proxy/contacts/suggestions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (r.ok) {
      setSuggestions(prev => prev.map(s => s.suggestion_id === id ? { ...s, status: action === "approve" ? "approved" : "rejected" } : s));
      setPendingCount(prev => Math.max(0, (prev ?? 1) - 1));
      if (action === "approve") onContactCreated();
    } else {
      setReviewedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  const pending = suggestions.filter(s => s.status === "pending");

  return (
    <>
      <button
        onClick={openModal}
        className="text-violet-500 dark:text-violet-400 hover:text-violet-600 dark:hover:text-violet-300 transition-colors"
      >
        {pendingCount !== null && pendingCount > 0
          ? `Review ${pendingCount} suggested contact${pendingCount !== 1 ? "s" : ""}`
          : "Review suggested contacts"}
      </button>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-end p-4 pt-16 pointer-events-none">
          <div className="pointer-events-auto w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl flex flex-col max-h-[80vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Suggested Contacts</span>
                {pendingCount !== null && pendingCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 font-semibold leading-none">
                    {pendingCount}
                  </span>
                )}
              </div>
              <button onClick={() => setModalOpen(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg leading-none">✕</button>
            </div>

            {/* Scan bar */}
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
              <button onClick={scan} disabled={scanning}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 font-medium transition-colors">
                {scanning
                  ? <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  : <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                }
                {scanning ? "Scanning…" : "Scan emails"}
              </button>
              {scanMsg && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{scanMsg}</span>}
              {loading && <span className="text-[11px] text-zinc-400 animate-pulse">Loading…</span>}
            </div>

            {/* Suggestions */}
            <div className="flex-1 overflow-y-auto">
              {suggestions.length === 0 && !loading && !scanning && (
                <p className="px-4 py-8 text-xs text-zinc-400 text-center italic">
                  Scan your Gmail inbox to find new contacts and missing info for existing ones.
                </p>
              )}
              {pending.length > 0 && (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                  {pending.map(s => (
                    <SuggestionRow key={s.suggestion_id} s={s} onReview={review} processing={reviewedIds.has(s.suggestion_id)} />
                  ))}
                </div>
              )}
              {pending.length === 0 && suggestions.length > 0 && !scanning && (
                <p className="px-4 py-6 text-xs text-zinc-400 text-center">All caught up.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SuggestionRow({ s, onReview, processing, readonly }: {
  s: ContactSuggestion;
  onReview: (id: string, action: "approve" | "reject") => void;
  processing: boolean;
  readonly?: boolean;
}) {
  const isNew = s.suggestion_type === "new_contact";

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {/* Type badge */}
      <div className={`flex-shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${
        isNew ? "bg-emerald-100 dark:bg-emerald-900/40" : "bg-blue-100 dark:bg-blue-900/40"
      }`}>
        {isNew ? (
          <svg className="w-3 h-3 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        ) : (
          <svg className="w-3 h-3 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100">
            {isNew ? s.suggested_name : (s.target_contact_name ?? s.target_name)}
          </span>
          {isNew && s.suggested_email && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{s.suggested_email}</span>
          )}
          {isNew && s.suggested_org && (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{s.suggested_org}</span>
          )}
          {!isNew && s.enrichment_fields && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              +{Object.entries(s.enrichment_fields).map(([k, v]) => `${k}: ${v}`).join(", ")}
            </span>
          )}
        </div>
        {s.duplicate_of_contact_id && (
          <p className="mt-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
            ⚠ Already a contact{s.duplicate_of_name ? ` — ${s.duplicate_of_name}` : ""}. Approving fills in
            missing fields instead of adding a second one.
          </p>
        )}
        {s.reason && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-snug">{s.reason}</p>
        )}
        {s.source_subject && (
          <p className="text-[10px] text-zinc-300 dark:text-zinc-600 mt-0.5 truncate">
            via: {s.source_subject}
          </p>
        )}
      </div>

      {/* Actions */}
      {!readonly && s.status === "pending" && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => onReview(s.suggestion_id, "approve")}
            disabled={processing}
            className="text-[11px] px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 font-medium disabled:opacity-40 transition-colors"
          >
            {isNew ? "Add" : "Apply"}
          </button>
          <button
            onClick={() => onReview(s.suggestion_id, "reject")}
            disabled={processing}
            className="text-[11px] px-2 py-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
          >
            Skip
          </button>
        </div>
      )}
      {(readonly || s.status !== "pending") && (
        <span className={`text-[10px] flex-shrink-0 font-medium ${
          s.status === "approved" ? "text-emerald-500" : "text-zinc-400"
        }`}>
          {s.status === "approved" ? "✓ Added" : "✕ Skipped"}
        </span>
      )}
    </div>
  );
}

// ── Create Contact Modal ──────────────────────────────────────────────────────

function CreateModal({ onClose, onCreated, defaultOrg }: { onClose: () => void; onCreated: () => void; defaultOrg?: string }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", organization: defaultOrg ?? "", title: "", tags: "", notes: "", linkedin_url: "", website_url: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
        organization: form.organization || null,
        title: form.title || null,
        tags: form.tags ? form.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
        notes: form.notes || null,
        linkedin_url: form.linkedin_url || null,
        website_url: form.website_url || null,
      };
      const r = await fetch("/api/proxy/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const fields: { key: keyof typeof form; label: string; required?: boolean; hint?: string }[] = [
    { key: "name",         label: "Full Name",    required: true },
    { key: "email",        label: "Email" },
    { key: "phone",        label: "Phone" },
    { key: "organization", label: "Organization" },
    { key: "title",        label: "Title / Role" },
    { key: "tags",         label: "Tags",         hint: "comma-separated" },
    { key: "linkedin_url", label: "LinkedIn URL" },
    { key: "website_url",  label: "Website" },
    { key: "notes",        label: "Notes" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col border border-zinc-200 dark:border-zinc-700">
        <div className="px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add Contact</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg leading-none">✕</button>
        </div>
        <form onSubmit={submit} className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          {fields.map(({ key, label, required, hint }) => (
            <div key={key}>
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                {label}{required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              {key === "notes" ? (
                <AutoTextarea value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} rows={3}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              ) : (
                <input type="text" required={required} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              )}
              {hint && <p className="text-[11px] text-zinc-400 mt-0.5">{hint}</p>}
            </div>
          ))}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </form>
        <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
          <button onClick={() => document.querySelector("form")?.requestSubmit()} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium">
            {saving ? "Saving…" : "Add Contact"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function ContactsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [allTags, setAllTags] = useState<TagDef[]>([]);
  const [companyMap, setCompanyMap] = useState<Map<string, CompanyData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("last_interaction");
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const tagFilterRef = useRef<HTMLDivElement>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [addContactForOrg, setAddContactForOrg] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const hasAutoSynced = useRef(false);

  // Group contacts by organization; preserve API sort order for groups
  const { grouped, ungrouped } = useMemo(() => {
    const map = new Map<string, { contacts: Contact[]; company_id: string | null }>();
    const solo: Contact[] = [];
    for (const c of contacts) {
      const org = c.organization?.trim() ?? "";
      if (!org) { solo.push(c); continue; }
      if (!map.has(org)) map.set(org, { contacts: [], company_id: c.company_id });
      map.get(org)!.contacts.push(c);
      if (!map.get(org)!.company_id && c.company_id) map.get(org)!.company_id = c.company_id;
    }
    // Preserve insertion order (which reflects API sort) — don't re-sort alphabetically
    const groups = Array.from(map.entries())
      .map(([org, { contacts: cs, company_id }]) => ({ org, contacts: cs, company_id }));
    return { grouped: groups, ungrouped: solo };
  }, [contacts]);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (sort) params.set("sort", sort);
      if (filterTag) params.set("tags", filterTag);
      const r = await fetch(`/api/proxy/contacts?${params}`);
      if (r.ok) {
        const d = await r.json();
        setContacts(d.contacts ?? []);
      }
    } finally { setLoading(false); }
  }, [search, sort, filterTag]);

  const fetchTags = useCallback(async () => {
    const r = await fetch("/api/proxy/contacts/tags");
    if (r.ok) {
      const d = await r.json();
      if (d?.tags) {
        setAllTags(d.tags);
        d.tags.forEach((t: TagDef) => { tagColorRegistry[t.name.toLowerCase()] = t.color; });
      }
    }
  }, []);

  const fetchCompanies = useCallback(async () => {
    const r = await fetch("/api/proxy/contacts/companies");
    if (r.ok) {
      const d = await r.json();
      const map = new Map<string, CompanyData>();
      (d.companies ?? []).forEach((c: CompanyData) => map.set(c.company_id, c));
      setCompanyMap(map);
    }
  }, []);

  function handleCompanyUpdated(companyId: string, patch: Partial<CompanyData>) {
    setCompanyMap(prev => {
      const next = new Map(prev);
      const existing = next.get(companyId);
      if (existing) next.set(companyId, { ...existing, ...patch });
      return next;
    });
  }

  useEffect(() => {
    if (!sortOpen) return;
    function handler(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortOpen]);

  useEffect(() => {
    if (!tagFilterOpen) return;
    function handler(e: MouseEvent) {
      if (tagFilterRef.current && !tagFilterRef.current.contains(e.target as Node)) setTagFilterOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tagFilterOpen]);

  useEffect(() => { fetchContacts(); }, [fetchContacts]);
  useEffect(() => {
    fetchTags();
    fetchCompanies();
    fetch("/api/proxy/contacts/google/status").then(r => r.ok ? r.json() : null).then(d => { if (d) setGoogleStatus(d); });
    fetch("/api/proxy/contacts/google/sync-status").then(r => r.ok ? r.json() : null).then(d => { if (d) setSyncStatus(d); });
  }, [fetchTags, fetchCompanies]);

  // Auto-sync on load if connected and last sync was >4h ago (silent, no UI)
  useEffect(() => {
    if (googleStatus?.connected && syncStatus && !hasAutoSynced.current) {
      hasAutoSynced.current = true;
      const lastSync = syncStatus.last_sync ? new Date(syncStatus.last_sync).getTime() : 0;
      if (Date.now() - lastSync > 4 * 60 * 60 * 1000) {
        fetch("/api/proxy/contacts/google/sync", { method: "POST" })
          .then(r => r.ok ? setTimeout(fetchContacts, 8000) : null);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleStatus, syncStatus]);

  // Handle OAuth redirect
  useEffect(() => {
    if (searchParams.get("google_connected") || searchParams.get("google_error")) {
      fetch("/api/proxy/contacts/google/status").then(r => r.ok ? r.json() : null).then(d => { if (d) setGoogleStatus(d); });
      router.replace("/contacts");
    }
  }, [searchParams, router]);

  // Open create modal when ?create=1 in URL
  useEffect(() => {
    if (searchParams.get("create") === "1") {
      setShowCreate(true);
      router.replace("/contacts");
    }
  }, [searchParams, router]);

  function handleTagsUpdated(contactId: string, tags: string[]) {
    setContacts(prev => prev.map(c => c.contact_id === contactId ? { ...c, tags } : c));
  }

  function handleArchived(contactId: string) {
    setContacts(prev => prev.filter(c => c.contact_id !== contactId));
  }

  // "Name" sorts by company name: the browse view is grouped into company
  // cards, so ordering by contact name scattered the groups unintuitively.
  const SORT_OPTIONS = [
    { value: "last_interaction", label: "Recent" },
    { value: "name",             label: "Name" },
    { value: "created_at",       label: "Added" },
  ] as const;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400 pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Sort */}
        <div className="relative" ref={sortRef}>
          <button
            onClick={() => setSortOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
          >
            <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M6 12h12M9 17h6" />
            </svg>
            {SORT_OPTIONS.find(o => o.value === sort)?.label ?? "Sort"}
          </button>
          {sortOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-36 py-1 overflow-hidden">
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setSort(opt.value); setSortOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                    sort === opt.value
                      ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 font-medium"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tag filter */}
        <div className="relative" ref={tagFilterRef}>
          <button
            onClick={() => setTagFilterOpen(o => !o)}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              filterTag
                ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400"
                : "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600"
            }`}
          >
            {filterTag ? (
              <>
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: tagColor(filterTag) }} />
                {filterTag}
                <span onClick={e => { e.stopPropagation(); setFilterTag(null); }} className="ml-0.5 opacity-60 hover:opacity-100">✕</span>
              </>
            ) : (
              <>
                <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                Tag
              </>
            )}
          </button>
          {tagFilterOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl w-44 py-1 overflow-hidden">
              {filterTag && (
                <button onClick={() => { setFilterTag(null); setTagFilterOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 italic">
                  Clear filter
                </button>
              )}
              {allTags.map(t => (
                <button key={t.name} onClick={() => { setFilterTag(t.name); setTagFilterOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    filterTag === t.name
                      ? "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 font-medium"
                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                  }`}>
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} />
                  {t.name}
                </button>
              ))}
              {allTags.length === 0 && (
                <p className="px-3 py-2 text-xs text-zinc-400 italic">No tags yet</p>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Stats + suggestions link */}
      <div className="flex items-center gap-3 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span>{loading ? "Loading…" : `${contacts.length} contact${contacts.length !== 1 ? "s" : ""}${search || filterTag ? " (filtered)" : ""}`}</span>
        <SuggestionsLink onContactCreated={fetchContacts} />
      </div>

      {/* Content */}
      {loading ? (
        <div className="columns-1 sm:columns-2 xl:columns-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 animate-pulse mb-3 break-inside-avoid" />
          ))}
        </div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-20 text-zinc-400 dark:text-zinc-500">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="text-sm">No contacts found.</p>
          {!search && (
            <button onClick={() => setShowCreate(true)} className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">
              Add your first contact
            </button>
          )}
        </div>
      ) : (
        <div className="columns-1 sm:columns-2 xl:columns-3 gap-3">
          {grouped.map(({ org, contacts: grp, company_id }) => (
            <div key={org} className="break-inside-avoid mb-3">
              <CompanyRow
                org={org}
                contacts={grp}
                companyId={company_id}
                companyData={company_id ? (companyMap.get(company_id) ?? null) : null}
                allTags={allTags}
                onTagsUpdated={handleTagsUpdated}
                onCompanyUpdated={handleCompanyUpdated}
                onArchived={handleArchived}
                onAddContact={setAddContactForOrg}
              />
            </div>
          ))}
          {ungrouped.map(c => (
            <div key={c.contact_id} className="break-inside-avoid mb-3">
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-sm">
                <ContactCard contact={c} allTags={allTags} onTagsUpdated={handleTagsUpdated} onArchived={handleArchived} />
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreated={fetchContacts} />
      )}
      {addContactForOrg !== null && (
        <CreateModal
          defaultOrg={addContactForOrg}
          onClose={() => setAddContactForOrg(null)}
          onCreated={() => { fetchContacts(); setAddContactForOrg(null); }}
        />
      )}
    </div>
  );
}

export default function ContactsPage() {
  return (
    <Suspense>
      <ContactsPageContent />
    </Suspense>
  );
}
