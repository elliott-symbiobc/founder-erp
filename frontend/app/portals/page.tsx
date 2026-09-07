"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { portalPath, portalUrl as buildPortalUrl } from "@/lib/portalLinks";
import { useEffect, useState, useCallback, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Portal {
  portal_id: string;
  token: string;
  slug: string | null;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  portal_drive_folder_id: string | null;
  portal_drive_folder_name: string | null;
  project_id: string | null;
  project_name: string;
  project_drive_folder_name: string | null;
  created_by_name: string | null;
  client_org: string | null;
  client_contact: string | null;
  category: "client" | "investor" | "partner";
  is_password_protected: boolean;
  is_standalone: boolean;
  viewer_count: number;
  last_access_at: string | null;
  last_access_by: string | null;
}

interface Project {
  project_id: string;
  name: string;
}

type Tab = "client" | "investor" | "partner";

const TAB_LABELS: Record<Tab, string> = {
  client: "Clients",
  investor: "Investors",
  partner: "Partners",
};

const CATEGORY_COLORS: Record<Tab, string> = {
  client:   "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400",
  investor: "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400",
  partner:  "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400",
};

function timeAgo(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PortalsPage() {
  const router = useRouter();
  const [portals, setPortals]   = useState<Portal[]>([]);
  const [loading, setLoading]   = useState(true);
  const [copied, setCopied]     = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [tab, setTab]           = useState<Tab>("client");
  const [showRevoked, setShowRevoked] = useState(false);

  // Create portal flow
  const [showCreateForm, setShowCreateForm]   = useState(false);
  const [createMode, setCreateMode]           = useState<"project" | "standalone">("standalone");
  const [projects, setProjects]               = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState("");
  const [roomName, setRoomName]               = useState("");
  const [createCategory, setCreateCategory]   = useState<Tab>("client");
  const [createSlug, setCreateSlug]           = useState("");
  const [creating, setCreating]               = useState(false);
  const [createError, setCreateError]         = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/proxy/portals");
      if (r.ok) setPortals(await r.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const r = await fetch("/api/proxy/projects");
      if (r.ok) {
        const data = await r.json();
        setProjects(data.projects ?? data ?? []);
      }
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  function openCreateForm() {
    setShowCreateForm(true);
    setCreateMode("standalone");
    setSelectedProject("");
    setRoomName("");
    setCreateSlug("");
    setCreateCategory(tab);
    setCreateError(null);
    loadProjects();
  }

  async function createPortal(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      let r: Response;
      if (createMode === "standalone") {
        if (!roomName.trim()) return;
        r = await fetch("/api/proxy/portals/standalone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: roomName.trim() }),
        });
      } else {
        if (!selectedProject) return;
        r = await fetch(`/api/proxy/projects/${selectedProject}/portal`, { method: "POST" });
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Failed to create portal");
      }
      const created = await r.json().catch(() => ({}));
      const newPortalId: string | undefined = created?.portal_id;

      // Apply the settings chosen at creation time so there's no second trip
      // through the manage page to set them.
      const settingsBase = createMode === "standalone"
        ? (newPortalId ? `/api/proxy/portals/room/${newPortalId}` : null)
        : `/api/proxy/projects/${selectedProject}/portal`;

      if (settingsBase) {
        if (createCategory !== "client") {
          await fetch(`${settingsBase}/category`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: createCategory }),
          }).catch(() => {});
        }
        if (createSlug.trim()) {
          await fetch(`${settingsBase}/slug`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: createSlug.trim() }),
          }).catch(() => {});
        }
      }

      setShowCreateForm(false);
      if (createMode === "standalone" && newPortalId) {
        router.push(`/portals/room/${newPortalId}`);
        return;
      }
      if (createMode === "project" && selectedProject) {
        router.push(`/portals/${selectedProject}`);
        return;
      }
      load();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Error creating portal");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(portal: Portal) {
    setRevoking(portal.portal_id);
    if (portal.is_standalone) {
      await fetch(`/api/proxy/portals/room/${portal.portal_id}`, { method: "DELETE" });
    } else {
      await fetch(`/api/proxy/projects/${portal.project_id}/portal`, { method: "DELETE" });
    }
    setRevoking(null);
    load();
  }

  function copyLink(portal: Portal) {
    const url = buildPortalUrl(portal.slug ?? portal.token);
    navigator.clipboard.writeText(url).then(() => {
      setCopied(portal.token);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  async function setCategory(portal: Portal, category: Tab) {
    const url = portal.is_standalone
      ? `/api/proxy/portals/room/${portal.portal_id}/category`
      : `/api/proxy/projects/${portal.project_id}/portal/category`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    if (r.ok) {
      setPortals(prev => prev.map(p =>
        p.portal_id === portal.portal_id ? { ...p, category } : p
      ));
    }
  }

  // Split by tab
  const tabPortals  = portals.filter(p => p.category === tab);
  const active      = tabPortals.filter(p => p.is_active);
  const inactive    = tabPortals.filter(p => !p.is_active);
  const totalActive = portals.filter(p => p.is_active).length;

  const tabCounts: Record<Tab, number> = {
    client:   portals.filter(p => p.is_active && p.category === "client").length,
    investor: portals.filter(p => p.is_active && p.category === "investor").length,
    partner:  portals.filter(p => p.is_active && p.category === "partner").length,
  };

  const rowProps = (p: Portal) => ({
    portal: p,
    copied: copied === p.token,
    revoking: revoking === p.portal_id,
    onCopy: () => copyLink(p),
    onRevoke: () => revoke(p),
    onCategory: (cat: Tab) => setCategory(p, cat),
  });

  return (
    <div className="space-y-5">

      {/* Tabs + actions — one row */}
      <div className="flex items-center gap-0.5 border-b border-gray-200 dark:border-gray-800">
        {(["client", "investor", "partner"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setShowRevoked(false); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            {TAB_LABELS[t]}
            {tabCounts[t] > 0 && (
              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                tab === t
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
              }`}>
                {tabCounts[t]}
              </span>
            )}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3 pb-1.5">
          <span className="text-xs text-gray-400">{totalActive} active</span>
          <button
            onClick={openCreateForm}
            className="text-xs px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium"
          >
            + New portal
          </button>
        </div>
      </div>

      {/* Create portal modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Create new portal</h2>
              <button onClick={() => setShowCreateForm(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-medium">
              {(["standalone", "project"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setCreateMode(mode)}
                  className={`flex-1 py-2 transition-colors ${
                    createMode === mode
                      ? "bg-blue-600 text-white"
                      : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-750"
                  }`}
                >
                  {mode === "standalone" ? "Investor Data Room" : "Link to Project"}
                </button>
              ))}
            </div>

            <p className="text-sm text-gray-500 dark:text-gray-400">
              {createMode === "standalone"
                ? "Create a standalone data room not tied to any project. Perfect for investor due diligence."
                : "Link a portal to an existing project. Any previous active portal for that project will be revoked."}
            </p>

            <form onSubmit={createPortal} className="space-y-3">
              {createMode === "standalone" ? (
                <input
                  type="text"
                  placeholder="Data room name (e.g. Series A Due Diligence)…"
                  value={roomName}
                  onChange={e => setRoomName(e.target.value)}
                  required
                  autoFocus
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              ) : projectsLoading ? (
                <p className="text-sm text-gray-400">Loading projects…</p>
              ) : (
                <select
                  value={selectedProject}
                  onChange={e => setSelectedProject(e.target.value)}
                  required
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select a project…</option>
                  {projects.map(p => (
                    <option key={p.project_id} value={p.project_id}>{p.name}</option>
                  ))}
                </select>
              )}

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                  Category
                </label>
                <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-medium">
                  {(["client", "investor", "partner"] as Tab[]).map(cat => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCreateCategory(cat)}
                      className={`flex-1 py-1.5 transition-colors ${
                        createCategory === cat
                          ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                          : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                      }`}
                    >
                      {cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                  Short URL <span className="font-normal normal-case tracking-normal text-gray-300 dark:text-gray-600">optional</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-mono text-gray-400 shrink-0">/portal/</span>
                  <input
                    type="text"
                    placeholder="series-a"
                    value={createSlug}
                    onChange={e => setCreateSlug(e.target.value)}
                    className="flex-1 text-sm font-mono border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  A memorable link instead of a long token. Leave blank to use the token.
                </p>
              </div>

              {createError && <p className="text-sm text-red-500">{createError}</p>}

              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || (createMode === "standalone" ? !roomName.trim() : !selectedProject)}
                  className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
                >
                  {creating ? "Creating…" : createMode === "standalone" ? "Create data room" : "Create portal"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Portal table */}
      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Loading…</div>
      ) : tabPortals.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-12 text-center">
          <p className="text-sm text-gray-400 mb-2">No {TAB_LABELS[tab].toLowerCase()} portals yet.</p>
          <p className="text-xs text-gray-400">
            Click <span className="font-medium text-gray-500">+ New portal</span> to create one.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
                <Th>Portal</Th>
                <Th>Company</Th>
                <Th>Contact</Th>
                <Th>Category</Th>
                <Th>Last access</Th>
                <Th>Viewers</Th>
                <Th>Drive folder</Th>
                <Th>Created</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {active.map(p => <PortalRow key={p.portal_id} {...rowProps(p)} />)}

              {inactive.length > 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-2 bg-gray-50/60 dark:bg-gray-900/40">
                    <button
                      onClick={() => setShowRevoked(v => !v)}
                      className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    >
                      <svg
                        className={`w-3 h-3 transition-transform ${showRevoked ? "rotate-90" : ""}`}
                        fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                      Revoked — {inactive.length}
                    </button>
                  </td>
                </tr>
              )}

              {showRevoked && inactive.map(p => (
                <PortalRow key={p.portal_id} {...rowProps(p)} revoked />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Table primitives ─────────────────────────────────────────────────────────

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap ${className}`}>
      {children}
    </th>
  );
}

/** Dropdown anchored with fixed positioning so it escapes the table's clipping. */
function Dropdown({
  trigger,
  children,
  align = "left",
}: {
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, left: 0 });
  const btnRef  = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onScroll() { setOpen(false); }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  function toggle() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: align === "right" ? r.right : r.left });
    setOpen(v => !v);
  }

  return (
    <>
      <button ref={btnRef} onClick={toggle} className="text-left">
        {trigger(open)}
      </button>
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, left: align === "right" ? undefined : pos.left, right: align === "right" ? `calc(100vw - ${pos.left}px)` : undefined }}
          className="fixed z-50 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg py-1 min-w-[150px] max-h-64 overflow-y-auto"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </>
  );
}

function MenuItem({
  children,
  onClick,
  active,
  danger,
  muted,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 ${
        danger ? "text-red-500"
          : active ? "text-blue-600 dark:text-blue-400 font-medium"
          : muted ? "text-gray-400 italic"
          : "text-gray-700 dark:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

// ── Portal Row ────────────────────────────────────────────────────────────────

function PortalRow({
  portal,
  copied,
  revoking,
  onCopy,
  onRevoke,
  onCategory,
  revoked,
}: {
  portal: Portal;
  copied: boolean;
  revoking: boolean;
  onCopy: () => void;
  onRevoke: () => void;
  onCategory: (cat: Tab) => void;
  revoked?: boolean;
}) {
  const folderName = portal.portal_drive_folder_name ?? portal.project_drive_folder_name;
  const manageHref = portal.is_standalone ? `/portals/room/${portal.portal_id}` : `/portals/${portal.project_id}`;
  const expired    = portal.expires_at && new Date(portal.expires_at) < new Date();

  return (
    <tr className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors ${revoked ? "opacity-50" : ""}`}>

      {/* Portal name */}
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${revoked ? "bg-gray-300 dark:bg-gray-600" : "bg-green-500"}`}
            title={revoked ? "Revoked" : "Active"}
          />
          <Link
            href={manageHref}
            className="font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-[240px]"
          >
            {portal.project_name}
          </Link>
          {portal.is_password_protected && (
            <span title="Password protected" className="shrink-0 leading-none">
              <svg className="w-3 h-3 text-amber-500"
                   fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            </span>
          )}
          {expired && <span className="text-[10px] text-red-500 shrink-0">expired</span>}
        </div>
      </td>

      {/* Company */}
      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
        {portal.client_org
          ? <span className="truncate block max-w-[180px]" title={portal.client_org}>{portal.client_org}</span>
          : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>

      {/* Contact */}
      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">
        {portal.client_contact
          ? <span className="truncate block max-w-[160px]" title={portal.client_contact}>{portal.client_contact}</span>
          : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>

      {/* Category */}
      <td className="px-4 py-2.5">
        {revoked ? (
          <CategoryBadge category={portal.category} />
        ) : (
          <Dropdown trigger={() => <CategoryBadge category={portal.category} />}>
            {close => (
              <>
                {(["client", "investor", "partner"] as Tab[]).map(cat => (
                  <MenuItem
                    key={cat}
                    active={cat === portal.category}
                    onClick={() => { onCategory(cat); close(); }}
                  >
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>
        )}
      </td>

      {/* Last client access — who and when */}
      <td className="px-4 py-2.5 whitespace-nowrap">
        {portal.last_access_at ? (
          <span className="text-gray-600 dark:text-gray-300" title={fullDate(portal.last_access_at)}>
            {portal.last_access_by
              ? <>{portal.last_access_by} <span className="text-gray-400">·</span> </>
              : <span className="text-gray-400 italic">Unidentified · </span>}
            <span className="text-gray-500 dark:text-gray-400">{timeAgo(portal.last_access_at)}</span>
          </span>
        ) : (
          <span className="text-gray-300 dark:text-gray-600">Never</span>
        )}
      </td>

      {/* Viewers */}
      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300 tabular-nums">
        {portal.viewer_count > 0 ? portal.viewer_count : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>

      {/* Drive folder */}
      <td className="px-4 py-2.5 text-gray-500 dark:text-gray-400">
        {folderName
          ? <span className="truncate block max-w-[160px]" title={folderName}>{folderName}</span>
          : <span className="text-gray-300 dark:text-gray-600">—</span>}
      </td>

      {/* Created */}
      <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">
        <span title={`${fullDate(portal.created_at)}${portal.created_by_name ? ` · ${portal.created_by_name}` : ""}`}>
          {timeAgo(portal.created_at)}
        </span>
      </td>

      {/* Actions */}
      <td className="px-4 py-2.5 text-right whitespace-nowrap">
        {revoked ? (
          <span className="text-xs text-gray-400">Revoked</span>
        ) : (
          <div className="inline-flex items-center gap-3">
            <button onClick={onCopy} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
              {copied ? "Copied!" : "Copy link"}
            </button>
            <Dropdown
              align="right"
              trigger={() => (
                <span className="px-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">⋯</span>
              )}
            >
              {close => (
                <>
                  <MenuItem onClick={() => { close(); window.location.href = manageHref; }}>Manage portal</MenuItem>
                  {!portal.is_standalone && portal.project_id && (
                    <MenuItem onClick={() => { close(); window.location.href = `/projects/${portal.project_id}`; }}>
                      Open project
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => { close(); window.open(portalPath(portal.slug ?? portal.token), "_blank", "noopener"); }}>
                    Preview as client
                  </MenuItem>
                  <MenuItem danger onClick={() => { close(); onRevoke(); }}>
                    {revoking ? "Revoking…" : "Revoke access"}
                  </MenuItem>
                </>
              )}
            </Dropdown>
          </div>
        )}
      </td>
    </tr>
  );
}

function CategoryBadge({ category }: { category: Tab }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CATEGORY_COLORS[category]}`}>
      {category.charAt(0).toUpperCase() + category.slice(1)}
    </span>
  );
}
