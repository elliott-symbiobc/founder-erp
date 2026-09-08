"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Project {
  project_id: string;
  name: string;
  project_type: string;
  stage: string | null;
  status: string;
  probability: number | null;
  expected_revenue: number | null;
  date_start: string | null;
  date_deadline: string | null;
  tags: string[];
  notes: string | null;
  section: string | null;
  crm_type: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_org: string | null;
  contact_avatar: string | null;
  contact_email: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  task_count: number;
  tasks_done: number;
  last_email_at: string | null;
  email_count: number;
  created_at: string;
  updated_at: string;
}

export interface CardTask {
  task_id: string;
  title: string;
  status: string;
  assigned_to_name: string | null;
  locked: boolean;
  due_date: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const STATUS_CARD: Record<string, string> = {
  in_progress:     "bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800/50",
  waiting_client:  "bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800/50",
  waiting_sbc:     "bg-[#000000]/10 border-[#000000]/30 dark:bg-[#000000]/15 dark:border-[#000000]/40",
  awaiting_vendor: "bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800/50",
};

export const STATUS_DOT: Record<string, string> = {
  in_progress:     "bg-green-500",
  waiting_client:  "bg-amber-400",
  waiting_sbc:     "bg-[#000000]",
  awaiting_vendor: "bg-orange-400",
};

export const STATUS_LABEL: Record<string, string> = {
  in_progress:     "In Progress",
  waiting_client:  "Awaiting Client",
  waiting_sbc:     "Awaiting Us",
  awaiting_vendor: "Awaiting Vendor",
};

export const TYPE_BADGE: Record<string, string> = {
  crm_opportunity: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  portfolio:       "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  partnership:     "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  grant:           "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  internal:        "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  marketing:       "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

export const TYPE_LABELS: Record<string, string> = {
  crm_opportunity: "R&D Contract", portfolio: "Portfolio",
  partnership: "Partnership", grant: "Grant",
  internal: "Operations", marketing: "Marketing",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

export function fmtCurrency(v: number | null): string | null {
  if (!v) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function daysUntil(d: string | null): number | null {
  if (!d) return null;
  const diff = new Date(d).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

export function daysSince(d: string | null): number | null {
  if (!d) return null;
  const diff = Date.now() - new Date(d).getTime();
  return Math.floor(diff / 86_400_000);
}

// ── Avatar ─────────────────────────────────────────────────────────────────────

// Avatar now lives in components/Avatar.tsx; re-exported for existing importers.
export { Avatar };

// ── ProjectCard ────────────────────────────────────────────────────────────────

export function ProjectCard({ p, compact = false, onDelete, onUpdate, showType = false, href }:
  { p: Project; compact?: boolean; onDelete?: (id: string) => void; onUpdate?: () => void; showType?: boolean; href?: string }) {
  const router = useRouter();
  const deadline = daysUntil(p.date_deadline);
  const lastEmail = daysSince(p.last_email_at);
  const [confirmDel, setConfirmDel] = useState(false);
  const [localStatus, setLocalStatus] = useState(p.status);
  const [tasks, setTasks] = useState<CardTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const loadedForCount = useRef<number>(-1);

  async function loadTasks(count: number) {
    const r = await fetch(`/api/proxy/tasks?project_id=${p.project_id}&all_users=true`);
    if (r.ok) { const all: CardTask[] = await r.json(); setTasks(all.filter(t => t.status === "open" && !t.locked)); }
    loadedForCount.current = count;
    setTasksLoaded(true);
  }

  useEffect(() => {
    if (!compact) return;
    if (loadedForCount.current === p.task_count && tasksLoaded) return;
    loadTasks(p.task_count);
  }, [p.project_id, p.task_count]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleTask(t: CardTask) {
    await fetch(`/api/proxy/tasks/${t.task_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    setTasks(prev => prev.filter(x => x.task_id !== t.task_id));
  }

  async function patchProject(field: string, value: string) {
    await fetch(`/api/proxy/projects/${p.project_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    onUpdate?.();
  }

  return (
    <div className="relative group">
      <div
        className="relative group/card border rounded-lg p-3 hover:shadow-sm transition-all cursor-pointer bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600"
        onClick={() => router.push(href ?? `/projects/${p.project_id}`)}
      >
        {compact && <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded ${STATUS_DOT[localStatus] ?? "bg-zinc-300"}`} />}
        <div className={compact ? "pl-3" : ""}>
        {/* Company + type badge */}
        <div className="flex items-start justify-between gap-2 mb-0.5">
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate group-hover/card:text-blue-600 dark:group-hover/card:text-blue-400 transition-colors leading-tight">
            {p.contact_org ?? p.contact_name ?? p.name}
          </span>
          {showType && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide shrink-0 ${TYPE_BADGE[p.project_type] ?? "bg-gray-100 text-gray-500"}`}>
              {TYPE_LABELS[p.project_type] ?? p.project_type}
            </span>
          )}
        </div>

        {/* Status + revenue + owner */}
        <div className="flex items-center gap-1.5 mb-2" onClick={e => e.stopPropagation()}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[localStatus] ?? "bg-gray-300"}`} />
          <select
            value={localStatus}
            onChange={e => { setLocalStatus(e.target.value); patchProject("status", e.target.value); }}
            className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none"
          >
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
            {p.expected_revenue ? (
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">{fmtCurrency(p.expected_revenue)}</span>
            ) : null}
            {p.assigned_to_name && (
              <div className="flex items-center gap-1" title={p.assigned_to_name}>
                <Avatar name={p.assigned_to_name} url={null} size={4} />
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[60px]">{p.assigned_to_name.split(" ")[0]}</span>
              </div>
            )}
          </div>
        </div>

        {/* Plan needed flag */}
        {(p.project_type === "crm_opportunity" || p.project_type === "portfolio" || p.project_type === "grant") && p.task_count === 0 && (
          <div className="flex items-center gap-1 mb-2 -mt-1" onClick={e => e.stopPropagation()}>
            <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M4 3h16v13l-8 5-8-5V3z" />
            </svg>
            <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Plan needed</span>
          </div>
        )}

        {/* Contact + last email inline */}
        {(p.contact_name || deadline !== null || lastEmail !== null) && (
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-1">
            {p.contact_name && (
              <>
                <Avatar name={p.contact_name} url={p.contact_avatar} size={4} />
                <span className="truncate flex-1">{p.contact_name}</span>
              </>
            )}
            {!p.contact_name && deadline !== null && (
              <span className={`flex-1 ${deadline < 0 ? "text-red-500 font-medium" : deadline < 7 ? "text-amber-500" : ""}`}>
                {deadline < 0 ? `${Math.abs(deadline)}d overdue` : `${deadline}d left`}
              </span>
            )}
            {p.contact_name && deadline !== null && (
              <span className={`flex-shrink-0 ${deadline < 0 ? "text-red-500 font-medium" : deadline < 7 ? "text-amber-500" : ""}`}>
                {deadline < 0 ? `${Math.abs(deadline)}d overdue` : `${deadline}d left`}
              </span>
            )}
            {lastEmail !== null && (
              <span className={`flex-shrink-0 ml-auto ${lastEmail > 7 ? "text-red-500 font-semibold" : ""}`}>
                {lastEmail === 0 ? "Today" : `${lastEmail}d ago`}
              </span>
            )}
          </div>
        )}

        {/* Active tasks toggle (compact/pipeline mode only) */}
        {compact && tasksLoaded && tasks.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5 mt-2 pt-2 space-y-1" onClick={e => e.stopPropagation()}>
            {tasks.map(t => (
              <div key={t.task_id} className="flex items-center gap-1.5">
                <button
                  onClick={() => toggleTask(t)}
                  className="w-3.5 h-3.5 rounded border border-zinc-300 dark:border-zinc-600 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 flex-shrink-0 transition-colors"
                />
                <span className="flex-1 text-[11px] text-zinc-600 dark:text-zinc-300 truncate min-w-0">{t.title}</span>
                {t.due_date && (() => { const dl = daysUntil(t.due_date); return (
                  <span className={`text-[10px] flex-shrink-0 font-medium ${dl !== null && dl < 0 ? "text-red-500" : dl !== null && dl < 3 ? "text-amber-500" : "text-zinc-400 dark:text-zinc-500"}`}>
                    {dl !== null && dl < 0 ? `${Math.abs(dl)}d late` : dl === 0 ? "today" : `${dl}d`}
                  </span>
                ); })()}
                {t.assigned_to_name && (
                  <span className="text-[10px] text-zinc-400 flex-shrink-0">{t.assigned_to_name.split(" ")[0]}</span>
                )}
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Delete button */}
      {onDelete && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10" onClick={e => e.stopPropagation()}>
          {confirmDel ? (
            <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-800 rounded-lg px-2 py-1 shadow-sm">
              <span className="text-[10px] text-red-600 dark:text-red-400 font-medium">Delete?</span>
              <button onClick={() => onDelete(p.project_id)} className="text-[10px] px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded font-medium">Yes</button>
              <button onClick={() => setConfirmDel(false)} className="text-[10px] px-1.5 py-0.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDel(true)}
              className="w-6 h-6 flex items-center justify-center rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 hover:border-red-300 dark:hover:border-red-700 shadow-sm transition-colors"
              title="Delete project"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
