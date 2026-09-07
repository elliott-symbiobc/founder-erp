"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";

interface Task {
  task_id: string;
  title: string;
  due_date: string | null;
  status: string;
  assigned_to: string | null;
  priority: string | null;
  project_name: string | null;
  activity_type?: string | null;
}

interface User {
  user_id: string;
  name: string | null;
  email: string;
  user_type?: string;
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isOverdue(due: string | null, status: string): boolean {
  if (!due || status === "done") return false;
  return new Date(due) < new Date(new Date().toDateString());
}

export default function TeamPanel() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([
      fetch("/api/proxy/tasks?status=open&all_users=true&limit=500").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/tasks/users").then(r => r.ok ? r.json() : []),
    ]).then(([taskData, userData]) => {
      setTasks(Array.isArray(taskData) ? taskData : []);
      setUsers(Array.isArray(userData) ? userData : []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const employees = users.filter(u => u.user_type === "employee" || !u.user_type);
  const openTasks = tasks.filter(t => t.status === "open");
  const byUser = employees.map(u => ({
    user: u,
    tasks: openTasks.filter(t => t.assigned_to === u.user_id),
  }));
  const unassigned = openTasks.filter(t => !t.assigned_to);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Team"
        title="Team"
        className={`flex items-center justify-center p-2 rounded-md transition-colors ${open ? "bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400" : "text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"}`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Team</h2>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="overflow-y-auto max-h-[70vh]">
            {loading ? (
              <div className="flex items-center justify-center py-10 gap-2 text-gray-400">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                <span className="text-sm">Loading…</span>
              </div>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {byUser.map(({ user, tasks: userTasks }) => (
                  <div key={user.user_id}>
                    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50/60 dark:bg-gray-800/40">
                      <Avatar name={user.name} size={7} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{user.name || user.email}</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${userTasks.length > 0 ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400" : "bg-gray-100 dark:bg-gray-800 text-gray-400"}`}>
                        {userTasks.length}
                      </span>
                    </div>
                    {userTasks.length === 0 ? (
                      <p className="text-[11px] text-gray-400 px-4 py-2">No open tasks</p>
                    ) : (
                      <div className="divide-y divide-gray-50 dark:divide-gray-800/60">
                        {userTasks.map(t => {
                          const overdue = isOverdue(t.due_date, t.status);
                          return (
                            <div key={t.task_id} className="flex items-start gap-2 px-4 py-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-800 dark:text-gray-200 truncate">{t.title}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  {t.due_date && (
                                    <span className={`text-[10px] ${overdue ? "text-red-500 font-medium" : "text-gray-400"}`}>
                                      {overdue ? "Overdue · " : ""}{fmtDate(t.due_date)}
                                    </span>
                                  )}
                                  {t.project_name && (
                                    <span className="text-[10px] px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400">{t.project_name}</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {unassigned.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50/60 dark:bg-gray-800/40">
                      <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[10px] font-bold text-gray-500 shrink-0">?</div>
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 flex-1">Unassigned</span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">{unassigned.length}</span>
                    </div>
                    <div className="divide-y divide-gray-50 dark:divide-gray-800/60">
                      {unassigned.map(t => (
                        <div key={t.task_id} className="flex items-start gap-2 px-4 py-2">
                          <p className="text-xs text-gray-800 dark:text-gray-200 truncate flex-1">{t.title}</p>
                          {t.due_date && <p className={`text-[10px] shrink-0 ${isOverdue(t.due_date, t.status) ? "text-red-500" : "text-gray-400"}`}>{fmtDate(t.due_date)}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
