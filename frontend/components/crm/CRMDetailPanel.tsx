"use client";

import Link from "next/link";
import React, { useEffect, useState, useCallback } from "react";
import { CRM_STAGE_GROUPS, findGroup, allStages } from "@/lib/contractStages";
import { MilestonesSection } from "@/components/project/MilestonesSection";
import { ActiveTasksSection, ResourcesSection, StrategicPlanningSection, FundingAgentSection } from "@/components/project/ProjectSections";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

interface ActionItem {
  task_id: string;
  title: string;
  status: string;
  due_date: string | null;
  assigned_to_name: string | null;
  activity_type: string | null;
}

interface EmailActivity {
  interaction_type: string;
  subject: string | null;
  content_preview: string | null;
  occurred_at: string;
  direction: string | null;
}

interface ContactReminder {
  reminder_id: string;
  reminder_type: string;
  title: string;
  description: string | null;
  due_date: string | null;
  auto_generated: boolean;
}

interface RelatedProject {
  project_id: string;
  name: string;
  project_type: string;
  stage: string | null;
  status: string;
  crm_type: string | null;
  expected_revenue: number | null;
  date_deadline: string | null;
}

interface ProjectContact {
  id: string;
  contact_id: string;
  role: string;
  is_primary: boolean;
  name: string;
  email: string | null;
  organization: string | null;
  title: string | null;
  avatar_url: string | null;
}

interface Project {
  project_id: string;
  name: string;
  project_type: string;
  stage: string | null;
  status: string;
  crm_type: string | null;
  expected_revenue: number | null;
  date_start: string | null;
  date_deadline: string | null;
  tags: string[];
  notes: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_org: string | null;
  contact_avatar: string | null;
  contact_email: string | null;
  contact_title: string | null;
  contact_summary: string | null;
  ai_summary: string | null;
  ai_summary_generated_at: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  email_activity: EmailActivity[];
  contact_reminders: ContactReminder[];
  project_contacts: ProjectContact[];
}

interface TaskUser {
  user_id: string;
  name: string;
}

interface DriveFile {
  file_id: string;
  name: string;
  mime_type: string | null;
  web_view_link: string | null;
  modified_time: string | null;
  size_bytes: number | null;
  content_text: string | null;
}

type DriveInfo = {
  drive_folder_id: string | null;
  drive_folder_name: string | null;
  drive_synced_at: string | null;
  files: DriveFile[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CRM_STAGES = ["Lead", "Prospect", "Qualification", "Initial Assessment", "Contract Sent", "Closed Won", "Closed Lost"];

const STAGE_BADGE: Record<string, string> = {
  "Lead":               "bg-slate-100 text-slate-700 border border-slate-300 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-700/60",
  "Prospect":           "bg-blue-100 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:text-blue-300 dark:border-blue-700/60",
  "Qualification":      "bg-purple-100 text-purple-700 border border-purple-300 dark:bg-purple-900/50 dark:text-purple-300 dark:border-purple-700/60",
  "Initial Assessment": "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-700/60",
  "Contract Sent":      "bg-orange-100 text-orange-700 border border-orange-300 dark:bg-orange-900/50 dark:text-orange-300 dark:border-orange-700/60",
  "Closed Won":         "bg-green-100 text-green-700 border border-green-300 dark:bg-green-900/50 dark:text-green-300 dark:border-green-700/60",
  "Closed Lost":        "bg-red-100 text-red-700 border border-red-300 dark:bg-red-900/50 dark:text-red-400 dark:border-red-800/60",
};

const STAGE_DOT: Record<string, string> = {
  "Lead": "bg-slate-400", "Prospect": "bg-blue-500", "Qualification": "bg-purple-500",
  "Initial Assessment": "bg-amber-500", "Contract Sent": "bg-orange-500",
  "Closed Won": "bg-green-500", "Closed Lost": "bg-red-500",
};

const STAGE_STATUS: Record<string, string> = { "Closed Won": "won", "Closed Lost": "lost" };

const ACTIVITY_TYPES = [
  { value: "todo",     label: "To-do",    icon: "☑" },
  { value: "email",    label: "Email",    icon: "✉" },
  { value: "call",     label: "Call",     icon: "☎" },
  { value: "meeting",  label: "Meeting",  icon: "◷" },
  { value: "document", label: "Document", icon: "▤" },
];

const ACTIVITY_COLORS: Record<string, string> = {
  email:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  call:     "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  document: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  meeting:  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  todo:     "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const STATUS_COLORS: Record<string, string> = {
  active:    "bg-green-500", at_risk: "bg-yellow-500",
  off_track: "bg-red-500",   on_hold: "bg-gray-400",
  won:       "bg-blue-500",  inactive: "bg-gray-300 dark:bg-gray-600",
};

const TYPE_LABELS: Record<string, string> = {
  crm_opportunity: "CRM", poc: "POC", project: "Project",
  internal: "Internal", funding: "Funding",
};

const TYPE_COLORS: Record<string, string> = {
  crm_opportunity: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  poc:             "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  project:         "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  internal:        "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  funding:         "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

const CONTACT_ROLES = [
  "primary", "technical_liaison", "decision_maker",
  "billing", "legal", "advisor", "partner", "contact", "other",
];

const MIME_LABEL: Record<string, { label: string; color: string }> = {
  "application/vnd.google-apps.document":     { label: "Doc",    color: "text-blue-500" },
  "application/vnd.google-apps.spreadsheet":  { label: "Sheet",  color: "text-green-500" },
  "application/vnd.google-apps.presentation": { label: "Slides", color: "text-yellow-500" },
  "application/vnd.google-apps.folder":       { label: "Folder", color: "text-gray-400" },
  "application/pdf":                          { label: "PDF",    color: "text-red-400" },
  "text/plain":                               { label: "Text",   color: "text-gray-400" },
};

// ── Tag registry ──────────────────────────────────────────────────────────────

const tagColorRegistry: Record<string, string> = {};
function tagStyle(color: string) {
  return { backgroundColor: color + "22", color, borderColor: color + "55" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(d: string | null, withTime = false) {
  if (!d) return null;
  const date = new Date(d);
  if (withTime) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function initials(name: string) {
  return name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
}

function getRelatedTypeLabel(p: { project_type: string; crm_type: string | null }) {
  if (p.project_type === "crm_opportunity") return p.crm_type === "project" ? "Client" : "CRM";
  return TYPE_LABELS[p.project_type] ?? p.project_type;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const color = tagColorRegistry[tag.toLowerCase()] ?? "#6b7280";
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border font-medium" style={tagStyle(color)}>
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} className="opacity-60 hover:opacity-100 transition-opacity">
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  );
}

// ── AI Summary Card ───────────────────────────────────────────────────────────

function AISummaryCard({ projectId, summary, generatedAt, onUpdated }: {
  projectId: string;
  summary: string | null;
  generatedAt: string | null;
  onUpdated: (summary: string) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(summary ?? "");
  const [saving, setSaving] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/summary`, { method: "POST" });
      if (r.ok) { const d = await r.json(); onUpdated(d.summary); setEditText(d.summary); }
    } finally { setGenerating(false); }
  }

  async function saveEdit() {
    setSaving(true);
    await fetch(`/api/proxy/projects/${projectId}/summary`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: editText }),
    });
    onUpdated(editText); setSaving(false); setEditing(false);
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-violet-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
          <h2 className="font-semibold text-sm text-gray-900 dark:text-gray-100">AI Summary</h2>
        </div>
        <div className="flex items-center gap-2">
          {summary && !editing && (
            <button onClick={() => { setEditText(summary); setEditing(true); }} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Edit</button>
          )}
          <button onClick={generate} disabled={generating}
            className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
              summary ? "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                      : "bg-violet-600 text-white hover:bg-violet-700"
            } disabled:opacity-50`}>
            {generating ? "Generating…" : summary ? "Regenerate" : "Generate"}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <AutoTextarea value={editText} onChange={e => setEditText(e.target.value)} rows={4}
            className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none focus:outline-none focus:ring-1 focus:ring-violet-500" />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
            <button onClick={saveEdit} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 font-medium">{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      ) : summary ? (
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{summary}</p>
          {generatedAt && <p className="text-[10px] text-gray-400 mt-2">Generated {timeAgo(generatedAt)}</p>}
        </div>
      ) : (
        <p className="text-xs text-gray-400 italic">Click Generate to create an AI summary of this project.</p>
      )}
    </div>
  );
}

// ── Related Projects Card ─────────────────────────────────────────────────────

function RelatedProjectsCard({ projectId }: { projectId: string }) {
  const [related, setRelated] = useState<RelatedProject[]>([]);
  useEffect(() => {
    fetch(`/api/proxy/projects/${projectId}/related`)
      .then(r => r.ok ? r.json() : []).then(setRelated);
  }, [projectId]);
  if (related.length === 0) return null;
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
      <h2 className="font-semibold text-sm text-gray-900 dark:text-gray-100 mb-3">Related</h2>
      <div className="space-y-2">
        {related.map(p => (
          <Link key={p.project_id} href={`/projects/${p.project_id}`}
            className="flex items-start gap-2 group hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg p-2 -mx-2 transition-colors">
            <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[p.status] ?? "bg-gray-400"}`} />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate">{p.name}</p>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_COLORS[p.project_type] ?? ""}`}>{getRelatedTypeLabel(p)}</span>
                {p.stage && <span className="text-[10px] text-gray-400">{p.stage}</span>}
                {p.expected_revenue && p.expected_revenue > 0 && <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">${p.expected_revenue.toLocaleString()}</span>}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── TaskGantt ─────────────────────────────────────────────────────────────────

function TaskGantt({ actionItems }: { actionItems: ActionItem[] }) {
  const tasks = actionItems.filter(t => t.due_date);
  if (tasks.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <p className="text-sm text-gray-400">No tasks with deadlines to display on the Gantt.</p>
      </div>
    );
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const taskDates = tasks.map(t => new Date(t.due_date! + "T00:00:00"));
  const allAnchors = [...taskDates, today];
  const rawMin = new Date(Math.min(...allAnchors.map(d => d.getTime())));
  const rawMax = new Date(Math.max(...allAnchors.map(d => d.getTime())));
  rawMin.setDate(rawMin.getDate() - 7); rawMax.setDate(rawMax.getDate() + 14);
  const totalMs = rawMax.getTime() - rawMin.getTime();
  function pct(d: Date) { return Math.max(0, Math.min(100, ((d.getTime() - rawMin.getTime()) / totalMs) * 100)); }
  const months: { label: string; left: number }[] = [];
  const cur = new Date(rawMin); cur.setDate(1);
  while (cur <= rawMax) { months.push({ label: cur.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), left: pct(cur) }); cur.setMonth(cur.getMonth() + 1); }
  const todayPct = pct(today);
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <div className="flex border-b border-gray-200 dark:border-gray-800">
        <div className="w-44 flex-shrink-0 px-4 py-2.5 border-r border-gray-200 dark:border-gray-800">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Task</span>
        </div>
        <div className="flex-1 relative h-9">
          {months.map((m, i) => (
            <div key={i} className="absolute top-0 h-full flex items-center" style={{ left: `${m.left}%` }}>
              <div className="h-full border-l border-gray-100 dark:border-gray-800" />
              <span className="text-[10px] text-gray-400 ml-1 whitespace-nowrap">{m.label}</span>
            </div>
          ))}
          {todayPct >= 0 && todayPct <= 100 && (
            <div className="absolute top-0 bottom-0 w-px bg-blue-500/60" style={{ left: `${todayPct}%` }}>
              <span className="absolute top-0 -translate-x-1/2 text-[9px] text-blue-500 font-semibold">today</span>
            </div>
          )}
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {tasks.map(task => {
          const deadline = new Date(task.due_date! + "T00:00:00");
          const deadlinePct = pct(deadline);
          const isDone = task.status === "done";
          const overdue = !isDone && deadline < today;
          const barColor = isDone ? "bg-green-500" : overdue ? "bg-red-500" : "bg-blue-500";
          const barStart = isDone ? deadlinePct : Math.min(pct(today), deadlinePct);
          const barWidth = Math.max(deadlinePct - barStart, 0.8);
          return (
            <div key={task.task_id} className="flex items-center hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
              <div className="w-44 flex-shrink-0 px-4 py-2.5 border-r border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isDone ? "bg-green-500" : overdue ? "bg-red-500" : "bg-gray-400"}`} />
                  <span className={`text-xs truncate ${isDone ? "line-through text-gray-400" : "text-gray-800 dark:text-gray-100"}`}>{task.title}</span>
                </div>
              </div>
              <div className="flex-1 relative h-10 px-1">
                {months.map((m, i) => <div key={i} className="absolute top-0 bottom-0 border-l border-gray-100 dark:border-gray-800/60" style={{ left: `${m.left}%` }} />)}
                {todayPct >= 0 && todayPct <= 100 && <div className="absolute top-0 bottom-0 w-px bg-blue-400/30" style={{ left: `${todayPct}%` }} />}
                <div className={`absolute top-1/2 -translate-y-1/2 h-5 rounded ${barColor} opacity-80`}
                  style={{ left: `${barStart}%`, width: `${barWidth}%` }} title={`Due: ${fmt(task.due_date)}`} />
                <div className={`absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full border-2 border-white dark:border-gray-900 ${isDone ? "bg-green-500" : overdue ? "bg-red-500" : "bg-blue-600"}`}
                  style={{ left: `calc(${deadlinePct}% - 4px)` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-2 text-[10px] text-gray-400 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30 flex items-center gap-4">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />Done</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />In progress</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />Overdue</span>
      </div>
    </div>
  );
}

// ── DriveIcon ─────────────────────────────────────────────────────────────────

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

// ── DrivePanel ────────────────────────────────────────────────────────────────

function DrivePanel(props: {
  projectId: string;
  driveInfo: DriveInfo | null; driveLoading: boolean; driveError: string | null;
  driveLinkInput: string; setDriveLinkInput: (v: string) => void; driveLinking: boolean;
  driveSyncing: boolean; driveCreating: boolean;
  driveNewName: string; setDriveNewName: (v: string) => void;
  driveNewType: "doc" | "sheet" | "slide"; setDriveNewType: (v: "doc" | "sheet" | "slide") => void;
  driveShowCreate: boolean; setDriveShowCreate: (v: boolean) => void;
  drivePreview: DriveFile | null; setDrivePreview: (v: DriveFile | null) => void;
  onLink: (e: React.SyntheticEvent) => void; onSync: () => void;
  onCreate: (e: React.SyntheticEvent) => void; onPreview: (f: DriveFile) => void; onUnlink: () => void;
}) {
  const { driveInfo, driveLoading, driveError, driveLinkInput, setDriveLinkInput, driveLinking,
    driveSyncing, driveCreating, driveNewName, setDriveNewName, driveNewType, setDriveNewType,
    driveShowCreate, setDriveShowCreate, drivePreview, setDrivePreview,
    onLink, onSync, onCreate, onPreview, onUnlink } = props;

  if (driveLoading) return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
      <p className="text-sm text-gray-400">Loading Drive…</p>
    </div>
  );

  if (driveError === "no_google_token" || driveError === "needs_drive_scope") return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center space-y-3">
      <DriveIcon className="w-8 h-8 text-gray-300 dark:text-gray-600 mx-auto" />
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {driveError === "no_google_token" ? "Google account not connected." : "Drive access not enabled."}
      </p>
      <p className="text-xs text-gray-400">Go to <strong>Contacts → Google</strong> and re-connect your Google account to enable Drive.</p>
    </div>
  );

  if (!driveInfo?.drive_folder_id) return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-4">
      <div className="flex items-center gap-2">
        <DriveIcon className="w-5 h-5 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Link a Drive Folder</h2>
      </div>
      <p className="text-xs text-gray-400 leading-relaxed">Paste the URL of a Google Drive folder to index files for this project.</p>
      <form onSubmit={onLink} className="flex gap-2">
        <input type="text" placeholder="https://drive.google.com/drive/folders/…"
          value={driveLinkInput} onChange={e => setDriveLinkInput(e.target.value)}
          className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        <button type="submit" disabled={!driveLinkInput.trim() || driveLinking}
          className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
          {driveLinking ? "Linking…" : "Link"}
        </button>
      </form>
      {driveError && driveError !== "no_google_token" && driveError !== "needs_drive_scope" && (
        <p className="text-xs text-red-500">Failed to link folder. Check the URL and Drive permissions.</p>
      )}
    </div>
  );

  const files = driveInfo.files ?? [];
  const exportable = ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"];

  return (
    <div className="space-y-3">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <DriveIcon className="w-4 h-4 text-blue-500 shrink-0" />
          <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{driveInfo.drive_folder_name ?? driveInfo.drive_folder_id}</p>
          {driveInfo.drive_synced_at && <span className="text-[10px] text-gray-400 shrink-0">synced {timeAgo(driveInfo.drive_synced_at)}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onSync} disabled={driveSyncing} className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40">{driveSyncing ? "Syncing…" : "Sync"}</button>
          <button onClick={onUnlink} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Unlink</button>
        </div>
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
        {driveShowCreate ? (
          <form onSubmit={onCreate} className="px-4 py-3 flex items-center gap-2 flex-wrap">
            <input type="text" placeholder="File name…" value={driveNewName} onChange={e => setDriveNewName(e.target.value)} autoFocus
              className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-32" />
            <select value={driveNewType} onChange={e => setDriveNewType(e.target.value as "doc" | "sheet" | "slide")}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none">
              <option value="doc">Doc</option><option value="sheet">Sheet</option><option value="slide">Slides</option>
            </select>
            <button type="submit" disabled={!driveNewName.trim() || driveCreating}
              className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
              {driveCreating ? "Creating…" : "Create"}
            </button>
            <button type="button" onClick={() => setDriveShowCreate(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </form>
        ) : (
          <button onClick={() => setDriveShowCreate(true)}
            className="w-full px-4 py-2.5 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors rounded-xl">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
            New file in this folder
          </button>
        )}
      </div>
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
        {files.length === 0 ? (
          <p className="px-4 py-8 text-sm text-gray-400 text-center">No files in this folder yet.</p>
        ) : files.map(f => {
          const m = MIME_LABEL[f.mime_type ?? ""] ?? { label: "File", color: "text-gray-400" };
          const canPreview = exportable.includes(f.mime_type ?? "");
          return (
            <div key={f.file_id} className="px-4 py-2.5 flex items-center gap-3 group">
              <span className={`text-[10px] font-bold uppercase tracking-wide w-8 shrink-0 ${m.color}`}>{m.label}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 dark:text-gray-100 truncate">{f.name}</p>
                {f.modified_time && <p className="text-[10px] text-gray-400">{timeAgo(f.modified_time)}</p>}
              </div>
              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {canPreview && <button onClick={() => onPreview(f)} className="text-xs text-gray-500 hover:text-blue-600 dark:hover:text-blue-400">Read</button>}
                {f.web_view_link && <a href={f.web_view_link} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-500 hover:text-blue-600 dark:hover:text-blue-400">Open ↗</a>}
              </div>
            </div>
          );
        })}
      </div>
      {drivePreview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
          onClick={e => { if (e.target === e.currentTarget) setDrivePreview(null); }}>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{drivePreview.name}</p>
              <div className="flex items-center gap-3 shrink-0">
                {drivePreview.web_view_link && <a href={drivePreview.web_view_link} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Open in Drive ↗</a>}
                <button onClick={() => setDrivePreview(null)} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {drivePreview.content_text ? (
                <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed font-sans">{drivePreview.content_text}</pre>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">Loading content…</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PortalTab ─────────────────────────────────────────────────────────────────

function PortalTab({ projectId, portalInfo, portalLoading, portalCreating, portalCopied, setPortalCopied, onCreatePortal, onRevokePortal }: {
  projectId: string;
  portalInfo: { portal_id: string; token: string; is_password_protected: boolean; portal_drive_folder_id: string | null; portal_drive_folder_name: string | null } | null;
  portalLoading: boolean; portalCreating: boolean; portalCopied: boolean;
  setPortalCopied: (v: boolean) => void; onCreatePortal: () => void; onRevokePortal: () => void;
}) {
  if (portalLoading) return <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center"><p className="text-sm text-gray-400">Loading…</p></div>;
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
            </svg>
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Client Portal</span>
          </div>
          {portalInfo ? (
            <div className="flex items-center gap-2">
              <button onClick={() => { const url = `${window.location.origin}/portal/${portalInfo.token}`; navigator.clipboard.writeText(url).then(() => { setPortalCopied(true); setTimeout(() => setPortalCopied(false), 2000); }); }}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{portalCopied ? "Copied!" : "Copy link"}</button>
              <a href={`/portal/${portalInfo.token}`} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Preview ↗</a>
              <button onClick={onRevokePortal} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Revoke</button>
            </div>
          ) : (
            <button onClick={onCreatePortal} disabled={portalCreating}
              className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
              {portalCreating ? "Creating…" : "Generate link"}
            </button>
          )}
        </div>
        {portalInfo && <p className="text-[11px] text-gray-400 truncate font-mono">{typeof window !== "undefined" ? `${window.location.origin}/portal/${portalInfo.token}` : ""}</p>}
      </div>
      {portalInfo && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Portal settings</p>
            <p className="text-xs text-gray-400">Manage description, contacts, updates, password protection, and activity.</p>
          </div>
          <a href={`/portals/${projectId}`} className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium">Manage →</a>
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export default function CRMDetailPanel({
  projectId,
  contractType,
  onClose,
  onUpdated,
}: {
  projectId: string;
  contractType?: "rd_contract" | "portfolio_contract";
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  // Tasks (action items — still used by Gantt tab)
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [users, setUsers] = useState<TaskUser[]>([]);
  const [showAllEmails, setShowAllEmails] = useState(false);

  // Stage movement
  const [inactiveReason, setInactiveReason] = useState("");
  const [pendingInactive, setPendingInactive] = useState(false);

  // Title editing
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleText, setTitleText] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);

  // Notes editing
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);

  // Tags editing
  const [tagsEditing, setTagsEditing] = useState(false);
  const [tagsList, setTagsList] = useState<string[]>([]);
  const [tagsInput, setTagsInput] = useState("");
  const [tagsSaving, setTagsSaving] = useState(false);

  // Drive
  const [driveInfo, setDriveInfo] = useState<DriveInfo | null>(null);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveLinkInput, setDriveLinkInput] = useState("");
  const [driveLinking, setDriveLinking] = useState(false);
  const [driveSyncing, setDriveSyncing] = useState(false);
  const [driveCreating, setDriveCreating] = useState(false);
  const [driveNewName, setDriveNewName] = useState("");
  const [driveNewType, setDriveNewType] = useState<"doc" | "sheet" | "slide">("doc");
  const [driveShowCreate, setDriveShowCreate] = useState(false);
  const [drivePreview, setDrivePreview] = useState<DriveFile | null>(null);

  // Portal
  const [portalInfo, setPortalInfo] = useState<{
    portal_id: string; token: string;
    portal_drive_folder_id: string | null; portal_drive_folder_name: string | null;
    is_password_protected: boolean;
  } | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalCreating, setPortalCreating] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);

  // Contacts
  const [showContactModal, setShowContactModal] = useState(false);
  const [contactModalRole, setContactModalRole] = useState("contact");
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<{ contact_id: string; name: string; email: string | null; organization: string | null }[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactLinking, setContactLinking] = useState(false);
  const [removingContact, setRemovingContact] = useState<string | null>(null);
  const [editingContactRole, setEditingContactRole] = useState<string | null>(null);
  const [editRoleValue, setEditRoleValue] = useState("");

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/projects/${projectId}`);
    if (r.ok) setProject(await r.json());
    setLoading(false);
  }, [projectId]);

  const loadActionItems = useCallback(async () => {
    const r = await fetch(`/api/proxy/tasks?project_id=${projectId}&limit=100`);
    if (r.ok) setActionItems(await r.json());
  }, [projectId]);

  const fetchDrive = useCallback(async () => {
    setDriveLoading(true); setDriveError(null);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/drive`);
      if (r.ok) setDriveInfo(await r.json());
      else {
        const d = await r.json().catch(() => ({}));
        const detail = d?.detail;
        setDriveError(typeof detail === "object" && detail?.code ? detail.code : "error");
      }
    } catch { setDriveError("error"); }
    finally { setDriveLoading(false); }
  }, [projectId]);

  const fetchPortal = useCallback(async () => {
    setPortalLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal`);
      if (r.ok) { const d = await r.json(); setPortalInfo(d.portal ?? null); }
    } catch { /* ignore */ }
    finally { setPortalLoading(false); }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    load();
    loadActionItems();
    fetch("/api/proxy/tasks/users").then(r => r.ok ? r.json() : []).then(setUsers).catch(() => {});
    fetch("/api/proxy/contacts/tags").then(r => r.ok ? r.json() : [])
      .then((tags: { name: string; color: string }[]) => { tags.forEach(t => { tagColorRegistry[t.name.toLowerCase()] = t.color; }); });
  }, [load, loadActionItems]);

  // Load drive and portal on mount (no longer tab-gated)
  useEffect(() => {
  }, [projectId]);

  useEffect(() => {
    fetchDrive(); fetchPortal();
  }, [fetchDrive, fetchPortal]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !showContactModal) onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, showContactModal]);

  // ── Mutations ───────────────────────────────────────────────────────────────

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/proxy/projects/${projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    load(); onUpdated();
  }

  async function moveStage(stage: string, reason?: string) {
    const statusForStage = stage === "Inactive" ? "inactive" : stage === "Active" ? "in_progress" : "in_progress";
    const body: Record<string, unknown> = { stage, status: statusForStage };
    if (stage === "Inactive" && reason) {
      const ts = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const note = `[Marked inactive ${ts}]: ${reason}`;
      body.notes = project?.notes ? `${note}\n\n${project.notes}` : note;
    }
    await patch(body);
    setPendingInactive(false); setInactiveReason("");
  }

  async function saveTitle() {
    const trimmed = titleText.trim();
    if (!trimmed) return;
    setTitleSaving(true);
    await fetch(`/api/proxy/projects/${projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setProject(p => p ? { ...p, name: trimmed } : p);
    setTitleSaving(false); setTitleEditing(false); onUpdated();
  }

  async function saveNotes() {
    setNotesSaving(true);
    await fetch(`/api/proxy/projects/${projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notesText || null }),
    });
    setProject(p => p ? { ...p, notes: notesText || null } : p);
    setNotesSaving(false); setNotesEditing(false); onUpdated();
  }

  async function saveTags() {
    setTagsSaving(true);
    await fetch(`/api/proxy/projects/${projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: tagsList }),
    });
    setProject(p => p ? { ...p, tags: tagsList } : p);
    setTagsSaving(false); setTagsEditing(false);
  }

  async function resolveReminder(reminderId: string) {
    await fetch(`/api/proxy/projects/${projectId}/reminders/${reminderId}/resolve`, { method: "PATCH" });
    load();
  }

  // Drive actions
  async function driveLink(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!driveLinkInput.trim()) return;
    setDriveLinking(true); setDriveError(null);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/link`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_url: driveLinkInput.trim() }),
    });
    if (r.ok) { setDriveLinkInput(""); fetchDrive(); }
    else {
      const d = await r.json().catch(() => ({}));
      const detail = d?.detail;
      setDriveError(typeof detail === "object" ? detail?.code ?? "error" : "error");
    }
    setDriveLinking(false);
  }

  async function driveSync() {
    setDriveSyncing(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/sync`, { method: "POST" });
    if (r.ok) fetchDrive();
    setDriveSyncing(false);
  }

  async function driveCreate(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!driveNewName.trim()) return;
    setDriveCreating(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/create`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: driveNewName.trim(), file_type: driveNewType }),
    });
    if (r.ok) {
      const f = await r.json();
      if (f.webViewLink) window.open(f.webViewLink, "_blank");
      setDriveNewName(""); setDriveShowCreate(false); fetchDrive();
    }
    setDriveCreating(false);
  }

  async function fetchPreview(file: DriveFile) {
    if (file.content_text) { setDrivePreview(file); return; }
    const r = await fetch(`/api/proxy/projects/${projectId}/drive/files/${file.file_id}`);
    if (r.ok) setDrivePreview(await r.json());
  }

  // Portal actions
  async function createPortal() {
    setPortalCreating(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "POST" });
    if (r.ok) fetchPortal();
    setPortalCreating(false);
  }

  // Contact actions
  async function searchContacts(q: string) {
    setContactQuery(q);
    if (!q.trim()) { setContactResults([]); return; }
    setContactSearching(true);
    try {
      const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(q)}&include_archived=false`);
      const data = r.ok ? await r.json() : [];
      setContactResults((data.contacts ?? data).slice(0, 8));
    } catch { setContactResults([]); }
    finally { setContactSearching(false); }
  }

  async function linkContact(contactId: string) {
    setContactLinking(true);
    const isPrimary = (project?.project_contacts ?? []).length === 0;
    const r = await fetch(`/api/proxy/projects/${projectId}/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, role: contactModalRole, is_primary: isPrimary }),
    });
    if (r.ok) { setShowContactModal(false); setContactQuery(""); setContactResults([]); setContactModalRole("contact"); load(); }
    setContactLinking(false);
  }

  async function createAndLinkContact() {
    if (!contactQuery.trim()) return;
    setContactLinking(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/link-contact`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: contactQuery.trim() }),
    });
    if (r.ok) { setShowContactModal(false); setContactQuery(""); setContactResults([]); load(); }
    setContactLinking(false);
  }

  async function removeProjectContact(contactId: string) {
    setRemovingContact(contactId);
    await fetch(`/api/proxy/projects/${projectId}/contacts/${contactId}`, { method: "DELETE" });
    setRemovingContact(null); load();
  }

  async function saveContactRole(contactId: string, role: string) {
    await fetch(`/api/proxy/projects/${projectId}/contacts/${contactId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setEditingContactRole(null); load();
  }

  async function setContactAsPrimary(contactId: string) {
    await fetch(`/api/proxy/projects/${projectId}/contacts/${contactId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_primary: true }),
    });
    load();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading || !project) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
        <div className="fixed top-0 right-0 bottom-0 z-50 w-[90vw] max-w-5xl bg-white dark:bg-[#141824] shadow-2xl flex items-center justify-center">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      </>
    );
  }

  // R&D and Portfolio contracts share one unified sales pipeline.
  const activeStageGroups = CRM_STAGE_GROUPS;
  const activeStages = allStages(activeStageGroups);
  const defaultStage = activeStageGroups[0]?.stages[0] ?? "Prospect";
  const stage = project.stage ?? defaultStage;
  const currentGroup = findGroup(stage, activeStageGroups);

  const emails = project.email_activity ?? [];
  const visibleEmails = showAllEmails ? emails : emails.slice(0, 5);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed top-0 right-0 bottom-0 z-50 w-[90vw] max-w-5xl bg-white dark:bg-zinc-900 shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <div className="flex-1 min-w-0">
            {titleEditing ? (
              <form onSubmit={e => { e.preventDefault(); saveTitle(); }} className="flex items-center gap-2">
                <input autoFocus value={titleText} onChange={e => setTitleText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Escape") setTitleEditing(false); }}
                  className="flex-1 text-base font-semibold bg-white dark:bg-white/5 border border-blue-400 rounded-lg px-2 py-0.5 text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0" />
                <button type="submit" disabled={!titleText.trim() || titleSaving}
                  className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded-lg disabled:opacity-50 font-medium flex-shrink-0">
                  {titleSaving ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => setTitleEditing(false)}
                  className="text-xs px-2.5 py-1 border border-zinc-200 dark:border-zinc-700 text-zinc-500 rounded-lg flex-shrink-0">Cancel</button>
              </form>
            ) : (
              <h2
                className="text-base font-semibold text-zinc-900 dark:text-white truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                onClick={() => { setTitleText(project.name); setTitleEditing(true); }}
                title="Click to rename"
              >
                {project.name}
              </h2>
            )}
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Link href={`/projects/${projectId}`}
                className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                Open full page →
              </Link>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 mt-0.5">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stage rail — matches StatusBar from project detail */}
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/30 shrink-0">
          <div className="flex flex-wrap items-center gap-3 mb-2.5">
            {/* Status dot + selector */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[project.status] ?? "bg-zinc-300"}`} />
              <select
                value={project.status}
                onChange={async e => {
                  await fetch(`/api/proxy/projects/${projectId}`, {
                    method: "PATCH", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: e.target.value }),
                  });
                  load(); onUpdated();
                }}
                className="text-xs bg-transparent border-0 outline-none text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                <option value="in_progress">In Progress</option>
                <option value="waiting_client">Awaiting Client</option>
                <option value="waiting_sbc">Awaiting Open ERP</option>
                <option value="awaiting_vendor">Awaiting Vendor</option>
                <option value="inactive">Inactive</option>
                <option value="won">Won</option>
              </select>
            </div>

            {/* Revenue */}
            {project.expected_revenue != null && project.expected_revenue > 0 && (
              <span className="text-xs font-semibold text-green-600 dark:text-green-400">
                ${project.expected_revenue.toLocaleString()}
              </span>
            )}

            {/* Deadline */}
            {project.date_deadline && (
              <span className={`text-xs font-medium ${new Date(project.date_deadline) < new Date() ? "text-red-500" : "text-zinc-500 dark:text-zinc-400"}`}>
                {new Date(project.date_deadline) < new Date() ? "Overdue · " : ""}{fmt(project.date_deadline)}
              </span>
            )}

            {/* Assigned to */}
            {project.assigned_to_name && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">Owner: {project.assigned_to_name}</span>
            )}
          </div>

          {/* Stage group rail */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 mr-1">Stage:</span>
            {activeStageGroups.map(group => {
              const isCurrentGroup = group.stages.includes(stage);
              return (
                <div key={group.parent} className="flex items-center gap-0.5">
                  {group.stages.length === 1 ? (
                    <button
                      onClick={() => moveStage(group.stages[0])}
                      className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                        isCurrentGroup
                          ? `${group.color.badge} font-medium`
                          : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                      }`}
                    >
                      {group.parent}
                    </button>
                  ) : (
                    <div className={`flex items-center gap-0.5 rounded border px-1 py-0.5 ${isCurrentGroup ? group.color.card : "border-zinc-200 dark:border-zinc-700"}`}>
                      <span className={`text-[10px] font-medium mr-0.5 ${isCurrentGroup ? group.color.header : "text-zinc-400"}`}>{group.parent}:</span>
                      {group.stages.map(s => (
                        <button
                          key={s}
                          onClick={() => s === "Inactive" ? setPendingInactive(true) : moveStage(s)}
                          className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                            s === stage
                              ? `${group.color.badge} font-medium`
                              : "hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-400"
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Inactive reason prompt */}
          {pendingInactive && (
            <div className="mt-2 space-y-1.5">
              <p className="text-xs text-zinc-500">Why is this being marked inactive?</p>
              <AutoTextarea value={inactiveReason} onChange={e => setInactiveReason(e.target.value)}
                rows={2} autoFocus placeholder="e.g. No budget this year…"
                className="w-full text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1.5 resize-none text-zinc-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <div className="flex gap-2">
                <button onClick={() => setPendingInactive(false)} className="text-xs px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded">Back</button>
                <button onClick={() => moveStage("Inactive", inactiveReason.trim() || undefined)} className="text-xs px-3 py-1 bg-zinc-600 text-white rounded">Mark Inactive</button>
              </div>
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* ── Left column (2/3) ────────────────────────────────────────── */}
              <div className="lg:col-span-2 space-y-4">

                {/* Milestones & Objectives */}
                <MilestonesSection projectId={projectId} projectType={project.project_type} />

                {/* Active Tasks */}
                <ActiveTasksSection projectId={projectId} />

                {/* Resources */}
                <ResourcesSection projectId={projectId} />

                {/* Google Drive */}
                <DrivePanel
                  projectId={projectId}
                  driveInfo={driveInfo} driveLoading={driveLoading} driveError={driveError}
                  driveLinkInput={driveLinkInput} setDriveLinkInput={setDriveLinkInput}
                  driveLinking={driveLinking} driveSyncing={driveSyncing} driveCreating={driveCreating}
                  driveNewName={driveNewName} setDriveNewName={setDriveNewName}
                  driveNewType={driveNewType} setDriveNewType={setDriveNewType}
                  driveShowCreate={driveShowCreate} setDriveShowCreate={setDriveShowCreate}
                  drivePreview={drivePreview} setDrivePreview={setDrivePreview}
                  onLink={driveLink} onSync={driveSync} onCreate={driveCreate} onPreview={fetchPreview}
                  onUnlink={async () => {
                    await fetch(`/api/proxy/projects/${projectId}/drive/unlink`, { method: "DELETE" });
                    setPortalInfo(null); fetchDrive();
                  }} />

                {/* Follow-ups */}
                {(project.contact_reminders ?? []).length > 0 && (
                  <div className="bg-white dark:bg-zinc-900 rounded-xl border border-amber-200 dark:border-amber-900/40">
                    <div className="px-4 py-3 border-b border-amber-100 dark:border-amber-900/30 flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <h2 className="font-semibold text-sm text-amber-700 dark:text-amber-400">Open Follow-ups</h2>
                      <span className="text-xs text-amber-500">from contact</span>
                    </div>
                    <div className="px-4 divide-y divide-amber-50 dark:divide-amber-900/20">
                      {(project.contact_reminders ?? []).map(r => {
                        const overdue = r.due_date && new Date(r.due_date) < new Date();
                        return (
                          <div key={r.reminder_id} className="flex items-start gap-3 py-2.5 group">
                            <button onClick={() => resolveReminder(r.reminder_id)}
                              className="mt-0.5 w-4 h-4 rounded border border-amber-300 dark:border-amber-700 flex-shrink-0 flex items-center justify-center hover:bg-amber-100 dark:hover:bg-amber-900/40"
                              title="Mark as resolved" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-zinc-800 dark:text-zinc-200 leading-snug">{r.title}</p>
                              {r.description && <p className="text-[11px] text-zinc-400 mt-0.5 truncate">{r.description}</p>}
                              {r.due_date && (
                                <span className={`text-[11px] ${overdue ? "text-red-500 font-medium" : "text-zinc-400"}`}>
                                  {overdue ? "⚠ Overdue · " : ""}{fmt(r.due_date)}
                                </span>
                              )}
                            </div>
                            {r.auto_generated && <span className="text-[10px] text-amber-400 flex-shrink-0 mt-1">auto</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Email Activity */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800" suppressHydrationWarning>
                  <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
                    <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                      Email Activity
                      {emails.length > 0 && <span className="ml-2 text-xs font-normal text-zinc-400">{emails.length} messages</span>}
                    </h2>
                    {project.contact_id && (
                      <Link href={`/contacts/${project.contact_id}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">View contact →</Link>
                    )}
                  </div>
                  {emails.length === 0 ? (
                    <p className="text-sm text-zinc-400 py-8 text-center">
                      {project.contact_id ? "No emails found with this contact" : "No contact linked"}
                    </p>
                  ) : (
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {visibleEmails.map((e, i) => {
                        const isOutbound = e.direction === "outbound" || e.interaction_type === "email_sent";
                        const isMeeting = e.interaction_type === "meeting";
                        return (
                          <div key={i} className="px-4 py-3 flex items-start gap-3">
                            <div className={`mt-1 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${isMeeting ? "bg-purple-100 dark:bg-purple-900/40" : isOutbound ? "bg-blue-100 dark:bg-blue-900/40" : "bg-zinc-100 dark:bg-zinc-800"}`}>
                              <svg className={`w-3.5 h-3.5 ${isMeeting ? "text-purple-600 dark:text-purple-400" : isOutbound ? "text-blue-600 dark:text-blue-400" : "text-zinc-500"}`}
                                fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                {isMeeting
                                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                  : <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />}
                              </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{e.subject || (isMeeting ? "Meeting" : "(no subject)")}</p>
                                <span className="text-[11px] text-zinc-400 flex-shrink-0">{timeAgo(e.occurred_at)}</span>
                              </div>
                              {e.content_preview && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 line-clamp-2">{e.content_preview}</p>}
                            </div>
                          </div>
                        );
                      })}
                      {emails.length > 5 && (
                        <button onClick={() => setShowAllEmails(!showAllEmails)}
                          className="w-full px-4 py-2.5 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                          {showAllEmails ? "Show less" : `Show all ${emails.length} messages`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Right column (1/3) ───────────────────────────────────────── */}
              <div className="space-y-4">
                {/* AI Summary */}
                <AISummaryCard
                  projectId={projectId}
                  summary={project.ai_summary}
                  generatedAt={project.ai_summary_generated_at}
                  onUpdated={s => setProject(p => p ? { ...p, ai_summary: s } : p)}
                />

                {/* Details */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
                  <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">Details</h2>

                  {/* Assigned to */}
                  <div>
                    <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-0.5">Assigned To</p>
                    <select
                      value={project.assigned_to ?? ""}
                      onChange={async e => {
                        const val = e.target.value || null;
                        await fetch(`/api/proxy/projects/${projectId}`, {
                          method: "PATCH", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ assigned_to: val }),
                        });
                        load(); onUpdated();
                      }}
                      className="w-full text-xs bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="">Unassigned</option>
                      {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
                    </select>
                  </div>

                  {/* Dates */}
                  {project.date_start && (
                    <div>
                      <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-0.5">Start Date</p>
                      <p className="text-sm text-zinc-700 dark:text-zinc-300">{fmt(project.date_start)}</p>
                    </div>
                  )}
                  {project.date_deadline && (
                    <div>
                      <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-0.5">Deadline</p>
                      <p className={`text-sm ${new Date(project.date_deadline) < new Date() && project.status === "active" ? "text-red-500 font-medium" : "text-zinc-700 dark:text-zinc-300"}`}>
                        {fmt(project.date_deadline)}
                      </p>
                    </div>
                  )}
                  {project.expected_revenue != null && project.expected_revenue > 0 && (
                    <div>
                      <p className="text-[11px] text-zinc-400 uppercase tracking-wider mb-0.5">Expected Revenue</p>
                      <p className="text-sm font-semibold text-green-600 dark:text-green-400">${project.expected_revenue.toLocaleString()}</p>
                    </div>
                  )}

                  {/* Tags */}
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[11px] text-zinc-400 uppercase tracking-wider">Tags</p>
                      {!tagsEditing && (
                        <button onClick={() => { setTagsList(project.tags ?? []); setTagsInput(""); setTagsEditing(true); }}
                          className="text-[11px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
                          {(project.tags ?? []).length > 0 ? "Edit" : "Add"}
                        </button>
                      )}
                    </div>
                    {tagsEditing ? (
                      <div className="space-y-1.5">
                        {tagsList.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {tagsList.map(tag => <TagChip key={tag} tag={tag} onRemove={() => setTagsList(tagsList.filter(t => t !== tag))} />)}
                          </div>
                        )}
                        <input autoFocus type="text" placeholder="Type tag, press Enter or comma…"
                          value={tagsInput} onChange={e => setTagsInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault();
                              const t = tagsInput.trim().replace(/,$/, "");
                              if (t && !tagsList.includes(t)) setTagsList([...tagsList, t]);
                              setTagsInput("");
                            } else if (e.key === "Backspace" && !tagsInput && tagsList.length > 0) {
                              setTagsList(tagsList.slice(0, -1));
                            }
                          }}
                          className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setTagsEditing(false)} className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
                          <button onClick={saveTags} disabled={tagsSaving} className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium">{tagsSaving ? "Saving…" : "Save"}</button>
                        </div>
                      </div>
                    ) : (project.tags ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1">{project.tags.map(t => <TagChip key={t} tag={t} />)}</div>
                    ) : (
                      <p className="text-xs text-zinc-400 italic">No tags.</p>
                    )}
                  </div>

                  {/* Notes */}
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[11px] text-zinc-400 uppercase tracking-wider">Notes</p>
                      {!notesEditing && (
                        <button onClick={() => { setNotesText(project.notes ?? ""); setNotesEditing(true); }}
                          className="text-[11px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
                          {project.notes ? "Edit" : "Add"}
                        </button>
                      )}
                    </div>
                    {notesEditing ? (
                      <div className="space-y-1.5">
                        <AutoTextarea autoFocus value={notesText} onChange={e => setNotesText(e.target.value)} rows={8}
                          className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 resize-y focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setNotesEditing(false)} className="text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">Cancel</button>
                          <button onClick={saveNotes} disabled={notesSaving} className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium">{notesSaving ? "Saving…" : "Save"}</button>
                        </div>
                      </div>
                    ) : project.notes ? (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed whitespace-pre-wrap">{project.notes}</p>
                    ) : (
                      <p className="text-xs text-zinc-400 italic">No notes yet.</p>
                    )}
                  </div>
                </div>

                {/* Contacts */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">Contacts</h2>
                    <button onClick={() => setShowContactModal(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Add</button>
                  </div>
                  {(project.project_contacts ?? []).length === 0 ? (
                    <p className="text-xs text-zinc-400">No contacts linked.</p>
                  ) : (
                    <div className="space-y-3">
                      {(project.project_contacts ?? []).map(pc => (
                        <div key={pc.id} className="group">
                          <div className="flex items-start gap-2.5">
                            <Link href={`/contacts/${pc.contact_id}`} className="shrink-0 mt-0.5">
                              {pc.avatar_url ? (
                                <img src={pc.avatar_url} alt={pc.name} className="w-8 h-8 rounded-full object-cover" />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                                  <span className="text-blue-700 dark:text-blue-300 font-semibold text-[10px]">{initials(pc.name)}</span>
                                </div>
                              )}
                            </Link>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Link href={`/contacts/${pc.contact_id}`}
                                  className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate">
                                  {pc.name}
                                </Link>
                                {pc.is_primary && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium">Primary</span>}
                              </div>
                              {pc.title && <p className="text-xs text-zinc-500 truncate">{pc.title}</p>}
                              {pc.organization && <p className="text-xs text-zinc-400 truncate">{pc.organization}</p>}
                              <div className="flex items-center gap-1 mt-0.5">
                                {editingContactRole === pc.contact_id ? (
                                  <div className="flex items-center gap-1">
                                    <select value={editRoleValue} onChange={e => setEditRoleValue(e.target.value)}
                                      className="text-[11px] bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300">
                                      {CONTACT_ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                                    </select>
                                    <button onClick={() => saveContactRole(pc.contact_id, editRoleValue)} className="text-[10px] text-blue-600 hover:underline">Save</button>
                                    <button onClick={() => setEditingContactRole(null)} className="text-[10px] text-zinc-400 hover:underline">Cancel</button>
                                  </div>
                                ) : (
                                  <button onClick={() => { setEditingContactRole(pc.contact_id); setEditRoleValue(pc.role); }}
                                    className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 capitalize">
                                    {pc.role.replace(/_/g, " ")}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shrink-0">
                              {!pc.is_primary && (
                                <button onClick={() => setContactAsPrimary(pc.contact_id)} title="Set as primary"
                                  className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 px-1 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20">★</button>
                              )}
                              <button onClick={() => removeProjectContact(pc.contact_id)} disabled={removingContact === pc.contact_id}
                                title="Remove" className="text-[10px] text-zinc-400 hover:text-red-500 px-1 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20">×</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {project.contact_summary && (project.project_contacts ?? []).length === 1 && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-3 leading-relaxed line-clamp-4 italic border-t border-zinc-100 dark:border-zinc-800 pt-3">
                      {project.contact_summary}
                    </p>
                  )}
                </div>

                {/* Strategic Planning */}
                <StrategicPlanningSection projectId={projectId} />

                {/* Funding Agent */}
                <FundingAgentSection projectId={projectId} />

                {/* Portal */}
                <PortalTab projectId={projectId} portalInfo={portalInfo} portalLoading={portalLoading}
                  portalCreating={portalCreating} portalCopied={portalCopied} setPortalCopied={setPortalCopied}
                  onCreatePortal={createPortal}
                  onRevokePortal={async () => {
                    await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "DELETE" });
                    setPortalInfo(null);
                  }} />

                {/* Related */}
                <RelatedProjectsCard projectId={projectId} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Contact link modal — z-[60] to float above panel */}
      {showContactModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md p-5 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900 dark:text-gray-100">Add Contact</h3>
              <button onClick={() => { setShowContactModal(false); setContactQuery(""); setContactResults([]); setContactModalRole("contact"); }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mb-3">
              <label className="block text-xs text-gray-500 mb-1">Role</label>
              <select value={contactModalRole} onChange={e => setContactModalRole(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100">
                {CONTACT_ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</option>)}
              </select>
            </div>
            <input autoFocus type="text" placeholder="Search contacts by name or email…"
              value={contactQuery} onChange={e => searchContacts(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500" />
            <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
              {contactSearching && <p className="text-xs text-gray-400 py-2 text-center">Searching…</p>}
              {!contactSearching && contactResults.map(c => (
                <button key={c.contact_id} onClick={() => linkContact(c.contact_id)} disabled={contactLinking}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</p>
                  {(c.email || c.organization) && <p className="text-xs text-gray-400">{[c.organization, c.email].filter(Boolean).join(" · ")}</p>}
                </button>
              ))}
              {!contactSearching && contactQuery.trim() && contactResults.length === 0 && (
                <div className="py-2">
                  <p className="text-xs text-gray-400 text-center mb-2">No contacts found.</p>
                  <button onClick={createAndLinkContact} disabled={contactLinking}
                    className="w-full text-center text-xs text-blue-600 dark:text-blue-400 hover:underline py-1">
                    + Create &quot;{contactQuery.trim()}&quot; as new contact
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
