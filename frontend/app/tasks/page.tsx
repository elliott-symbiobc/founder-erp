"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ReportsPanel from "@/components/ReportsPanel";
import MessagingDrawer from "@/components/MessagingDrawer";
import MyResponsibilities from "@/components/tasks/MyResponsibilities";
import ReviewRequestModal from "@/components/tasks/ReviewRequestModal";
import ProjectPicker, { ProjectField } from "@/components/tasks/ProjectPicker";
import { useAssignmentApprovals } from "@/components/tasks/useAssignmentApprovals";

import { AutoTextarea } from "@/components/AutoTextarea";
import { Avatar } from "@/components/Avatar";
const CHEVRON = "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2024%2024%22%20stroke%3D%22%239ca3af%22%20stroke-width%3D%222%22%3E%3Cpath%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20d%3D%22M19%209l-7%207-7-7%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_0.4rem_center] bg-[length:1rem]";
const SEL = `text-sm border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500/30 pr-8 ${CHEVRON}`;
const SEL_XS = `text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/30 pr-6 ${CHEVRON}`;

// Background refresh cadence. Long on purpose: user actions already refresh the
// board, so the timer only exists to pick up other people's changes.
const POLL_MS = 120_000;
// A tab regaining focus only refetches if the data is at least this old.
const STALE_MS = 60_000;
// View/filter choices survive reloads and navigation.
// Bumped to v2 when the board became team-wide: v1 entries pin scope to "mine"
// and would silently cancel the new default for anyone who used the page before.
const PREFS_KEY = "tasks:view-prefs:v2";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Task {
  task_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  start_date: string | null;
  estimated_minutes: number | null;
  status: "open" | "done";
  kanban_status: "inbox" | "todo" | "in_progress" | "review" | "done";
  sort_order: number | null;
  project_id: string | null;
  project_name: string | null;
  /** Which kind of project — a task on a grant reads differently from one on a
   *  sales opportunity, even when the project names look alike. */
  project_type?: string | null;
  source_note_id: string | null;
  note_title: string | null;
  contact_id: string | null;
  contact_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  /** Creator. Shown as provenance only — it never implies assignment. */
  user_id?: string | null;
  owner_name: string | null;
  /** Why this was handed to you. Only set on delegated tasks. */
  assignment_note?: string | null;
  /** Set only while a review is outstanding. */
  reviewer_id?: string | null;
  reviewer_name?: string | null;
  review_note?: string | null;
  source: string | null;
  created_at: string;
  /** When it was marked done. Null while open. */
  completed_at?: string | null;
  priority: Priority | null;
  activity_type?: string | null;
  source_ref?: string | null;
  /** Set when the task belongs to an investor record, so it can link there. */
  investor_id?: string | null;
  investor_firm?: string | null;
  task_type?: string | null;
  milestone_id?: string | null;
  milestone_title?: string | null;
  extra_assignees?: { user_id: string; name: string }[] | null;
  blocked_by_count?: number | null;
}

interface User {
  user_id: string;
  name: string;
  email: string;
}

type Priority = "high" | "medium" | "low";
type ViewMode = "list" | "kanban" | "gantt" | "reports";
type FilterMode = "open" | "done" | "all";
type KanbanColId = "inbox" | "todo" | "in_progress" | "review" | "done";

// ─── Background-refresh gate ──────────────────────────────────────────────────
// Polling must never pull the user out of whatever they opened. Modals, inline
// editors and in-flight drags take a hold; the poller skips while any is held.

let refreshHolds = 0;

function holdRefresh(): () => void {
  refreshHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refreshHolds = Math.max(0, refreshHolds - 1);
  };
}

function isRefreshHeld(): boolean {
  return refreshHolds > 0;
}

/** Holds background refreshes for as long as `active` stays true. */
function useRefreshHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return holdRefresh();
  }, [active]);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Deep link to one investor's detail view. The tab is named too, or the page
 *  opens on non-dilutive and the panel would have nothing to sit behind. */
function investorHref(investorId: string) {
  return `/funding?tab=dilutive&investor=${investorId}`;
}

const PROJECT_TYPE_META: Record<string, { label: string; dot: string }> = {
  crm_opportunity: { label: "Opportunity", dot: "bg-blue-500" },
  partnership:     { label: "Partnership", dot: "bg-violet-500" },
  grant:           { label: "Funding",     dot: "bg-sky-500" },
  marketing:       { label: "Marketing",   dot: "bg-amber-500" },
  portfolio:       { label: "Portfolio",   dot: "bg-zinc-400" },
  internal:        { label: "Operations",  dot: "bg-teal-500" },
};

function projectTypeMeta(type: string | null | undefined) {
  if (!type) return null;
  return PROJECT_TYPE_META[type] ?? {
    // An unmapped type still says what it is rather than vanishing — new
    // project_type values get added over time and a silent blank is worse
    // than an unstyled label.
    label: type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
    dot: "bg-zinc-400",
  };
}

interface CardContext {
  kind: string;        // what sort of thing this is
  dot: string;
  label: string;       // which specific one
  href: string;
}

/** The one context line a kanban card shows: what kind of thing the task hangs
 *  off, and which one. Ordered most specific first. */
function getCardContext(t: Task): CardContext | null {
  if (t.project_name) {
    const pt = projectTypeMeta(t.project_type);
    return {
      kind: pt?.label ?? "Project",
      dot: pt?.dot ?? "bg-zinc-400",
      label: t.project_name,
      href: `/projects/${t.project_id}`,
    };
  }
  if (t.milestone_title) {
    return {
      kind: "Milestone",
      dot: "bg-emerald-500",
      label: t.milestone_title,
      href: t.project_id ? `/projects/${t.project_id}` : "/projects",
    };
  }
  // Investors come before the generic funding case, which was previously the
  // only funding branch here and swallowed the firm name.
  if (t.investor_id) {
    return {
      kind: "Investor",
      dot: "bg-sky-500",
      label: t.investor_firm || "Open investor",
      href: investorHref(t.investor_id),
    };
  }
  if (t.contact_name) {
    return {
      kind: "Contact",
      dot: "bg-violet-500",
      label: t.contact_name,
      href: t.contact_id ? `/contacts/${t.contact_id}` : "/contacts",
    };
  }
  // Funding work with no investor resolved -- rare, but it should still say
  // where it belongs rather than falling through to nothing.
  if (t.activity_type === "dilutive_activity" || (t.source === "auto" && t.activity_type === "follow_up")) {
    return { kind: "Funding", dot: "bg-sky-500", label: "Investor pipeline", href: "/funding?tab=dilutive" };
  }
  if (t.note_title) {
    return { kind: "Notebook", dot: "bg-amber-500", label: t.note_title, href: "/notebook" };
  }
  if (t.user_id && t.assigned_to && t.user_id !== t.assigned_to) {
    return {
      kind: "Assigned",
      dot: "bg-indigo-500",
      label: `From ${t.owner_name || "a teammate"}`,
      href: "/tasks",
    };
  }
  return null;
}

function getTaskDestination(t: Task): { href: string; label: string } | null {
  if (t.project_id && t.project_name) return { href: `/projects/${t.project_id}`, label: t.project_name };
  // A task on an investor opens that investor, not the board it sits on.
  if (t.investor_id) {
    return { href: investorHref(t.investor_id), label: t.investor_firm || "Investor" };
  }
  if (t.source === "auto" && t.activity_type === "follow_up") return { href: "/funding", label: "Funding" };
  if (t.contact_id && t.contact_name) return { href: "/contacts", label: t.contact_name };
  if (t.source_note_id && t.note_title) return { href: "/notebook", label: t.note_title };
  if (t.milestone_id && t.milestone_title) return { href: "/projects", label: t.milestone_title };
  return null;
}

// Where a task came from, and where to click through to. Projects win when set;
// otherwise the origin is inferred from whichever module stamped the task.
interface TaskOrigin {
  module: string;          // the section of the platform the task belongs to
  label: string;           // the specific record, when there is one
  href: string;
  sub?: string;            // secondary detail (milestone, contact, …)
  icon: "project" | "notebook" | "email" | "funding" | "contact" | "person";
}

function getTaskOrigin(t: Task): TaskOrigin | null {
  if (t.project_id) {
    // Name the kind of project rather than the generic word: "Funding" and
    // "Opportunity" are what distinguish two similarly-named projects.
    const ptype = projectTypeMeta(t.project_type);
    return {
      module: ptype?.label ?? "Project",
      label: t.project_name || "Open project",
      href: `/projects/${t.project_id}?from=/tasks`,
      sub: t.milestone_title ? `Milestone · ${t.milestone_title}` : undefined,
      icon: "project",
    };
  }

  if (t.source === "granola" || t.source_ref?.startsWith("granola:")) {
    const entryId = t.source_ref?.split(":")[1];
    return {
      module: "Meeting notes",
      label: t.note_title || "Open in Notebook",
      href: entryId ? `/notebook?open=${entryId}` : "/notebook",
      icon: "notebook",
    };
  }

  if (t.source_ref === "email_suggestion") {
    return {
      module: "Email",
      label: t.contact_name ? `Email · ${t.contact_name}` : "Open Email",
      href: "/email",
      icon: "email",
    };
  }

  if (t.investor_id) {
    return {
      module: "Funding",
      label: t.investor_firm || "Open investor",
      href: investorHref(t.investor_id),
      icon: "funding",
    };
  }

  if (t.activity_type === "dilutive_activity" || (t.source === "auto" && t.activity_type === "follow_up")) {
    return {
      module: "Funding",
      label: "Investor pipeline",
      href: "/funding?tab=dilutive",
      icon: "funding",
    };
  }

  if (t.source_note_id) {
    return {
      module: "Notebook",
      label: t.note_title || "Open Notebook",
      href: "/notebook",
      icon: "notebook",
    };
  }

  if (t.contact_id) {
    return {
      module: "CRM contact",
      label: t.contact_name || "Open contact",
      href: `/contacts/${t.contact_id}`,
      icon: "contact",
    };
  }

  if (t.milestone_id) {
    return {
      module: "Project milestone",
      label: t.milestone_title || "Open projects",
      href: "/projects",
      icon: "project",
    };
  }

  // A task someone hands you matches none of the branches above — it has no
  // project, contact or note behind it — and used to render with no origin at
  // all. The person who sent it is the context.
  if (t.user_id && t.assigned_to && t.user_id !== t.assigned_to) {
    return {
      module: "Assigned to you",
      label: t.owner_name ? `From ${t.owner_name}` : "From a teammate",
      href: "/tasks",
      sub: t.assignment_note || undefined,
      icon: "person",
    };
  }

  return null;
}

const ORIGIN_ICON_PATH: Record<TaskOrigin["icon"], string> = {
  project: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z",
  notebook: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
  email: "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
  funding: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  contact: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z",
  person: "M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z",
};

/** How long a task took, created to completed. Coarse on purpose: nobody cares
 *  that something took 3h 12m, only that it took an afternoon or three weeks. */
function fmtElapsed(from: string, to: string): string | null {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

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

// ─── Task Type Badge ──────────────────────────────────────────────────────────

const TASK_TYPES = ["email", "call", "meeting", "document", "todo", "follow_up", "in_silico", "wet_lab"] as const;
const TASK_TYPE_META: Record<string, { label: string; color: string }> = {
  email:     { label: "Email",             color: "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-800" },
  call:      { label: "Call",              color: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800" },
  meeting:   { label: "Meeting",           color: "bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-950/40 dark:text-purple-400 dark:border-purple-800" },
  document:  { label: "Document",          color: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800" },
  todo:      { label: "To-do",             color: "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700" },
  in_silico: { label: "In-Silico Analysis",color: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-400 dark:border-cyan-800" },
  wet_lab:   { label: "Wet Lab Work",      color: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-400 dark:border-teal-800" },
  follow_up: { label: "Follow-up",         color: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-800" },
};

// The data carries three spellings of the same idea -- "followup", "follow_up"
// and "followup_review" -- none of which are in TASK_TYPE_META, so tasks of
// that type classified as nothing at all. Normalised on read rather than
// migrated: activity_type is written by several extractors and a migration
// would only fix the rows that exist today.
const TASK_TYPE_ALIASES: Record<string, string> = {
  followup: "follow_up",
  followup_review: "follow_up",
};

function canonicalTaskType(type?: string | null): string | null {
  if (!type) return null;
  const t = TASK_TYPE_ALIASES[type] ?? type;
  return TASK_TYPE_META[t] ? t : null;
}

// A glyph per type, so every card is classified at a glance without a bordered
// pill on each one -- the cards just lost seven of those.
const TASK_TYPE_ICON: Record<string, string> = {
  email:     "M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75",
  call:      "M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z",
  meeting:   "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
  document:  "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
  todo:      "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  in_silico: "M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z",
  wet_lab:   "M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c.251.023.501.05.75.082M9.75 3.104a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5",
  follow_up: "M16.023 9.348h4.992V4.356m-4.993 4.992l3.181-3.183a8.25 8.25 0 00-13.803 3.7M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7",
};

// Icon colour only — the pill's background and border would be a box on every
// card, which is what the redesign removed.
const TASK_TYPE_DOT: Record<string, string> = {
  email:     "text-blue-500",
  call:      "text-green-600",
  meeting:   "text-purple-500",
  document:  "text-amber-600",
  todo:      "text-zinc-400",
  in_silico: "text-cyan-600",
  wet_lab:   "text-teal-600",
  follow_up: "text-rose-500",
};

function TypeGlyph({ t, className = "" }: { t: string; className?: string }) {
  return (
    <svg className={`w-3.5 h-3.5 ${TASK_TYPE_DOT[t] ?? "text-zinc-400"} ${className}`}
      fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d={TASK_TYPE_ICON[t]} />
    </svg>
  );
}

/**
 * The type control in the card's left gutter.
 *
 * It picks from a list rather than cycling. Cycling through eight types to
 * reach one is worse than a menu, and it could not classify an unset task at
 * all: with no type there was no icon, so there was nothing to click — which
 * is exactly the 37 tasks most in need of a type. An unset slot now shows a
 * dashed placeholder that appears on hover.
 */
function TaskTypePicker({
  type,
  onChange,
}: {
  type?: string | null;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = canonicalTaskType(type);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        title={t ? `${TASK_TYPE_META[t].label} — click to change` : "Set a type"}
        aria-label={t ? TASK_TYPE_META[t].label : "Set a type"}
        className={`w-3.5 h-3.5 flex items-center justify-center transition-opacity ${
          t ? "hover:opacity-70" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {t ? (
          <TypeGlyph t={t} />
        ) : (
          <span className="w-3 h-3 rounded-full border border-dashed border-zinc-400 dark:border-zinc-600" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 w-36 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-xl py-1">
          {TASK_TYPES.map(opt => (
            <button
              key={opt}
              onClick={() => { onChange(opt); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors ${
                opt === t ? "bg-zinc-50 dark:bg-zinc-800" : ""
              }`}
            >
              <TypeGlyph t={opt} />
              <span className="text-[11px] text-gray-900 dark:text-gray-100">{TASK_TYPE_META[opt].label}</span>
            </button>
          ))}
          {t && (
            <button
              onClick={() => { onChange(""); setOpen(false); }}
              className="w-full text-left px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors border-t border-zinc-100 dark:border-zinc-800 mt-1 pt-1.5"
            >
              Clear type
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TaskTypeBadge({ type, onClick }: { type?: string | null; onClick?: (e: React.MouseEvent) => void }) {
  const t = canonicalTaskType(type);
  if (!t) return null;
  const meta = TASK_TYPE_META[t];
  if (onClick) {
    return (
      <button onClick={onClick} title="Click to change type"
        className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md border cursor-pointer hover:opacity-80 transition-opacity ${meta.color}`}>
        {meta.label}
      </button>
    );
  }
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

// ─── Priority Badge ───────────────────────────────────────────────────────────

const PRIORITY_CYCLE: Priority[] = ["low", "medium", "high"];

function PriorityBadge({ priority, onClick }: { priority: Priority; onClick?: (e: React.MouseEvent) => void }) {
  const map = {
    high: { label: "High", cls: "bg-red-50 text-red-600 border border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800" },
    medium: { label: "Med", cls: "bg-amber-50 text-amber-600 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800" },
    low: { label: "Low", cls: "bg-green-50 text-green-600 border border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800" },
  };
  const { label, cls } = map[priority];
  if (onClick) {
    return (
      <button
        onClick={onClick}
        title="Click to change priority"
        className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md cursor-pointer hover:opacity-80 transition-opacity ${cls}`}
      >
        {label}
      </button>
    );
  }
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${cls}`}>
      {label}
    </span>
  );
}

// ─── New Task Modal ───────────────────────────────────────────────────────────

interface MilestoneSummary { milestone_id: string; title: string; }

function NewTaskModal({
  users,
  projects,
  defaultKanbanStatus,
  currentUserId,
  onSubmit,
  onClose,
}: {
  users: User[];
  projects: { project_id: string; name: string; project_type?: string }[];
  defaultKanbanStatus?: KanbanColId;
  currentUserId: string;
  onSubmit: (data: Partial<Task>) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [start, setStart] = useState("");
  const [est, setEst] = useState("");
  const [assignedTo, setAssignedTo] = useState(currentUserId);
  const [assigneeNote, setAssigneeNote] = useState("");
  const [projectId, setProjectId] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([]);
  const [kanbanStatus, setKanbanStatus] = useState<KanbanColId>(defaultKanbanStatus ?? "todo");
  // Classifying at creation is why this exists: with no type field here, every
  // hand-made task started unclassified, which is most of the untyped backlog.
  const [activityType, setActivityType] = useState("");

  // /users/me resolves after mount, so a fast click can open this before the id
  // lands. Adopt it once it arrives, unless a choice has already been made.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (currentUserId && !assignedTo) setAssignedTo(currentUserId);
  }, [currentUserId, assignedTo]);

  // The note explains a hand-off, so it is only owed when the work is going to
  // someone else. Taking a task yourself needs no explanation.
  const isDelegating = !!assignedTo && assignedTo !== currentUserId;
  const needsNote = isDelegating && !assigneeNote.trim();
  const [busy, setBusy] = useState(false);

  // Keep background polling off while this modal is open.
  useRefreshHold(true);

  useEffect(() => {
    setMilestoneId("");
    if (!projectId) { setMilestones([]); return; }
    fetch(`/api/proxy/projects/${projectId}/milestones`)
      .then(r => r.ok ? r.json() : [])
      .then((data: MilestoneSummary[]) => setMilestones(Array.isArray(data) ? data : []))
      .catch(() => setMilestones([]));
  }, [projectId]);

  async function submit() {
    if (!title.trim()) return;
    if (needsNote) return;
    setBusy(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        due_date: due || null,
        start_date: start || null,
        estimated_minutes: est ? parseInt(est, 10) : null,
        activity_type: activityType || null,
        assigned_to: assignedTo || null,
        assignment_note: assignedTo ? assigneeNote.trim() : null,
        project_id: projectId || null,
        milestone_id: milestoneId || null,
        kanban_status: kanbanStatus,
      } as Partial<Task> & { assignment_note?: string | null });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">New Task</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) submit(); if (e.key === "Escape") onClose(); }}
              placeholder="What needs to be done?"
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 transition-all"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Description</label>
            <AutoTextarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add details, context, or notes…"
              rows={3}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none transition-all"
            />
          </div>

          {/* Dates row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Start Date</label>
              <input
                type="date"
                value={start}
                onChange={e => setStart(e.target.value)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Due Date</label>
              <input
                type="date"
                value={due}
                onChange={e => setDue(e.target.value)}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all"
              />
            </div>
          </div>

          {/* Status + Estimate row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Status</label>
              <select
                value={kanbanStatus}
                onChange={e => setKanbanStatus(e.target.value as KanbanColId)}
                className={`w-full ${SEL}`}
              >
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="review">Review</option>
                <option value="done">Done</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Estimate (min)</label>
              <input
                type="number"
                value={est}
                onChange={e => setEst(e.target.value)}
                placeholder="e.g. 30"
                min={1}
                className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 transition-all"
              />
            </div>
          </div>

          {/* Assignee */}
          {users.length > 0 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Assignee</label>
                <select
                  value={assignedTo}
                  onChange={e => { setAssignedTo(e.target.value); setAssigneeNote(""); }}
                  className={`w-full ${SEL}`}
                >
                  {users.map(u => (
                    <option key={u.user_id} value={u.user_id}>
                      {u.user_id === currentUserId ? `${u.name || u.email} (me)` : (u.name || u.email)}
                    </option>
                  ))}
                </select>
              </div>
              {isDelegating && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                    Note to assignee <span className="text-red-500">*</span>
                  </label>
                  <AutoTextarea
                    value={assigneeNote}
                    onChange={e => setAssigneeNote(e.target.value)}
                    placeholder="Add context for the assignee…"
                    rows={2}
                    className={`w-full text-sm bg-gray-50 dark:bg-gray-800 border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none transition-all ${
                      needsNote ? "border-red-300 dark:border-red-700" : "border-gray-200 dark:border-gray-700"
                    }`}
                  />
                  {needsNote && (
                    <p className="text-[10px] text-red-500 mt-1">Required when assigning to someone</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Project */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Type</label>
            <select value={activityType} onChange={e => setActivityType(e.target.value)}
              className={`w-full ${SEL}`}>
              <option value="">Unclassified</option>
              {TASK_TYPES.map(t => (
                <option key={t} value={t}>{TASK_TYPE_META[t]?.label ?? t}</option>
              ))}
            </select>
          </div>

          <ProjectField
            projects={projects}
            value={projectId}
            onChange={setProjectId}
          />

          {/* Milestone — only shown when a project is selected and has milestones */}
          {milestones.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Milestone</label>
              <select
                value={milestoneId}
                onChange={e => setMilestoneId(e.target.value)}
                className={`w-full ${SEL}`}
              >
                <option value="">No milestone</option>
                {milestones.map(m => <option key={m.milestone_id} value={m.milestone_id}>{m.title}</option>)}
              </select>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!title.trim() || busy || needsNote || !assignedTo}
            className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {busy && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Task Modal ──────────────────────────────────────────────────────────

function EditTaskModal({
  task,
  users,
  projects,
  onSave,
  onDelete,
  onClose,
}: {
  task: Task;
  users: User[];
  projects: { project_id: string; name: string; project_type?: string }[];
  onSave: (id: string, patch: Partial<Task> & { assignment_note?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [due, setDue] = useState(task.due_date ?? "");
  const [start, setStart] = useState(task.start_date ?? "");
  const [est, setEst] = useState(task.estimated_minutes ? String(task.estimated_minutes) : "");
  const [assignedTo, setAssignedTo] = useState(task.assigned_to ?? "");
  const [assigneeNote, setAssigneeNote] = useState("");
  const [projectId, setProjectId] = useState(task.project_id ?? "");
  const [milestoneId, setMilestoneId] = useState(task.milestone_id ?? "");
  const [milestones, setMilestones] = useState<MilestoneSummary[]>([]);
  const [kanbanStatus, setKanbanStatus] = useState<KanbanColId>(task.kanban_status ?? "todo");
  // Type was settable only by clicking the icon on the card — and an untyped
  // task draws no icon, so 37 open tasks had no way to be classified at all.
  const [activityType, setActivityType] = useState(canonicalTaskType(task.activity_type) ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Keep background polling off while this modal is open.
  useRefreshHold(true);

  // Reflect unsaved project/milestone picks so the link always points where the
  // task is about to live, not where it lived when the modal opened.
  const origin = getTaskOrigin({
    ...task,
    project_id: projectId || null,
    project_name: projectId
      ? (projects.find(p => p.project_id === projectId)?.name ?? task.project_name)
      : null,
    milestone_id: milestoneId || null,
    milestone_title: milestoneId
      ? (milestones.find(m => m.milestone_id === milestoneId)?.title ?? task.milestone_title)
      : null,
  });

  useEffect(() => {
    if (!projectId) { setMilestones([]); return; }
    fetch(`/api/proxy/projects/${projectId}/milestones`)
      .then(r => r.ok ? r.json() : [])
      .then((data: MilestoneSummary[]) => setMilestones(Array.isArray(data) ? data : []))
      .catch(() => setMilestones([]));
  }, [projectId]);

  const isNewAssignee = !!(assignedTo && assignedTo !== (task.assigned_to ?? ""));

  const isDirty =
    title !== task.title ||
    description !== (task.description ?? "") ||
    due !== (task.due_date ?? "") ||
    start !== (task.start_date ?? "") ||
    est !== (task.estimated_minutes ? String(task.estimated_minutes) : "") ||
    assignedTo !== (task.assigned_to ?? "") ||
    projectId !== (task.project_id ?? "") ||
    milestoneId !== (task.milestone_id ?? "") ||
    activityType !== (canonicalTaskType(task.activity_type) ?? "") ||
    kanbanStatus !== (task.kanban_status ?? "todo");

  // Following the link leaves the page, so don't drop edits on the floor.
  function confirmLeave(e: React.MouseEvent) {
    if (isDirty && !window.confirm("You have unsaved changes to this task. Leave without saving?")) {
      e.preventDefault();
    }
  }

  async function save() {
    if (!title.trim()) return;
    if (isNewAssignee && !assigneeNote.trim()) return;
    setBusy(true);
    try {
      await onSave(task.task_id, {
        title: title.trim(),
        description: description.trim() || null,
        due_date: due || null,
        start_date: start || null,
        estimated_minutes: est ? parseInt(est, 10) : null,
        assigned_to: assignedTo || null,
        project_id: projectId || null,
        milestone_id: milestoneId || null,
        activity_type: activityType || null,
        kanban_status: kanbanStatus,
        assignment_note: isNewAssignee ? assigneeNote.trim() : null,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await onDelete(task.task_id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Edit Task</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Linked to — click through to wherever this task came from */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Linked to</label>
            {origin ? (
              <Link
                href={origin.href}
                onClick={confirmLeave}
                className="group flex items-center gap-3 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2.5 hover:border-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/20 transition-colors"
              >
                <span className="w-8 h-8 shrink-0 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 flex items-center justify-center text-gray-500 group-hover:text-blue-600 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d={ORIGIN_ICON_PATH[origin.icon]} />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {origin.module}
                  </span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-700 dark:group-hover:text-blue-400">
                    {origin.label}
                  </span>
                  {origin.sub && (
                    <span className="block text-[11px] text-gray-400 dark:text-gray-500 truncate">{origin.sub}</span>
                  )}
                </span>
                <svg className="w-4 h-4 shrink-0 text-gray-300 group-hover:text-blue-500 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </Link>
            ) : (
              <div className="flex items-center gap-3 w-full rounded-lg border border-dashed border-gray-200 dark:border-gray-700 px-3 py-2.5">
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  Standalone task — not linked to a project or record. Pick a project below to link it.
                </span>
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) save(); if (e.key === "Escape") onClose(); }}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 transition-all"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Description</label>
            <AutoTextarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add details, context, or notes…"
              rows={3}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none transition-all"
            />
          </div>

          {/* Dates */}
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

          {/* Type */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Type</label>
            <select value={activityType} onChange={e => setActivityType(e.target.value)}
              className={`w-full ${SEL}`}>
              <option value="">Unclassified</option>
              {TASK_TYPES.map(t => (
                <option key={t} value={t}>{TASK_TYPE_META[t]?.label ?? t}</option>
              ))}
            </select>
          </div>

          {/* Status + Estimate */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Status</label>
              <select value={kanbanStatus} onChange={e => setKanbanStatus(e.target.value as KanbanColId)}
                className={`w-full ${SEL}`}>
                <option value="inbox">Inbox</option>
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

          {/* Assignee */}
          {users.length > 0 && (
            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Assignee</label>
                <select value={assignedTo} onChange={e => { setAssignedTo(e.target.value); setAssigneeNote(""); }}
                  className={`w-full ${SEL}`}>
                  <option value="">Unassigned</option>
                  {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>)}
                </select>
              </div>
              {isNewAssignee && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                    Note to assignee <span className="text-red-500">*</span>
                  </label>
                  <AutoTextarea
                    value={assigneeNote}
                    onChange={e => setAssigneeNote(e.target.value)}
                    placeholder="Add a note for the assignee…"
                    rows={2}
                    className={`w-full text-sm bg-gray-50 dark:bg-gray-800 border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none transition-all ${
                      !assigneeNote.trim() ? "border-red-400 dark:border-red-500" : "border-gray-200 dark:border-gray-700"
                    }`}
                  />
                  {!assigneeNote.trim() && (
                    <p className="mt-1 text-xs text-red-500">A note is required when assigning a task.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Project */}
          <ProjectField
            projects={projects}
            value={projectId}
            onChange={id => { setProjectId(id); setMilestoneId(""); }}
          />

          {/* Milestone */}
          {milestones.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Milestone</label>
              <select value={milestoneId} onChange={e => setMilestoneId(e.target.value)}
                className={`w-full ${SEL}`}>
                <option value="">No milestone</option>
                {milestones.map(m => <option key={m.milestone_id} value={m.milestone_id}>{m.title}</option>)}
              </select>
            </div>
          )}

          {/* Meta info */}
          <div className="text-[11px] text-gray-400 dark:text-gray-600 border-t border-gray-100 dark:border-gray-800 pt-3">
            {/* Project lives in the "Linked to" card above, so it isn't repeated here. */}
            Created {new Date(task.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {task.owner_name && ` · ${task.owner_name}`}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-600 dark:text-red-400">Delete this task?</span>
              <button onClick={handleDelete} disabled={busy}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors">
                Yes, delete
              </button>
              <button onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">
                Cancel
              </button>
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
            <button onClick={save} disabled={!title.trim() || busy || (isNewAssignee && !assigneeNote.trim())}
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
const LABEL_W = 220;

interface GanttDrag {
  taskId: string;
  type: "move" | "resize";
  startX: number;
  origStart: number;
  origDue: number;
  rangeStartMs: number;
}

function GanttView({
  tasks,
  onUpdate,
  onToggle,
  onDelete,
}: {
  tasks: Task[];
  onUpdate: (id: string, patch: Partial<Task> & { assignment_note?: string | null }) => Promise<void>;
  onToggle: (task: Task) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<GanttDrag | null>(null);
  const [preview, setPreview] = useState<Record<string, { start: number; due: number }>>({});
  const previewRef = useRef<Record<string, { start: number; due: number }>>({});
  useEffect(() => { previewRef.current = preview; }, [preview]);

  // Pause polling while a bar is being dragged or resized.
  useRefreshHold(Object.keys(preview).length > 0);

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  const { rangeStart, totalDays } = useMemo(() => {
    const ms: number[] = [today.getTime()];
    for (const t of tasks) {
      if (t.start_date) ms.push(new Date(t.start_date).getTime());
      if (t.due_date) ms.push(new Date(t.due_date).getTime());
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
          due_date: dateToIso(addDays(rs, p.due)),
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
    if (task.start_date) {
      const d = new Date(task.start_date); d.setHours(0, 0, 0, 0);
      sd = Math.floor((d.getTime() - rangeStart.getTime()) / 86400000);
    }
    if (task.due_date) {
      const d = new Date(task.due_date); d.setHours(0, 0, 0, 0);
      dd = Math.floor((d.getTime() - rangeStart.getTime()) / 86400000);
    }
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
      result.push({
        label: curr.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        x: mStart * DAY_PX,
        width: Math.ceil((mEnd.getTime() - curr.getTime()) / 86400000) * DAY_PX,
      });
      curr = next;
    }
    return result;
  }, [rangeStart, totalDays]);

  const datedTasks = tasks.filter(t => getBarDays(t) !== null);
  const undatedTasks = tasks.filter(t => !t.start_date && !t.due_date);
  const timelineW = totalDays * DAY_PX;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden select-none">
      <div ref={scrollRef} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 180px)" }}>
        <div style={{ display: "inline-block", minWidth: "100%", width: LABEL_W + timelineW }}>
          {/* Header */}
          <div className="flex sticky top-0 z-20 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <div className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-800/60 border-r border-gray-200 dark:border-gray-700 flex items-end pb-2 px-4"
                 style={{ width: LABEL_W, minWidth: LABEL_W, height: 52 }}>
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
                      {show && (
                        <span className={`text-[10px] ${isToday ? "text-blue-600 font-bold" : isWknd ? "text-gray-300 dark:text-gray-600" : "text-gray-400 dark:text-gray-600"}`}>
                          {d.getDate()}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Dated task rows */}
          {datedTasks.map(task => {
            const days = getBarDays(task)!;
            const overdue = isOverdue(task.due_date, task.status);
            const isDone = task.status === "done";
            let barCls = "bg-blue-100 dark:bg-blue-900/40 border-blue-300 dark:border-blue-600";
            let txtCls = "text-blue-800 dark:text-blue-200";
            if (isDone) { barCls = "bg-green-100 dark:bg-green-900/40 border-green-300 dark:border-green-600"; txtCls = "text-green-800 dark:text-green-200"; }
            else if (overdue) { barCls = "bg-red-100 dark:bg-red-900/40 border-red-300 dark:border-red-600"; txtCls = "text-red-800 dark:text-red-200"; }
            const barLeft = days.start * DAY_PX + 2;
            const barW = Math.max(DAY_PX, (days.due - days.start) * DAY_PX - 4);
            return (
              <div key={task.task_id} className="flex border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50/30 dark:hover:bg-gray-800/20 group" style={{ height: ROW_H }}>
                <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3"
                     style={{ width: LABEL_W, minWidth: LABEL_W }}>
                  <button onClick={() => onToggle(task)}
                          className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-colors ${isDone ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-green-400"}`} />
                  <span className={`text-xs truncate flex-1 ${isDone ? "line-through text-gray-400" : "text-gray-800 dark:text-gray-100"}`}>{task.title}</span>
                  <button onClick={() => onDelete(task.task_id)}
                          className="ml-1 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 flex-shrink-0">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div style={{ position: "relative", width: timelineW, flexShrink: 0 }}>
                  <div style={{ position: "absolute", left: todayDay * DAY_PX, top: 0, bottom: 0, width: 1, pointerEvents: "none", zIndex: 1 }}
                       className="bg-blue-400/50" />
                  {Array.from({ length: totalDays }, (_, i) => {
                    const d = addDays(rangeStart, i);
                    if (d.getDay() !== 0 && d.getDay() !== 6) return null;
                    return <div key={i} style={{ position: "absolute", left: i * DAY_PX, top: 0, bottom: 0, width: DAY_PX, pointerEvents: "none" }}
                                className="bg-gray-50/50 dark:bg-gray-800/20" />;
                  })}
                  <div
                    style={{ position: "absolute", left: barLeft, width: barW, top: 5, height: ROW_H - 10, borderRadius: 5, zIndex: 2,
                             cursor: dragRef.current?.taskId === task.task_id ? "grabbing" : "grab" }}
                    className={`border flex items-center px-2 ${barCls}`}
                    onPointerDown={e => startDrag(e, task.task_id, "move", days.start, days.due)}
                  >
                    <span className={`text-[11px] truncate flex-1 pointer-events-none ${txtCls}`}>{task.title}</span>
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "ew-resize", zIndex: 3 }}
                         className="rounded-r"
                         onPointerDown={e => { e.stopPropagation(); startDrag(e, task.task_id, "resize", days.start, days.due); }} />
                  </div>
                </div>
              </div>
            );
          })}

          {/* Undated tasks */}
          {undatedTasks.length > 0 && (
            <>
              <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/40" style={{ height: 28 }}>
                <div className="sticky left-0 z-10 bg-gray-50/80 dark:bg-gray-800/40 flex items-center px-4"
                     style={{ width: LABEL_W, minWidth: LABEL_W }}>
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">No date</span>
                </div>
                <div style={{ width: timelineW }} />
              </div>
              {undatedTasks.map(task => (
                <div key={task.task_id} className="flex border-b border-gray-100 dark:border-gray-800" style={{ height: ROW_H }}>
                  <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3"
                       style={{ width: LABEL_W, minWidth: LABEL_W }}>
                    <button onClick={() => onToggle(task)}
                            className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${task.status === "done" ? "bg-green-500 border-green-500" : "border-gray-300 hover:border-green-400"}`} />
                    <span className={`text-xs truncate ${task.status === "done" ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>{task.title}</span>
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
              <div className="sticky left-0 flex items-center justify-center px-4 text-sm text-gray-400"
                   style={{ width: LABEL_W, minWidth: LABEL_W }}>No tasks</div>
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
  {
    // Work that arrived rather than work you chose: tasks handed over by someone
    // else, shown above the collapsed suggestion groups. Emptying it is triage,
    // not progress, which is why it sits outside the To Do → Done flow.
    id: "inbox" as KanbanColId,
    label: "Inbox",
    dot: "bg-indigo-500",
    emptyMsg: "Nothing waiting on you.",
  },
  {
    id: "todo" as KanbanColId,
    label: "To Do",
    dot: "bg-gray-400",
    emptyMsg: "No tasks yet.",
  },
  {
    id: "in_progress" as KanbanColId,
    label: "In Progress",
    dot: "bg-blue-500",
    emptyMsg: "Drag tasks here to start work.",
  },
  {
    id: "review" as KanbanColId,
    label: "Review",
    dot: "bg-amber-500",
    emptyMsg: "Move tasks here for review.",
  },
  {
    id: "done" as KanbanColId,
    label: "Done",
    dot: "bg-green-500",
    // Completed work is a record, not a queue. It opens collapsed so the board
    // shows what is live, and expands on demand or when the status filter is
    // set to Done, where it is the only thing worth looking at.
    autoCollapse: true,
    emptyMsg: "Completed tasks will appear here.",
  },
];

function KanbanView({
  tasks,
  users,
  projects,
  onUpdate,
  onDelete,
  onCreate,
  onReorder,
  onRefresh,
  onToggle,
  onProjectCreated,
  currentUserId,
  statusFilter,
}: {
  tasks: Task[];
  users: User[];
  projects: { project_id: string; name: string; project_type?: string }[];
  onUpdate: (id: string, patch: Partial<Task> & { assignment_note?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCreate: (data: { title: string; kanban_status: KanbanColId; due_date?: string }) => Promise<void>;
  onReorder: (ids: string[]) => Promise<void>;
  onRefresh: () => void;
  onToggle: (task: Task) => Promise<void>;
  onProjectCreated: (p: { project_id: string; name: string; project_type?: string }) => void;
  currentUserId: string;
  statusFilter: FilterMode;
}) {
  const approvals = useAssignmentApprovals();
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [reviewFor, setReviewFor] = useState<Task | null>(null);
  const [pickingProjectFor, setPickingProjectFor] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  async function requestReview(taskId: string, reviewerId: string, note: string) {
    const res = await fetch(`/api/proxy/tasks/${taskId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer_id: reviewerId, note }),
    });
    if (!res.ok) throw new Error("request failed");
    setReviewFor(null);
    onRefresh();
  }

  async function resolveReview(taskId: string, action: "approved" | "changes_requested") {
    setResolving(taskId);
    try {
      const res = await fetch(`/api/proxy/tasks/${taskId}/review/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) onRefresh();
    } finally {
      setResolving(null);
    }
  }
  const dragId = useRef<string | null>(null);
  const didDrag = useRef(false);
  const [dragOverCol, setDragOverCol] = useState<KanbanColId | null>(null);
  const [dragOverCard, setDragOverCard] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<KanbanColId>>(
    () => new Set(KANBAN_COLS.filter(c => c.autoCollapse).map(c => c.id))
  );
  const [addingIn, setAddingIn] = useState<KanbanColId | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [colSort, setColSort] = useState<Record<KanbanColId, "none" | "priority" | "due_date">>({
    inbox: "none", todo: "none", in_progress: "none", review: "none", done: "none",
  });

  // Pause polling while a card is open, being dragged, or being added inline.
  useRefreshHold(!!editTask || !!draggingId || addingIn !== null);

  // Filtering to Done is an explicit request to look at completed work, so the
  // auto-collapse gets out of the way rather than hiding the one column left on
  // screen. Leaving that filter does not re-collapse it: by then you have seen
  // the column open, and snapping it shut would look like a bug.
  const wasDoneFilter = useRef(false);
  useEffect(() => {
    const isDoneFilter = statusFilter === "done";
    if (isDoneFilter && !wasDoneFilter.current) {
      setCollapsed(prev => {
        if (!prev.has("done")) return prev;
        const next = new Set(prev);
        next.delete("done");
        return next;
      });
    }
    wasDoneFilter.current = isDoneFilter;
  }, [statusFilter]);

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

  function cyclColSort(colId: KanbanColId) {
    setColSort(prev => {
      const order: ("none" | "priority" | "due_date")[] = ["none", "priority", "due_date"];
      const next = order[(order.indexOf(prev[colId]) + 1) % order.length];
      return { ...prev, [colId]: next };
    });
  }

  const byCol: Record<KanbanColId, Task[]> = { inbox: [], todo: [], in_progress: [], review: [], done: [] };
  for (const t of tasks) {
    const k = (t.kanban_status as KanbanColId) || "todo";
    if (byCol[k]) byCol[k].push(t);
  }

  // Every column stays mounted even when the filter empties it. Dragging to Done
  // is no longer the only way to complete a task -- cards have a checkbox now --
  // but the column is still a drop target and still the place completed work is
  // read back from, so it should not vanish under the default "open" filter.
  function hiddenByFilter(colId: KanbanColId): boolean {
    // Done keeps its cards under every filter now — completed work is retained
    // and read back there rather than disappearing the moment it is finished.
    if (statusFilter === "done") return colId !== "done";
    return false;
  }

  function toggleCollapse(colId: KanbanColId) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }

  async function handleColDrop(col: KanbanColId) {
    if (dragId.current) {
      await onUpdate(dragId.current, { kanban_status: col });
      dragId.current = null;
    }
    setDragOverCol(null);
    setDragOverCard(null);
    setDraggingId(null);
    didDrag.current = false;
  }

  function handleCardDrop(e: React.DragEvent, targetTaskId: string, targetColId: KanbanColId) {
    const fromId = dragId.current;
    if (!fromId || fromId === targetTaskId) return;
    const fromTask = tasks.find(t => t.task_id === fromId);
    const fromCol = (fromTask?.kanban_status as KanbanColId) || "todo";

    if (fromCol === targetColId) {
      // Same column — reorder within the column using the flat task list
      e.stopPropagation();
      const fromIdx = tasks.findIndex(t => t.task_id === fromId);
      const toIdx = tasks.findIndex(t => t.task_id === targetTaskId);
      if (fromIdx === -1 || toIdx === -1) return;
      const newOrder = [...tasks];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, moved);
      dragId.current = null;
      setDragOverCol(null);
      setDragOverCard(null);
      setDraggingId(null);
      setTimeout(() => { didDrag.current = false; }, 0);
      onReorder(newOrder.map(t => t.task_id));
    }
    // Different column: let event bubble to column onDrop for status change
  }

  async function addTask(col: KanbanColId) {
    if (!newTitle.trim()) return;
    await onCreate({ title: newTitle.trim(), kanban_status: col });
    setNewTitle("");
    setAddingIn(null);
  }

  return (
    <div className="flex gap-3 items-start pb-4">
      {KANBAN_COLS.map(col => {
        const colTasks = sortColTasks(byCol[col.id], colSort[col.id]);
        const isCollapsed = collapsed.has(col.id);
        const isColOver = dragOverCol === col.id;

        if (isCollapsed) {
          return (
            <div
              key={col.id}
              className="flex-shrink-0 w-10 flex flex-col items-center py-1 gap-2 cursor-pointer group/col"
              onClick={() => toggleCollapse(col.id)}
              title={`Expand ${col.label}`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${col.dot}`} />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300 [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">
                {col.label}
              </span>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-600 tabular-nums">
                {colTasks.length}
              </span>
            </div>
          );
        }

        return (
          <div
            key={col.id}
            className={`flex-shrink-0 flex flex-col rounded-lg transition-all ${
              isColOver
                ? "border border-blue-400 dark:border-blue-500 bg-blue-50/30 dark:bg-blue-950/10"
                : "border border-transparent"
            }`}
            style={{ width: 260 }}
            onDragOver={e => { e.preventDefault(); setDragOverCol(col.id); }}
            onDragLeave={e => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverCol(null);
                setDragOverCard(null);
              }
            }}
            onDrop={() => handleColDrop(col.id)}
          >
            {/* Column header, in the CRM board's language: no filled colour
                bar, no count pill. The controls stay hidden until the column is
                hovered, so five columns no longer present fifteen buttons. */}
            <div className="sticky top-0 z-10 bg-[var(--color-paper)] flex items-center justify-between gap-1.5 mb-2 px-1 py-1 group/col">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${col.dot}`} />
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300 truncate">
                  {col.label}
                </span>
                <span className="text-xs text-zinc-400 dark:text-zinc-600 tabular-nums">{colTasks.length}</span>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover/col:opacity-100 focus-within:opacity-100 transition-opacity">
                <button
                  onClick={() => cyclColSort(col.id)}
                  className={`p-0.5 transition-colors ${
                    colSort[col.id] !== "none"
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  }`}
                  title={`Sort: ${colSort[col.id] === "none" ? "none" : colSort[col.id] === "priority" ? "priority" : "due date"}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M6 12h12M9 17h6" />
                  </svg>
                </button>
                <button
                  onClick={() => { setAddingIn(col.id); setNewTitle(""); }}
                  className="p-0.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                  title="Add task"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
                <button
                  onClick={() => toggleCollapse(col.id)}
                  className="p-0.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                  title="Collapse column"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Cards area */}
            <div className="flex-1 space-y-2">
              {colTasks.map(task => {
                const overdue = isOverdue(task.due_date, task.status);
                const priority = inferPriority(task);
                const isDone = task.status === "done";
                const isBeingDragged = draggingId === task.task_id;
                const isCardOver = dragOverCard === task.task_id;

                return (
                  <div
                    key={task.task_id}
                    draggable
                    onDragStart={() => { dragId.current = task.task_id; didDrag.current = true; setDraggingId(task.task_id); }}
                    onDragEnd={() => { dragId.current = null; setDraggingId(null); setDragOverCol(null); setDragOverCard(null); setTimeout(() => { didDrag.current = false; }, 0); }}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOverCard(task.task_id); }}
                    onDrop={e => handleCardDrop(e, task.task_id, col.id)}
                    onClick={() => { if (!didDrag.current) setEditTask(task); }}
                    className={`relative bg-white dark:bg-zinc-900 rounded-lg border p-3 cursor-pointer group transition-all ${
                      isBeingDragged
                        ? "opacity-40"
                        : isCardOver
                        ? "border-blue-400 dark:border-blue-500 shadow-sm"
                        : "border-zinc-200 dark:border-zinc-700 hover:shadow-sm hover:border-zinc-300 dark:hover:border-zinc-600"
                    }`}
                  >
                    {/* Urgency marker, matching the CRM board: a hairline inset
                        from the card edges rather than a full-height bar. Also
                        the priority control, since the badge that used to cycle
                        priority is gone. */}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        const next = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(priority) + 1) % PRIORITY_CYCLE.length];
                        onUpdate(task.task_id, { priority: next });
                      }}
                      title={`Priority: ${priority} — click to change`}
                      aria-label={`Priority: ${priority}`}
                      className={`absolute left-0 top-3 bottom-3 w-0.5 rounded hover:w-1 transition-all ${
                        priority === "high" ? "bg-red-400" :
                        priority === "medium" ? "bg-amber-400" :
                        "bg-zinc-200 dark:bg-zinc-700"
                      }`}
                    />

                    <div className="pl-3">
                      {/* Title */}
                      <div className="flex items-start gap-2">
                        {/* Completing a task used to mean dragging it to Done —
                            the only gesture the board offered. The checkbox is
                            faint until hover so it does not read as a second
                            priority marker beside the stripe, and stays visible
                            once checked so a done task can be reopened. */}
                        {/* A gutter down the left of the card: what you do with
                            the task on top, what kind of task it is beneath. Both
                            are 14px controls, so stacking them costs no width and
                            keeps the title's left edge straight. */}
                        <div className="flex flex-col items-center gap-1.5 shrink-0 mt-0.5">
                          <button
                            onClick={e => { e.stopPropagation(); onToggle(task); }}
                            aria-label={isDone ? "Mark as not done" : "Mark as done"}
                            title={isDone ? "Mark as not done" : "Mark as done"}
                            className={`w-3.5 h-3.5 shrink-0 rounded-full border flex items-center justify-center transition-all ${
                              isDone
                                ? "bg-emerald-500 border-emerald-500 text-white"
                                : "border-zinc-300 dark:border-zinc-600 text-transparent opacity-40 group-hover:opacity-100 hover:border-emerald-500 hover:text-emerald-500"
                            }`}
                          >
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3.5} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          </button>
                          <TaskTypePicker
                            type={task.activity_type}
                            onChange={next =>
                              onUpdate(task.task_id, { activity_type: next || null } as Partial<Task>)
                            }
                          />
                        </div>
                        <p className={`text-xs font-medium leading-snug flex-1 min-w-0 ${
                          isDone ? "line-through text-zinc-400 dark:text-zinc-500" : "text-gray-900 dark:text-white"
                        }`}>
                          {task.title}
                        </p>
                        {/* Assignees ride in the title row, which every card has
                            anyway. They used to anchor the due-date row, so a
                            task with no due date and nothing blocking it still
                            paid for a whole row to show one 16px icon. */}
                        <div className="flex items-center gap-0.5 shrink-0">
                          {task.assigned_to_name && (
                            <Avatar name={task.assigned_to_name} title={task.assigned_to_name} />
                          )}
                          {(task.extra_assignees ?? []).slice(0, 2).map(ea => (
                            <span key={ea.user_id} className="-ml-1 inline-flex">
                              <Avatar name={ea.name} title={ea.name} />
                            </span>
                          ))}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); onDelete(task.task_id); }}
                          className="opacity-0 group-hover:opacity-100 w-4 h-4 flex-shrink-0 flex items-center justify-center text-zinc-300 hover:text-red-400 rounded transition-all"
                          aria-label="Delete task"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>

                      {task.description && !isDone && (
                        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed mt-0.5 line-clamp-2">
                          {task.description}
                        </p>
                      )}

                      {/* Due date, blocked state and assignee as plain text.
                          Colour is reserved for the two things that actually
                          need attention: overdue and blocked. */}
                      {/* A finished card reports when, and how long it took —
                          the reason for keeping them on the board at all. */}
                      {isDone && task.completed_at && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                            Done {fmtDate(task.completed_at)}
                          </span>
                          {(() => {
                            const took = fmtElapsed(task.created_at, task.completed_at);
                            return took ? (
                              <span className="text-[11px] text-zinc-400 dark:text-zinc-500"
                                title={`Created ${fmtDate(task.created_at)}`}>
                                · took {took}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      )}

                      {!isDone && (task.due_date || (task.blocked_by_count ?? 0) > 0) && (
                        <div className="flex items-center gap-1.5 mt-1">
                          {task.due_date && (
                            <span className={`text-[11px] font-medium ${
                              overdue ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"
                            }`}>
                              {fmtDate(task.due_date)}{overdue && " · late"}
                            </span>
                          )}
                          {(task.blocked_by_count ?? 0) > 0 && (
                            <span className="text-[11px] font-medium text-orange-600 dark:text-orange-400" title="Blocked by another task">
                              blocked
                            </span>
                          )}
                        </div>
                      )}

                      {/* Context: one link, not a stack. A task on a project
                          milestone with a contact used to show all three; the
                          most specific one is the one worth clicking. */}
                      {(() => {
                        const ctx = getCardContext(task);
                        if (!ctx) return null;
                        return (
                          <div className="border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-2">
                            {/* Type gets its own line. Sharing one row with the
                                name meant the type — pinned shrink-0 — took ~96px
                                of a 260px column and truncated the name away,
                                and most project names here run past 23 chars.
                                The name is the more specific fact, so it gets
                                the full width. */}
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ctx.dot}`} />
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 truncate">
                                {ctx.kind}
                              </span>
                            </div>
                            <Link href={ctx.href} onClick={e => e.stopPropagation()}
                              className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                              title={ctx.label}>
                              {ctx.label}
                            </Link>
                          </div>
                        );
                      })()}
                      {/* Accepting a delegated task used to live in the shell's
                          My Work drawer, nowhere near the task. It belongs on
                          the card that is asking for the answer. */}
                      {col.id === "inbox" && approvals.isPending(task.task_id) && (
                        <div
                          className="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800"
                          onClick={e => e.stopPropagation()}
                        >
                          {/* Text actions, not filled buttons. Nothing else on
                              this card is a solid colour, and a blue pill made
                              the one card asking a question the loudest thing on
                              a board that had just been quietened down. */}
                          <button
                            onClick={async () => {
                              if (await approvals.respond(task.task_id, "approved")) onRefresh();
                            }}
                            disabled={approvals.isResponding(task.task_id)}
                            className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 transition-colors"
                          >
                            Accept
                          </button>
                          <span className="text-[11px] text-zinc-300 dark:text-zinc-700">·</span>
                          <button
                            onClick={async () => {
                              if (await approvals.respond(task.task_id, "denied")) onRefresh();
                            }}
                            disabled={approvals.isResponding(task.task_id)}
                            className="text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40 transition-colors"
                          >
                            Decline
                          </button>
                          {approvals.isResponding(task.task_id) && (
                            <span className="text-[11px] text-zinc-400 dark:text-zinc-600">…</span>
                          )}
                        </div>
                      )}

                      {/* A task under review says who is waiting and what they
                          were asked for. The reviewer gets the verbs; everyone
                          else just sees the state, so a card never offers a
                          decision that is not theirs to make. */}
                      {task.reviewer_id && (
                        <div
                          className="mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800"
                          onClick={e => e.stopPropagation()}
                        >
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                            {task.reviewer_id === currentUserId
                              ? "Review requested of you"
                              : `Awaiting ${task.reviewer_name || "review"}`}
                          </p>
                          {task.review_note && (
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-3">
                              {task.review_note}
                            </p>
                          )}
                          {task.reviewer_id === currentUserId && (
                            <div className="flex items-center gap-2 mt-1.5">
                              <button
                                onClick={() => resolveReview(task.task_id, "approved")}
                                disabled={resolving === task.task_id}
                                className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-emerald-600 dark:hover:text-emerald-400 disabled:opacity-40 transition-colors"
                              >
                                Approve
                              </button>
                              <span className="text-[11px] text-zinc-300 dark:text-zinc-700">·</span>
                              <button
                                onClick={() => resolveReview(task.task_id, "changes_requested")}
                                disabled={resolving === task.task_id}
                                className="text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40 transition-colors"
                              >
                                Request changes
                              </button>
                              {resolving === task.task_id && (
                                <span className="text-[11px] text-zinc-400 dark:text-zinc-600">…</span>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {!task.project_id && (
                        <div className={`relative ${
                          pickingProjectFor === task.task_id ? "mt-2" : "mt-0 hidden group-hover:block group-hover:mt-2"
                        }`}>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setPickingProjectFor(
                                pickingProjectFor === task.task_id ? null : task.task_id
                              );
                            }}
                            className="text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                          >
                            + Add to project
                          </button>
                          {pickingProjectFor === task.task_id && (
                            <ProjectPicker
                              projects={projects}
                              onCreated={(project_id, name) =>
                                onProjectCreated({ project_id, name })
                              }
                              onClose={() => setPickingProjectFor(null)}
                              onPick={async projectId => {
                                setPickingProjectFor(null);
                                await onUpdate(task.task_id, { project_id: projectId });
                              }}
                            />
                          )}
                        </div>
                      )}

                      {/* Asking for a review is only offered on work in flight,
                          and only when one is not already outstanding. */}
                      {!task.reviewer_id && col.id === "in_progress" && !isDone && (
                        <button
                          onClick={e => { e.stopPropagation(); setReviewFor(task); }}
                          className="hidden group-hover:block text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 mt-2 transition-colors"
                        >
                          Request review
                        </button>
                      )}

                      {/* The hook records a failed response but had nowhere to
                          say so; without this the restored buttons look like a
                          click that simply did not register. */}
                      {col.id === "inbox" && approvals.error && approvals.isPending(task.task_id) && (
                        <p className="text-[10px] text-red-500 mt-1">{approvals.error}</p>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Empty state, CRM-style: one dashed box, one line. A column
                  emptied by the status filter says so — otherwise "Completed
                  tasks will appear here" reads as data loss when the filter is
                  simply set to Open. */}
              {colTasks.length === 0 && addingIn !== col.id
                && !(col.id === "inbox" && suggestionCount > 0) && (
                <div className={`border border-dashed rounded-lg p-4 text-center transition-colors ${
                  isColOver ? "border-blue-400 dark:border-blue-500" : "border-zinc-200 dark:border-zinc-800"
                }`}>
                  <p className="text-xs text-zinc-400 dark:text-zinc-600">
                    {hiddenByFilter(col.id) ? `Hidden by the "${statusFilter}" filter.` : col.emptyMsg}
                  </p>
                </div>
              )}
            </div>

            {/* Inline add — the composer only; the "Add task" button that used
                to sit here permanently duplicated the + in the header. */}
            {addingIn === col.id && (
              <div className="mt-2 bg-white dark:bg-zinc-900 rounded-lg border border-blue-300 dark:border-blue-600 p-2.5">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") addTask(col.id);
                    if (e.key === "Escape") setAddingIn(null);
                  }}
                  placeholder="Task title…"
                  className="w-full text-xs bg-transparent text-gray-900 dark:text-gray-100 placeholder-zinc-400 focus:outline-none"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => addTask(col.id)}
                    className="px-2.5 py-1 text-[11px] bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setAddingIn(null)}
                    className="px-2.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {reviewFor && (
        <ReviewRequestModal
          taskTitle={reviewFor.title}
          users={users}
          currentUserId={currentUserId}
          onSubmit={(reviewerId, note) => requestReview(reviewFor.task_id, reviewerId, note)}
          onClose={() => setReviewFor(null)}
        />
      )}

      {/* Edit modal */}
      {editTask && (
        <EditTaskModal
          task={editTask}
          users={users}
          projects={projects}
          onSave={async (id, patch) => {
            await onUpdate(id, patch);
            setEditTask(prev => prev && prev.task_id === id ? { ...prev, ...patch } : prev);
          }}
          onDelete={onDelete}
          onClose={() => setEditTask(null)}
        />
      )}
    </div>
  );
}

// ─── List View ────────────────────────────────────────────────────────────────

const PRIORITY_ROW: Record<Priority, string> = {
  high: "border-l-2 border-l-red-400",
  medium: "border-l-2 border-l-amber-400",
  low: "",
};

function ListView({
  tasks,
  users,
  onReorder,
  onUpdate,
  onDelete,
  onToggle,
}: {
  tasks: Task[];
  users: User[];
  onReorder: (ids: string[]) => Promise<void>;
  onUpdate: (id: string, patch: Partial<Task> & { assignment_note?: string | null }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (task: Task) => Promise<void>;
  onCreate: (data: Partial<Task>) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEst, setEditEst] = useState("");
  const [editAssigned, setEditAssigned] = useState("");

  const [rankEditId, setRankEditId] = useState<string | null>(null);
  const [rankEditVal, setRankEditVal] = useState("");

  type SortCol = "priority" | "title" | "due_date" | "est" | "assignee" | "project";
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function handleColSort(col: SortCol) {
    if (sortCol === col) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortCol(null); }
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  const sortedTasks = useMemo(() => {
    const PORD: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
    if (!sortCol) return tasks;
    return [...tasks].sort((a, b) => {
      let cmp = 0;
      if (sortCol === "priority") {
        cmp = PORD[inferPriority(a)] - PORD[inferPriority(b)];
      } else if (sortCol === "title") {
        cmp = a.title.localeCompare(b.title);
      } else if (sortCol === "due_date") {
        if (!a.due_date && !b.due_date) cmp = 0;
        else if (!a.due_date) cmp = 1;
        else if (!b.due_date) cmp = -1;
        else cmp = a.due_date.localeCompare(b.due_date);
      } else if (sortCol === "est") {
        const ea = a.estimated_minutes ?? Infinity;
        const eb = b.estimated_minutes ?? Infinity;
        cmp = ea - eb;
      } else if (sortCol === "assignee") {
        cmp = (a.assigned_to_name ?? "").localeCompare(b.assigned_to_name ?? "");
      } else if (sortCol === "project") {
        cmp = (a.project_name ?? "").localeCompare(b.project_name ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [tasks, sortCol, sortDir]);

  const dragTask = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Pause polling while a row is being edited, re-ranked, or dragged.
  useRefreshHold(editingId !== null || rankEditId !== null || dragOver !== null);

  function commitRank(taskId: string, total: number) {
    const n = parseInt(rankEditVal, 10);
    setRankEditId(null);
    if (isNaN(n)) return;
    const clamped = Math.max(1, Math.min(n, total));
    const fromIdx = tasks.findIndex(t => t.task_id === taskId);
    if (fromIdx === -1) return;
    const newOrder = [...tasks];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(clamped - 1, 0, moved);
    onReorder(newOrder.map(t => t.task_id));
  }

  function startEdit(task: Task) {
    setEditingId(task.task_id);
    setEditTitle(task.title);
    setEditDue(task.due_date ?? "");
    setEditStart(task.start_date ?? "");
    setEditEst(task.estimated_minutes ? String(task.estimated_minutes) : "");
    setEditAssigned(task.assigned_to ?? "");
  }

  async function saveEdit(task: Task) {
    await onUpdate(task.task_id, {
      title: editTitle.trim() || task.title,
      due_date: editDue || null,
      start_date: editStart || null,
      estimated_minutes: editEst ? parseInt(editEst, 10) : null,
      assigned_to: editAssigned || null,
    } as Partial<Task>);
    setEditingId(null);
  }

  function handleDrop(targetId: string) {
    const fromId = dragTask.current;
    if (!fromId || fromId === targetId) { setDragOver(null); return; }
    const fromIdx = tasks.findIndex(t => t.task_id === fromId);
    const toIdx = tasks.findIndex(t => t.task_id === targetId);
    if (fromIdx < 0 || toIdx < 0) { setDragOver(null); return; }
    const newOrder = [...tasks];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    onReorder(newOrder.map(t => t.task_id));
    dragTask.current = null;
    setDragOver(null);
  }

  if (tasks.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center py-16 gap-3">
        <svg className="w-12 h-12 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        <p className="text-sm text-gray-400">No tasks match your filters.</p>
      </div>
    );
  }

  function SortHeader({ col, label, className }: { col: SortCol; label: string; className?: string }) {
    const active = sortCol === col;
    return (
      <button
        onClick={() => handleColSort(col)}
        className={`flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wider transition-colors select-none ${
          active ? "text-blue-500 dark:text-blue-400" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        } ${className ?? ""}`}
        title={active ? (sortDir === "asc" ? "Sorted ascending — click for descending" : "Sorted descending — click to clear") : `Sort by ${label}`}
      >
        {label}
        <span className="ml-0.5 w-2.5 text-center">
          {active ? (sortDir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Column headers */}
      <div
        className="grid border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-2.5"
        style={{ gridTemplateColumns: "20px 20px 32px 60px 1fr 110px 70px 130px 110px 28px" }}
      >
        <div />
        <div />
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">#</span>
        <SortHeader col="priority" label="Priority" />
        <SortHeader col="title" label="Title" />
        <SortHeader col="due_date" label="Due Date" />
        <SortHeader col="est" label="Est." />
        <SortHeader col="assignee" label="Assignee" />
        <SortHeader col="project" label="Project" />
        <div />
      </div>

      {sortedTasks.map((task, idx) => {
        const overdue = isOverdue(task.due_date, task.status);
        const priority = inferPriority(task);
        const editing = editingId === task.task_id;
        const isOver = dragOver === task.task_id;
        const rank = idx + 1;
        const isRankEditing = rankEditId === task.task_id;

        return (
          <div
            key={task.task_id}
            draggable={!sortCol}
            onDragStart={sortCol ? undefined : () => { dragTask.current = task.task_id; }}
            onDragEnd={sortCol ? undefined : () => { dragTask.current = null; setDragOver(null); }}
            onDragOver={sortCol ? undefined : (e => { e.preventDefault(); setDragOver(task.task_id); })}
            onDragLeave={sortCol ? undefined : () => setDragOver(null)}
            onDrop={sortCol ? undefined : () => handleDrop(task.task_id)}
            className={`grid items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 last:border-0 group transition-colors ${
              PRIORITY_ROW[priority]
            } ${
              isOver ? "bg-blue-50 dark:bg-blue-950/20" : "hover:bg-gray-50/50 dark:hover:bg-gray-800/20"
            }`}
            style={{ gridTemplateColumns: "20px 20px 32px 60px 1fr 110px 70px 130px 110px 28px" }}
          >
            {/* Drag handle — hidden while a column sort is active */}
            <div className={`flex items-center justify-center ${sortCol ? "opacity-0 pointer-events-none" : "cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-400"}`}>
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                <circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/>
                <circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/>
                <circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/>
              </svg>
            </div>

            {/* Checkbox */}
            <button
              onClick={() => onToggle(task)}
              className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                task.status === "done" ? "bg-green-500 border-green-500" : "border-gray-300 dark:border-gray-600 hover:border-green-400"
              }`}
              aria-label={task.status === "done" ? "Mark open" : "Mark done"}
            >
              {task.status === "done" && (
                <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>

            {/* Rank # */}
            {isRankEditing ? (
              <input
                autoFocus
                type="number"
                min={1}
                max={tasks.length}
                value={rankEditVal}
                onChange={e => setRankEditVal(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") commitRank(task.task_id, tasks.length);
                  if (e.key === "Escape") setRankEditId(null);
                }}
                onBlur={() => commitRank(task.task_id, tasks.length)}
                onClick={e => e.stopPropagation()}
                className="w-8 text-xs text-center bg-white dark:bg-gray-800 border border-blue-400 rounded px-0.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500/40 text-gray-700 dark:text-gray-200"
              />
            ) : (
              <button
                onClick={e => { e.stopPropagation(); setRankEditId(task.task_id); setRankEditVal(String(rank)); }}
                className="text-xs text-gray-300 dark:text-gray-600 hover:text-blue-500 dark:hover:text-blue-400 font-mono tabular-nums w-7 text-center transition-colors"
                title="Click to set position"
              >
                {rank}
              </button>
            )}

            {/* Priority */}
            <div className="flex items-center">
              <PriorityBadge
                priority={priority}
                onClick={e => {
                  e.stopPropagation();
                  const next = PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(priority) + 1) % PRIORITY_CYCLE.length];
                  onUpdate(task.task_id, { priority: next });
                }}
              />
            </div>

            {/* Title / Edit */}
            {editing ? (
              <div className="flex gap-1.5 items-center col-span-full pl-2 pr-6">
                <input autoFocus value={editTitle} onChange={e => setEditTitle(e.target.value)}
                       onKeyDown={e => { if (e.key === "Enter") saveEdit(task); if (e.key === "Escape") setEditingId(null); }}
                       className="flex-1 text-sm bg-white dark:bg-gray-800 border border-blue-400 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100" />
                <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)} title="Due date"
                       className="text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 focus:outline-none text-gray-900 dark:text-gray-100" />
                <input type="date" value={editStart} onChange={e => setEditStart(e.target.value)} title="Start date"
                       className="text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 focus:outline-none text-gray-900 dark:text-gray-100" />
                <input type="number" value={editEst} onChange={e => setEditEst(e.target.value)} placeholder="min"
                       className="w-16 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 focus:outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400" />
                <select value={editAssigned} onChange={e => setEditAssigned(e.target.value)}
                        className={SEL_XS}>
                  <option value="">Unassigned</option>
                  {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>)}
                </select>
                <button onClick={() => saveEdit(task)} className="text-xs text-blue-600 font-semibold hover:underline px-1">Save</button>
                <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-600 px-1">Cancel</button>
              </div>
            ) : (
              <>
                <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                  <span
                    onClick={() => startEdit(task)}
                    className={`text-sm cursor-text truncate flex-shrink min-w-0 ${task.status === "done" ? "line-through text-gray-400 dark:text-gray-600" : "text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400"} transition-colors`}
                    title={task.title}
                  >
                    {task.title}
                    {task.contact_name && (
                      <span className="text-gray-400 dark:text-gray-500 ml-1.5 font-normal text-xs">· {task.contact_name}</span>
                    )}
                  </span>
                  <TaskTypeBadge type={task.activity_type}
                    onClick={e => {
                      e.stopPropagation();
                      const types = TASK_TYPES as unknown as string[];
                      const cur = task.activity_type || "todo";
                      const next = types[(types.indexOf(cur) + 1) % types.length];
                      onUpdate(task.task_id, { activity_type: next } as Partial<Task>);
                    }}
                  />
                  {(task.blocked_by_count ?? 0) > 0 && (
                    <span className="flex-shrink-0 inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-md bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 font-semibold">⊘</span>
                  )}
                  {task.milestone_title && (
                    <Link href={task.project_id ? `/projects/${task.project_id}` : "/projects"} onClick={e => e.stopPropagation()}
                      className="flex-shrink-0 inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-medium max-w-[80px] truncate hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors" title={task.milestone_title}>◆ {task.milestone_title}</Link>
                  )}
                </span>

                {/* Due Date */}
                <span className={`text-xs font-medium ${
                  overdue ? "text-red-500" : task.due_date ? "text-gray-500 dark:text-gray-400" : "text-gray-300 dark:text-gray-700"
                }`}>
                  {task.due_date ? fmtDate(task.due_date) : "—"}
                  {overdue && <span className="ml-1 text-[10px] font-semibold">late</span>}
                </span>

                {/* Est */}
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {fmtMinutes(task.estimated_minutes) ?? "—"}
                </span>

                {/* Assignee */}
                <div className="flex items-center gap-1">
                  {task.assigned_to_name ? (
                    <>
                      <Avatar name={task.assigned_to_name} title={task.assigned_to_name} />
                      {(task.extra_assignees ?? []).slice(0, 2).map(ea => (
                        <span key={ea.user_id} className="-ml-1 inline-flex">
                          <Avatar name={ea.name} title={ea.name} />
                        </span>
                      ))}
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate ml-0.5">
                        {task.assigned_to_name.split(" ")[0]}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-gray-300 dark:text-gray-700">—</span>
                  )}
                </div>

                {/* Project / linked section */}
                {(() => {
                  const dest = getTaskDestination(task);
                  return dest ? (
                    <Link href={dest.href}
                          className="text-xs text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 hover:underline truncate font-medium"
                          onClick={e => e.stopPropagation()}>
                      {dest.label}
                    </Link>
                  ) : (
                    <span className="text-xs text-gray-300 dark:text-gray-700">—</span>
                  );
                })()}
              </>
            )}

            {/* Delete */}
            {!editing && (
              <button
                onClick={() => onDelete(task.task_id)}
                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all flex items-center justify-center w-7 h-7 rounded hover:bg-red-50 dark:hover:bg-red-950/20"
                aria-label="Delete task"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Email Suggestions Panel ──────────────────────────────────────────────────

interface EmailSuggestion {
  suggestion_id?: string;
  message_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  date: string;
  reason: string;
  suggested_action: string;
  suggested_due_date: string;
  status?: string;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function TasksPageContent() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const pendingDeletes = useRef<Set<string>>(new Set());
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<{ project_id: string; name: string; project_type?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // A failed fetch has to be visible. Silently keeping the last-known list makes
  // a broken endpoint look exactly like an empty board.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("kanban");
  const [filter, setFilter] = useState<FilterMode>("open");
  const [search, setSearch] = useState("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterPriority, setFilterPriority] = useState<Priority | "">("");
  const [filterType, setFilterType] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [modalDefaultCol, setModalDefaultCol] = useState<KanbanColId | undefined>(undefined);
  // Opens on your own work; "All" widens it to the team, as does clearing the
  // assignee filter. Stored prefs override this on the next visit.
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [isAdmin, setIsAdmin] = useState(false);
  // Needed so New Task can pre-select you: every task must have an assignee, and
  // the form should show who that is rather than leaving it blank.
  const [currentUserId, setCurrentUserId] = useState("");
  const [messagingOpen, setMessagingOpen] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);

  // ?task=<id> opens that task's Edit Task view, wherever the link came from.
  // Fetched by id rather than looked up in `tasks`: the target is often filtered
  // out of the current board (wrong status, another user's task, past the limit).
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get("task");
  const [deepLinkTask, setDeepLinkTask] = useState<Task | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!deepLinkId) { setDeepLinkTask(null); setDeepLinkError(null); return; }
    let alive = true;
    setDeepLinkError(null);
    fetch(`/api/proxy/tasks/${deepLinkId}`, { cache: "no-store" })
      .then(async r => {
        if (!alive) return;
        if (r.ok) { setDeepLinkTask(await r.json()); return; }
        setDeepLinkError(r.status === 404 ? "That task no longer exists." : "You do not have access to that task.");
      })
      .catch(() => { if (alive) setDeepLinkError("Could not load that task."); });
    return () => { alive = false; };
  }, [deepLinkId]);

  const closeDeepLink = useCallback(() => {
    setDeepLinkTask(null);
    setDeepLinkError(null);
    router.replace("/tasks", { scroll: false });
  }, [router]);

  // Only the very first fetch blocks the view. Later fetches swap the data in
  // underneath, so a refresh never tears down the board and throws away an open
  // card, a collapsed column, or a half-finished inline edit.
  const hasLoaded = useRef(false);
  const lastLoadedAt = useRef(0);

  const load = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    else setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (filter !== "all") params.set("status", filter);
      // Under "Open", ask for recently finished work too so the Done column has
      // something in it. A window rather than everything: Done only grows, and
      // the row cap would start silently dropping open tasks to make room.
      if (filter === "open") params.set("done_within_days", "30");
      if (scope === "all") params.set("all_users", "true");
      const res = await fetch(`/api/proxy/tasks?${params}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setTasks(data.filter((t: Task) => !pendingDeletes.current.has(t.task_id)));
        setLoadError(null);
      } else {
        setLoadError(
          res.status === 401 ? "Your session expired — sign in again to see your tasks."
            : `Could not load tasks (error ${res.status}). Your tasks are still there.`
        );
      }
    } catch {
      setLoadError("Could not reach the server. Your tasks are still there.");
    } finally {
      hasLoaded.current = true;
      lastLoadedAt.current = Date.now();
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, scope]);

  // Background refresh: skipped while the tab is hidden or the user has
  // something open (modal, inline edit, drag).
  const maybeLoad = useCallback(() => {
    if (document.hidden || isRefreshHeld()) return;
    load();
  }, [load]);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/proxy/messaging/unread");
      if (res.ok) { const d = await res.json(); setUnreadMessages(d.total ?? 0); }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll so changes made elsewhere show up without a navigation. Every 2 min is
  // plenty — the events below cover anything the user does themselves.
  useEffect(() => {
    const iv = setInterval(maybeLoad, POLL_MS);
    return () => clearInterval(iv);
  }, [maybeLoad]);

  // Instantly remove a task when marked done from dashboard (same tab or cross-tab)
  useEffect(() => {
    function onTaskDone(e: Event) {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) setTasks(ts => ts.filter(t => t.task_id !== id));
    }
    // Coming back to the tab shouldn't refetch on every stray focus event —
    // only when the data is actually stale.
    function onVisible() {
      if (Date.now() - lastLoadedAt.current < STALE_MS) return;
      maybeLoad();
    }

    // Cross-tab: BroadcastChannel
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("task-updates");
      bc.onmessage = (e) => {
        if (e.data?.type === "done" && e.data?.id) {
          setTasks(ts => ts.filter(t => t.task_id !== e.data.id));
        } else {
          maybeLoad();
        }
      };
    } catch {}

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("task-assignment-accepted", maybeLoad);
    window.addEventListener("task-updated", maybeLoad);
    window.addEventListener("task-done", onTaskDone);
    return () => {
      bc?.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("task-assignment-accepted", maybeLoad);
      window.removeEventListener("task-updated", maybeLoad);
      window.removeEventListener("task-done", onTaskDone);
    };
  }, [maybeLoad]);

  useEffect(() => {
    fetch("/api/proxy/tasks/users").then(r => r.ok ? r.json() : []).then(setUsers);
    // No status filter. Projects use in_progress / waiting_sbc / waiting_client,
    // and nothing is ever "active" -- so this asked for a status that does not
    // exist and got nothing back, which is why every project dropdown on this
    // page has been empty and tasks could not be attached to anything.
    fetch("/api/proxy/projects")
      .then(r => r.ok ? r.json() : [])
      .then(data => setProjects((data.items ?? data ?? []).map(
        (p: { project_id: string; name: string; project_type?: string }) =>
          ({ project_id: p.project_id, name: p.name, project_type: p.project_type })
      )));
    fetch("/api/proxy/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.effective_permissions?.manage_users) setIsAdmin(true);
        if (d?.user_id) setCurrentUserId(d.user_id);
      });
  }, []);

  useEffect(() => {
    fetchUnread();
    const iv = setInterval(fetchUnread, 30_000);
    return () => clearInterval(iv);
  }, [fetchUnread]);

  // Only the view is remembered, so a reload or a trip to another module doesn't
  // dump you back on the Kanban board. Scope and status are deliberately not
  // persisted: the page always opens on your own open tasks, so what you see on
  // arrival never depends on where you left off days ago.
  // localStorage is client-only, so this has to run after mount rather than in a
  // state initializer, which would desync server and client markup.
  const prefsLoaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<{ view: ViewMode }>;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (p.view && ["list", "kanban", "gantt", "reports"].includes(p.view)) setView(p.view);
      }
    } catch { /* ignore unreadable prefs */ }
    prefsLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ view }));
    } catch { /* storage unavailable — not worth failing over */ }
  }, [view]);

  const onCreate = useCallback(async (data: Partial<Task>) => {
    const res = await fetch("/api/proxy/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) load();
  }, [load]);

  const onUpdate = useCallback(async (id: string, patch: Partial<Task> & { assignment_note?: string | null }) => {
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
    const next = task.status === "done" ? "open" : "done";
    // Optimistic update so the UI responds immediately
    setTasks(ts => ts.map(t => t.task_id === task.task_id ? { ...t, status: next as "open" | "done", kanban_status: next === "done" ? "done" : (t.kanban_status === "done" ? "todo" : t.kanban_status) } : t));
    const res = await fetch(`/api/proxy/tasks/${task.task_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      const updated = await res.json();
      setTasks(ts => ts.map(t => t.task_id === task.task_id ? { ...t, ...updated } : t));
      window.dispatchEvent(new Event("task-updated"));
    } else {
      // Revert on failure
      setTasks(ts => ts.map(t => t.task_id === task.task_id ? { ...t, status: task.status } : t));
    }
  }, [setTasks]);

  const onDelete = useCallback(async (id: string) => {
    pendingDeletes.current.add(id);
    setTasks(ts => ts.filter(t => t.task_id !== id));
    const res = await fetch(`/api/proxy/tasks/${id}`, { method: "DELETE" });
    pendingDeletes.current.delete(id);
    if (!res.ok && res.status !== 404) {
      // Revert: re-fetch to restore
      load();
    }
  }, [load]);

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

  // Stats
  const openCount = tasks.filter(t => t.status === "open").length;
  const overdueCount = tasks.filter(t => isOverdue(t.due_date, t.status)).length;

  // Search, assignee and priority apply the same way to every view; only the
  // status rule differs between them, so it is applied by the callers below.
  const applyFilters = useCallback((input: Task[]) => {
    let list = input;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.contact_name?.toLowerCase().includes(q) ||
        t.project_name?.toLowerCase().includes(q)
      );
    }
    if (filterAssignee) {
      // Assignment only — who created a task doesn't put it on their plate.
      // Same rule the server uses for "Mine", so All + yourself and Mine agree.
      list = list.filter(t =>
        t.assigned_to === filterAssignee ||
        t.extra_assignees?.some(a => a.user_id === filterAssignee)
      );
    }
    if (filterPriority) {
      list = list.filter(t => inferPriority(t) === filterPriority);
    }
    if (filterType) {
      // Compare canonically so "followup" and "follow_up" filter as one thing.
      list = list.filter(t => canonicalTaskType(t.activity_type) === filterType);
    }
    return list;
  }, [search, filterAssignee, filterPriority, filterType]);

  // List, Gantt and Reports: status means exactly what it says. "Open" here
  // shows open work and nothing else.
  const shown = useMemo(() => applyFilters(
    filter === "all" ? tasks : tasks.filter(t => (filter === "open" ? t.status === "open" : t.status === "done"))
  ), [tasks, filter, applyFilters]);

  // Kanban is the exception, and only under "Open": the board keeps finished
  // cards so the Done column has something in it, which is the point of the
  // column. They can only land in Done, since the column is chosen by
  // kanban_status. Without this split the other three views would start
  // listing every completed task under a filter labelled "Open".
  const kanbanShown = useMemo(() => (
    filter === "open"
      ? applyFilters(tasks.filter(t => t.status === "open" || t.kanban_status === "done"))
      : shown
  ), [tasks, filter, applyFilters, shown]);

  const hasActiveFilters = search || filterAssignee || filterPriority || filterType;

  function clearFilters() {
    setSearch("");
    setFilterAssignee("");
    setFilterPriority("");
    setFilterType("");
  }

  return (
    <div className="space-y-2.5 max-w-full">
      {/* ── One bar. View, scope and search stay visible because they change
             what you are looking at; everything that merely narrows it lives
             behind Filters, which shows a dot when it is doing something. ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* View */}
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
          {(["list", "kanban", "gantt", "reports"] as ViewMode[]).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all capitalize ${view === v ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"}`}>
              {v}
            </button>
          ))}
        </div>

        {/* Scope */}
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
          {(["mine", "all"] as const).map(s => (
            // Leaving "All" also drops the assignee filter — its control is
            // hidden under "Mine", so a stale value would narrow the board with
            // nothing on screen to explain why.
            <button key={s} onClick={() => { setScope(s); if (s === "mine") setFilterAssignee(""); }}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${scope === s ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
              {s === "mine" ? "Mine" : "All"}
            </button>
          ))}
        </div>

        {view !== "reports" && (
          <div className="relative flex-1 min-w-[140px] max-w-[220px]">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0015.803 15.803z" />
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        )}

        {/* Filters — status, priority and assignee, none of which need to be on
            screen to be understood. The dot is the only always-visible part. */}
        {view !== "reports" && (
          <div className="relative">
            <button onClick={() => setFiltersOpen(o => !o)}
              className={`flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg border transition-colors ${
                hasActiveFilters || filter !== "open"
                  ? "border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40"
                  : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
              </svg>
              Filters
            </button>

            {filtersOpen && (
              <div className="absolute left-0 top-full mt-1.5 z-30 w-56 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl p-3 space-y-2.5">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Status</p>
                  <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
                    {(["open", "done", "all"] as FilterMode[]).map(f => (
                      <button key={f} onClick={() => setFilter(f)}
                        className={`flex-1 px-2 py-1 rounded text-xs font-medium capitalize transition-all ${filter === f ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm" : "text-gray-500 dark:text-gray-400"}`}>
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                <select value={filterPriority} onChange={e => setFilterPriority(e.target.value as Priority | "")} className={`${SEL_XS} w-full`}>
                  <option value="">Any priority</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>

                <select value={filterType} onChange={e => setFilterType(e.target.value)} className={`${SEL_XS} w-full`}>
                  <option value="">Any type</option>
                  {TASK_TYPES.map(t => (
                    <option key={t} value={t}>{TASK_TYPE_META[t]?.label ?? t}</option>
                  ))}
                </select>

                {scope === "all" && users.length > 1 && (
                  <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} className={`${SEL_XS} w-full`}>
                    <option value="">Any assignee</option>
                    {users.map(u => <option key={u.user_id} value={u.user_id}>{u.name || u.email}</option>)}
                  </select>
                )}

                {(hasActiveFilters || filter !== "open") && (
                  <button onClick={() => { clearFilters(); setFilter("open"); }}
                    className="w-full text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-1 transition-colors">
                    Reset filters
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Counts. Overdue is the only one that ever needs to catch the eye. */}
        <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{openCount} open</span>
        {overdueCount > 0 && <span className="text-xs text-red-500 font-medium tabular-nums">{overdueCount} overdue</span>}
        {refreshing && (
          <span className="w-3 h-3 border border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin" title="Refreshing…" />
        )}

        {/* Messages — renamed from "Inbox", which now names the kanban column. */}
        <button onClick={() => setMessagingOpen(true)} title="Messages"
          className="relative p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          {unreadMessages > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 bg-blue-600 rounded flex items-center justify-center text-[9px] font-bold text-white">
              {unreadMessages > 9 ? "9+" : unreadMessages}
            </span>
          )}
        </button>

        <button onClick={() => { setModalDefaultCol(undefined); setShowModal(true); }}
          className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Task
        </button>
      </div>


      <MyResponsibilities />

      {/* Surfaced rather than swallowed: an empty board and a failed fetch look
          identical otherwise, which is how a 500 can hide behind a task count. */}
      {loadError && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3">
          <svg className="w-5 h-5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-sm text-amber-800 dark:text-amber-300 flex-1">{loadError}</p>
          <button
            onClick={load}
            disabled={refreshing}
            className="text-xs font-medium text-amber-800 dark:text-amber-300 underline underline-offset-2 hover:no-underline disabled:opacity-40"
          >
            Try again
          </button>
        </div>
      )}

      {/* ── Views ── */}
      {loading ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center py-20 gap-3">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-400">Loading tasks…</p>
        </div>
      ) : view === "list" ? (
        <ListView
          tasks={shown}
          users={users}
          onReorder={onReorder}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onToggle={onToggle}
          onCreate={onCreate}
        />
      ) : view === "kanban" ? (
        <KanbanView
          tasks={kanbanShown}
          users={users}
          projects={projects}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onCreate={(data) => onCreate({ ...data })}
          onReorder={onReorder}
          onRefresh={load}
          onToggle={onToggle}
          onProjectCreated={p => setProjects(prev =>
            // Guard against listing it twice if two cards create the same name.
            prev.some(x => x.project_id === p.project_id) ? prev : [...prev, p]
          )}
          currentUserId={currentUserId}
          statusFilter={filter}
        />
      ) : view === "gantt" ? (
        <GanttView
          tasks={shown}
          onUpdate={onUpdate}
          onToggle={onToggle}
          onDelete={onDelete}
        />
      ) : (
        <ReportsPanel isAdmin={isAdmin} />
      )}

      {/* ── New Task Modal ── */}
      {showModal && (
        <NewTaskModal
          users={users}
          projects={projects}
          defaultKanbanStatus={modalDefaultCol}
          currentUserId={currentUserId}
          onSubmit={onCreate}
          onClose={() => setShowModal(false)}
        />
      )}

      {/* ── Deep-linked task (?task=<id>) ── */}
      {deepLinkTask && (
        <EditTaskModal
          task={deepLinkTask}
          users={users}
          projects={projects}
          onSave={async (id, patch) => {
            await onUpdate(id, patch);
            setDeepLinkTask(prev => prev && prev.task_id === id ? { ...prev, ...patch } : prev);
          }}
          onDelete={async (id) => { await onDelete(id); closeDeepLink(); }}
          onClose={closeDeepLink}
        />
      )}
      {deepLinkError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeDeepLink}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-2xl px-6 py-5 max-w-sm" onClick={e => e.stopPropagation()}>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{deepLinkError}</p>
            <button onClick={closeDeepLink}
              className="mt-4 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Messaging Drawer ── */}
      <MessagingDrawer
        open={messagingOpen}
        onClose={() => { setMessagingOpen(false); fetchUnread(); }}
        onUnreadChange={fetchUnread}
      />
    </div>
  );
}

// useSearchParams needs a Suspense boundary in the App Router.
export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageContent />
    </Suspense>
  );
}
