"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

interface PortalInfo {
  portal_id: string;
  token: string;
  slug: string | null;
  is_active: boolean;
  portal_drive_folder_id: string | null;
  portal_drive_folder_name: string | null;
  is_password_protected: boolean;
}

interface PortalContent {
  description: string | null;
  is_password_protected: boolean;
  has_portal_password: boolean;
  contacts: Array<{ id: number; name: string; title: string | null; email: string | null; phone: string | null }>;
  updates: Array<{ id: number; title: string; body: string | null; created_at: string; created_by_name: string | null }>;
}

interface PortalViewer {
  viewer_id: string;
  name: string;
  email: string | null;
  firm: string | null;
  is_active: boolean;
  created_at: string;
}

interface ActivityEntry {
  log_id: number;
  viewer_id: string | null;
  viewer_name: string | null;
  event_type: string;
  file_id: string | null;
  file_name: string | null;
  section: string | null;
  ip_address: string | null;
  created_at: string;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PortalManagePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();

  const [projectName, setProjectName] = useState<string>("");
  const [portalInfo, setPortalInfo]   = useState<PortalInfo | null>(null);
  const [portalLoading, setPortalLoading] = useState(true);
  const [portalCreating, setPortalCreating] = useState(false);
  const [portalCopied, setPortalCopied]   = useState(false);

  // Content
  const [content, setContent]             = useState<PortalContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  // Folder
  const [folderInput, setFolderInput]     = useState("");
  const [folderSaving, setFolderSaving]   = useState(false);
  const [folderError, setFolderError]     = useState<boolean | string>(false);
  const [showFolderForm, setShowFolderForm] = useState(false);

  // Description
  const [descDraft, setDescDraft]         = useState("");
  const [descSaving, setDescSaving]       = useState(false);
  const [descSaved, setDescSaved]         = useState(false);

  // Password
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordInput, setPasswordInput]       = useState("");
  const [passwordSaving, setPasswordSaving]     = useState(false);
  const [passwordSaved, setPasswordSaved]       = useState(false);

  // Contacts
  const [showContactForm, setShowContactForm] = useState(false);
  const [cName, setCName]   = useState("");
  const [cTitle, setCTitle] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cSaving, setCSaving] = useState(false);
  const [editContactId, setEditContactId] = useState<number | null>(null);
  const [ecName, setEcName]   = useState("");
  const [ecTitle, setEcTitle] = useState("");
  const [ecEmail, setEcEmail] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [ecSaving, setEcSaving] = useState(false);

  // Updates
  const [showUpdateForm, setShowUpdateForm] = useState(false);
  const [uTitle, setUTitle] = useState("");
  const [uBody, setUBody]   = useState("");
  const [uSaving, setUSaving] = useState(false);

  // Viewers
  const [viewers, setViewers]           = useState<PortalViewer[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const [showViewerForm, setShowViewerForm] = useState(false);
  const [vName, setVName]   = useState("");
  const [vEmail, setVEmail] = useState("");
  const [vFirm, setVFirm]   = useState("");
  const [vPw, setVPw]       = useState("");
  const [vSaving, setVSaving] = useState(false);
  const [editViewerId, setEditViewerId] = useState<string | null>(null);
  const [evName, setEvName]   = useState("");
  const [evEmail, setEvEmail] = useState("");
  const [evFirm, setEvFirm]   = useState("");
  const [evPw, setEvPw]       = useState("");
  const [evSaving, setEvSaving] = useState(false);

  // Slug
  const [showSlugForm, setShowSlugForm] = useState(false);
  const [slugInput, setSlugInput]       = useState("");
  const [slugSaving, setSlugSaving]     = useState(false);
  const [slugError, setSlugError]       = useState("");

  // Activity
  const [activity, setActivity]         = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const fetchPortal = useCallback(async () => {
    setPortalLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal`);
      if (r.ok) {
        const d = await r.json();
        setPortalInfo(d.portal ?? null);
      }
    } finally {
      setPortalLoading(false);
    }
  }, [projectId]);

  const fetchContent = useCallback(async () => {
    setContentLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal/content`);
      if (r.ok) {
        const d = await r.json();
        setContent(d);
        if (!descSaving) setDescDraft(d.description ?? "");
      }
    } finally {
      setContentLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const fetchViewers = useCallback(async () => {
    setViewersLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal/viewers`);
      if (r.ok) setViewers(await r.json());
    } finally {
      setViewersLoading(false);
    }
  }, [projectId]);

  const fetchActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const r = await fetch(`/api/proxy/projects/${projectId}/portal/activity`);
      if (r.ok) setActivity(await r.json());
    } finally {
      setActivityLoading(false);
    }
  }, [projectId]);

  // Fetch project name from projects list (simple approach)
  useEffect(() => {
    fetch(`/api/proxy/projects/${projectId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.name) setProjectName(d.name); })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => { fetchPortal(); }, [fetchPortal]);
  useEffect(() => { if (portalInfo) { fetchContent(); fetchViewers(); } }, [portalInfo, fetchContent, fetchViewers]);
  useEffect(() => { if (!descSaving && content) setDescDraft(content.description ?? ""); }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ────────────────────────────────────────────────────────────────

  async function createPortal() {
    setPortalCreating(true);
    await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "POST" });
    setPortalCreating(false);
    fetchPortal();
  }

  async function revokePortal() {
    await fetch(`/api/proxy/projects/${projectId}/portal`, { method: "DELETE" });
    setPortalInfo(null);
    setContent(null);
    setViewers([]);
    setActivity([]);
  }

  async function saveFolder(e: React.FormEvent) {
    e.preventDefault();
    setFolderSaving(true);
    setFolderError(false);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_url: folderInput.trim() }),
    });
    if (r.ok) { setShowFolderForm(false); setFolderInput(""); fetchPortal(); }
    else {
      try {
        const data = await r.json();
        const detail = data?.detail;
        if (detail?.code === "no_google_token") setFolderError("Connect your Google account first (Settings → Integrations).");
        else if (detail?.code === "needs_drive_scope") setFolderError("Re-connect your Google account and grant Drive access.");
        else if (typeof detail === "string") setFolderError(detail);
        else setFolderError(true);
      } catch { setFolderError(true); }
    }
    setFolderSaving(false);
  }

  async function saveDescription() {
    setDescSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: descDraft.trim() || null }),
    });
    if (r.ok) { setDescSaved(true); setTimeout(() => setDescSaved(false), 2000); fetchContent(); }
    setDescSaving(false);
  }

  async function togglePasswordProtected(enabled: boolean) {
    await fetch(`/api/proxy/projects/${projectId}/portal/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_password_protected: enabled }),
    });
    fetchContent();
  }

  async function savePortalPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordInput.trim()) return;
    setPasswordSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.trim() }),
    });
    if (r.ok) {
      setPasswordInput(""); setShowPasswordForm(false);
      setPasswordSaved(true); setTimeout(() => setPasswordSaved(false), 2500);
      fetchContent();
    }
    setPasswordSaving(false);
  }

  async function saveSlug(e: React.FormEvent) {
    e.preventDefault();
    setSlugError("");
    setSlugSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/slug`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slugInput.trim() || null }),
    });
    if (r.ok) {
      const d = await r.json();
      setPortalInfo(prev => prev ? { ...prev, slug: d.slug } : prev);
      setShowSlugForm(false); setSlugInput("");
    } else {
      const d = await r.json().catch(() => ({}));
      setSlugError(d.detail ?? "Failed to save slug");
    }
    setSlugSaving(false);
  }

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    if (!cName.trim()) return;
    setCSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cName.trim(), title: cTitle.trim() || null, email: cEmail.trim() || null, phone: cPhone.trim() || null }),
    });
    if (r.ok) { setCName(""); setCTitle(""); setCEmail(""); setCPhone(""); setShowContactForm(false); fetchContent(); }
    setCSaving(false);
  }

  function startEditContact(c: PortalContent["contacts"][0]) {
    setEditContactId(c.id); setEcName(c.name); setEcTitle(c.title ?? ""); setEcEmail(c.email ?? ""); setEcPhone(c.phone ?? "");
  }

  async function saveEditContact(e: React.FormEvent, id: number) {
    e.preventDefault();
    setEcSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/contacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ecName.trim(), title: ecTitle.trim() || null, email: ecEmail.trim() || null, phone: ecPhone.trim() || null }),
    });
    if (r.ok) { setEditContactId(null); fetchContent(); }
    setEcSaving(false);
  }

  async function deleteContact(id: number) {
    await fetch(`/api/proxy/projects/${projectId}/portal/contacts/${id}`, { method: "DELETE" });
    fetchContent();
  }

  async function postUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!uTitle.trim()) return;
    setUSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: uTitle.trim(), body: uBody.trim() || null }),
    });
    if (r.ok) { setUTitle(""); setUBody(""); setShowUpdateForm(false); fetchContent(); }
    setUSaving(false);
  }

  async function deleteUpdate(id: number) {
    await fetch(`/api/proxy/projects/${projectId}/portal/updates/${id}`, { method: "DELETE" });
    fetchContent();
  }

  async function addViewer(e: React.FormEvent) {
    e.preventDefault();
    if (!vName.trim() || !vPw.trim()) return;
    setVSaving(true);
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/viewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: vName.trim(), email: vEmail.trim() || null, firm: vFirm.trim() || null, password: vPw }),
    });
    if (r.ok) { setVName(""); setVEmail(""); setVFirm(""); setVPw(""); setShowViewerForm(false); fetchViewers(); }
    setVSaving(false);
  }

  function startEditViewer(v: PortalViewer) {
    setEditViewerId(v.viewer_id); setEvName(v.name); setEvEmail(v.email ?? ""); setEvFirm(v.firm ?? ""); setEvPw("");
  }

  async function saveEditViewer(e: React.FormEvent, vid: string) {
    e.preventDefault();
    setEvSaving(true);
    const body: Record<string, unknown> = { name: evName.trim(), email: evEmail.trim() || null, firm: evFirm.trim() || null };
    if (evPw.trim()) body.password = evPw;
    const r = await fetch(`/api/proxy/projects/${projectId}/portal/viewers/${vid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { setEditViewerId(null); fetchViewers(); }
    setEvSaving(false);
  }

  async function deleteViewer(vid: string) {
    await fetch(`/api/proxy/projects/${projectId}/portal/viewers/${vid}`, { method: "DELETE" });
    fetchViewers();
  }

  async function toggleViewerActive(vid: string, active: boolean) {
    await fetch(`/api/proxy/projects/${projectId}/portal/viewers/${vid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: active }),
    });
    fetchViewers();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const portalIdentifier = portalInfo?.slug ?? portalInfo?.token ?? "";
  const portalUrl = portalInfo ? `${typeof window !== "undefined" ? window.location.origin : ""}/portal/${portalIdentifier}` : "";

  return (
    <div className="max-w-2xl space-y-4">

      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link
          href="/portals"
          className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Portals
        </Link>
        <span className="text-gray-200 dark:text-gray-700">/</span>
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
          {projectName || "Portal"}
        </h1>
      </div>

      {portalLoading ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      ) : (
        <>
          {/* ── Section 1: Portal link ── */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                </svg>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Portal Link</span>
              </div>
              {portalInfo ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { navigator.clipboard.writeText(portalUrl).then(() => { setPortalCopied(true); setTimeout(() => setPortalCopied(false), 2000); }); }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {portalCopied ? "Copied!" : "Copy link"}
                  </button>
                  <a href={`/portal/${portalIdentifier}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                    Preview ↗
                  </a>
                  <button onClick={revokePortal} className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                    Revoke
                  </button>
                </div>
              ) : (
                <button
                  onClick={createPortal}
                  disabled={portalCreating}
                  className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
                >
                  {portalCreating ? "Creating…" : "Generate link"}
                </button>
              )}
            </div>
            {portalInfo && (
              <p className="text-[11px] text-gray-400 truncate font-mono">{portalUrl}</p>
            )}
            {portalInfo && (
              showSlugForm ? (
                <form onSubmit={saveSlug} className="flex gap-2 items-center">
                  <span className="text-[11px] text-gray-400 shrink-0 font-mono">/portal/</span>
                  <input
                    type="text"
                    placeholder={portalInfo.slug ?? "short-name"}
                    value={slugInput}
                    onChange={e => { setSlugInput(e.target.value); setSlugError(""); }}
                    autoFocus
                    className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  />
                  <button type="submit" disabled={slugSaving}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                    {slugSaving ? "Saving…" : "Save"}
                  </button>
                  {portalInfo.slug && (
                    <button type="button" onClick={async () => { setSlugSaving(true); const r = await fetch(`/api/proxy/projects/${projectId}/portal/slug`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: null }) }); if (r.ok) { setPortalInfo(prev => prev ? { ...prev, slug: null } : prev); setShowSlugForm(false); } setSlugSaving(false); }}
                      className="text-xs text-red-400 hover:text-red-600 shrink-0">
                      Remove
                    </button>
                  )}
                  <button type="button" onClick={() => { setShowSlugForm(false); setSlugInput(""); setSlugError(""); }}
                    className="text-xs text-gray-400 hover:text-gray-600 shrink-0">
                    Cancel
                  </button>
                  {slugError && <span className="text-xs text-red-500">{slugError}</span>}
                </form>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-400">
                    {portalInfo.slug
                      ? <><span className="text-gray-300 dark:text-gray-600">Short URL: </span><span className="font-mono">/portal/{portalInfo.slug}</span></>
                      : <span className="italic">No short URL set</span>}
                  </span>
                  <button onClick={() => { setSlugInput(portalInfo.slug ?? ""); setShowSlugForm(true); }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0">
                    {portalInfo.slug ? "Edit" : "Set short URL"}
                  </button>
                </div>
              )
            )}
          </div>

          {portalInfo && (
            <>
              {/* ── Section 2: Drive folder ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Documents Folder</p>
                {showFolderForm ? (
                  <form onSubmit={saveFolder} className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder="Drive folder URL or ID…"
                      value={folderInput}
                      onChange={e => setFolderInput(e.target.value)}
                      autoFocus
                      className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button type="submit" disabled={!folderInput.trim() || folderSaving}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                      {folderSaving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onClick={() => { setShowFolderForm(false); setFolderInput(""); }}
                      className="text-xs text-gray-400 hover:text-gray-600 shrink-0">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {portalInfo.portal_drive_folder_name ?? <span className="text-gray-400 italic">Using project folder</span>}
                      </span>
                    </div>
                    <button onClick={() => setShowFolderForm(true)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0">
                      {portalInfo.portal_drive_folder_id ? "Change" : "Set folder"}
                    </button>
                  </div>
                )}
                {folderError && <p className="text-[11px] text-red-500 mt-1">{typeof folderError === "string" ? folderError : "Could not link folder. Check the URL and permissions."}</p>}
              </div>

              {/* ── Section 3: Description ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Overview Description</p>
                {contentLoading && !content ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : (
                  <>
                    <AutoTextarea
                      rows={4}
                      placeholder="Add a description shown to visitors on the portal overview page…"
                      value={descDraft}
                      onChange={e => setDescDraft(e.target.value)}
                      className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <button onClick={saveDescription} disabled={descSaving}
                        className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                        {descSaving ? "Saving…" : descSaved ? "Saved!" : "Save"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* ── Section 4: Password protection ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4"/>
                    </svg>
                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Password Protection</p>
                  </div>
                  <button
                    onClick={() => togglePasswordProtected(!(content?.is_password_protected ?? false))}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      content?.is_password_protected ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                      content?.is_password_protected ? "translate-x-4" : "translate-x-1"
                    }`} />
                  </button>
                </div>

                {content?.is_password_protected && (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Visitors must enter a password to access this portal. Set a shared password below, or add individual investor logins in the Investors section.
                    </p>
                    <div className="flex items-center justify-between gap-2 py-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 dark:text-gray-300">Shared password</span>
                        {content?.has_portal_password && !showPasswordForm && (
                          <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded font-medium">Set</span>
                        )}
                        {passwordSaved && <span className="text-[10px] text-green-600">Saved!</span>}
                      </div>
                      {!showPasswordForm && (
                        <button onClick={() => setShowPasswordForm(true)}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                          {content?.has_portal_password ? "Change" : "Set password"}
                        </button>
                      )}
                    </div>
                    {showPasswordForm && (
                      <form onSubmit={savePortalPassword} className="flex gap-2 items-center">
                        <input
                          type="password"
                          placeholder="New shared password…"
                          value={passwordInput}
                          onChange={e => setPasswordInput(e.target.value)}
                          autoFocus
                          className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button type="submit" disabled={!passwordInput.trim() || passwordSaving}
                          className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                          {passwordSaving ? "Saving…" : "Save"}
                        </button>
                        <button type="button" onClick={() => { setShowPasswordForm(false); setPasswordInput(""); }}
                          className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Cancel</button>
                      </form>
                    )}
                  </div>
                )}
              </div>

              {/* ── Section 5: Investors ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Investors
                      {viewers.length > 0 && <span className="ml-1.5 text-gray-400 normal-case font-normal">({viewers.length})</span>}
                    </p>
                  </div>
                  {!showViewerForm && (
                    <button onClick={() => setShowViewerForm(true)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      + Add investor
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-400">Each investor gets a named login. Their activity is tracked individually.</p>

                {viewersLoading && viewers.length === 0 ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : (
                  <>
                    {viewers.map(v => (
                      <div key={v.viewer_id} className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5">
                        {editViewerId === v.viewer_id ? (
                          <form onSubmit={e => saveEditViewer(e, v.viewer_id)} className="space-y-1.5">
                            <input type="text" placeholder="Name *" value={evName} onChange={e => setEvName(e.target.value)} required
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="email" placeholder="Email" value={evEmail} onChange={e => setEvEmail(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="text" placeholder="Firm" value={evFirm} onChange={e => setEvFirm(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="password" placeholder="New password (leave blank to keep)" value={evPw} onChange={e => setEvPw(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <div className="flex gap-2">
                              <button type="submit" disabled={evSaving} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                                {evSaving ? "Saving…" : "Save"}
                              </button>
                              <button type="button" onClick={() => setEditViewerId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                            </div>
                          </form>
                        ) : (
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{v.name}</p>
                                {!v.is_active && (
                                  <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">Disabled</span>
                                )}
                              </div>
                              <p className="text-[11px] text-gray-400">
                                {[v.firm, v.email].filter(Boolean).join(" · ") || "No email or firm"}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button onClick={() => toggleViewerActive(v.viewer_id, !v.is_active)}
                                className="text-[11px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
                                {v.is_active ? "Disable" : "Enable"}
                              </button>
                              <button onClick={() => startEditViewer(v)} className="text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Edit</button>
                              <button onClick={() => deleteViewer(v.viewer_id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Delete</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}

                    {showViewerForm && (
                      <form onSubmit={addViewer} className="border border-blue-100 dark:border-blue-900/30 rounded-lg px-3 py-2.5 space-y-1.5 bg-blue-50/30 dark:bg-blue-950/10">
                        <input type="text" placeholder="Name *" value={vName} onChange={e => setVName(e.target.value)} required autoFocus
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="email" placeholder="Email" value={vEmail} onChange={e => setVEmail(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Firm" value={vFirm} onChange={e => setVFirm(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="password" placeholder="Password *" value={vPw} onChange={e => setVPw(e.target.value)} required
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2">
                          <button type="submit" disabled={vSaving || !vName.trim() || !vPw.trim()}
                            className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                            {vSaving ? "Adding…" : "Add investor"}
                          </button>
                          <button type="button" onClick={() => { setShowViewerForm(false); setVName(""); setVEmail(""); setVFirm(""); setVPw(""); }}
                            className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                        </div>
                      </form>
                    )}

                    {viewers.length === 0 && !showViewerForm && (
                      <p className="text-xs text-gray-400 py-1">No investors added yet.</p>
                    )}
                  </>
                )}
              </div>

              {/* ── Section 6: Contacts ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Team Contacts</p>
                  {!showContactForm && (
                    <button onClick={() => setShowContactForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      + Add contact
                    </button>
                  )}
                </div>
                {contentLoading && !content ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : (
                  <>
                    {(content?.contacts ?? []).map(c => (
                      <div key={c.id} className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5">
                        {editContactId === c.id ? (
                          <form onSubmit={e => saveEditContact(e, c.id)} className="space-y-1.5">
                            <input type="text" placeholder="Name *" value={ecName} onChange={e => setEcName(e.target.value)} required
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="text" placeholder="Title" value={ecTitle} onChange={e => setEcTitle(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="email" placeholder="Email" value={ecEmail} onChange={e => setEcEmail(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <input type="text" placeholder="Phone" value={ecPhone} onChange={e => setEcPhone(e.target.value)}
                              className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <div className="flex gap-2">
                              <button type="submit" disabled={ecSaving} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                                {ecSaving ? "Saving…" : "Save"}
                              </button>
                              <button type="button" onClick={() => setEditContactId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                            </div>
                          </form>
                        ) : (
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{c.name}</p>
                              {c.title && <p className="text-xs text-gray-500">{c.title}</p>}
                              {c.email && <p className="text-xs text-blue-600 dark:text-blue-400">{c.email}</p>}
                              {c.phone && <p className="text-xs text-gray-500">{c.phone}</p>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button onClick={() => startEditContact(c)} className="text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Edit</button>
                              <button onClick={() => deleteContact(c.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Delete</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {showContactForm && (
                      <form onSubmit={addContact} className="border border-blue-100 dark:border-blue-900/30 rounded-lg px-3 py-2.5 space-y-1.5 bg-blue-50/30 dark:bg-blue-950/10">
                        <input type="text" placeholder="Name *" value={cName} onChange={e => setCName(e.target.value)} required autoFocus
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Title" value={cTitle} onChange={e => setCTitle(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="email" placeholder="Email" value={cEmail} onChange={e => setCEmail(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Phone" value={cPhone} onChange={e => setCPhone(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2">
                          <button type="submit" disabled={cSaving || !cName.trim()} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                            {cSaving ? "Adding…" : "Add"}
                          </button>
                          <button type="button" onClick={() => { setShowContactForm(false); setCName(""); setCTitle(""); setCEmail(""); setCPhone(""); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                        </div>
                      </form>
                    )}
                    {(content?.contacts ?? []).length === 0 && !showContactForm && (
                      <p className="text-xs text-gray-400 py-1">No contacts added yet.</p>
                    )}
                  </>
                )}
              </div>

              {/* ── Section 7: Updates ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Progress Updates</p>
                  {!showUpdateForm && (
                    <button onClick={() => setShowUpdateForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      + Post update
                    </button>
                  )}
                </div>
                {showUpdateForm && (
                  <form onSubmit={postUpdate} className="border border-blue-100 dark:border-blue-900/30 rounded-lg px-3 py-2.5 space-y-1.5 bg-blue-50/30 dark:bg-blue-950/10">
                    <input type="text" placeholder="Update title *" value={uTitle} onChange={e => setUTitle(e.target.value)} required autoFocus
                      className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <AutoTextarea placeholder="Details (optional)…" value={uBody} onChange={e => setUBody(e.target.value)} rows={3}
                      className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
                    <div className="flex gap-2">
                      <button type="submit" disabled={uSaving || !uTitle.trim()} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                        {uSaving ? "Posting…" : "Post"}
                      </button>
                      <button type="button" onClick={() => { setShowUpdateForm(false); setUTitle(""); setUBody(""); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    </div>
                  </form>
                )}
                {contentLoading && !content ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : (content?.updates ?? []).length === 0 && !showUpdateForm ? (
                  <p className="text-xs text-gray-400 py-1">No updates posted yet.</p>
                ) : (
                  <div className="space-y-2">
                    {(content?.updates ?? []).map(u => (
                      <div key={u.id} className="border-l-2 border-blue-200 dark:border-blue-800 pl-3 py-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 leading-snug">{u.title}</p>
                            {u.body && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed whitespace-pre-wrap">{u.body}</p>}
                            <p className="text-[11px] text-gray-400 mt-1">
                              {new Date(u.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              {u.created_by_name ? ` · ${u.created_by_name}` : ""}
                            </p>
                          </div>
                          <button onClick={() => deleteUpdate(u.id)} className="text-[11px] text-gray-300 hover:text-red-500 transition-colors shrink-0 mt-0.5">
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Section 8: Activity log ── */}
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                    </svg>
                    <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Activity Log</p>
                  </div>
                  <button
                    onClick={() => { if (!showActivity) { setShowActivity(true); fetchActivity(); } else setShowActivity(false); }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {showActivity ? "Hide" : "Show"}
                  </button>
                </div>
                {showActivity && (
                  <>
                    {activityLoading ? (
                      <p className="text-xs text-gray-400">Loading…</p>
                    ) : activity.length === 0 ? (
                      <p className="text-xs text-gray-400 py-1">No activity recorded yet.</p>
                    ) : (
                      <div className="divide-y divide-gray-50 dark:divide-gray-800 max-h-96 overflow-y-auto -mx-1 px-1">
                        {activity.map(e => (
                          <div key={e.log_id} className="flex items-start gap-3 py-2">
                            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                              e.event_type === "login" ? "bg-green-500" :
                              e.event_type === "file_download" ? "bg-orange-400" :
                              e.event_type === "file_view" ? "bg-blue-400" : "bg-gray-300"
                            }`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="text-xs font-medium text-gray-800 dark:text-gray-200">
                                  {e.viewer_name ?? "Anonymous"}
                                </span>
                                <span className="text-[11px] text-gray-400">
                                  {e.event_type === "login" ? "signed in" :
                                   e.event_type === "file_view" ? `viewed ${e.file_name ?? "a file"}` :
                                   e.event_type === "file_download" ? `downloaded ${e.file_name ?? "a file"}` :
                                   `visited ${e.section ?? "portal"}`}
                                </span>
                              </div>
                              <p className="text-[10px] text-gray-400 mt-0.5">
                                {new Date(e.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                                {e.ip_address ? ` · ${e.ip_address}` : ""}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <button onClick={fetchActivity} className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                      Refresh
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
