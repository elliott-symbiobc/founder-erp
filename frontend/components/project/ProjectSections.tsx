"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
  task_id: string; title: string; status: string; kanban_status: string;
  due_date: string | null; priority: string | null; activity_type: string | null;
  milestone_id: string | null; milestone_title: string | null;
  assigned_to: string | null; assigned_to_name: string | null;
  blocked_by_count: number; locked: boolean;
  follow_up_of: string | null; trigger_days: number | null; condition: string | null;
  description: string | null;
}

interface Resource {
  id: string; resource_type: string; label: string; quantity: number | null;
  unit: string | null; start_date: string | null; end_date: string | null;
  cost_estimate: number | null; assigned_user_name: string | null;
  milestone_title: string | null; notes: string | null;
}

// ── Shared constants & helpers ────────────────────────────────────────────────

const SEL_XS = "text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-5 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.25rem_center] bg-[length:0.8rem]";

const ACTIVITY_ICON: Record<string, string> = { email: "✉", call: "☎", meeting: "◎", document: "▣", todo: "○", in_silico: "⬡", wet_lab: "⚗" };

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function fmtCurrency(v: number | null) {
  if (!v) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
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

// ── Active Tasks ──────────────────────────────────────────────────────────────

export function ActiveTasksSection({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [addingTitle, setAddingTitle] = useState("");
  const [addingDue, setAddingDue] = useState("");
  const [addingDesc, setAddingDesc] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingDescId, setEditingDescId] = useState<string | null>(null);
  const [descDraft, setDescDraft] = useState("");
  const [milestones, setMilestones] = useState<Array<{ milestone_id: string; title: string }>>([]);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/tasks?project_id=${projectId}&all_users=true`);
    if (r.ok) setTasks(await r.json());
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch(`/api/proxy/projects/${projectId}/milestones`).then(r => r.ok ? r.json() : []).then(setMilestones);
  }, [projectId]);

  const activeTasks = tasks.filter(t => t.status === "open" && !t.locked);
  const blocked = tasks.filter(t => t.blocked_by_count > 0 && t.status === "open" && !t.locked);
  const [followUpTarget, setFollowUpTarget] = useState<string | null>(null); // task_id we're adding follow-up to
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDays, setFollowUpDays] = useState("7");

  async function addTask() {
    if (!addingTitle.trim()) return;
    await fetch("/api/proxy/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: addingTitle.trim(), project_id: projectId, due_date: addingDue || null, description: addingDesc || null }),
    });
    setAddingTitle(""); setAddingDue(""); setAddingDesc(""); setAdding(false); load();
  }

  async function saveDesc(taskId: string, desc: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc || null }),
    });
    setEditingDescId(null);
    load();
  }

  async function addFollowUp(parentTaskId: string) {
    if (!followUpTitle.trim()) return;
    await fetch("/api/proxy/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: followUpTitle.trim(),
        project_id: projectId,
        follow_up_of: parentTaskId,
        trigger_days: parseInt(followUpDays) || 7,
        condition: "no_response",
      }),
    });
    setFollowUpTarget(null); setFollowUpTitle(""); setFollowUpDays("7"); load();
  }

  async function toggle(t: Task) {
    await fetch(`/api/proxy/tasks/${t.task_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: t.status === "done" ? "open" : "done" }),
    });
    load();
  }

  async function assignToMilestone(taskId: string, milestoneId: string) {
    await fetch(`/api/proxy/tasks/${taskId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestone_id: milestoneId }),
    });
    load();
  }

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader title="Active Tasks" count={activeTasks.length} action={
        <div className="flex items-center gap-2">
          {blocked.length > 0 && <span className="text-xs text-red-500 font-medium">⚠ {blocked.length} blocked</span>}
          <button onClick={() => setAdding(true)} className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">+ Add</button>
        </div>
      } />

      {blocked.length > 0 && (
        <div className="mb-3 p-2 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30">
          <div className="text-[11px] font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide mb-1.5">Blocked</div>
          {blocked.map(t => (
            <div key={t.task_id} className="flex items-center gap-2 text-xs py-1">
              <span className="text-red-400">⚠</span>
              <span className="flex-1 text-zinc-700 dark:text-zinc-300">{t.title}</span>
              {t.assigned_to_name && <span className="text-zinc-400">{t.assigned_to_name}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1">
        {activeTasks.map(t => {
          const isFollowUp = !!t.follow_up_of;
          const hasFollowUp = activeTasks.some(x => x.follow_up_of === t.task_id);
          return (
            <div key={t.task_id}>
              <div className={`rounded px-1 py-1 ${isFollowUp ? "ml-4 border-l-2 border-amber-200 dark:border-amber-800/40 pl-2" : ""}`}>
                <div className="flex items-center gap-2 text-xs flex-nowrap min-w-0">
                  <button onClick={() => toggle(t)} className="w-3.5 h-3.5 rounded border border-zinc-300 dark:border-zinc-600 hover:border-green-400 flex-shrink-0" />
                  {isFollowUp && <span className="text-amber-400 flex-shrink-0 text-[10px]">↩</span>}
                  {t.activity_type && !isFollowUp && <span className="text-zinc-300 dark:text-zinc-600 flex-shrink-0">{ACTIVITY_ICON[t.activity_type] ?? ""}</span>}
                  <span className="flex-1 truncate min-w-0 text-zinc-700 dark:text-zinc-300">{t.title}</span>
                  {isFollowUp && (
                    <span className="text-[10px] text-amber-500 dark:text-amber-400 flex-shrink-0 font-medium">
                      if no reply · {t.trigger_days ?? 7}d
                    </span>
                  )}
                  {t.due_date && <span className={`text-[10px] flex-shrink-0 ${(daysUntil(t.due_date) ?? 1) < 0 ? "text-red-400" : "text-zinc-400"}`}>{fmtDate(t.due_date)}</span>}
                  {t.assigned_to_name && <span className="text-[10px] flex-shrink-0 text-zinc-400 max-w-[80px] truncate">{t.assigned_to_name.split(" ")[0]}</span>}
                </div>
                {/* Description */}
                {editingDescId === t.task_id ? (
                  <AutoTextarea autoFocus value={descDraft} onChange={e => setDescDraft(e.target.value)}
                    onBlur={() => saveDesc(t.task_id, descDraft)}
                    onKeyDown={e => { if (e.key === "Escape") { setEditingDescId(null); } if (e.key === "Enter" && e.metaKey) saveDesc(t.task_id, descDraft); }}
                    rows={2} placeholder="Add description…"
                    className="ml-5 mt-1 w-full text-xs px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30 resize-none" />
                ) : t.description ? (
                  <p onClick={() => { setEditingDescId(t.task_id); setDescDraft(t.description ?? ""); }}
                    className="ml-5 mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed cursor-text hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors whitespace-pre-wrap">
                    {t.description}
                  </p>
                ) : (
                  <button onClick={() => { setEditingDescId(t.task_id); setDescDraft(""); }}
                    className="ml-5 mt-0.5 text-[10px] text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 transition-colors">
                    + description
                  </button>
                )}
                {!hasFollowUp && !isFollowUp && followUpTarget !== t.task_id && (
                  <button
                    onClick={() => { setFollowUpTarget(t.task_id); setFollowUpTitle(""); setFollowUpDays("7"); }}
                    className="ml-5 mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                  >+ if no reply…</button>
                )}
                {(t.milestone_title || milestones.length > 0) && (
                  <div className="flex items-center gap-1.5 mt-0.5 pl-5">
                    {t.milestone_title && <span className="text-[10px] text-zinc-400 truncate">{t.milestone_title}</span>}
                    {milestones.length > 0 && (
                      <select onChange={e => { if (e.target.value) assignToMilestone(t.task_id, e.target.value); }} defaultValue=""
                        className={`hidden group-hover:inline-block ${SEL_XS} py-0 text-[10px]`} onClick={e => e.stopPropagation()}>
                        <option value="">Move…</option>
                        {milestones.map(m => <option key={m.milestone_id} value={m.milestone_id}>{m.title}</option>)}
                      </select>
                    )}
                  </div>
                )}
              </div>
              {/* Inline follow-up form */}
              {followUpTarget === t.task_id && (
                <div className="ml-4 mt-1 mb-1 pl-2 border-l-2 border-amber-300 dark:border-amber-700">
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium mb-1">If no reply after this task is done:</p>
                  <div className="flex gap-1.5 items-center">
                    <input autoFocus value={followUpTitle} onChange={e => setFollowUpTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") addFollowUp(t.task_id); if (e.key === "Escape") setFollowUpTarget(null); }}
                      placeholder="Follow-up task title…"
                      className="flex-1 px-2 py-1 text-xs border border-amber-200 dark:border-amber-800 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-400/50" />
                    <span className="text-[10px] text-zinc-400 flex-shrink-0">after</span>
                    <input type="number" min={1} max={90} value={followUpDays} onChange={e => setFollowUpDays(e.target.value)}
                      className="w-10 px-1 py-1 text-xs border border-amber-200 dark:border-amber-800 rounded bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-center focus:outline-none focus:ring-1 focus:ring-amber-400/50" />
                    <span className="text-[10px] text-zinc-400 flex-shrink-0">days</span>
                    <button onClick={() => addFollowUp(t.task_id)} className="text-xs px-2 py-1 bg-amber-500 text-white rounded hover:bg-amber-600 flex-shrink-0">Add</button>
                    <button onClick={() => setFollowUpTarget(null)} className="text-xs text-zinc-400 hover:text-zinc-600 flex-shrink-0">✕</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {activeTasks.length === 0 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No active tasks — activate an objective in the Plan to get started.</p>
        )}
      </div>

      {adding && (
        <div className="flex flex-col gap-1.5 mt-2">
          <div className="flex gap-1.5">
            <input autoFocus value={addingTitle} onChange={e => setAddingTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addTask(); if (e.key === "Escape") { setAdding(false); setAddingTitle(""); setAddingDue(""); }}}
              placeholder="Task title…"
              className="flex-1 px-3 py-1.5 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <input type="date" value={addingDue} onChange={e => setAddingDue(e.target.value)}
              className="px-2 py-1.5 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button onClick={addTask} className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
            <button onClick={() => { setAdding(false); setAddingTitle(""); setAddingDue(""); }} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Resources ─────────────────────────────────────────────────────────────────

export function ResourcesSection({ projectId }: { projectId: string }) {
  const [resources, setResources] = useState<Resource[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ resource_type: "labor", label: "", cost_estimate: "", unit: "", notes: "" });

  const load = useCallback(async () => {
    const r = await fetch(`/api/projects/${projectId}/resources`);
    if (r.ok) setResources(await r.json());
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function addResource() {
    if (!form.label.trim()) return;
    await fetch(`/api/projects/${projectId}/resources`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, cost_estimate: form.cost_estimate ? parseFloat(form.cost_estimate) : null }),
    });
    setForm({ resource_type: "labor", label: "", cost_estimate: "", unit: "", notes: "" });
    setAdding(false); load();
  }

  async function deleteResource(id: string) {
    await fetch(`/api/projects/${projectId}/resources/${id}`, { method: "DELETE" });
    load();
  }

  const grouped = resources.reduce<Record<string, Resource[]>>((acc, r) => {
    (acc[r.resource_type] = acc[r.resource_type] ?? []).push(r); return acc;
  }, {});
  const totalCost = resources.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader title="Resources" count={resources.length} action={
        <div className="flex items-center gap-2">
          {totalCost > 0 && <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">Est. {fmtCurrency(totalCost)}</span>}
          <button onClick={() => setAdding(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Add</button>
        </div>
      } />

      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} className="mb-3">
          <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1">
            {type.replace("_", " ")}
          </div>
          <div className="space-y-1">
            {items.map(r => (
              <div key={r.id} className="flex items-center gap-2 text-xs py-1 group">
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{r.label}</span>
                {r.quantity && <span className="text-zinc-400">{r.quantity} {r.unit}</span>}
                {r.cost_estimate && <span className="text-zinc-500 font-mono">{fmtCurrency(r.cost_estimate)}</span>}
                {r.assigned_user_name && <span className="text-zinc-400">{r.assigned_user_name}</span>}
                <button onClick={() => deleteResource(r.id)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600">✕</button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {resources.length === 0 && !adding && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No resources allocated. <button onClick={() => setAdding(true)} className="underline">Add one</button>.</p>
      )}

      {adding && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <select value={form.resource_type} onChange={e => setForm(f => ({ ...f, resource_type: e.target.value }))} className={SEL_XS}>
            {["labor","capital","equipment","lab_space","consumables","external"].map(t => <option key={t} value={t}>{t.replace("_"," ")}</option>)}
          </select>
          <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Label" className="text-xs border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <input value={form.cost_estimate} onChange={e => setForm(f => ({ ...f, cost_estimate: e.target.value }))} placeholder="Est. cost ($)" type="number" className="text-xs border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="Unit (hrs/wk, L, kg)" className="text-xs border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <div className="col-span-2 flex gap-2">
            <button onClick={addResource} className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700">Add Resource</button>
            <button onClick={() => setAdding(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Strategic Planning ────────────────────────────────────────────────────────

export function StrategicPlanningSection({ projectId, onUpdate }: { projectId: string; onUpdate?: () => void }) {
  const [linkedGoals, setLinkedGoals] = useState<Array<{ goal_id: string; title: string; category: string | null; status: string; target_date: string | null; contribution_notes: string | null }>>([]);
  const [linkedFpa, setLinkedFpa] = useState<Array<{ id: string; contract_label: string; contract_type: string | null }>>([]);
  const [allGoals, setAllGoals] = useState<Array<{ goal_id: string; title: string; category: string | null; status: string }>>([]);
  const [fpaContracts, setFpaContracts] = useState<Array<{ label: string; type: string; total_value?: number; monthly_amount?: number }>>([]);
  const [addingGoal, setAddingGoal] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/projects/${projectId}`);
    if (!r.ok) return;
    const data = await r.json();
    setLinkedGoals(data.strategic_goals ?? []);
    setLinkedFpa(data.fpa_links ?? []);
  }, [projectId]);

  useEffect(() => {
    load();
    fetch("/api/strategic-goals").then(r => r.ok ? r.json() : []).then(setAllGoals);
    fetch("/api/fpa/model").then(r => r.ok ? r.json() : null).then(data => {
      if (data?.contract_pipeline) setFpaContracts(data.contract_pipeline.map((c: Record<string, unknown>) => ({
        label: (c.name ?? c.label ?? "Unnamed") as string,
        type: (c.type ?? "") as string,
        total_value: c.total_value as number,
        monthly_amount: c.monthly_amount as number,
      })));
    });
  }, [load]);

  async function linkGoal() {
    if (!selectedGoalId) return;
    await fetch(`/api/projects/${projectId}/goals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal_id: selectedGoalId }),
    });
    setAddingGoal(false); setSelectedGoalId(""); load(); onUpdate?.();
  }

  async function unlinkGoal(goalId: string) {
    await fetch(`/api/projects/${projectId}/goals/${goalId}`, { method: "DELETE" });
    load(); onUpdate?.();
  }

  async function addFpaLink(label: string, type: string) {
    await fetch(`/api/projects/${projectId}/fpa-links`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract_label: label, contract_type: type }),
    });
    load(); onUpdate?.();
  }

  async function removeFpaLink(id: string) {
    await fetch(`/api/projects/${projectId}/fpa-links/${id}`, { method: "DELETE" });
    load(); onUpdate?.();
  }

  const unlinkedGoals = allGoals.filter(g => !linkedGoals.find(l => l.goal_id === g.goal_id) && g.status === "active");
  const unlinkedContracts = fpaContracts.filter(c => !linkedFpa.find(l => l.contract_label === c.label));

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader title="Strategic Planning" />

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Strategic Goals</span>
          <button onClick={() => setAddingGoal(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Link goal</button>
        </div>
        {linkedGoals.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">Not linked to any strategic goals.</p>
        ) : (
          <div className="space-y-1.5">
            {linkedGoals.map(g => (
              <div key={g.goal_id} className="flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${g.status === "achieved" ? "bg-green-500" : "bg-blue-500"}`} />
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{g.title}</span>
                {g.category && <span className="text-zinc-400">{g.category}</span>}
                {g.target_date && <span className="text-zinc-400">{fmtDate(g.target_date)}</span>}
                <button onClick={() => unlinkGoal(g.goal_id)} className="text-zinc-300 hover:text-red-400">✕</button>
              </div>
            ))}
          </div>
        )}
        {addingGoal && (
          <div className="flex gap-2 mt-2">
            <select value={selectedGoalId} onChange={e => setSelectedGoalId(e.target.value)} className={`flex-1 ${SEL_XS}`}>
              <option value="">Select goal…</option>
              {unlinkedGoals.map(g => <option key={g.goal_id} value={g.goal_id}>{g.title}</option>)}
            </select>
            <button onClick={linkGoal} disabled={!selectedGoalId} className="text-xs px-2 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40">Link</button>
            <button onClick={() => setAddingGoal(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">FP&A Contract Pipeline</span>
        </div>
        {linkedFpa.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">Not linked to any FP&A contracts.</p>
        ) : (
          <div className="space-y-1 mb-2">
            {linkedFpa.map(l => (
              <div key={l.id} className="flex items-center gap-2 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
                <span className="flex-1 text-zinc-700 dark:text-zinc-300">{l.contract_label}</span>
                {l.contract_type && <span className="text-zinc-400">{l.contract_type}</span>}
                <button onClick={() => removeFpaLink(l.id)} className="text-zinc-300 hover:text-red-400">✕</button>
              </div>
            ))}
          </div>
        )}
        {unlinkedContracts.length > 0 && (
          <div className="space-y-0.5">
            {unlinkedContracts.slice(0, 5).map(c => (
              <button key={c.label} onClick={() => addFpaLink(c.label, c.type)}
                className="w-full text-left text-xs px-2 py-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/50 flex items-center gap-2 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors">
                <span className="text-zinc-300 dark:text-zinc-600">+</span>
                <span className="flex-1 truncate">{c.label}</span>
                <span className="text-zinc-400">{c.type}</span>
                {c.total_value && <span className="font-mono text-zinc-400">{fmtCurrency(c.total_value)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Funding Agent ─────────────────────────────────────────────────────────────

export function FundingAgentSection({ projectId, noCard }: { projectId: string; noCard?: boolean }) {
  const [results, setResults] = useState<Array<{ opportunity_id: string; title: string; funding_type: string | null; amount: string | null; stage: string; tags: string[]; relevance_explanation: string; relevance_score: number }>>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function searchFunding() {
    setSearching(true); setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/funding-search`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      setResults((await r.json()).results ?? []);
      setSearched(true);
    } catch { setError("Funding search failed. Please try again."); }
    finally { setSearching(false); }
  }

  async function linkOpportunity(opportunityId: string) {
    await fetch(`/api/projects/${projectId}/fpa-links`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract_label: `funding:${opportunityId}`, contract_type: "funding_opportunity" }),
    });
  }

  const inner = (
    <>
      <SectionHeader title="Funding" action={
        <button onClick={searchFunding} disabled={searching}
          className="text-xs bg-violet-600 text-white px-3 py-1 rounded-lg hover:bg-violet-700 disabled:opacity-40 flex items-center gap-1.5">
          {searching ? "Searching…" : "Find Funding"}
        </button>
      } />
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-3">
        AI-powered search of your funding pipeline for opportunities relevant to this project.
      </p>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      {!searched && !searching && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">Click "Find Funding" to search for matching opportunities.</p>
      )}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map(r => (
            <div key={r.opportunity_id} className="p-2.5 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{r.title}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.relevance_score >= 8 ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : r.relevance_score >= 5 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-zinc-100 text-zinc-500"}`}>{r.relevance_score}/10</span>
                  <button onClick={() => linkOpportunity(r.opportunity_id)} className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">Link</button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-zinc-400 mb-1">
                {r.funding_type && <span>{r.funding_type}</span>}
                {r.amount && <span className="font-mono">{r.amount}</span>}
                {r.tags.map(t => <span key={t} className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{t}</span>)}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{r.relevance_explanation}</p>
            </div>
          ))}
        </div>
      )}
      {searched && results.length === 0 && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No matching funding opportunities found.</p>
      )}
    </>
  );

  if (noCard) return <div>{inner}</div>;
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      {inner}
    </div>
  );
}

// ── Shared helpers for Drive / Portal ─────────────────────────────────────────

function timeAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const MIME_LABEL: Record<string, { label: string; color: string }> = {
  "application/vnd.google-apps.document":     { label: "Doc",    color: "text-blue-500" },
  "application/vnd.google-apps.spreadsheet":  { label: "Sheet",  color: "text-green-500" },
  "application/vnd.google-apps.presentation": { label: "Slides", color: "text-yellow-500" },
  "application/vnd.google-apps.folder":       { label: "Folder", color: "text-zinc-400" },
  "application/pdf":                          { label: "PDF",    color: "text-red-400" },
  "text/plain":                               { label: "Text",   color: "text-zinc-400" },
};

interface DriveFile { file_id: string; name: string; mime_type: string | null; web_view_link: string | null; modified_time: string | null; content_text?: string | null; }
interface DriveInfo { drive_folder_id: string | null; drive_folder_name: string | null; drive_synced_at: string | null; files?: DriveFile[]; }

function DriveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 87.3 78" fill="currentColor">
      <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L38 33.35 13.85 0C12.45.8 11.3 1.9 10.55 3.3L.25 21.7A13.4 13.4 0 000 28.15c0 2.3.6 4.5 1.75 6.45z" fill="#0066da"/>
      <path d="M43.65 78l24.5-42.45L43.65 33 19.15 78z" fill="#00ac47"/>
      <path d="M73.55 76.15c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.25-2.95 1.2-4.5 0-2.3-.6-4.5-1.75-6.45l-10.35-17.9c-.8-1.4-1.95-2.5-3.3-3.3L49.3 67.55z" fill="#ea4335"/>
      <path d="M43.65 0L19.15 42.45 43.65 78l24.5-42.45z" fill="#00832d"/>
      <path d="M76.85 24.85L66.5 6.95C65.7 5.55 64.55 4.45 63.2 3.65L43.65 0 49.3 67.55l27.55-42.7z" fill="#2684fc"/>
      <path d="M43.65 0L19.15 42.45 38 33.35 43.65 0z" fill="#00ac47"/>
    </svg>
  );
}

// ── Drive Section ─────────────────────────────────────────────────────────────

export function DriveSection({ projectId }: { projectId: string }) {
  const [driveInfo, setDriveInfo] = useState<DriveInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"doc" | "sheet" | "slide">("doc");
  const [showCreate, setShowCreate] = useState(false);
  const [preview, setPreview] = useState<DriveFile | null>(null);

  const fetchDrive = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/drive`);
      if (r.ok) setDriveInfo(await r.json());
      else {
        const d = await r.json().catch(() => ({}));
        const detail = d?.detail;
        setError(typeof detail === "object" && detail?.code ? detail.code : "error");
      }
    } catch { setError("error"); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchDrive(); }, [fetchDrive]);

  async function onLink(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!linkInput.trim()) return;
    setLinking(true); setError(null);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/link`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_url: linkInput.trim() }),
    });
    if (r.ok) { setLinkInput(""); fetchDrive(); }
    else {
      const d = await r.json().catch(() => ({}));
      const detail = d?.detail;
      setError(typeof detail === "object" ? detail?.code ?? "error" : "error");
    }
    setLinking(false);
  }

  async function onSync() {
    setSyncing(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/sync`, { method: "POST" });
    if (r.ok) fetchDrive();
    setSyncing(false);
  }

  async function onCreate(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), file_type: newType }),
    });
    if (r.ok) {
      const f = await r.json();
      if (f.webViewLink) window.open(f.webViewLink, "_blank");
      setNewName(""); setShowCreate(false); fetchDrive();
    }
    setCreating(false);
  }

  async function fetchPreview(file: DriveFile) {
    if (file.content_text) { setPreview(file); return; }
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/files/${file.file_id}`);
    if (r.ok) setPreview(await r.json());
  }

  if (loading) return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center">
      <p className="text-sm text-zinc-400">Loading Drive…</p>
    </div>
  );

  if (error === "no_google_token" || error === "needs_drive_scope") return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center space-y-3">
      <DriveIcon className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto" />
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {error === "no_google_token" ? "Google account not connected." : "Drive access not enabled."}
      </p>
      <p className="text-xs text-zinc-400">Go to <strong>Contacts → Google</strong> and re-connect your Google account to enable Drive.</p>
    </div>
  );

  if (!driveInfo?.drive_folder_id) return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
      <div className="flex items-center gap-2">
        <DriveIcon className="w-5 h-5 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Link a Drive Folder</h2>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">Paste the URL of a Google Drive folder to index files for this project.</p>
      <form onSubmit={onLink} className="flex gap-2">
        <input type="text" placeholder="https://drive.google.com/drive/folders/…"
          value={linkInput} onChange={e => setLinkInput(e.target.value)}
          className="flex-1 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <button type="submit" disabled={!linkInput.trim() || linking}
          className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
          {linking ? "Linking…" : "Link"}
        </button>
      </form>
      {error && <p className="text-xs text-red-500">Failed to link folder. Check the URL and Drive permissions.</p>}
    </div>
  );

  const files = driveInfo.files ?? [];
  const exportable = ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"];

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <DriveIcon className="w-4 h-4 text-blue-500 shrink-0" />
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">{driveInfo.drive_folder_name ?? driveInfo.drive_folder_id}</p>
          {driveInfo.drive_synced_at && <span className="text-[10px] text-zinc-400 shrink-0">synced {timeAgo(driveInfo.drive_synced_at)}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onSync} disabled={syncing} className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40">{syncing ? "Syncing…" : "Sync"}</button>
          <button onClick={async () => { await fetch(`/api/proxy/projects/${projectId}/drive/unlink`, { method: "DELETE" }); fetchDrive(); }} className="text-xs text-zinc-400 hover:text-red-500 transition-colors">Unlink</button>
        </div>
      </div>
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800">
        {showCreate ? (
          <form onSubmit={onCreate} className="px-4 py-3 flex items-center gap-2 flex-wrap">
            <input type="text" placeholder="File name…" value={newName} onChange={e => setNewName(e.target.value)} autoFocus
              className="flex-1 text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-32" />
            <select value={newType} onChange={e => setNewType(e.target.value as "doc" | "sheet" | "slide")}
              className="text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none">
              <option value="doc">Doc</option><option value="sheet">Sheet</option><option value="slide">Slides</option>
            </select>
            <button type="submit" disabled={!newName.trim() || creating}
              className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
              {creating ? "Creating…" : "Create"}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="text-xs text-zinc-400 hover:text-zinc-600">Cancel</button>
          </form>
        ) : (
          <button onClick={() => setShowCreate(true)}
            className="w-full px-4 py-2.5 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors rounded-xl">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            New file in this folder
          </button>
        )}
      </div>
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
        {files.length === 0 ? (
          <p className="px-4 py-8 text-sm text-zinc-400 text-center">No files in this folder yet.</p>
        ) : files.map(f => {
          const m = MIME_LABEL[f.mime_type ?? ""] ?? { label: "File", color: "text-zinc-400" };
          const canPreview = exportable.includes(f.mime_type ?? "");
          return (
            <div key={f.file_id} className="px-4 py-2.5 flex items-center gap-3 group">
              <span className={`text-[10px] font-bold uppercase tracking-wide w-8 shrink-0 ${m.color}`}>{m.label}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-800 dark:text-zinc-100 truncate">{f.name}</p>
                {f.modified_time && <p className="text-[10px] text-zinc-400">{timeAgo(f.modified_time)}</p>}
              </div>
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {canPreview && <button onClick={() => fetchPreview(f)} className="text-xs text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400">Read</button>}
                {f.web_view_link && <a href={f.web_view_link} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400">Open ↗</a>}
              </div>
            </div>
          );
        })}
      </div>
      {preview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{preview.name}</p>
              <div className="flex items-center gap-3 shrink-0">
                {preview.web_view_link && <a href={preview.web_view_link} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Open in Drive ↗</a>}
                <button onClick={() => setPreview(null)} className="text-zinc-400 hover:text-zinc-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {preview.content_text ? (
                <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed font-sans">{preview.content_text}</pre>
              ) : (
                <p className="text-sm text-zinc-400 text-center py-8">Loading content…</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Workspace Bar (Drive + Resources + Portal) ───────────────────────────────

type WorkspaceTab = "drive" | "resources" | "portal";

interface WorkspaceSummary {
  driveLinked: boolean | null;   // null = loading
  resourceCount: number | null;
  portalActive: boolean | null;
}

export function WorkspaceBar({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<WorkspaceSummary>({ driveLinked: null, resourceCount: null, portalActive: null });
  const [expanded, setExpanded] = useState<WorkspaceTab | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/proxy/projects/${projectId}/drive`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/resources?project_id=${projectId}`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`/api/proxy/projects/${projectId}/portal`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([drive, resources, portal]) => {
      setSummary({
        driveLinked: drive?.drive_folder_id ? true : false,
        resourceCount: Array.isArray(resources) ? resources.length : 0,
        portalActive: portal?.portal != null,
      });
    });
  }, [projectId]);

  function toggle(tab: WorkspaceTab) {
    setExpanded(prev => prev === tab ? null : tab);
  }

  const tiles: { key: WorkspaceTab; label: string; status: string; icon: React.ReactNode }[] = [
    {
      key: "drive",
      label: "Drive",
      status: summary.driveLinked === null ? "…" : summary.driveLinked ? "Linked" : "Not linked",
      icon: <DriveIcon className="w-4 h-4" />,
    },
    {
      key: "resources",
      label: "Resources",
      status: summary.resourceCount === null ? "…" : summary.resourceCount === 0 ? "None" : `${summary.resourceCount}`,
      icon: (
        <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 5.625c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
        </svg>
      ),
    },
    {
      key: "portal",
      label: "Portal",
      status: summary.portalActive === null ? "…" : summary.portalActive ? "Active" : "No link",
      icon: (
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
        </svg>
      ),
    },
  ];

  return (
    <div className="space-y-0">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
        <div className="grid grid-cols-3 divide-x divide-zinc-100 dark:divide-zinc-800">
          {tiles.map(tile => {
            const isActive = expanded === tile.key;
            const isEmpty = tile.status === "None" || tile.status === "Not linked" || tile.status === "No link";
            return (
              <button
                key={tile.key}
                onClick={() => toggle(tile.key)}
                className={`flex flex-col items-center gap-1.5 py-3 px-2 transition-colors text-center ${isActive ? "bg-zinc-50 dark:bg-zinc-800/60" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40"}`}
              >
                <div className={`transition-opacity ${isEmpty ? "opacity-40" : "opacity-100"}`}>{tile.icon}</div>
                <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{tile.label}</span>
                <span className={`text-[10px] ${isEmpty ? "text-zinc-400 dark:text-zinc-600" : "text-blue-600 dark:text-blue-400"}`}>{tile.status}</span>
                <svg className={`w-3 h-3 text-zinc-300 dark:text-zinc-600 transition-transform ${isActive ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            );
          })}
        </div>
      </div>

      {expanded === "drive" && (
        <div className="pt-2"><DriveSection projectId={projectId} /></div>
      )}
      {expanded === "resources" && (
        <div className="pt-2"><ResourcesSection projectId={projectId} /></div>
      )}
      {expanded === "portal" && (
        <div className="pt-2"><PortalSection projectId={projectId} /></div>
      )}
    </div>
  );
}

// ── Portal Section ────────────────────────────────────────────────────────────

export function PortalSection({ projectId }: { projectId: string }) {
  const [portalInfo, setPortalInfo] = useState<{ portal_id: string; token: string; is_password_protected: boolean; portal_drive_folder_id: string | null; portal_drive_folder_name: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchPortal = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal`);
      if (r.ok) { const d = await r.json(); setPortalInfo(d.portal ?? null); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchPortal(); }, [fetchPortal]);

  async function createPortal() {
    setCreating(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "POST" });
    if (r.ok) fetchPortal();
    setCreating(false);
  }

  async function revokePortal() {
    if (!portalInfo) return;
    await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "DELETE" });
    setPortalInfo(null);
  }

  if (loading) return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center">
      <p className="text-sm text-zinc-400">Loading…</p>
    </div>
  );

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
          </svg>
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">Client Portal</span>
        </div>
        {portalInfo ? (
          <div className="flex items-center gap-2">
            <button onClick={() => { const url = `${window.location.origin}/portal/${portalInfo.token}`; navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{copied ? "Copied!" : "Copy link"}</button>
            <a href={`/portal/${portalInfo.token}`} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Preview ↗</a>
            <button onClick={revokePortal} className="text-xs text-zinc-400 hover:text-red-500 transition-colors">Revoke</button>
          </div>
        ) : (
          <button onClick={createPortal} disabled={creating}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
            {creating ? "Creating…" : "Generate link"}
          </button>
        )}
      </div>
      {portalInfo && (
        <>
          <p className="text-[11px] text-zinc-400 truncate font-mono">{typeof window !== "undefined" ? `${window.location.origin}/portal/${portalInfo.token}` : ""}</p>
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-xs text-zinc-400">Manage description, contacts, updates, password protection, and activity.</p>
            <a href={`/portals/${projectId}`} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors font-medium">Manage →</a>
          </div>
        </>
      )}
    </div>
  );
}
