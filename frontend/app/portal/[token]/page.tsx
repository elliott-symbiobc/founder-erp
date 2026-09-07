"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortalContact {
  id: number;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

interface PortalUpdate {
  id: number;
  title: string;
  body: string | null;
  created_at: string;
  created_by_name: string | null;
}

interface PortalFile {
  file_id: string;
  name: string;
  mime_type: string | null;
  modified_time: string | null;
  size_bytes: number | null;
  description?: string | null;
}

interface PortalData {
  project_name: string;
  drive_folder_name: string | null;
  label: string | null;
  description: string | null;
  contacts: PortalContact[];
  updates: PortalUpdate[];
  files: PortalFile[];
  messaging_enabled?: boolean;
}

interface PortalMessage {
  message_id: string;
  sender_name: string | null;
  sender_display_name: string | null;
  body: string;
  is_announcement: boolean;
  portal_token: string | null;
  created_at: string;
}

interface FolderEntry {
  id: string;
  name: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MIME_META: Record<string, { label: string; color: string }> = {
  "application/vnd.google-apps.document":     { label: "Doc",    color: "#4285F4" },
  "application/vnd.google-apps.spreadsheet":  { label: "Sheet",  color: "#34A853" },
  "application/vnd.google-apps.presentation": { label: "Slides", color: "#FBBC04" },
  "application/vnd.google-apps.folder":       { label: "Folder", color: "#F59E0B" },
  "application/pdf":                          { label: "PDF",    color: "#EA4335" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":   { label: "Word",  color: "#2B579A" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":          { label: "Excel", color: "#217346" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":  { label: "PPT",   color: "#B7472A" },
  "text/plain":  { label: "Text",  color: "#8E8E8E" },
  "image/png":   { label: "PNG",   color: "#8E8E8E" },
  "image/jpeg":  { label: "JPG",   color: "#8E8E8E" },
};

const VIEWABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

const NOT_DOWNLOADABLE = new Set([
  "application/vnd.google-apps.folder",
]);

function fmtSize(bytes: number | null) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function sessionKey(token: string) {
  return `portal_session_${token}`;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PortalPage() {
  const { token } = useParams<{ token: string }>();

  const [portalData, setPortalData]             = useState<PortalData | null>(null);
  const [loading, setLoading]                   = useState(true);
  const [error, setError]                       = useState<string | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [sessionToken, setSessionToken]         = useState<string | null>(null);
  const [viewerName, setViewerName]             = useState<string | null>(null);

  // Subfolder drill-down (for nested folders inside an expanded section)
  const [folderStack, setFolderStack]   = useState<FolderEntry[]>([]);
  const [folderFiles, setFolderFiles]   = useState<PortalFile[] | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);

  // Accordion state
  const [openSections, setOpenSections]     = useState<Set<string>>(new Set());
  const [sectionFiles, setSectionFiles]     = useState<Record<string, PortalFile[]>>({});
  const [sectionLoading, setSectionLoading] = useState<Record<string, boolean>>({});
  const [search, setSearch]                 = useState("");

  // File viewer overlay
  const [viewer, setViewer]           = useState<{ file: PortalFile; blobUrl: string } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<string | null>(null);

  const trackedOnce = useRef(false);

  const getSessionHeaders = useCallback((): HeadersInit => {
    const tok = sessionToken ?? (token ? sessionStorage.getItem(sessionKey(token)) : null);
    if (tok) return { "X-Portal-Session": tok };
    return {};
  }, [sessionToken, token]);

  const track = useCallback((
    eventType: "page_visit" | "file_view" | "file_download",
    opts?: { file_id?: string; file_name?: string; section?: string }
  ) => {
    if (!token) return;
    fetch(`/api/proxy/portal/${token}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getSessionHeaders() },
      body: JSON.stringify({ event_type: eventType, ...opts }),
    }).catch(() => {});
  }, [token, getSessionHeaders]);

  const loadPortal = useCallback(async (session?: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      const tok = session ?? sessionToken ?? sessionStorage.getItem(sessionKey(token));
      if (tok) (headers as Record<string, string>)["X-Portal-Session"] = tok;
      const r = await fetch(`/api/proxy/portal/${token}`, { headers });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "This portal link is invalid or has been revoked.");
      }
      const data = await r.json();
      if (data.password_required) { setPasswordRequired(true); setLoading(false); return; }
      setPortalData(data as PortalData);
      setPasswordRequired(false);
      if (!trackedOnce.current) {
        trackedOnce.current = true;
        setTimeout(() => track("page_visit", { section: "overview" }), 500);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [token, sessionToken, track]);

  useEffect(() => {
    if (!token) return;
    const stored = sessionStorage.getItem(sessionKey(token));
    if (stored) setSessionToken(stored);
    loadPortal(stored ?? undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Open all top-level sections and pre-load their files when portal data arrives
  useEffect(() => {
    if (!portalData) return;
    const folders = portalData.files.filter(f => f.mime_type === "application/vnd.google-apps.folder");
    if (folders.length === 0) return;
    const ids = new Set(folders.map(f => f.file_id));
    setOpenSections(ids);
    // Parallel-fetch all section contents
    folders.forEach(folder => {
      setSectionLoading(prev => ({ ...prev, [folder.file_id]: true }));
      fetch(`/api/proxy/portal/${token}/folders/${folder.file_id}`, { headers: getSessionHeaders() })
        .then(r => r.ok ? r.json() : { files: [] })
        .then(d => {
          setSectionFiles(prev => ({ ...prev, [folder.file_id]: d.files ?? [] }));
        })
        .finally(() => setSectionLoading(prev => ({ ...prev, [folder.file_id]: false })));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portalData]);

  useEffect(() => {
    return () => { if (viewer?.blobUrl) URL.revokeObjectURL(viewer.blobUrl); };
  }, [viewer]);

  const handleAuthSuccess = useCallback((tok: string, name: string | null) => {
    if (!token) return;
    setSessionToken(tok);
    setViewerName(name);
    sessionStorage.setItem(sessionKey(token), tok);
    loadPortal(tok);
  }, [token, loadPortal]);

  const toggleSection = useCallback((folderId: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
        // Lazy-load if not yet fetched
        if (!sectionFiles[folderId] && !sectionLoading[folderId]) {
          setSectionLoading(p => ({ ...p, [folderId]: true }));
          fetch(`/api/proxy/portal/${token}/folders/${folderId}`, { headers: getSessionHeaders() })
            .then(r => r.ok ? r.json() : { files: [] })
            .then(d => setSectionFiles(p => ({ ...p, [folderId]: d.files ?? [] })))
            .finally(() => setSectionLoading(p => ({ ...p, [folderId]: false })));
        }
      }
      return next;
    });
  }, [token, sectionFiles, sectionLoading, getSessionHeaders]);

  // Subfolder navigation (drills into nested folders within a section)
  const openFolder = useCallback(async (file: PortalFile) => {
    setFolderStack(prev => [...prev, { id: file.file_id, name: file.name }]);
    setFolderFiles(null);
    setFolderLoading(true);
    try {
      const r = await fetch(`/api/proxy/portal/${token}/folders/${file.file_id}`, { headers: getSessionHeaders() });
      if (r.ok) { const d = await r.json(); setFolderFiles(d.files ?? []); }
    } finally { setFolderLoading(false); }
  }, [token, getSessionHeaders]);

  const navigateTo = useCallback(async (idx: number) => {
    if (idx < 0) { setFolderStack([]); setFolderFiles(null); return; }
    const entry = folderStack[idx];
    setFolderStack(folderStack.slice(0, idx + 1));
    setFolderFiles(null);
    setFolderLoading(true);
    try {
      const r = await fetch(`/api/proxy/portal/${token}/folders/${entry.id}`, { headers: getSessionHeaders() });
      if (r.ok) { const d = await r.json(); setFolderFiles(d.files ?? []); }
    } finally { setFolderLoading(false); }
  }, [token, folderStack, getSessionHeaders]);

  /** Save a file through an authenticated fetch.
   *
   * A password-protected portal gates the download endpoint on the session
   * header, which a link click cannot send: navigating straight to the URL is
   * unauthenticated and returns 401. Fetching it and saving the blob keeps the
   * session attached.
   */
  const saveFile = useCallback(async (file: PortalFile) => {
    setDownloading(file.file_id);
    try {
      const r = await fetch(
        `/api/proxy/portal/${token}/files/${file.file_id}/download`,
        { headers: getSessionHeaders() }
      );
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      track("file_download", { file_id: file.file_id, file_name: file.name });
    } catch {
      alert(`Could not download ${file.name}. Please try again.`);
    } finally {
      setDownloading(null);
    }
  }, [token, getSessionHeaders, track]);

  const openViewer = useCallback(async (file: PortalFile) => {
    if (viewer?.blobUrl) URL.revokeObjectURL(viewer.blobUrl);
    setViewer(null); setViewerError(null); setViewerLoading(true);
    track("file_view", { file_id: file.file_id, file_name: file.name, section: "documents" });
    try {
      const r = await fetch(`/api/proxy/portal/${token}/files/${file.file_id}/download`, { headers: getSessionHeaders() });
      if (!r.ok) throw new Error("Failed to load file");
      const blob = await r.blob();
      setViewer({ file, blobUrl: URL.createObjectURL(blob) });
    } catch { setViewerError("Could not load preview. Try downloading instead."); }
    finally { setViewerLoading(false); }
  }, [token, viewer, track, getSessionHeaders]);

  const closeViewer = useCallback(() => {
    if (viewer?.blobUrl) URL.revokeObjectURL(viewer.blobUrl);
    setViewer(null); setViewerError(null);
  }, [viewer]);

  const hasViewer = !!(viewer || viewerLoading || viewerError);

  // ── Render guards ──────────────────────────────────────────────────────────

  if (loading) return (
    <PageShell>
      <div className="flex items-center justify-center py-24">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    </PageShell>
  );

  if (passwordRequired && !portalData) return (
    <PasswordGate token={token ?? ""} onSuccess={handleAuthSuccess} />
  );

  if (error) return (
    <PageShell>
      <div className="flex items-center justify-center py-24">
        <p className="text-sm text-red-500 max-w-sm text-center">{error}</p>
      </div>
    </PageShell>
  );

  if (!portalData) return null;

  const isInSubfolder   = folderStack.length > 0;
  const rootFiles       = portalData.files;
  const topFolders      = rootFiles.filter(f => f.mime_type === "application/vnd.google-apps.folder");
  const rootOnlyFiles   = rootFiles.filter(f => f.mime_type !== "application/vnd.google-apps.folder");
  const rootName        = portalData.drive_folder_name ?? portalData.project_name;

  const filteredFolders = topFolders.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase())
  );

  // Subfolder view (drill-down into nested folder)
  const subFolderItems = (folderFiles ?? []).filter(f => f.mime_type === "application/vnd.google-apps.folder");
  const subFileItems   = (folderFiles ?? []).filter(f => f.mime_type !== "application/vnd.google-apps.folder");

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col font-sans">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0 sticky top-0 z-30">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-3">
          <LogoMark />
          <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
          <h1 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate flex-1">
            {portalData.project_name}
          </h1>
          {portalData.label && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md px-2 py-0.5">
              {portalData.label}
            </span>
          )}
          {viewerName && (
            <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1.5 shrink-0">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
              {viewerName}
            </span>
          )}
        </div>
      </header>

      {/* ── Hero strip ─────────────────────────────────────────────────────── */}
      {(portalData.description || portalData.contacts.length > 0 || portalData.updates.length > 0) && (
        <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="max-w-5xl mx-auto px-6 py-6 flex gap-8 items-start">
            {(portalData.description || portalData.contacts.length > 0) && (
              <div className="flex-1 min-w-0 flex flex-col gap-5">
                {portalData.description && (
                  <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {portalData.description}
                  </p>
                )}
                {portalData.contacts.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                      Your Open ERP team
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {portalData.contacts.map(c => <ContactChip key={c.id} contact={c} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {portalData.updates.length > 0 && (
              <div className="shrink-0 w-72">
                <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-red-600 dark:text-red-400">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                        <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                      </svg>
                      Latest Update
                    </span>
                    <span className="text-[11px] text-gray-400 dark:text-gray-500">
                      {fmtDate(portalData.updates[0].created_at)}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1.5 leading-snug">
                    {portalData.updates[0].title}
                  </p>
                  {portalData.updates[0].body && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                      {portalData.updates[0].body.length > 200
                        ? portalData.updates[0].body.slice(0, 200) + "…"
                        : portalData.updates[0].body}
                    </p>
                  )}
                  {portalData.updates[0].created_by_name && (
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
                      Posted by {portalData.updates[0].created_by_name}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Page body ──────────────────────────────────────────────────────── */}
      <div className="flex-1 py-8 px-6">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">

          {/* ── Data Room ──────────────────────────────────────────────────── */}
          <div>
            {/* Header row */}
            <div className="flex items-center justify-between gap-4 mb-5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-100 dark:border-amber-900 flex items-center justify-center shrink-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#F59E0B">
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Data Room</h2>
                  {!isInSubfolder && topFolders.length > 0 && (
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">{topFolders.length} sections</p>
                  )}
                </div>
              </div>

              {/* Search — only at root */}
              {!isInSubfolder && topFolders.length > 2 && (
                <div className="relative w-56">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                    <circle cx="11" cy="11" r="8" /><path strokeLinecap="round" d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search sections…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-amber-400 dark:focus:ring-amber-600"
                  />
                </div>
              )}
            </div>

            {/* ── Subfolder drill-down view ─────────────────────────────────── */}
            {isInSubfolder ? (
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl overflow-hidden">
                {/* Breadcrumb */}
                <div className="flex items-center gap-1.5 px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex-wrap text-xs bg-gray-50 dark:bg-gray-800/50">
                  <button
                    className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 transition-colors font-medium"
                    onClick={() => navigateTo(-1)}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    {rootName}
                  </button>
                  {folderStack.map((entry, idx) => (
                    <React.Fragment key={entry.id}>
                      <span className="text-gray-300 dark:text-gray-600">/</span>
                      <button
                        className={`px-1 py-0.5 rounded transition-colors ${
                          idx === folderStack.length - 1
                            ? "text-gray-900 dark:text-gray-100 font-semibold"
                            : "text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        }`}
                        onClick={() => navigateTo(idx)}
                      >
                        {entry.name}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
                <div className="p-5">
                  {folderLoading ? (
                    <p className="text-sm text-gray-400 py-4 text-center">Loading…</p>
                  ) : (folderFiles ?? []).length === 0 ? (
                    <p className="text-sm text-gray-400 py-4 text-center">This folder is empty.</p>
                  ) : (
                    <>
                      {subFolderItems.length > 0 && (
                        <div className="grid gap-2.5 mb-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                          {subFolderItems.map(f => (
                            <SubFolderCard key={f.file_id} folder={f} onClick={() => openFolder(f)} />
                          ))}
                        </div>
                      )}
                      {subFileItems.length > 0 && (
                        <FileTable
                          files={subFileItems}
                          token={token ?? ""}
                          viewer={viewer}
                          onView={openViewer}
                          onClose={closeViewer}
                          onDownload={saveFile}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* ── Root accordion view ───────────────────────────────────────── */
              <div className="flex flex-col gap-2">
                {filteredFolders.length === 0 && search && (
                  <p className="text-sm text-gray-400 py-6 text-center">No sections match &ldquo;{search}&rdquo;</p>
                )}

                {filteredFolders.map((folder, idx) => {
                  const isOpen    = openSections.has(folder.file_id);
                  const isLoading = sectionLoading[folder.file_id];
                  const files     = sectionFiles[folder.file_id] ?? [];
                  const subFolders = files.filter(f => f.mime_type === "application/vnd.google-apps.folder");
                  const fileCount  = files.filter(f => f.mime_type !== "application/vnd.google-apps.folder").length;

                  return (
                    <div
                      key={folder.file_id}
                      className={`bg-white dark:bg-gray-900 border rounded-xl overflow-hidden transition-all ${
                        isOpen
                          ? "border-amber-200 dark:border-amber-800 shadow-sm"
                          : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                      }`}
                    >
                      {/* Section header (always visible) */}
                      <button
                        className="w-full flex items-center gap-4 px-5 py-4 text-left group"
                        onClick={() => toggleSection(folder.file_id)}
                      >
                        {/* Index number */}
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 transition-colors ${
                          isOpen
                            ? "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 group-hover:bg-amber-50 dark:group-hover:bg-amber-950 group-hover:text-amber-600 dark:group-hover:text-amber-400"
                        }`}>
                          {idx + 1}
                        </div>

                        {/* Title + description */}
                        <div className="flex-1 min-w-0">
                          <span className={`block text-sm font-semibold leading-snug ${
                            isOpen ? "text-gray-900 dark:text-gray-100" : "text-gray-800 dark:text-gray-200"
                          }`}>
                            {folder.name}
                          </span>
                          {folder.description && (
                            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
                              {folder.description}
                            </span>
                          )}
                        </div>

                        {/* File count + chevron */}
                        <div className="flex items-center gap-3 shrink-0">
                          {!isLoading && files.length > 0 && (
                            <span className="text-[11px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 rounded px-2 py-0.5 font-medium">
                              {files.length} {files.length === 1 ? "item" : "items"}
                            </span>
                          )}
                          {isLoading && (
                            <span className="text-[11px] text-gray-400 animate-pulse">Loading…</span>
                          )}
                          <svg
                            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
                            className={`transition-transform text-gray-400 dark:text-gray-500 ${isOpen ? "rotate-180" : ""}`}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </div>
                      </button>

                      {/* Expanded content */}
                      {isOpen && (
                        <div className="border-t border-amber-100 dark:border-amber-900/50">
                          {isLoading ? (
                            <div className="px-5 py-6 text-center">
                              <p className="text-sm text-gray-400">Loading…</p>
                            </div>
                          ) : files.length === 0 ? (
                            <div className="px-5 py-5 text-center">
                              <p className="text-sm text-gray-400">This section is empty.</p>
                            </div>
                          ) : (
                            <div className="px-5 py-4 space-y-4">
                              {/* Subfolders within this section */}
                              {subFolders.length > 0 && (
                                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                                  {subFolders.map(sf => (
                                    <SubFolderCard key={sf.file_id} folder={sf} onClick={() => openFolder(sf)} />
                                  ))}
                                </div>
                              )}
                              {/* Files */}
                              {fileCount > 0 && (
                                <FileTable
                                  files={files.filter(f => f.mime_type !== "application/vnd.google-apps.folder")}
                                  token={token ?? ""}
                                  viewer={viewer}
                                  onView={openViewer}
                                  onClose={closeViewer}
                                  onDownload={saveFile}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Root-level files (not inside any folder) */}
                {rootOnlyFiles.length > 0 && (
                  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden mt-1">
                    <div className="px-5 py-3.5 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                        Additional Files
                      </span>
                      <span className="text-[10px] font-bold text-gray-400 bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5">
                        {rootOnlyFiles.length}
                      </span>
                    </div>
                    <div className="px-5 py-3">
                      <FileTable
                        files={rootOnlyFiles}
                        token={token ?? ""}
                        viewer={viewer}
                        onView={openViewer}
                        onClose={closeViewer}
                        onDownload={saveFile}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Updates card ───────────────────────────────────────────────── */}
          {portalData.updates.length > 0 && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl overflow-hidden">
              <div className="flex items-center gap-2.5 px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                <div className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-gray-500 dark:text-gray-400">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">Project Updates</h2>
                <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded px-2 py-0.5">
                  {portalData.updates.length}
                </span>
              </div>
              <div className="p-6">
                <div className="flex flex-col">
                  {portalData.updates.map((u, idx) => (
                    <div key={u.id} className="flex gap-4">
                      <div className="flex flex-col items-center shrink-0 w-4 pt-1">
                        <div className="w-2.5 h-2.5 rounded-full bg-red-600 dark:bg-red-500 border-2 border-red-100 dark:border-red-900 shrink-0" />
                        {idx < portalData.updates.length - 1 && (
                          <div className="flex-1 w-px bg-gray-200 dark:bg-gray-700 mt-1.5" />
                        )}
                      </div>
                      <div className={`flex-1 min-w-0 ${idx < portalData.updates.length - 1 ? "pb-6" : ""}`}>
                        <div className="flex items-start justify-between gap-4 flex-wrap mb-1.5">
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-snug">{u.title}</p>
                          <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                            {fmtDate(u.created_at)}{u.created_by_name ? ` · ${u.created_by_name}` : ""}
                          </span>
                        </div>
                        {u.body && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{u.body}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Portal Messaging ────────────────────────────────────────────────── */}
      {portalData.messaging_enabled && token && (
        <PortalMessaging token={token} sessionToken={sessionToken} />
      )}

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-4 px-6 shrink-0">
        <p className="text-[11px] text-gray-300 dark:text-gray-600 text-center">
          Shared via Open ERP Platform
        </p>
      </footer>

      {/* ── Viewer overlay ─────────────────────────────────────────────────── */}
      {hasViewer && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-stretch justify-center p-6"
          onClick={closeViewer}
        >
          <div
            className="flex flex-col w-full max-w-5xl bg-white dark:bg-gray-900 rounded-2xl overflow-hidden shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate flex-1">
                {viewer?.file.name ?? "Loading…"}
              </span>
              <div className="flex items-center gap-2">
                {viewer && (
                  <button
                    onClick={() => saveFile(viewer.file)}
                    disabled={downloading === viewer.file.file_id}
                    className="flex items-center gap-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50"
                  >
                    <DownloadIcon />
                    {downloading === viewer.file.file_id ? "Preparing…" : "Download"}
                  </button>
                )}
                <button
                  className="flex items-center justify-center w-8 h-8 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                  onClick={closeViewer}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 relative">
              {viewerLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-sm text-gray-400">Loading preview…</p>
                </div>
              )}
              {viewerError && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-sm text-red-500">{viewerError}</p>
                </div>
              )}
              {viewer && (
                <iframe src={viewer.blobUrl} className="w-full h-full border-0" title={viewer.file.name} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Portal Messaging Component ────────────────────────────────────────────────

function PortalMessaging({ token, sessionToken }: { token: string; sessionToken: string | null }) {
  const [messages, setMessages] = useState<PortalMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sessionHeader = sessionToken ? { "X-Portal-Session": sessionToken } : {};

  const load = useCallback(async () => {
    const res = await fetch(`/api/proxy/messaging/portal/${token}/messages`, {
      headers: { ...sessionHeader },
    }).catch(() => null);
    if (res?.ok) {
      const d = await res.json();
      setMessages(d.messages ?? []);
    }
    setLoading(false);
  }, [token, sessionToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    const body = text.trim();
    setText("");
    try {
      const res = await fetch(`/api/proxy/messaging/portal/${token}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeader },
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages(prev => [...prev, msg]);
      }
    } finally { setSending(false); }
  }

  function fmtTime(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-5">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-3">
          <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Messages</h3>
          <span className="text-[11px] text-gray-400">Send a message to the team</span>
        </div>

        {/* Message thread */}
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="max-h-64 overflow-y-auto px-4 py-3 space-y-3 bg-gray-50 dark:bg-gray-800/30">
            {loading ? (
              <div className="flex justify-center py-4">
                <svg className="w-4 h-4 animate-spin text-gray-300" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              </div>
            ) : messages.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-xs text-gray-400">No messages yet. Send a message to the team below.</p>
              </div>
            ) : (
              messages.map(msg => {
                const isPortalSender = !!msg.portal_token;
                const displayName = msg.sender_display_name || msg.sender_name || (isPortalSender ? "You" : "Team");
                return (
                  <div key={msg.message_id} className={`flex gap-2 ${isPortalSender ? "flex-row-reverse" : ""}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 ${isPortalSender ? "bg-blue-500" : "bg-gray-700 dark:bg-gray-600"}`}>
                      {displayName[0].toUpperCase()}
                    </div>
                    <div className={`max-w-xs ${isPortalSender ? "items-end" : "items-start"} flex flex-col`}>
                      <div className={`flex items-baseline gap-1.5 ${isPortalSender ? "flex-row-reverse" : ""}`}>
                        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">{isPortalSender ? "You" : displayName}</span>
                        <span className="text-[10px] text-gray-400">{fmtTime(msg.created_at)}</span>
                      </div>
                      <div className={`mt-0.5 px-3 py-1.5 rounded-xl text-xs text-gray-700 dark:text-gray-200 leading-relaxed ${isPortalSender ? "bg-blue-100 dark:bg-blue-900/40" : "bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700"}`}>
                        {msg.body}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Compose */}
          <form onSubmit={send} className="flex gap-2 p-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Send a message to the team…"
              className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            <button type="submit" disabled={!text.trim() || sending}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
              {sending ? "…" : "Send"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── FileTable ─────────────────────────────────────────────────────────────────

function FileTable({
  files,
  token,
  viewer,
  onView,
  onClose,
  onDownload,
}: {
  files: PortalFile[];
  token: string;
  viewer: { file: PortalFile; blobUrl: string } | null;
  onView: (f: PortalFile) => void;
  onClose: () => void;
  onDownload: (f: PortalFile) => void;
}) {
  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {files.map(f => {
        const meta    = MIME_META[f.mime_type ?? ""] ?? { label: "File", color: "#8E8E8E" };
        const canView = VIEWABLE.has(f.mime_type ?? "");
        const canDl   = !NOT_DOWNLOADABLE.has(f.mime_type ?? "");
        const isActive = viewer?.file.file_id === f.file_id;
        return (
          <div
            key={f.file_id}
            className={`flex items-center gap-3.5 px-4 py-3 transition-colors ${
              isActive ? "bg-amber-50 dark:bg-amber-950/30" : "bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/60"
            }`}
          >
            <span
              className="text-[10px] font-bold uppercase tracking-wide rounded-md px-1.5 py-0.5 shrink-0 w-11 text-center"
              style={{ background: meta.color + "18", color: meta.color }}
            >
              {meta.label}
            </span>
            <div className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {f.name}
              </span>
              {f.description && (
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug line-clamp-2">
                  {f.description}
                </span>
              )}
              <span className="block text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                {fmtDate(f.modified_time)}{f.size_bytes ? ` · ${fmtSize(f.size_bytes)}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {canView && (
                <button
                  className={`text-xs font-medium rounded-lg px-3 py-1.5 border transition-colors ${
                    isActive
                      ? "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-700"
                      : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300"
                  }`}
                  onClick={() => isActive ? onClose() : onView(f)}
                >
                  {isActive ? "Close" : "View"}
                </button>
              )}
              {canDl && (
                <button
                  onClick={() => onDownload(f)}
                  className="flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 transition-colors hover:border-gray-300"
                >
                  <DownloadIcon />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SubFolderCard ─────────────────────────────────────────────────────────────

function SubFolderCard({ folder, onClick }: { folder: PortalFile; onClick: () => void }) {
  return (
    <button
      className="flex items-center gap-3 px-4 py-3 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 rounded-xl text-left hover:bg-amber-100/70 dark:hover:bg-amber-900/30 hover:border-amber-200 dark:hover:border-amber-800 hover:shadow-sm transition-all group"
      onClick={onClick}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#F59E0B" className="shrink-0">
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      </svg>
      <div className="flex-1 min-w-0">
        <span className="block text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{folder.name}</span>
        {folder.description && (
          <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 truncate">{folder.description}</span>
        )}
      </div>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
        className="text-amber-400 dark:text-amber-600 shrink-0 group-hover:translate-x-0.5 transition-transform">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

// ── Helper components ─────────────────────────────────────────────────────────

function ContactChip({ contact }: { contact: PortalContact }) {
  const initials = contact.name.split(" ").map(p => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="flex items-center gap-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
      <div className="w-8 h-8 rounded-full bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300 flex items-center justify-center text-xs font-bold shrink-0">
        {initials}
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">{contact.name}</span>
        {contact.title && <span className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{contact.title}</span>}
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="text-[11px] text-red-600 dark:text-red-400 hover:underline truncate" onClick={e => e.stopPropagation()}>
            {contact.email}
          </a>
        )}
      </div>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

function LogoMark() {
  return (
    <img
      src="/api/logo"
      alt="Open ERP"
      style={{ height: 24, width: "auto" }}
      onError={(e) => {
        const i = e.currentTarget;
        if (!i.src.includes("logo.svg")) i.src = "/logo.svg";
      }}
    />
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col font-sans">
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center">
          <LogoMark />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ── Password Gate ─────────────────────────────────────────────────────────────

function PasswordGate({
  token,
  onSuccess,
}: {
  token: string;
  onSuccess: (sessionToken: string, viewerName: string | null) => void;
}) {
  const [password, setPassword] = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/proxy/portal/${token}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "Incorrect password");
      }
      const data = await r.json();
      onSuccess(data.session_token, data.viewer_name ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Incorrect password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col font-sans">
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center">
          <LogoMark />
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 shadow-sm">
            <div className="w-11 h-11 rounded-xl bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center mb-5">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="text-gray-500 dark:text-gray-400">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            </div>
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">Password required</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-6">
              This data room is protected. Enter your password to continue.
            </p>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
                className={`w-full px-3 py-2.5 text-sm rounded-lg border bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 outline-none transition-colors ${
                  error
                    ? "border-red-300 dark:border-red-700"
                    : "border-gray-200 dark:border-gray-700 focus:border-gray-400 dark:focus:border-gray-500"
                }`}
              />
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                disabled={loading || !password}
                className="w-full py-2.5 text-sm font-semibold rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white transition-colors disabled:cursor-not-allowed"
              >
                {loading ? "Verifying…" : "Access data room"}
              </button>
            </form>
          </div>
          <p className="text-[11px] text-gray-300 dark:text-gray-600 text-center mt-5">
            Shared via Open ERP Platform
          </p>
        </div>
      </div>
    </div>
  );
}
