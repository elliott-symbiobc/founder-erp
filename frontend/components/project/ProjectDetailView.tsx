"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { RD_STAGE_GROUPS, PORTFOLIO_STAGE_GROUPS, allStages } from "@/lib/contractStages";
import { PlanSection } from "@/components/project/PlanSection";
import { ActiveTasksSection, WorkspaceBar, StrategicPlanningSection } from "@/components/project/ProjectSections";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ──────────────────────────────────────────────────────────────────────

interface User { user_id: string; name: string; full_name?: string; avatar_url?: string; }

interface Milestone {
  milestone_id: string; title: string; description: string | null; milestone_type: string;
  status: string; due_date: string | null; start_date: string | null; completed_at: string | null;
  owner_id: string | null; owner_name: string | null; owner_avatar: string | null; sort_order: number;
  document_deliverable: boolean; integration_refs: Record<string, unknown>; open_task_count: number;
  done_task_count: number; assignees: Array<{ user_id: string; role: string; name: string; avatar_url?: string }> | null;
  blocked_by_count: number; blocks_count: number;
}

interface Task {
  task_id: string; title: string; status: string; kanban_status: string; due_date: string | null;
  start_date: string | null; description: string | null; priority: string | null; activity_type: string | null;
  milestone_id: string | null; milestone_title: string | null; assigned_to: string | null;
  assigned_to_name: string | null; extra_assignees: Array<{ user_id: string; role: string; name: string }> | null;
  blocked_by_count: number; estimated_minutes: number | null;
}

interface EmailActivity {
  interaction_type: string; subject: string | null; content_preview: string | null; occurred_at: string;
  direction: string | null; contact_name: string | null; contact_org: string | null;
}

interface ContactReminder {
  reminder_id: string; reminder_type: string; title: string; description: string | null;
  due_date: string | null; auto_generated: boolean; contact_name?: string;
}

interface ProjectContact {
  id: string; contact_id: string; role: string; is_primary: boolean; name: string;
  email: string | null; organization: string | null; title: string | null; avatar_url: string | null;
}

interface Resource {
  id: string; resource_type: string; label: string; quantity: number | null; unit: string | null;
  start_date: string | null; end_date: string | null; cost_estimate: number | null;
  assigned_user_name: string | null; milestone_title: string | null; notes: string | null;
}

interface StrategicGoalLink {
  id: string; goal_id: string; title: string; category: string | null;
  status: string; target_date: string | null; contribution_notes: string | null;
}

interface FpaLink { id: string; contract_label: string; contract_type: string | null; link_notes: string | null; }

export interface Project {
  project_id: string; name: string; project_type: string; stage: string | null; status: string;
  probability: number | null; expected_revenue: number | null; revenue_to_date: number | null;
  date_start: string | null; date_deadline: string | null; tags: string[]; notes: string | null;
  contact_id: string | null; contact_name: string | null; contact_org: string | null;
  contact_avatar: string | null; contact_email: string | null; assigned_to: string | null;
  assigned_to_name: string | null; ai_summary: string | null; substrate: string | null;
  linked_opportunity_id: string | null; linked_investor_id: string | null;
  tasks: Task[]; email_activity: EmailActivity[]; contact_reminders: ContactReminder[];
  project_contacts: ProjectContact[]; milestones: Array<{
    milestone_id: string; title: string; milestone_type: string; status: string;
    due_date: string | null; sort_order: number; document_deliverable: boolean; open_tasks: number; done_tasks: number;
  }>; strategic_goals: StrategicGoalLink[]; fpa_links: FpaLink[];
  template_id: string | null; crm_deal_id: string | null; crm_type: string | null;
  company_description: string | null; esg_url: string | null; lead_source: string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEL = "text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 pr-7 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.4rem_center] bg-[length:1rem]";
const SEL_XS = "text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-5 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.25rem_center] bg-[length:0.8rem]";

const STAGE_SEQUENCES: Record<string, string[]> = {
  partnership: ["Exploring","Negotiating","Agreement","Active","Complete"],
  grant:       ["Identified","In Prep","Submitted","Under Review","Won","Lost"],
  internal:    ["Backlog","Planning","Active","Validation","Complete"],
  marketing:   ["Idea","Draft","Published","Archived"],
};

const STATUS_COLORS: Record<string, string> = {
  in_progress: "bg-green-500", waiting_client: "bg-amber-400",
  waiting_sbc: "bg-[#C31010]", awaiting_vendor: "bg-orange-400",
};

const STATUS_LABEL: Record<string, string> = {
  in_progress: "In Progress", waiting_client: "Awaiting Client",
  waiting_sbc: "Awaiting Us", awaiting_vendor: "Awaiting Vendor",
};

const MILESTONE_STATUS_COLORS: Record<string, string> = {
  pending:          "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  in_progress:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blocked:          "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  complete:         "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  skipped:          "bg-zinc-100 text-zinc-400 dark:bg-zinc-800",
  waiting_external: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};

const MILESTONE_TYPE_ICON: Record<string, string> = {
  objective: "○", checkpoint: "◆", deliverable: "▣", approval: "✓",
  external_wait: "⧗", repeating: "↺",
};

const ACTIVITY_ICON: Record<string, string> = {
  email: "✉", call: "☎", meeting: "◎", document: "▣", todo: "○",
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "text-red-500", medium: "text-amber-500", low: "text-zinc-400",
};

const DATE_INPUT = "text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 cursor-pointer";
const LEAD_SOURCES = ["Inbound", "Referral", "Cold Outreach", "Conference/Event", "Partner", "Website", "Social Media", "Other"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

function RevenueField({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.toString() ?? "");
  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-zinc-500">$</span>
        <input autoFocus type="number" value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={() => { onSave(draft ? parseFloat(draft) : null); setEditing(false); }}
          onKeyDown={e => {
            if (e.key === "Enter") { onSave(draft ? parseFloat(draft) : null); setEditing(false); }
            if (e.key === "Escape") { setDraft(value?.toString() ?? ""); setEditing(false); }
          }}
          className="w-24 text-xs border-b border-blue-400 bg-transparent focus:outline-none text-zinc-800 dark:text-zinc-200" placeholder="0" />
      </div>
    );
  }
  return (
    <button onClick={() => { setDraft(value?.toString() ?? ""); setEditing(true); }}
      className={`text-xs font-mono rounded px-1.5 py-0.5 transition-colors ${value ? "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800" : "text-zinc-300 dark:text-zinc-600 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
      title="Click to set revenue">
      {value ? fmtCurrency(value) : "+ Revenue"}
    </button>
  );
}

function MoneyField({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  if (editing) {
    return (
      <div className="flex items-center gap-1 border border-blue-300 dark:border-blue-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800">
        <span className="text-sm text-zinc-400">$</span>
        <input autoFocus type="number" value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={() => { onSave(draft ? parseFloat(draft) : null); setEditing(false); }}
          onKeyDown={e => {
            if (e.key === "Enter") { onSave(draft ? parseFloat(draft) : null); setEditing(false); }
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-24 text-sm bg-transparent focus:outline-none text-zinc-800 dark:text-zinc-200" placeholder="0" />
      </div>
    );
  }
  return (
    <button onClick={() => { setDraft(value?.toString() ?? ""); setEditing(true); }}
      className="text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-left text-zinc-800 dark:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 transition-colors min-w-[100px]">
      {value ? fmtCurrency(value) : <span className="text-zinc-300 dark:text-zinc-600">$—</span>}
    </button>
  );
}

function FinancialSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/proxy/projects/${project.project_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    onUpdate();
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">Revenue</h3>
      <div className="flex gap-6">
        <div>
          <label className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide block mb-1">Projected</label>
          <MoneyField value={project.expected_revenue} onSave={v => patch({ expected_revenue: v })} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide block mb-1">To Date</label>
          <MoneyField value={project.revenue_to_date} onSave={v => patch({ revenue_to_date: v })} />
        </div>
      </div>
    </div>
  );
}

function ProjectHeader({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const [editingSubstrate, setEditingSubstrate] = useState(false);
  const [substrateDraft, setSubstrateDraft] = useState(project.substrate ?? "");
  const [editingName, setEditingName] = useState(false);
  const displayTitle = project.contact_org ?? project.contact_name ?? project.name;
  const [nameDraft, setNameDraft] = useState(displayTitle);
  useEffect(() => { setSubstrateDraft(project.substrate ?? ""); }, [project.substrate]);
  useEffect(() => { setNameDraft(project.contact_org ?? project.contact_name ?? project.name); }, [project.contact_org, project.contact_name, project.name]);
  async function saveSubstrate() {
    await fetch(`/api/proxy/projects/${project.project_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ substrate: substrateDraft.trim() || null }),
    });
    setEditingSubstrate(false); onUpdate();
  }
  async function saveName() {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== displayTitle) {
      if (project.contact_id && project.contact_org != null) {
        await fetch(`/api/proxy/contacts/${project.contact_id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization: trimmed }),
        });
      } else if (project.contact_id && project.contact_name != null) {
        await fetch(`/api/proxy/contacts/${project.contact_id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
      } else {
        await fetch(`/api/proxy/projects/${project.project_id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
      }
      onUpdate();
    }
    setEditingName(false);
  }
  const showSubstrate = !["marketing", "internal", "grant"].includes(project.project_type);
  return (
    <div className="space-y-0.5">
      {editingName ? (
        <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)}
          onBlur={saveName}
          onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setNameDraft(displayTitle); setEditingName(false); } }}
          className="text-xl font-semibold bg-transparent border-b border-blue-400 focus:outline-none text-zinc-900 dark:text-zinc-100 w-full max-w-lg" />
      ) : (
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          onClick={() => { setNameDraft(displayTitle); setEditingName(true); }}
          title="Click to edit">
          {displayTitle}
        </h1>
      )}
      {showSubstrate && (editingSubstrate ? (
        <input autoFocus value={substrateDraft} onChange={e => setSubstrateDraft(e.target.value)}
          onBlur={saveSubstrate}
          onKeyDown={e => { if (e.key === "Enter") saveSubstrate(); if (e.key === "Escape") { setSubstrateDraft(project.substrate ?? ""); setEditingSubstrate(false); } }}
          placeholder="Substrate…"
          className="text-sm bg-transparent border-b border-blue-400 focus:outline-none text-zinc-500 dark:text-zinc-400 w-full max-w-lg" />
      ) : (
        <button onClick={() => { setSubstrateDraft(project.substrate ?? ""); setEditingSubstrate(true); }}
          className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">
          {project.substrate || <span className="text-zinc-300 dark:text-zinc-600 italic">+ Add substrate</span>}
        </button>
      ))}
    </div>
  );
}

function PartnershipHeader({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const partnerName = project.contact_org || project.contact_name || "";
  const [editingPartner, setEditingPartner] = useState(false);
  const [partnerDraft, setPartnerDraft] = useState(partnerName);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  useEffect(() => { setPartnerDraft(project.contact_org || project.contact_name || ""); }, [project.contact_org, project.contact_name]);
  useEffect(() => { setNameDraft(project.name); }, [project.name]);
  async function savePartner() {
    if (!project.contact_id) { setEditingPartner(false); return; }
    await fetch(`/api/proxy/contacts/${project.contact_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: partnerDraft.trim() || null }),
    });
    setEditingPartner(false); onUpdate();
  }
  async function saveName() {
    await fetch(`/api/proxy/projects/${project.project_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameDraft.trim() || project.name }),
    });
    setEditingName(false); onUpdate();
  }
  return (
    <div className="space-y-0.5">
      {editingPartner ? (
        <input autoFocus value={partnerDraft} onChange={e => setPartnerDraft(e.target.value)} onBlur={savePartner}
          onKeyDown={e => { if (e.key === "Enter") savePartner(); if (e.key === "Escape") { setPartnerDraft(partnerName); setEditingPartner(false); } }}
          placeholder="Partner name…" className="text-xl font-semibold bg-transparent border-b border-blue-400 focus:outline-none text-zinc-900 dark:text-zinc-100 w-full max-w-lg" />
      ) : (
        <button onClick={() => { setPartnerDraft(partnerName); setEditingPartner(true); }}
          className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors text-left">
          {partnerName || <span className="text-zinc-300 dark:text-zinc-600 font-normal italic text-lg">+ Add partner name</span>}
        </button>
      )}
      {editingName ? (
        <input autoFocus value={nameDraft} onChange={e => setNameDraft(e.target.value)} onBlur={saveName}
          onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setNameDraft(project.name); setEditingName(false); } }}
          placeholder="Project name…" className="text-sm font-medium bg-transparent border-b border-blue-300 focus:outline-none text-zinc-500 dark:text-zinc-400 w-full max-w-lg" />
      ) : (
        <button onClick={() => { setNameDraft(project.name); setEditingName(true); }}
          className="text-sm font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors text-left">
          {project.name || <span className="italic">+ Add project name</span>}
        </button>
      )}
    </div>
  );
}

function StatusBar({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const contractStageGroups =
    project.project_type === "crm_opportunity" ? RD_STAGE_GROUPS :
    project.project_type === "portfolio" && project.crm_type === "portfolio_contract" ? PORTFOLIO_STAGE_GROUPS :
    project.project_type === "portfolio" ? RD_STAGE_GROUPS : null;
  const stages = contractStageGroups ? allStages(contractStageGroups) : (STAGE_SEQUENCES[project.project_type] ?? []);
  const [descDraft, setDescDraft] = useState(project.notes ?? "");
  const [descEditing, setDescEditing] = useState(false);
  const [aiStatusLoading, setAiStatusLoading] = useState(false);
  const [aiStatusReason, setAiStatusReason] = useState<string | null>(null);
  useEffect(() => { if (project.project_type !== "grant") calcAiStatus(); }, [project.project_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDescDraft(project.notes ?? ""); }, [project.notes]);
  useEffect(() => {
    if (!project.date_start && project.email_activity?.length) {
      const earliest = [...project.email_activity].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())[0];
      fetch(`/api/proxy/projects/${project.project_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date_start: earliest.occurred_at.slice(0, 10) }),
      }).then(() => onUpdate());
    }
  }, [project.project_id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/proxy/projects/${project.project_id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    onUpdate();
  }
  async function calcAiStatus() {
    setAiStatusLoading(true);
    setAiStatusReason(null);
    try {
      const r = await fetch(`/api/proxy/projects/${project.project_id}/calculate-status`, { method: "POST" });
      if (r.ok) { const d = await r.json(); setAiStatusReason(d.reason ?? null); onUpdate(); }
    } finally { setAiStatusLoading(false); }
  }
  const STATUS_DOT_MAP: Record<string, string> = {
    in_progress: "bg-green-500", waiting_client: "bg-amber-400",
    waiting_sbc: "bg-[#C31010]", awaiting_vendor: "bg-orange-400",
  };
  const STATUS_LABEL_MAP: Record<string, string> = {
    in_progress: "In Progress", waiting_client: "Awaiting Client",
    waiting_sbc: "Awaiting Us", awaiting_vendor: "Awaiting Vendor",
  };
  const lastContactDays = project.email_activity?.length
    ? Math.floor((Date.now() - new Date([...project.email_activity].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0].occurred_at).getTime()) / 86_400_000)
    : null;

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
      {/* Row 1: status pill + stage select + type select + dates + AI button */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status — manual dropdown (hidden for grants, AI-managed) */}
        {project.project_type !== "grant" && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border ${
            project.status === "in_progress"    ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-950/20 dark:border-green-800 dark:text-green-400" :
            project.status === "waiting_client" ? "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-400" :
            project.status === "waiting_sbc"    ? "bg-[#C31010]/10 border-[#C31010]/40 text-[#C31010] dark:bg-[#C31010]/25 dark:border-[#C31010]/50 dark:text-[#ef8f8f]" :
            "bg-orange-50 border-orange-200 text-orange-700 dark:bg-orange-950/20 dark:border-orange-800 dark:text-orange-400"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT_MAP[project.status] ?? "bg-zinc-400"}`} />
            <select
              value={project.status}
              onChange={e => patch({ status: e.target.value })}
              className="bg-transparent border-0 cursor-pointer focus:outline-none appearance-none p-0 leading-none text-inherit"
            >
              {Object.entries(STATUS_LABEL_MAP).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}

        {/* Stage */}
        {stages.length > 0 && (
          <select value={project.stage ?? ""} onChange={e => patch({ stage: e.target.value })} className={SEL_XS}>
            {!project.stage && <option value="">— Stage —</option>}
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        {/* Type */}
        <select value={project.project_type} onChange={e => patch({ project_type: e.target.value })} className={SEL_XS}>
          <option value="crm_opportunity">R&D Contract</option>
          <option value="portfolio">Portfolio Contract</option>
          <option value="partnership">Partnership</option>
          <option value="grant">Grant / Funding</option>
          <option value="internal">Operations</option>
          <option value="marketing">Marketing</option>
        </select>

        {/* Dates */}
        <input type="date" value={project.date_start ?? ""} onChange={e => patch({ date_start: e.target.value || null })}
          title="Start date"
          className="text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30 cursor-pointer" />
        <span className="text-zinc-300 dark:text-zinc-600 text-xs">→</span>
        <input type="date" value={project.date_deadline ?? ""} onChange={e => patch({ date_deadline: e.target.value || null })}
          title="End date"
          className="text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30 cursor-pointer" />

        {lastContactDays !== null && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-1">
            Last contact: {lastContactDays === 0 ? "today" : lastContactDays === 1 ? "yesterday" : `${lastContactDays}d ago`}
          </span>
        )}

        {/* AI status loading indicator — not for grants */}
        {aiStatusLoading && project.project_type !== "grant" && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-violet-500 dark:text-violet-400">
            <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            AI
          </span>
        )}
      </div>

      {/* AI reason banner */}
      {aiStatusReason && (
        <div className="mt-2 px-2.5 py-1.5 bg-violet-50 dark:bg-violet-950/20 border border-violet-100 dark:border-violet-900/30 rounded-lg text-xs text-violet-700 dark:text-violet-300">
          {aiStatusReason}
        </div>
      )}

      {/* Description */}
      <div className="mt-2">
        {descEditing ? (
          <AutoTextarea autoFocus value={descDraft} onChange={e => setDescDraft(e.target.value)}
            onBlur={() => { patch({ notes: descDraft || null }); setDescEditing(false); }}
            onKeyDown={e => { if (e.key === "Escape") { setDescDraft(project.notes ?? ""); setDescEditing(false); } }}
            rows={2} className="w-full text-xs px-2 py-1.5 border border-blue-300 dark:border-blue-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none resize-none" />
        ) : (
          <button onClick={() => { setDescDraft(project.notes ?? ""); setDescEditing(true); }}
            className="w-full text-left text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 px-1 py-0.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
            {project.notes ?? <span className="text-zinc-300 dark:text-zinc-600 italic">Add description…</span>}
          </button>
        )}
      </div>
      {project.assigned_to_name && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">Owner: {project.assigned_to_name}</p>}
    </div>
  );
}

function TimelineList({ emails }: { emails: EmailActivity[] }) {
  const groups: Record<string, EmailActivity[]> = {};
  for (const e of emails) {
    const key = new Date(e.occurred_at).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    (groups[key] = groups[key] ?? []).push(e);
  }
  return (
    <div className="relative pl-5">
      <div className="absolute left-2 top-0 bottom-0 w-px bg-zinc-200 dark:bg-zinc-700" />
      <div className="space-y-5">
        {Object.entries(groups).map(([month, items]) => (
          <div key={month}>
            <div className="flex items-center gap-2 mb-2 -ml-5">
              <div className="w-4 h-4 rounded-full bg-zinc-200 dark:bg-zinc-700 ring-2 ring-white dark:ring-zinc-900 flex-shrink-0 ml-0.5" />
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{month}</span>
            </div>
            <div className="space-y-0.5">
              {items.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-xs py-1.5 px-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                  <span className={`flex-shrink-0 mt-0.5 ${e.direction === "inbound" ? "text-blue-500" : e.interaction_type === "meeting" ? "text-purple-500" : "text-emerald-500"}`}>
                    {e.interaction_type === "meeting" ? "◎" : e.direction === "inbound" ? "↙" : "↗"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {e.contact_name && <span className="font-medium text-zinc-700 dark:text-zinc-300">{e.contact_name}</span>}
                      {e.subject && <span className="text-zinc-500 dark:text-zinc-400 truncate">{e.subject}</span>}
                    </div>
                    {e.content_preview && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">{e.content_preview}</p>}
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-zinc-300 dark:text-zinc-600 whitespace-nowrap">
                    {new Date(e.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GanttTimeline({ emails, project }: { emails: EmailActivity[]; project: Project }) {
  const sorted = [...emails].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  const minTs = new Date(sorted[0].occurred_at).getTime();
  const maxTs = Date.now();
  const totalMs = maxTs - minTs || 1;
  function xPct(dateStr: string) { return Math.max(0, Math.min(100, (new Date(dateStr).getTime() - minTs) / totalMs * 100)); }
  const contacts = [...new Set(sorted.map(e => e.contact_name).filter(Boolean))] as string[];
  const milestonesWithDates = (project.milestones ?? []).filter(m => m.due_date);
  const months: { label: string; pct: number }[] = [];
  const cur = new Date(minTs); cur.setDate(1);
  while (cur.getTime() <= maxTs) {
    months.push({ label: cur.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), pct: (cur.getTime() - minTs) / totalMs * 100 });
    cur.setMonth(cur.getMonth() + 1);
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px] space-y-1.5">
        <div className="relative h-5 ml-36 mb-1">
          {months.map(m => <div key={m.label} className="absolute text-[9px] text-zinc-400 dark:text-zinc-500 whitespace-nowrap -translate-x-1/2" style={{ left: `${m.pct}%` }}>{m.label}</div>)}
        </div>
        {milestonesWithDates.length > 0 && (
          <div className="flex items-center">
            <div className="w-36 flex-shrink-0 text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide pr-3 text-right">Milestones</div>
            <div className="flex-1 relative h-6 bg-zinc-50 dark:bg-zinc-800/20 rounded">
              <div className="absolute top-0 bottom-0 w-px bg-red-300 dark:bg-red-700/50" style={{ left: "100%" }} />
              {milestonesWithDates.map(m => (
                <div key={m.milestone_id} className="absolute top-1/2 -translate-y-1/2 group/dot" style={{ left: `${xPct(m.due_date!)}%` }} title={m.title}>
                  <div className={`w-2.5 h-2.5 rotate-45 -translate-x-1/2 cursor-pointer border border-white dark:border-zinc-900 ${m.status === "complete" ? "bg-green-400" : m.status === "in_progress" ? "bg-blue-400" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/dot:block z-20 bg-zinc-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap shadow-lg">{m.title}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {contacts.map(contact => {
          const cEmails = sorted.filter(e => e.contact_name === contact);
          const firstPct = xPct(cEmails[0].occurred_at);
          const lastPct = xPct(cEmails[cEmails.length - 1].occurred_at);
          return (
            <div key={contact} className="flex items-center">
              <div className="w-36 flex-shrink-0 text-[11px] text-zinc-600 dark:text-zinc-400 truncate pr-3 text-right">{contact}</div>
              <div className="flex-1 relative h-6 bg-zinc-50 dark:bg-zinc-800/20 rounded">
                <div className="absolute top-0 bottom-0 w-px bg-red-300 dark:bg-red-700/50" style={{ left: "100%" }} />
                {cEmails.length > 1 && <div className="absolute top-1/2 -translate-y-1/2 h-px bg-zinc-300 dark:bg-zinc-600" style={{ left: `${firstPct}%`, width: `${Math.max(lastPct - firstPct, 0.2)}%` }} />}
                {cEmails.map((e, i) => (
                  <div key={i} className="absolute top-1/2 -translate-y-1/2 group/dot" style={{ left: `${xPct(e.occurred_at)}%` }}>
                    <div className={`w-2.5 h-2.5 rounded-full border border-white dark:border-zinc-900 -translate-x-1/2 cursor-pointer ${e.interaction_type === "meeting" ? "bg-purple-400" : e.direction === "inbound" ? "bg-blue-400" : "bg-emerald-400"}`} />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/dot:block z-20 bg-zinc-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap shadow-lg">
                      {e.direction === "inbound" ? "↙" : "↗"} {new Date(e.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}{e.subject ? ` — ${e.subject.slice(0, 40)}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-4 pt-2 ml-36 text-[10px] text-zinc-400 dark:text-zinc-500">
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-400" /> Inbound</div>
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-400" /> Outbound</div>
          <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-purple-400" /> Meeting</div>
          <div className="flex items-center gap-1"><div className="w-px h-3 bg-red-300" /> Today</div>
        </div>
      </div>
    </div>
  );
}

interface TimelinePhase { title: string; start_date: string; end_date: string; summary: string; }

function ProjectTimeline({ project }: { project: Project }) {
  const [phases, setPhases] = useState<TimelinePhase[]>([]);
  const [generating, setGenerating] = useState(false);
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [ganttOpen, setGanttOpen] = useState(false);

  const emailsDesc = [...(project.email_activity ?? [])].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );
  const emailsAsc = [...emailsDesc].reverse();

  useEffect(() => {
    if (emailsDesc.length === 0) return;
    setGenerating(true);
    fetch(`/api/proxy/projects/${project.project_id}/timeline`, { method: "POST" })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.phases) setPhases(data.phases); })
      .finally(() => setGenerating(false));
  }, [project.project_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (emailsDesc.length === 0) return null;

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Relationship History</h3>
        {generating && (
          <span className="text-[11px] text-violet-500 dark:text-violet-400 flex items-center gap-1">
            <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            Analyzing…
          </span>
        )}
      </div>

      {/* Recent emails — newest first, show 5 by default */}
      <div className="space-y-0.5 mb-3">
        {emailsDesc.slice(0, emailsOpen ? undefined : 5).map((e, i) => {
          const daysAgo = Math.floor((Date.now() - new Date(e.occurred_at).getTime()) / 86_400_000);
          return (
            <div key={i} className="flex items-start gap-2 text-xs py-1.5 px-2 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
              <span className={`flex-shrink-0 mt-0.5 leading-none ${e.interaction_type === "meeting" ? "text-purple-500" : e.direction === "inbound" ? "text-blue-500" : "text-emerald-500"}`}>
                {e.interaction_type === "meeting" ? "◎" : e.direction === "inbound" ? "↙" : "↗"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  {e.contact_name && <span className="font-medium text-zinc-700 dark:text-zinc-300 text-[11px]">{e.contact_name}</span>}
                  {e.subject && <span className="text-zinc-500 dark:text-zinc-400 truncate">{e.subject}</span>}
                </div>
                {e.content_preview && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">{e.content_preview}</p>}
              </div>
              <span className="flex-shrink-0 text-[10px] text-zinc-300 dark:text-zinc-600 whitespace-nowrap">
                {daysAgo === 0 ? "Today" : daysAgo === 1 ? "Yesterday" : `${daysAgo}d ago`}
              </span>
            </div>
          );
        })}
        {emailsDesc.length > 5 && (
          <button onClick={() => setEmailsOpen(o => !o)}
            className="w-full text-left text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 px-2 py-1 transition-colors">
            {emailsOpen ? "Show less" : `Show all ${emailsDesc.length} emails`}
          </button>
        )}
      </div>

      {/* AI phases */}
      {phases.length > 0 && (
        <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3">
          <p className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-2">AI Analysis</p>
          <div className="space-y-2.5">
            {phases.map((phase, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-1.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{phase.title}</span>
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                      {fmtDate(phase.start_date)}{phase.end_date && phase.end_date !== phase.start_date ? ` – ${fmtDate(phase.end_date)}` : ""}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed mt-0.5">{phase.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contact timeline (Gantt) */}
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-3">
        <button onClick={() => setGanttOpen(o => !o)}
          className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">
          <svg className={`w-3 h-3 transition-transform ${ganttOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          {ganttOpen ? "Hide" : "Show"} contact timeline
        </button>
        {ganttOpen && <div className="mt-3"><GanttTimeline emails={emailsAsc} project={project} /></div>}
      </div>
    </div>
  );
}

function DocumentsSection({ project }: { project: Project }) {
  const docMilestones = (project.milestones ?? []).filter(m => m.document_deliverable);
  if (docMilestones.length === 0) return null;
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader title="Document Deliverables" count={docMilestones.length} />
      <div className="space-y-1.5">
        {docMilestones.map(m => (
          <div key={m.milestone_id} className="flex items-center gap-2 text-xs py-1">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${m.status === "complete" ? "bg-green-500" : m.status === "in_progress" ? "bg-blue-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
            <span className={`flex-1 ${m.status === "complete" ? "line-through text-zinc-400" : "text-zinc-700 dark:text-zinc-300"}`}>{m.title}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${MILESTONE_STATUS_COLORS[m.status] ?? ""}`}>{m.status.replace("_"," ")}</span>
            {m.due_date && <span className="text-zinc-400 dark:text-zinc-500">{fmtDate(m.due_date)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanyInfoSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const [generating, setGenerating] = useState(false);
  const [localDesc, setLocalDesc] = useState(project.company_description ?? "");
  const [localEsg, setLocalEsg] = useState(project.esg_url ?? "");
  const [localLeadSource, setLocalLeadSource] = useState(project.lead_source ?? "");
  const [customLeadSource, setCustomLeadSource] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [showContactAdd, setShowContactAdd] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ contact_id: string; name: string; organization: string | null }>>([]);
  const [searching, setSearching] = useState(false);
  const [addingRole, setAddingRole] = useState("stakeholder");
  const [pendingContact, setPendingContact] = useState<{ contact_id: string; name: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const contacts = project.project_contacts ?? [];
  const ROLES = ["stakeholder", "sponsor", "technical", "legal", "finance", "executive", "other"];
  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/proxy/projects/${project.project_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    onUpdate();
  }
  async function generate() {
    setGenerating(true);
    try {
      const r = await fetch(`/api/proxy/projects/${project.project_id}/generate-company-info`, { method: "POST" });
      if (r.ok) { const d = await r.json(); setLocalDesc(d.description ?? ""); setLocalEsg(d.esg_url ?? ""); onUpdate(); }
    } finally { setGenerating(false); }
  }
  async function searchContacts(q: string) {
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(q)}&limit=20`);
    if (r.ok) { const data = await r.json(); setSearchResults((data.contacts ?? data).map((c: Record<string, unknown>) => ({ contact_id: c.contact_id, name: c.name, organization: c.organization ?? c.company ?? null }))); }
    setSearching(false);
  }
  async function addContact() {
    if (!pendingContact) return;
    await fetch(`/api/proxy/projects/${project.project_id}/contacts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact_id: pendingContact.contact_id, role: addingRole, is_primary: contacts.length === 0 }) });
    setPendingContact(null); setContactSearch(""); setSearchResults([]); setAddingRole("stakeholder"); setShowContactAdd(false); onUpdate();
  }
  async function removeContact(contactId: string) {
    await fetch(`/api/proxy/projects/${project.project_id}/contacts/${contactId}`, { method: "DELETE" });
    setConfirmRemove(null); onUpdate();
  }
  async function setPrimary(contactId: string) {
    await fetch(`/api/proxy/projects/${project.project_id}/contacts/${contactId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_primary: true }) });
    onUpdate();
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-4">
      <SectionHeader title="Organization Info" action={
        <button onClick={generate} disabled={generating} className="text-xs text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 flex items-center gap-1 transition-colors">
          {generating ? (<><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg> Generating…</>) : (localDesc ? "↺ Regenerate" : "✦ Generate")}
        </button>
      } />
      <div>
        {editingDesc ? (
          <AutoTextarea autoFocus value={localDesc} onChange={e => setLocalDesc(e.target.value)} onBlur={() => { setEditingDesc(false); patch({ company_description: localDesc || null }); }} rows={3}
            className="w-full text-xs text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        ) : localDesc ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed cursor-text hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors" onClick={() => setEditingDesc(true)}>{localDesc}</p>
        ) : (
          <p className="text-xs text-zinc-300 dark:text-zinc-600 italic cursor-pointer hover:text-zinc-500 dark:hover:text-zinc-400" onClick={() => setEditingDesc(true)}>No company description — click Generate or click to write one</p>
        )}
      </div>
      {(localEsg || editingDesc) && (
        <div className="flex items-center gap-1.5">
          <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"/></svg>
          {localEsg ? <a href={localEsg} target="_blank" rel="noopener noreferrer" className="text-xs text-green-600 dark:text-green-400 hover:underline truncate">{localEsg}</a> : <span className="text-xs text-zinc-300 dark:text-zinc-600 italic">No ESG/sustainability page found</span>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide w-20 shrink-0">Lead Source</label>
        {customLeadSource ? (
          <input autoFocus value={localLeadSource} onChange={e => setLocalLeadSource(e.target.value)}
            onBlur={() => { patch({ lead_source: localLeadSource || null }); if (!localLeadSource) setCustomLeadSource(false); }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setCustomLeadSource(false); setLocalLeadSource(project.lead_source ?? ""); } }}
            placeholder="Type lead source…" className="flex-1 text-xs px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
        ) : (
          <div className="flex-1 flex items-center gap-1">
            <select value={LEAD_SOURCES.includes(localLeadSource) ? localLeadSource : (localLeadSource ? "__custom__" : "")}
              onChange={e => { if (e.target.value === "__custom__") setCustomLeadSource(true); else { setLocalLeadSource(e.target.value); patch({ lead_source: e.target.value || null }); } }}
              className={SEL_XS + " flex-1"}>
              <option value="">— Not set —</option>
              {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              {localLeadSource && !LEAD_SOURCES.includes(localLeadSource) && <option value="__custom__">{localLeadSource}</option>}
              <option value="__custom__">+ Custom…</option>
            </select>
            {localLeadSource && !LEAD_SOURCES.includes(localLeadSource) && <button onClick={() => setCustomLeadSource(true)} className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 whitespace-nowrap">Edit</button>}
          </div>
        )}
      </div>
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">Contacts <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded">{contacts.length}</span></span>
          <button onClick={() => { setShowContactAdd(true); setContactSearch(""); setPendingContact(null); setSearchResults([]); }} className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">+ Add</button>
        </div>
        {showContactAdd && (
          <div className="mb-3 space-y-2">
            {!pendingContact ? (
              <>
                <div className="relative">
                  <input autoFocus value={contactSearch} onChange={e => { setContactSearch(e.target.value); searchContacts(e.target.value); }} placeholder="Search contacts…"
                    className="w-full text-xs px-2.5 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 placeholder-zinc-400" />
                  {searching && <span className="absolute right-2 top-1.5 text-[10px] text-zinc-400">…</span>}
                </div>
                {searchResults.length > 0 && (
                  <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden divide-y divide-zinc-100 dark:divide-zinc-800 max-h-40 overflow-y-auto">
                    {searchResults.map(c => (
                      <button key={c.contact_id} onClick={() => { setPendingContact(c); setContactSearch(""); setSearchResults([]); }} className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                        <span className="font-medium text-zinc-800 dark:text-zinc-200">{c.name}</span>
                        {c.organization && <span className="text-zinc-400 ml-1.5">· {c.organization}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => { setShowContactAdd(false); setContactSearch(""); setSearchResults([]); }} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Cancel</button>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-zinc-700 dark:text-zinc-300 font-medium">{pendingContact.name}</p>
                <select value={addingRole} onChange={e => setAddingRole(e.target.value)} className={SEL_XS + " w-full"}>{ROLES.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}</select>
                <div className="flex gap-2">
                  <button onClick={addContact} className="flex-1 text-xs py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium">Link Contact</button>
                  <button onClick={() => { setPendingContact(null); setContactSearch(""); setShowContactAdd(false); }} className="px-3 text-xs py-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
        {contacts.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No contacts linked.</p>
        ) : (
          <div className="space-y-2">
            {contacts.map(c => (
              <div key={c.id} className="flex items-center gap-2 group/contact">
                <Avatar name={c.name} url={c.avatar_url} size={7} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Link href={`/contacts/${c.contact_id}`} className="text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 truncate">{c.name}</Link>
                    {c.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Primary</span>}
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 capitalize">{c.role}</span>
                  </div>
                  {(c.title || c.organization) && <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{[c.title, c.organization].filter(Boolean).join(" · ")}</p>}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover/contact:opacity-100 transition-opacity">
                  {c.email && <a href={`mailto:${c.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Email</a>}
                  {!c.is_primary && <button onClick={() => setPrimary(c.contact_id)} className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 px-1">Set Primary</button>}
                  {confirmRemove === c.contact_id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => removeContact(c.contact_id)} className="text-[10px] px-1.5 py-0.5 bg-red-600 text-white rounded font-medium">Remove</button>
                      <button onClick={() => setConfirmRemove(null)} className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmRemove(c.contact_id)} className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 px-1">✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectLeadSection({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const [users, setUsers] = useState<Array<{ user_id: string; name: string; email: string }>>([]);
  const [selecting, setSelecting] = useState(false);
  async function loadUsers() { const r = await fetch("/api/proxy/tasks/users"); if (r.ok) setUsers(await r.json()); }
  async function assign(userId: string | null) {
    await fetch(`/api/proxy/projects/${project.project_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assigned_to: userId }) });
    setSelecting(false); onUpdate();
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Project Lead</h3>
        <button onClick={() => { loadUsers(); setSelecting(s => !s); }} className="text-xs text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
          {selecting ? "Cancel" : project.assigned_to ? "Change" : "+ Assign"}
        </button>
      </div>
      {selecting ? (
        <div className="space-y-1">
          <button onClick={() => assign(null)} className="w-full text-left px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg transition-colors">— Unassign</button>
          {users.map(u => (
            <button key={u.user_id} onClick={() => assign(u.user_id)}
              className={`w-full text-left px-2 py-1.5 text-xs rounded-lg transition-colors flex items-center gap-2 ${u.user_id === project.assigned_to ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium" : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}>
              <Avatar name={u.name} url={null} size={5} />
              <span className="flex-1 truncate">{u.name}</span>
              {u.user_id === project.assigned_to && <span className="text-[10px] text-blue-500">Current</span>}
            </button>
          ))}
        </div>
      ) : project.assigned_to_name ? (
        <div className="flex items-center gap-2">
          <Avatar name={project.assigned_to_name} url={null} size={7} />
          <div><p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{project.assigned_to_name}</p><p className="text-[11px] text-zinc-400 dark:text-zinc-500">Project Lead</p></div>
        </div>
      ) : (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">No project lead assigned.</p>
      )}
    </div>
  );
}

function InfoPanel({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  async function patch(fields: Record<string, unknown>) {
    await fetch(`/api/proxy/projects/${project.project_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    onUpdate();
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3">
      <div className="flex items-center gap-4">
        <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide shrink-0">Revenue</span>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Projected</span>
            <MoneyField value={project.expected_revenue} onSave={v => patch({ expected_revenue: v })} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">To date</span>
            <MoneyField value={project.revenue_to_date} onSave={v => patch({ revenue_to_date: v })} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RelatedProjectsPanel({ projectId, contactId }: { projectId: string; contactId: string }) {
  const [related, setRelated] = useState<Array<{ project_id: string; name: string; stage: string | null; status: string; expected_revenue: number | null }>>([]);
  useEffect(() => { fetch(`/api/proxy/projects/${projectId}/related`).then(r => r.ok ? r.json() : []).then(setRelated); }, [projectId]);
  if (related.length === 0) return null;
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
      <SectionHeader title="Related Projects" count={related.length} />
      <div className="space-y-1.5">
        {related.map(p => (
          <Link key={p.project_id} href={`/projects/${p.project_id}`} className="flex items-center gap-2 text-xs py-1 hover:text-blue-600 dark:hover:text-blue-400 group">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.status === "active" ? "bg-green-500" : "bg-zinc-300"}`} />
            <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300 group-hover:text-blue-600 dark:group-hover:text-blue-400">{p.name}</span>
            {p.stage && <span className="text-zinc-400 dark:text-zinc-500">{p.stage}</span>}
            {p.expected_revenue && <span className="font-mono text-zinc-400 dark:text-zinc-500">{fmtCurrency(p.expected_revenue)}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

function LinkedInvestorSection({ investorId }: { investorId: string }) {
  const [inv, setInv] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    fetch(`/api/proxy/dilutive/${investorId}`)
      .then(r => r.ok ? r.json() : null)
      .then(setInv);
  }, [investorId]);
  if (!inv) return null;

  function Row({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
      <div className="flex gap-2 text-xs">
        <span className="text-zinc-400 dark:text-zinc-500 w-28 flex-shrink-0">{label}</span>
        <span className="text-zinc-700 dark:text-zinc-300 flex-1">{value}</span>
      </div>
    );
  }

  const checkRange = [inv.check_size_min, inv.check_size_max].filter(Boolean).join(" – ");

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Investor Profile</h3>
        <a href={`/funding?tab=dilutive`}
          className="text-[11px] text-zinc-400 hover:text-blue-500 transition-colors">View in Funding →</a>
      </div>
      {inv.description && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed pb-1">{inv.description}</p>
      )}
      <div className="space-y-1.5">
        <Row label="Firm type" value={inv.firm_type} />
        <Row label="Focus" value={inv.focus} />
        <Row label="Stage" value={inv.investment_stage} />
        <Row label="Check size" value={checkRange || inv.avg_check_size} />
        <Row label="Fund size" value={inv.fund_size} />
        <Row label="Geography" value={inv.geo_focus} />
        <Row label="HQ" value={inv.hq} />
        <Row label="Fund launch" value={inv.fund_launch_year} />
        <Row label="Partners" value={inv.partners} />
        <Row label="Intro type" value={inv.intro_type} />
        <Row label="Intro notes" value={inv.intro_notes} />
      </div>
      {(inv.website || inv.linkedin || inv.portfolio_url || inv.source_link) && (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
          {inv.website && <a href={inv.website} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline">Website</a>}
          {inv.linkedin && <a href={inv.linkedin} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline">LinkedIn</a>}
          {inv.portfolio_url && <a href={inv.portfolio_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline">Portfolio</a>}
          {inv.source_link && <a href={inv.source_link} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline">Source</a>}
        </div>
      )}
      {inv.portfolio?.length > 0 && (
        <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1">Portfolio</p>
          <div className="flex flex-wrap gap-1">
            {inv.portfolio.map((p: string, i: number) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded">{p}</span>
            ))}
          </div>
        </div>
      )}
      {inv.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {inv.tags.map((t: string, i: number) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 rounded border border-blue-100 dark:border-blue-900">{t}</span>
          ))}
        </div>
      )}
      {inv.enrichment_notes && (
        <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide mb-1">Enrichment Notes</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{inv.enrichment_notes}</p>
        </div>
      )}
    </div>
  );
}

function LinkedOpportunitySection({ opportunityId }: { opportunityId: string }) {
  const [opp, setOpp] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    fetch(`/api/proxy/funding?`)
      .then(r => r.ok ? r.json() : [])
      .then((list: any[]) => setOpp(list.find(o => o.opportunity_id === opportunityId) ?? null));
  }, [opportunityId]);
  if (!opp) return null;

  function Row({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
      <div className="flex gap-2 text-xs">
        <span className="text-zinc-400 dark:text-zinc-500 w-28 flex-shrink-0">{label}</span>
        <span className="text-zinc-700 dark:text-zinc-300 flex-1">{value}</span>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Grant / Funding Entry</h3>
        <a href="/funding?tab=non-dilutive" className="text-[11px] text-zinc-400 hover:text-blue-500 transition-colors">View in Funding →</a>
      </div>
      <div className="space-y-1.5">
        <Row label="Stage" value={opp.stage} />
        <Row label="Type" value={opp.funding_type} />
        <Row label="Amount" value={opp.amount} />
        <Row label="Deadline" value={opp.deadline} />
        <Row label="Decision date" value={opp.decision_date} />
        <Row label="Dispersion" value={opp.funding_dispersion} />
      </div>
      {opp.source_link && (
        <a href={opp.source_link} target="_blank" rel="noopener noreferrer"
          className="inline-block text-[11px] text-blue-500 hover:underline pt-1">Source link →</a>
      )}
      {opp.notes && (
        <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">{opp.notes}</p>
        </div>
      )}
      {opp.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {opp.tags.map((t: string, i: number) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 rounded border border-blue-100 dark:border-blue-900">{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedFundingBadge({ project, onLinked }: { project: Project; onLinked: () => void }) {
  const [linking, setLinking] = useState(false);
  const hasLink = !!(project.linked_opportunity_id || project.linked_investor_id);
  const sourceId = project.linked_opportunity_id || project.linked_investor_id;
  const sourceType = project.linked_opportunity_id ? "opportunity" : "investor";

  if (hasLink) {
    const href = project.linked_opportunity_id
      ? `/funding?tab=non-dilutive`
      : `/funding?tab=dilutive`;
    return (
      <a href={href}
        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 transition-colors">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
        </svg>
        Linked to Funding module
      </a>
    );
  }
  return null;
}

function ProjectBody({ project, load }: { project: Project; load: () => void }) {
  return (
    <>
      {project.project_type === "partnership"
        ? <PartnershipHeader project={project} onUpdate={load} />
        : <ProjectHeader project={project} onUpdate={load} />
      }
      {(project.linked_opportunity_id || project.linked_investor_id) && (
        <LinkedFundingBadge project={project} onLinked={load} />
      )}
      <StatusBar project={project} onUpdate={load} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <PlanSection projectId={project.project_id} projectName={project.name} />
          <WorkspaceBar projectId={project.project_id} />
          <FinancialSection project={project} onUpdate={load} />
          <ProjectTimeline project={project} />
          <DocumentsSection project={project} />
        </div>
        <div className="space-y-4">
          <ActiveTasksSection projectId={project.project_id} />
          {project.linked_investor_id && <LinkedInvestorSection investorId={project.linked_investor_id} />}
          {project.linked_opportunity_id && <LinkedOpportunitySection opportunityId={project.linked_opportunity_id} />}
          <CompanyInfoSection project={project} onUpdate={load} />
          <ProjectLeadSection project={project} onUpdate={load} />
          <StrategicPlanningSection projectId={project.project_id} onUpdate={load} />
          {project.contact_id && <RelatedProjectsPanel projectId={project.project_id} contactId={project.contact_id} />}
        </div>
      </div>
    </>
  );
}

export function ProjectDetailView({ id, onClose, backHref, onUpdate: onUpdateExternal }: { id: string; onClose?: () => void; backHref?: string; onUpdate?: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/projects/${id}`);
    if (r.ok) { setProject(await r.json()); setLoading(false); onUpdateExternal?.(); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  if (loading || !project) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-sm text-zinc-400 dark:text-zinc-500">Loading project…</div>
      </div>
    );
  }

  // Panel mode: onClose provided
  if (onClose) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <ProjectBody project={project} load={load} />
      </div>
    );
  }

  // Page mode: breadcrumb navigation
  const href = backHref ?? "/projects";
  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto space-y-4">
      <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
        <Link href={href} className="hover:text-zinc-700 dark:hover:text-zinc-300">Projects</Link>
        <span>/</span>
        <span className="text-zinc-700 dark:text-zinc-300 font-medium truncate">
          {project.project_type === "partnership" ? (project.contact_org || project.contact_name || project.name) : project.name}
        </span>
      </div>
      <ProjectBody project={project} load={load} />
    </div>
  );
}
