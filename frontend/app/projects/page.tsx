"use client";

import React from "react";
import { STAGE_SEQUENCES } from "@/lib/projectKinds";
import Link from "next/link";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ProjectCard, Project, STATUS_DOT, STATUS_LABEL, STATUS_CARD, TYPE_BADGE, TYPE_LABELS, Avatar, fmtCurrency, daysUntil, daysSince } from "@/components/project/ProjectCard";
import { ProjectDetailView } from "@/components/project/ProjectDetailView";

import { AutoTextarea } from "@/components/AutoTextarea";
// Returns a function that builds a URL that opens the project in the slide-over panel.
function useProjectHref() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? DEFAULT_TAB;
  return (projectId: string) => {
    const params = new URLSearchParams();
    params.set("tab", tab);
    params.set("panel", projectId);
    return `/projects?${params.toString()}`;
  };
}

const CHEVRON = "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.4rem_center] bg-[length:1rem]";
const SEL = `text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 pr-8 ${CHEVRON}`;
const SEL_XS = `text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-6 ${CHEVRON}`;

// ── Types — re-exported from shared component ──────────────────────────────

interface TemplateSummary {
  template_id: string;
  name: string;
  project_type: string;
  description: string | null;
  milestone_count: number;
  config?: Record<string, unknown>;
}

interface TemplateTask {
  id: string;
  title: string;
  activity_type: string | null;
  sort_order: number;
  estimated_minutes: number | null;
}

interface TemplateMilestone {
  id: string;
  title: string;
  milestone_type: string;
  sort_order: number;
  description: string | null;
  default_duration_days: number | null;
  tasks?: TemplateTask[];
}

interface TemplateDetail extends TemplateSummary {
  milestones: TemplateMilestone[];
}

// ── Stage sequences per project type ─────────────────────────────────────────


// Groups of stages shown under a shared parent label in the pipeline view
const STAGE_GROUPS: Record<string, { label: string; stages: string[]; color: string }[]> = {
  crm_opportunity: [
    { label: "Initial Assessment", stages: ["Prelim. Report & TEA", "Initial Sample Analysis & POC Proposal"], color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 border-violet-200 dark:border-violet-800" },
  ],
};

const STAGE_COLORS: Record<string, string> = {
  Prospect:    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  Qualified:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Assessment:  "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  Proposal:    "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  Legal:       "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  Contracted:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "R&D":       "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  Pilot:       "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  Production:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Exploring:   "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  Negotiating: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  Agreement:   "bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300",
  Active:      "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Complete:    "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  Identified:     "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  "In Prep":      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Submitted:      "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "Under Review": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  Won:            "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Lost:           "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  Backlog:    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  Planning:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Validation: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  Ideation:     "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300",
  "In Progress":"bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Review:       "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  Live:         "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};


// ── Partnership pipeline config ───────────────────────────────────────────────

const DEFAULT_PARTNERSHIP_STAGES = ["Exploring", "Negotiating", "Agreement", "Active", "Complete"];
const DEFAULT_PARTNERSHIP_TYPES  = ["Academic", "Commercial"];
const PARTNERSHIP_TYPE_PALETTE = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
];
function partnershipTypeColor(type: string, types: string[]): string {
  const idx = types.indexOf(type);
  return idx >= 0 ? PARTNERSHIP_TYPE_PALETTE[idx % PARTNERSHIP_TYPE_PALETTE.length] : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
}
function getProjectPartnershipType(p: Project, types: string[]): string | null {
  return p.tags.find(t => types.includes(t)) ?? null;
}

const TYPE_TABS = [
  { key: "crm_opportunity", label: "R&D Contracts" },
  { key: "portfolio",       label: "Portfolio Contracts" },
  { key: "partnership",     label: "Partnerships" },
  { key: "grant",           label: "Grants & Funding" },
  { key: "internal",        label: "Operations" },
  { key: "marketing",       label: "Marketing" },
] as const;

type TabKey = (typeof TYPE_TABS)[number]["key"];
const DEFAULT_TAB: TabKey = "crm_opportunity";
type ViewMode = "pipeline" | "table" | "timeline";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

// ── Editable inline text ──────────────────────────────────────────────────────

function EditableText({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <input autoFocus value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { onSave(draft); setEditing(false); }}
        onKeyDown={e => {
          if (e.key === "Enter") { onSave(draft); setEditing(false); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={`bg-transparent border-b border-blue-400 focus:outline-none min-w-0 ${className}`}
        onClick={e => e.stopPropagation()} />
    );
  }
  return (
    <span className={`cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors ${className}`}
      onClick={e => { e.stopPropagation(); setEditing(true); setDraft(value); }}>
      {value}
    </span>
  );
}


// ── Pipeline View ─────────────────────────────────────────────────────────────

function PipelineView({ projects: initialProjects, tabKey, onDelete, onUpdate, showType }: {
  projects: Project[]; tabKey: TabKey; onDelete: (id: string) => void; onUpdate: () => void; showType?: boolean;
}) {
  const stages = STAGE_SEQUENCES[tabKey] ?? [];
  const [localProjects, setLocalProjects] = useState<Project[]>(initialProjects);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const projectHref = useProjectHref();
  useEffect(() => { setLocalProjects(initialProjects); }, [initialProjects]);


  function onDragStart(e: React.DragEvent, projectId: string) {
    setDragId(projectId);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: React.DragEvent, stage: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(stage);
  }

  async function onDrop(e: React.DragEvent, toStage: string) {
    e.preventDefault();
    setDragOver(null);
    if (!dragId) return;
    const project = localProjects.find(p => p.project_id === dragId);
    if (!project || project.stage === toStage) { setDragId(null); return; }

    // Optimistic update
    setLocalProjects(prev => prev.map(p => p.project_id === dragId ? { ...p, stage: toStage } : p));
    setDragId(null);

    await fetch(`/api/proxy/projects/${dragId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: toStage }),
    });
    onUpdate();
  }

  const groups = STAGE_GROUPS[tabKey] ?? [];
  const stageToGroup = new Map<string, (typeof groups)[0]>();
  for (const g of groups) for (const s of g.stages) stageToGroup.set(s, g);

  function renderStageCol(stage: string, withSpacer = false) {
    const sp = localProjects.filter(p => p.stage === stage);
    const sv = sp.reduce((s, p) => s + (p.expected_revenue ?? 0), 0);
    const isOver = dragOver === stage;
    return (
      <div key={stage} className="flex-shrink-0 w-56"
        onDragOver={e => onDragOver(e, stage)}
        onDragLeave={() => setDragOver(null)}
        onDrop={e => onDrop(e, stage)}
      >
        {withSpacer && <div className="h-[26px]" />}
        <div className="flex items-center justify-between mb-2 h-8">
          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200 uppercase tracking-wider leading-tight line-clamp-2">{stage}</span>
          <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
            <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">{sp.length}</span>
            {sv > 0 && <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{fmtCurrency(sv)}</span>}
          </div>
        </div>
        <div className={`space-y-2 min-h-[80px] rounded-lg transition-colors p-1 -m-1 ${isOver ? "bg-blue-50 dark:bg-blue-950/20 ring-2 ring-blue-300 dark:ring-blue-700 ring-inset" : ""}`}>
          {sp.map(p => (
            <div key={p.project_id} draggable
              onDragStart={e => onDragStart(e, p.project_id)}
              onDragEnd={() => { setDragId(null); setDragOver(null); }}
              className={`transition-opacity ${dragId === p.project_id ? "opacity-40" : "opacity-100"}`}
            >
              <ProjectCard p={p} compact onDelete={onDelete} onUpdate={onUpdate} showType={showType} href={projectHref(p.project_id)} />
            </div>
          ))}
          {sp.length === 0 && !isOver && <div className="text-[11px] text-zinc-300 dark:text-zinc-600 italic px-1 pt-1">—</div>}
        </div>
      </div>
    );
  }

  // Build top-level items: grouped stages wrapped together, singletons standalone
  const items: React.ReactNode[] = [];
  let i = 0;
  while (i < stages.length) {
    const stage = stages[i];
    const group = stageToGroup.get(stage);
    if (group && group.stages[0] === stage) {
      items.push(
        <div key={`group-${group.label}`} className="flex-shrink-0">
          <div className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-t mb-0 border ${group.color}`}>
            {group.label}
          </div>
          <div className={`flex gap-3 border-l border-r border-b rounded-b p-2 border-zinc-200/70 dark:border-zinc-700/40`}>
            {group.stages.map(s => renderStageCol(s))}
          </div>
        </div>
      );
      i += group.stages.length;
    } else {
      items.push(renderStageCol(stage, true));
      i++;
    }
  }

  return (
    <div className="overflow-x-auto pb-4 min-h-[400px]">
      <div className="flex gap-3 items-start min-w-max">
        {items}
      </div>
    </div>
  );
}

// ── Table View ────────────────────────────────────────────────────────────────

type SortKey = "name" | "stage" | "status" | "expected_revenue" | "date_deadline" | "last_email_at" | "task_count";

function TableView({ projects, onDelete, onStatusChange }: { projects: Project[]; onDelete: (id: string) => void; onStatusChange: (id: string, status: string) => void }) {
  const projectHref = useProjectHref();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "date_deadline", dir: "asc" });
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const sorted = useMemo(() => [...projects].sort((a, b) => {
    const mul = sort.dir === "asc" ? 1 : -1;
    const av = a[sort.key] ?? ""; const bv = b[sort.key] ?? "";
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv)) * mul;
  }), [projects, sort]);

  function Th({ k, label }: { k: SortKey; label: string }) {
    const active = sort.key === k;
    return <th className="text-left text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide py-2 px-3 cursor-pointer select-none hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap" onClick={() => setSort(s => s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: "asc" })}>{label} {active && (sort.dir === "asc" ? "↑" : "↓")}</th>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <Th k="name" label="Project" />
            <th className="text-left text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide py-2 px-3 whitespace-nowrap">Type</th>
            <Th k="stage" label="Stage" />
            <Th k="status" label="Status" />
            <th className="text-left text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide py-2 px-3 whitespace-nowrap">Contact</th>
            <Th k="expected_revenue" label="Value" />
            <Th k="date_deadline" label="Deadline" />
            <Th k="task_count" label="Tasks" />
            <Th k="last_email_at" label="Last Contact" />
            <th className="py-2 px-2 w-8" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {sorted.map(p => {
            const deadline = daysUntil(p.date_deadline);
            const lastEmail = daysSince(p.last_email_at);
            const taskPct = p.task_count > 0 ? Math.round((p.tasks_done / p.task_count) * 100) : null;
            return (
              <tr key={p.project_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
                <td className="py-2.5 px-3">
                  <Link href={projectHref(p.project_id)} className="flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400">
                    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[p.status] ?? "bg-gray-300"}`} />
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-[200px]">{p.contact_org ?? p.contact_name ?? p.name}</p>
                    </div>
                  </Link>
                </td>
                <td className="py-2.5 px-3"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${TYPE_BADGE[p.project_type] ?? "bg-gray-100 text-gray-500"}`}>{TYPE_LABELS[p.project_type] ?? p.project_type}</span></td>
                <td className="py-2.5 px-3">{p.stage ? <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${STAGE_COLORS[p.stage] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>{p.stage}</span> : <span className="text-zinc-300 dark:text-zinc-600">—</span>}</td>
                <td className="py-2.5 px-3" onClick={e => e.stopPropagation()}>
                  <select
                    value={p.status}
                    onChange={e => onStatusChange(p.project_id, e.target.value)}
                    className="text-xs text-zinc-600 dark:text-zinc-300 bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none hover:text-zinc-900 dark:hover:text-zinc-100"
                  >
                    {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td className="py-2.5 px-3">{p.contact_name ? <div className="flex items-center gap-1.5"><Avatar name={p.contact_name} url={p.contact_avatar} size={5} /><span className="text-xs text-zinc-600 dark:text-zinc-300 truncate max-w-[140px]">{p.contact_name}</span></div> : <span className="text-zinc-300 dark:text-zinc-600">—</span>}</td>
                <td className="py-2.5 px-3 text-xs text-zinc-600 dark:text-zinc-300 font-mono">{fmtCurrency(p.expected_revenue) ?? "—"}</td>
                <td className="py-2.5 px-3 text-xs whitespace-nowrap">{p.date_deadline ? <span className={deadline !== null && deadline < 0 ? "text-red-500 font-medium" : deadline !== null && deadline < 7 ? "text-amber-500" : "text-zinc-500 dark:text-zinc-400"}>{fmtDate(p.date_deadline)}</span> : <span className="text-zinc-300 dark:text-zinc-600">—</span>}</td>
                <td className="py-2.5 px-3">{p.task_count > 0 ? <div className="flex items-center gap-1.5"><div className="w-12 h-1 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${taskPct}%` }} /></div><span className="text-xs text-zinc-500 dark:text-zinc-400">{p.tasks_done}/{p.task_count}</span></div> : <span className="text-zinc-300 dark:text-zinc-600 text-xs">—</span>}</td>
                <td className="py-2.5 px-3 text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">{lastEmail === null ? "—" : lastEmail === 0 ? "Today" : `${lastEmail}d ago`}</td>
                <td className="py-2.5 px-2 text-right">
                  {confirmDel === p.project_id ? (
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => { onDelete(p.project_id); setConfirmDel(null); }} className="text-[10px] px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded font-medium">Yes</button>
                      <button onClick={() => setConfirmDel(null)} className="text-[10px] px-1.5 py-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">No</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDel(p.project_id)} className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400" title="Delete">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-500 italic">No projects found.</div>}
    </div>
  );
}

// ── Timeline View (Gantt) ─────────────────────────────────────────────────────

function TimelineView({ projects }: { projects: Project[] }) {
  const projectHref = useProjectHref();
  const withDates = projects.filter(p => p.date_start || p.date_deadline);
  if (withDates.length === 0) return <div className="py-10 text-center text-sm text-zinc-400 dark:text-zinc-500 italic">No projects with dates to display.</div>;
  const allDates = withDates.flatMap(p => [p.date_start, p.date_deadline].filter(Boolean) as string[]);
  const minDate = new Date(Math.min(...allDates.map(d => new Date(d).getTime())));
  const maxDate = new Date(Math.max(...allDates.map(d => new Date(d).getTime())));
  const totalDays = Math.max((maxDate.getTime() - minDate.getTime()) / 86_400_000, 30);
  function pct(d: string | null, fallback: Date) {
    const target = d ? new Date(d) : fallback;
    return Math.max(0, Math.min(100, ((target.getTime() - minDate.getTime()) / (totalDays * 86_400_000)) * 100));
  }
  const STATUS_BAR: Record<string, string> = { in_progress: "bg-green-500", waiting_client: "bg-amber-400", waiting_sbc: "bg-[#000000]", awaiting_vendor: "bg-orange-400" };
  const months: { label: string; pct: number }[] = [];
  const cursor = new Date(minDate); cursor.setDate(1);
  while (cursor <= maxDate) {
    months.push({ label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), pct: ((cursor.getTime() - minDate.getTime()) / (totalDays * 86_400_000)) * 100 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return (
    <div className="overflow-x-auto"><div className="min-w-[700px]">
      <div className="relative h-6 mb-1 ml-48">{months.map(m => <div key={m.label} className="absolute text-[10px] text-zinc-400 dark:text-zinc-500" style={{ left: `${m.pct}%` }}>{m.label}</div>)}</div>
      <div className="space-y-1.5">{withDates.map(p => {
        const start = pct(p.date_start, minDate); const end = pct(p.date_deadline, maxDate);
        return (
          <div key={p.project_id} className="flex items-center gap-2">
            <Link href={projectHref(p.project_id)} className="w-44 flex-shrink-0 text-xs text-zinc-700 dark:text-zinc-300 truncate hover:text-blue-600 dark:hover:text-blue-400 text-right pr-2">{p.name}</Link>
            <div className="flex-1 relative h-5 bg-zinc-100 dark:bg-zinc-800 rounded">
              <div className={`absolute h-full rounded ${STATUS_BAR[p.status] ?? "bg-blue-400"} opacity-80`} style={{ left: `${start}%`, width: `${Math.max(end - start, 2)}%` }} />
              <div className="absolute top-0 bottom-0 w-px bg-red-400 opacity-60" style={{ left: `${pct(new Date().toISOString().slice(0, 10), new Date())}%` }} />
            </div>
            {p.stage && <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${STAGE_COLORS[p.stage] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>{p.stage}</span>}
          </div>
        );
      })}</div>
    </div></div>
  );
}

// ── Partnership Card ──────────────────────────────────────────────────────────

function PartnershipCard({ project, types, onSetType, onAddType, onClick, onDelete }: {
  project: Project;
  types: string[];
  onSetType: (id: string, type: string | null) => void;
  onAddType: (type: string) => void;
  onClick: () => void;
  onDelete?: (id: string) => void;
}) {
  const currentType = getProjectPartnershipType(project, types);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [addingType, setAddingType] = useState(false);
  const [newTypeDraft, setNewTypeDraft] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [localStatus, setLocalStatus] = useState(project.status);
  const [tasks, setTasks] = useState<Array<{ task_id: string; title: string; assigned_to_name: string | null; due_date: string | null; locked: boolean; status: string }>>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const loadedForCount = useRef<number>(-1);

  useEffect(() => {
    if (loadedForCount.current === project.task_count && tasksLoaded) return;
    fetch(`/api/proxy/tasks?project_id=${project.project_id}&all_users=true`)
      .then(r => r.ok ? r.json() : [])
      .then((all: Array<{ task_id: string; title: string; assigned_to_name: string | null; due_date: string | null; locked: boolean; status: string }>) => {
        setTasks(all.filter(t => t.status === "open" && !t.locked));
        loadedForCount.current = project.task_count;
        setTasksLoaded(true);
      });
  }, [project.project_id, project.task_count]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleTask(taskId: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    setTasks(prev => prev.filter(t => t.task_id !== taskId));
  }

  async function patchStatus(value: string) {
    await fetch(`/api/proxy/projects/${project.project_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: value }),
    });
  }
  const typeColor = currentType
    ? partnershipTypeColor(currentType, types)
    : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500";

  return (
    <div
      className="relative group/pcard rounded-lg border bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 shadow-sm hover:shadow transition-all cursor-pointer p-3"
      onClick={onClick}
    >
      <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded ${STATUS_DOT[project.status] ?? "bg-zinc-300"}`} />
      <div className="pl-3">
        <div className="mb-1.5" onClick={e => e.stopPropagation()}>
          <div className="relative inline-block">
            <button
              onClick={() => setTypeMenuOpen(o => !o)}
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium transition-opacity hover:opacity-80 ${typeColor}`}
            >
              {currentType ?? "Set type"}
            </button>
            {typeMenuOpen && (
              <div className="absolute top-full left-0 mt-1 z-20 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[140px]">
                <button
                  onClick={() => { onSetType(project.project_id, null); setTypeMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                  None
                </button>
                {types.map(t => (
                  <button key={t}
                    onClick={() => { onSetType(project.project_id, t); setTypeMenuOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors ${t === currentType ? "font-semibold" : ""}`}
                  >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${partnershipTypeColor(t, types).split(" ")[0]}`} />
                    {t}
                  </button>
                ))}
                <div className="border-t border-zinc-100 dark:border-zinc-800 mt-1 pt-1">
                  {addingType ? (
                    <div className="px-2 py-1">
                      <input
                        autoFocus
                        value={newTypeDraft}
                        onChange={e => setNewTypeDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && newTypeDraft.trim()) {
                            onAddType(newTypeDraft.trim());
                            onSetType(project.project_id, newTypeDraft.trim());
                            setTypeMenuOpen(false);
                            setAddingType(false);
                            setNewTypeDraft("");
                          }
                          if (e.key === "Escape") { setAddingType(false); setNewTypeDraft(""); }
                        }}
                        placeholder="Type name…"
                        className="w-full text-xs px-2 py-1 border border-blue-300 dark:border-blue-600 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setAddingType(true)}
                      className="w-full text-left px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                    >
                      + Add type
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 leading-tight line-clamp-2">
          {project.contact_org ?? project.contact_name ?? project.name}
        </p>
        {(project.contact_org || project.contact_name) && (
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">{project.name}</p>
        )}
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[localStatus] ?? "bg-gray-300"}`} />
            <select
              value={localStatus}
              onChange={e => { setLocalStatus(e.target.value); patchStatus(e.target.value); }}
              className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none"
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {project.assigned_to_name && (
            <div className="flex items-center gap-1" title={project.assigned_to_name}>
              <Avatar name={project.assigned_to_name} url={null} size={5} />
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[80px]">{project.assigned_to_name.split(" ")[0]}</span>
            </div>
          )}
        </div>
        {(() => { const dl = daysUntil(project.date_deadline); return dl !== null ? (
          <div className={`text-[10px] mt-1.5 font-medium ${dl < 0 ? "text-red-500" : dl < 7 ? "text-amber-500" : "text-zinc-400 dark:text-zinc-500"}`}>
            {dl < 0 ? `${Math.abs(dl)}d overdue` : `${dl}d left`}
          </div>
        ) : null; })()}
        {tasksLoaded && tasks.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5 mt-2 pt-2 space-y-1" onClick={e => e.stopPropagation()}>
            {tasks.map(t => {
              const dl = daysUntil(t.due_date);
              return (
                <div key={t.task_id} className="flex items-center gap-1.5">
                  <button onClick={() => toggleTask(t.task_id)}
                    className="w-3.5 h-3.5 rounded border border-zinc-300 dark:border-zinc-600 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 flex-shrink-0 transition-colors" />
                  <span className="flex-1 text-[11px] text-zinc-600 dark:text-zinc-300 truncate min-w-0">{t.title}</span>
                  {t.due_date && dl !== null && (
                    <span className={`text-[10px] flex-shrink-0 font-medium ${dl < 0 ? "text-red-500" : dl < 3 ? "text-amber-500" : "text-zinc-400 dark:text-zinc-500"}`}>
                      {dl < 0 ? `${Math.abs(dl)}d late` : dl === 0 ? "today" : `${dl}d`}
                    </span>
                  )}
                  {t.assigned_to_name && <span className="text-[10px] text-zinc-400 flex-shrink-0">{t.assigned_to_name.split(" ")[0]}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {onDelete && (
        <div className="absolute top-2 right-2" onClick={e => e.stopPropagation()}>
          {confirmDel ? (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-red-600 dark:text-red-400">Delete?</span>
              <button onClick={() => { onDelete(project.project_id); setConfirmDel(false); }} className="text-[10px] px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded font-medium">Yes</button>
              <button onClick={() => setConfirmDel(false)} className="text-[10px] px-1.5 py-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">No</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDel(true)}
              className="opacity-0 group-hover/pcard:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400"
              title="Delete">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add Stage Button ──────────────────────────────────────────────────────────

function AddStageButton({ onAdd }: { onAdd: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  if (adding) {
    return (
      <div className="flex flex-col gap-2 mt-8">
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && draft.trim()) { onAdd(draft.trim()); setAdding(false); setDraft(""); }
            if (e.key === "Escape") { setAdding(false); setDraft(""); }
          }}
          placeholder="Stage name…"
          className="w-full text-xs px-3 py-2 border border-blue-300 dark:border-blue-600 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        />
        <div className="flex gap-1">
          <button onClick={() => { if (draft.trim()) onAdd(draft.trim()); setAdding(false); setDraft(""); }}
            className="flex-1 text-xs py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">Add</button>
          <button onClick={() => { setAdding(false); setDraft(""); }}
            className="text-xs px-2 py-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setAdding(true)}
      className="mt-8 w-full h-8 flex items-center justify-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 border border-dashed border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 rounded-lg transition-colors"
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/>
      </svg>
      Add Stage
    </button>
  );
}

// ── Partnership Pipeline View ─────────────────────────────────────────────────

function PartnershipPipelineView({ projects: initialProjects, onDelete, onUpdate }: {
  projects: Project[];
  onDelete: (id: string) => void;
  onUpdate: () => void;
}) {
  const router = useRouter();
  const projectHref = useProjectHref();
  const [stages, setStages] = useState<string[]>(DEFAULT_PARTNERSHIP_STAGES);
  const [partnershipTypes, setPartnershipTypes] = useState<string[]>(DEFAULT_PARTNERSHIP_TYPES);
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set(["Inactive"]));
  const [localProjects, setLocalProjects] = useState<Project[]>(initialProjects);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Load persisted config from localStorage after mount (avoids hydration mismatch)
  useEffect(() => {
    try { const s = localStorage.getItem("partnership_stages"); if (s) setStages(JSON.parse(s)); } catch {}
    try { const t = localStorage.getItem("partnership_types"); if (t) setPartnershipTypes(JSON.parse(t)); } catch {}
  }, []);

  useEffect(() => { setLocalProjects(initialProjects); }, [initialProjects]);

  function saveStages(s: string[]) {
    setStages(s);
    try { localStorage.setItem("partnership_stages", JSON.stringify(s)); } catch {}
  }

  function saveTypes(t: string[]) {
    setPartnershipTypes(t);
    try { localStorage.setItem("partnership_types", JSON.stringify(t)); } catch {}
  }

  async function handleRenameStage(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    saveStages(stages.map(s => s === oldName ? trimmed : s));
    if (collapsedStages.has(oldName)) {
      setCollapsedStages(prev => { const s = new Set(prev); s.delete(oldName); s.add(trimmed); return s; });
    }
    const toUpdate = localProjects.filter(p => p.stage === oldName);
    setLocalProjects(prev => prev.map(p => p.stage === oldName ? { ...p, stage: trimmed } : p));
    await Promise.all(toUpdate.map(p =>
      fetch(`/api/proxy/projects/${p.project_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: trimmed }),
      })
    ));
    onUpdate();
  }

  async function handleSetType(projectId: string, type: string | null) {
    const project = localProjects.find(p => p.project_id === projectId);
    if (!project) return;
    const newTags = [
      ...project.tags.filter(t => !partnershipTypes.includes(t)),
      ...(type ? [type] : []),
    ];
    setLocalProjects(prev => prev.map(p => p.project_id === projectId ? { ...p, tags: newTags } : p));
    await fetch(`/api/proxy/projects/${projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: newTags }),
    });
  }

  function handleAddType(typeName: string) {
    if (!partnershipTypes.includes(typeName)) saveTypes([...partnershipTypes, typeName]);
  }

  function onDragStart(e: React.DragEvent, projectId: string) {
    setDragId(projectId);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e: React.DragEvent, stage: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(stage);
  }
  async function onDrop(e: React.DragEvent, toStage: string) {
    e.preventDefault();
    setDragOver(null);
    if (!dragId) return;
    const project = localProjects.find(p => p.project_id === dragId);
    if (!project || project.stage === toStage) { setDragId(null); return; }
    setLocalProjects(prev => prev.map(p => p.project_id === dragId ? { ...p, stage: toStage } : p));
    setDragId(null);
    await fetch(`/api/proxy/projects/${dragId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: toStage }),
    });
    onUpdate();
  }

  const byStage = useMemo(() => {
    const map: Record<string, Project[]> = {};
    for (const s of stages) map[s] = [];
    for (const p of localProjects) {
      const s = p.stage ?? stages[0];
      if (s in map) map[s].push(p);
      else if (stages[0]) map[stages[0]].push(p);
    }
    return map;
  }, [localProjects, stages]);

  function toggleCollapse(stage: string) {
    setCollapsedStages(prev => { const s = new Set(prev); s.has(stage) ? s.delete(stage) : s.add(stage); return s; });
  }

  return (
    <div className="overflow-x-auto pb-4 min-h-[400px]">
      <div className="flex gap-3 items-start min-w-max">
        {stages.map(stage => {
          const sp = byStage[stage] ?? [];
          const isOver = dragOver === stage;
          const isCollapsed = collapsedStages.has(stage);

          if (isCollapsed) {
            return (
              <div key={stage}
                className="flex-shrink-0 w-12 flex flex-col items-center"
                onDragOver={e => onDragOver(e, stage)}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => onDrop(e, stage)}
              >
                <button
                  onClick={() => toggleCollapse(stage)}
                  className={`w-full rounded-xl border py-4 flex flex-col items-center gap-2 transition-colors ${isOver ? "bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-700" : "bg-zinc-50 dark:bg-zinc-800/30 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800/50"}`}
                  title={`Expand ${stage} (${sp.length})`}
                >
                  <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider [writing-mode:vertical-rl] rotate-180">
                    {stage}
                  </span>
                  <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500">{sp.length}</span>
                </button>
              </div>
            );
          }

          return (
            <div key={stage} className="flex-shrink-0 w-56"
              onDragOver={e => onDragOver(e, stage)}
              onDragLeave={() => setDragOver(null)}
              onDrop={e => onDrop(e, stage)}
            >
              <div className="flex items-center justify-between mb-2 h-8">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <EditableText
                    value={stage}
                    onSave={newName => handleRenameStage(stage, newName)}
                    className="text-xs font-bold text-zinc-700 dark:text-zinc-200 uppercase tracking-wider"
                  />
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 flex-shrink-0">{sp.length}</span>
                </div>
                <button
                  onClick={() => toggleCollapse(stage)}
                  className="text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400 p-0.5 ml-1 flex-shrink-0"
                  title="Collapse"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>
              <div className={`space-y-2 min-h-[80px] rounded-lg transition-colors p-1 -m-1 ${isOver ? "bg-blue-50 dark:bg-blue-950/20 ring-2 ring-blue-300 dark:ring-blue-700 ring-inset" : ""}`}>
                {sp.map(p => (
                  <div key={p.project_id} draggable
                    onDragStart={e => onDragStart(e, p.project_id)}
                    onDragEnd={() => { setDragId(null); setDragOver(null); }}
                    className={`transition-opacity ${dragId === p.project_id ? "opacity-40" : "opacity-100"}`}
                  >
                    <PartnershipCard
                      project={p}
                      types={partnershipTypes}
                      onSetType={handleSetType}
                      onAddType={handleAddType}
                      onClick={() => router.push(projectHref(p.project_id))}
                      onDelete={onDelete}
                    />
                  </div>
                ))}
                {sp.length === 0 && !isOver && (
                  <div className="text-[11px] text-zinc-300 dark:text-zinc-600 italic px-1 pt-1">—</div>
                )}
              </div>
            </div>
          );
        })}
        <div className="flex-shrink-0 w-48">
          <AddStageButton onAdd={name => saveStages([...stages, name])} />
        </div>
      </div>
    </div>
  );
}

// ── Native Flowchart ──────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, { bg: string; border: string; badge: string; dot: string }> = {
  milestone:    { bg: "bg-blue-50 dark:bg-blue-900/20",    border: "border-blue-200 dark:border-blue-700/50",    badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",    dot: "bg-blue-500" },
  checkpoint:   { bg: "bg-amber-50 dark:bg-amber-900/20",   border: "border-amber-200 dark:border-amber-700/50",   badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",   dot: "bg-amber-400" },
  review:       { bg: "bg-purple-50 dark:bg-purple-900/20", border: "border-purple-200 dark:border-purple-700/50", badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300", dot: "bg-purple-500" },
  deliverable:  { bg: "bg-green-50 dark:bg-green-900/20",   border: "border-green-200 dark:border-green-700/50",   badge: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",   dot: "bg-green-500" },
  approval:     { bg: "bg-rose-50 dark:bg-rose-900/20",     border: "border-rose-200 dark:border-rose-700/50",     badge: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",     dot: "bg-rose-500" },
  objective:    { bg: "bg-zinc-50 dark:bg-zinc-800/40",     border: "border-zinc-200 dark:border-zinc-700/50",     badge: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",       dot: "bg-zinc-400" },
  external_wait:{ bg: "bg-orange-50 dark:bg-orange-900/20", border: "border-orange-200 dark:border-orange-700/50", badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300", dot: "bg-orange-400" },
};

const MILESTONE_TYPES = ["objective","milestone","checkpoint","deliverable","approval","review","external_wait"];

function FlowArrow() {
  return (
    <div className="flex justify-center py-0.5 select-none pointer-events-none">
      <svg width="20" height="28" viewBox="0 0 20 28" fill="none">
        <line x1="10" y1="0" x2="10" y2="20" stroke="#9ca3af" strokeWidth="1.5"/>
        <path d="M5 16 L10 22 L15 16" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    </div>
  );
}

function FlowNode({
  milestone, index, total,
  onUpdate, onDelete, onAddAfter, onMoveUp, onMoveDown,
}: {
  milestone: TemplateMilestone;
  index: number;
  total: number;
  onUpdate: (id: string, fields: Partial<TemplateMilestone>) => void;
  onDelete: (id: string) => void;
  onAddAfter: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(milestone.title);
  const [durDraft, setDurDraft] = useState(String(milestone.default_duration_days ?? ""));
  const [saving, setSaving] = useState(false);
  const colors = NODE_COLORS[milestone.milestone_type] ?? NODE_COLORS.objective;

  // Sync draft when milestone changes externally
  useEffect(() => { setTitleDraft(milestone.title); }, [milestone.title]);
  useEffect(() => { setDurDraft(String(milestone.default_duration_days ?? "")); }, [milestone.default_duration_days]);

  async function saveTitle() {
    const v = titleDraft.trim();
    if (!v || v === milestone.title) { setEditingTitle(false); return; }
    setSaving(true);
    onUpdate(milestone.id, { title: v });
    await fetch(`/api/proxy/template-milestones/${milestone.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: v }),
    });
    setSaving(false);
    setEditingTitle(false);
  }

  async function saveDuration() {
    const days = durDraft ? parseInt(durDraft) : null;
    if (days === (milestone.default_duration_days ?? null)) return;
    onUpdate(milestone.id, { default_duration_days: days ?? undefined });
    await fetch(`/api/proxy/template-milestones/${milestone.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_duration_days: days }),
    });
  }

  async function saveType(t: string) {
    onUpdate(milestone.id, { milestone_type: t });
    await fetch(`/api/proxy/template-milestones/${milestone.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestone_type: t }),
    });
  }

  const taskCount = (milestone.tasks ?? []).length;

  return (
    <div className={`group/node relative rounded-xl border ${colors.border} ${colors.bg} px-4 py-3 shadow-sm transition-shadow hover:shadow-md mx-auto`} style={{ width: 320 }}>
      {/* Step number */}
      <div className="flex items-start gap-2.5">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-500 dark:text-zinc-400 mt-0.5">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          {/* Title */}
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") { setTitleDraft(milestone.title); setEditingTitle(false); } }}
              className="w-full text-sm font-medium bg-white dark:bg-zinc-800 border border-blue-400 rounded px-1.5 py-0.5 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          ) : (
            <button
              className={`text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 text-left w-full truncate transition-colors ${saving ? "opacity-60" : ""}`}
              onClick={() => setEditingTitle(true)}
              title="Click to edit"
            >
              {milestone.title}
            </button>
          )}

          {/* Type + Duration row */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <select
              value={milestone.milestone_type}
              onChange={e => saveType(e.target.value)}
              className={`text-[10px] px-1.5 py-0.5 rounded border-0 font-medium capitalize cursor-pointer focus:outline-none appearance-none ${colors.badge}`}
            >
              {MILESTONE_TYPES.map(t => (
                <option key={t} value={t}>{t.replace("_", " ")}</option>
              ))}
            </select>
            <div className="flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
              <input
                type="number"
                min={1}
                value={durDraft}
                onChange={e => setDurDraft(e.target.value)}
                onBlur={saveDuration}
                onKeyDown={e => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } }}
                placeholder="—"
                className="w-10 text-center text-[10px] bg-white/60 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-0.5 text-zinc-600 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-400/50 appearance-none"
              />
              <span>days</span>
            </div>
            {taskCount > 0 && (
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{taskCount} task{taskCount !== 1 ? "s" : ""}</span>
            )}
          </div>
        </div>

        {/* Controls — visible on hover */}
        <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover/node:opacity-100 transition-opacity ml-1 flex-shrink-0">
          <button
            onClick={() => onMoveUp(milestone.id)}
            disabled={index === 0}
            className="text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-0 p-0.5"
            title="Move up"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7"/></svg>
          </button>
          <button
            onClick={() => onDelete(milestone.id)}
            className="text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 p-0.5"
            title="Delete step"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
          <button
            onClick={() => onMoveDown(milestone.id)}
            disabled={index === total - 1}
            className="text-zinc-300 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-0 p-0.5"
            title="Move down"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
          </button>
        </div>
      </div>

      {/* Add step below (appears on hover between nodes) */}
      <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 z-10 opacity-0 group-hover/node:opacity-100 transition-opacity">
        <button
          onClick={() => onAddAfter(milestone.id)}
          className="w-7 h-7 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center justify-center text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 shadow-sm transition-all"
          title="Add step here"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        </button>
      </div>
    </div>
  );
}

function FlowChart({ template, onChanged }: { template: TemplateDetail; onChanged: () => void }) {
  const [milestones, setMilestones] = useState<TemplateMilestone[]>(template.milestones);

  // Sync when template prop changes (e.g. after adding a step from the header button)
  useEffect(() => { setMilestones(template.milestones); }, [template.milestones]);

  function updateLocal(id: string, fields: Partial<TemplateMilestone>) {
    setMilestones(ms => ms.map(m => m.id === id ? { ...m, ...fields } : m));
  }

  async function handleDelete(id: string) {
    setMilestones(ms => ms.filter(m => m.id !== id));
    await fetch(`/api/proxy/template-milestones/${id}`, { method: "DELETE" });
    onChanged();
  }

  async function handleAddAfter(afterId: string) {
    const idx = milestones.findIndex(m => m.id === afterId);
    const sortOrder = idx >= 0 ? milestones[idx].sort_order + 1 : 999;
    const r = await fetch(`/api/proxy/project-templates/${template.template_id}/milestones`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Step", milestone_type: "milestone", sort_order: sortOrder }),
    });
    if (r.ok) onChanged();
  }

  async function reorder(id: string, direction: "up" | "down") {
    const idx = milestones.findIndex(m => m.id === id);
    if (direction === "up" && idx === 0) return;
    if (direction === "down" && idx === milestones.length - 1) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    const next = [...milestones];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setMilestones(next);
    // Persist new sort_orders
    await Promise.all([
      fetch(`/api/proxy/template-milestones/${next[idx].id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sort_order: idx }),
      }),
      fetch(`/api/proxy/template-milestones/${next[swapIdx].id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sort_order: swapIdx }),
      }),
    ]);
    onChanged();
  }

  if (milestones.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-zinc-200 dark:border-zinc-700 rounded-xl">
        <p className="text-sm text-zinc-400 dark:text-zinc-500 mb-3">No steps yet. Add your first step to build the workflow.</p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto py-4" style={{ maxHeight: 560 }}>
      <div className="flex flex-col items-center">
        {milestones.map((m, i) => (
          <React.Fragment key={m.id}>
            <FlowNode
              milestone={m}
              index={i}
              total={milestones.length}
              onUpdate={updateLocal}
              onDelete={handleDelete}
              onAddAfter={handleAddAfter}
              onMoveUp={id => reorder(id, "up")}
              onMoveDown={id => reorder(id, "down")}
            />
            {i < milestones.length - 1 && <FlowArrow />}
          </React.Fragment>
        ))}
        {/* Terminal cap */}
        <div className="mt-3 flex items-center gap-2">
          <div className="w-3 h-3 rounded-full border-2 border-zinc-300 dark:border-zinc-600" />
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">End</span>
        </div>
      </div>
    </div>
  );
}

function TemplatesView({ tabKey }: { tabKey: TabKey }) {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelTpl, setConfirmDelTpl] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [addingTask, setAddingTask] = useState<string | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  async function loadTemplates() {
    setLoading(true);
    try {
      const r = await fetch(`/api/proxy/project-templates?project_type=${tabKey}`);
      if (r.ok) setTemplates(await r.json());
    } finally { setLoading(false); }
  }

  async function loadTemplate(id: string) {
    const r = await fetch(`/api/proxy/project-templates/${id}`);
    if (r.ok) { const data = await r.json(); setSelected(data); setExpandedSteps(new Set()); }
  }

  async function createTemplate() {
    if (!newName.trim()) return;
    const r = await fetch("/api/proxy/project-templates", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), project_type: tabKey }),
    });
    if (r.ok) {
      const data = await r.json();
      setCreating(false); setNewName("");
      await loadTemplates();
      loadTemplate(data.template_id);
    }
  }

  async function deleteTemplate(id: string) {
    await fetch(`/api/proxy/project-templates/${id}`, { method: "DELETE" });
    if (selected?.template_id === id) setSelected(null);
    await loadTemplates(); setConfirmDelTpl(null);
  }

  async function addMilestone() {
    if (!selected) return;
    const r = await fetch(`/api/proxy/project-templates/${selected.template_id}/milestones`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Step", milestone_type: "milestone" }),
    });
    if (r.ok) loadTemplate(selected.template_id);
  }

  async function deleteMilestone(id: string) {
    await fetch(`/api/proxy/template-milestones/${id}`, { method: "DELETE" });
    if (selected) loadTemplate(selected.template_id);
  }

  async function addTask(milestoneId: string) {
    if (!newTaskTitle.trim() || !selected) return;
    await fetch(`/api/proxy/template-milestones/${milestoneId}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTaskTitle.trim() }),
    });
    setNewTaskTitle(""); setAddingTask(null);
    loadTemplate(selected.template_id);
  }

  async function deleteTask(taskId: string) {
    await fetch(`/api/proxy/template-tasks/${taskId}`, { method: "DELETE" });
    if (selected) loadTemplate(selected.template_id);
  }

  useEffect(() => { loadTemplates(); }, [tabKey]);

  return (
    <div className="flex gap-6 min-h-[600px]">
      {/* Left sidebar */}
      <div className="w-52 flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Templates</span>
          <button onClick={() => setCreating(true)} className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 font-medium">+ New</button>
        </div>

        {creating && (
          <div className="flex gap-1 mb-2">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") createTemplate(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
              placeholder="Template name…"
              className="flex-1 text-xs px-2 py-1 border border-blue-300 dark:border-blue-600 rounded-md bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none"
            />
            <button onClick={createTemplate} className="text-xs px-2 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700">✓</button>
          </div>
        )}

        {loading ? <div className="text-xs text-zinc-400 italic">Loading…</div> :
         templates.length === 0 && !creating ? <div className="text-xs text-zinc-400 dark:text-zinc-500 italic">No templates yet.</div> : (
          <div className="space-y-0.5">
            {templates.map(t => (
              <div key={t.template_id} className="group/tpl relative">
                <button onClick={() => loadTemplate(t.template_id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${selected?.template_id === t.template_id ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium" : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}>
                  <div className="truncate pr-4">{t.name}</div>
                  <div className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">{t.milestone_count ?? 0} steps</div>
                </button>
                {confirmDelTpl === t.template_id ? (
                  <div className="absolute right-1 top-1.5 flex items-center gap-1 bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-800 rounded px-1.5 py-0.5 shadow-sm z-10">
                    <span className="text-[10px] text-red-600 dark:text-red-400">Delete?</span>
                    <button onClick={() => deleteTemplate(t.template_id)} className="text-[10px] px-1 bg-red-600 text-white rounded">Yes</button>
                    <button onClick={() => setConfirmDelTpl(null)} className="text-[10px] px-1 text-zinc-400">No</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDelTpl(t.template_id)}
                    className="absolute right-1.5 top-2 opacity-0 group-hover/tpl:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="w-px bg-zinc-200 dark:bg-zinc-800 flex-shrink-0" />

      {/* Main panel */}
      <div className="flex-1 min-w-0 space-y-4">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <div className="text-zinc-300 dark:text-zinc-600 text-4xl">⬡</div>
            <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">Select a template or create a new one.</p>
          </div>
        ) : (
          <>
            {/* Template name + actions */}
            <div className="flex items-center gap-3">
              <EditableText
                value={selected.name}
                onSave={async v => {
                  await fetch(`/api/proxy/project-templates/${selected.template_id}`, {
                    method: "PATCH", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: v }),
                  });
                  setSelected({ ...selected, name: v }); loadTemplates();
                }}
                className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
              />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{selected.milestones.length} step{selected.milestones.length !== 1 ? "s" : ""}</span>
              <button onClick={addMilestone}
                className="ml-auto text-xs px-2.5 py-1 border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-600 dark:hover:border-blue-500 dark:hover:text-blue-400 rounded-lg transition-colors">
                + Add Step
              </button>
            </div>

            {/* Native flowchart */}
            <FlowChart
              template={selected}
              onChanged={() => loadTemplate(selected.template_id)}
            />

            {/* Steps + Tasks panel */}
            {selected.milestones.length > 0 && (
              <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Steps & Tasks</span>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">Click a step to manage its tasks</span>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {selected.milestones.map((m, idx) => {
                    const open = expandedSteps.has(m.id);
                    const tasks = m.tasks ?? [];
                    return (
                      <div key={m.id}>
                        <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group/step">
                          <button onClick={() => setExpandedSteps(prev => { const s = new Set(prev); open ? s.delete(m.id) : s.add(m.id); return s; })}
                            className="flex items-center gap-2 flex-1 text-left min-w-0">
                            <span className="text-[10px] text-zinc-400 font-mono w-4 flex-shrink-0">{idx + 1}</span>
                            <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{m.title}</span>
                            {tasks.length > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>}
                            <span className={`ml-1 text-zinc-400 text-xs transition-transform ${open ? "rotate-90" : ""}`}>›</span>
                          </button>
                          <button onClick={() => { setAddingTask(m.id); setExpandedSteps(prev => new Set([...prev, m.id])); }}
                            className="opacity-0 group-hover/step:opacity-100 transition-opacity text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 font-medium">
                            + Task
                          </button>
                          <button onClick={() => deleteMilestone(m.id)}
                            className="opacity-0 group-hover/step:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                        {open && (
                          <div className="pl-10 pr-4 pb-2 space-y-1 bg-zinc-50/50 dark:bg-zinc-800/20">
                            {tasks.map(t => (
                              <div key={t.id} className="flex items-center gap-2 py-1 group/task">
                                <span className="w-1 h-1 rounded-full bg-zinc-300 dark:bg-zinc-600 flex-shrink-0" />
                                <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1">{t.title}</span>
                                {t.estimated_minutes && <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t.estimated_minutes}m</span>}
                                <button onClick={() => deleteTask(t.id)}
                                  className="opacity-0 group-hover/task:opacity-100 transition-opacity text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400">
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            ))}
                            {tasks.length === 0 && addingTask !== m.id && (
                              <div className="text-[11px] text-zinc-400 dark:text-zinc-500 italic py-1">No tasks yet.</div>
                            )}
                            {addingTask === m.id ? (
                              <div className="flex gap-1 mt-1">
                                <input autoFocus value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                                  onKeyDown={e => { if (e.key === "Enter") addTask(m.id); if (e.key === "Escape") { setAddingTask(null); setNewTaskTitle(""); } }}
                                  placeholder="Task name…"
                                  className="flex-1 text-xs px-2 py-1 border border-blue-300 dark:border-blue-600 rounded-md bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none"
                                />
                                <button onClick={() => addTask(m.id)} className="text-xs px-2 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700">Add</button>
                                <button onClick={() => { setAddingTask(null); setNewTaskTitle(""); }} className="text-xs px-2 py-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Cancel</button>
                              </div>
                            ) : (
                              <button onClick={() => { setAddingTask(m.id); }}
                                className="text-[11px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 mt-1 transition-colors">
                                + Add task
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Status Settings View ──────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { key: "in_progress",    label: "In Progress",      dot: "bg-green-500" },
  { key: "waiting_client", label: "Awaiting Client", dot: "bg-amber-400" },
  { key: "waiting_sbc",    label: "Awaiting Us",    dot: "bg-[#000000]" },
  { key: "awaiting_vendor",label: "Awaiting Vendor",   dot: "bg-orange-400" },
];

function StatusSettingsView() {
  const [criteria, setCriteria] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/proxy/projects/status-settings")
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setCriteria(data.criteria); setLoading(false); });
  }, []);

  async function save() {
    setSaving(true);
    await fetch("/api/proxy/projects/status-settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ criteria }),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (loading) return <div className="py-12 text-center text-sm text-zinc-400">Loading settings…</div>;

  return (
    <div className="max-w-2xl space-y-6 pt-2">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-1">AI Status Criteria</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Define what each status means. The AI reads recent emails and open tasks, then picks the best match.
        </p>
      </div>
      <div className="space-y-4">
        {STATUS_OPTIONS.map(({ key, label, dot }) => (
          <div key={key} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{label}</span>
            </div>
            <AutoTextarea
              rows={3}
              value={criteria[key] ?? ""}
              onChange={e => setCriteria(prev => ({ ...prev, [key]: e.target.value }))}
              placeholder={`Describe when a project should be marked as "${label}"…`}
              className="w-full text-sm px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none placeholder-zinc-400"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : "Save Criteria"}
        </button>
        {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
      </div>
    </div>
  );
}

// ── Project Drawer ────────────────────────────────────────────────────────────

function ProjectDrawer({ projectId, onClose, onUpdate }: { projectId: string; onClose: () => void; onUpdate: () => void }) {
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
          <ProjectDetailView id={projectId} onClose={onClose} onUpdate={onUpdate} />
        </div>
      </div>
    </>
  );
}

// ── Create Project Modal ──────────────────────────────────────────────────────

function CreateModal({ onClose, onCreated, defaultType }: { onClose: () => void; onCreated: (id: string) => void; defaultType: string }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(defaultType);
  const [stage, setStage] = useState("");
  const [loading, setLoading] = useState(false);
  const stages = STAGE_SEQUENCES[type] ?? [];
  useEffect(() => setStage(stages[0] ?? ""), [type]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const r = await fetch("/api/proxy/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), project_type: type, stage, status: "in_progress" }),
      });
      if (!r.ok) throw new Error();
      const data = await r.json();
      onCreated(data.project_id);
    } catch { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl w-full max-w-md border border-zinc-200 dark:border-zinc-700">
        <div className="p-5 border-b border-zinc-100 dark:border-zinc-800"><h2 className="font-semibold text-zinc-900 dark:text-zinc-100">New Project</h2></div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Project Name</label>
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Cellulosic Ethanol R&D — Acme Corp" />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Type</label>
            <select value={type} onChange={e => setType(e.target.value)} className={`w-full ${SEL}`}>
              <option value="crm_opportunity">R&D Contract</option>
              <option value="portfolio">Portfolio Contract</option>
              <option value="partnership">Partnership</option>
              <option value="grant">Grant / Funding</option>
              <option value="internal">Operations</option>
              <option value="marketing">Marketing</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Initial Stage</label>
            <select value={stage} onChange={e => setStage(e.target.value)} className={`w-full ${SEL}`}>
              {stages.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400">Cancel</button>
            <button type="submit" disabled={!name.trim() || loading} className="flex-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 font-medium">{loading ? "Creating…" : "Create Project"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────


function defaultViewMode(_tab: TabKey): ViewMode {
  return "pipeline";
}

function ProjectsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = (searchParams.get("tab") ?? DEFAULT_TAB) as TabKey;

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [subTab, setSubTab] = useState<"projects" | "templates" | "settings">("projects");
  const [viewMode, setViewMode] = useState<ViewMode>(() => defaultViewMode(activeTab));
  const [showCreate, setShowCreate] = useState(false);
  const prevTabRef = useRef<TabKey>(activeTab);
  const panelId = searchParams.get("panel");

  function closePanel() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("panel");
    const qs = params.toString();
    router.replace(`/projects${qs ? "?" + qs : ""}`);
  }

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (statusFilter) params.set("status", statusFilter);
    try {
      const r = await fetch(`/api/proxy/projects?${params}`);
      if (r.ok) setProjects(await r.json());
    } finally { setLoading(false); }
  }, [search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Reset view state when tab changes via URL navigation
  useEffect(() => {
    if (prevTabRef.current !== activeTab) {
      setViewMode(defaultViewMode(activeTab));
      setSubTab("projects");
      prevTabRef.current = activeTab;
    }
  }, [activeTab]);

  // Open create modal when ?create=1 is in URL
  useEffect(() => {
    if (searchParams.get("create") === "1") {
      setShowCreate(true);
      const params = new URLSearchParams(searchParams.toString());
      params.delete("create");
      const qs = params.toString();
      router.replace(`/projects${qs ? "?" + qs : ""}`);
    }
  }, [searchParams, router]);

  const tabProjects = useMemo(() => projects.filter(p => p.project_type === activeTab), [projects, activeTab]);

  const handleDelete = useCallback(async (id: string) => {
    setProjects(prev => prev.filter(p => p.project_id !== id));
    await fetch(`/api/proxy/projects/${id}`, { method: "DELETE" });
  }, []);

  const handleStatusChange = useCallback(async (id: string, status: string) => {
    setProjects(prev => prev.map(p => p.project_id === id ? { ...p, status } : p));
    await fetch(`/api/proxy/projects/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }, []);

  const viewOptions: { key: ViewMode; label: string }[] = [
    { key: "pipeline", label: "Pipeline" },
    { key: "timeline", label: "Gantt" },
    { key: "table", label: "Table" },
  ];

  const safeViewMode: ViewMode = viewMode;

  const isContractsGroup = activeTab === "crm_opportunity" || activeTab === "portfolio";
  const isPartnershipGroup = activeTab === "partnership";

  return (
    <div className="px-4 sm:px-6 pt-3 pb-6 max-w-[1400px] mx-auto space-y-3">
      {/* Group subtab row (Contracts or Partnerships) */}
      {(isContractsGroup || isPartnershipGroup) && (
        <div className="flex items-center gap-1 border-b border-zinc-100 dark:border-zinc-800/60 pb-0">
          {isContractsGroup && (
            <>
              <Link href="/projects?tab=crm_opportunity"
                className={`px-3 pb-2 text-sm font-medium border-b-2 transition-colors -mb-px ${activeTab === "crm_opportunity" ? "border-zinc-700 dark:border-zinc-300 text-zinc-900 dark:text-zinc-100" : "border-transparent text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
                R&D Contracts
              </Link>
              <Link href="/projects?tab=portfolio"
                className={`px-3 pb-2 text-sm font-medium border-b-2 transition-colors -mb-px ${activeTab === "portfolio" ? "border-zinc-700 dark:border-zinc-300 text-zinc-900 dark:text-zinc-100" : "border-transparent text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
                Portfolio Contracts
              </Link>
            </>
          )}
          {isPartnershipGroup && (
            <>
              <Link href="/projects?tab=partnership"
                className={`px-3 pb-2 text-sm font-medium border-b-2 transition-colors -mb-px ${activeTab === "partnership" ? "border-zinc-700 dark:border-zinc-300 text-zinc-900 dark:text-zinc-100" : "border-transparent text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
                Partnerships
              </Link>
              <Link href="/projects/advisors"
                className="px-3 pb-2 text-sm font-medium border-b-2 border-transparent text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors -mb-px">
                Advisors
              </Link>
            </>
          )}
        </div>
      )}

      {/* Templates/Settings subtab row */}
      <div className="flex items-center gap-5 border-b border-zinc-100 dark:border-zinc-800/60 pb-0">
        {(["projects", "templates", "settings"] as const).map(st => (
          <button key={st} onClick={() => setSubTab(st)}
            className={`pb-2 text-sm font-medium border-b-2 transition-colors -mb-px ${subTab === st ? "border-zinc-700 dark:border-zinc-300 text-zinc-900 dark:text-zinc-100" : "border-transparent text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}>
            {st === "projects" ? "Projects" : st === "templates" ? "Templates & Automation" : "Settings"}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      {subTab === "projects" && (
        <div className="flex flex-wrap items-center gap-2">
          {viewMode !== "pipeline" && (
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects…"
              className="flex-1 min-w-[180px] max-w-[280px] px-3 py-1.5 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40 placeholder-zinc-400 transition-shadow" />
          )}
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={SEL}>
            <option value="">All statuses</option>
            <option value="in_progress">In Progress</option>
            <option value="waiting_client">Awaiting Client</option>
            <option value="waiting_sbc">Awaiting Founder ERP</option>
            <option value="awaiting_vendor">Awaiting Vendor</option>
          </select>
          <div className="ml-auto flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-1">
            {viewOptions.map(v => (
              <button key={v.key} onClick={() => setViewMode(v.key)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${viewMode === v.key ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm font-medium" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-30"}`}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {subTab === "settings" ? (
        <StatusSettingsView />
      ) : subTab === "templates" ? (
        <TemplatesView tabKey={activeTab} />
      ) : loading ? (
        <div className="py-12 text-center text-sm text-zinc-400 dark:text-zinc-500">Loading projects…</div>
      ) : (
        <>
          {safeViewMode === "pipeline" && activeTab === "partnership" && (
            <PartnershipPipelineView projects={tabProjects} onDelete={handleDelete} onUpdate={load} />
          )}
          {safeViewMode === "pipeline" && activeTab !== "partnership" && (
            <PipelineView projects={tabProjects} tabKey={activeTab} onDelete={handleDelete} onUpdate={load} />
          )}
          {safeViewMode === "table" && <TableView projects={tabProjects} onDelete={handleDelete} onStatusChange={handleStatusChange} />}
          {safeViewMode === "timeline" && <TimelineView projects={tabProjects} />}
        </>
      )}

      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreated={id => { setShowCreate(false); router.push(`/projects/${id}`); }} defaultType={activeTab} />
      )}

      {panelId && <ProjectDrawer projectId={panelId} onClose={closePanel} onUpdate={load} />}
    </div>
  );
}

export default function ProjectsPage() {
  return <Suspense><ProjectsContent /></Suspense>;
}
