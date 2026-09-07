"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { EntityActivity, EntityContacts } from "@/components/comms/EntityActivity";
import { Avatar } from "@/components/Avatar";
import { AutoTextarea } from "@/components/AutoTextarea";
import {
  CRM_STAGE_GROUPS, allStages, LEAD_SOURCES, LEAD_SOURCE_OTHER,
  DEAL_STATUS_LABEL, USER_SETTABLE_STATUSES,
  URGENCY_CHIP, URGENCY_DOT, URGENCY_FALLBACK, URGENCY_LABEL, URGENCY_HELP,
  SITE_REGIONS, ROLE_IN_DECISION, CONTACT_FUNCTIONS,
  CLOSED_LOST_CATEGORIES, CLOSED_LOST_OTHER,
  PLAN_ITEM_TYPES, planStatusesFor,
} from "@/lib/contractStages";

// ── Shared styles (mirrors components/project/ProjectDetailView.tsx) ──────────

const SEL = "text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 pr-7 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.4rem_center] bg-[length:1rem]";
const SEL_XS = "text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-5 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.25rem_center] bg-[length:0.8rem]";
const DATE_INPUT = "text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 cursor-pointer";
const CARD = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl";
const INPUT_XS = "text-xs text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500/30";
const LABEL = "text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DealRow = {
  deal_id: string;
  title: string;
  company_id: string | null;
  company_name: string | null;
  stage: string | null;
  status: string | null;
  contract_type: string;
  description: string | null;
  site_country_region: string | null;
  deal_lead_id: string | null;
  deal_lead_name: string | null;
  start_date: string | null;
  expected_close_date: string | null;
  end_date: string | null;
  date_entered_current_stage: string | null;
  urgency: string | null;
  deal_source: string | null;
  projected_revenue: number | string | null;
  success_criteria: string | null;
  closed_lost_category: string | null;
  closed_lost_reason: string | null;
  reapproach_date: string | null;
  email_text: string | null;
  archived: boolean | null;
};


export type CustomField = { id: string; kind: "line" | "textbox" | "date"; label: string; value: string | null };

export type PlanItem = {
  plan_item_id: string;
  item_type: string;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  status: string;
  description: string | null;
  body: string | null;
  email_subject: string | null;
  nda_signed_date: string | null;
  fs_target_date: string | null;
  fs_date_completed: string | null;
  fs_date_sent_to_client: string | null;
  fs_analysis_link: string | null;
  resolved_on: string | null;
  title: string | null;
  custom_fields: CustomField[];
  email_enabled: boolean;
  created_at: string;
};

type DetailPayload = {
  deal: DealRow;
  company: { company_id: string; name: string; website_url: string | null; industry: string | null } | null;
  contacts: {
    contact_id: string; name: string | null; email: string | null; phone: string | null;
    title: string | null; role_in_decision: string | null; contact_function: string | null;
    role: string; is_primary: boolean;
  }[];
  plan_items: PlanItem[];
  stage_history: StageHistoryEntry[];
};

export type StageHistoryEntry = {
  stage_history_id: string;
  changed_at: string;
  stage_from: string | null;
  stage_to: string;
  changed_by_name: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function money(v: number | string | null) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
function dateVal(v: unknown): string {
  const s = str(v);
  return s ? s.slice(0, 10) : "";
}

/** Click-to-edit text / textarea / number cell. */
function Field({ value, onSave, placeholder = "—", multiline = false, numeric = false, required = false }: {
  value: string; onSave: (v: string | null) => void; placeholder?: string;
  multiline?: boolean; numeric?: boolean; required?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { setDraft(value); }, [value]);
  // Auto-grow the multiline editor so the whole text is visible without resizing.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);
  const missing = required && !value.trim();

  if (editing) {
    if (multiline) {
      return (
        <AutoTextarea ref={taRef} autoFocus value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); if (draft !== value) onSave(draft.trim() || null); }}
          className={INPUT_XS + " w-full resize-none overflow-hidden"}
          style={{ minHeight: 48 }} />
      );
    }
    return (
      <input autoFocus type={numeric ? "number" : "text"} step="any" value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== value) onSave(draft.trim() || null); }}
        onKeyDown={e => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={INPUT_XS + " w-full"} />
    );
  }
  return (
    <span onClick={() => setEditing(true)}
      className={`text-xs cursor-text leading-relaxed whitespace-pre-wrap break-words rounded transition-colors ${
        value ? "text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
              : "text-zinc-300 dark:text-zinc-600 italic hover:text-zinc-400"
      } ${missing ? "ring-2 ring-amber-400/70 px-1" : ""}`}>
      {value || placeholder}
    </span>
  );
}

function Row({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="grid grid-cols-[132px_1fr] gap-2 items-start">
      <span className={LABEL + " pt-0.5"}>{label}{required && <span className="text-amber-500 ml-0.5">*</span>}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Collapsible section — collapsed by default, with a summary shown when closed. */
function Section({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={CARD}>
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

// ── GENERAL — always visible ──────────────────────────────────────────────────

function DealLeadPicker({ deal, patch }: { deal: DealRow; patch: (f: Record<string, unknown>) => Promise<void> }) {
  const [users, setUsers] = useState<Array<{ user_id: string; name: string }>>([]);
  useEffect(() => {
    fetch("/api/proxy/tasks/users").then(r => (r.ok ? r.json() : [])).then(setUsers).catch(() => {});
  }, []);
  return (
    <select value={deal.deal_lead_id ?? ""} onChange={e => patch({ deal_lead_id: e.target.value || null })}
      className={SEL_XS + " w-full" + (deal.deal_lead_id ? "" : " ring-2 ring-amber-400/70")}>
      <option value="">—</option>
      {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
    </select>
  );
}

function GeneralSection({ deal, patch, onStage, stageError, busy }: {
  deal: DealRow;
  patch: (f: Record<string, unknown>) => Promise<void>;
  onStage: (s: string) => void;
  stageError: { target_stage: string; missing: string[] } | null;
  busy: boolean;
}) {
  const stages = allStages(CRM_STAGE_GROUPS);
  const daysInStage = deal.date_entered_current_stage
    ? Math.max(0, Math.round((Date.now() - new Date(deal.date_entered_current_stage + "T00:00:00").getTime()) / 86400000))
    : null;
  const status = deal.status ?? "new";
  const systemStatus = !(USER_SETTABLE_STATUSES as readonly string[]).includes(status);
  // Closed Won needs Success Criteria and Closed Lost needs a Category to ENTER
  // the stage — so surface those fields as soon as a move there is attempted
  // (the gate blocks otherwise, and the field would be unreachable).
  const isWon = deal.stage === "Closed Won" || stageError?.target_stage === "Closed Won";
  const isLost = deal.stage === "Closed Lost" || stageError?.target_stage === "Closed Lost";

  return (
    <div className="space-y-3">
      <Field value={deal.title} required onSave={v => v && patch({ title: v })} placeholder="Deal name" />

      <div className={CARD + " p-3 space-y-2.5"}>
        <div className="flex flex-wrap items-center gap-2">
          <select value={deal.stage ?? "Lead"} disabled={busy}
            onChange={e => onStage(e.target.value)} className={SEL}>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border bg-zinc-100 border-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-200">
            <span className={LABEL}>Status</span>
            {deal.stage === "Closed Lost" ? (
              <select value={status} onChange={e => patch({ status: e.target.value })}
                title="Choose the Closed Lost outcome"
                className="bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none text-inherit">
                {["nurture", "lost"].map(v => <option key={v} value={v}>{DEAL_STATUS_LABEL[v] ?? v}</option>)}
              </select>
            ) : systemStatus ? (
              <span title="Set by the stage change, not by hand">{DEAL_STATUS_LABEL[status] ?? status}</span>
            ) : (
              <select value={status} onChange={e => patch({ status: e.target.value })}
                className="bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none text-inherit">
                {USER_SETTABLE_STATUSES.map(v => <option key={v} value={v}>{DEAL_STATUS_LABEL[v]}</option>)}
              </select>
            )}
          </div>

          {deal.urgency && (
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border ${URGENCY_CHIP[deal.urgency] ?? "bg-zinc-100 border-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-300"}`}
              title={`Urgency Flag (auto, read-only) \u2014 ${URGENCY_HELP[deal.urgency] ?? ""}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${URGENCY_DOT[deal.urgency] ?? URGENCY_FALLBACK}`} />
              <span>{URGENCY_LABEL[deal.urgency] ?? deal.urgency}</span>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 opacity-50" aria-hidden><path fillRule="evenodd" d="M10 2a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1V6a4 4 0 0 0-4-4Zm2 6V6a2 2 0 1 0-4 0v2h4Z" clipRule="evenodd"/></svg>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className={LABEL}>Start</span>
            <input type="date" value={dateVal(deal.start_date)} className={DATE_INPUT}
              onChange={e => patch({ start_date: e.target.value || null })} />
          </div>
          <div className="flex items-center gap-1.5"
            title="Moving to Qualification, Initial Assessment or Contract Sent resets this to that stage's standard. Between stage changes it is yours to set.">
            <span className={LABEL}>Expected close</span>
            <input type="date" value={dateVal(deal.expected_close_date)} className={DATE_INPUT}
              onChange={e => patch({ expected_close_date: e.target.value || null })} />
          </div>
          {daysInStage !== null && (
            <div className="flex items-center gap-1.5" title="Time in the current stage">
              <span className={LABEL}>In stage</span>
              <span className="text-sm text-zinc-500 dark:text-zinc-400">{daysInStage}d</span>
            </div>
          )}
          {deal.end_date && (
            <div className="flex items-center gap-1.5" title="Stamped automatically at Closed Won / Closed Lost">
              <span className={LABEL}>End</span>
              <span className="text-sm text-zinc-500 dark:text-zinc-400">{fmtDate(deal.end_date)}</span>
            </div>
          )}
        </div>

        {stageError && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Cannot move to {stageError.target_stage} — complete these first:
            </p>
            <ul className="mt-1 space-y-0.5">
              {stageError.missing.map(m => (
                <li key={m} className="text-[11px] text-amber-700 dark:text-amber-400">• {m}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <Row label="Deal Lead" required>
            <DealLeadPicker deal={deal} patch={patch} />
          </Row>
          <Row label="Deal Source" required>
            <select value={deal.deal_source ?? ""} onChange={e => patch({ deal_source: e.target.value || null })}
              className={SEL_XS + " w-full" + (deal.deal_source ? "" : " ring-2 ring-amber-400/70")}>
              <option value="">—</option>
              {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Row>
          <Row label="Projected Revenue">
            <Field value={deal.projected_revenue != null ? String(deal.projected_revenue) : ""} numeric
              placeholder={money(deal.projected_revenue) ?? "—"}
              onSave={v => patch({ projected_revenue: v ? parseFloat(v) : null })} />
          </Row>
          <Row label="Contract Type">
            <select value={deal.contract_type} onChange={e => patch({ contract_type: e.target.value })}
              className={SEL_XS + " w-full"}>
              <option value="rd_contract">R&amp;D Contract</option>
              <option value="portfolio_contract">Portfolio Contract</option>
            </select>
          </Row>
        </div>

        <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <span className={LABEL + " block mb-1"}>
            Deal Description
            {deal.deal_source === LEAD_SOURCE_OTHER && <span className="text-amber-500 ml-0.5">*</span>}
          </span>
          <Field value={deal.description ?? ""} multiline placeholder="+ Add description"
            required={deal.deal_source === LEAD_SOURCE_OTHER}
            onSave={v => patch({ description: v })} />
        </div>

        {isWon && (
          <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
            <span className={LABEL + " block mb-1"}>Success Criteria<span className="text-amber-500 ml-0.5">*</span></span>
            <Field value={deal.success_criteria ?? ""} multiline required
              placeholder="+ How and why was this won, and what would make them commission the next stage?"
              onSave={v => patch({ success_criteria: v })} />
          </div>
        )}

        {isLost && (
          <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800 space-y-3">
            <div>
              <span className={LABEL + " block mb-1"}>Lost Category<span className="text-amber-500 ml-0.5">*</span></span>
              <select value={deal.closed_lost_category ?? ""}
                onChange={e => patch({ closed_lost_category: e.target.value || null })}
                className={SEL_XS + " w-full" + (deal.closed_lost_category ? "" : " ring-2 ring-amber-400/70")}>
                <option value="">Select a reason…</option>
                {CLOSED_LOST_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <span className={LABEL + " block mb-1"}>
                Lost Reason / Description
                {deal.closed_lost_category === CLOSED_LOST_OTHER && <span className="text-amber-500 ml-0.5">*</span>}
              </span>
              <Field value={deal.closed_lost_reason ?? ""} multiline
                required={deal.closed_lost_category === CLOSED_LOST_OTHER}
                placeholder={deal.closed_lost_category === CLOSED_LOST_OTHER ? "+ Add detail (required)" : "+ Add detail (optional)"}
                onSave={v => patch({ closed_lost_reason: v })} />
            </div>
            {deal.reapproach_date && (
              <div>
                <span className={LABEL + " block mb-1"}>Re-approach</span>
                <span className="text-xs text-zinc-700 dark:text-zinc-300"
                  title="Set automatically from the Closed Lost category clock">
                  {fmtDate(deal.reapproach_date)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workspace links (row above Company) ──────────────────────────────────────

function WorkspaceButtons({ deal }: { deal: DealRow }) {
  // Notebook and Client Portal have their own pages; Drive and Resources do not
  // yet have a CRM-side destination, so they render inactive rather than 404.
  const buttons: { label: string; href: string | null; title: string }[] = [
    { label: "Notebook",      href: "/notebook", title: "Open the notebook" },
    { label: "Drive",         href: null,        title: "No Drive folder linked to this deal yet" },
    { label: "Resources",     href: null,        title: "No resources linked to this deal yet" },
    { label: "Client Portal", href: "/portals",  title: "Open client portals" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {buttons.map(b => b.href ? (
        <Link key={b.label} href={b.href} title={b.title}
          className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors font-medium">
          {b.label}
        </Link>
      ) : (
        <span key={b.label} title={b.title}
          className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-300 dark:text-zinc-600 cursor-not-allowed font-medium">
          {b.label}
        </span>
      ))}
    </div>
  );
}

// ── COMPANY ───────────────────────────────────────────────────────────────────

type CompanyHit = { company_id: string; name: string; industry: string | null; company_location: string | null };

function CompanySearch({ onPick, highlight = true, autoFocus = false }: {
  onPick: (c: CompanyHit) => void;
  // The amber ring means "required and still empty". Reassigning a company that
  // is already set is not that, so the caller turns it off.
  highlight?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/proxy/contacts/companies?search=${encodeURIComponent(term)}`);
        const j = r.ok ? await r.json() : { companies: [] };
        if (alive) setHits((j.companies ?? []).slice(0, 8));
      } catch { if (alive) setHits([]); }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); setSearching(false); };
  }, [q]);

  const term = q.trim();
  const exact = hits.some(c => c.name.toLowerCase() === term.toLowerCase());

  // The company a deal belongs to is often newer than the contacts book, so the
  // dead end of "no matching company" gets a way out, the same one the new-deal
  // picker offers.
  async function createCompany() {
    if (!term || creating) return;
    setCreating(true);
    try {
      const r = await fetch("/api/proxy/contacts/companies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: term }),
      });
      if (r.ok) {
        const c = await r.json();
        setOpen(false);
        onPick({ company_id: c.company_id, name: c.name, industry: null, company_location: null });
      }
    } finally { setCreating(false); }
  }

  return (
    <div className="relative w-full">
      <input value={q} autoFocus={autoFocus} onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search companies…"
        className={INPUT_XS + " w-full" + (highlight ? " ring-2 ring-amber-400/70" : "")} />
      {open && term.length >= 2 && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
          {hits.length === 0 && searching && (
            <p className="px-2 py-1.5 text-xs text-zinc-400">Searching…</p>
          )}
          {hits.map(c => (
            <button key={c.company_id} type="button"
              onMouseDown={e => { e.preventDefault(); onPick(c); setOpen(false); }}
              className="w-full text-left px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              <span className="block text-xs text-zinc-800 dark:text-zinc-200 truncate">{c.name}</span>
              {(c.industry || c.company_location) && (
                <span className="block text-[10px] text-zinc-400 truncate">
                  {[c.industry, c.company_location].filter(Boolean).join(" · ")}
                </span>
              )}
            </button>
          ))}
          {!searching && !exact && (
            <button type="button" disabled={creating}
              onMouseDown={e => { e.preventDefault(); createCompany(); }}
              className="w-full text-left px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 disabled:opacity-50">
              {creating ? "Creating…" : `+ Create company \u201c${term}\u201d`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CompanyPicked({ company, onPick }: {
  company: { company_id: string; name: string };
  onPick: (c: CompanyHit) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="space-y-1">
        <CompanySearch autoFocus highlight={false}
          onPick={c => { setEditing(false); onPick(c); }} />
        <button type="button" onClick={() => setEditing(false)}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Link href={`/contacts/companies/${company.company_id}`}
        className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 min-w-0">
        <span className="truncate">{company.name}</span>
        <svg className="w-3 h-3 opacity-60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
        </svg>
      </Link>
      <button type="button" onClick={() => setEditing(true)} title="Link this deal to a different company"
        className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0">
        Change
      </button>
    </div>
  );
}

type ContactHit = { contact_id: string; name: string | null; email: string | null; organization: string | null };

function ContactSearch({ exclude, onPick }: { exclude: Set<string>; onPick: (c: ContactHit) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(term)}`);
        const j = r.ok ? await r.json() : { contacts: [] };
        if (alive) setHits((j.contacts ?? []).filter((c: ContactHit) => !exclude.has(c.contact_id)).slice(0, 8));
      } catch { if (alive) setHits([]); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative w-full">
      <input value={q} onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="+ Add a contact to this deal…" className={INPUT_XS + " w-full"} />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg">
          {hits.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-400">No matching contact.</p>
          ) : hits.map(c => (
            <button key={c.contact_id} type="button"
              onMouseDown={e => { e.preventDefault(); onPick(c); setOpen(false); setQ(""); }}
              className="w-full text-left px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              <span className="block text-xs text-zinc-800 dark:text-zinc-200 truncate">{c.name ?? "—"}</span>
              {(c.email || c.organization) && (
                <span className="block text-[10px] text-zinc-400 truncate">{[c.organization, c.email].filter(Boolean).join(" · ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CompanySection({ data, patch, reload }: {
  data: DetailPayload;
  patch: (f: Record<string, unknown>) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const { deal, company, contacts } = data;
  const primary = contacts.find(c => c.is_primary) ?? null;

  async function setRole(contactId: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/crm/contacts/${contactId}/buying-role`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    await reload();
  }

  async function linkContact(contactId: string, role: string, isPrimary: boolean) {
    await fetch(`/api/proxy/crm/deals/${deal.deal_id}/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, role, is_primary: isPrimary }),
    });
    await reload();
  }
  async function removeContact(contactId: string) {
    await fetch(`/api/proxy/crm/deals/${deal.deal_id}/contacts/${contactId}`, { method: "DELETE" });
    await reload();
  }
  const linkedIds = new Set(contacts.map(c => c.contact_id));

  const summary = [company?.name ?? deal.company_name, primary?.name].filter(Boolean).join(" · ");

  return (
    <Section title="Company" summary={summary || "No company linked"}>
      <div className="space-y-2.5">
        <Row label="Company" required>
          {company ? (
            <CompanyPicked company={company} onPick={c => patch({ company_id: c.company_id })} />
          ) : (
            <CompanySearch onPick={c => patch({ company_id: c.company_id })} />
          )}
        </Row>

        <Row label="Site Country / Region">
          <select value={deal.site_country_region ?? ""}
            onChange={e => patch({ site_country_region: e.target.value || null })}
            className={SEL_XS + " w-full"}>
            <option value="">—</option>
            {SITE_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </Row>

        <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <span className={LABEL + " block mb-2"}>Contacts {contacts.length > 0 ? `(${contacts.length})` : ""}</span>
          {contacts.length === 0 ? (
            <p className="text-xs text-zinc-400 italic">No contacts linked.</p>
          ) : (
            <div className="space-y-3">
              {contacts.map(c => (
                <div key={c.contact_id} className="flex items-start gap-2">
                  <Avatar name={c.name} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Link href={`/contacts/${c.contact_id}`}
                        className="text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 truncate">
                        {c.name ?? "—"}
                      </Link>
                      {c.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Primary</span>}
                    </div>
                    {c.email && <p className="text-[11px] text-zinc-400 truncate">{c.email}</p>}
                    <div className="grid grid-cols-2 gap-1.5">
                      <select value={c.role_in_decision ?? ""}
                        onChange={e => setRole(c.contact_id, { role_in_decision: e.target.value || null })}
                        className={SEL_XS + " w-full" + (c.is_primary && !c.role_in_decision ? " ring-2 ring-amber-400/70" : "")}>
                        <option value="">Role in decision…</option>
                        {ROLE_IN_DECISION.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <select value={c.contact_function ?? ""}
                        onChange={e => setRole(c.contact_id, { contact_function: e.target.value || null })}
                        className={SEL_XS + " w-full" + (c.is_primary && !c.contact_function ? " ring-2 ring-amber-400/70" : "")}>
                        <option value="">Function…</option>
                        {CONTACT_FUNCTIONS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!c.is_primary && (
                      <button onClick={() => linkContact(c.contact_id, c.role, true)}
                        className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 whitespace-nowrap">Make primary</button>
                    )}
                    <button onClick={() => removeContact(c.contact_id)} title="Remove from deal"
                      className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600">Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2">
            <ContactSearch exclude={linkedIds}
              onPick={c => linkContact(c.contact_id, "contact", contacts.length === 0)} />
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── PLAN ──────────────────────────────────────────────────────────────────────

/** Email plan item: subject + message, plus its (not yet wired) Test / Send actions. */
function EmailAction({ item, onPatch }: { item: PlanItem; onPatch: (fields: Record<string, unknown>) => void }) {
  const bodyValue = item.body ?? "";
  const subjValue = item.email_subject ?? "";
  const [draft, setDraft] = useState(bodyValue);
  const [dirty, setDirty] = useState(false);
  const [subj, setSubj] = useState(subjValue);
  const [subjDirty, setSubjDirty] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { if (!dirty) setDraft(bodyValue); }, [bodyValue, dirty]);
  useEffect(() => { if (!subjDirty) setSubj(subjValue); }, [subjValue, subjDirty]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 140)}px`;
  }, [draft]);

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none">Subject</span>
        <input type="text" value={subj}
          onChange={e => { setSubj(e.target.value); setSubjDirty(true); }}
          onBlur={() => { if (subjDirty) { onPatch({ email_subject: subj.trim() || null }); setSubjDirty(false); } }}
          placeholder="Subject line used when the email is sent"
          className="w-full text-xs text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
      </div>
      <AutoTextarea ref={ref} value={draft}
        onChange={e => { setDraft(e.target.value); setDirty(true); }}
        onBlur={() => { if (dirty) { onPatch({ body: draft.trim() || null }); setDirty(false); } }}
        placeholder="Write the email…"
        className="w-full text-xs leading-relaxed text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 resize-y focus:outline-none focus:ring-1 focus:ring-blue-500/30"
        style={{ minHeight: 140 }} />
      {(dirty || subjDirty) && (
        <span className="text-[10px] text-zinc-400">Unsaved</span>
      )}
    </div>
  );
}

/** Custom task: user-added fields (one-line / text box / date), each with an
 *  editable label. The whole list is saved back as the item's custom_fields. */
function TaskFields({ item, onPatch }: { item: PlanItem; onPatch: (fields: Record<string, unknown>) => void }) {
  const fields: CustomField[] = Array.isArray(item.custom_fields) ? item.custom_fields : [];
  const save = (next: CustomField[]) => onPatch({ custom_fields: next });
  const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `f${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const defaultLabel = (k: CustomField["kind"]) => (k === "line" ? "New field" : k === "textbox" ? "Notes" : "Date");
  const add = (kind: CustomField["kind"]) => save([...fields, { id: newId(), kind, label: defaultLabel(kind), value: null }]);
  const setF = (id: string, patch: Partial<CustomField>) => save(fields.map(f => (f.id === id ? { ...f, ...patch } : f)));
  const removeF = (id: string) => save(fields.filter(f => f.id !== id));

  const BTN = "text-[11px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors";

  return (
    <div className="space-y-2">
      {fields.map(f => (
        <div key={f.id} className="flex items-start gap-2">
          <div className="w-28 shrink-0 pt-0.5">
            <Field value={f.label} placeholder="Label" onSave={v => setF(f.id, { label: v || "Field" })} />
          </div>
          <div className="flex-1 min-w-0">
            {f.kind === "date" ? (
              <input type="date" value={dateVal(f.value)} className={DATE_INPUT + " !text-xs !py-1"}
                onChange={e => setF(f.id, { value: e.target.value || null })} />
            ) : (
              <Field value={f.value ?? ""} multiline={f.kind === "textbox"}
                placeholder={f.kind === "textbox" ? "+ Add text" : "+ Add value"}
                onSave={v => setF(f.id, { value: v })} />
            )}
          </div>
          <button onClick={() => removeF(f.id)} title="Remove field"
            className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 px-1 pt-0.5">✕</button>
        </div>
      ))}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">Add field:</span>
        <button onClick={() => add("line")} className={BTN}>+ One line</button>
        <button onClick={() => add("textbox")} className={BTN}>+ Text box</button>
        <button onClick={() => add("date")} className={BTN}>+ Date</button>
      </div>
    </div>
  );
}

function PlanItemRow({ it, users, patchItem, del, today, expanded, onToggle }: {
  it: PlanItem;
  users: Array<{ user_id: string; name: string }>;
  patchItem: (id: string, fields: Record<string, unknown>) => Promise<void>;
  del: (id: string) => void;
  today: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isOverdue = it.status === "open" && !!it.due_date && it.due_date < today;
  const label = PLAN_ITEM_TYPES.find(t => t.key === it.item_type)?.label ?? it.item_type;
  const shownDate = it.status === "open" ? it.due_date : (it.resolved_on ?? it.due_date);
  return (
    <div className={`rounded-lg border ${isOverdue ? "border-red-300 dark:border-red-800/60 bg-red-50/50 dark:bg-red-950/10" : "border-zinc-200 dark:border-zinc-800"}`}>
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 rounded-lg">
        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0">{label}</span>
        <span className="min-w-0 flex-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate">
          {it.title || <span className="italic text-zinc-400">{`Untitled ${label.toLowerCase()}`}</span>}
        </span>
        {it.status !== "open" && <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0 capitalize">{it.status}</span>}
        {isOverdue && <span className="text-[10px] font-medium text-red-600 dark:text-red-400 shrink-0">Overdue</span>}
        {shownDate && <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">{shownDate}</span>}
        <svg className={`w-3 h-3 shrink-0 text-zinc-400 transition-transform ${expanded ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2">
              <div>
                <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none block mb-0.5">Name</span>
                <Field value={it.title ?? ""} placeholder={`${label} name`}
                  onSave={v => patchItem(it.plan_item_id, { title: v })} />
              </div>
              <Field value={it.description ?? ""} placeholder="+ Add a description"
                onSave={v => patchItem(it.plan_item_id, { description: v })} />
              <div className="flex items-end gap-2 flex-wrap">
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                  {label}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none">Status</span>
                  <select value={it.status} onChange={e => patchItem(it.plan_item_id, { status: e.target.value })}
                    className={SEL_XS}>
                    {planStatusesFor(it.item_type).map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none">Owner</span>
                  <select value={it.owner_id ?? ""} onChange={e => patchItem(it.plan_item_id, { owner_id: e.target.value || null })}
                    className={SEL_XS}>
                    <option value="">—</option>
                    {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none">Due date</span>
                  <input type="date" value={dateVal(it.due_date)} className={DATE_INPUT + " !text-xs !py-1"}
                    onChange={e => patchItem(it.plan_item_id, { due_date: e.target.value || null })} />
                </div>
                {(it.status === "done" || it.status === "cancelled") && (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 leading-none">{it.status === "done" ? "Done on" : "Cancelled on"}</span>
                    <input type="date" value={dateVal(it.resolved_on)} className={DATE_INPUT + " !text-xs !py-1"}
                      onChange={e => patchItem(it.plan_item_id, { resolved_on: e.target.value || null })} />
                  </div>
                )}
                {isOverdue && <span className="text-[10px] font-medium text-red-600 dark:text-red-400 self-end pb-1">Overdue</span>}
                <button onClick={() => del(it.plan_item_id)}
                  title="Delete this plan item"
                  className="ml-auto text-[10px] text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 px-1">✕</button>
              </div>

              {it.item_type === "next_step" && (
                <Field value={it.body ?? ""} placeholder="+ The single next action, written so someone else could carry it out"
                  onSave={v => patchItem(it.plan_item_id, { body: v })} />
              )}

              {it.item_type === "email" && (
                <EmailAction item={it} onPatch={fields => patchItem(it.plan_item_id, fields)} />
              )}

              {it.item_type === "task" && (
                <TaskFields item={it} onPatch={fields => patchItem(it.plan_item_id, fields)} />
              )}

              {it.item_type === "first_touch" && (
                it.email_enabled ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Email</span>
                      <button onClick={() => patchItem(it.plan_item_id, { email_enabled: false })}
                        className="text-[10px] text-zinc-400 hover:text-red-500">Remove email</button>
                    </div>
                    <EmailAction item={it} onPatch={fields => patchItem(it.plan_item_id, fields)} />
                  </div>
                ) : (
                  <button onClick={() => patchItem(it.plan_item_id, { email_enabled: true })}
                    className="text-[11px] px-2 py-1 rounded border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                    + Add email
                  </button>
                )
              )}

              {it.item_type === "nda" && (
                <Row label="Signed">
                  <input type="date" value={dateVal(it.nda_signed_date)} className={DATE_INPUT + " !text-xs !py-1"}
                    onChange={e => patchItem(it.plan_item_id, { nda_signed_date: e.target.value || null })} />
                </Row>
              )}

              {it.item_type === "feasibility_study" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Row label="Target"><input type="date" value={dateVal(it.fs_target_date)} className={DATE_INPUT + " !text-xs !py-1"}
                    onChange={e => patchItem(it.plan_item_id, { fs_target_date: e.target.value || null })} /></Row>
                  <Row label="Completed"><input type="date" value={dateVal(it.fs_date_completed)} className={DATE_INPUT + " !text-xs !py-1"}
                    onChange={e => patchItem(it.plan_item_id, { fs_date_completed: e.target.value || null })} /></Row>
                  <Row label="Sent to client"><input type="date" value={dateVal(it.fs_date_sent_to_client)} className={DATE_INPUT + " !text-xs !py-1"}
                    onChange={e => patchItem(it.plan_item_id, { fs_date_sent_to_client: e.target.value || null })} /></Row>
                  <Row label="Analysis link">
                    <Field value={it.fs_analysis_link ?? ""} placeholder="+ Link to the analysis record"
                      onSave={v => patchItem(it.plan_item_id, { fs_analysis_link: v })} />
                  </Row>
                </div>
              )}
        </div>
      )}
    </div>
  );
}

function PlanActivity({ dealId, items, reload, deal }: {
  dealId: string; items: PlanItem[]; reload: () => Promise<void>; deal: DealRow;
}) {
  const [users, setUsers] = useState<Array<{ user_id: string; name: string }>>([]);
  useEffect(() => {
    fetch("/api/proxy/tasks/users").then(r => (r.ok ? r.json() : [])).then(setUsers).catch(() => {});
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  // Plan rows collapse like the activity rows; a freshly added one opens itself.
  const [expandedPlan, setExpandedPlan] = useState<Set<string>>(new Set());
  const togglePlan = (id: string) =>
    setExpandedPlan(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  async function add(itemType: string) {
    const r = await fetch(`/api/proxy/crm/deals/${dealId}/plan-items`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_type: itemType }),
    });
    try {
      const row = await r.json();
      if (row?.plan_item_id) setExpandedPlan(prev => new Set(prev).add(row.plan_item_id));
    } catch { /* still shows, just collapsed */ }
    await reload();
  }
  async function patchItem(id: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/crm/plan-items/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    await reload();
  }
  async function del(id: string) {
    const item = items.find(i => i.plan_item_id === id);
    const label = PLAN_ITEM_TYPES.find(t => t.key === item?.item_type)?.label ?? "plan item";
    const name = item?.title ? `"${item.title}"` : `this ${label.toLowerCase()}`;
    if (!window.confirm(`Delete ${name}? This can't be undone.`)) return;
    const r = await fetch(`/api/proxy/crm/plan-items/${id}`, { method: "DELETE" });
    if (!r.ok) { window.alert("Could not delete the plan item. Please try again."); return; }
    await reload();
  }

  // Plan items join the Activity feed as dated rows, newest first.
  const feedExtras = items.map(it => ({
    key: `plan:${it.plan_item_id}`,
    open: it.status === "open",
    date: it.status === "open" ? it.created_at : (it.resolved_on ?? it.created_at),
    node: <PlanItemRow it={it} users={users} patchItem={patchItem} del={del} today={today}
      expanded={expandedPlan.has(it.plan_item_id)} onToggle={() => togglePlan(it.plan_item_id)} />,
  }));

  // Standalone quick-adders. First Touch / First Follow-up are email intents and
  // live in the Activity toolbar instead, so they are not repeated here.
  const planButtons = (
    <>
      {PLAN_ITEM_TYPES.filter(t => !["first_touch", "email", "task"].includes(t.key)).map(t => (
        <button key={t.key} onClick={() => add(t.key)}
          className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
          + {t.label}
        </button>
      ))}
      <button onClick={() => add("task")} title="A task with an editable name and custom fields"
        className="text-[11px] px-2.5 py-1 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
        + Custom
      </button>
    </>
  );

  return (
    <EntityActivity entityType="deal" entityId={dealId}
      assignedTo={deal.deal_lead_id ?? null} onChanged={reload}
      title="Plan & Activity"
      feedExtras={feedExtras}
      planButtons={planButtons}
      requireOpenTask={!["Closed Won", "Closed Lost"].includes(deal.stage ?? "")} />
  );
}


// ── STAGE HISTORY — its own read-only block ──────────────────────────────────

function StageHistorySection({ history }: { history: StageHistoryEntry[] }) {
  const summary = history.length > 0
    ? `${history.length} change${history.length === 1 ? "" : "s"}`
    : "No changes yet";
  return (
    <Section title="Stage History" summary={summary}>
      {history.length === 0 ? (
        <p className="text-xs text-zinc-400 italic">No stage changes recorded.</p>
      ) : (
        <ol className="space-y-1.5">
          {[...history].sort((a, b) => (a.changed_at < b.changed_at ? 1 : a.changed_at > b.changed_at ? -1 : 0)).map(h => (
            <li key={h.stage_history_id} className="flex items-center gap-2 text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" />
              <span className="text-zinc-700 dark:text-zinc-300">
                {h.stage_from ? `${h.stage_from} → ${h.stage_to}` : `Created at ${h.stage_to}`}
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 shrink-0">
                <span className="tabular-nums">{fmtDateTime(h.changed_at)}</span>
                {h.changed_by_name && <span>by {h.changed_by_name}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[10px] text-zinc-300 dark:text-zinc-600 italic">Read-only — every stage change is recorded.</p>
    </Section>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function DealDetailView({ dealId, onUpdate, onDeleted }: { dealId: string; onUpdate?: () => void; onDeleted?: () => void }) {
  const [data, setData] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stageError, setStageError] = useState<{ target_stage: string; missing: string[] } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/crm/deals/${dealId}/detail`);
    if (r.ok) setData(await r.json());
    setLoading(false);
  }, [dealId]);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (fields: Record<string, unknown>) => {
    await fetch(`/api/proxy/crm/deals/${dealId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    await load();
    onUpdate?.();
  }, [dealId, load, onUpdate]);

  const reload = useCallback(async () => { await load(); onUpdate?.(); }, [load, onUpdate]);

  // Stage moves go through the gate — a 422 lists every missing field.
  const onStage = useCallback(async (target: string) => {
    setBusy(true);
    setStageError(null);
    try {
      const r = await fetch(`/api/proxy/crm/deals/${dealId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: target }),
      });
      if (r.status === 422) {
        const j = await r.json();
        const d = j?.detail ?? {};
        setStageError({ target_stage: d.target_stage ?? target, missing: d.missing ?? [] });
      } else {
        await load();
        onUpdate?.();
      }
    } finally {
      setBusy(false);
    }
  }, [dealId, load, onUpdate]);

  const onDelete = useCallback(async () => {
    const isArchived = !!data?.deal?.archived;
    const msg = isArchived
      ? "Permanently delete this deal? This cannot be undone \u2014 the deal and all of its plan items, contacts and history will be erased."
      : "Delete this deal? It will be moved to Archived (you can restore or permanently delete it from there).";
    if (!window.confirm(msg)) return;
    await fetch(`/api/proxy/crm/deals/${dealId}`, { method: "DELETE" });
    onDeleted?.();
  }, [dealId, onDeleted, data]);

  if (loading || !data) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-sm text-zinc-400 dark:text-zinc-500">Loading deal…</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-3">
      <GeneralSection deal={data.deal} patch={patch} onStage={onStage} stageError={stageError} busy={busy} />
      <WorkspaceButtons deal={data.deal} />
      <CompanySection data={data} patch={patch} reload={reload} />
      <div className="space-y-3">
        <EntityContacts entityType="deal" entityId={dealId}
          entityName={data.deal.company_name ?? data.deal.title ?? null} onChanged={reload} />
        <PlanActivity dealId={dealId} items={data.plan_items} reload={reload} deal={data.deal} />
      </div>
      <StageHistorySection history={data.stage_history} />

      {onDeleted && (
        <div className="pt-2 flex justify-end">
          <button onClick={onDelete}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium ${data.deal.archived
              ? "border-red-600 bg-red-600 text-white hover:bg-red-700"
              : "border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20"}`}>
            {data.deal.archived ? "Delete permanently" : "Delete deal"}
          </button>
        </div>
      )}
    </div>
  );
}
