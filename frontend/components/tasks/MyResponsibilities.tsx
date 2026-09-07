"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The modules and projects you own, salvaged from the old TasksWidget.
 *
 * It used to be a 224px-tall scrolling list occupying a third of the dashboard.
 * It is reference material — you look at it occasionally, not while working —
 * so here it is a single collapsed line that states the count and expands on
 * click. Renders nothing at all when you own nothing.
 */

interface MyModule {
  module_key: string;
  module_label: string;
  project_id?: string;
  is_project_lead?: boolean;
}

const MODULE_PATHS: Record<string, string> = {
  tasks: "/tasks", calendar: "/calendar", reports: "/reports", notebook: "/notebook",
  crm: "/crm", projects: "/projects", portals: "/portals", contacts: "/contacts",
  fpa: "/fpa", funding: "/funding", receivables: "/invoices", payables: "/payables",
  analyses: "/analyses", model: "/model", literature: "/kb",
  "system-design": "/system-design", runs: "/runs", protocols: "/protocols",
  strains: "/strains", enzymes: "/enzymes", chemicals: "/chemicals",
  consumables: "/consumables", equipment: "/equipment", inventory: "/inventory",
  marketing: "/marketing",
};

// "dashboard" is deliberately absent from MODULE_PATHS — that route is now a
// redirect — so an unmapped module falls back to Tasks rather than a bounce.
function moduleLink(m: MyModule): string {
  if (m.is_project_lead && m.project_id) return `/projects/${m.project_id}`;
  return MODULE_PATHS[m.module_key] ?? "/tasks";
}

export default function MyResponsibilities() {
  const [modules, setModules] = useState<MyModule[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/proxy/module-owners/my")
      .then(r => r.ok ? r.json() : [])
      .then(m => { if (Array.isArray(m)) setModules(m); })
      .catch(() => {});
  }, []);

  if (modules.length === 0) return null;

  // is_project_lead is what separates the two: a project you lead is a
  // different kind of responsibility from a module you own, and lumping them
  // into one count ("you own 29 areas") said nothing useful about either.
  const projects = modules.filter(m => m.is_project_lead);
  const owned = modules.filter(m => !m.is_project_lead);

  const parts: string[] = [];
  if (owned.length) parts.push(`own ${owned.length} module${owned.length === 1 ? "" : "s"}`);
  if (projects.length) parts.push(`lead ${projects.length} project${projects.length === 1 ? "" : "s"}`);
  const summary = `You ${parts.join(" and ")}`;

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
        </svg>
        <span>{summary}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {([
            { label: "Projects you lead", items: projects, dot: "bg-emerald-500" },
            { label: "Modules you own", items: owned, dot: "bg-indigo-500" },
          ]).filter(g => g.items.length > 0).map(g => (
            <div key={g.label}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 mb-1">{g.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map(m => (
                  <Link
                    key={m.module_key}
                    href={moduleLink(m)}
                    className="inline-flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${g.dot}`} />
                    <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{m.module_label}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
