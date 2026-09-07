"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { DealDetailView } from "@/components/crm/DealDetailView";
import { CRM_STAGE_GROUPS, findGroup, DEAL_STATUS_LABEL, URGENCY_DOT, URGENCY_LABEL, URGENCY_FALLBACK, STAGE_INFO, type StageGroup } from "@/lib/contractStages";
import KnowledgeBase from "@/components/crm/KnowledgeBase";
import { CommsSettings } from "@/components/comms/CommsSettings";

import { AutoTextarea } from "@/components/AutoTextarea";
const CHEVRON = "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.4rem_center] bg-[length:1rem]";
const SEL = `w-full text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 pr-8 ${CHEVRON}`;
const INPUT = "w-full bg-white dark:bg-white/5 border border-gray-300 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Deal = {
  deal_id: string;
  title: string;
  stage: string | null;
  status: string | null;
  contract_type: string;
  description: string | null;
  company_id: string | null;
  company_name: string | null;
  primary_contact_name: string | null;
  deal_lead_name: string | null;
  projected_revenue: number | string | null;
  expected_close_date: string | null;
  end_date: string | null;
  date_entered_current_stage: string | null;
  last_activity_at: string | null;
  last_activity_kind: string | null;
  urgency: string | null;
  open_next_steps: number;
  overdue_next_steps: number;
  created_at: string;
  updated_at: string;
};

type ContractType = "rd_contract" | "portfolio_contract";

type SortMode = "close_date" | "status";

// Order used when a column is sorted by status.
const STATUS_ORDER: Record<string, number> = {
  new: 0, awaiting_internal: 1, awaiting_client: 2, won: 3, nurture: 4, lost: 5,
};

function sortDeals(deals: Deal[], mode: SortMode): Deal[] {
  const list = [...deals];
  if (mode === "status") {
    list.sort((a, b) => {
      const ra = STATUS_ORDER[a.status ?? ""] ?? 99;
      const rb = STATUS_ORDER[b.status ?? ""] ?? 99;
      return ra - rb;
    });
  } else {
    list.sort((a, b) => {
      const x = a.expected_close_date, y = b.expected_close_date;
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  return list;
}

const ACTIVITY_LABEL: Record<string, string> = {
  email: "Emailed", meeting: "Met", touch: "Contacted", task: "Task done",
};

// Compact relative age for the card preview ("today", "3d ago", "2mo ago").
function relTimeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function money(v: number | string | null): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>;
}
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className={`w-3.5 h-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
function SortIcon() {
  return <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 6h13M3 12h9M3 18h5m9-3v6m0 0l3-3m-3 3l-3-3" /></svg>;
}
function CloseIcon() {
  return <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>;
}

// ── Deal Card ─────────────────────────────────────────────────────────────────

function MiniAvatar({ name }: { name: string }) {
  const initials = name.split(" ").map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return (
    <div className="w-4 h-4 rounded bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-[9px] font-bold text-zinc-600 dark:text-zinc-300 shrink-0">
      {initials}
    </div>
  );
}

function StageInfoIcon({ stage, header }: { stage: string; header: string }) {
  const info = STAGE_INFO[stage];
  if (!info) return null;
  return (
    <span className="relative group/info inline-flex items-center" onClick={e => e.stopPropagation()}>
      <svg viewBox="0 0 20 20" fill="currentColor" aria-label={`About ${stage}`}
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help">
        <path fillRule="evenodd" clipRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v5a1 1 0 11-2 0V9zm1-4.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z" />
      </svg>
      <span role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-30 hidden group-hover/info:block w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2.5 shadow-lg normal-case tracking-normal">
        <span className={`block text-[11px] font-semibold ${header}`}>{stage}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-gray-600 dark:text-gray-300 font-normal">{info.description}</span>
        <span className="mt-1.5 block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 font-normal">{info.requirements}</span>
      </span>
    </span>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const revenue = money(deal.projected_revenue);
  // Side marker reflects the deal's status, using the same colours as the
  // status pill in the detail view.
  const status = deal.status ?? "new";
  // The preview surfaces how recently the deal was worked — the last email,
  // meeting or completed task. Time-in-stage now lives in the detail view.
  const lastActivity = deal.last_activity_at ? relTimeAgo(deal.last_activity_at) : null;
  const lastActivityLabel = ACTIVITY_LABEL[deal.last_activity_kind ?? ""] ?? "Last activity";
  const statusLabel = DEAL_STATUS_LABEL[status] ?? status;
  // Colour comes from the read-only Urgency Flag, not from Status directly.
  const urgency = deal.urgency ?? null;
  const flagColor = (urgency && URGENCY_DOT[urgency]) || URGENCY_FALLBACK;
  const flagLabel = urgency ? (URGENCY_LABEL[urgency] ?? urgency) : statusLabel;
  return (
    <div className="relative group/card bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 hover:shadow-sm hover:border-zinc-300 dark:hover:border-zinc-600 transition-all cursor-grab active:cursor-grabbing">
      <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded ${flagColor}`} title={`Urgency: ${flagLabel} | Status: ${statusLabel}`} />
      <div className="pl-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-900 dark:text-white truncate" title={deal.title}>{deal.title}</p>
          {deal.company_name && deal.company_name !== deal.title && (
            <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate" title={deal.company_name}>{deal.company_name}</p>
          )}
          {/* Status + revenue + owner — read-only preview; edits live in the detail view */}
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${flagColor}`} title={`Urgency: ${flagLabel}`} />
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">{statusLabel}</span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {revenue && (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">{revenue}</span>
              )}
              {deal.deal_lead_name && (
                <div className="flex items-center gap-1" title={`Owner: ${deal.deal_lead_name}`}>
                  <MiniAvatar name={deal.deal_lead_name} />
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[64px]">{deal.deal_lead_name.split(" ")[0]}</span>
                </div>
              )}
            </div>
          </div>
          {deal.primary_contact_name && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-2">
              <MiniAvatar name={deal.primary_contact_name} />
              <span className="truncate flex-1" title={`Contact: ${deal.primary_contact_name}`}>{deal.primary_contact_name}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title="Most recent email, meeting or completed task">
                {lastActivity ? `${lastActivityLabel} ${lastActivity}` : "No activity yet"}
              </span>
              {deal.overdue_next_steps > 0 && (
                <span className="text-[10px] font-medium text-red-600 dark:text-red-400"
                  title="Open Next Steps past their due date">
                  {deal.overdue_next_steps} overdue
                </span>
              )}
              {deal.open_next_steps === 0 && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400" title="Every open deal needs at least one open task">
                  no open task
                </span>
              )}
            </div>
        </div>
      </div>
    </div>
  );
}

// ── New Deal Modal ────────────────────────────────────────────────────────────

function NewDealCompanyPicker({ onPick }: { onPick: (id: string, name: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Array<{ company_id: string; name: string; industry: string | null }>>([]);
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
        if (alive) setHits((j.companies ?? []).slice(0, 6));
      } catch { if (alive) setHits([]); }
      finally { if (alive) setSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  const term = q.trim();
  const exact = hits.some(c => c.name.toLowerCase() === term.toLowerCase());

  async function createCompany() {
    if (!term || creating) return;
    setCreating(true);
    try {
      const r = await fetch("/api/proxy/contacts/companies", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: term }),
      });
      if (r.ok) { const c = await r.json(); onPick(c.company_id, c.name); }
    } finally { setCreating(false); }
  }

  return (
    <div>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search companies…" className={INPUT} />
      {term.length >= 2 && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-gray-200 dark:border-white/10">
          {hits.map(c => (
            <button key={c.company_id} type="button" onClick={() => onPick(c.company_id, c.name)}
              className="w-full text-left px-2 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-white/5 text-gray-800 dark:text-gray-200 truncate">
              {c.name}{c.industry ? ` · ${c.industry}` : ""}
            </button>
          ))}
          {!searching && !exact && (
            <button type="button" onClick={createCompany} disabled={creating}
              className="w-full text-left px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 disabled:opacity-50">
              {creating ? "Creating…" : `+ Create company \u201c${term}\u201d`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewDealModal({
  initialStage,
  stageGroups,
  contractType,
  onClose,
  onCreated,
}: {
  initialStage: string;
  stageGroups: StageGroup[];
  contractType: ContractType;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [stage, setStage] = useState(initialStage);
  const [expectedClose, setExpectedClose] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const allStages = stageGroups.flatMap(g => g.stages);
  const ecdRequired = allStages.indexOf(stage) >= allStages.indexOf("Qualification");

  // Deal name mirrors the company; still editable afterward.
  function pickCompany(id: string, name: string) {
    setCompanyId(id);
    setCompanyName(name);
    setTitle(name);
  }

  async function submit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!companyId) { setErr("Pick or create a company"); return; }
    if (!title.trim()) { setErr("Name is required"); return; }
    setSaving(true);
    setErr("");
    const r = await fetch("/api/proxy/crm/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        company_id: companyId,
        stage,
        contract_type: contractType,
        expected_close_date: expectedClose || null,
        description: description.trim() || null,
      }),
    });
    if (r.ok) {
      onCreated();
    } else {
      setErr("Failed to create");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={submit}
        className="bg-white dark:bg-[#141824] border border-gray-200 dark:border-white/10 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-white/8">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">
            New {contractType === "portfolio_contract" ? "Portfolio" : "R&D"} Contract
          </h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><CloseIcon /></button>
        </div>
        <div className="p-5 space-y-3">
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Company *</label>
            {companyId ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-900 dark:text-white truncate">{companyName}</span>
                <button type="button" onClick={() => { setCompanyId(null); setCompanyName(""); }}
                  className="text-xs text-gray-400 hover:text-gray-600">change</button>
              </div>
            ) : (
              <NewDealCompanyPicker onPick={pickCompany} />
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Name *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} className={INPUT} />
            <p className="mt-1 text-[10px] text-gray-400">Auto-filled from the company — edit if the deal needs its own name.</p>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Stage</label>
            <select value={stage} onChange={e => setStage(e.target.value)} className={SEL}>
              {allStages.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Expected close date{ecdRequired && <span className="text-amber-500 ml-0.5">*</span>}
            </label>
            <input type="date" value={expectedClose} onChange={e => setExpectedClose(e.target.value)} className={INPUT} />
            {ecdRequired && !expectedClose && (
              <p className="mt-1 text-[10px] text-gray-400">Leave blank to auto-seed a default when the deal is created.</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <AutoTextarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
              className="w-full bg-white dark:bg-white/5 border border-gray-300 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white resize-none" />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button type="button" onClick={onClose}
            className="px-4 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-white/8 dark:hover:bg-white/12 text-sm text-gray-600 dark:text-gray-300 rounded-lg">Cancel</button>
          <button type="submit" disabled={saving}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-sm text-white rounded-lg disabled:opacity-50">
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Deal Drawer (mirrors the Projects slide-over) ─────────────────────────────

function DealDrawer({ dealId, onClose, onUpdate, onDeleted }: { dealId: string; onClose: () => void; onUpdate: () => void; onDeleted: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [width, setWidth] = useState(768);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => { setTimeout(() => setMounted(true), 10); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    e.preventDefault();

    function onMove(ev: MouseEvent) {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      const next = Math.min(Math.max(startW.current + delta, 360), window.innerWidth - 80);
      setWidth(next);
    }
    function onUp() {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/20 dark:bg-black/40 z-40 backdrop-blur-[1px]" onClick={onClose} />
      <div
        style={{ width }}
        className={`fixed top-0 right-0 bottom-0 z-50 bg-white dark:bg-zinc-950 shadow-2xl flex flex-col transition-transform duration-300 ${mounted ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Drag handle */}
        <div
          onMouseDown={onMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize group z-10 hover:bg-blue-400/30 active:bg-blue-400/50 transition-colors"
          title="Drag to resize"
        />
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <button onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex-shrink-0"
            title="Close (Esc)">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <DealDetailView dealId={dealId} onUpdate={onUpdate} onDeleted={onDeleted} />
        </div>
      </div>
    </>
  );
}

// ── Contract Pipeline Board ───────────────────────────────────────────────────

function ContractBoard({
  stageGroups,
  contractType,
  emptyLabel,
  archived = false,
}: {
  stageGroups: StageGroup[];
  contractType: ContractType;
  emptyLabel: string;
  archived?: boolean;
}) {
  const [byGroup, setByGroup] = useState<Record<string, Deal[]>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<Record<string, SortMode>>({});
  const [newStage, setNewStage] = useState<string | null>(null);
  const [openDealId, setOpenDealId] = useState<string | null>(null);
  const [gateError, setGateError] = useState<{ deal: string; target: string; missing: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const collapseInit = useRef(false);

  const fetchBoard = useCallback(async () => {
    // NB: deliberately no setLoading(true) here — a refetch must not blank the
    // board, because that unmounts an open DealDrawer and remounts it in a loop.
    const r = await fetch(`/api/proxy/crm/deals?contract_type=${contractType}${archived ? "&archived=true" : ""}`);
    if (r.ok) {
      const payload = await r.json();
      const list: Deal[] = payload.deals ?? [];
      const grouped: Record<string, Deal[]> = {};
      for (const g of stageGroups) grouped[g.parent] = [];
      for (const d of list) {
        const stage = d.stage ?? stageGroups[0]?.stages[0] ?? "";
        const group = findGroup(stage, stageGroups);
        const key = group?.parent ?? stageGroups[0]?.parent ?? "";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(d);
      }
      // Sorting is applied per-column at render time (see sortMode).
      setByGroup(grouped);
      // Apply autoCollapse defaults once only — re-applying on every refetch
      // would snap the user's expanded columns shut after each edit.
      if (!collapseInit.current) {
        collapseInit.current = true;
        setCollapsed(new Set(stageGroups.filter(g => g.autoCollapse).map(g => g.parent)));
      }
    }
    setLoading(false);
  }, [stageGroups, contractType, archived]);

  useEffect(() => { fetchBoard(); }, [fetchBoard]);

  function toggleCollapse(parent: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(parent) ? next.delete(parent) : next.add(parent);
      return next;
    });
  }

  async function moveCard(dealId: string, toGroup: StageGroup) {
    const newStageVal = toGroup.stages[0];
    const fromGroup = stageGroups.find(g => (byGroup[g.parent] ?? []).some(d => d.deal_id === dealId));
    if (!fromGroup || fromGroup.parent === toGroup.parent) return;
    const moving = (byGroup[fromGroup.parent] ?? []).find(d => d.deal_id === dealId);
    setGateError(null);

    // Optimistic local update
    setByGroup(prev => {
      const next = { ...prev };
      const deal = (next[fromGroup.parent] ?? []).find(d => d.deal_id === dealId);
      if (!deal) return prev;
      next[fromGroup.parent] = (next[fromGroup.parent] ?? []).filter(d => d.deal_id !== dealId);
      next[toGroup.parent] = [{ ...deal, stage: newStageVal }, ...(next[toGroup.parent] ?? [])];
      return next;
    });

    // The server owns the stage gate. On 422 revert the optimistic move and
    // show exactly which fields are missing.
    const r = await fetch(`/api/proxy/crm/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: newStageVal }),
    });
    if (r.status === 422) {
      const j = await r.json().catch(() => null);
      const d = j?.detail ?? {};
      setGateError({
        deal: moving?.title ?? "This deal",
        target: d.target_stage ?? newStageVal,
        missing: d.missing ?? [],
      });
      await fetchBoard();
    } else if (!r.ok) {
      await fetchBoard();
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><p className="text-sm text-gray-500">Loading…</p></div>;
  }

  return (
    <>
      {gateError && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {gateError.deal} cannot move to {gateError.target} — complete these first:
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {gateError.missing.map(m => (
                <li key={m} className="text-[11px] text-amber-700 dark:text-amber-400">• {m}</li>
              ))}
            </ul>
          </div>
          <button onClick={() => setGateError(null)}
            className="text-amber-600 hover:text-amber-800 dark:hover:text-amber-300 text-xs shrink-0">✕</button>
        </div>
      )}
      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-2 p-4 h-full min-w-max items-start">
          {stageGroups.map(group => {
            const mode = sortMode[group.parent] ?? "close_date";
            const deals = sortDeals(byGroup[group.parent] ?? [], mode);
            const st = group.color;
            const isCollapsed = collapsed.has(group.parent);

            return (
              <div key={group.parent} className={`flex flex-col shrink-0 transition-all ${isCollapsed ? "w-10" : "w-60"}`}>
                {/* Column header */}
                <div
                  className={`flex items-center gap-1.5 mb-2 px-1 cursor-pointer select-none ${isCollapsed ? "flex-col gap-2" : "justify-between"}`}
                  onClick={() => toggleCollapse(group.parent)}
                  title={isCollapsed ? `Expand ${group.parent}` : `Collapse ${group.parent}`}
                >
                  {isCollapsed ? (
                    <>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide ${st.header} whitespace-nowrap`}
                        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                      >
                        {group.parent}
                      </span>
                      <span className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">{deals.length}</span>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                        <span className={`text-xs font-semibold uppercase tracking-wide ${st.header}`}>{group.parent}</span>
                        <StageInfoIcon stage={group.parent} header={st.header} />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400 dark:text-gray-600 tabular-nums">{deals.length}</span>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            setSortMode(prev => ({ ...prev, [group.parent]: mode === "status" ? "close_date" : "status" }));
                          }}
                          className={`transition-colors ml-0.5 p-0.5 ${mode === "status" ? st.header : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}
                          title={mode === "status" ? "Sorted by status — click to sort by close date" : "Sort by status"}
                        >
                          <SortIcon />
                        </button>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            setNewStage(group.stages[group.stages.length - 1]);
                          }}
                          className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors ml-0.5 p-0.5"
                          title={`Add to ${group.parent}`}
                        >
                          <PlusIcon />
                        </button>
                        <ChevronIcon collapsed={false} />
                      </div>
                    </>
                  )}
                </div>

                {/* Cards — drop zone */}
                {!isCollapsed && (
                  <div
                    className={`flex flex-col gap-2 flex-1 overflow-y-auto pr-0.5 rounded-lg transition-colors ${draggedId && dragOverGroup === group.parent ? `${st.bg} ring-1 ring-inset ${st.card}` : ""}`}
                    onDragOver={e => { e.preventDefault(); setDragOverGroup(group.parent); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverGroup(null); }}
                    onDrop={e => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("dealId");
                      if (id) moveCard(id, group);
                      setDraggedId(null); setDragOverGroup(null);
                    }}
                  >
                    {deals.length === 0 ? (
                      <div className={`border border-dashed rounded-lg p-4 text-center transition-colors ${draggedId && dragOverGroup === group.parent ? `${st.card} border-solid` : "border-gray-200 dark:border-white/8"}`}>
                        <p className="text-xs text-gray-400 dark:text-gray-600">{emptyLabel}</p>
                      </div>
                    ) : deals.map(d => (
                      <div
                        key={d.deal_id}
                        draggable
                        onDragStart={e => { e.dataTransfer.setData("dealId", d.deal_id); e.dataTransfer.effectAllowed = "move"; setDraggedId(d.deal_id); }}
                        onDragEnd={() => { setDraggedId(null); setDragOverGroup(null); }}
                        onClick={() => setOpenDealId(d.deal_id)}
                        className={`transition-opacity ${draggedId === d.deal_id ? "opacity-40" : "opacity-100"}`}
                      >
                        <DealCard deal={d} />
                      </div>
                    ))}
                  </div>
                )}

                {/* Collapsed pill */}
                {isCollapsed && deals.length > 0 && (
                  <div className={`mt-1 rounded-lg ${st.bg} border ${st.card} flex items-center justify-center py-4`}
                    style={{ minHeight: "60px" }}>
                    <span className={`text-xs font-semibold ${st.header}`}>{deals.length}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Deal detail window */}
      {openDealId && (
        <DealDrawer
          dealId={openDealId}
          onClose={() => setOpenDealId(null)}
          onUpdate={fetchBoard}
          onDeleted={() => { setOpenDealId(null); fetchBoard(); }}
        />
      )}

      {/* New deal modal */}
      {newStage && (
        <NewDealModal
          initialStage={newStage}
          stageGroups={stageGroups}
          contractType={contractType}
          onClose={() => setNewStage(null)}
          onCreated={() => { setNewStage(null); fetchBoard(); }}
        />
      )}

    </>
  );
}



// ── Main Page ─────────────────────────────────────────────────────────────────

type MainTab = "rd_contracts" | "portfolio_contracts" | "knowledge_base" | "settings";

export default function CRMPage() {
  const [tab, setTab] = useState<MainTab>("rd_contracts");
  const [archived, setArchived] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [ioBusy, setIoBusy] = useState<null | "import" | "export">(null);
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const contractType = tab === "portfolio_contracts" ? "portfolio_contract" : "rd_contract";

  useEffect(() => {
    if (!ioMsg) return;
    const t = setTimeout(() => setIoMsg(null), 6000);
    return () => clearTimeout(t);
  }, [ioMsg]);

  async function exportDeals() {
    setIoBusy("export");
    try {
      const r = await fetch(`/api/proxy/crm/deals/export?contract_type=${contractType}${archived ? "&archived=true" : ""}`);
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `crm_${archived ? "archived_" : ""}${contractType}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setIoMsg("Export failed \u2014 please try again.");
    } finally {
      setIoBusy(null);
    }
  }

  async function importDeals(file: File) {
    setIoBusy("import"); setIoMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/proxy/crm/deals/import?contract_type=${contractType}`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || "Import failed");
      const bits = [`Imported ${j.created} deal${j.created === 1 ? "" : "s"}`];
      if (j.skipped) bits.push(`skipped ${j.skipped}`);
      if (j.error_count) bits.push(`${j.error_count} error${j.error_count === 1 ? "" : "s"}`);
      setIoMsg(bits.join(" \u00b7 "));
      setReloadKey(k => k + 1);
    } catch (e) {
      setIoMsg(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setIoBusy(null);
    }
  }

  const TAB_CONFIG: { key: MainTab; label: string }[] = [
    { key: "rd_contracts",        label: "R&D Contracts" },
    { key: "portfolio_contracts", label: "Portfolio Contracts" },
    { key: "knowledge_base",      label: "Knowledge Base" },
    { key: "settings",            label: "Settings" },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-white/8 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-white/8 rounded-lg p-0.5">
            {TAB_CONFIG.map(({ key, label }) => (
              <button key={key} onClick={() => setTab(key)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${tab === key ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {(tab === "rd_contracts" || tab === "portfolio_contracts") && (
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) importDeals(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={ioBusy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border text-gray-500 dark:text-gray-400 border-gray-200 dark:border-white/10 hover:text-gray-700 hover:border-gray-300 dark:hover:text-gray-200 disabled:opacity-50 transition-colors"
              title="Import deals from a CSV (columns matched by name: company, title, stage, status, deal_lead, deal_source, projected_revenue, start_date, expected_close_date)">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
              {ioBusy === "import" ? "Importing…" : "Import"}
            </button>
            <button onClick={exportDeals} disabled={ioBusy !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border text-gray-500 dark:text-gray-400 border-gray-200 dark:border-white/10 hover:text-gray-700 hover:border-gray-300 dark:hover:text-gray-200 disabled:opacity-50 transition-colors"
              title="Download the current board as a CSV">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5 5 5M12 4v12" /></svg>
              {ioBusy === "export" ? "Exporting…" : "Export"}
            </button>
            <button onClick={() => setArchived(a => !a)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${archived ? "bg-zinc-800 text-white border-zinc-800 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-200" : "text-gray-500 dark:text-gray-400 border-gray-200 dark:border-white/10 hover:text-gray-700 hover:border-gray-300 dark:hover:text-gray-200"}`}
              title={archived ? "Showing archived deals — click to return to the active board" : "Show archived deals"}>
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M3 4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4Zm1 4h12l-.6 7.2A2 2 0 0 1 13.4 17H6.6a2 2 0 0 1-2-1.8L4 8Zm4 2a1 1 0 0 0 0 2h4a1 1 0 1 0 0-2H8Z" /></svg>
              {archived ? "Viewing Archived" : "Archived"}
            </button>
          </div>
        )}
      </div>

      {ioMsg && (
        <div className="px-5 py-2 text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-b border-blue-100 dark:border-blue-900/40 shrink-0 flex items-center justify-between">
          <span>{ioMsg}</span>
          <button onClick={() => setIoMsg(null)} className="text-blue-400 hover:text-blue-600 ml-3">✕</button>
        </div>
      )}

      {/* Tab content */}
      {tab === "rd_contracts" && (
        <ContractBoard
          key={`rd-${reloadKey}`}
          stageGroups={CRM_STAGE_GROUPS}
          contractType="rd_contract"
          emptyLabel="No R&D contracts"
          archived={archived}
        />
      )}
      {tab === "portfolio_contracts" && (
        <ContractBoard
          key={`portfolio-${reloadKey}`}
          stageGroups={CRM_STAGE_GROUPS}
          contractType="portfolio_contract"
          emptyLabel="No portfolio contracts"
          archived={archived}
        />
      )}
      {tab === "knowledge_base" && <KnowledgeBase />}
      {tab === "settings" && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-white">Email &amp; Documents</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Templates and shared attachments the deal composer draws on. Templates here are scoped to CRM deals; the document shelf is shared platform-wide.
            </p>
            <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
              <CommsSettings scope="deal" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
