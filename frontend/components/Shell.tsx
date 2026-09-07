"use client";

import Link from "next/link";
import { usePartnerModules } from "@/lib/usePartnerModules";
import { Avatar } from "@/components/Avatar";
import { usePathname, useSearchParams } from "next/navigation";
import React, { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { SessionProvider, useSession, signOut } from "next-auth/react";
import DarkModeToggle from "@/components/DarkModeToggle";
import { DevModeProvider, useDevMode } from "@/components/DevModeContext";
import LogoImage from "@/components/LogoImage";
import TimeTrackingPanel from "@/components/TimeTrackingPanel";
import RolesPanel from "@/components/RolesPanel";
import TeamPanel from "@/components/TeamPanel";
import AssignmentToasts from "@/components/tasks/AssignmentToasts";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Icons ──────────────────────────────────────────────────────────────────

const AnalysesIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
  </svg>
);

const LiteratureIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
  </svg>
);

const StrainsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.871 4A17.926 17.926 0 003 12c0 2.874.673 5.59 1.871 8m14.13 0a17.926 17.926 0 001.87-8c0-2.874-.673-5.59-1.87-8M9 9h1.246a1 1 0 01.961.725l1.586 5.55a1 1 0 00.961.725H15m1-7h-.08a2 2 0 00-1.519.698L9.6 15.302A2 2 0 018.08 16H8" />
  </svg>
);

const KbIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

const RunsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
  </svg>
);

const EnzymeIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
    <circle cx="12" cy="8" r="1.5" strokeWidth={1.5} />
  </svg>
);

const ProtocolIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
  </svg>
);

const FpaIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const NotebookIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

const UsersIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const ContactsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

const ProjectsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
  </svg>
);

const TasksIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12l2 2 4-4" />
  </svg>
);

const CalendarIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008zm6.75-4.5h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V15zm0 2.25h.008v.008h-.008v-.008zm2.25-4.5h.008v.008H16.5v-.008zm0 2.25h.008v.008H16.5V15z" />
  </svg>
);

const ReportsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
  </svg>
);

const ClockIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const FundingIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
  </svg>
);

const InvoiceIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const PayablesIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
  </svg>
);

const SystemDesignIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
  </svg>
);

const InventoryIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
);

const PortalsIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  </svg>
);

const MarketingIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
  </svg>
);

// ── Nav structure ──────────────────────────────────────────────────────────

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  sub?: { href: string; label: string; permission?: string }[];
  permission?: string; // permission key required to show this item (null = always visible)
  activePaths?: string[]; // additional paths that count as active for this item
}

const LearnIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

const PartnersIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
);

const ActivityIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const PRIMARY: NavItem[] = [
  { href: "/tasks",     label: "Tasks",     icon: TasksIcon,     activePaths: ["/tasks", "/reports"], permission: "projects" },
  { href: "/calendar",  label: "Calendar",  icon: CalendarIcon,  permission: "calendar" },
];

// The Learning Center is visible to staff too — they need to review what the
// partner cohorts are being shown.
const LEARN: NavItem[] = [
  { href: "/learn", label: "Learning", icon: LearnIcon, permission: "learn" },
];

// External partners get their own sidebar rather than the staff tree with rows
// filtered out: most staff nav items carry no permission key, so filtering
// alone would leak Tasks, Calendar, CRM and Portals to every partner.
//
// Built from the API's module list so this sidebar, the grant checkboxes in
// Users, and the API's own guard cannot drift apart — a cohort can never be
// granted a module the partner has no way to reach, and the labels here are
// the same module names an admin ticked.
const PARTNER_NAV_ICONS: Record<string, React.ReactNode> = {
  learn:        LearnIcon,
  protocols:    ProtocolIcon,
  strains:      InventoryIcon,
  log_runs:     RunsIcon,
  notebook:     NotebookIcon,
  literature:   LiteratureIcon,
  queue_upload: LiteratureIcon,
  analyses:     AnalysesIcon,
  model:        AnalysesIcon,
  compounds:    AnalysesIcon,
  system_design: SystemDesignIcon,
  projects:     ProjectsIcon,
};



const SALES: NavItem[] = [
  { href: "/crm",       label: "CRM",       icon: UsersIcon,     permission: "contacts" },
  { href: "/projects?tab=crm_opportunity",  label: "Projects",  icon: ProjectsIcon,  permission: "projects" },
  { href: "/marketing", label: "Marketing", icon: MarketingIcon, activePaths: ["/marketing"], permission: "marketing" },
  { href: "/portals",   label: "Portals",   icon: PortalsIcon,   permission: "portals" },
  { href: "/contacts",  label: "Contacts",  icon: ContactsIcon,  permission: "contacts" },
];

const ACCOUNTING: NavItem[] = [
  { href: "/fpa",       label: "FP&A",      icon: FpaIcon,       permission: "view_fpa" },
  { href: "/funding",   label: "Funding",   icon: FundingIcon,   permission: "funding" },
  { href: "/invoices",  label: "Receivables",  icon: InvoiceIcon, permission: "invoices" },
  { href: "/payables",  label: "Payables",  icon: PayablesIcon,  permission: "payables" },
];

const AgentManagerIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
  </svg>
);

const LcaAdminIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
);

const ADMIN: NavItem[] = [
  { href: "/admin/users",          label: "Users",          icon: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  ), permission: "manage_users" },
  { href: "/admin/agent-manager",  label: "Agent Manager",  icon: AgentManagerIcon, permission: "manage_users" },
  { href: "/admin/learning",       label: "Course Content", icon: PartnersIcon,     permission: "manage_partners",
    activePaths: ["/admin/learning"] },
  { href: "/admin/activity",       label: "Activity",       icon: ActivityIcon,     permission: "view_activity" },
];


// ── Title helper ───────────────────────────────────────────────────────────

/** True for partner accounts, including sessions still carrying the old
 *  `student` role name from before migration 159. */
function isPartnerRole(role: string | undefined): boolean {
  return role === "partner" || role === "student";
}

function pageTitleFromPath(pathname: string): string {
  if (pathname.startsWith("/queue")) return "Review Queue";
  if (pathname.startsWith("/compounds")) return "Compounds";
  if (pathname.startsWith("/kb")) return "Knowledge Base";
  if (pathname.startsWith("/fpa")) return "FP&A";
  if (pathname.startsWith("/admin/agent-manager")) return "Agent Manager";
  if (pathname.startsWith("/admin/users")) return "Users";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/tasks")) return "Tasks";
  if (pathname.startsWith("/contacts")) return "Contacts";
  if (pathname.startsWith("/projects/advisors")) return "Advisors";
  if (pathname.startsWith("/projects")) return "Projects";
  if (pathname.startsWith("/crm/sales-pipeline")) return "Sales Pipeline";
  if (pathname.startsWith("/crm")) return "CRM";
  if (pathname.startsWith("/funding")) return "Funding";
  if (pathname.startsWith("/invoices")) return "Receivables";
  if (pathname.startsWith("/payables")) return "Payables";
  if (pathname.startsWith("/marketing")) return "Marketing";
  if (pathname.startsWith("/portals")) return "Portals";
  if (pathname.startsWith("/reports")) return "Reports";
  if (pathname.startsWith("/inventory")) return "Inventory";
  return "Open ERP";
}

function moduleKeyFromPath(pathname: string): string | null {
  if (pathname.startsWith("/tasks")) return null;
  if (pathname.startsWith("/reports")) return null;
  if (pathname.startsWith("/crm")) return "crm";
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/portals")) return "portals";
  if (pathname.startsWith("/contacts")) return "contacts";
  if (pathname.startsWith("/fpa")) return "fpa";
  if (pathname.startsWith("/funding")) return "funding";
  if (pathname.startsWith("/invoices")) return "receivables";
  if (pathname.startsWith("/payables")) return "payables";
  if (pathname.startsWith("/kb")) return "literature";
  if (pathname.startsWith("/inventory")) return "inventory";
  if (pathname.startsWith("/marketing")) return "marketing";
  return null;
}

// ── NavLink ────────────────────────────────────────────────────────────────

function NavLink({ href, label, icon, active, collapsed }: { href: string; label: string; icon: React.ReactNode; active: boolean; collapsed?: boolean }) {
  return (
    <Link
      href={href}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex items-center rounded-md text-sm font-medium transition-colors min-h-[28px] ${
        collapsed ? "justify-center p-1.5" : "gap-2 px-2.5 py-1"
      } ${
        active
          ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
          : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
      }`}
    >
      <span aria-hidden="true" className={active ? "text-blue-600 dark:text-blue-400" : "text-gray-400 dark:text-gray-500"}>{icon}</span>
      {!collapsed && label}
    </Link>
  );
}

// ── DevToggle ──────────────────────────────────────────────────────────────

function DevToggle() {
  const { devMode, toggleDevMode } = useDevMode();
  return (
    <button
      onClick={toggleDevMode}
      aria-label={devMode ? "Disable developer mode" : "Enable developer mode"}
      aria-pressed={devMode}
      className={`text-xs font-mono px-2 py-1 rounded border transition-colors ${
        devMode
          ? "border-amber-400 text-amber-400 bg-amber-950 shadow-[0_0_6px_rgba(251,191,36,0.4)]"
          : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      }`}
    >
      <span aria-hidden="true">{devMode ? "⚙ DEV" : "⚙"}</span>
    </button>
  );
}

// ── Module Owner Badge ─────────────────────────────────────────────────────

interface ModuleOwner {
  module_key: string;
  module_label: string;
  user_id: string;
  user_email: string;
  user_name: string;
}

function ModuleOwnerBadge({
  moduleKey,
  owner,
  isAdmin,
  onOwnerChange,
}: {
  moduleKey: string;
  owner: ModuleOwner | null;
  isAdmin: boolean;
  onOwnerChange: (moduleKey: string, owner: ModuleOwner | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    if (users.length === 0) {
      fetch("/api/proxy/messaging/users")
        .then(r => r.ok ? r.json() : [])
        .then(setUsers)
        .catch(() => {});
    }
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [pickerOpen, users.length]);

  async function assign(user: TeamUser) {
    setSaving(true);
    try {
      const res = await fetch(`/api/proxy/module-owners/${moduleKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: user.user_id, user_email: user.email, user_name: user.name ?? user.email }),
      });
      if (res.ok) {
        onOwnerChange(moduleKey, {
          module_key: moduleKey,
          module_label: owner?.module_label ?? moduleKey,
          user_id: user.user_id,
          user_email: user.email,
          user_name: user.name ?? user.email,
        });
        setPickerOpen(false);
      }
    } finally { setSaving(false); }
  }

  async function remove() {
    setSaving(true);
    try {
      const res = await fetch(`/api/proxy/module-owners/${moduleKey}`, { method: "DELETE" });
      if (res.ok) { onOwnerChange(moduleKey, null); setPickerOpen(false); }
    } finally { setSaving(false); }
  }

  return (
    <div className="relative flex items-center" ref={ref}>
      {owner ? (
        <button
          onClick={() => isAdmin && setPickerOpen(o => !o)}
          title={`Owner: ${owner.user_name}`}
          className={`flex items-center gap-1.5 ${isAdmin ? "cursor-pointer hover:opacity-80" : "cursor-default"} transition-opacity`}
        >
          <Avatar name={owner.user_name} size={5} />
          <span className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:block">{owner.user_name.split(" ")[0]}</span>
        </button>
      ) : (
        <button
          onClick={() => isAdmin && setPickerOpen(o => !o)}
          disabled={!isAdmin}
          title={isAdmin ? "Assign owner" : "No owner assigned"}
          className={`flex items-center gap-1.5 ${isAdmin ? "cursor-pointer hover:opacity-80" : "cursor-default"} transition-opacity`}
        >
          <Avatar name={null} size={5} />
          <span className="text-xs text-zinc-400 dark:text-zinc-500 hidden sm:block">
            {isAdmin ? "Assign" : "Unassigned"}
          </span>
        </button>
      )}

      {pickerOpen && (
        <div className="absolute left-0 top-full mt-1.5 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 px-3 pt-2.5 pb-1 uppercase tracking-wider">Assign owner</p>
          <div className="max-h-48 overflow-y-auto">
            {users.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-2">Loading…</p>
            ) : users.map(u => (
              <button
                key={u.user_id}
                onClick={() => assign(u)}
                disabled={saving}
                className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left ${owner?.user_id === u.user_id ? "bg-indigo-50 dark:bg-indigo-950/30" : ""}`}
              >
                <Avatar name={u.name || u.email} size={5} />
                <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{u.name || u.email}</span>
                {owner?.user_id === u.user_id && (
                  <svg className="w-3 h-3 text-indigo-500 ml-auto shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.704 5.296a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-3-3a1 1 0 011.414-1.414L9 11.586l6.29-6.29a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
          </div>
          {owner && (
            <div className="border-t border-gray-100 dark:border-gray-800 p-2">
              <button
                onClick={remove}
                disabled={saving}
                className="w-full text-xs text-red-500 hover:text-red-600 py-1 transition-colors"
              >
                Remove owner
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── User Profile Footer ────────────────────────────────────────────────────

export interface UserProfile {
  full_name?: string;
  title?: string;
  role?: string;
  effective_permissions?: Record<string, boolean>;
}

function UserFooter() {
  const { data: session } = useSession();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch("/api/proxy/users/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setProfile(d); })
      .catch(() => {});
  }, [session]);

  if (!session?.user) return null;

  const name = profile?.full_name || session.user.name || session.user.email || "User";
  const role = profile?.role || (session.user as { role?: string }).role || "user";
  const title = profile?.title;

  return (
    <div className="px-3 py-3 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center shrink-0 mt-0.5">
          <svg className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <Link href="/admin/users" className="min-w-0 flex-1 hover:opacity-70 transition-opacity">
          <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{name}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 capitalize">
            {role}{title ? ` · ${title}` : ""}
          </p>
        </Link>
        <Link
          href="/settings"
          aria-label="Settings"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors mt-0.5 p-1 rounded min-h-[32px] min-w-[32px] flex items-center justify-center"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          aria-label="Sign out"
          className="shrink-0 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors mt-0.5 p-1 rounded min-h-[32px] min-w-[32px] flex items-center justify-center"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Log Time Button ────────────────────────────────────────────────────────

function LogTimeButton() {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [minutes, setMinutes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!minutes || parseInt(minutes) <= 0) return;
    setSaving(true);
    try {
      await fetch("/api/proxy/time-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: desc, duration_minutes: parseInt(minutes), entry_date: new Date().toISOString().slice(0, 10) }),
      });
      setDesc("");
      setMinutes("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Log Time"
        className="flex items-center justify-center p-2 rounded-md text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
      >
        {ClockIcon}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4" role="dialog" aria-modal="true" aria-label="Log time">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Log Time</h2>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Minutes spent</label>
              <input
                type="number" min="1" max="720" required
                value={minutes} onChange={e => setMinutes(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. 45"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description (optional)</label>
              <input
                type="text"
                value={desc} onChange={e => setDesc(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="What did you work on?"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setOpen(false)} className="flex-1 px-3 py-2 text-sm rounded-md border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
              <button type="submit" disabled={saving} className="flex-1 px-3 py-2 text-sm rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50">
                {saving ? "Saving…" : "Log"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────

// ── NotificationsInbox ─────────────────────────────────────────────────────

interface AppNotification {
  notification_id: string;
  notification_type: string;
  entity_type: string;
  entity_id: string;
  title: string;
  message: string | null;
  status: string;
  created_at: string;
  sender_name: string | null;
  sender_email: string | null;
}

interface TeamUser { user_id: string; name: string | null; email: string; }

function NotificationsInbox() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [responding, setResponding] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  // Compose state
  const [composing, setComposing] = useState(false);
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
  const [composeTitle, setComposeTitle] = useState("");
  const [composeMsg, setComposeMsg] = useState("");
  const [composeRecipients, setComposeRecipients] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch("/api/proxy/notifications");
      if (res.ok) {
        const d = await res.json();
        setNotifications(d.notifications ?? []);
        // The badge counts only the notifications where someone is waiting on
        // you -- a task handed over, a review asked of you, a review verdict.
        // Notebook shares, portal views and messages still list below, they
        // just do not light the bell.
        setUnreadCount(d.actionable_unread_count ?? d.assignment_unread_count ?? 0);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    load();
    const iv = setInterval(load, 60_000);
    return () => clearInterval(iv);
  }, [session, load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  async function respond(id: string, action: "approved" | "denied") {
    setResponding(prev => new Set([...prev, id]));
    try {
      const res = await fetch(`/api/proxy/notifications/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setNotifications(prev => prev.map(n => n.notification_id === id ? { ...n, status: action } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));
        if (action === "approved") {
          window.dispatchEvent(new CustomEvent("task-assignment-accepted"));
        }
      }
    } finally {
      setResponding(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  }

  async function markRead(id: string) {
    await fetch(`/api/proxy/notifications/${id}/read`, { method: "PATCH" }).catch(() => {});
    setNotifications(prev => prev.map(n => n.notification_id === id ? { ...n, status: "read" } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  }

  async function deleteNotification(id: string) {
    const n = notifications.find(x => x.notification_id === id);
    setNotifications(prev => prev.filter(x => x.notification_id !== id));
    if (n?.status === "pending") setUnreadCount(prev => Math.max(0, prev - 1));
    await fetch(`/api/proxy/notifications/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const [clearing, setClearing] = useState(false);
  const [keptNote, setKeptNote] = useState<string | null>(null);
  const [keptCount, setKeptCount] = useState(0);

  // Two steps on purpose. The first click clears everything that is merely
  // informational; assignments still awaiting an accept/decline survive it,
  // because deleting them takes away the Inbox card's Accept and Decline while
  // leaving the task sitting there. Wiping those is a second, explicit click —
  // which matters here, where most of the backlog IS pending assignments and a
  // one-shot "clear all" would quietly discard 50-odd open decisions.
  async function clearAll(includePending: boolean) {
    if (clearing) return;
    setClearing(true);
    setKeptNote(null);
    try {
      const url = includePending
        ? "/api/proxy/notifications?include_pending=true"
        : "/api/proxy/notifications";
      const res = await fetch(url, { method: "DELETE" });
      if (res.ok) {
        const d = await res.json();
        const kept = d.kept_awaiting_response ?? 0;
        setNotifications(prev =>
          includePending
            ? []
            : prev.filter(n => n.status === "pending" && n.notification_type === "task_assigned")
        );
        setUnreadCount(kept);
        setKeptCount(kept);
        setKeptNote(kept > 0 ? `${kept} awaiting your response were kept` : null);
      }
    } catch { /* leave the list as-is; the next poll re-syncs */ }
    finally { setClearing(false); }
  }

  function openCompose() {
    setComposing(true);
    setComposeTitle(""); setComposeMsg(""); setComposeRecipients([]); setSendResult(null);
    if (teamUsers.length === 0) {
      fetch("/api/proxy/messaging/users")
        .then(r => r.ok ? r.json() : [])
        .then(setTeamUsers)
        .catch(() => {});
    }
  }

  async function sendNotification(e: React.FormEvent) {
    e.preventDefault();
    if (!composeTitle.trim() || composeRecipients.length === 0 || sending) return;
    setSending(true); setSendResult(null);
    try {
      const res = await fetch("/api/proxy/notifications/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient_ids: composeRecipients, title: composeTitle.trim(), message: composeMsg.trim() || null }),
      });
      if (res.ok) {
        const d = await res.json();
        setSendResult(`Sent to ${d.sent} recipient${d.sent === 1 ? "" : "s"}`);
        setComposeTitle(""); setComposeMsg(""); setComposeRecipients([]);
        setTimeout(() => { setComposing(false); setSendResult(null); }, 1500);
      } else {
        setSendResult("Failed to send");
      }
    } finally { setSending(false); }
  }

  function toggleRecipient(uid: string) {
    setComposeRecipients(prev =>
      prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid]
    );
  }

  function fmtRelative(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function entityLink(n: AppNotification) {
    if (n.entity_type === "task") return `/tasks`;
    if (n.entity_type === "project") return `/projects?tab=crm_opportunity`;
    return "#";
  }

  if (!session) return null;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        aria-label="Notifications"
        className="relative p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 bg-red-500 rounded flex items-center justify-center text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-2xl shadow-black/10 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</span>
              {unreadCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-900">
                  {unreadCount} waiting
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!composing && notifications.length > 0 && (
                <button
                  onClick={() => clearAll(false)}
                  disabled={clearing}
                  title="Clear notifications (keeps anything awaiting your response)"
                  className="p-1 rounded text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              )}
              <button
                onClick={composing ? () => setComposing(false) : openCompose}
                title={composing ? "Back to inbox" : "Send a notification"}
                className="p-1 rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                {composing ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
                  </svg>
                )}
              </button>
              <Link href="/settings#notifications" onClick={() => setOpen(false)}
                className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline font-medium">
                Settings
              </Link>
            </div>
          </div>

          {keptNote && !composing && (
            <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-800">
              <p className="text-[10px] text-gray-500 dark:text-gray-400 flex-1">{keptNote}</p>
              {keptCount > 0 && (
                <button
                  onClick={() => clearAll(true)}
                  disabled={clearing}
                  className="text-[10px] font-medium text-red-500 hover:text-red-600 dark:hover:text-red-400 hover:underline disabled:opacity-40"
                >
                  Clear those too
                </button>
              )}
            </div>
          )}

          {/* Compose panel */}
          {composing ? (
            <form onSubmit={sendNotification} className="p-4 space-y-3">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">Send notification</p>

              {/* Recipient picker */}
              <div>
                <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1.5">To</p>
                <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
                  {teamUsers.length === 0 ? (
                    <p className="text-[10px] text-gray-400">Loading team…</p>
                  ) : teamUsers.map(u => (
                    <label key={u.user_id} className="flex items-center gap-2 cursor-pointer group">
                      <input type="checkbox"
                        checked={composeRecipients.includes(u.user_id)}
                        onChange={() => toggleRecipient(u.user_id)}
                        className="w-3 h-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <Avatar name={u.name || u.email} size={4} />
                      <span className="text-[11px] text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100 truncate">
                        {u.name || u.email}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div>
                <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1">Title</p>
                <input
                  value={composeTitle} onChange={e => setComposeTitle(e.target.value)}
                  placeholder="Notification title…"
                  maxLength={120}
                  className="w-full text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                />
              </div>

              {/* Message */}
              <div>
                <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1">Message (optional)</p>
                <AutoTextarea
                  value={composeMsg} onChange={e => setComposeMsg(e.target.value)}
                  placeholder="Additional details…"
                  rows={2}
                  className="w-full text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none"
                />
              </div>

              {sendResult && (
                <p className={`text-[10px] font-medium ${sendResult.startsWith("Sent") ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                  {sendResult}
                </p>
              )}

              <button type="submit"
                disabled={!composeTitle.trim() || composeRecipients.length === 0 || sending}
                className="w-full py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-semibold transition-colors">
                {sending ? "Sending…" : `Send${composeRecipients.length > 0 ? ` to ${composeRecipients.length}` : ""}`}
              </button>
            </form>
          ) : (
            /* Notification list */
            <div className="overflow-y-auto max-h-96">
              {loading && notifications.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                  <svg className="w-8 h-8 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm text-gray-400">All caught up</p>
                </div>
              ) : (
                notifications.map(n => {
                  const isPending = n.status === "pending";
                  const isResponding = responding.has(n.notification_id);
                  return (
                    <div key={n.notification_id}
                      className={`group px-4 py-3 border-b border-gray-50 dark:border-gray-800 last:border-0 transition-colors ${
                        isPending ? "bg-blue-50/30 dark:bg-blue-950/10" : ""
                      }`}>
                      <div className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${isPending ? "bg-blue-500" : "bg-gray-300 dark:bg-gray-600"}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 dark:text-gray-100 leading-snug">{n.title}</p>
                          {n.sender_name && (
                            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">from {n.sender_name}</p>
                          )}
                          {n.message && (
                            <p className="text-[10px] text-gray-500 dark:text-gray-400 italic mt-0.5 line-clamp-2">"{n.message}"</p>
                          )}
                          <div className="flex items-center gap-2 mt-1.5">
                            {n.entity_type !== "general" && (
                              <Link href={entityLink(n)} onClick={() => setOpen(false)}
                                className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline font-medium">
                                View →
                              </Link>
                            )}
                            <span className="text-[10px] text-gray-400">{fmtRelative(n.created_at)}</span>
                          </div>
                          {isPending && n.notification_type !== "general" && (
                            <div className="flex gap-1.5 mt-2">
                              <button
                                onClick={() => respond(n.notification_id, "approved")}
                                disabled={isResponding}
                                className="flex-1 text-[10px] py-1 rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-medium transition-colors"
                              >
                                {isResponding ? "…" : "Accept"}
                              </button>
                              <button
                                onClick={() => respond(n.notification_id, "denied")}
                                disabled={isResponding}
                                className="flex-1 text-[10px] py-1 rounded-md border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                              >
                                {isResponding ? "…" : "Deny"}
                              </button>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => deleteNotification(n.notification_id)}
                          title="Remove"
                          className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-400 dark:hover:text-red-400 transition-all"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── DevAgentPanel ──────────────────────────────────────────────────────────
// Floating panel shown to admins when devMode is on — quick access to all
// agent configs from any page without navigating to /admin/agent-manager.

function DevAgentPanel() {
  const { devMode } = useDevMode();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<{ agent_id: string; display_name: string; module: string; model: string; wired: boolean; has_override: boolean }[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (open && !loaded) {
      fetch("/api/proxy/agent-manager/agents")
        .then(r => r.ok ? r.json() : [])
        .then(data => { setAgents(data); setLoaded(true); })
        .catch(() => setLoaded(true));
    }
  }, [open, loaded]);

  if (!devMode) return null;

  return (
    <>
      {/* Floating trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-16 right-4 z-40 flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-mono font-semibold rounded shadow-lg shadow-amber-500/30 transition-all hover:shadow-xl"
        title="Open Agent Panel"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
        </svg>
        Agents
      </button>

      {/* Slide-over panel */}
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-2xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-amber-50 dark:bg-amber-950/30">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-amber-700 dark:text-amber-400">⚙ DEV — AGENTS</span>
              </div>
              <div className="flex items-center gap-2">
                <Link href="/admin/agent-manager"
                  className="text-xs text-amber-600 dark:text-amber-400 hover:underline font-medium"
                  onClick={() => setOpen(false)}>
                  Full Manager →
                </Link>
                <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto py-2">
              {!loaded ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : agents.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No agents found</p>
              ) : (
                agents.map(agent => (
                  <div key={agent.agent_id} className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{agent.display_name}</span>
                        {agent.has_override && <span className="text-[10px] text-blue-500 dark:text-blue-400 flex-shrink-0">• mod</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-400 font-mono">
                          {agent.model.replace("claude-", "").replace("-20250514", "").replace("-20251001", "")}
                        </span>
                        <span className="text-[10px] text-gray-400">{agent.module}</span>
                        {agent.wired && (
                          <span className="text-[10px] text-green-500">●live</span>
                        )}
                      </div>
                    </div>
                    <Link href={`/admin/agent-manager`}
                      onClick={() => setOpen(false)}
                      className="flex-shrink-0 p-1 text-gray-400 hover:text-blue-500 rounded transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                      </svg>
                    </Link>
                  </div>
                ))
              )}
            </div>

            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
              <p className="text-[10px] text-gray-400 dark:text-gray-600">
                <span className="font-semibold text-green-500">●live</span> = overrides active at runtime.
                Others saved to DB for future wiring.
              </p>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ── DevTerminal ────────────────────────────────────────────────────────────

interface TermLine {
  ts: string;
  pipeline: string;
  fn: string | null;
  status: string;
  entity: string | null;
  msg: string | null;
  duration: number | null;
}

function DevTerminal() {
  const { devMode } = useDevMode();
  const [open, setOpen] = useState(true);
  const [lines, setLines] = useState<TermLine[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!devMode) { esRef.current?.close(); esRef.current = null; return; }
    const es = new EventSource("/api/proxy/dev/activity?since_minutes=5");
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "heartbeat" || d.type === "error") return;
        setLines(prev => {
          const next = [...prev, {
            ts: d.started_at ? new Date(d.started_at).toLocaleTimeString() : "",
            pipeline: d.pipeline ?? "?",
            fn: d.function_name ?? null,
            status: d.status ?? "running",
            entity: d.entity_id ? String(d.entity_id).slice(0, 8) : null,
            msg: d.error_message ?? null,
            duration: d.duration_ms ?? null,
          }];
          return next.slice(-200);
        });
      } catch {}
    };
    return () => { es.close(); esRef.current = null; };
  }, [devMode]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, open]);

  if (!devMode) return null;

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-30 border-t border-amber-500/40 bg-gray-950 font-mono text-xs transition-all ${open ? "h-44" : "h-7"}`}>
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 h-7 bg-gray-900 border-b border-amber-500/30 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <span className="text-amber-400 font-semibold tracking-wider">⚙ DEV TERMINAL</span>
        <div className="flex items-center gap-3">
          {lines.length > 0 && (
            <button
              onClick={e => { e.stopPropagation(); setLines([]); }}
              className="text-gray-500 hover:text-gray-300 text-[10px]"
            >
              clear
            </button>
          )}
          <span className="text-gray-500">{open ? "▾" : "▴"}</span>
        </div>
      </div>

      {/* Log output */}
      {open && (
        <div className="h-[calc(100%-1.75rem)] overflow-y-auto px-3 py-1 space-y-0">
          {lines.length === 0 ? (
            <span className="text-gray-600">waiting for activity…</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="flex items-baseline gap-2 leading-5">
                <span className="text-gray-600 shrink-0 w-16">{l.ts}</span>
                <span className={`shrink-0 w-20 truncate ${l.pipeline === "tea" ? "text-blue-400" : l.pipeline === "compound_discovery" ? "text-purple-400" : "text-green-400"}`}>
                  {l.pipeline}
                </span>
                <span className="text-gray-300 truncate flex-1">{l.fn ?? "—"}</span>
                {l.entity && <span className="text-gray-600 shrink-0">{l.entity}</span>}
                {l.duration != null && <span className="text-gray-500 shrink-0">{l.duration}ms</span>}
                <span className={`shrink-0 w-14 text-right ${l.status === "complete" ? "text-green-500" : l.status === "running" ? "text-amber-400" : l.status === "failed" ? "text-red-500" : "text-gray-500"}`}>
                  {l.status}
                </span>
                {l.msg && <span className="text-red-400 truncate max-w-xs">{l.msg}</span>}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

/** Persistent bar shown while an admin is previewing a partner account.
 *  Deliberately loud and always on screen: the most dangerous thing about a
 *  preview mode is forgetting you are in one. */
function PreviewBanner({ who }: { who: string | null }) {
  function exit() {
    // Clearing the cookie is all it takes — the proxy stops sending X-View-As,
    // so the very next request is the admin's own again.
    document.cookie = "openerp_view_as=; path=/; max-age=0";
    window.location.href = "/admin/users";
  }
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-amber-500 text-amber-950">
      <span className="text-sm font-semibold">
        Previewing as {who ?? "a partner account"}
      </span>
      <span className="text-xs opacity-80 hidden sm:inline">
        Read-only — you are seeing exactly what this partner sees.
      </span>
      <button
        onClick={exit}
        className="ml-auto px-3 py-1 rounded-md bg-amber-950 text-amber-50 text-xs font-medium hover:bg-amber-900"
      >
        Exit preview
      </button>
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectTab = searchParams.get("tab") ?? "crm_opportunity";
  const { data: session } = useSession();
  const [myPerms, setMyPerms] = useState<Record<string, boolean> | null>(null);
  // The grantable module list is served by the API, which also derives the
  // guard from it, so the sidebar cannot offer something the guard refuses.
  const { modules: partnerModules } = usePartnerModules();
  // While an admin previews a partner account, /users/me answers as that
  // partner. Driving the nav off this rather than the NextAuth session is what
  // makes the whole sidebar switch over during a preview.
  const [profileRole, setProfileRole] = useState<string | null>(null);
  const [previewOf, setPreviewOf] = useState<string | null>(null);
  const [viewingAs, setViewingAs] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [moduleOwners, setModuleOwners] = useState<Record<string, ModuleOwner>>({});

  useEffect(() => {
    setViewingAs(document.cookie.includes("openerp_view_as="));
  }, [pathname]);

  useEffect(() => {
    const stored = localStorage.getItem("sidebarCollapsed");
    if (stored === "true") setSidebarCollapsed(true);
    try {
      const secs = localStorage.getItem("collapsedSections");
      if (secs) setCollapsedSections(new Set(JSON.parse(secs)));
    } catch {}
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed(v => {
      localStorage.setItem("sidebarCollapsed", String(!v));
      return !v;
    });
  }

  function toggleSection(header: string) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(header)) next.delete(header);
      else next.add(header);
      try { localStorage.setItem("collapsedSections", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  useEffect(() => {
    if (!session) return;
    fetch("/api/proxy/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.effective_permissions) setMyPerms(d.effective_permissions);
        if (d?.role) setProfileRole(d.role);
        if (d?.full_name || d?.email) setPreviewOf(d.full_name || d.email);
      })
      .catch(() => {});
  }, [session]);

  useEffect(() => {
    if (!session) return;
    fetch("/api/proxy/module-owners")
      .then(r => r.ok ? r.json() : [])
      .then((owners: ModuleOwner[]) => {
        const map: Record<string, ModuleOwner> = {};
        for (const o of owners) map[o.module_key] = o;
        setModuleOwners(map);
      })
      .catch(() => {});
  }, [session]);

  function updateModuleOwner(moduleKey: string, owner: ModuleOwner | null) {
    setModuleOwners(prev => {
      const next = { ...prev };
      if (owner) next[moduleKey] = owner;
      else delete next[moduleKey];
      return next;
    });
  }

  if (pathname.startsWith("/login") || pathname.startsWith("/eula") || pathname.startsWith("/privacy") || pathname.startsWith("/portal/") || pathname.startsWith("/invite/") || pathname.startsWith("/investors") || pathname.startsWith("/sms-consent")) {
    return <>{children}</>;
  }

  // Read after mount, never during render: the server has no cookie jar, so
  // deriving this inline would render false on the server and true on the
  // client and trip a hydration mismatch.
  // Prefer the role the API reported over the session's: during a preview they
  // disagree, and the API's is the one everything else is enforcing against.
  const userRole = profileRole
    ?? (session?.user as { role?: string } | undefined)?.role
    ?? "user";

  // Resolve permission: use fetched effective_permissions if available, else fall back to role defaults
  function can(key: string): boolean {
    if (myPerms) return myPerms[key] ?? false;
    // Role-based fallback while permissions are loading.
    // External partners deny by default: their grants come from their
    // organisation, so guessing from the role would flash modules like System
    // Design or Literature into a partner's sidebar for a moment before
    // /users/me answers.
    if (isPartnerRole(userRole)) return false;
    if (userRole === "admin") return true;
    // The ordinary staff account, mirroring ROLE_DEFAULTS.user in auth.py:
    // everything except the money it does not own and the admin tools.
    const staffOff = ["funding", "view_fpa", "edit_fpa",
                      "manage_users", "manage_partners", "view_activity"];
    return !staffOff.includes(key);
  }

  // Partner sidebar rows, from the API's module list rather than a copy here.
  const partnerNav: NavItem[] = partnerModules.map(m => ({
    href: m.href,
    label: m.label,
    icon: PARTNER_NAV_ICONS[m.key] ?? LearnIcon,
    // Learning is the one module every partner account has, so it is never gated.
    permission: m.key === "learn" ? undefined : m.key,
  }));

  const title = pageTitleFromPath(pathname);
  const currentModuleKey = moduleKeyFromPath(pathname);
  const currentOwner = currentModuleKey ? (moduleOwners[currentModuleKey] ?? null) : null;
  const isAdmin = can("manage_users");
  // External partners never see the staff navigation tree. "student" is the
  // pre-rename name (migration 159) and still arrives in NextAuth sessions
  // issued before it, so both are treated as partner accounts.
  const isPartner = isPartnerRole(userRole);

  function renderSection(header: string, items: NavItem[]) {
    const visible = items.filter(item => !item.permission || can(item.permission));
    if (visible.length === 0) return null;
    const isSectionCollapsed = collapsedSections.has(header);
    return (
      <div>
        {!sidebarCollapsed && (
          <button
            onClick={() => toggleSection(header)}
            className="w-full flex items-center justify-between px-2.5 mb-0.5 group"
          >
            <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">{header}</span>
            <svg
              className={`w-3 h-3 text-gray-300 dark:text-gray-600 group-hover:text-gray-400 dark:group-hover:text-gray-500 transition-transform ${isSectionCollapsed ? "-rotate-90" : ""}`}
              fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}
        {!isSectionCollapsed && (
          <div className="space-y-0">
            {visible.map((item) => {
              const isActive = item.activePaths
                ? item.activePaths.some(p => pathname.startsWith(p))
                : (pathname === item.href || pathname.startsWith(item.href));
              return (
                <div key={item.href}>
                  <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive} collapsed={sidebarCollapsed} />
                  {item.sub && isActive && !sidebarCollapsed && (
                    <div className="ml-6 mt-1.5 space-y-0">
                      {item.sub.map((s) => (
                        <Link key={s.href} href={s.href} className="block px-3 py-1 rounded text-xs font-medium border border-blue-300 text-blue-600 hover:bg-blue-50 hover:border-blue-400 transition-colors text-center">
                          {s.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? "w-12" : "w-52"} shrink-0 bg-[var(--color-chrome)] border-r border-gray-200 dark:border-gray-800 flex flex-col h-screen sticky top-0 transition-all duration-200`}>
        <div className={`border-b border-gray-100 dark:border-gray-800 flex items-center ${sidebarCollapsed ? "flex-col gap-1 justify-center py-3 px-2" : "justify-between px-4 py-4"}`}>
          {sidebarCollapsed ? (
            <LogoImage className="h-7 w-auto mb-1" />
          ) : (
            <LogoImage className="h-7 w-auto" />
          )}
          <button
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            aria-controls="main-nav"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors p-1 rounded min-h-[36px] min-w-[36px] flex items-center justify-center"
          >
            <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              {sidebarCollapsed
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              }
            </svg>
          </button>
        </div>

        <nav id="main-nav" aria-label="Main navigation" className="flex-1 px-2 py-2 overflow-y-auto space-y-2">
          {isPartner ? (
            <div className="space-y-0">
              {partnerNav.filter(item => !item.permission || can(item.permission)).map(item => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  icon={item.icon}
                  active={pathname.startsWith(item.href)}
                  collapsed={sidebarCollapsed}
                />
              ))}
            </div>
          ) : (
          <>
          {/* Primary section - no header */}
          <div className="space-y-0">
            {PRIMARY.filter(item => !item.permission || can(item.permission)).map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href);
              return (
                <div key={item.href}>
                  <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive} collapsed={sidebarCollapsed} />
                  {item.sub && isActive && !sidebarCollapsed && (
                    <div className="ml-6 mt-1.5 space-y-0">
                      {item.sub.map((s) => (
                        <Link key={s.href} href={s.href} className="block px-3 py-1 rounded text-xs font-medium border border-blue-300 text-blue-600 hover:bg-blue-50 hover:border-blue-400 transition-colors text-center">
                          {s.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Learning Center */}
          {LEARN.filter(item => !item.permission || can(item.permission)).map(item => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={pathname.startsWith(item.href)}
              collapsed={sidebarCollapsed}
            />
          ))}

          {/* SALES section */}
          {renderSection("SALES", SALES)}
          {renderSection("ACCOUNTING", ACCOUNTING)}

          {/* R&D banner + Analysis + System Design */}
          {!sidebarCollapsed && (
            <p className="px-2.5 pt-0.5 pb-0.5 text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
              R&amp;D
            </p>
          )}
          {/* Analysis: single module (Analysis / ML Models / Data), no section divider */}
          {(() => {
            const item = ANALYSIS[0];
            const isActive = item.activePaths!.some(p => pathname.startsWith(p));
            const subs = (item.sub ?? []).filter(s => !s.permission || can(s.permission));
            return (
              <div className="space-y-0">
                <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive} collapsed={sidebarCollapsed} />
                {isActive && !sidebarCollapsed && (
                  <div className="ml-6 mt-1.5 space-y-0">
                    {subs.map((s) => (
                      <Link key={s.href} href={s.href} className="block px-3 py-1 rounded text-xs font-medium border border-blue-300 text-blue-600 hover:bg-blue-50 hover:border-blue-400 transition-colors text-center">
                        {s.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Literature: its own module */}
          {(() => {
            const item = LITERATURE[0];
            if (item.permission && !can(item.permission)) return null;
            return (
              <NavLink
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={pathname.startsWith(item.href)}
                collapsed={sidebarCollapsed}
              />
            );
          })()}

          {/* System Design: single module, subtabs surfaced as sub-links */}
          {(() => {
            const item = SYSTEM_DESIGN[0];
            if (item.permission && !can(item.permission)) return null;
            const isActive = pathname.startsWith(item.href);
            return (
              <div className="space-y-0">
                <NavLink href={item.href} label={item.label} icon={item.icon} active={isActive} collapsed={sidebarCollapsed} />
                {item.sub && isActive && !sidebarCollapsed && (
                  <div className="ml-6 mt-1.5 space-y-0">
                    {item.sub.map((s) => (
                      <Link key={s.href} href={s.href} className="block px-3 py-1 rounded text-xs font-medium border border-blue-300 text-blue-600 hover:bg-blue-50 hover:border-blue-400 transition-colors text-center">
                        {s.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}


          {/* ADMIN section */}
          {renderSection("ADMIN", ADMIN)}
          </>
          )}
        </nav>

        {/* User profile footer */}
        {!sidebarCollapsed && <UserFooter />}

        {/* KB + Log Time + dark mode */}
        <div className="border-t border-gray-100 dark:border-gray-800 pt-2 pb-2 px-2 flex items-center justify-around">
          <NavLink href="/kb" label="Knowledge Base" icon={KbIcon} active={pathname.startsWith("/kb")} collapsed={true} />
          <LogTimeButton />
          <DevToggle />
          <DarkModeToggle />
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex min-h-0 flex-col min-w-0">
        <header className="bg-[var(--color-chrome)] border-b border-gray-200 dark:border-gray-800 px-6 py-3 shrink-0 flex items-center justify-between">
          {/* Staff-only. The sidebar already excludes partners, but this strip
              keyed off the path alone, so a partner who reached /tasks was
              shown a Reports tab — a module no partner account can open. */}
          {!isPartner && (pathname.startsWith("/tasks") || pathname.startsWith("/reports")) ? (
            <div className="flex items-center gap-0 -ml-2">
              {([
                { label: "Tasks",     href: "/tasks",     match: "/tasks"     },
                { label: "Reports",   href: "/reports",   match: "/reports"   },
              ]).map(tab => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    pathname.startsWith(tab.match)
                      ? "border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400"
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          ) : pathname.startsWith("/contacts") ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Contacts</span>
              {currentModuleKey && <ModuleOwnerBadge moduleKey={currentModuleKey} owner={currentOwner} isAdmin={isAdmin} onOwnerChange={updateModuleOwner} />}
            </div>
          ) : pathname.startsWith("/projects") ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 overflow-x-auto">
              {([
                { key: "contracts",    label: "Contracts",       href: "/projects?tab=crm_opportunity", activeKeys: ["crm_opportunity", "portfolio"] },
                { key: "partnership",  label: "Partnerships",    href: "/projects?tab=partnership",     activeKeys: ["partnership", "advisors"] },
                { key: "grant",        label: "Grants & Funding",href: "/projects?tab=grant",           activeKeys: ["grant"] },
                { key: "internal",     label: "Operations",      href: "/projects?tab=internal",        activeKeys: ["internal"] },
                { key: "marketing",    label: "Marketing",       href: "/projects?tab=marketing",       activeKeys: ["marketing"] },
              ] as const).map(tab => {
                const currentKey = pathname.startsWith("/projects/advisors") ? "advisors" : projectTab;
                const isActive = (tab.activeKeys as readonly string[]).includes(currentKey);
                return (
                  <Link
                    key={tab.key}
                    href={tab.href}
                    className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors whitespace-nowrap ${
                      isActive
                        ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                        : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                    }`}
                  >
                    {tab.label}
                  </Link>
                );
              })}
              </div>
              {currentModuleKey && <ModuleOwnerBadge moduleKey={currentModuleKey} owner={currentOwner} isAdmin={isAdmin} onOwnerChange={updateModuleOwner} />}
            </div>
          ) : pathname.startsWith("/funding") ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 overflow-x-auto">
                {([
                  { key: "non-dilutive", label: "Applications" },
                  { key: "dilutive",     label: "Investors" },
                  { key: "plan",         label: "Plan" },
                  { key: "rounds",       label: "Rounds" },
                  { key: "management",   label: "Management" },
                  { key: "reports",      label: "Reports" },
                ] as const).map(tab => {
                  const isActive = (searchParams.get("tab") ?? "non-dilutive") === tab.key;
                  return (
                    <Link
                      key={tab.key}
                      href={`/funding?tab=${tab.key}`}
                      className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors whitespace-nowrap ${
                        isActive
                          ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                          : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                      }`}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
              </div>
              {currentModuleKey && <ModuleOwnerBadge moduleKey={currentModuleKey} owner={currentOwner} isAdmin={isAdmin} onOwnerChange={updateModuleOwner} />}
            </div>
          ) : pathname.startsWith("/crm") ? (
            <div className="flex items-center gap-2">
              <Link
                href="/crm"
                className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                  !pathname.startsWith("/crm/sales-pipeline")
                    ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                CRM
              </Link>
              <div className="flex items-center gap-1">
                <Link
                  href="/crm/sales-pipeline"
                  className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${
                    pathname.startsWith("/crm/sales-pipeline")
                      ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  Sales Pipeline
                </Link>
              </div>
              {currentModuleKey && <ModuleOwnerBadge moduleKey={currentModuleKey} owner={currentOwner} isAdmin={isAdmin} onOwnerChange={updateModuleOwner} />}
            </div>
          ) : pathname.startsWith("/tasks") ? (
            <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Tasks</h1>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
              {currentModuleKey && <ModuleOwnerBadge moduleKey={currentModuleKey} owner={currentOwner} isAdmin={isAdmin} onOwnerChange={updateModuleOwner} />}
            </div>
          )}
          {/* Right side */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {pathname.startsWith("/projects") && !pathname.startsWith("/projects/advisors") && (
              <Link
                href={`/projects?tab=${projectTab}&create=1`}
                className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1"
              >
                <span className="text-base leading-none">+</span> New Project
              </Link>
            )}
            {pathname === "/contacts" && (
              <>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("contacts:sync"))}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors font-medium"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Sync Gmail
                </button>
                <Link
                  href="/contacts?create=1"
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-medium"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  Add Contact
                </Link>
              </>
            )}
            <RolesPanel />
            <TeamPanel />
            <TimeTrackingPanel />
            <NotificationsInbox />
          </div>
        </header>
        {viewingAs && <PreviewBanner who={previewOf} />}
        <main key={pathname} id="main-content" tabIndex={-1} className={`flex-1 min-h-0 bg-[var(--color-paper)] focus:outline-none ${pathname.startsWith("/crm") || pathname.startsWith("/marketing") || pathname.startsWith("/funding") ? "overflow-hidden" : "overflow-auto p-6 pb-48"}`} suppressHydrationWarning>{children}</main>
      </div>
      <AssignmentToasts />
      {can("manage_users") && <DevAgentPanel />}
      <DevTerminal />
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DevModeProvider>
        <Suspense>
          <ShellInner>{children}</ShellInner>
        </Suspense>
      </DevModeProvider>
    </SessionProvider>
  );
}
