"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PROJECT_KINDS, stagesForKind, kindToPayload, type ProjectKind } from "@/lib/projectKinds";

/**
 * Attach a task to a project without opening the edit modal.
 *
 * Tasks scraped from email and meeting notes arrive with no project — that is
 * all the extraction knows — so attaching one is a triage step done many times
 * in a row. Opening a modal, finding the dropdown, saving and closing for each
 * is why it did not happen.
 *
 * Searchable because there are dozens of projects and their names run long.
 */

interface Project {
  project_id: string;
  name: string;
  project_type?: string;
}

const TYPE_LABEL: Record<string, string> = {
  crm_opportunity: "Opportunity",
  partnership: "Partnership",
  grant: "Funding",
  internal: "Operations",
  marketing: "Marketing",
  portfolio: "Portfolio",
};

export default function ProjectPicker({
  projects,
  onPick,
  onCreated,
  onClear,
  onClose,
  /** Render in the document flow instead of as a popover. Modal bodies here
   *  scroll (max-h-[70vh] overflow-y-auto), which clips an absolutely
   *  positioned panel; in flow it simply pushes the fields below it down. */
  inline = false,
}: {
  projects: Project[];
  onPick: (projectId: string) => void;
  /** Called with the new project's id after it is created. */
  onCreated?: (projectId: string, name: string) => void;
  /** Offered as "No project" when the field already has one. */
  onClear?: () => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<ProjectKind | null>(null);
  const [stage, setStage] = useState("");
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // An inline panel is dismissed by choosing something or by the field's own
    // control; closing it on any outside click would fight the form around it.
    if (inline) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [onClose, inline]);

  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = term
      ? projects.filter(p => p.name.toLowerCase().includes(term))
      : projects;
    return list.slice(0, 40);
  }, [q, projects]);

  const term = q.trim();
  // Only offer creation once there is something to name it, and not when the
  // typed name already exists — otherwise this becomes a duplicate factory.
  const exact = projects.some(p => p.name.trim().toLowerCase() === term.toLowerCase());
  const canCreate = term.length > 1 && !exact;

  // Choosing a kind seeds its first stage; the stage lists share no values
  // between kinds, so a stage carried over from a previous choice would be
  // meaningless on the new one.
  function chooseKind(k: ProjectKind) {
    setKind(k);
    setStage(stagesForKind(k)[0] ?? "");
    setTag(k.tagOptions?.[0] ?? "");
  }

  async function create() {
    if (!canCreate || saving || !kind) return;
    setSaving(true);
    setError(null);
    try {
      // status is sent explicitly rather than trusted to the endpoint default,
      // the way the Projects page does.
      if (!kind) return;
      const res = await fetch("/api/proxy/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kindToPayload(kind, term, stage, tag || undefined)),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      onCreated?.(d.project_id, term);
      onPick(d.project_id);
    } catch {
      setError("Could not create that project.");
      setSaving(false);
    }
  }

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      className={`bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden ${
        inline ? "mt-1" : "absolute left-0 right-0 top-full mt-1 z-30 shadow-xl"
      }`}
    >
      <input
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") onClose();
          // Enter opens the form rather than creating outright: a project now
          // needs a kind, and guessing one would file it in the wrong pipeline.
          if (e.key === "Enter" && canCreate && hits.length === 0) setCreating(true);
        }}
        placeholder="Find a project…"
        className="w-full px-2.5 py-1.5 text-[11px] bg-transparent border-b border-zinc-100 dark:border-zinc-800 text-gray-900 dark:text-gray-100 placeholder-zinc-400 focus:outline-none"
      />
      <div className="max-h-52 overflow-y-auto">
        {onClear && (
          <button
            onClick={onClear}
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            No project
          </button>
        )}
        {hits.length === 0 && !canCreate ? (
          <p className="px-2.5 py-2 text-[11px] text-zinc-400">
            {term ? "No match." : "No projects yet."}
          </p>
        ) : (
          hits.map(p => (
            <button
              key={p.project_id}
              onClick={() => onPick(p.project_id)}
              className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <span className="block text-[11px] text-gray-900 dark:text-gray-100 truncate">{p.name}</span>
              {p.project_type && (
                <span className="block text-[9px] uppercase tracking-wide text-zinc-400">
                  {TYPE_LABEL[p.project_type] ?? p.project_type.replace(/_/g, " ")}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {/* Create, rather than only attach. A task often is the first thing that
          exists about a piece of work, so the project it belongs to may not
          have been made yet — and leaving to create one loses the task. */}
      {/* Creating a project is not one field. What separates an R&D contract
          from a partnership from a grant is project_type, crm_type, section and
          a stage sequence with no values in common — so the form asks for the
          kind in the words it is called by and derives the rest. */}
      {canCreate && (
        <div className="border-t border-zinc-100 dark:border-zinc-800 p-2">
          {!creating ? (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-left text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate"
            >
              + Create “{term}”
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                New “{term}”
              </p>

              {!kind ? (
                <div className="space-y-0.5">
                  {PROJECT_KINDS.map(k => (
                    <button
                      key={k.key}
                      onClick={() => chooseKind(k)}
                      className="w-full flex items-start gap-1.5 text-left px-1.5 py-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                    >
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${k.dot}`} />
                      <span className="min-w-0">
                        <span className="block text-[11px] text-gray-900 dark:text-gray-100">{k.label}</span>
                        <span className="block text-[9px] text-zinc-400 truncate">{k.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <button
                    onClick={() => setKind(null)}
                    className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                  >
                    ← {kind.label}
                  </button>

                  {stagesForKind(kind).length > 0 && (
                    <label className="block">
                      <span className="block text-[9px] uppercase tracking-wide text-zinc-400 mb-0.5">Stage</span>
                      <select
                        value={stage}
                        onChange={e => setStage(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-gray-900 dark:text-gray-100 focus:outline-none"
                      >
                        {stagesForKind(kind).map(st => <option key={st} value={st}>{st}</option>)}
                      </select>
                    </label>
                  )}

                  {kind.tagOptions && (
                    <label className="block">
                      <span className="block text-[9px] uppercase tracking-wide text-zinc-400 mb-0.5">
                        {kind.tagLabel ?? "Type"}
                      </span>
                      <select
                        value={tag}
                        onChange={e => setTag(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-gray-900 dark:text-gray-100 focus:outline-none"
                      >
                        {kind.tagOptions.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </label>
                  )}

                  <button
                    onClick={create}
                    disabled={saving}
                    className="w-full text-[11px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded py-1 transition-colors"
                  >
                    {saving ? "Creating…" : "Create and attach"}
                  </button>
                </div>
              )}

              {error && <p className="text-[10px] text-red-500">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The project field for the task modals.
 *
 * It replaces a bare <select> listing 42 projects in creation order, with no
 * search, no indication of type, and no way to make a project that does not
 * exist yet. It also rendered nothing at all when the list was empty, so the
 * field simply vanished rather than saying why.
 */
export function ProjectField({
  projects,
  value,
  onChange,
  onCreated,
}: {
  projects: Project[];
  value: string;
  onChange: (projectId: string) => void;
  onCreated?: (projectId: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = projects.find(p => p.project_id === value);

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Project</label>

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors"
      >
        <span className="min-w-0 flex-1">
          {selected ? (
            <>
              <span className="block text-xs text-gray-900 dark:text-gray-100 truncate">{selected.name}</span>
              {selected.project_type && (
                <span className="block text-[9px] uppercase tracking-wide text-zinc-400">
                  {TYPE_LABEL[selected.project_type] ?? selected.project_type.replace(/_/g, " ")}
                </span>
              )}
            </>
          ) : (
            <span className="block text-xs text-zinc-400">No project — search or create one</span>
          )}
        </span>
        <svg className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <ProjectPicker
          inline
          projects={projects}
          onPick={id => { onChange(id); setOpen(false); }}
          onClear={value ? () => { onChange(""); setOpen(false); } : undefined}
          onCreated={onCreated}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
