"use client";

import { useEffect, useState, useCallback } from "react";
import { Avatar } from "@/components/Avatar";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { AutoTextarea } from "@/components/AutoTextarea";
interface CompanyContact {
  contact_id: string;
  name: string;
  email: string | null;
  title: string | null;
  tags: string[];
  avatar_url: string | null;
  last_interaction_at: string | null;
  tagline: string | null;
  open_reminders: number;
}

interface LinkedProject {
  project_id: string;
  name: string;
  project_type: string;
  stage: string;
  status: string;
}

interface Company {
  company_id: string;
  name: string;
  website_url: string | null;
  linkedin_url: string | null;
  logo_url: string | null;
  industry: string | null;
  company_size: string | null;
  company_type: string | null;
  company_location: string | null;
  description: string | null;
  esg_url: string | null;
  partnership_potential: string | null;
  regulatory_pressures: string[];
  government_incentives: string[];
  tags: string[];
  notes: string | null;
  enrichment_data: Record<string, unknown>;
  last_enriched_at: string | null;
  archived: boolean;
  contacts: CompanyContact[];
  projects: LinkedProject[];
}

function timeAgo(iso: string | null): string {
  if (!iso) return "No contact";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function stageColor(stage: string): string {
  const map: Record<string, string> = {
    lead: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    qualified: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    proposal: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400",
    negotiation: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
    won: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
    lost: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400",
  };
  return map[stage] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
}

// Ensure external links have a scheme; a bare domain would otherwise be
// treated as a relative path and navigate inside our own app.
function extUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, "")}`;
}

function EditableField({ label, value, onSave, multiline = false }: {
  label: string;
  value: string | null;
  onSave: (v: string | null) => Promise<void>;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(draft.trim() || null);
    setSaving(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">{label}</p>
        {multiline ? (
          <AutoTextarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
          />
        ) : (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        )}
        <div className="flex gap-2">
          <button onClick={save} disabled={saving} className="text-xs px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setDraft(value ?? ""); setEditing(true); }}
      className="w-full text-left group/field space-y-0.5"
    >
      <p className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm ${value ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-300 dark:text-zinc-600 italic"} group-hover/field:text-blue-600 dark:group-hover/field:text-blue-400 transition-colors`}>
        {value ?? "Click to add…"}
      </p>
    </button>
  );
}

export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [generatingDesc, setGeneratingDesc] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchCompany = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/proxy/contacts/companies/${id}`);
      if (!r.ok) throw new Error(r.status === 404 ? "Company not found" : "Failed to load");
      setCompany(await r.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchCompany(); }, [fetchCompany]);

  useEffect(() => { setDescDraft(company?.description ?? ""); }, [company?.description]);

  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/proxy/contacts/companies/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    fetchCompany();
  }

  async function deleteCompany() {
    const r = await fetch(`/api/proxy/contacts/companies/${id}/permanent`, { method: "DELETE" });
    if (r.ok) router.push("/contacts");
    else setConfirmDelete(false);
  }

  async function generateDescription() {
    setGeneratingDesc(true);
    try {
      const r = await fetch(`/api/proxy/contacts/companies/${id}/generate-description`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setDescDraft(d.description ?? "");
        await patch({ description: d.description });
      }
    } finally {
      setGeneratingDesc(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 max-w-5xl">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-zinc-200 dark:border-zinc-800 animate-pulse bg-zinc-50 dark:bg-zinc-900" />
        ))}
      </div>
    );
  }

  if (error || !company) {
    return (
      <div className="text-center py-20 text-zinc-400">
        <p className="text-sm">{error ?? "Company not found"}</p>
        <Link href="/contacts" className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">← Back to contacts</Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
          <Link href="/contacts" className="hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">Contacts</Link>
          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-zinc-700 dark:text-zinc-300 font-medium">{company.name}</span>
        </div>
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-500">Delete company? Contacts will be kept.</span>
            <button onClick={deleteCompany} className="text-xs px-2.5 py-1 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium">Confirm</button>
            <button onClick={() => setConfirmDelete(false)} className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}
            className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete company
          </button>
        )}
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* ── Left: Company info ── */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          {/* Header card */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5 space-y-4">
            {/* Logo / initials + name */}
            <div className="flex items-center gap-3">
              {company.logo_url ? (
                <img src={company.logo_url} alt={company.name} className="w-12 h-12 rounded-xl object-cover" />
              ) : (
                <div className="w-12 h-12 rounded-xl bg-gray-700 dark:bg-gray-600 flex items-center justify-center text-white text-lg font-bold select-none">
                  {company.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div>
                <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{company.name}</h1>
                {company.industry && <p className="text-xs text-zinc-400 dark:text-zinc-500">{company.industry}</p>}
                {company.company_location && <p className="text-xs text-zinc-400 dark:text-zinc-500">{company.company_location}</p>}
              </div>
            </div>

            {company.description && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed line-clamp-2">
                {company.description}
              </p>
            )}

            {/* Project / CRM quick-links — grouped by type */}
            {(company.projects?.length ?? 0) > 0 && (() => {
              const byType: Record<string, typeof company.projects> = {};
              company.projects.forEach(p => {
                const t = p.project_type ?? "other";
                (byType[t] = byType[t] ?? []).push(p);
              });
              const typeLabel: Record<string, string> = {
                crm_opportunity: "CRM",
                partnership: "Partnership",
                portfolio: "Portfolio",
                grant: "Grant",
                internal: "Ops",
                marketing: "Marketing",
              };
              return (
                <div className="space-y-1.5">
                  {Object.entries(byType).map(([type, projects]) => (
                    <div key={type}>
                      <p className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">
                        {typeLabel[type] ?? type.replace(/_/g, " ")}
                      </p>
                      <div className="flex flex-col gap-1">
                        {projects.map(p => (
                          <Link key={p.project_id} href={`/projects/${p.project_id}`}
                            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 border border-zinc-200 dark:border-zinc-700 hover:border-blue-200 dark:hover:border-blue-800 transition-colors group/proj">
                            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate group-hover/proj:text-blue-600 dark:group-hover/proj:text-blue-400 transition-colors">
                              {p.name}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${stageColor(p.stage)}`}>
                              {p.stage}
                            </span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* External links */}
            <div className="flex flex-wrap gap-2">
              {company.website_url && (
                <a href={extUrl(company.website_url)} target="_blank" rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                  Website ↗
                </a>
              )}
              {company.linkedin_url && (
                <a href={extUrl(company.linkedin_url)} target="_blank" rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors">
                  LinkedIn ↗
                </a>
              )}
              {company.esg_url && (
                <a href={extUrl(company.esg_url)} target="_blank" rel="noopener noreferrer"
                  className="text-xs px-2.5 py-1 rounded-lg border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950 transition-colors">
                  ESG Report ↗
                </a>
              )}
            </div>

            {/* Editable fields */}
            <div className="space-y-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <EditableField label="Name" value={company.name} onSave={v => patch({ name: v ?? company.name })} />
              <EditableField label="Website" value={company.website_url} onSave={v => patch({ website_url: v })} />
              <EditableField label="LinkedIn" value={company.linkedin_url} onSave={v => patch({ linkedin_url: v })} />
              <EditableField label="Industry" value={company.industry} onSave={v => patch({ industry: v })} />
              <EditableField label="Size" value={company.company_size} onSave={v => patch({ company_size: v })} />
              <EditableField label="Type" value={company.company_type} onSave={v => patch({ company_type: v })} />
              <EditableField label="Location" value={company.company_location} onSave={v => patch({ company_location: v })} />
              <EditableField label="Partnership Potential" value={company.partnership_potential} onSave={v => patch({ partnership_potential: v })} multiline />
              <EditableField label="Notes" value={company.notes} onSave={v => patch({ notes: v })} multiline />
            </div>
          </div>

          {/* Regulatory pressures */}
          {company.regulatory_pressures?.length > 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Regulatory Pressures</p>
              <div className="flex flex-wrap gap-1.5">
                {company.regulatory_pressures.map((r, i) => (
                  <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">{r}</span>
                ))}
              </div>
            </div>
          )}

          {/* Government incentives */}
          {company.government_incentives?.length > 0 && (
            <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Government Incentives</p>
              <div className="flex flex-wrap gap-1.5">
                {company.government_incentives.map((g, i) => (
                  <span key={i} className="text-[11px] px-2 py-0.5 rounded bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">{g}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Center: Description + Projects ── */}
        <div className="col-span-12 lg:col-span-5 space-y-4">
          {/* Description */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">About</p>
              <button onClick={generateDescription} disabled={generatingDesc}
                className="text-xs text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 flex items-center gap-1 transition-colors">
                {generatingDesc ? (
                  <><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>Generating…</>
                ) : descDraft ? "↺ Regenerate" : "✦ Generate"}
              </button>
            </div>
            {editingDesc ? (
              <AutoTextarea autoFocus value={descDraft} onChange={e => setDescDraft(e.target.value)}
                onBlur={() => { setEditingDesc(false); if (descDraft !== (company.description ?? "")) patch({ description: descDraft || null }); }}
                rows={5}
                className="w-full text-sm text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
            ) : descDraft ? (
              <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed cursor-text hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                onClick={() => setEditingDesc(true)}>{descDraft}</p>
            ) : (
              <p className="text-sm text-zinc-400 dark:text-zinc-500 italic cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors"
                onClick={() => setEditingDesc(true)}>Click to write a description, or use ✦ Generate to auto-fill with AI.</p>
            )}
          </div>

          {/* Linked projects */}
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
            <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              Projects ({company.projects?.length ?? 0})
            </p>
            {!company.projects?.length ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No linked projects.</p>
            ) : (
              <div className="space-y-2">
                {company.projects.map(p => (
                  <Link key={p.project_id} href={`/projects/${p.project_id}`}
                    className="flex items-center justify-between gap-3 p-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors group/proj">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate group-hover/proj:text-blue-600 dark:group-hover/proj:text-blue-400 transition-colors">
                        {p.name}
                      </p>
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 capitalize">{p.project_type?.replace(/_/g, " ")}</p>
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded font-medium flex-shrink-0 ${stageColor(p.stage)}`}>
                      {p.stage}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: People ── */}
        <div className="col-span-12 lg:col-span-3 space-y-4">
          <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
            <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              People ({company.contacts?.length ?? 0})
            </p>
            {!company.contacts?.length ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No contacts linked to this company.</p>
            ) : (
              <div className="space-y-2.5">
                {company.contacts.map(c => (
                  <Link key={c.contact_id} href={`/contacts/${c.contact_id}`}
                    className="flex items-center gap-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg p-1.5 -mx-1.5 transition-colors group/person">
                    <div className="flex-shrink-0">
                      <Avatar url={c.avatar_url} name={c.name} size={8} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate group-hover/person:text-blue-600 dark:group-hover/person:text-blue-400 transition-colors">
                        {c.name}
                      </p>
                      {c.title && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{c.title}</p>}
                    </div>
                    {c.open_reminders > 0 && (
                      <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-semibold">
                        {c.open_reminders}
                      </span>
                    )}
                    <span className="flex-shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">
                      {timeAgo(c.last_interaction_at)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
