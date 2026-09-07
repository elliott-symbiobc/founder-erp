"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface User { user_id: string; name: string; full_name?: string; avatar_url?: string; }

interface Milestone {
  milestone_id: string;
  title: string;
  description: string | null;
  milestone_type: string;
  status: string;
  due_date: string | null;
  start_date: string | null;
  completed_at: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owner_avatar: string | null;
  sort_order: number;
  document_deliverable: boolean;
  integration_refs: Record<string, unknown>;
  open_task_count: number;
  done_task_count: number;
  assignees: Array<{ user_id: string; role: string; name: string; avatar_url?: string }> | null;
  blocked_by_count: number;
  blocks_count: number;
}

interface Task {
  task_id: string;
  title: string;
  status: string;
  kanban_status: string;
  due_date: string | null;
  start_date: string | null;
  description: string | null;
  priority: string | null;
  activity_type: string | null;
  milestone_id: string | null;
  milestone_title: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  extra_assignees: Array<{ user_id: string; role: string; name: string }> | null;
  blocked_by_count: number;
  estimated_minutes: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEL_XS = "text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-5 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.25rem_center] bg-[length:0.8rem]";

const MILESTONE_STATUS_COLORS: Record<string, string> = {
  pending:          "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  in_progress:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blocked:          "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  complete:         "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  skipped:          "bg-zinc-100 text-zinc-400 dark:bg-zinc-800",
  waiting_external: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};

const MILESTONE_TYPE_ICON: Record<string, string> = {
  objective:     "○",
  checkpoint:    "◆",
  deliverable:   "▣",
  approval:      "✓",
  external_wait: "⧗",
  repeating:     "↺",
};

const ACTIVITY_ICON: Record<string, string> = {
  email:     "✉",
  call:      "☎",
  meeting:   "◎",
  document:  "▣",
  todo:      "○",
  in_silico: "⬡",
  wet_lab:   "⚗",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function daysUntil(d: string | null) {
  if (!d) return null;
  return Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
}

function SectionHeader({ title, count, action }: { title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
        {title}
        {count !== undefined && (
          <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded">{count}</span>
        )}
      </h3>
      {action}
    </div>
  );
}

// ── Tasks within a Milestone ──────────────────────────────────────────────────

function TasksInMilestone({ milestoneId, tasks, onToggle, onAdd, projectId, users }:
  { milestoneId: string; tasks: Task[]; onToggle: (t: Task) => void; onAdd: (title: string) => void; projectId: string; users: User[] }) {
  const [addingTask, setAddingTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");

  return (
    <div className="space-y-1">
      {tasks.map(t => (
        <div key={t.task_id} className={`flex items-center gap-2 text-xs px-1 py-1 rounded hover:bg-white dark:hover:bg-zinc-800/50 group ${t.status === "done" ? "opacity-50" : ""}`}>
          <button
            onClick={() => onToggle(t)}
            className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
              t.status === "done" ? "bg-green-500 border-green-500 text-white" : "border-zinc-300 dark:border-zinc-600 hover:border-green-400"
            }`}
          >
            {t.status === "done" && <svg className="w-2 h-2" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
          </button>

          {t.activity_type && (
            <span className="text-zinc-300 dark:text-zinc-600 w-3 flex-shrink-0">{ACTIVITY_ICON[t.activity_type] ?? ""}</span>
          )}
          {t.priority && (
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.priority === "high" ? "bg-red-500" : t.priority === "medium" ? "bg-amber-400" : "bg-zinc-300"}`} />
          )}

          <span className={`flex-1 truncate ${t.status === "done" ? "line-through text-zinc-400" : "text-zinc-700 dark:text-zinc-200"}`}>
            {t.blocked_by_count > 0 && <span className="text-red-400 mr-1" title="Blocked">⚠</span>}
            {t.title}
          </span>

          {t.due_date && (
            <span className={`flex-shrink-0 text-[10px] ${(daysUntil(t.due_date) ?? 1) < 0 ? "text-red-400" : "text-zinc-400"}`}>
              {fmtDate(t.due_date)}
            </span>
          )}

          {t.assigned_to_name && (
            <span className="flex-shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">{t.assigned_to_name}</span>
          )}

          <Link href={`/tasks`} className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-blue-500 flex-shrink-0">→</Link>
        </div>
      ))}

      {addingTask ? (
        <div className="flex gap-1.5 mt-1">
          <input
            autoFocus
            value={taskTitle}
            onChange={e => setTaskTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { onAdd(taskTitle); setTaskTitle(""); setAddingTask(false); }
              if (e.key === "Escape") { setAddingTask(false); setTaskTitle(""); }
            }}
            placeholder="Task title…"
            className="flex-1 px-2 py-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button onClick={() => { onAdd(taskTitle); setTaskTitle(""); setAddingTask(false); }} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">Add</button>
          <button onClick={() => { setAddingTask(false); setTaskTitle(""); }} className="text-xs text-zinc-400 hover:text-zinc-600">✕</button>
        </div>
      ) : (
        <button onClick={() => setAddingTask(true)} className="text-xs text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400 mt-1 pl-1">
          + Add task
        </button>
      )}
    </div>
  );
}

// ── MilestonesSection ─────────────────────────────────────────────────────────

export function MilestonesSection({ projectId, projectType }: { projectId: string; projectType: string }) {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<Record<string, Task[]>>({});
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("objective");
  const [showApplyTemplate, setShowApplyTemplate] = useState(false);
  const [templates, setTemplates] = useState<Array<{ template_id: string; name: string; milestone_count: number }>>([]);
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/projects/${projectId}/milestones`);
    if (r.ok) setMilestones(await r.json());
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch("/api/proxy/tasks/users").then(r => r.ok ? r.json() : []).then(setUsers);
  }, []);

  async function loadTasks(mid: string) {
    if (tasks[mid]) return;
    const r = await fetch(`/api/proxy/tasks?milestone_id=${mid}`);
    if (r.ok) { const data = await r.json(); setTasks(prev => ({ ...prev, [mid]: data })); }
  }

  async function toggleExpand(mid: string) {
    if (expanded.has(mid)) {
      setExpanded(prev => { const s = new Set(prev); s.delete(mid); return s; });
    } else {
      setExpanded(prev => new Set([...prev, mid]));
      await loadTasks(mid);
    }
  }

  async function addMilestone() {
    if (!newTitle.trim()) return;
    await fetch(`/api/proxy/projects/${projectId}/milestones`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), milestone_type: newType }),
    });
    setNewTitle(""); setAdding(false);
    load();
  }

  async function completeM(mid: string) {
    await fetch(`/api/proxy/projects/${projectId}/milestones/${mid}/complete`, { method: "POST" });
    load();
  }

  async function updateStatus(mid: string, status: string) {
    await fetch(`/api/proxy/projects/${projectId}/milestones/${mid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  async function deleteM(mid: string) {
    if (!confirm("Delete this milestone and unlink its tasks?")) return;
    await fetch(`/api/proxy/projects/${projectId}/milestones/${mid}`, { method: "DELETE" });
    load();
  }

  async function loadTemplates() {
    const r = await fetch(`/api/proxy/project-templates?project_type=${projectType}`);
    if (r.ok) setTemplates(await r.json());
    setShowApplyTemplate(true);
  }

  async function applyTemplate(tid: string) {
    setApplyingTemplate(true);
    await fetch(`/api/proxy/projects/${projectId}/milestones/from-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: tid, include_tasks: true }),
    });
    setApplyingTemplate(false);
    setShowApplyTemplate(false);
    load();
  }

  async function addTask(mid: string, title: string) {
    if (!title.trim()) return;
    await fetch("/api/proxy/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), project_id: projectId, milestone_id: mid, kanban_status: "todo" }),
    });
    const r = await fetch(`/api/proxy/tasks?milestone_id=${mid}`);
    if (r.ok) { const data = await r.json(); setTasks(prev => ({ ...prev, [mid]: data })); }
  }

  async function toggleTask(t: Task) {
    const newStatus = t.status === "done" ? "open" : "done";
    await fetch(`/api/proxy/tasks/${t.task_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    const mid = t.milestone_id;
    if (mid) {
      const r = await fetch(`/api/proxy/tasks?milestone_id=${mid}`);
      if (r.ok) { const data = await r.json(); setTasks(prev => ({ ...prev, [mid]: data })); }
    }
    load();
  }

  const completedCount = milestones.filter(m => m.status === "complete").length;
  const blockedCount = milestones.filter(m => m.status === "blocked").length;

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader
        title="Milestones & Objectives"
        count={milestones.length}
        action={
          <div className="flex items-center gap-2">
            {blockedCount > 0 && (
              <span className="text-xs text-red-500 font-medium">{blockedCount} blocked</span>
            )}
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{completedCount}/{milestones.length} done</span>
            <button onClick={loadTemplates} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline">Apply template</button>
            <button onClick={() => setAdding(true)} className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">+ Add</button>
          </div>
        }
      />

      {/* Progress bar */}
      {milestones.length > 0 && (
        <div className="h-1.5 rounded bg-zinc-100 dark:bg-zinc-800 mb-4 overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded transition-all"
            style={{ width: `${milestones.length > 0 ? (completedCount / milestones.length) * 100 : 0}%` }}
          />
        </div>
      )}

      {/* Template apply panel */}
      {showApplyTemplate && (
        <div className="mb-4 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Apply a Template</span>
            <button onClick={() => setShowApplyTemplate(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
          {templates.length === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No templates found for this project type.</p>
          ) : (
            <div className="space-y-1">
              {templates.map(t => (
                <button
                  key={t.template_id}
                  onClick={() => applyTemplate(t.template_id)}
                  disabled={applyingTemplate}
                  className="w-full text-left text-xs px-3 py-2 rounded border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
                >
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{t.name}</span>
                  <span className="text-zinc-400 dark:text-zinc-500 ml-2">({t.milestone_count} milestones)</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Milestone list */}
      <div className="space-y-1.5">
        {milestones.map(m => {
          const isExpanded = expanded.has(m.milestone_id);
          const isBlocked = m.status === "blocked";
          const pct = (m.open_task_count + m.done_task_count) > 0
            ? Math.round((m.done_task_count / (m.open_task_count + m.done_task_count)) * 100)
            : null;
          const overdue = m.due_date && daysUntil(m.due_date) !== null && (daysUntil(m.due_date) ?? 0) < 0 && m.status !== "complete";

          return (
            <div key={m.milestone_id} className={`rounded-lg border transition-colors ${
              isBlocked ? "border-red-200 dark:border-red-900/50 bg-red-50/30 dark:bg-red-900/10" :
              m.status === "complete" ? "border-green-100 dark:border-green-900/30 bg-green-50/20 dark:bg-green-900/10" :
              "border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30"
            }`}>
              {/* Milestone header */}
              <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer" onClick={() => toggleExpand(m.milestone_id)}>
                <span className="text-base leading-none text-zinc-400 dark:text-zinc-500 w-4 flex-shrink-0">
                  {MILESTONE_TYPE_ICON[m.milestone_type] ?? "○"}
                </span>

                {/* Complete toggle */}
                <button
                  onClick={e => { e.stopPropagation(); m.status !== "complete" ? completeM(m.milestone_id) : updateStatus(m.milestone_id, "pending"); }}
                  className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                    m.status === "complete" ? "bg-green-500 border-green-500 text-white" : "border-zinc-300 dark:border-zinc-600 hover:border-green-400"
                  }`}
                >
                  {m.status === "complete" && <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>}
                </button>

                <span className={`flex-1 text-sm font-medium min-w-0 truncate ${m.status === "complete" ? "line-through text-zinc-400 dark:text-zinc-500" : "text-zinc-900 dark:text-zinc-100"}`}>
                  {m.title}
                </span>

                {/* Badges */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {isBlocked && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 font-medium">BLOCKED</span>
                  )}
                  {m.document_deliverable && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400 font-medium">DOC</span>
                  )}
                  {m.blocks_count > 0 && (
                    <span title={`Blocks ${m.blocks_count} milestone(s)`} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
                      ↠{m.blocks_count}
                    </span>
                  )}
                  {pct !== null && (
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">{pct}%</span>
                  )}
                  {m.due_date && (
                    <span className={`text-[11px] ${overdue ? "text-red-500 font-medium" : "text-zinc-400 dark:text-zinc-500"}`}>
                      {fmtDate(m.due_date)}
                    </span>
                  )}
                  {m.assignees && m.assignees.length > 0 && (
                    <div className="flex -space-x-1">
                      {m.assignees.slice(0, 3).map(a => (
                        <Avatar key={a.user_id} name={a.name} url={a.avatar_url} size={5} />
                      ))}
                    </div>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${MILESTONE_STATUS_COLORS[m.status] ?? ""}`}>
                    {m.status.replace("_", " ")}
                  </span>
                  <svg className={`w-3 h-3 text-zinc-400 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
                  </svg>
                </div>
              </div>

              {/* Expanded: tasks */}
              {isExpanded && (
                <div className="border-t border-zinc-100 dark:border-zinc-800 px-3 pt-2 pb-3">
                  {m.description && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">{m.description}</p>
                  )}
                  <TasksInMilestone
                    milestoneId={m.milestone_id}
                    tasks={tasks[m.milestone_id] ?? []}
                    onToggle={toggleTask}
                    onAdd={title => addTask(m.milestone_id, title)}
                    projectId={projectId}
                    users={users}
                  />
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <select
                      value={m.status}
                      onChange={e => { e.stopPropagation(); updateStatus(m.milestone_id, e.target.value); }}
                      className={SEL_XS}
                      onClick={e => e.stopPropagation()}
                    >
                      {["pending","in_progress","blocked","complete","skipped","waiting_external"].map(s => (
                        <option key={s} value={s}>{s.replace("_", " ")}</option>
                      ))}
                    </select>
                    <Link href={`/projects/${projectId}?milestone=${m.milestone_id}`} className="text-xs text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400">
                      Details →
                    </Link>
                    <button onClick={() => deleteM(m.milestone_id)} className="text-xs text-red-400 hover:text-red-600 ml-auto">Delete</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add milestone inline */}
      {adding ? (
        <div className="mt-2 flex gap-2">
          <select value={newType} onChange={e => setNewType(e.target.value)} className={SEL_XS}>
            {["objective","checkpoint","deliverable","approval","external_wait","repeating"].map(t => (
              <option key={t} value={t}>{t.replace("_", " ")}</option>
            ))}
          </select>
          <input
            autoFocus
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addMilestone(); if (e.key === "Escape") { setAdding(false); setNewTitle(""); }}}
            placeholder="Milestone title…"
            className="flex-1 px-3 py-1.5 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={addMilestone} className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
          <button onClick={() => { setAdding(false); setNewTitle(""); }} className="text-xs px-3 py-1.5 text-zinc-400 hover:text-zinc-600">Cancel</button>
        </div>
      ) : milestones.length === 0 && (
        <div className="text-center py-4 text-sm text-zinc-400 dark:text-zinc-500 italic">
          No milestones yet. <button onClick={() => setAdding(true)} className="underline">Add one</button> or <button onClick={loadTemplates} className="underline">apply a template</button>.
        </div>
      )}
    </div>
  );
}
