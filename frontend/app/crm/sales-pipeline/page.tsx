"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "leads" | "agents";

interface System {
  id: string;
  name: string;
  spreadsheet_id: string | null;
  description: string | null;
}

interface TraceStep {
  type: "info" | "thinking" | "tool_call" | "tool_result" | "save" | "error" | "done";
  ts: string;
  content: string;
  raw_command?: string;
  contacts?: { name?: string; title?: string; email?: string }[];
  company_fields?: string[];
}

interface Contact {
  name: string;
  title?: string;
  seniority?: string;
  department?: string;
  email?: string;
  email_status?: string;
  phone?: string;
  linkedin?: string;
}

interface Lead {
  id: string;
  company: string;
  priority: string | null;
  priority_score: number | null;
  reach_out_status: string | null;
  mutual_connection: string | null;
  recommended_action: string | null;
  notes: string | null;
  contacts: Contact[];
  website: string | null;
  tier_size: string | null;
  region: string | null;
  city: string | null;
  address: string | null;
  key_products: string | null;
  est_revenue: string | null;
  org_fit: string | null;
  industry: string | null;
  description: string | null;
  employee_count: number | null;
  founded_year: number | null;
  company_linkedin: string | null;
  technologies: string[];
  source: string;
  enrichment_status: string | null;
  enrichment_notes: string | null;
  field_sources?: Record<string, string>;
  score_breakdown?: Record<string, any>;
}

interface IcpProfile {
  company_url?: string;
  product_description?: string;
  price_point?: string;
  current_customers: string[];
  competitors: string[];
  target_titles: string[];
  target_seniority: string[];
  company_size_min?: number | null;
  company_size_max?: number | null;
  target_industries: string[];
  target_regions: string[];
  signals: string[];
  exclude_titles: string[];
  exclude_industries: string[];
  exclude_company_types: string[];
  exclude_company_size_min?: number | null;
  exclude_company_size_max?: number | null;
  exclude_companies: string[];
}

const EMPTY: IcpProfile = {
  company_url: "",
  product_description: "",
  price_point: "",
  current_customers: [],
  competitors: [],
  target_titles: [],
  target_seniority: [],
  company_size_min: null,
  company_size_max: null,
  target_industries: [],
  target_regions: [],
  signals: [],
  exclude_titles: [],
  exclude_industries: [],
  exclude_company_types: [],
  exclude_company_size_min: null,
  exclude_company_size_max: null,
  exclude_companies: [],
};

const TAB_CONFIG: { key: Tab; label: string }[] = [
  { key: "leads",  label: "Leads" },
  { key: "agents", label: "Agents" },
];

// ── Tag input ─────────────────────────────────────────────────────────────────

function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function add() {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput("");
  }

  function remove(i: number) {
    onChange(values.filter((_, idx) => idx !== i));
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 min-h-[38px] px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {values.map((v, i) => (
        <span
          key={i}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-xs font-medium"
        >
          {v}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); remove(i); }}
            className="hover:text-blue-900 dark:hover:text-blue-100 leading-none"
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !input && values.length) remove(values.length - 1);
        }}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] text-xs bg-transparent outline-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500"
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-4 items-start">
      <div className="pt-1.5">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p>
        {hint && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

// ── Priority badge ────────────────────────────────────────────────────────────

const PRIORITY_STYLES: Record<string, string> = {
  IMMEDIATE: "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300",
  HIGH:      "bg-orange-50 dark:bg-orange-950 text-orange-700 dark:text-orange-300",
  MEDIUM:    "bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300",
};

function PriorityBadge({ priority }: { priority: string | null }) {
  if (!priority) return null;
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${PRIORITY_STYLES[priority] ?? "bg-gray-100 dark:bg-white/10 text-gray-500"}`}>
      {priority}
    </span>
  );
}

// ── Lead detail drawer ────────────────────────────────────────────────────────

const REACH_OUT_OPTIONS = ["", "Reached Out", "In Conversation", "Qualified", "Not a Fit"];
const PRIORITY_OPTIONS  = ["", "IMMEDIATE", "HIGH", "MEDIUM"];

const iCls = "w-full px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40";
const tCls = `${iCls} resize-none`;

// Score colour: 0–39 gray, 40–59 yellow, 60–79 blue, 80+ green
function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const cls = score >= 80 ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300"
            : score >= 60 ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
            : score >= 40 ? "bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300"
            : "bg-gray-100 dark:bg-white/8 text-gray-500";
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold tabular-nums ${cls}`}>{score}</span>;
}

// Collapsible section
function Sect({ title, badge, open, onToggle, children }: {
  title: string; badge?: React.ReactNode; open: boolean;
  onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-100 dark:border-white/6 last:border-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-gray-50 dark:hover:bg-white/3 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">{title}</span>
          {badge}
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-4 space-y-2.5">{children}</div>}
    </div>
  );
}

// View-mode row: only renders if value is truthy
function VRow({ label, value, source, children }: { label: string; value?: any; source?: string; children?: React.ReactNode }) {
  const hasValue = value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
  if (!hasValue && !children) return null;
  return (
    <div className="flex gap-3 text-xs">
      <span className="w-[110px] shrink-0 text-gray-400 dark:text-gray-500 pt-0.5">{label}</span>
      <span className="text-gray-800 dark:text-gray-200 leading-relaxed flex-1">{children ?? String(value)}</span>
      {source && <SourceTag source={source} />}
    </div>
  );
}

// Edit-mode row
function ERow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
      <span className="text-xs text-gray-500 dark:text-gray-400 pt-1.5 leading-tight">{label}</span>
      <div>{children}</div>
    </div>
  );
}

const ExtLink = ({ href }: { href: string | null }) => href ? (
  <a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-gray-400 hover:text-blue-500 transition-colors">
    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  </a>
) : null;

// Source provenance tag
function SourceTag({ source }: { source?: string }) {
  if (!source) return null;
  const cls =
    source === "apollo"  ? "bg-purple-50 dark:bg-purple-950 text-purple-600 dark:text-purple-400" :
    source === "hunter"  ? "bg-orange-50 dark:bg-orange-950 text-orange-600 dark:text-orange-400" :
    source === "manual"  ? "bg-gray-100 dark:bg-white/8 text-gray-400" :
    "bg-gray-100 dark:bg-white/8 text-gray-400";
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide shrink-0 ${cls}`}>{source}</span>
  );
}

function LeadDrawer({ lead, onClose, onSave, runId: initialRunId, traceSteps: initialSteps, traceStatus: initialStatus }: {
  lead: Lead; onClose: () => void; onSave: (updated: Lead) => void;
  runId?: string | null; traceSteps?: TraceStep[]; traceStatus?: "running" | "completed" | "failed" | null;
}) {
  const [form, setForm] = useState<Lead>({ ...lead, contacts: lead.contacts ?? [], technologies: lead.technologies ?? [] });
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [open, setOpen] = useState({ outreach: true, contacts: true, company: true, notes: false, score: false });
  const tog = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));

  // Enrichment trace — lifted state so it persists across drawer open/close
  const [enriching, setEnriching] = useState(!!initialRunId && initialStatus === "running");
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>(initialSteps ?? []);
  const [traceStatus, setTraceStatus] = useState<"running" | "completed" | "failed" | null>(initialStatus ?? null);
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId ?? null);
  const [showTrace, setShowTrace] = useState(!!initialRunId);
  const traceEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function set(key: keyof Lead, value: string) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function updateContact(i: number, field: keyof Contact, value: string) {
    setForm(f => {
      const contacts = [...f.contacts];
      contacts[i] = { ...contacts[i], [field]: value };
      return { ...f, contacts };
    });
  }

  function addContact() {
    setForm(f => ({ ...f, contacts: [...f.contacts, { name: "" }] }));
  }

  function removeContact(i: number) {
    setForm(f => ({ ...f, contacts: f.contacts.filter((_, idx) => idx !== i) }));
  }

  function startPolling(runId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/proxy/crm/runs/${runId}`);
        if (!r.ok) return;
        const runData = await r.json();
        setTraceSteps(runData.steps ?? []);
        if (runData.status === "completed" || runData.status === "failed") {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setTraceStatus(runData.status);
          setEnriching(false);
          if (runData.status === "completed") {
            const r2 = await fetch("/api/proxy/crm/leads");
            if (r2.ok) {
              const all: Lead[] = await r2.json();
              const updated = all.find(l => l.id === lead.id);
              if (updated) {
                setForm({ ...updated, contacts: updated.contacts ?? [], technologies: updated.technologies ?? [] });
                onSave(updated);
              }
            }
          }
        }
      } catch { /* keep polling */ }
    }, 1500);
  }

  // Resume polling if a run was already in progress when drawer reopened
  useEffect(() => {
    if (initialRunId && initialStatus === "running") startPolling(initialRunId);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (showTrace) traceEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [traceSteps, showTrace]);

  async function enrich() {
    if (enriching) return;
    setEnriching(true);
    setTraceSteps([]);
    setTraceStatus("running");
    setShowTrace(true);
    try {
      const res = await fetch("/api/proxy/crm/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_ids: [lead.id], max_leads: 1 }),
      });
      if (!res.ok) {
        setTraceSteps([{ type: "error", ts: new Date().toISOString(), content: `Failed to start enrichment (${res.status})` }]);
        setTraceStatus("failed"); setEnriching(false); return;
      }
      const data = await res.json();
      const run = data.runs?.[0];
      if (!run?.run_id) {
        setTraceSteps([{ type: "error", ts: new Date().toISOString(), content: data.message || "No leads to enrich" }]);
        setTraceStatus("failed"); setEnriching(false); return;
      }
      setActiveRunId(run.run_id);
      onSave({ ...form, _runId: run.run_id, _traceStatus: "running" } as any); // notify parent
      startPolling(run.run_id);
    } catch (e) {
      setTraceSteps([{ type: "error", ts: new Date().toISOString(), content: String(e) }]);
      setTraceStatus("failed"); setEnriching(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/proxy/crm/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) onSave(await res.json());
    } finally {
      setSaving(false);
    }
  }


  const enrichedAt = (lead as any).enriched_at
    ? new Date((lead as any).enriched_at).toLocaleDateString()
    : null;

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30 dark:bg-black/50" />
      <div
        className="w-[500px] bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-white/10 flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-200 dark:border-white/8 shrink-0">
          <div className="min-w-0 pr-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white truncate">{form.company}</h2>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <ScoreBadge score={form.priority_score ?? null} />
              {form.enrichment_status === "enriched" && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 font-medium">✓ Enriched{enrichedAt ? ` ${enrichedAt}` : ""}</span>
              )}
              {form.enrichment_status === "failed" && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 font-medium">Enrichment failed</span>
              )}
              {form.source === "agent" && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-300 font-medium">Agent</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={async () => {
                const res = await fetch(`/api/proxy/crm/leads/${lead.id}/score`, { method: "POST" });
                if (res.ok) { const updated = await res.json(); setForm({ ...updated, contacts: updated.contacts ?? [], technologies: updated.technologies ?? [] }); onSave(updated); }
              }}
              className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
              title="Re-calculate priority score"
            >Re-score</button>
            <button
              onClick={async (e) => {
                const btn = e.currentTarget;
                btn.textContent = "Checking…";
                btn.setAttribute("disabled", "true");
                try {
                  const res = await fetch("/api/proxy/crm/leads/mutual-connections", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ lead_ids: [lead.id], unchecked_only: false }),
                  });
                  if (res.ok) {
                    // Poll until check completes (mutual_connection_checked_at updates)
                    const poll = setInterval(async () => {
                      const r2 = await fetch(`/api/proxy/crm/leads/${lead.id}`);
                      if (r2.ok) {
                        const updated = await r2.json();
                        if (updated.mutual_connection_checked_at) {
                          clearInterval(poll);
                          setForm({ ...updated, contacts: updated.contacts ?? [], technologies: updated.technologies ?? [] });
                          onSave(updated);
                          btn.textContent = "Check connections";
                          btn.removeAttribute("disabled");
                        }
                      }
                    }, 2000);
                    setTimeout(() => { clearInterval(poll); btn.textContent = "Check connections"; btn.removeAttribute("disabled"); }, 120000);
                  }
                } catch { btn.textContent = "Check connections"; btn.removeAttribute("disabled"); }
              }}
              className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
              title="Find warm connections via contacts database"
            >Check connections</button>
            <button
              onClick={enrich}
              disabled={enriching}
              className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
            >{enriching ? "Enriching…" : "Enrich"}</button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
          </div>
        </div>

        {/* Trace panel — overlays the body while running, stays open until dismissed */}
        {showTrace && (
          <div className="flex-1 flex flex-col min-h-0 bg-gray-950 dark:bg-gray-950">
            {/* Trace header */}
            <div className="px-4 py-2.5 border-b border-white/8 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                {traceStatus === "running" && (
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                )}
                {traceStatus === "completed" && (
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                )}
                {traceStatus === "failed" && (
                  <span className="w-2 h-2 rounded-full bg-red-400" />
                )}
                <span className="text-xs font-semibold text-gray-300">
                  {traceStatus === "running" ? "Enriching…" : traceStatus === "completed" ? "Enrichment complete" : "Enrichment failed"}
                </span>
              </div>
              {traceStatus !== "running" && (
                <button
                  onClick={() => setShowTrace(false)}
                  className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-white/8 transition-colors"
                >View lead →</button>
              )}
            </div>
            {/* Steps */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 font-mono text-xs">
              {traceSteps.map((step, i) => {
                const time = new Date(step.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                if (step.type === "info") return (
                  <div key={i} className="flex gap-2 text-gray-500">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>{step.content}</span>
                  </div>
                );
                if (step.type === "thinking") return (
                  <div key={i} className="flex gap-2 text-blue-400/80">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span className="italic leading-relaxed">{step.content}</span>
                  </div>
                );
                if (step.type === "tool_call") return (
                  <div key={i} className="flex gap-2 text-amber-400">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>→ {step.content}</span>
                  </div>
                );
                if (step.type === "tool_result") return (
                  <div key={i} className="flex gap-2 text-gray-400 pl-4">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>{step.content}</span>
                  </div>
                );
                if (step.type === "save") return (
                  <div key={i} className="flex gap-2 text-green-400">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>✓ {step.content}</span>
                  </div>
                );
                if (step.type === "error") return (
                  <div key={i} className="flex gap-2 text-red-400">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>✗ {step.content}</span>
                  </div>
                );
                if (step.type === "done") return (
                  <div key={i} className="flex gap-2 text-green-300 font-semibold">
                    <span className="shrink-0 text-gray-600">{time}</span>
                    <span>✓ {step.content}</span>
                  </div>
                );
                return null;
              })}
              {traceStatus === "running" && (
                <div className="flex gap-2 text-gray-600 animate-pulse">
                  <span>…</span>
                </div>
              )}
              <div ref={traceEndRef} />
            </div>
          </div>
        )}

        {/* Body */}
        <div className={`flex-1 overflow-y-auto ${showTrace ? "hidden" : ""}`}>

          {/* ── Outreach ─────────────────────────────────────────── */}
          <Sect title="Outreach" open={open.outreach} onToggle={() => tog("outreach")}>
            {mode === "view" ? (
              <>
                <VRow label="Status" value={form.reach_out_status} />
                <VRow label="Mutual connection" value={form.mutual_connection} source={form.field_sources?.mutual_connection} />
                <VRow label="Recommended action" value={form.recommended_action} source={form.field_sources?.recommended_action} />
                <VRow label="Notes" value={form.notes} />
              </>
            ) : (
              <>
                <ERow label="Status">
                  <select value={form.reach_out_status ?? ""} onChange={e => set("reach_out_status", e.target.value)} className={iCls}>
                    {REACH_OUT_OPTIONS.map(o => <option key={o} value={o}>{o || "—"}</option>)}
                  </select>
                </ERow>
                <ERow label="Mutual connection">
                  <input value={form.mutual_connection ?? ""} onChange={e => set("mutual_connection", e.target.value)} className={iCls} />
                </ERow>
                <ERow label="Recommended action">
                  <AutoTextarea rows={2} value={form.recommended_action ?? ""} onChange={e => set("recommended_action", e.target.value)} className={tCls} />
                </ERow>
                <ERow label="Notes">
                  <AutoTextarea rows={3} value={form.notes ?? ""} onChange={e => set("notes", e.target.value)} className={tCls} />
                </ERow>
              </>
            )}
          </Sect>

          {/* ── Contacts ─────────────────────────────────────────── */}
          <Sect
            title="Contacts"
            badge={form.contacts.length > 0 ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500">{form.contacts.length}</span> : undefined}
            open={open.contacts}
            onToggle={() => tog("contacts")}
          >
            {mode === "view" ? (
              form.contacts.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 italic">No contacts yet</p>
              ) : (
                <div className="space-y-3">
                  {form.contacts.map((c, i) => (
                    <div key={i} className="border border-gray-100 dark:border-white/8 rounded-lg p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">{c.name}</p>
                          {(c.title || c.seniority || c.department) && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                              {[c.title, c.seniority, c.department].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>
                        <SourceTag source={form.field_sources?.[`contact_${i}`]} />
                      </div>
                      {c.email && (
                        <div className="flex items-center gap-2">
                          <a href={`mailto:${c.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate">{c.email}</a>
                          {c.email_status && (
                            <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-medium ${
                              c.email_status === "verified" ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300" :
                              c.email_status === "likely"   ? "bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300" :
                              "bg-gray-100 dark:bg-white/8 text-gray-500"
                            }`}>{c.email_status}</span>
                          )}
                        </div>
                      )}
                      {c.phone && <p className="text-xs text-gray-500 dark:text-gray-400">{c.phone}</p>}
                      {c.linkedin && (
                        <div className="flex items-center gap-1.5">
                          <a href={c.linkedin} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">LinkedIn</a>
                          <ExtLink href={c.linkedin} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                <div className="space-y-3">
                  {form.contacts.map((contact, i) => (
                    <div key={i} className="relative border border-gray-100 dark:border-white/8 rounded-lg p-3 space-y-2">
                      <button onClick={() => removeContact(i)} className="absolute top-2 right-2 text-gray-300 dark:text-gray-600 hover:text-red-400 text-base leading-none">×</button>
                      <ERow label="Name"><input value={contact.name} onChange={e => updateContact(i, "name", e.target.value)} className={iCls} placeholder="Full name" /></ERow>
                      <ERow label="Title"><input value={contact.title ?? ""} onChange={e => updateContact(i, "title", e.target.value)} className={iCls} placeholder="Job title" /></ERow>
                      <ERow label="Seniority / Dept">
                        <div className="flex gap-2">
                          <input value={contact.seniority ?? ""} onChange={e => updateContact(i, "seniority", e.target.value)} className={iCls} placeholder="VP, Director…" />
                          <input value={contact.department ?? ""} onChange={e => updateContact(i, "department", e.target.value)} className={iCls} placeholder="R&D, Procurement…" />
                        </div>
                      </ERow>
                      <ERow label="Email">
                        <div className="flex gap-2 items-center">
                          <input value={contact.email ?? ""} onChange={e => updateContact(i, "email", e.target.value)} className={iCls} placeholder="email@company.com" />
                          {contact.email_status && (
                            <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-medium ${
                              contact.email_status === "verified" ? "bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300" :
                              contact.email_status === "likely"   ? "bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300" :
                              "bg-gray-100 dark:bg-white/8 text-gray-500"
                            }`}>{contact.email_status}</span>
                          )}
                        </div>
                      </ERow>
                      <ERow label="Phone"><input value={contact.phone ?? ""} onChange={e => updateContact(i, "phone", e.target.value)} className={iCls} placeholder="+1 555 000 0000" /></ERow>
                      <ERow label="LinkedIn">
                        <div className="flex items-center gap-2">
                          <input value={contact.linkedin ?? ""} onChange={e => updateContact(i, "linkedin", e.target.value)} className={iCls} placeholder="https://linkedin.com/in/…" />
                          <ExtLink href={contact.linkedin ?? null} />
                        </div>
                      </ERow>
                    </div>
                  ))}
                </div>
                <button onClick={addContact} className="text-xs text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 font-medium mt-1">+ Add contact</button>
              </>
            )}
          </Sect>

          {/* ── Company ──────────────────────────────────────────── */}
          <Sect title="Company" open={open.company} onToggle={() => tog("company")}>
            {mode === "view" ? (
              <>
                <VRow label="Website" value={form.website}>
                  {form.website && <div className="flex items-center gap-1.5"><a href={form.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline truncate">{form.website}</a><ExtLink href={form.website} /></div>}
                </VRow>
                <VRow label="LinkedIn" value={form.company_linkedin} source={form.field_sources?.company_linkedin}>
                  {form.company_linkedin && <div className="flex items-center gap-1.5"><a href={form.company_linkedin} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">LinkedIn</a><ExtLink href={form.company_linkedin} /></div>}
                </VRow>
                <VRow label="Industry" value={form.industry} source={form.field_sources?.industry} />
                <VRow label="Description" value={form.description} source={form.field_sources?.description} />
                <VRow label="Employees" value={form.employee_count} source={form.field_sources?.employee_count} />
                <VRow label="Founded" value={form.founded_year} source={form.field_sources?.founded_year} />
                {(form.technologies?.length ?? 0) > 0 && (
                  <VRow label="Technologies" value={form.technologies.join(", ")} source={form.field_sources?.technologies} />
                )}
                <VRow label="Size tier" value={form.tier_size} source={form.field_sources?.tier_size} />
                <VRow label="Region" value={[form.region, form.city].filter(Boolean).join(", ") || null} />
                <VRow label="Address" value={form.address} />
                <VRow label="Revenue" value={form.est_revenue} source={form.field_sources?.est_revenue} />
                <VRow label="Key products" value={form.key_products} source={form.field_sources?.key_products} />
                <VRow label="Founder ERP fit" value={form.org_fit} />
              </>
            ) : (
              <>
                <ERow label="Website">
                  <div className="flex items-center gap-2"><input value={form.website ?? ""} onChange={e => set("website", e.target.value)} className={iCls} /><ExtLink href={form.website} /></div>
                </ERow>
                <ERow label="LinkedIn">
                  <div className="flex items-center gap-2"><input value={form.company_linkedin ?? ""} onChange={e => set("company_linkedin", e.target.value)} className={iCls} /><ExtLink href={form.company_linkedin} /></div>
                </ERow>
                <ERow label="Industry"><input value={form.industry ?? ""} onChange={e => set("industry", e.target.value)} className={iCls} /></ERow>
                <ERow label="Description"><AutoTextarea rows={2} value={form.description ?? ""} onChange={e => set("description", e.target.value)} className={tCls} /></ERow>
                <ERow label="Employees / Founded">
                  <div className="flex gap-2">
                    <input type="number" value={form.employee_count ?? ""} onChange={e => setForm(f => ({ ...f, employee_count: e.target.value ? parseInt(e.target.value) : null }))} placeholder="Headcount" className={iCls} />
                    <input type="number" value={form.founded_year ?? ""} onChange={e => setForm(f => ({ ...f, founded_year: e.target.value ? parseInt(e.target.value) : null }))} placeholder="Founded" className={iCls} />
                  </div>
                </ERow>
                <ERow label="Technologies"><TagInput values={form.technologies ?? []} onChange={v => setForm(f => ({ ...f, technologies: v }))} placeholder="Add tech…" /></ERow>
                <ERow label="Tier / Size"><input value={form.tier_size ?? ""} onChange={e => set("tier_size", e.target.value)} className={iCls} /></ERow>
                <ERow label="Region">
                  <div className="flex gap-2">
                    <input value={form.region ?? ""} onChange={e => set("region", e.target.value)} placeholder="Region" className={iCls} />
                    <input value={form.city ?? ""} onChange={e => set("city", e.target.value)} placeholder="City" className={iCls} />
                  </div>
                </ERow>
                <ERow label="Address"><input value={form.address ?? ""} onChange={e => set("address", e.target.value)} className={iCls} /></ERow>
                <ERow label="Revenue"><input value={form.est_revenue ?? ""} onChange={e => set("est_revenue", e.target.value)} className={iCls} /></ERow>
                <ERow label="Key products"><AutoTextarea rows={2} value={form.key_products ?? ""} onChange={e => set("key_products", e.target.value)} className={tCls} /></ERow>
                <ERow label="Founder ERP fit"><AutoTextarea rows={3} value={form.org_fit ?? ""} onChange={e => set("org_fit", e.target.value)} className={tCls} /></ERow>
              </>
            )}
          </Sect>

          {/* ── Score Breakdown ──────────────────────────────────── */}
          {form.score_breakdown && Object.keys(form.score_breakdown).length > 0 && (() => {
            const bd = form.score_breakdown!;
            const maxes = bd._max as Record<string, number> | undefined;
            const LABELS: Record<string, string> = {
              company_size: "Company size", revenue: "Revenue",
              contact_quality: "Contacts", icp_match: "ICP match",
              warm_connection: "Warm connection", engagement: "Engagement",
              completeness: "Completeness",
            };
            const DETAILS: Record<string, { field: string; source: string }[]> = {
              company_size:    [{ field: "employee_count", source: "Apollo org" }, { field: "tier_size (fallback)", source: "Manual" }],
              revenue:         [{ field: "est_revenue", source: "Manual / Apollo org" }],
              contact_quality: [{ field: "contacts[].email", source: "Apollo /people/bulk_match · Hunter /email-finder" }],
              icp_match:       [{ field: "industry", source: "Apollo org / Hunter company" }, { field: "region", source: "Manual" }],
              warm_connection: [{ field: "mutual_connection", source: "Manual" }],
              engagement:      [{ field: "recommended_action", source: "Manual" }, { field: "org_fit", source: "Manual" }],
              completeness:    [{ field: "enrichment_status", source: "System" }, { field: "website", source: "Apollo org" }, { field: "description", source: "Hunter company" }],
            };
            const FALLBACK_MAX: Record<string, number> = {
              company_size: 25, revenue: 20, contact_quality: 15,
              icp_match: 15, warm_connection: 15, engagement: 5, completeness: 5,
            };
            const keys = Object.keys(LABELS);
            return (
              <Sect
                title="Score breakdown"
                badge={<ScoreBadge score={bd.total ?? form.priority_score ?? null} />}
                open={open.score}
                onToggle={() => tog("score")}
              >
                <div className="space-y-3">
                  {keys.map(k => {
                    const pts = bd[k] ?? 0;
                    const max = maxes?.[k] ?? FALLBACK_MAX[k] ?? 25;
                    const pct = max > 0 ? Math.round((pts / max) * 100) : 0;
                    const barColor = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-blue-500" : pct >= 20 ? "bg-yellow-500" : "bg-gray-300 dark:bg-white/20";
                    return (
                      <div key={k}>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="w-[120px] shrink-0 text-gray-600 dark:text-gray-300 font-medium">{LABELS[k]}</span>
                          <div className="flex-1 h-1.5 bg-gray-100 dark:bg-white/10 rounded overflow-hidden">
                            <div className={`h-full rounded transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-12 text-right tabular-nums text-gray-500 dark:text-gray-400 shrink-0">{pts}/{max}</span>
                        </div>
                        {DETAILS[k] && (
                          <div className="ml-[120px] mt-0.5 space-y-0.5">
                            {DETAILS[k].map((d, i) => (
                              <p key={i} className="text-[10px] text-gray-400 dark:text-gray-500">
                                <span className="font-mono">{d.field}</span>
                                <span className="mx-1 text-gray-300 dark:text-gray-600">·</span>
                                <span>{d.source}</span>
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="pt-1.5 border-t border-gray-100 dark:border-white/8 flex items-center justify-between text-xs font-semibold">
                    <span className="text-gray-500 dark:text-gray-400">Total</span>
                    <span className="text-gray-900 dark:text-gray-100 tabular-nums">{bd.total ?? "—"} / 100</span>
                  </div>
                </div>
              </Sect>
            );
          })()}

          {/* ── Enrichment Notes ─────────────────────────────────── */}
          {form.enrichment_notes && (
            <Sect title="Enrichment Notes" open={open.notes} onToggle={() => tog("notes")}>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{form.enrichment_notes}</p>
            </Sect>
          )}

        </div>

        {/* Footer */}
        {!showTrace && (
          <div className="px-5 py-3 border-t border-gray-200 dark:border-white/8 flex items-center justify-end gap-2 shrink-0">
            {mode === "view" ? (
              <button
                onClick={() => setMode("edit")}
                className="px-4 py-1.5 bg-gray-100 dark:bg-white/8 hover:bg-gray-200 dark:hover:bg-white/12 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition-colors"
              >Edit</button>
            ) : (
              <>
                <button
                  onClick={() => { setMode("view"); setForm({ ...lead, contacts: lead.contacts ?? [], technologies: lead.technologies ?? [] }); }}
                  className="px-4 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                >Cancel</button>
                <button onClick={save} disabled={saving}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-60 transition-colors">
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Leads tab ─────────────────────────────────────────────────────────────────

type SortKey = "company" | "priority_score" | "reach_out_status" | "region" | "tier_size" | "est_revenue" | "enrichment_status";
type SortDir = "asc" | "desc";


function LeadsTab({ system }: { system: System | null }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Lead | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("priority_score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = system ? `?system_id=${system.id}` : "";
    fetch(`/api/proxy/crm/leads${qs}`)
      .then(r => r.ok ? r.json() : [])
      .then(setLeads)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [system]);

  useEffect(() => { load(); }, [load]);

  async function syncSheets() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const body = system?.spreadsheet_id ? { spreadsheet_id: system.spreadsheet_id } : {};
      const r = await fetch("/api/proxy/crm/leads/sheets/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) {
        const msg = data?.detail?.message ?? data?.detail ?? "Sync failed";
        setSyncMsg(`Error: ${msg}`);
      } else {
        const s = data.stats;
        const parts = [];
        if (s.db_to_sheet_appended)  parts.push(`${s.db_to_sheet_appended} pushed to sheet`);
        if (s.sheet_to_db_created)   parts.push(`${s.sheet_to_db_created} pulled from sheet`);
        if (s.db_updated_from_sheet) parts.push(`${s.db_updated_from_sheet} DB rows updated`);
        if (s.sheet_updated_from_db) parts.push(`${s.sheet_updated_from_db} sheet rows updated`);
        setSyncMsg(parts.length ? parts.join(" · ") : "Already in sync");
        load();
      }
    } catch {
      setSyncMsg("Network error");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 5000);
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "priority_score" ? "desc" : "asc"); }
  }

  const filtered = leads
    .filter(l => {
      const q = search.toLowerCase();
      return !q || l.company.toLowerCase().includes(q) || (l.region ?? "").toLowerCase().includes(q) || (l.org_fit ?? "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (sortKey === "priority_score") {
        const av = a.priority_score ?? -1, bv = b.priority_score ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const av = (a[sortKey] ?? "").toString().toLowerCase();
      const bv = (b[sortKey] ?? "").toString().toLowerCase();
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">Loading…</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-gray-200 dark:border-white/8 flex items-center gap-3 shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search companies, regions, fit…"
          className="flex-1 max-w-xs px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        />
        <a
          href="https://docs.google.com/spreadsheets/d/1T_tWv5tTEia93H5v-tCZObfUF4OMtvXIHlGb4yb9eBc/edit"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 hover:text-green-600 dark:hover:text-green-400 transition-colors"
          title="Open Google Sheet"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.188 2H7.768C6.79 2 6 2.79 6 3.768V6H3.768C2.79 6 2 6.79 2 7.768v12.464C2 21.21 2.79 22 3.768 22h11.42c.977 0 1.767-.79 1.767-1.768V18h2.233C20.166 18 21 17.166 21 16.188V3.812C21 2.834 20.166 2 19.188 2zM15 20.232a.233.233 0 01-.232.232H3.768a.233.233 0 01-.233-.232V7.768c0-.128.104-.233.233-.233H6v8.653C6 17.166 6.834 18 7.812 18H15v2.232zm4-4.044a.188.188 0 01-.188.188H7.812a.188.188 0 01-.187-.188V3.812c0-.104.084-.188.187-.188h11.376c.104 0 .188.084.188.188v12.376z"/>
            <path d="M9 7h6v1.5H9zm0 3h6v1.5H9zm0 3h4v1.5H9z"/>
          </svg>
          Sheet
        </a>
        {syncMsg && (
          <span className="text-xs text-gray-500 dark:text-gray-400 max-w-xs truncate">{syncMsg}</span>
        )}
        <button
          onClick={syncSheets}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {syncing ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Syncing…
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Sync Sheets
            </>
          )}
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-white/8 z-10">
            <tr>
              {([
                { key: "company",          label: "Company",  w: "w-[200px]" },
                { key: "priority_score",   label: "Score",    w: "w-[60px]"  },
                { key: "reach_out_status", label: "Status",   w: "w-[120px]" },
                { key: "region",           label: "Region",   w: "w-[140px]" },
                { key: "tier_size",        label: "Size",     w: "w-[130px]" },
                { key: "est_revenue",      label: "Revenue",  w: "w-[120px]" },
              ] as { key: SortKey; label: string; w: string }[]).map(col => (
                <th key={col.key} className={`${col.w} px-4 py-2.5 text-left`}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors group"
                  >
                    {col.label}
                    <span className={`transition-opacity ${sortKey === col.key ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
                      {sortKey === col.key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                </th>
              ))}
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 w-[160px]">Key Contact</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 w-[160px]">Email</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400 w-[90px]">
                <button onClick={() => toggleSort("enrichment_status")} className="flex items-center gap-1 text-xs font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors group">
                  Enriched
                  <span className={`transition-opacity ${sortKey === "enrichment_status" ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
                    {sortKey === "enrichment_status" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-white/5">
            {filtered.map(lead => (
              <tr
                key={lead.id}
                onClick={() => setSelected(lead)}
                className="hover:bg-gray-50 dark:hover:bg-white/3 cursor-pointer transition-colors"
              >
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[190px]">{lead.company}</div>
                  {lead.city && <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{lead.city}</div>}
                </td>
                <td className="px-4 py-2.5"><ScoreBadge score={lead.priority_score ?? null} /></td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 truncate max-w-[110px]">{lead.reach_out_status ?? "—"}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 truncate">{lead.region ?? "—"}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 truncate">{lead.tier_size ?? "—"}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 truncate">{lead.est_revenue || "—"}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 max-w-[150px]">
                  {lead.contacts?.[0] ? (
                    <div>
                      <div className="truncate font-medium text-gray-800 dark:text-gray-200">{lead.contacts[0].name}</div>
                      {lead.contacts[0].title && <div className="truncate text-gray-400 dark:text-gray-500">{lead.contacts[0].title}</div>}
                    </div>
                  ) : "—"}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 max-w-[150px]">
                  <span className="truncate block">{lead.contacts?.find(c => c.email)?.email || "—"}</span>
                </td>
                <td className="px-4 py-2.5">
                  {lead.enrichment_status === "enriched" ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 font-medium">✓ Done</span>
                  ) : lead.enrichment_status === "failed" ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400 font-medium">Failed</span>
                  ) : (
                    <span className="text-[10px] text-gray-400 dark:text-gray-600">Pending</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="flex items-center justify-center h-32 text-gray-400 dark:text-gray-500 text-sm">No leads found</div>
        )}
      </div>

      {selected && (
        <LeadDrawer
          lead={selected}
          onClose={() => setSelected(null)}
          onSave={updated => {
            setLeads(ls => ls.map(l => l.id === updated.id ? updated : l));
            setSelected(updated);
          }}
        />
      )}
    </div>
  );
}

// ── Enrichment result type ────────────────────────────────────────────────────

// ── Lead Enrichment Agent card ────────────────────────────────────────────────

function EnrichmentAgentCard() {
  const [status, setStatus] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [maxLeads, setMaxLeads] = useState(5);
  const [lastResult, setLastResult] = useState<{ runs: { run_id: string; company: string }[] } | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadStatus = useCallback(async () => {
    const r = await fetch("/api/proxy/crm/leads/enrich/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function runEnrichment() {
    setRunning(true);
    setLastResult(null);
    try {
      const r = await fetch("/api/proxy/crm/leads/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_leads: maxLeads }),
      });
      if (r.ok) {
        const data = await r.json();
        setLastResult({ runs: data.runs ?? [] });
        // Poll status until enrichment finishes
        const poll = setInterval(async () => {
          await loadStatus();
        }, 3000);
        setTimeout(() => clearInterval(poll), 120000);
      }
    } finally {
      setRunning(false);
    }
  }

  const total = Object.values(status).reduce((a, b) => a + b, 0);
  const enriched = status["enriched"] ?? 0;
  const pending = status["pending"] ?? 0;
  const failed = status["failed"] ?? 0;
  const pct = total > 0 ? Math.round((enriched / total) * 100) : 0;

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      {/* Compact header row — always visible */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left"
      >
        <div className="w-6 h-6 rounded-md bg-purple-100 dark:bg-purple-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Lead Enrichment</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 font-medium">Active</span>
          </div>
          {total > 0 && (
            <div className="flex items-center gap-3 mt-1">
              <div className="flex-1 h-1 bg-gray-100 dark:bg-white/10 rounded overflow-hidden">
                <div className="h-full bg-purple-500 rounded transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">{enriched}/{total} enriched · {pending} pending</span>
            </div>
          )}
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded controls */}
      {expanded && (
        <>
          <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 flex items-center gap-3 bg-gray-50 dark:bg-white/2">
            <span className="text-xs text-gray-500 dark:text-gray-400">Leads per run:</span>
            <select
              value={maxLeads}
              onChange={e => setMaxLeads(Number(e.target.value))}
              disabled={running}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none"
            >
              {[1, 3, 5, 10, 20].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <button
              onClick={e => { e.stopPropagation(); runEnrichment(); }}
              disabled={running || pending === 0}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
            >
              {running ? (
                <>
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running…
                </>
              ) : "Run"}
            </button>
          </div>

          {lastResult && lastResult.runs.length > 0 && (
            <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3">
              <p className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                Running — {lastResult.runs.length} lead{lastResult.runs.length !== 1 ? "s" : ""}
              </p>
              <div className="space-y-1">
                {lastResult.runs.map(r => (
                  <div key={r.run_id} className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                    {r.company}
                  </div>
                ))}
              </div>
            </div>
          )}

          {failed > 0 && (
            <div className="border-t border-gray-100 dark:border-white/8 px-4 py-2">
              <span className="text-[10px] text-red-500 dark:text-red-400">{failed} failed enrichments</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── GooseWorks balance card ───────────────────────────────────────────────────

function GooseWorksCard() {
  const [data, setData] = useState<{
    available: number; cycle_used: number; cycle_allocated: number;
    consumed_pct: number; cost_per_credit_usd: number;
    runs_30d: number; credits_used_30d: number; avg_credits_per_run: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/proxy/crm/gooseworks/balance")
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.detail ?? "Failed")))
      .then(setData)
      .catch(e => setError(String(e)));
  }, []);

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg px-4 py-3">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-6 h-6 rounded-md bg-gray-100 dark:bg-white/10 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-900 dark:text-white">GooseWorks Credits</span>
      </div>

      {error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : !data ? (
        <p className="text-xs text-gray-400 animate-pulse">Loading…</p>
      ) : (
        <div className="space-y-3">
          {/* Balance bar */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">Cycle usage</span>
              <span className="text-xs font-medium tabular-nums text-gray-700 dark:text-gray-300">
                {data.cycle_used} / {data.cycle_allocated} credits
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 dark:bg-white/10 rounded overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${data.consumed_pct >= 90 ? "bg-red-500" : data.consumed_pct >= 70 ? "bg-yellow-500" : "bg-green-500"}`}
                style={{ width: `${data.consumed_pct}%` }}
              />
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2 pt-1">
            <div className="text-center">
              <p className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{data.available}</p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">Available</p>
              <p className="text-[10px] text-green-600 dark:text-green-400 tabular-nums">${(data.available * 0.01).toFixed(2)}</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">{data.runs_30d}</p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">Runs (30d)</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
                {data.avg_credits_per_run > 0 ? `~${data.avg_credits_per_run}` : "—"}
              </p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">Credits/run</p>
            </div>
          </div>

          {/* Cost line */}
          <p className="text-[10px] text-gray-400 dark:text-gray-500 pt-1 border-t border-gray-100 dark:border-white/8">
            {data.credits_used_30d} credits used (30d) ·{" "}
            <span className="font-medium text-gray-600 dark:text-gray-300">
              ${(data.credits_used_30d * 0.01).toFixed(2)}
            </span>{" "}
            spent · avg{" "}
            <span className="font-medium text-gray-600 dark:text-gray-300">
              ${(data.avg_credits_per_run * 0.01).toFixed(2)}
            </span>
            /run
          </p>
        </div>
      )}
    </div>
  );
}


// ── Scoring metrics card ──────────────────────────────────────────────────────

const SCORE_CATEGORIES = [
  { key: "company_size",    label: "Company size",    hint: "Employee headcount" },
  { key: "revenue",         label: "Revenue",         hint: "Est. annual revenue" },
  { key: "contact_quality", label: "Contacts",        hint: "Verified email contacts found" },
  { key: "icp_match",       label: "ICP match",       hint: "Industry & region fit" },
  { key: "warm_connection", label: "Warm connection", hint: "Mutual connection present" },
  { key: "engagement",      label: "Engagement",      hint: "Recommended action, Founder ERP fit notes" },
  { key: "completeness",    label: "Completeness",    hint: "Enrichment & data quality" },
];

function ScoringMetricsCard() {
  const [expanded, setExpanded] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>({
    company_size: 25, revenue: 20, contact_quality: 15, icp_match: 15, warm_connection: 15, engagement: 5, completeness: 5,
  });
  const [keywords, setKeywords] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    fetch("/api/proxy/crm/scoring-config")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) { setWeights(d.weights ?? weights); setKeywords(d.industry_keywords ?? []); }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [expanded]);

  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  async function save() {
    setSaving(true);
    try {
      await fetch("/api/proxy/crm/scoring-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights, industry_keywords: keywords }),
      });
      // Re-score all leads with new config
      await fetch("/api/proxy/crm/leads/score", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left"
      >
        <div className="w-6 h-6 rounded-md bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-gray-900 dark:text-white">Lead Scoring</span>
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">weights · industry keywords</span>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-white/8 px-4 py-4 space-y-5 bg-gray-50 dark:bg-white/2">

          {/* Category weights */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest">Category weights</p>
              <span className={`text-xs font-medium tabular-nums ${total !== 100 ? "text-orange-500" : "text-gray-400 dark:text-gray-500"}`}>
                {total}/100{total !== 100 ? " — doesn't sum to 100" : ""}
              </span>
            </div>
            <div className="space-y-3">
              {SCORE_CATEGORIES.map(cat => (
                <div key={cat.key} className="grid grid-cols-[1fr_80px_36px] gap-2 items-center">
                  <div>
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{cat.label}</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500">{cat.hint}</p>
                  </div>
                  <input
                    type="range" min={0} max={50} step={1}
                    value={weights[cat.key] ?? 0}
                    onChange={e => setWeights(w => ({ ...w, [cat.key]: Number(e.target.value) }))}
                    className="w-full accent-blue-500"
                  />
                  <input
                    type="number" min={0} max={50}
                    value={weights[cat.key] ?? 0}
                    onChange={e => setWeights(w => ({ ...w, [cat.key]: Math.min(50, Math.max(0, Number(e.target.value))) }))}
                    className="w-full text-xs text-center px-1 py-1 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/40"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Industry keywords */}
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-2">Industry keywords</p>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-2">Leads matching these in industry or key products get ICP match credit.</p>
            <TagInput values={keywords} onChange={setKeywords} placeholder="Add keyword, press Enter" />
          </div>

          <div className="flex justify-end">
            <button
              onClick={save}
              disabled={saving}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${saved ? "bg-green-600 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"} disabled:opacity-60`}
            >
              {saved ? "Saved & re-scored" : saving ? "Saving…" : "Save & re-score leads"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Acquisition helpers ───────────────────────────────────────────────────────

function AcqRunResult({ runId }: { runId: string | null }) {
  const [run, setRun] = useState<{ status: string; added?: number; skipped?: number; result?: any } | null>(null);

  useEffect(() => {
    if (!runId) return;
    const poll = setInterval(async () => {
      const r = await fetch(`/api/proxy/crm/leads/acquire/run/${runId}`);
      if (r.ok) {
        const d = await r.json();
        setRun(d);
        if (d.status !== "running") clearInterval(poll);
      }
    }, 2500);
    return () => clearInterval(poll);
  }, [runId]);

  if (!runId || !run) return null;
  if (run.status === "running") return (
    <p className="text-[10px] text-blue-500 dark:text-blue-400 flex items-center gap-1.5">
      <svg className="w-3 h-3 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Running…
    </p>
  );
  if (run.status === "failed") return (
    <p className="text-[10px] text-red-500">{run.result?.error ?? "Run failed"}</p>
  );
  return (
    <p className="text-[10px] text-gray-500 dark:text-gray-400">
      Done — <span className="text-green-600 dark:text-green-400 font-medium">{run.added ?? 0} new leads added</span>
      {run.skipped ? `, ${run.skipped} already known` : ""}
    </p>
  );
}


// ── Apollo Acquisition card ───────────────────────────────────────────────────

function ApolloAcquisitionCard() {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [maxResults, setMaxResults] = useState(50);
  const [stats, setStats] = useState<{ total: number; pending: number; enriched: number } | null>(null);

  useEffect(() => {
    fetch("/api/proxy/crm/leads/acquire/stats")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const row = (d.by_source || []).find((r: any) => r.source === "apollo_search");
        if (row) setStats(row);
      }).catch(() => {});
  }, [runId]);

  async function run() {
    setRunning(true);
    setRunId(null);
    try {
      const r = await fetch("/api/proxy/crm/leads/acquire/apollo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_results: maxResults }),
      });
      if (r.ok) { const d = await r.json(); setRunId(d.run_id); }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
        <div className="w-6 h-6 rounded-md bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Apollo Company Search</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-medium">Free</span>
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
            {stats ? `${stats.total} leads acquired · ${stats.pending} pending enrichment` : "Find new bakery/food companies from Apollo's database"}
          </p>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 bg-gray-50 dark:bg-white/2 space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            Searches Apollo for bakery, baking, and food manufacturing companies in North America (50–50k employees). Skips companies already in your pipeline.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Max results:</label>
            <select value={maxResults} onChange={e => setMaxResults(Number(e.target.value))} disabled={running}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none">
              {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <button onClick={run} disabled={running}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
              {running ? <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Starting…</> : "Run"}
            </button>
          </div>
          <AcqRunResult runId={runId} />
        </div>
      )}
    </div>
  );
}


// ── Job Signals card ──────────────────────────────────────────────────────────

function JobSignalsCard() {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [hoursOld, setHoursOld] = useState(720);
  const [stats, setStats] = useState<{ total: number; pending: number } | null>(null);

  useEffect(() => {
    fetch("/api/proxy/crm/leads/acquire/stats")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const row = (d.by_source || []).find((r: any) => r.source === "job_signal");
        if (row) setStats(row);
      }).catch(() => {});
  }, [runId]);

  async function run() {
    setRunning(true);
    setRunId(null);
    try {
      const r = await fetch("/api/proxy/crm/leads/acquire/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours_old: hoursOld }),
      });
      if (r.ok) { const d = await r.json(); setRunId(d.run_id); }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
        <div className="w-6 h-6 rounded-md bg-amber-100 dark:bg-amber-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Job Signals</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-medium">Free</span>
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
            {stats ? `${stats.total} leads from hiring signals · ${stats.pending} pending` : "Find companies hiring R&D, Innovation, Procurement roles"}
          </p>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 bg-gray-50 dark:bg-white/2 space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            Scrapes LinkedIn for bakery/food companies actively hiring VP R&D, Director of Innovation, or Procurement roles — a strong buying signal. Free via JobSpy.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Lookback:</label>
            <select value={hoursOld} onChange={e => setHoursOld(Number(e.target.value))} disabled={running}
              className="text-xs px-2 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none">
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
              <option value={2160}>90 days</option>
            </select>
            <button onClick={run} disabled={running}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
              {running ? <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Starting…</> : "Run"}
            </button>
          </div>
          <AcqRunResult runId={runId} />
        </div>
      )}
    </div>
  );
}


// ── Event Scrape card ─────────────────────────────────────────────────────────

const PRESET_EVENTS = [
  { label: "IBIE 2025 Exhibitors", url: "https://www.ibie2025.com/exhibitors" },
  { label: "IFT First 2025 Exhibitors", url: "https://www.ift.org/ift-first/exhibitors" },
  { label: "SnackExpo 2025 Exhibitors", url: "https://www.snaxpo.com/exhibitors" },
];

function EventScrapeCard() {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [stats, setStats] = useState<{ total: number; pending: number } | null>(null);

  useEffect(() => {
    fetch("/api/proxy/crm/leads/acquire/stats")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const row = (d.by_source || []).find((r: any) => r.source === "event_scrape");
        if (row) setStats(row);
      }).catch(() => {});
  }, [runId]);

  async function run() {
    if (!url.trim()) return;
    setRunning(true);
    setRunId(null);
    try {
      const r = await fetch("/api/proxy/crm/leads/acquire/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (r.ok) { const d = await r.json(); setRunId(d.run_id); }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      <button onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
        <div className="w-6 h-6 rounded-md bg-teal-100 dark:bg-teal-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Event / Conference</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300 font-medium">Free</span>
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
            {stats ? `${stats.total} leads from events · ${stats.pending} pending` : "Scrape exhibitor/speaker lists from food industry conferences"}
          </p>
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 bg-gray-50 dark:bg-white/2 space-y-3">
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
            Paste any conference exhibitor or speaker list URL. The agent scrapes the page and extracts company names, deduplicating against your existing pipeline.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_EVENTS.map(e => (
              <button key={e.url} onClick={() => setUrl(e.url)}
                className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${url === e.url ? "border-teal-400 dark:border-teal-600 bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300" : "border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 hover:border-teal-300 dark:hover:border-teal-700"}`}>
                {e.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://conference.com/exhibitors"
              className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40"
            />
            <button onClick={run} disabled={running || !url.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors shrink-0">
              {running ? <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Starting…</> : "Scrape"}
            </button>
          </div>
          <AcqRunResult runId={runId} />
        </div>
      )}
    </div>
  );
}


// ── Mutual Connection Agent card ──────────────────────────────────────────────

function MutualConnectionAgentCard() {
  const [status, setStatus] = useState<{ unchecked: number; found: number; not_found: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ found: number; checked: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [recheckAll, setRecheckAll] = useState(false);

  const loadStatus = useCallback(async () => {
    const r = await fetch("/api/proxy/crm/leads/mutual-connections/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function runCheck() {
    setRunning(true);
    setLastRun(null);
    try {
      const r = await fetch("/api/proxy/crm/leads/mutual-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unchecked_only: !recheckAll }),
      });
      if (r.ok) {
        const data = await r.json();
        // Poll until unchecked count drops
        const poll = setInterval(async () => {
          const s = await fetch("/api/proxy/crm/leads/mutual-connections/status");
          if (s.ok) {
            const updated = await s.json();
            setStatus(updated);
            if (updated.unchecked === 0 || (!recheckAll && updated.unchecked === 0)) {
              clearInterval(poll);
              setLastRun({ found: updated.found, checked: updated.total });
              setRunning(false);
            }
          }
        }, 3000);
        setTimeout(() => { clearInterval(poll); setRunning(false); }, 300000);
      }
    } catch {
      setRunning(false);
    }
  }

  const checked = status ? (status.found + status.not_found) : 0;
  const total = status?.total ?? 0;
  const found = status?.found ?? 0;
  const unchecked = status?.unchecked ?? 0;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;

  return (
    <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left"
      >
        <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-950 flex items-center justify-center shrink-0">
          <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Warm Connection Finder</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-medium">GooseWorks</span>
          </div>
          {status && (
            <div className="flex items-center gap-3 mt-1">
              <div className="flex-1 h-1 bg-gray-100 dark:bg-white/10 rounded overflow-hidden">
                <div className="h-full bg-blue-500 rounded transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                {found} connections · {unchecked} unchecked
              </span>
            </div>
          )}
        </div>
        <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <>
          <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 bg-gray-50 dark:bg-white/2 space-y-3">
            <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
              Checks contacts DB for direct org matches, then uses <strong>Coresignal</strong> (~10 credits/profile) to
              trace lead contacts' employment history and find second-degree overlaps.
            </p>

            {status && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Found", value: found, color: "text-green-600 dark:text-green-400" },
                  { label: "No match", value: status.not_found, color: "text-gray-500 dark:text-gray-400" },
                  { label: "Unchecked", value: unchecked, color: "text-yellow-600 dark:text-yellow-400" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="text-center bg-white dark:bg-white/5 rounded-lg py-2">
                    <p className={`text-sm font-semibold tabular-nums ${color}`}>{value}</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={recheckAll}
                  onChange={e => setRecheckAll(e.target.checked)}
                  className="rounded"
                />
                Re-check all leads
              </label>
              <button
                onClick={runCheck}
                disabled={running || (!recheckAll && unchecked === 0)}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {running ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Running…
                  </>
                ) : `Run${unchecked > 0 ? ` (${unchecked})` : ""}`}
              </button>
            </div>
          </div>

          {lastRun && (
            <div className="border-t border-gray-100 dark:border-white/8 px-4 py-2">
              <p className="text-[10px] text-gray-500 dark:text-gray-400">
                Completed: <span className="text-green-600 dark:text-green-400 font-medium">{lastRun.found} connections found</span> of {lastRun.checked} leads checked
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}


// ── Agents tab ────────────────────────────────────────────────────────────────

function AgentsTab({ system }: { system: System | null }) {
  const [form, setForm] = useState<IcpProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [icpExpanded, setIcpExpanded] = useState(false);

  useEffect(() => {
    const qs = system ? `?system_id=${system.id}` : "";
    fetch(`/api/proxy/crm/icp${qs}`)
      .then((r) => r.ok ? r.json() : {})
      .then((d) => setForm({ ...EMPTY, ...d }))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [system]);

  function set<K extends keyof IcpProfile>(key: K, value: IcpProfile[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const qs = system ? `?system_id=${system.id}` : "";
      await fetch(`/api/proxy/crm/icp${qs}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">Loading…</div>;
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-3">

        {/* Lead Acquisition */}
        <div>
          <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">Lead Acquisition</p>
          <div className="space-y-2">
            <ApolloAcquisitionCard />
            <JobSignalsCard />
            <EventScrapeCard />
          </div>
        </div>

        {/* Agents */}
        <div>
          <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest mb-2">Enrichment & Scoring</p>
          <div className="space-y-2">
            <EnrichmentAgentCard />
            <MutualConnectionAgentCard />
            <ScoringMetricsCard />
            <GooseWorksCard />
          </div>
        </div>

        {/* Agent Context — collapsible */}
        <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
          <button
            onClick={() => setIcpExpanded(e => !e)}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left"
          >
            <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-950 flex items-center justify-center shrink-0">
              <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-gray-900 dark:text-white">Agent Context</span>
              <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">ICP · targeting · exclusions</span>
            </div>
            <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${icpExpanded ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {icpExpanded && (
            <div className="border-t border-gray-100 dark:border-white/8 px-6 py-6 space-y-8 bg-gray-50 dark:bg-white/2">
              <div className="flex justify-end">
                <button
                  onClick={save}
                  disabled={saving}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${saved ? "bg-green-600 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"} disabled:opacity-60`}
                >
                  {saved ? "Saved" : saving ? "Saving…" : "Save"}
                </button>
              </div>

          <div className="space-y-8">
            <Section title="Product">
              <Field label="Company URL">
                <input className={inputCls} placeholder="https://example.com" value={form.company_url ?? ""} onChange={(e) => set("company_url", e.target.value)} />
              </Field>
              <Field label="What it does" hint="Agents use this as their primary product context">
                <AutoTextarea className={`${inputCls} resize-none`} rows={3} placeholder="Describe your product or service…" value={form.product_description ?? ""} onChange={(e) => set("product_description", e.target.value)} />
              </Field>
              <Field label="Price point / deal size" hint="Helps determine buyer seniority">
                <input className={inputCls} placeholder="e.g. $5k–$50k ARR, enterprise, usage-based" value={form.price_point ?? ""} onChange={(e) => set("price_point", e.target.value)} />
              </Field>
              <Field label="Current customers" hint="Company names — calibrate search filters">
                <TagInput values={form.current_customers} onChange={(v) => set("current_customers", v)} placeholder="Add company name, press Enter" />
              </Field>
              <Field label="Competitors">
                <TagInput values={form.competitors} onChange={(v) => set("competitors", v)} placeholder="Add competitor, press Enter" />
              </Field>
            </Section>

            <div className="border-t border-gray-100 dark:border-white/8" />

            <Section title="Target ICP — Include">
              <Field label="Job titles">
                <TagInput values={form.target_titles} onChange={(v) => set("target_titles", v)} placeholder="e.g. VP R&D, Director of Innovation" />
              </Field>
              <Field label="Seniority">
                <TagInput values={form.target_seniority} onChange={(v) => set("target_seniority", v)} placeholder="e.g. VP, Director, C-Level" />
              </Field>
              <Field label="Company size" hint="Headcount range">
                <div className="flex items-center gap-2">
                  <input type="number" className={`${inputCls} w-28`} placeholder="Min" value={form.company_size_min ?? ""} onChange={(e) => set("company_size_min", e.target.value ? Number(e.target.value) : null)} />
                  <span className="text-gray-400 text-sm">–</span>
                  <input type="number" className={`${inputCls} w-28`} placeholder="Max" value={form.company_size_max ?? ""} onChange={(e) => set("company_size_max", e.target.value ? Number(e.target.value) : null)} />
                </div>
              </Field>
              <Field label="Industries">
                <TagInput values={form.target_industries} onChange={(v) => set("target_industries", v)} placeholder="e.g. SaaS, FinTech, Logistics" />
              </Field>
              <Field label="Regions">
                <TagInput values={form.target_regions} onChange={(v) => set("target_regions", v)} placeholder="e.g. US, SF Bay Area, EU" />
              </Field>
              <Field label="Buying signals" hint="Timing indicators to prioritise">
                <TagInput values={form.signals} onChange={(v) => set("signals", v)} placeholder="e.g. recently hired, posted about pain point" />
              </Field>
            </Section>

            <div className="border-t border-gray-100 dark:border-white/8" />

            <Section title="Exclusions — Filter Out">
              <Field label="Titles to exclude">
                <TagInput values={form.exclude_titles} onChange={(v) => set("exclude_titles", v)} placeholder="e.g. Intern, Coordinator, Student" />
              </Field>
              <Field label="Industries to exclude">
                <TagInput values={form.exclude_industries} onChange={(v) => set("exclude_industries", v)} placeholder="e.g. Government, Education, Non-profit" />
              </Field>
              <Field label="Company types to exclude">
                <TagInput values={form.exclude_company_types} onChange={(v) => set("exclude_company_types", v)} placeholder="e.g. Agencies, Consultancies" />
              </Field>
              <Field label="Company size to exclude" hint="Headcount range">
                <div className="flex items-center gap-2">
                  <input type="number" className={`${inputCls} w-28`} placeholder="Min" value={form.exclude_company_size_min ?? ""} onChange={(e) => set("exclude_company_size_min", e.target.value ? Number(e.target.value) : null)} />
                  <span className="text-gray-400 text-sm">–</span>
                  <input type="number" className={`${inputCls} w-28`} placeholder="Max" value={form.exclude_company_size_max ?? ""} onChange={(e) => set("exclude_company_size_max", e.target.value ? Number(e.target.value) : null)} />
                </div>
              </Field>
              <Field label="Companies to exclude" hint="Existing customers, competitors, partners">
                <TagInput values={form.exclude_companies} onChange={(v) => set("exclude_companies", v)} placeholder="Add company name, press Enter" />
              </Field>
            </Section>
          </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function SalesPipelineInner() {
  const searchParams = useSearchParams();
  const preselectedId = searchParams.get("system");

  const [tab, setTab] = useState<Tab>("leads");
  const [systems, setSystems] = useState<System[]>([]);
  const [currentSystem, setCurrentSystem] = useState<System | null>(null);
  const [showSystemMenu, setShowSystemMenu] = useState(false);
  const [addingSystem, setAddingSystem] = useState(false);
  const [newSystemName, setNewSystemName] = useState("");
  const [newSystemSheet, setNewSystemSheet] = useState("");
  const [savingSystem, setSavingSystem] = useState(false);

  useEffect(() => {
    if (!showSystemMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-system-menu]")) setShowSystemMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showSystemMenu]);

  useEffect(() => {
    fetch("/api/proxy/crm/systems")
      .then(r => r.ok ? r.json() : [])
      .then((data: System[]) => {
        setSystems(data);
        const match = preselectedId ? data.find(s => s.id === preselectedId) : null;
        setCurrentSystem(match ?? (data.length > 0 ? data[0] : null));
      })
      .catch(() => {});
  }, [preselectedId]);

  async function createSystem() {
    if (!newSystemName.trim()) return;
    setSavingSystem(true);
    try {
      const r = await fetch("/api/proxy/crm/systems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSystemName.trim(), spreadsheet_id: (() => { const m = newSystemSheet.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : (newSystemSheet.trim() || null); })() }),
      });
      if (r.ok) {
        const sys: System = await r.json();
        setSystems(s => [...s, sys]);
        setCurrentSystem(sys);
        setAddingSystem(false);
        setNewSystemName("");
        setNewSystemSheet("");
      }
    } finally {
      setSavingSystem(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-white/8 shrink-0">
        <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-white/8 rounded-lg p-0.5">
          {TAB_CONFIG.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                tab === key
                  ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* System selector */}
        <div className="relative" data-system-menu>
          <button
            onClick={() => { setShowSystemMenu(m => !m); setAddingSystem(false); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/10 transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
            {currentSystem?.name ?? "Select system"}
            <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showSystemMenu && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-white/10 rounded-xl shadow-lg z-50 overflow-hidden">
              <div className="py-1">
                {systems.map(sys => (
                  <button
                    key={sys.id}
                    onClick={() => { setCurrentSystem(sys); setShowSystemMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
                      sys.id === currentSystem?.id
                        ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-medium"
                        : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sys.id === currentSystem?.id ? "bg-blue-400" : "bg-gray-300 dark:bg-gray-600"}`} />
                    {sys.name}
                  </button>
                ))}
              </div>
              <div className="border-t border-gray-100 dark:border-white/8 p-2">
                {!addingSystem ? (
                  <button
                    onClick={() => setAddingSystem(true)}
                    className="w-full text-left px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-lg transition-colors font-medium"
                  >
                    + Add system
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    <input
                      autoFocus
                      value={newSystemName}
                      onChange={e => setNewSystemName(e.target.value)}
                      placeholder="System name"
                      className="w-full px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      value={newSystemSheet}
                      onChange={e => setNewSystemSheet(e.target.value)}
                      placeholder="Google Sheet URL (optional)"
                      className="w-full px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={createSystem}
                        disabled={savingSystem || !newSystemName.trim()}
                        className="flex-1 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg disabled:opacity-50"
                      >
                        {savingSystem ? "…" : "Create"}
                      </button>
                      <button
                        onClick={() => { setAddingSystem(false); setNewSystemName(""); setNewSystemSheet(""); }}
                        className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {tab === "leads" && <LeadsTab system={currentSystem} />}
      {tab === "agents" && <AgentsTab system={currentSystem} />}
    </div>
  );
}

export default function SalesPipelinePage() {
  return (
    <Suspense>
      <SalesPipelineInner />
    </Suspense>
  );
}
