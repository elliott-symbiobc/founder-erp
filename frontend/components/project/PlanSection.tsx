"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
const API = "/api/proxy";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Objective {
  milestone_id: string;
  title: string;
  status: string;
  due_date: string | null;
  start_date: string | null;
  owner_id: string | null;
  owner_name: string | null;
  sort_order: number;
  open_task_count: number;
  done_task_count: number;
}

interface PlanTask {
  task_id: string;
  title: string;
  status: string;
  task_type: string | null;
  due_date: string | null;
  start_date: string | null;
  milestone_id: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  locked: boolean;
  description: string | null;
  follow_up_of: string | null;
  trigger_days: number | null;
  condition: string | null;
}

interface PlanUser {
  user_id: string;
  name: string;
}

// ── Select components ─────────────────────────────────────────────────────────

function StatusPill({ value, onChange, onClick }: { value: string; onChange: (v: string) => void; onClick?: (e: React.MouseEvent) => void }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    not_started: { label: "Not Started", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
    in_progress:  { label: "In Progress",  cls: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300" },
    complete:     { label: "Complete",     cls: "bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-300" },
    blocked:      { label: "Blocked",      cls: "bg-red-50 text-red-500 dark:bg-red-900/30 dark:text-red-400" },
  };
  const c = cfg[value] ?? cfg.not_started;
  return (
    <div className="relative inline-flex shrink-0" onClick={onClick}>
      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded tracking-wide ${c.cls}`}>
        {c.label}
        <svg className="w-2 h-2 opacity-50" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
      </span>
      <select value={value} onChange={e => onChange(e.target.value)} className="absolute inset-0 w-full opacity-0 cursor-pointer text-xs" />
    </div>
  );
}

function TypePill({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const tt = value ? TASK_TYPE_MAP[value] : null;
  const dotColors: Record<string, string> = {
    deliverable:      "bg-blue-400",
    follow_up:        "bg-amber-400",
    request_approval: "bg-purple-400",
    send_to_client:   "bg-green-400",
  };
  return (
    <div className="relative inline-flex shrink-0">
      <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded ${tt?.color ?? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"}`}>
        {tt && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[value!] ?? "bg-zinc-400"}`} />}
        {tt?.label ?? "Type"}
      </span>
      <select value={value ?? ""} onChange={e => onChange(e.target.value || null)} className="absolute inset-0 w-full opacity-0 cursor-pointer text-xs">
        <option value="">No type</option>
        {TASK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
    </div>
  );
}

function AssigneePill({ value, onChange, users, placeholder = "Assign…", onClick }: { value: string | null; onChange: (v: string | null) => void; users: PlanUser[]; placeholder?: string; onClick?: (e: React.MouseEvent) => void }) {
  const u = users.find(u => u.user_id === value);
  return (
    <div className="relative inline-flex shrink-0" onClick={onClick}>
      {u ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          <span className="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-[9px] font-bold shrink-0">
            {u.name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase()}
          </span>
          <span className="max-w-[70px] truncate">{u.name.split(" ")[0]}</span>
        </span>
      ) : (
        <span className="text-[11px] text-zinc-300 dark:text-zinc-600 italic">{placeholder}</span>
      )}
      <select value={value ?? ""} onChange={e => onChange(e.target.value || null)} className="absolute inset-0 w-full opacity-0 cursor-pointer text-xs">
        <option value="">{placeholder}</option>
        {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
      </select>
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_TYPES: { value: string; label: string; color: string; dot: string }[] = [
  { value: "deliverable",      label: "Deliverable",        color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",       dot: "bg-blue-500" },
  { value: "follow_up",        label: "Follow-up",          color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",    dot: "bg-amber-500" },
  { value: "request_approval", label: "Approval",           color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300", dot: "bg-purple-500" },
  { value: "send_to_client",   label: "Send to Client",     color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",    dot: "bg-green-500" },
  { value: "in_silico",        label: "In-Silico Analysis", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",        dot: "bg-cyan-500" },
  { value: "wet_lab",          label: "Wet Lab Work",       color: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",        dot: "bg-teal-500" },
];

const TASK_TYPE_MAP = Object.fromEntries(TASK_TYPES.map(t => [t.value, t]));

const OBJ_STATUS_COLORS: Record<string, string> = {
  not_started: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  pending:     "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  complete:    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  blocked:     "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
};

type PlanView = "list" | "gantt" | "flow";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateInput(d: string | null) {
  if (!d) return "";
  return d.slice(0, 10);
}

function initials(name: string) {
  return name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase();
}

// ── Inline editable title ─────────────────────────────────────────────────────

function InlineTitle({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <input
        autoFocus value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim()) onSave(draft.trim()); setEditing(false); }}
        onKeyDown={e => {
          if (e.key === "Enter") { if (draft.trim()) onSave(draft.trim()); setEditing(false); }
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={`bg-transparent border-b border-blue-400 focus:outline-none ${className}`}
        style={{ minWidth: 120 }}
      />
    );
  }
  return <span className={`cursor-text hover:text-blue-600 dark:hover:text-blue-400 ${className}`} onClick={() => { setDraft(value); setEditing(true); }}>{value}</span>;
}

// ── List View ─────────────────────────────────────────────────────────────────

function ListView({
  projectId, objectives, tasks, users, onRefresh,
}: {
  projectId: string;
  objectives: Objective[];
  tasks: PlanTask[];
  users: PlanUser[];
  onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(objectives.filter(o => o.status === "not_started" || o.status === "pending").map(o => o.milestone_id))
  );
  const [addingObj, setAddingObj] = useState(false);
  const [newObjTitle, setNewObjTitle] = useState("");
  const [addingTaskFor, setAddingTaskFor] = useState<string | null>(null);
  const [newTask, setNewTask] = useState({ title: "", task_type: "deliverable", due_date: "", assigned_to: "", description: "" });
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState("");
  const [followUpTarget, setFollowUpTarget] = useState<string | null>(null);
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDays, setFollowUpDays] = useState("7");

  function toggle(id: string) {
    setCollapsed(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }

  async function createObjective() {
    if (!newObjTitle.trim()) return;
    await fetch(`${API}/projects/${projectId}/milestones`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newObjTitle.trim(), milestone_type: "objective", status: "pending" }),
    });
    setNewObjTitle(""); setAddingObj(false); onRefresh();
  }

  async function patchObjective(milestoneId: string, fields: Record<string, unknown>) {
    await fetch(`${API}/projects/${projectId}/milestones/${milestoneId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    onRefresh();
  }

  async function deleteObjective(milestoneId: string) {
    await fetch(`${API}/projects/${projectId}/milestones/${milestoneId}`, { method: "DELETE" });
    onRefresh();
  }

  async function createTask(milestoneId: string) {
    if (!newTask.title.trim()) return;
    await fetch(`${API}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: newTask.title.trim(),
        task_type: newTask.task_type || null,
        due_date: newTask.due_date || null,
        assigned_to: newTask.assigned_to || null,
        description: newTask.description || null,
        project_id: projectId,
        milestone_id: milestoneId,
      }),
    });
    setNewTask({ title: "", task_type: "deliverable", due_date: "", assigned_to: "", description: "" });
    setAddingTaskFor(null);
    onRefresh();
  }

  async function createFollowUp(parentTask: PlanTask) {
    if (!followUpTitle.trim()) return;
    await fetch(`${API}/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: followUpTitle.trim(),
        project_id: projectId,
        milestone_id: parentTask.milestone_id,
        follow_up_of: parentTask.task_id,
        trigger_days: parseInt(followUpDays) || 7,
        condition: "no_response",
      }),
    });
    setFollowUpTarget(null); setFollowUpTitle(""); setFollowUpDays("7");
    onRefresh();
  }

  async function toggleTask(task: PlanTask) {
    await fetch(`${API}/tasks/${task.task_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }),
    });
    onRefresh();
  }

  async function patchTask(taskId: string, fields: Record<string, unknown>) {
    await fetch(`${API}/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    onRefresh();
  }

  async function deleteTask(taskId: string) {
    await fetch(`${API}/tasks/${taskId}`, { method: "DELETE" });
    onRefresh();
  }

  const tasksByObjective = tasks.reduce<Record<string, PlanTask[]>>((acc, t) => {
    const key = t.milestone_id ?? "__none__";
    (acc[key] = acc[key] ?? []).push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-2">
      {objectives.map(obj => {
        const objTasks = tasksByObjective[obj.milestone_id] ?? [];
        const isCollapsed = collapsed.has(obj.milestone_id);
        const done = objTasks.filter(t => t.status === "done").length;

        return (
          <div key={obj.milestone_id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            {/* Objective header */}
            <div className="flex items-center gap-2 px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800/50">
              <button onClick={() => toggle(obj.milestone_id)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0">
                <svg className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <StatusPill value={obj.status} onChange={v => patchObjective(obj.milestone_id, { status: v })} onClick={e => e.stopPropagation()} />

              <InlineTitle
                value={obj.title}
                onSave={v => patchObjective(obj.milestone_id, { title: v })}
                className="flex-1 text-sm font-semibold text-zinc-800 dark:text-zinc-100"
              />

              {objTasks.length > 0 && (
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 shrink-0">{done}/{objTasks.length}</span>
              )}

              <input
                type="date"
                value={fmtDateInput(obj.due_date)}
                onChange={e => patchObjective(obj.milestone_id, { due_date: e.target.value || null })}
                onClick={e => e.stopPropagation()}
                className="text-[11px] text-zinc-400 dark:text-zinc-500 bg-transparent border-0 focus:outline-none cursor-pointer w-28 shrink-0"
                title="Due date"
              />

              <AssigneePill value={obj.owner_id ?? null} onChange={v => patchObjective(obj.milestone_id, { owner_id: v })} users={users} placeholder="Owner" onClick={e => e.stopPropagation()} />

              <button
                onClick={() => { setAddingTaskFor(obj.milestone_id); setCollapsed(prev => { const s = new Set(prev); s.delete(obj.milestone_id); return s; }); }}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline shrink-0 px-1"
              >+ Task</button>

              <button
                onClick={() => deleteObjective(obj.milestone_id)}
                className="text-zinc-300 hover:text-red-400 dark:text-zinc-600 dark:hover:text-red-400 shrink-0 text-xs px-0.5"
                title="Delete objective"
              >✕</button>
            </div>

            {/* Tasks */}
            {!isCollapsed && (
              <div>
                {objTasks.map(task => {
                  const tt = task.task_type ? TASK_TYPE_MAP[task.task_type] : null;
                  const isFollowUp = !!task.follow_up_of;
                  const hasFollowUp = objTasks.some(x => x.follow_up_of === task.task_id);
                  return (
                    <div key={task.task_id} className={`border-t border-zinc-100 dark:border-zinc-800/60 group ${isFollowUp ? "ml-6 border-l-2 border-amber-200 dark:border-amber-800/40" : ""}`}>
                      <div className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20">
                        {/* Checkbox */}
                        {task.locked ? (
                          <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center text-zinc-300 dark:text-zinc-600">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>
                          </span>
                        ) : (
                          <button
                            onClick={() => toggleTask(task)}
                            className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${task.status === "done" ? "bg-green-500 border-green-500 text-white" : "border-zinc-300 dark:border-zinc-600 hover:border-blue-400"}`}
                          >
                            {task.status === "done" && (
                              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        )}

                        {isFollowUp
                          ? <span className="text-amber-400 text-xs shrink-0" title={`Follow-up if no reply after ${task.trigger_days ?? 7}d`}>↩</span>
                          : <TypePill value={task.task_type} onChange={v => patchTask(task.task_id, { task_type: v })} />
                        }

                        <InlineTitle
                          value={task.title}
                          onSave={v => patchTask(task.task_id, { title: v })}
                          className={`flex-1 text-sm ${task.status === "done" ? "line-through text-zinc-400 dark:text-zinc-600" : "text-zinc-800 dark:text-zinc-200"}`}
                        />

                        {isFollowUp && (
                          <span className="text-[10px] text-amber-500 shrink-0 font-medium">if no reply · {task.trigger_days ?? 7}d</span>
                        )}

                        <input
                          type="date"
                          value={fmtDateInput(task.due_date)}
                          onChange={e => patchTask(task.task_id, { due_date: e.target.value || null })}
                          className="text-[11px] text-zinc-400 dark:text-zinc-500 bg-transparent border-0 focus:outline-none cursor-pointer w-28 shrink-0"
                        />

                        <AssigneePill value={task.assigned_to} onChange={v => patchTask(task.task_id, { assigned_to: v })} users={users} />

                        <button
                          onClick={() => patchTask(task.task_id, { locked: !task.locked })}
                          className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400 shrink-0 transition-colors"
                          title={task.locked ? "Unlock task" : "Lock task"}
                        >
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/></svg>
                        </button>
                        <button
                          onClick={() => deleteTask(task.task_id)}
                          className="opacity-0 group-hover:opacity-100 text-zinc-300 hover:text-red-400 dark:text-zinc-600 dark:hover:text-red-400 text-xs shrink-0"
                        >✕</button>
                      </div>

                      {/* Description + follow-up inline */}
                      {(editingDescId === task.task_id || task.description || (!hasFollowUp && !isFollowUp) || followUpTarget === task.task_id) && (
                        <div className="px-3 pb-1 ml-6">
                          {editingDescId === task.task_id ? (
                            <AutoTextarea autoFocus value={descDraft} onChange={e => setDescDraft(e.target.value)}
                              onBlur={() => { patchTask(task.task_id, { description: descDraft || null }); setEditingDescId(null); }}
                              onKeyDown={e => { if (e.key === "Escape") setEditingDescId(null); if (e.key === "Enter" && e.metaKey) { patchTask(task.task_id, { description: descDraft || null }); setEditingDescId(null); } }}
                              rows={2} placeholder="Add description…"
                              className="w-full text-xs px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30 resize-none" />
                          ) : task.description ? (
                            <p onClick={() => { setEditingDescId(task.task_id); setDescDraft(task.description ?? ""); }}
                              className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed cursor-text hover:text-zinc-600 dark:hover:text-zinc-300 whitespace-pre-wrap">
                              {task.description}
                            </p>
                          ) : null}

                          {/* Inline action links */}
                          {editingDescId !== task.task_id && followUpTarget !== task.task_id && (
                            <div className="flex items-center gap-3 mt-0.5">
                              {!task.description && (
                                <button onClick={() => { setEditingDescId(task.task_id); setDescDraft(""); }}
                                  className="text-[10px] text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 transition-colors">
                                  + description
                                </button>
                              )}
                              {!hasFollowUp && !isFollowUp && (
                                <button onClick={() => { setFollowUpTarget(task.task_id); setFollowUpTitle(""); setFollowUpDays("7"); }}
                                  className="text-[10px] text-zinc-300 dark:text-zinc-600 hover:text-amber-500 dark:hover:text-amber-400 transition-colors">
                                  + if no reply…
                                </button>
                              )}
                            </div>
                          )}

                          {/* Conditional follow-up form */}
                          {followUpTarget === task.task_id && (
                            <div className="mt-1 flex gap-1 items-center flex-wrap">
                              <input autoFocus value={followUpTitle} onChange={e => setFollowUpTitle(e.target.value)}
                                onKeyDown={e => { if (e.key === "Enter") createFollowUp(task); if (e.key === "Escape") setFollowUpTarget(null); }}
                                placeholder="Follow-up title…"
                                className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] border border-amber-200 dark:border-amber-800 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none" />
                              <span className="text-[10px] text-zinc-400 shrink-0">after</span>
                              <input type="number" min={1} max={90} value={followUpDays} onChange={e => setFollowUpDays(e.target.value)}
                                className="w-8 px-1 py-0.5 text-[11px] border border-amber-200 dark:border-amber-800 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-center focus:outline-none" />
                              <span className="text-[10px] text-zinc-400 shrink-0">d</span>
                              <button onClick={() => createFollowUp(task)} className="text-[10px] px-1.5 py-0.5 bg-amber-500 text-white rounded hover:bg-amber-600 shrink-0">Add</button>
                              <button onClick={() => setFollowUpTarget(null)} className="text-[10px] text-zinc-400 hover:text-zinc-600 shrink-0">✕</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Add task row */}
                {addingTaskFor === obj.milestone_id ? (
                  <div className="border-t border-zinc-100 dark:border-zinc-800/60 px-3 py-2 bg-blue-50/40 dark:bg-blue-950/20">
                    <div className="flex items-center gap-2">
                      <div className="w-4 flex-shrink-0" />
                      <TypePill value={newTask.task_type} onChange={v => setNewTask(p => ({ ...p, task_type: v ?? "deliverable" }))} />
                      <input
                        autoFocus
                        value={newTask.title}
                        onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") createTask(obj.milestone_id); if (e.key === "Escape") { setAddingTaskFor(null); setNewTask({ title: "", task_type: "deliverable", due_date: "", assigned_to: "", description: "" }); } }}
                        placeholder="Task title…"
                        className="flex-1 text-sm bg-transparent border-b border-blue-400 focus:outline-none text-zinc-900 dark:text-zinc-100 placeholder-zinc-400"
                      />
                      <input
                        type="date"
                        value={newTask.due_date}
                        onChange={e => setNewTask(p => ({ ...p, due_date: e.target.value }))}
                        className="text-[11px] text-zinc-400 bg-transparent border-0 focus:outline-none cursor-pointer w-28 shrink-0"
                      />
                      <AssigneePill value={newTask.assigned_to || null} onChange={v => setNewTask(p => ({ ...p, assigned_to: v ?? "" }))} users={users} />
                      <button onClick={() => createTask(obj.milestone_id)} className="text-xs text-blue-600 dark:text-blue-400 font-medium hover:underline shrink-0">Add</button>
                      <button onClick={() => { setAddingTaskFor(null); setNewTask({ title: "", task_type: "deliverable", due_date: "", assigned_to: "", description: "" }); }} className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0">Cancel</button>
                    </div>
                    <input value={newTask.description} onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))}
                      placeholder="Description (optional)…"
                      className="w-full mt-1 text-xs bg-transparent border-b border-zinc-200 dark:border-zinc-700 focus:outline-none text-zinc-600 dark:text-zinc-400 placeholder-zinc-300 dark:placeholder-zinc-600" />
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingTaskFor(obj.milestone_id)}
                    className="w-full text-left px-9 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-600 hover:text-blue-600 dark:hover:text-blue-400 border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20 transition-colors"
                  >
                    + Add task
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add objective */}
      {addingObj ? (
        <div className="flex items-center gap-2 px-3 py-2.5 border border-blue-300 dark:border-blue-700 rounded-lg bg-blue-50/40 dark:bg-blue-950/20">
          <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide shrink-0">Objective</span>
          <input
            autoFocus
            value={newObjTitle}
            onChange={e => setNewObjTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") createObjective(); if (e.key === "Escape") { setAddingObj(false); setNewObjTitle(""); } }}
            placeholder="Objective title…"
            className="flex-1 text-sm bg-transparent border-b border-blue-400 focus:outline-none text-zinc-900 dark:text-zinc-100 placeholder-zinc-400"
          />
          <button onClick={createObjective} className="text-xs text-blue-600 dark:text-blue-400 font-medium hover:underline shrink-0">Add</button>
          <button onClick={() => { setAddingObj(false); setNewObjTitle(""); }} className="text-xs text-zinc-400 hover:text-zinc-600 shrink-0">Cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setAddingObj(true)}
          className="w-full py-2 text-sm text-zinc-400 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 border border-dashed border-zinc-200 dark:border-zinc-700 rounded-lg hover:border-zinc-400 dark:hover:border-zinc-500 transition-colors"
        >
          + Add Objective
        </button>
      )}
    </div>
  );
}

// ── Gantt View ────────────────────────────────────────────────────────────────

function GanttView({ objectives, tasks }: { objectives: Objective[]; tasks: PlanTask[] }) {
  const allDates = [
    ...objectives.map(o => o.start_date).filter(Boolean),
    ...objectives.map(o => o.due_date).filter(Boolean),
    ...tasks.map(t => t.start_date).filter(Boolean),
    ...tasks.map(t => t.due_date).filter(Boolean),
  ] as string[];

  const today = new Date();
  const minDate = allDates.length ? new Date(Math.min(...allDates.map(d => new Date(d).getTime()))) : new Date(today.getFullYear(), today.getMonth(), 1);
  const maxDate = allDates.length ? new Date(Math.max(...allDates.map(d => new Date(d).getTime()))) : new Date(today.getFullYear(), today.getMonth() + 3, 0);

  // Expand range by a bit
  minDate.setDate(minDate.getDate() - 7);
  maxDate.setDate(maxDate.getDate() + 14);

  const totalDays = Math.max((maxDate.getTime() - minDate.getTime()) / 86_400_000, 14);

  function xPct(d: string | null) {
    if (!d) return null;
    return Math.max(0, Math.min(100, ((new Date(d).getTime() - minDate.getTime()) / 86_400_000 / totalDays) * 100));
  }

  const todayPct = Math.max(0, Math.min(100, ((today.getTime() - minDate.getTime()) / 86_400_000 / totalDays) * 100));

  // Generate month labels
  const months: { label: string; pct: number }[] = [];
  const cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  while (cursor <= maxDate) {
    const pct = ((cursor.getTime() - minDate.getTime()) / 86_400_000 / totalDays) * 100;
    months.push({ label: cursor.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), pct });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const tasksByObjective = tasks.reduce<Record<string, PlanTask[]>>((acc, t) => {
    const key = t.milestone_id ?? "__none__";
    (acc[key] = acc[key] ?? []).push(t);
    return acc;
  }, {});

  const LABEL_W = 200;

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 600 }}>
        {/* Month header */}
        <div className="flex items-center mb-1">
          <div style={{ width: LABEL_W }} className="shrink-0" />
          <div className="flex-1 relative h-5">
            {months.map(m => (
              <span key={m.label} className="absolute text-[10px] text-zinc-400 dark:text-zinc-500" style={{ left: `${m.pct}%` }}>{m.label}</span>
            ))}
          </div>
        </div>

        {/* Rows */}
        {objectives.map(obj => {
          const objTasks = tasksByObjective[obj.milestone_id] ?? [];
          const startPct = xPct(obj.start_date);
          const endPct = xPct(obj.due_date);

          return (
            <div key={obj.milestone_id}>
              {/* Objective row */}
              <div className="flex items-center mb-0.5 h-7 group">
                <div style={{ width: LABEL_W }} className="shrink-0 pr-3 flex items-center gap-1.5">
                  <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${OBJ_STATUS_COLORS[obj.status] ?? "bg-zinc-100 text-zinc-500"}`}>●</span>
                  <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100 truncate">{obj.title}</span>
                </div>
                <div className="flex-1 relative h-full bg-zinc-50 dark:bg-zinc-800/20 rounded">
                  {/* Today line */}
                  <div className="absolute top-0 bottom-0 w-px bg-red-400/60" style={{ left: `${todayPct}%` }} />
                  {/* Objective bar */}
                  {startPct !== null && endPct !== null && (
                    <div
                      className={`absolute top-1.5 bottom-1.5 rounded ${OBJ_STATUS_COLORS[obj.status]?.includes("blue") ? "bg-blue-300" : OBJ_STATUS_COLORS[obj.status]?.includes("green") ? "bg-green-300" : "bg-zinc-300 dark:bg-zinc-600"} opacity-60`}
                      style={{ left: `${startPct}%`, width: `${Math.max(endPct - startPct, 0.5)}%` }}
                    />
                  )}
                  {endPct !== null && startPct === null && (
                    <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rotate-45 bg-zinc-400" style={{ left: `${endPct}%`, marginLeft: -6 }} title={obj.title} />
                  )}
                </div>
              </div>

              {/* Task rows */}
              {objTasks.map(task => {
                const tt = task.task_type ? TASK_TYPE_MAP[task.task_type] : null;
                const tStartPct = xPct(task.start_date);
                const tEndPct = xPct(task.due_date);
                return (
                  <div key={task.task_id} className="flex items-center mb-0.5 h-6">
                    <div style={{ width: LABEL_W }} className="shrink-0 pl-6 pr-3 flex items-center gap-1.5">
                      {tt && <span className={`text-[9px] font-medium px-1 rounded ${tt.color}`}>{tt.label}</span>}
                      <span className={`text-[11px] truncate ${task.status === "done" ? "line-through text-zinc-400" : "text-zinc-600 dark:text-zinc-400"}`}>{task.title}</span>
                    </div>
                    <div className="flex-1 relative h-full">
                      <div className="absolute top-0 bottom-0 w-px bg-red-400/60" style={{ left: `${todayPct}%` }} />
                      {tStartPct !== null && tEndPct !== null && (
                        <div
                          className={`absolute top-1 bottom-1 rounded ${task.status === "done" ? "bg-green-400/50" : tt ? tt.dot.replace("bg-", "bg-") + "/40" : "bg-zinc-300 dark:bg-zinc-600"}`}
                          style={{ left: `${tStartPct}%`, width: `${Math.max(tEndPct - tStartPct, 0.5)}%` }}
                        />
                      )}
                      {tEndPct !== null && tStartPct === null && (
                        <div className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rotate-45 ${task.status === "done" ? "bg-green-400" : "bg-zinc-400"}`} style={{ left: `${tEndPct}%`, marginLeft: -4 }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Flow View ─────────────────────────────────────────────────────────────────
// Shows Project → Objectives as a left-to-right sequential pipeline.
// Tasks are visible in List/Gantt views; Flow shows the high-level stage progression.

const NODE_W = 180;
const NODE_H = 64;
const H_GAP = 60;   // horizontal gap between nodes
const PAD_X = 32;
const PAD_Y = 40;

function FlowView({
  projectName, objectives, tasks,
}: {
  projectName: string;
  objectives: Objective[];
  tasks: PlanTask[];
}) {
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const taskCountByObj = tasks.reduce<Record<string, { total: number; done: number }>>((acc, t) => {
    if (!t.milestone_id) return acc;
    const s = acc[t.milestone_id] ?? { total: 0, done: 0 };
    s.total++;
    if (t.status === "done") s.done++;
    acc[t.milestone_id] = s;
    return acc;
  }, {});

  // Lay out project node + objectives left-to-right on a single row
  const STATUS_COLOR: Record<string, string> = {
    complete:    "#22c55e",
    in_progress: "#3b82f6",
    blocked:     "#ef4444",
    pending:     "#a1a1aa",
    not_started: "#a1a1aa",
  };

  type NodePos = { id: string; x: number; label: string; color: string; taskTotal: number; taskDone: number; isProject?: boolean };

  const allNodes: NodePos[] = [
    { id: "__project__", x: PAD_X, label: projectName, color: "#6366f1", taskTotal: 0, taskDone: 0, isProject: true },
    ...objectives.map((obj, i) => ({
      id: obj.milestone_id,
      x: PAD_X + (NODE_W + H_GAP) * (i + 1),
      label: obj.title,
      color: STATUS_COLOR[obj.status] ?? "#a1a1aa",
      taskTotal: taskCountByObj[obj.milestone_id]?.total ?? 0,
      taskDone: taskCountByObj[obj.milestone_id]?.done ?? 0,
    })),
  ];

  const svgW = PAD_X + (NODE_W + H_GAP) * allNodes.length + PAD_X;
  const svgH = PAD_Y * 2 + NODE_H;
  const cy = PAD_Y + NODE_H / 2;

  function edgePath(x1: number, x2: number) {
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${cy} C ${mx} ${cy}, ${mx} ${cy}, ${x2} ${cy}`;
  }

  function onMouseDown(e: React.MouseEvent) { dragging.current = true; lastPos.current = { x: e.clientX, y: e.clientY }; }
  function onMouseMove(e: React.MouseEvent) { dragging.current = false; lastPos.current = { x: e.clientX, y: e.clientY }; }
  function onMouseUp() { dragging.current = false; }

  return (
    <div className="relative rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 overflow-x-auto" style={{ height: svgH }}>
      <svg
        width={svgW} height={svgH}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
        style={{ cursor: "grab", userSelect: "none", display: "block" }}
      >
        <g>
          {/* Connector lines between nodes */}
          {allNodes.slice(0, -1).map((node, i) => (
            <path
              key={`edge-${i}`}
              d={edgePath(node.x + NODE_W, allNodes[i + 1].x)}
              fill="none"
              stroke="#d4d4d8"
              strokeWidth={2}
              markerEnd="url(#arrow)"
            />
          ))}

          <defs>
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#d4d4d8" />
            </marker>
          </defs>

          {/* Nodes */}
          {allNodes.map(node => {
            const pct = node.taskTotal > 0 ? node.taskDone / node.taskTotal : 0;
            return (
              <g key={node.id}>
                {/* Shadow */}
                <rect x={node.x + 2} y={PAD_Y + 2} width={NODE_W} height={NODE_H} rx={10} fill="rgba(0,0,0,0.07)" />
                {/* Card */}
                <rect x={node.x} y={PAD_Y} width={NODE_W} height={NODE_H} rx={10} fill="white" stroke={node.color} strokeWidth={node.isProject ? 2.5 : 1.5} />
                {/* Color accent bar */}
                <rect x={node.x} y={PAD_Y} width={6} height={NODE_H} rx={4} fill={node.color} />
                {/* Label */}
                <text x={node.x + 14} y={PAD_Y + (node.taskTotal > 0 ? 20 : NODE_H / 2)} fontSize={11} fontWeight={600} fill="#27272a" dominantBaseline="middle">
                  {node.label.length > 20 ? node.label.slice(0, 19) + "…" : node.label}
                </text>
                {/* Task progress */}
                {node.taskTotal > 0 && (
                  <>
                    <text x={node.x + 14} y={PAD_Y + 38} fontSize={9} fill="#a1a1aa" dominantBaseline="middle">
                      {node.taskDone}/{node.taskTotal} tasks
                    </text>
                    {/* Progress bar */}
                    <rect x={node.x + 14} y={PAD_Y + 49} width={NODE_W - 28} height={4} rx={2} fill="#f4f4f5" />
                    <rect x={node.x + 14} y={PAD_Y + 49} width={(NODE_W - 28) * pct} height={4} rx={2} fill={node.color} />
                  </>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {objectives.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-zinc-400 dark:text-zinc-500">Add objectives to see the flow diagram</p>
        </div>
      )}
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function PlanSection({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<PlanView>("list");
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [users, setUsers] = useState<PlanUser[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [milRes, taskRes, userRes] = await Promise.all([
        fetch(`${API}/projects/${projectId}/milestones`),
        fetch(`${API}/tasks?project_id=${projectId}&all_users=true`),
        fetch(`${API}/tasks/users`),
      ]);
      if (milRes.ok) setObjectives(await milRes.json());
      if (taskRes.ok) setTasks(await taskRes.json());
      if (userRes.ok) setUsers(await userRes.json());
    } catch (e) {
      console.error("PlanSection load error:", e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          <svg className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${open ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          Plan
          {objectives.length > 0 && (
            <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded font-normal">
              {objectives.length} objective{objectives.length !== 1 ? "s" : ""}
            </span>
          )}
        </button>
        {open && (
          <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
            {(["list", "gantt", "flow"] as PlanView[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-xs rounded-md transition-colors capitalize ${view === v ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm font-medium" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
              >
                {v === "flow" ? "Flow" : v === "gantt" ? "Gantt" : "List"}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
        <div className="px-4 pb-4">
          {loading ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center py-6">Loading…</p>
          ) : view === "list" ? (
            <ListView projectId={projectId} objectives={objectives} tasks={tasks} users={users} onRefresh={load} />
          ) : view === "gantt" ? (
            <GanttView objectives={objectives} tasks={tasks} />
          ) : (
            <FlowView projectName={projectName} objectives={objectives} tasks={tasks} />
          )}
        </div>
      )}
    </div>
  );
}
