"use client";

import { Avatar } from "@/components/Avatar";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ─── Types ────────────────────────────────────────────────────────────────────

interface Task {
  task_id: string;
  user_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  start_date: string | null;
  estimated_minutes: number | null;
  status: "open" | "done";
  kanban_status: "todo" | "in_progress" | "review" | "done";
  sort_order: number | null;
  project_id: string | null;
  project_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  owner_name: string | null;
  priority: Priority | null;
  created_at: string;
}

interface User {
  user_id: string;
  name: string;
  email: string;
}

type Priority = "high" | "medium" | "low";
type ViewMode = "kanban" | "gantt";
type TaskScope = "mine" | "all";
type KanbanColId = "todo" | "in_progress" | "review" | "done";

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtMinutes(m: number | null): string | null {
  if (!m) return null;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function isOverdue(due: string | null, status: string): boolean {
  if (!due || status === "done") return false;
  return new Date(due) < new Date(new Date().toDateString());
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function inferPriority(task: Task): Priority {
  if (task.priority) return task.priority;
  if (isOverdue(task.due_date, task.status)) return "high";
  if (task.due_date && task.status !== "done") {
    const days = Math.ceil((new Date(task.due_date).getTime() - Date.now()) / 86400000);
    if (days <= 3) return "high";
    if (days <= 7) return "medium";
  }
  return "low";
}

// ─── Priority Badge ───────────────────────────────────────────────────────────

const PRIORITY_CYCLE: Priority[] = ["low", "medium", "high"];

function PriorityBadge({ priority, onClick }: { priority: Priority; onClick?: (e: React.MouseEvent) => void }) {
  const map = {
    high:   { label: "High", cls: "bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800" },
    medium: { label: "Med",  cls: "bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800" },
    low:    { label: "Low",  cls: "bg-green-50 text-green-600 border border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800" },
  };
  const { label, cls } = map[priority];
  if (onClick) {
    return (
      <button onClick={onClick} title="Click to change priority"
        className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md cursor-pointer hover:opacity-80 transition-opacity ${cls}`}>
        {label}
      </button>
    );
  }
  return <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${cls}`}>{label}</span>;
}

// ─── Edit Task Modal ──────────────────────────────────────────────────────────

function EditTaskModal({
  task, users, onSave, onDelete, onClose,
}: {
  task: Task;
  users: User[];
  onSave: (id: string, patch: Partial<Task>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle]           = useState(task.title);
  const [description, setDesc]      = useState(task.description ?? "");
  const [due, setDue]               = useState(task.due_date ?? "");
  const [start, setStart]           = useState(task.start_date ?? "");
  const [est, setEst]               = useState(task.estimated_minutes ? String(task.estimated_minutes) : "");
  const [assignedTo, setAssignedTo] = useState(task.assigned_to ?? "");
  const [kanbanStatus, setKSt]      = useState<KanbanColId>(task.kanban_status ?? "todo");
  const [busy, setBusy]             = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onSave(task.task_id, {
        title: title.trim(),
        description: description.trim() || null,
        due_date: due || null,
        start_date: start || null,
        estimated_minutes: est ? parseInt(est, 10) : null,
        assigned_to: assignedTo || null,
        kanban_status: kanbanStatus,
      });
      onClose();
    } finally { setBusy(false); }
  }

  async function handleDelete() {
    setBusy(true);
    try { await onDelete(task.task_id); onClose(); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Task</h3>
            {task.owner_name && (
              <p className="text-xs text-gray-400 mt-0.5">Owner: {task.owner_name}</p>
            )}
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Title <span className="text-red-500">*</span></label>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) save(); if (e.key === "Escape") onClose(); }}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Description</label>
            <AutoTextarea value={description} onChange={e => setDesc(e.target.value)} rows={3}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 resize-none transition-all" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Start Date</label>
              <input type="date" value={start} onChange={e => setStart(e.target.value)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Due Date</label>
              <input type="date" value={due} onChange={e => setDue(e.target.value)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Status</label>
              <select value={kanbanStatus} onChange={e => setKSt(e.target.value as KanbanColId)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all">
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="review">Review</option>
                <option value="done">Done</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Estimate (min)</label>
              <input type="number" value={est} onChange={e => setEst(e.target.value)} placeholder="e.g. 30" min={1}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 transition-all" />
            </div>
          </div>
          {users.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Assignee</label>
              <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all">
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>)}
              </select>
            </div>
          )}
          <div className="text-[11px] text-gray-400 dark:text-gray-600 border-t border-gray-100 dark:border-gray-800 pt-3">
            Created {new Date(task.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {task.project_name && ` · ${task.project_name}`}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-600 dark:text-red-400">Delete this task?</span>
              <button onClick={handleDelete} disabled={busy}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors">
                Yes, delete
              </button>
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              Delete
            </button>
          )}
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              Cancel
            </button>
            <button onClick={save} disabled={!title.trim() || busy}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2">
              {busy && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Gantt View ───────────────────────────────────────────────────────────────

const DAY_PX = 26;
const ROW_H = 38;
const LABEL_W = 240;

interface GanttDrag {
  taskId: string;
  type: "move" | "resize";
  startX: number;
  origStart: number;
  origDue: number;
  rangeStartMs: number;
}

function GanttView({
  tasks, onUpdate, onToggle, onDelete, showOwner,
}: {
  tasks: Task[];
  onUpdate: (id: string, patch: Partial<Task>) => Promise<void>;
  onToggle: (task: Task) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  showOwner?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<GanttDrag | null>(null);
  const [preview, setPreview] = useState<Record<string, { start: number; due: number }>>({});
  const previewRef = useRef<Record<string, { start: number; due: number }>>({});
  useEffect(() => { previewRef.current = preview; }, [preview]);

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  const { rangeStart, totalDays } = useMemo(() => {
    const ms: number[] = [today.getTime()];
    for (const t of tasks) {
      if (t.start_date) ms.push(new Date(t.start_date).getTime());
      if (t.due_date)   ms.push(new Date(t.due_date).getTime());
    }
    const minMs = Math.min(...ms) - 7 * 86400000;
    const maxMs = Math.max(...ms) + 21 * 86400000;
    const rs = new Date(minMs); rs.setHours(0, 0, 0, 0);
    return { rangeStart: rs, totalDays: Math.max(60, Math.ceil((maxMs - rs.getTime()) / 86400000)) };
  }, [tasks, today]);

  const todayDay = useMemo(() =>
    Math.floor((today.getTime() - rangeStart.getTime()) / 86400000),
    [today, rangeStart]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, (todayDay - 4) * DAY_PX);
  }, [todayDay]);

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round((e.clientX - d.startX) / DAY_PX);
      let ns = d.origStart, nd = d.origDue;
      if (d.type === "move") { ns += delta; nd += delta; }
      else { nd = Math.max(d.origStart + 1, d.origDue + delta); }
      setPreview(p => ({ ...p, [d.taskId]: { start: ns, due: nd } }));
    }
    function onUp() {
      const d = dragRef.current;
      if (!d) return;
      const p = previewRef.current[d.taskId];
      if (p && (p.start !== d.origStart || p.due !== d.origDue)) {
        const rs = new Date(d.rangeStartMs);
        onUpdateRef.current(d.taskId, {
          start_date: dateToIso(addDays(rs, p.start)),
          due_date:   dateToIso(addDays(rs, p.due)),
        });
      }
      dragRef.current = null;
      setPreview(p => { const n = { ...p }; if (d) delete n[d.taskId]; return n; });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  function getBarDays(task: Task): { start: number; due: number } | null {
    const p = preview[task.task_id];
    if (p) return p;
    let sd: number | null = null, dd: number | null = null;
    if (task.start_date) { const d = new Date(task.start_date); d.setHours(0,0,0,0); sd = Math.floor((d.getTime() - rangeStart.getTime()) / 86400000); }
    if (task.due_date)   { const d = new Date(task.due_date);   d.setHours(0,0,0,0); dd = Math.floor((d.getTime() - rangeStart.getTime()) / 86400000); }
    if (sd === null && dd === null) return null;
    if (sd === null) sd = dd!;
    if (dd === null) dd = sd + 1;
    if (dd <= sd) dd = sd + 1;
    return { start: sd, due: dd };
  }

  function startDrag(e: React.PointerEvent, taskId: string, type: "move" | "resize", sd: number, dd: number) {
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { taskId, type, startX: e.clientX, origStart: sd, origDue: dd, rangeStartMs: rangeStart.getTime() };
  }

  const monthHeaders = useMemo(() => {
    const result: { label: string; x: number; width: number }[] = [];
    let curr = new Date(rangeStart);
    const end = addDays(rangeStart, totalDays);
    while (curr < end) {
      const mStart = Math.floor((curr.getTime() - rangeStart.getTime()) / 86400000);
      const next = new Date(curr.getFullYear(), curr.getMonth() + 1, 1);
      const mEnd = next < end ? next : end;
      result.push({ label: curr.toLocaleDateString("en-US", { month: "short", year: "numeric" }), x: mStart * DAY_PX, width: Math.ceil((mEnd.getTime() - curr.getTime()) / 86400000) * DAY_PX });
      curr = next;
    }
    return result;
  }, [rangeStart, totalDays]);

  const datedTasks   = tasks.filter(t => getBarDays(t) !== null);
  const undatedTasks = tasks.filter(t => !t.start_date && !t.due_date);
  const timelineW    = totalDays * DAY_PX;
  const labelW       = showOwner ? LABEL_W + 60 : LABEL_W;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden select-none">
      <div ref={scrollRef} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)" }}>
        <div style={{ display: "inline-block", minWidth: "100%", width: labelW + timelineW }}>
          {/* Header */}
          <div className="flex sticky top-0 z-20 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <div className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-800/60 border-r border-gray-200 dark:border-gray-700 flex items-end pb-2 px-4"
                 style={{ width: labelW, minWidth: labelW, height: 52 }}>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Task</span>
            </div>
            <div style={{ position: "relative", width: timelineW, flexShrink: 0, height: 52 }}>
              {monthHeaders.map((m, i) => (
                <div key={i} style={{ position: "absolute", left: m.x, width: m.width, top: 0, height: 24 }}
                     className="border-r border-gray-200 dark:border-gray-700 px-2 flex items-center">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">{m.label}</span>
                </div>
              ))}
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 24, display: "flex" }}>
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = addDays(rangeStart, i);
                  const isToday = i === todayDay;
                  const isWknd = d.getDay() === 0 || d.getDay() === 6;
                  const show = totalDays < 90 ? true : (i % 7 === 0 || d.getDate() === 1);
                  return (
                    <div key={i} style={{ width: DAY_PX, flexShrink: 0 }}
                         className={`border-l border-gray-100 dark:border-gray-800 flex items-center justify-center ${isWknd ? "bg-gray-50/60 dark:bg-gray-800/30" : ""}`}>
                      {show && <span className={`text-[10px] ${isToday ? "text-blue-600 font-bold" : isWknd ? "text-gray-300 dark:text-gray-600" : "text-gray-400 dark:text-gray-600"}`}>{d.getDate()}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {datedTasks.map(task => {
            const days = getBarDays(task)!;
            const overdue = isOverdue(task.due_date, task.status);
            const isDone = task.status === "done";
            let barCls = "bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-600";
            let txtCls = "text-blue-800 dark:text-blue-200";
            if (isDone)        { barCls = "bg-green-100 dark:bg-green-900/40 border-green-300 dark:border-green-600"; txtCls = "text-green-800 dark:text-green-200"; }
            else if (overdue)  { barCls = "bg-red-100 dark:bg-red-900/40 border-red-300 dark:border-red-600";        txtCls = "text-red-800 dark:text-red-200"; }
            const barLeft = days.start * DAY_PX + 2;
            const barW    = Math.max(DAY_PX, (days.due - days.start) * DAY_PX - 4);
            return (
              <div key={task.task_id} className="flex border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50/30 dark:hover:bg-gray-800/20 group" style={{ height: ROW_H }}>
                <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3"
                     style={{ width: labelW, minWidth: labelW }}>
                  <button onClick={() => onToggle(task)}
                          className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-colors ${isDone ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-green-400"}`} />
                  <span className={`text-xs truncate flex-1 ${isDone ? "line-through text-gray-400" : "text-gray-800 dark:text-gray-100"}`}>{task.title}</span>
                  {showOwner && task.owner_name && (
                    <Avatar name={task.owner_name} title={task.owner_name} />
                  )}
                  <button onClick={() => onDelete(task.task_id)}
                          className="ml-1 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 flex-shrink-0">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
                <div style={{ position: "relative", width: timelineW, flexShrink: 0 }}>
                  <div style={{ position: "absolute", left: todayDay * DAY_PX, top: 0, bottom: 0, width: 1, pointerEvents: "none", zIndex: 1 }} className="bg-blue-400/50" />
                  {Array.from({ length: totalDays }, (_, i) => {
                    const d = addDays(rangeStart, i);
                    if (d.getDay() !== 0 && d.getDay() !== 6) return null;
                    return <div key={i} style={{ position: "absolute", left: i * DAY_PX, top: 0, bottom: 0, width: DAY_PX, pointerEvents: "none" }} className="bg-gray-50/50 dark:bg-gray-800/20" />;
                  })}
                  <div style={{ position: "absolute", left: barLeft, width: barW, top: 5, height: ROW_H - 10, borderRadius: 5, zIndex: 2, cursor: dragRef.current?.taskId === task.task_id ? "grabbing" : "grab" }}
                       className={`border flex items-center px-2 ${barCls}`}
                       onPointerDown={e => startDrag(e, task.task_id, "move", days.start, days.due)}>
                    <span className={`text-[11px] truncate flex-1 pointer-events-none ${txtCls}`}>{task.title}</span>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 3 }}
                         className="rounded-r"
                         onPointerDown={e => { e.stopPropagation(); startDrag(e, task.task_id, "resize", days.start, days.due); }} />
                  </div>
                </div>
              </div>
            );
          })}

          {undatedTasks.length > 0 && (
            <>
              <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/40" style={{ height: 28 }}>
                <div className="sticky left-0 z-10 bg-gray-50/80 dark:bg-gray-800/40 flex items-center px-4" style={{ width: labelW, minWidth: labelW }}>
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">No date</span>
                </div>
                <div style={{ width: timelineW }} />
              </div>
              {undatedTasks.map(task => (
                <div key={task.task_id} className="flex border-b border-gray-100 dark:border-gray-800" style={{ height: ROW_H }}>
                  <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3" style={{ width: labelW, minWidth: labelW }}>
                    <button onClick={() => onToggle(task)}
                            className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${task.status === "done" ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-green-400"}`} />
                    <span className={`text-xs truncate flex-1 ${task.status === "done" ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>{task.title}</span>
                    {showOwner && task.owner_name && (
                      <Avatar name={task.owner_name} title={task.owner_name} />
                    )}
                  </div>
                  <div style={{ width: timelineW }} className="flex items-center px-4">
                    <span className="text-xs text-gray-400 italic">Set a due date to appear on chart</span>
                  </div>
                </div>
              ))}
            </>
          )}

          {tasks.length === 0 && (
            <div className="flex" style={{ height: 80 }}>
              <div className="sticky left-0 flex items-center justify-center px-4 text-sm text-gray-400" style={{ width: labelW, minWidth: labelW }}>No tasks</div>
              <div style={{ width: timelineW }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Kanban View ──────────────────────────────────────────────────────────────

const KANBAN_COLS = [
  { id: "todo"        as KanbanColId, label: "To Do",      headerCls: "bg-gray-50 dark:bg-gray-800/60",        dot: "bg-gray-400"   },
  { id: "in_progress" as KanbanColId, label: "In Progress", headerCls: "bg-blue-50 dark:bg-blue-950/30",        dot: "bg-blue-500"   },
  { id: "review"      as KanbanColId, label: "Review",      headerCls: "bg-amber-50 dark:bg-amber-950/30",      dot: "bg-amber-500"  },
  { id: "done"        as KanbanColId, label: "Done",        headerCls: "bg-green-50 dark:bg-green-950/30",      dot: "bg-green-500"  },
];

function KanbanView({
  tasks, users, onUpdate, onDelete, onReorder, showOwner,
}: {
  tasks: Task[];
  users: User[];
  onUpdate: (id: string, patch: Partial<Task>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReorder: (ids: string[]) => Promise<void>;
  showOwner?: boolean;
}) {
  const dragId       = useRef<string | null>(null);
  const didDrag      = useRef(false);
  const [dragOverCol,  setDragOverCol]  = useState<KanbanColId | null>(null);
  const [dragOverCard, setDragOverCard] = useState<string | null>(null);
  const [draggingId,   setDraggingId]   = useState<string | null>(null);
  const [collapsed,    setCollapsed]    = useState<Set<KanbanColId>>(new Set());
  const [editTask,     setEditTask]     = useState<Task | null>(null);
  const [colSort, setColSort] = useState<Record<KanbanColId, "none" | "priority" | "due_date">>({
    todo: "none", in_progress: "none", review: "none", done: "none",
  });

  function sortColTasks(colTasks: Task[], sort: "none" | "priority" | "due_date"): Task[] {
    if (sort === "none") return colTasks;
    if (sort === "priority") {
      const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
      return [...colTasks].sort((a, b) => order[inferPriority(a)] - order[inferPriority(b)]);
    }
    return [...colTasks].sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
  }

  const byCol: Record<KanbanColId, Task[]> = { todo: [], in_progress: [], review: [], done: [] };
  for (const t of tasks) {
    const k = (t.kanban_status as KanbanColId) || "todo";
    if (byCol[k]) byCol[k].push(t);
  }

  async function handleColDrop(col: KanbanColId) {
    if (dragId.current) {
      await onUpdate(dragId.current, { kanban_status: col });
      dragId.current = null;
    }
    setDragOverCol(null); setDragOverCard(null); setDraggingId(null); didDrag.current = false;
  }

  function handleCardDrop(e: React.DragEvent, targetTaskId: string, targetColId: KanbanColId) {
    const fromId = dragId.current;
    if (!fromId || fromId === targetTaskId) return;
    const fromTask = tasks.find(t => t.task_id === fromId);
    const fromCol = (fromTask?.kanban_status as KanbanColId) || "todo";
    if (fromCol === targetColId) {
      e.stopPropagation();
      const fromIdx = tasks.findIndex(t => t.task_id === fromId);
      const toIdx   = tasks.findIndex(t => t.task_id === targetTaskId);
      if (fromIdx === -1 || toIdx === -1) return;
      const newOrder = [...tasks];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, moved);
      dragId.current = null; setDragOverCol(null); setDragOverCard(null); setDraggingId(null);
      setTimeout(() => { didDrag.current = false; }, 0);
      onReorder(newOrder.map(t => t.task_id));
    }
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4" style={{ minHeight: "calc(100vh - 340px)" }}>
      {KANBAN_COLS.map(col => {
        const colTasks   = sortColTasks(byCol[col.id], colSort[col.id]);
        const isCollapsed = collapsed.has(col.id);
        const isColOver   = dragOverCol === col.id;

        if (isCollapsed) {
          return (
            <div key={col.id}
              className="flex-shrink-0 w-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 flex flex-col items-center py-3 gap-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors"
              onClick={() => setCollapsed(prev => { const n = new Set(prev); n.delete(col.id); return n; })}
              title={`Expand ${col.label}`}>
              <div className={`w-2 h-2 rounded-full ${col.dot}`} />
              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 [writing-mode:vertical-rl] rotate-180 tracking-wide">{col.label}</span>
              <span className="text-[10px] font-bold text-gray-400 bg-gray-200 dark:bg-gray-700 rounded-full w-5 h-5 flex items-center justify-center">{colTasks.length}</span>
            </div>
          );
        }

        return (
          <div key={col.id}
            className={`flex-shrink-0 flex flex-col rounded-xl border transition-all duration-150 ${isColOver ? "border-blue-400 dark:border-blue-500 shadow-md shadow-blue-500/10" : "border-gray-200 dark:border-gray-700"}`}
            style={{ width: 290 }}
            onDragOver={e => { e.preventDefault(); setDragOverCol(col.id); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setDragOverCol(null); setDragOverCard(null); } }}
            onDrop={() => handleColDrop(col.id)}>

            {/* Column header */}
            <div className={`px-3 py-2.5 rounded-t-xl border-b border-gray-200 dark:border-gray-700 flex items-center justify-between ${col.headerCls}`}>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${col.dot}`} />
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{col.label}</span>
                <span className="text-[10px] font-bold text-gray-500 bg-gray-200 dark:bg-gray-600 rounded px-1.5 py-0.5 min-w-[18px] text-center">{colTasks.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setColSort(prev => { const order = ["none", "priority", "due_date"] as const; return { ...prev, [col.id]: order[(order.indexOf(prev[col.id]) + 1) % order.length] }; })}
                  className={`h-6 flex items-center gap-0.5 px-1.5 text-[9px] font-semibold rounded transition-colors ${colSort[col.id] !== "none" ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-700/60"}`}>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M6 12h12M9 17h6" /></svg>
                  {colSort[col.id] !== "none" && <span>{colSort[col.id] === "priority" ? "P" : "D"}</span>}
                </button>
                <button onClick={() => setCollapsed(prev => { const n = new Set(prev); n.add(col.id); return n; })}
                  className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-700/60 rounded transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            </div>

            {/* Cards */}
            <div className="flex-1 p-2 space-y-2 overflow-y-auto" style={{ maxHeight: "calc(100vh - 400px)" }}>
              {colTasks.map(task => {
                const overdue      = isOverdue(task.due_date, task.status);
                const priority     = inferPriority(task);
                const isDone       = task.status === "done";
                const isBeingDragged = draggingId === task.task_id;
                const isCardOver   = dragOverCard === task.task_id;
                return (
                  <div key={task.task_id}
                    draggable
                    onDragStart={() => { dragId.current = task.task_id; didDrag.current = true; setDraggingId(task.task_id); }}
                    onDragEnd={() => { dragId.current = null; setDraggingId(null); setDragOverCol(null); setDragOverCard(null); setTimeout(() => { didDrag.current = false; }, 0); }}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverCard(task.task_id); }}
                    onDrop={e => handleCardDrop(e, task.task_id, col.id)}
                    onClick={() => { if (!didDrag.current) setEditTask(task); }}
                    className={`relative bg-white dark:bg-gray-800 rounded-xl border cursor-pointer group transition-all duration-150 overflow-hidden ${
                      isBeingDragged ? "opacity-40 scale-95 shadow-none" :
                      isCardOver     ? "border-blue-400 dark:border-blue-500 shadow-sm shadow-blue-500/20 -translate-y-0.5" :
                      "border-gray-200 dark:border-gray-700 hover:shadow-md hover:shadow-gray-200/60 dark:hover:shadow-black/20 hover:-translate-y-0.5 hover:border-gray-300 dark:hover:border-gray-600"
                    }`}>
                    <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${priority === "high" ? "bg-red-400" : priority === "medium" ? "bg-amber-400" : "bg-gray-200 dark:bg-gray-700"}`} />
                    <div className="pl-4 pr-3 pt-3 pb-3">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <p className={`text-sm font-semibold leading-snug flex-1 min-w-0 ${isDone ? "line-through text-gray-400 dark:text-gray-500" : "text-gray-900 dark:text-gray-50"}`}>
                          {task.title}
                        </p>
                        <button onClick={e => { e.stopPropagation(); onDelete(task.task_id); }}
                          className="opacity-0 group-hover:opacity-100 w-5 h-5 flex-shrink-0 flex items-center justify-center text-gray-300 hover:text-red-400 rounded transition-all">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                      {task.description && !isDone && (
                        <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed mb-2.5 line-clamp-2">{task.description}</p>
                      )}
                      <div className="flex items-center gap-1 flex-wrap mt-1.5">
                        <PriorityBadge priority={priority} onClick={e => { e.stopPropagation(); const next = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(priority) + 1) % PRIORITY_CYCLE.length]; onUpdate(task.task_id, { priority: next }); }} />
                        {task.due_date && (
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-medium ${overdue ? "bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"}`}>
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" /></svg>
                            {fmtDate(task.due_date)}{overdue && <span className="font-semibold"> · late</span>}
                          </span>
                        )}
                        {task.project_name && (
                          <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-900 font-medium max-w-[90px] truncate">{task.project_name}</span>
                        )}
                        {task.estimated_minutes && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            {fmtMinutes(task.estimated_minutes)}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1">
                          {showOwner && task.owner_name && (
                            <Avatar name={task.owner_name} title={`Owner: ${task.owner_name}`} />
                          )}
                          {task.assigned_to_name && (
                            <Avatar name={task.assigned_to_name} title={`Assigned: ${task.assigned_to_name}`} />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {colTasks.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
                  <p className="text-xs text-gray-300 dark:text-gray-600">No tasks</p>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {editTask && (
        <EditTaskModal
          task={editTask}
          users={users}
          onSave={async (id, patch) => { await onUpdate(id, patch); setEditTask(prev => prev && prev.task_id === id ? { ...prev, ...patch } : prev); }}
          onDelete={onDelete}
          onClose={() => setEditTask(null)}
        />
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminTasksPage() {
  const [tasks,    setTasks]    = useState<Task[]>([]);
  const [users,    setUsers]    = useState<User[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [scope,    setScope]    = useState<TaskScope>("mine");
  const [view,     setView]     = useState<ViewMode>("kanban");
  const [search,   setSearch]   = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterPriority, setFilterPriority] = useState<Priority | "">("");
  const [filterStatus,   setFilterStatus]   = useState<"open" | "done" | "all">("open");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (scope === "all") params.set("all_users", "true");
      if (filterStatus !== "all") params.set("status", filterStatus);
      const res = await fetch(`/api/proxy/tasks?${params}`);
      if (res.ok) setTasks(await res.json());
    } finally { setLoading(false); }
  }, [scope, filterStatus]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/proxy/tasks/users").then(r => r.ok ? r.json() : []).then(setUsers);
  }, []);

  const onUpdate = useCallback(async (id: string, patch: Partial<Task>) => {
    const res = await fetch(`/api/proxy/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const updated = await res.json();
      setTasks(ts => ts.map(t => t.task_id === id ? { ...t, ...updated } : t));
    }
  }, []);

  const onToggle = useCallback(async (task: Task) => {
    await onUpdate(task.task_id, { status: task.status === "done" ? "open" : "done" });
  }, [onUpdate]);

  const onDelete = useCallback(async (id: string) => {
    await fetch(`/api/proxy/tasks/${id}`, { method: "DELETE" });
    setTasks(ts => ts.filter(t => t.task_id !== id));
  }, []);

  const onReorder = useCallback(async (orderedIds: string[]) => {
    setTasks(prev => {
      const map = new Map(prev.map(t => [t.task_id, t]));
      return orderedIds.map((id, i) => ({ ...map.get(id)!, sort_order: (i + 1) * 10 })).filter(Boolean);
    });
    await fetch("/api/proxy/tasks/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: orderedIds }),
    });
  }, []);

  const shown = useMemo(() => {
    let list = tasks;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.contact_name?.toLowerCase().includes(q) ||
        t.project_name?.toLowerCase().includes(q) ||
        t.owner_name?.toLowerCase().includes(q)
      );
    }
    if (filterAssignee) list = list.filter(t => t.assigned_to === filterAssignee);
    if (filterPriority)  list = list.filter(t => inferPriority(t) === filterPriority);
    return list;
  }, [tasks, search, filterAssignee, filterPriority]);

  const openCount    = tasks.filter(t => t.status === "open").length;
  const overdueCount = tasks.filter(t => isOverdue(t.due_date, t.status)).length;
  const doneCount    = tasks.filter(t => t.status === "done").length;
  const hasFilters   = !!(search || filterAssignee || filterPriority);

  return (
    <div className="space-y-4 max-w-full">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          {/* My / All tabs */}
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 w-fit">
            {(["mine", "all"] as TaskScope[]).map(s => (
              <button key={s} onClick={() => setScope(s)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${scope === s ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}>
                {s === "mine" ? "My Tasks" : "All Tasks"}
              </button>
            ))}
          </div>
          {/* Stats */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />{openCount} open
            </span>
            {overdueCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 font-medium border border-red-200 dark:border-red-800">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />{overdueCount} overdue
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400 font-medium border border-green-200 dark:border-green-800">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />{doneCount} done
            </span>
          </div>
        </div>

        {/* View + status controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {(["open", "done", "all"] as const).map(f => (
              <button key={f} onClick={() => setFilterStatus(f)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${filterStatus === f ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}>
                {f}
              </button>
            ))}
          </div>
          <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {(["kanban", "gantt"] as ViewMode[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${view === v ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}>
                {v === "kanban" ? "Kanban" : "Gantt"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0015.803 15.803z" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 transition-all" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as Priority | "")}
          className={`text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all ${filterPriority ? "bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300" : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"}`}>
          <option value="">All priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        {users.length > 0 && (
          <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
            className={`text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all ${filterAssignee ? "bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300" : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"}`}>
            <option value="">All assignees</option>
            {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>)}
          </select>
        )}
        {hasFilters && (
          <button onClick={() => { setSearch(""); setFilterAssignee(""); setFilterPriority(""); }}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1 px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            Clear
          </button>
        )}
        {hasFilters && <span className="text-xs text-gray-400">{shown.length} of {tasks.length} tasks</span>}
      </div>

      {/* ── Legend for All Tasks ── */}
      {scope === "all" && (
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center gap-1.5">
            {/* Same component as the badges it explains, so the swatch can't drift. */}
            <Avatar name="Owner" size={4} />
            <span>Owner</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Avatar name="Assignee" size={4} />
            <span>Assignee</span>
          </div>
        </div>
      )}

      {/* ── View ── */}
      {loading ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading tasks…</p>
        </div>
      ) : view === "kanban" ? (
        <KanbanView
          tasks={shown}
          users={users}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onReorder={onReorder}
          showOwner={scope === "all"}
        />
      ) : (
        <GanttView
          tasks={shown}
          onUpdate={onUpdate}
          onToggle={onToggle}
          onDelete={onDelete}
          showOwner={scope === "all"}
        />
      )}
    </div>
  );
}
