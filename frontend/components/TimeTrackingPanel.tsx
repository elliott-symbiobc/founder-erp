"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";

import { AutoTextarea } from "@/components/AutoTextarea";
// ─── Interfaces ───────────────────────────────────────────────────────────────

interface TimeEntry {
  entry_id: string;
  user_id: string;
  user_email: string;
  user_name: string | null;
  task_id: string | null;
  task_title: string | null;
  entry_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  description: string | null;
}

interface ActiveTimer {
  timer_id: string;
  user_id: string;
  task_id: string | null;
  task_title: string | null;
  description: string | null;
  started_at: string;
}

interface User {
  user_id: string;
  name: string | null;
  email: string;
}

interface TaskItem {
  task_id: string;
  title: string;
  status: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtHM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isoWeekStart(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(m.getDate() + diff);
  return m;
}

function weekDates(start: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// ─── StartTimerModal ──────────────────────────────────────────────────────────

function StartTimerModal({ tasks, onStart, onClose }: {
  tasks: TaskItem[];
  onStart: (taskId: string, taskTitle: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [taskId, setTaskId] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const selectedTask = tasks.find(t => t.task_id === taskId);
    try {
      await onStart(taskId, selectedTask?.title || "", desc.trim());
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Start Timer</h3>
          </div>
          <button onClick={onClose} className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Task (optional)</label>
            <select value={taskId} onChange={e => setTaskId(e.target.value)}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 appearance-none">
              <option value="">— No task —</option>
              {tasks.filter(t => t.status === "open").map(t => <option key={t.task_id} value={t.task_id}>{t.title}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes (optional)</label>
            <AutoTextarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="What are you working on?"
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
            <button type="submit" disabled={busy}
              className="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
              {busy ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── LogTimeModal ─────────────────────────────────────────────────────────────

function LogTimeModal({ users, tasks, onSave, onClose }: {
  users: User[];
  tasks: TaskItem[];
  onSave: (entry: Omit<TimeEntry, "entry_id" | "user_id" | "user_email" | "user_name">) => Promise<void>;
  onClose: () => void;
}) {
  const [taskId, setTaskId] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [durH, setDurH] = useState("0");
  const [durM, setDurM] = useState("30");
  const [busy, setBusy] = useState(false);

  const totalMin = Math.max(0, parseInt(durH || "0") * 60 + parseInt(durM || "0"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (totalMin <= 0) return;
    setBusy(true);
    const selectedTask = tasks.find(t => t.task_id === taskId);
    try {
      await onSave({
        task_id: taskId || null,
        task_title: selectedTask?.title || null,
        entry_date: date,
        start_time: startTime || null,
        end_time: endTime || null,
        duration_minutes: totalMin,
        description: desc.trim() || null,
      });
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Log Time</h3>
          <button onClick={onClose} className="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} required
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Start (optional)</label>
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">End (optional)</label>
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Duration</label>
            <div className="flex items-center gap-2">
              <input type="number" min="0" max="23" value={durH} onChange={e => setDurH(e.target.value)}
                className="w-16 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-center" />
              <span className="text-xs text-gray-500">h</span>
              <input type="number" min="0" max="59" value={durM} onChange={e => setDurM(e.target.value)}
                className="w-16 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-center" />
              <span className="text-xs text-gray-500">min</span>
              {totalMin > 0 && <span className="text-xs text-indigo-500 font-medium ml-1">{fmtHM(totalMin)}</span>}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Task (optional)</label>
            <select value={taskId} onChange={e => setTaskId(e.target.value)}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 appearance-none">
              <option value="">— No task —</option>
              {tasks.filter(t => t.status === "open").map(t => <option key={t.task_id} value={t.task_id}>{t.title}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes (optional)</label>
            <AutoTextarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="What were you working on?"
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-none" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
            <button type="submit" disabled={busy || totalMin <= 0}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-40">
              {busy ? "Saving…" : "Log Time"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── ActiveTimerBar ───────────────────────────────────────────────────────────

function ActiveTimerBar({ timer, onStop, onDiscard }: {
  timer: ActiveTimer;
  onStop: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const started = new Date(timer.started_at).getTime();
    function tick() {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timer.started_at]);

  async function handleStop() {
    setStopping(true);
    try { await onStop(); } finally { setStopping(false); }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl mb-4">
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-semibold text-red-600 dark:text-red-400 tabular-nums">
            {fmtElapsed(elapsed)}
          </span>
          {timer.task_title && (
            <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{timer.task_title}</span>
          )}
          {timer.description && !timer.task_title && (
            <span className="text-xs text-gray-500 dark:text-gray-500 truncate italic">{timer.description}</span>
          )}
        </div>
        {timer.task_title && timer.description && (
          <p className="text-[11px] text-gray-400 truncate mt-0.5">{timer.description}</p>
        )}
      </div>
      <button onClick={onDiscard} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0">
        Discard
      </button>
      <button onClick={handleStop} disabled={stopping}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 shrink-0">
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
        {stopping ? "Saving…" : "Stop"}
      </button>
    </div>
  );
}

// ─── TimeTrackingContent ──────────────────────────────────────────────────────

function TimeTrackingContent({ users, isAdmin, activeTimer, onTimerChange }: {
  users: User[];
  isAdmin: boolean;
  activeTimer: ActiveTimer | null;
  onTimerChange: (timer: ActiveTimer | null) => void;
}) {
  const [weekStart, setWeekStart] = useState<Date>(() => isoWeekStart(new Date()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  const dates = weekDates(weekStart);
  const weekStr = weekStart.toISOString().slice(0, 10);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ week: weekStr });
    fetch(`/api/proxy/time-entries?${params}`)
      .then(r => r.ok ? r.json() : [])
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [weekStr]);

  useEffect(() => {
    fetch("/api/proxy/tasks?status=open&limit=200")
      .then(r => r.ok ? r.json() : [])
      .then(d => setTasks(Array.isArray(d) ? d : (d.tasks ?? [])))
      .catch(() => {});
  }, []);

  async function logEntry(data: Omit<TimeEntry, "entry_id" | "user_id" | "user_email" | "user_name">) {
    const res = await fetch("/api/proxy/time-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const entry = await res.json();
      setEntries(prev => [...prev, entry]);
    }
  }

  async function startTimer(taskId: string, taskTitle: string, description: string) {
    const res = await fetch("/api/proxy/time-entries/timer/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskId || null, task_title: taskTitle || null, description: description || null }),
    });
    if (res.ok) {
      const timer = await res.json();
      onTimerChange(timer);
    }
  }

  async function stopTimer() {
    const res = await fetch("/api/proxy/time-entries/timer/stop", { method: "POST" });
    if (res.ok) {
      const entry = await res.json();
      setEntries(prev => [...prev, entry]);
      onTimerChange(null);
      // Jump to the week containing the new entry
      const entryWeek = isoWeekStart(new Date(entry.entry_date + "T12:00:00"));
      setWeekStart(entryWeek);
    }
  }

  async function discardTimer() {
    await fetch("/api/proxy/time-entries/timer", { method: "DELETE" });
    onTimerChange(null);
  }

  async function deleteEntry(id: string) {
    await fetch(`/api/proxy/time-entries/${id}`, { method: "DELETE" });
    setEntries(prev => prev.filter(e => e.entry_id !== id));
  }

  function prevWeek() { const d = new Date(weekStart); d.setDate(d.getDate() - 7); setWeekStart(d); }
  function nextWeek() { const d = new Date(weekStart); d.setDate(d.getDate() + 7); setWeekStart(d); }
  function goToday() { setWeekStart(isoWeekStart(new Date())); }

  const today = new Date().toISOString().slice(0, 10);

  const allUsers = isAdmin
    ? users.filter(u => (u as any).user_type === "employee" || !(u as any).user_type)
    : users.slice(0, 1);

  function userEntries(userId: string) {
    return entries.filter(e => e.user_id === userId);
  }

  function dateEntries(userId: string, date: string) {
    return entries.filter(e => e.user_id === userId && e.entry_date === date);
  }

  function dayTotal(userId: string, date: string) {
    return dateEntries(userId, date).reduce((s, e) => s + e.duration_minutes, 0);
  }

  function weekTotal(userId: string) {
    return userEntries(userId).reduce((s, e) => s + e.duration_minutes, 0);
  }

  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div className="space-y-4">
      {/* Active timer bar */}
      {activeTimer && (
        <ActiveTimerBar timer={activeTimer} onStop={stopTimer} onDiscard={discardTimer} />
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button onClick={prevWeek} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>
        <button onClick={goToday} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          Today
        </button>
        <button onClick={nextWeek} className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        </button>
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 ml-1">
          {new Date(dates[0] + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          {" – "}
          {new Date(dates[6] + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <div className="flex-1" />
        {!activeTimer && (
          <button onClick={() => setShowStart(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-medium rounded-lg transition-colors">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21" /></svg>
            Start Timer
          </button>
        )}
        <button onClick={() => setShowLog(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
          Log Time
        </button>
      </div>

      {/* Grid */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header row */}
        <div className="grid border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/60"
          style={{ gridTemplateColumns: "200px repeat(7, 1fr) 80px" }}>
          <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-gray-400">Employee</div>
          {dates.map((d, i) => (
            <div key={d} className={`px-2 py-2.5 text-center text-xs font-semibold ${d === today ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
              <div>{DAY_LABELS[i]}</div>
              <div className={`text-[10px] font-normal mt-0.5 ${d === today ? "text-blue-500" : "text-gray-400"}`}>
                {new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </div>
            </div>
          ))}
          <div className="px-2 py-2.5 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">Total</div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-gray-400">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : allUsers.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-gray-400">No employees found</div>
        ) : (
          allUsers.map(user => {
            const wTotal = weekTotal(user.user_id);
            const isExpanded = expandedUser === user.user_id;
            return (
              <div key={user.user_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                {/* Summary row */}
                <div className="grid hover:bg-gray-50/60 dark:hover:bg-gray-800/30 transition-colors cursor-pointer"
                  style={{ gridTemplateColumns: "200px repeat(7, 1fr) 80px" }}
                  onClick={() => setExpandedUser(isExpanded ? null : user.user_id)}>
                  <div className="px-4 py-2.5 flex items-center gap-2">
                    <Avatar name={user.name} size={6} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{user.name || user.email}</p>
                    </div>
                    <svg className={`w-3 h-3 text-gray-400 ml-auto shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                  {dates.map(d => {
                    const mins = dayTotal(user.user_id, d);
                    return (
                      <div key={d} className={`px-1 py-2.5 text-center ${d === today ? "bg-blue-50/40 dark:bg-blue-950/10" : ""}`}>
                        {mins > 0 ? (
                          <span className={`text-xs font-semibold ${mins >= 480 ? "text-green-600 dark:text-green-400" : mins >= 240 ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
                            {fmtHM(mins)}
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-200 dark:text-gray-700">—</span>
                        )}
                      </div>
                    );
                  })}
                  <div className="px-2 py-2.5 text-center">
                    {wTotal > 0 ? (
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{fmtHM(wTotal)}</span>
                    ) : (
                      <span className="text-[10px] text-gray-300 dark:text-gray-600">—</span>
                    )}
                  </div>
                </div>

                {/* Expanded entry list */}
                {isExpanded && (
                  <div className="bg-gray-50/60 dark:bg-gray-800/20 border-t border-gray-100 dark:border-gray-800">
                    {dates.map(d => {
                      const dayEnts = dateEntries(user.user_id, d);
                      if (dayEnts.length === 0) return null;
                      return (
                        <div key={d} className="border-b border-gray-100 dark:border-gray-800/60 last:border-0">
                          <div className="px-4 py-1.5 flex items-center gap-2">
                            <span className={`text-[10px] font-semibold uppercase tracking-wide ${d === today ? "text-blue-500" : "text-gray-400"}`}>
                              {new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                            </span>
                            <span className="text-[10px] text-gray-400 ml-1">{fmtHM(dayEnts.reduce((s, e) => s + e.duration_minutes, 0))}</span>
                          </div>
                          {dayEnts.map(entry => (
                            <div key={entry.entry_id} className="group flex items-start gap-3 px-6 py-1.5 hover:bg-white dark:hover:bg-gray-800/60">
                              <div className="shrink-0 mt-0.5">
                                <span className="text-[10px] font-semibold text-indigo-500 tabular-nums">{fmtHM(entry.duration_minutes)}</span>
                                {entry.start_time && <span className="text-[9px] text-gray-400 block">{entry.start_time}{entry.end_time ? `–${entry.end_time}` : ""}</span>}
                              </div>
                              <div className="flex-1 min-w-0">
                                {entry.task_title && <p className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{entry.task_title}</p>}
                                {entry.description && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{entry.description}</p>}
                                {!entry.task_title && !entry.description && <p className="text-[11px] text-gray-400 italic">No description</p>}
                              </div>
                              <button onClick={() => deleteEntry(entry.entry_id)}
                                className="opacity-0 group-hover:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-all p-0.5">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {userEntries(user.user_id).length === 0 && (
                      <p className="text-xs text-gray-400 px-4 py-3">No time logged this week</p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showStart && (
        <StartTimerModal
          tasks={tasks}
          onStart={startTimer}
          onClose={() => setShowStart(false)}
        />
      )}
      {showLog && (
        <LogTimeModal
          users={users}
          tasks={tasks}
          onSave={logEntry}
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  );
}

// ─── TimeTrackingPanel ────────────────────────────────────────────────────────

export default function TimeTrackingPanel() {
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [activeTimer, setActiveTimer] = useState<ActiveTimer | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/proxy/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.effective_permissions?.manage_users) setIsAdmin(true); })
      .catch(() => {});
    fetch("/api/proxy/tasks/users")
      .then(r => r.ok ? r.json() : [])
      .then(setUsers)
      .catch(() => {});
    fetch("/api/proxy/time-entries/timer")
      .then(r => r.ok ? r.json() : null)
      .then(d => setActiveTimer(d || null))
      .catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      {/* Clock icon button */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Time Tracking"
        className="relative p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {activeTimer && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-gray-950 animate-pulse" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-[760px] bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 dark:border-gray-800 shrink-0">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Time Tracking</span>
                {activeTimer && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">
              <TimeTrackingContent
                users={users}
                isAdmin={isAdmin}
                activeTimer={activeTimer}
                onTimerChange={setActiveTimer}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
