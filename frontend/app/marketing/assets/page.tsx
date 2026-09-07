"use client";

/**
 * Marketing assets — the source of truth for outreach material.
 *
 * Files are not stored here. An attached Drive folder is listed live, so
 * replacing a deck means dropping the new PDF in Drive rather than re-uploading
 * it. What this page adds on top is the part Drive cannot express: which file
 * currently plays which role, and who consumes it.
 *
 * Other modules reference a role, never a file, so swapping the file behind
 * "investor-deck" updates every outreach email and mirrored data room at once.
 */

import { useCallback, useEffect, useState } from "react";

import KeyLanguagePanel from "@/components/marketing/KeyLanguagePanel";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Asset {
  file_id: string;
  name: string;
  mime_type: string;
  kind: string;
  size_bytes: number | null;
  modified_time: string | null;
  web_view_link: string | null;
  description: string | null;
  roles: string[];
}

interface Role {
  role: string;
  label: string;
  description: string | null;
  file_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  updated_at: string | null;
  used_by: { kind: string; name: string }[];
}

interface Folder {
  assets_folder_id: string | null;
  assets_folder_name: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes: number | null) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function fullDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const KIND_COLOR: Record<string, string> = {
  PDF:  "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400",
  PNG:  "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
  JPG:  "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
  SVG:  "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
  WEBP: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
  GIF:  "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MarketingAssetsPage() {
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [roles, setRoles]     = useState<Role[]>([]);
  const [folder, setFolder]   = useState<Folder>({ assets_folder_id: null, assets_folder_name: null });
  const [needsFolder, setNeedsFolder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  const [folderInput, setFolderInput] = useState("");
  const [showFolder, setShowFolder]   = useState(false);
  const [roleMenu, setRoleMenu]       = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState<string | null>(null);
  const [descDraft, setDescDraft]     = useState("");
  // The folder listing is reference material — what matters day to day is
  // which file fills which role, so it stays out of the way until asked for.
  const [showFiles, setShowFiles]     = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleLabel, setNewRoleLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/proxy/marketing/assets");
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Could not load assets");
      }
      const d = await r.json();
      setAssets(d.assets ?? []);
      setRoles(d.roles ?? []);
      setFolder(d.folder ?? {});
      setNeedsFolder(!!d.needs_folder);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load assets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveFolder(e: React.FormEvent) {
    e.preventDefault();
    setBusy("folder");
    setError(null);
    try {
      const r = await fetch("/api/proxy/marketing/assets/folder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_url: folderInput.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Could not attach that folder");
      }
      setShowFolder(false);
      setFolderInput("");
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not attach that folder");
    } finally {
      setBusy(null);
    }
  }

  async function assignRole(role: string, fileId: string | null) {
    setBusy(role);
    await fetch(`/api/proxy/marketing/roles/${role}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    setRoleMenu(null);
    await load();
    setBusy(null);
  }

  async function addRole(e: React.FormEvent) {
    e.preventDefault();
    setBusy("new-role");
    setError(null);
    try {
      const r = await fetch("/api/proxy/marketing/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newRoleLabel.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Could not add that role");
      }
      setNewRoleLabel("");
      setShowAddRole(false);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not add that role");
    } finally {
      setBusy(null);
    }
  }

  async function removeRole(role: string) {
    setBusy(role);
    setError(null);
    try {
      const r = await fetch(`/api/proxy/marketing/roles/${role}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Could not remove that role");
      }
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not remove that role");
    } finally {
      setBusy(null);
    }
  }

  async function saveDescription(fileId: string) {
    setBusy(fileId);
    await fetch(`/api/proxy/marketing/assets/${fileId}/description`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: descDraft }),
    });
    setEditingDesc(null);
    await load();
    setBusy(null);
  }

  const roleLabel = (r: string) => roles.find(x => x.role === r)?.label ?? r;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading assets…</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">

      {/* Folder — the tab already says Assets, so no heading here */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {folder.assets_folder_name
              ? <>Synced from <span className="font-medium text-gray-700 dark:text-gray-300">{folder.assets_folder_name}</span> in Drive.</>
              : "Attach a Drive folder to pull decks and graphics automatically."}
          </p>
        </div>
        <button
          onClick={() => { setShowFolder(v => !v); setFolderInput(""); }}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 shrink-0"
        >
          {folder.assets_folder_id ? "Change folder" : "Attach folder"}
        </button>
      </div>

      {showFolder && (
        <form onSubmit={saveFolder} className="flex gap-2 items-center bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700 rounded-xl p-3">
          <input
            value={folderInput}
            onChange={e => setFolderInput(e.target.value)}
            placeholder="Paste the Drive folder link…"
            autoFocus
            className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={busy === "folder" || !folderInput.trim()}
            className="text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0"
          >
            {busy === "folder" ? "Checking…" : "Attach"}
          </button>
          <button type="button" onClick={() => setShowFolder(false)} className="text-sm text-gray-400 hover:text-gray-600 shrink-0">
            Cancel
          </button>
        </form>
      )}

      {error && (
        <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Roles — what other modules actually ask for. One row each: this is a
          reference list, not the page's subject. */}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Current assets
          </h2>
          <div className="flex items-center gap-3">
            <p className="text-xs text-gray-400">
              Other modules reference these by name, not by file.
            </p>
            <button
              onClick={() => { setShowAddRole(v => !v); setNewRoleLabel(""); }}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
            >
              {showAddRole ? "Cancel" : "+ Add role"}
            </button>
          </div>
        </div>

        {showAddRole && (
          <form onSubmit={addRole} className="flex gap-2 items-center mb-2 bg-gray-50 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700 rounded-xl p-3">
            <input
              value={newRoleLabel}
              onChange={e => setNewRoleLabel(e.target.value)}
              placeholder="What is it called? e.g. Distillery one-pager"
              autoFocus
              className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={busy === "new-role" || !newRoleLabel.trim()}
              className="text-sm px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0"
            >
              {busy === "new-role" ? "Adding…" : "Add"}
            </button>
          </form>
        )}

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800">
          {roles.map(r => (
            <div key={r.role} className="group flex items-center gap-3 px-4 py-2.5">
              {/* min-width keeps the rows aligned; nowrap without truncate means a
                  longer name pushes the column wider rather than being cut off. */}
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 min-w-[11rem] shrink-0 whitespace-nowrap" title={r.description ?? ""}>
                {r.label}
              </span>

              <div className="flex-1 min-w-0">
                {r.file_id ? (
                  <span className="text-sm text-gray-600 dark:text-gray-300 truncate block">{r.file_name}</span>
                ) : (
                  <span className="text-sm text-amber-600 dark:text-amber-400">Not assigned</span>
                )}
                {r.used_by.length > 0 && (
                  <span className="text-[11px] text-gray-400 truncate block">
                    {r.used_by.map(u => u.name).join(", ")}
                  </span>
                )}
              </div>

              <span className="text-[11px] text-gray-400 whitespace-nowrap shrink-0 tabular-nums" title={fullDate(r.updated_at)}>
                {r.file_id ? timeAgo(r.updated_at) : "—"}
              </span>

              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => removeRole(r.role)}
                  disabled={busy === r.role}
                  title="Remove this role"
                  className="text-xs text-gray-300 dark:text-gray-600 hover:text-red-500 disabled:opacity-40 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  Remove
                </button>
                {r.file_id && (
                  <a
                    href={`/api/proxy/marketing/assets/${r.file_id}/download`}
                    download={r.file_name ?? undefined}
                    className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    Download
                  </a>
                )}
                <div className="relative">
                  <button
                    onClick={() => setRoleMenu(roleMenu === r.role ? null : r.role)}
                    disabled={busy === r.role}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40"
                  >
                    {r.file_id ? "Change" : "Assign"}
                  </button>
                  {roleMenu === r.role && (
                    <div className="absolute right-0 top-full mt-1 z-30 w-72 max-h-64 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg py-1">
                      {r.file_id && (
                        <button
                          onClick={() => assignRole(r.role, null)}
                          className="w-full text-left px-3 py-1.5 text-xs text-gray-400 italic hover:bg-gray-50 dark:hover:bg-gray-800"
                        >
                          Clear
                        </button>
                      )}
                      {assets.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-gray-400">No files in the folder yet.</p>
                      ) : assets.map(a => (
                        <button
                          key={a.file_id}
                          onClick={() => assignRole(r.role, a.file_id)}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 truncate ${
                            a.file_id === r.file_id
                              ? "text-blue-600 dark:text-blue-400 font-medium"
                              : "text-gray-700 dark:text-gray-200"
                          }`}
                        >
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Everything in the folder — collapsed unless asked for */}
      <div>
        {!needsFolder && (
          <button
            onClick={() => setShowFiles(v => !v)}
            className="flex items-center gap-1.5 mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showFiles ? "rotate-90" : ""}`}
              fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            In the folder — {assets.length}
          </button>
        )}

        {needsFolder ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">No Drive folder attached yet.</p>
            <p className="text-xs text-gray-400 mt-1">
              Attach one above and its PDFs and images appear here automatically.
            </p>
          </div>
        ) : !showFiles ? null : assets.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-10 text-center">
            <p className="text-sm text-gray-400">
              The folder has no PDFs or images in it.
            </p>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Asset</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Role</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Updated</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Size</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {assets.map(a => (
                  <tr key={a.file_id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 ${KIND_COLOR[a.kind] ?? KIND_COLOR.PNG}`}>
                          {a.kind}
                        </span>
                        <span className="font-medium text-gray-900 dark:text-gray-100 truncate max-w-[260px]">{a.name}</span>
                      </div>
                      {editingDesc === a.file_id ? (
                        <div className="flex items-center gap-2 mt-1.5">
                          <input
                            value={descDraft}
                            onChange={e => setDescDraft(e.target.value)}
                            autoFocus
                            placeholder="What is this for?"
                            className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                          />
                          <button
                            onClick={() => saveDescription(a.file_id)}
                            disabled={busy === a.file_id}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            Save
                          </button>
                          <button onClick={() => setEditingDesc(null)} className="text-xs text-gray-400 hover:text-gray-600">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingDesc(a.file_id); setDescDraft(a.description ?? ""); }}
                          className="block text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-0.5 text-left"
                        >
                          {a.description || <span className="italic">Add a description</span>}
                        </button>
                      )}
                    </td>

                    <td className="px-4 py-2.5">
                      {a.roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {a.roles.map(r => (
                            <span key={r} className="text-[10px] font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 rounded px-1.5 py-0.5">
                              {roleLabel(r)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      )}
                    </td>

                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400">
                      <span title={fullDate(a.modified_time)}>{timeAgo(a.modified_time)}</span>
                    </td>

                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500 dark:text-gray-400 tabular-nums">
                      {fmtSize(a.size_bytes) ?? "—"}
                    </td>

                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-3">
                        <a
                          href={`/api/proxy/marketing/assets/${a.file_id}/download`}
                          download={a.name}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Download
                        </a>
                        {a.web_view_link && (
                          <a
                            href={a.web_view_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                          >
                            Drive ↗
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <KeyLanguagePanel />
    </div>
  );
}
