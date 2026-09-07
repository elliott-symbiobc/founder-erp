"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { AutoTextarea } from "@/components/AutoTextarea";
import RoomTilesEditor from "@/components/portal/RoomTilesEditor";
import RoomAccessList from "@/components/portal/RoomAccessList";
import { portalPath, portalUrl as buildPortalUrl } from "@/lib/portalLinks";
// ── Types ─────────────────────────────────────────────────────────────────────

interface RoomFile {
  file_id: string;
  name: string;
  mime_type: string | null;
  description?: string | null;
}

interface RoomInfo {
  portal_id: string;
  token: string;
  slug: string | null;
  is_active: boolean;
  portal_drive_folder_id: string | null;
  portal_drive_folder_name: string | null;
  is_password_protected: boolean;
  name: string | null;
  messaging_enabled: boolean;
  messaging_channel_id: string | null;
}

interface RoomContent {
  description: string | null;
  is_password_protected: boolean;
  has_portal_password: boolean;
  contacts: Array<{ id: number; name: string; title: string | null; email: string | null; phone: string | null }>;
  updates: Array<{ id: number; title: string; body: string | null; created_at: string; created_by_name: string | null }>;
}

interface Viewer {
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

type RoomTab = "tiles" | "content" | "documents" | "access" | "activity";

const TABS: { id: RoomTab; label: string }[] = [
  { id: "tiles",     label: "Tiles" },
  { id: "content",   label: "Details" },
  { id: "documents", label: "Documents" },
  { id: "access",    label: "Access" },
  { id: "activity",  label: "Activity" },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RoomManagePage() {
  const { portalId } = useParams<{ portalId: string }>();
  const base = `/api/proxy/portals/room/${portalId}`;

  const [room, setRoom]               = useState<RoomInfo | null>(null);
  const [roomLoading, setRoomLoading] = useState(true);
  const [copied, setCopied]           = useState(false);
  const [tab, setTab]                 = useState<RoomTab>("tiles");

  // Rename
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState("");
  const [nameSaving, setNameSaving]   = useState(false);

  // Content
  const [content, setContent]           = useState<RoomContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  // Folder
  const [folderInput, setFolderInput]   = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const [folderError, setFolderError]   = useState<boolean | string>(false);
  const [showFolderForm, setShowFolderForm] = useState(false);

  // Password
  const [showPwForm, setShowPwForm]   = useState(false);
  const [pwInput, setPwInput]         = useState("");
  const [pwSaving, setPwSaving]       = useState(false);
  const [pwSaved, setPwSaved]         = useState(false);

  // Contacts
  const [showCForm, setShowCForm] = useState(false);
  const [cName, setCName]   = useState("");
  const [cTitle, setCTitle] = useState("");
  const [cEmail, setCEmail] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cSaving, setCSaving] = useState(false);
  const [editCid, setEditCid] = useState<number | null>(null);
  const [ecName, setEcName]   = useState("");
  const [ecTitle, setEcTitle] = useState("");
  const [ecEmail, setEcEmail] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [ecSaving, setEcSaving] = useState(false);

  // Updates
  const [showUForm, setShowUForm] = useState(false);
  const [uTitle, setUTitle] = useState("");
  const [uBody, setUBody]   = useState("");
  const [uSaving, setUSaving] = useState(false);

  // Viewers
  const [viewers, setViewers]   = useState<Viewer[]>([]);
  const [vLoading, setVLoading] = useState(false);
  const [showVForm, setShowVForm] = useState(false);
  const [vName, setVName]   = useState("");
  const [vEmail, setVEmail] = useState("");
  const [vFirm, setVFirm]   = useState("");
  const [vPw, setVPw]       = useState("");
  const [vSaving, setVSaving] = useState(false);
  const [editVid, setEditVid]   = useState<string | null>(null);
  const [evName, setEvName]     = useState("");
  const [evEmail, setEvEmail]   = useState("");
  const [evFirm, setEvFirm]     = useState("");
  const [evPw, setEvPw]         = useState("");
  const [evSaving, setEvSaving] = useState(false);

  // Room files (for description editing)
  const [roomFiles, setRoomFiles]           = useState<RoomFile[]>([]);
  const [roomFilesLoading, setRoomFilesLoading] = useState(false);
  const [editingFileId, setEditingFileId]   = useState<string | null>(null);
  const [fileDescDraft, setFileDescDraft]   = useState("");
  const [fileDescSaving, setFileDescSaving] = useState(false);

  // Slug
  const [showSlugForm, setShowSlugForm] = useState(false);
  const [slugInput, setSlugInput]       = useState("");
  const [slugSaving, setSlugSaving]     = useState(false);
  const [slugError, setSlugError]       = useState("");

  // Activity
  const [activity, setActivity]   = useState<ActivityEntry[]>([]);
  const [aLoading, setALoading]   = useState(false);
  const [showActivity, setShowActivity] = useState(false);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const fetchRoom = useCallback(async () => {
    setRoomLoading(true);
    const r = await fetch(base);
    if (r.ok) {
      const d = await r.json();
      setRoom(d);
      setNameDraft(d.name ?? "");
    }
    setRoomLoading(false);
  }, [base]);

  const fetchContent = useCallback(async () => {
    setContentLoading(true);
    const r = await fetch(`${base}/content`);
    if (r.ok) {
      const d = await r.json();
      setContent(d);
    }
    setContentLoading(false);
  }, [base]);

  const fetchViewers = useCallback(async () => {
    setVLoading(true);
    const r = await fetch(`${base}/viewers`);
    if (r.ok) setViewers(await r.json());
    setVLoading(false);
  }, [base]);

  const fetchActivity = useCallback(async () => {
    setALoading(true);
    const r = await fetch(`${base}/activity`);
    if (r.ok) setActivity(await r.json());
    setALoading(false);
  }, [base]);

  const fetchRoomFiles = useCallback(async () => {
    setRoomFilesLoading(true);
    const r = await fetch(`${base}/files`);
    if (r.ok) {
      const d = await r.json();
      setRoomFiles(d.files ?? []);
    }
    setRoomFilesLoading(false);
  }, [base]);

  useEffect(() => { fetchRoom(); }, [fetchRoom]);

  // Activity has its own tab now, so it loads on open rather than behind a Show toggle.
  useEffect(() => {
    if (tab === "activity" && !showActivity) { setShowActivity(true); fetchActivity(); }
  }, [tab, showActivity, fetchActivity]);
  useEffect(() => { if (room) { fetchContent(); fetchViewers(); if (room.portal_drive_folder_id) fetchRoomFiles(); } }, [room, fetchContent, fetchViewers, fetchRoomFiles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ────────────────────────────────────────────────────────────────

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameDraft.trim()) return;
    setNameSaving(true);
    await fetch(`${base}/name`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameDraft.trim() }),
    });
    setEditingName(false);
    setNameSaving(false);
    fetchRoom();
  }

  async function revokeRoom() {
    await fetch(base, { method: "DELETE" });
    setRoom(null);
  }

  async function saveFolder(e: React.FormEvent) {
    e.preventDefault();
    setFolderSaving(true); setFolderError(false);
    const r = await fetch(`${base}/folder`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_url: folderInput.trim() }),
    });
    if (r.ok) { setShowFolderForm(false); setFolderInput(""); fetchRoom(); }
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

  async function togglePw(enabled: boolean) {
    await fetch(`${base}/content`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_password_protected: enabled }),
    });
    fetchContent();
  }

  async function savePw(e: React.FormEvent) {
    e.preventDefault();
    if (!pwInput.trim()) return;
    setPwSaving(true);
    const r = await fetch(`${base}/content`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwInput.trim() }),
    });
    if (r.ok) { setPwInput(""); setShowPwForm(false); setPwSaved(true); setTimeout(() => setPwSaved(false), 2500); fetchContent(); }
    setPwSaving(false);
  }

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    setCSaving(true);
    const r = await fetch(`${base}/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cName.trim(), title: cTitle.trim() || null, email: cEmail.trim() || null, phone: cPhone.trim() || null }),
    });
    if (r.ok) { setCName(""); setCTitle(""); setCEmail(""); setCPhone(""); setShowCForm(false); fetchContent(); }
    setCSaving(false);
  }

  async function saveContact(e: React.FormEvent, id: number) {
    e.preventDefault();
    setEcSaving(true);
    const r = await fetch(`${base}/contacts/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ecName.trim(), title: ecTitle.trim() || null, email: ecEmail.trim() || null, phone: ecPhone.trim() || null }),
    });
    if (r.ok) { setEditCid(null); fetchContent(); }
    setEcSaving(false);
  }

  async function deleteContact(id: number) {
    await fetch(`${base}/contacts/${id}`, { method: "DELETE" });
    fetchContent();
  }

  async function postUpdate(e: React.FormEvent) {
    e.preventDefault();
    setUSaving(true);
    const r = await fetch(`${base}/updates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: uTitle.trim(), body: uBody.trim() || null }),
    });
    if (r.ok) { setUTitle(""); setUBody(""); setShowUForm(false); fetchContent(); }
    setUSaving(false);
  }

  async function deleteUpdate(id: number) {
    await fetch(`${base}/updates/${id}`, { method: "DELETE" });
    fetchContent();
  }

  async function addViewer(e: React.FormEvent) {
    e.preventDefault();
    setVSaving(true);
    const r = await fetch(`${base}/viewers`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: vName.trim(), email: vEmail.trim() || null, firm: vFirm.trim() || null, password: vPw }),
    });
    if (r.ok) { setVName(""); setVEmail(""); setVFirm(""); setVPw(""); setShowVForm(false); fetchViewers(); }
    setVSaving(false);
  }

  async function saveViewer(e: React.FormEvent, vid: string) {
    e.preventDefault();
    setEvSaving(true);
    const body: Record<string, unknown> = { name: evName.trim(), email: evEmail.trim() || null, firm: evFirm.trim() || null };
    if (evPw.trim()) body.password = evPw;
    const r = await fetch(`${base}/viewers/${vid}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) { setEditVid(null); fetchViewers(); }
    setEvSaving(false);
  }

  async function deleteViewer(vid: string) {
    await fetch(`${base}/viewers/${vid}`, { method: "DELETE" });
    fetchViewers();
  }

  async function saveFileDesc(fileId: string) {
    setFileDescSaving(true);
    await fetch(`${base}/files/${encodeURIComponent(fileId)}/description`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: fileDescDraft }),
    });
    setEditingFileId(null);
    setFileDescSaving(false);
    fetchRoomFiles();
  }

  async function saveSlug(e: React.FormEvent) {
    e.preventDefault();
    setSlugError("");
    setSlugSaving(true);
    const r = await fetch(`${base}/slug`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: slugInput.trim() || null }),
    });
    if (r.ok) {
      const d = await r.json();
      setRoom(prev => prev ? { ...prev, slug: d.slug } : prev);
      setShowSlugForm(false); setSlugInput("");
    } else {
      const d = await r.json().catch(() => ({}));
      setSlugError(d.detail ?? "Failed to save slug");
    }
    setSlugSaving(false);
  }

  async function toggleViewer(vid: string, active: boolean) {
    await fetch(`${base}/viewers/${vid}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: active }),
    });
    fetchViewers();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const portalIdentifier = room?.slug ?? room?.token ?? "";
  const portalUrl = room ? buildPortalUrl(portalIdentifier) : "";

  if (roomLoading) return (
    <div className="max-w-2xl">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-8 text-center">
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl space-y-5">

      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link href="/portals" className="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Portals
        </Link>
        <span className="text-gray-200 dark:text-gray-700">/</span>
        {editingName ? (
          <form onSubmit={saveName} className="flex items-center gap-2">
            <input
              type="text"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              autoFocus
              className="text-base font-semibold border-b border-blue-400 bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none"
            />
            <button type="submit" disabled={nameSaving || !nameDraft.trim()}
              className="text-xs text-blue-600 hover:underline">{nameSaving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => { setEditingName(false); setNameDraft(room?.name ?? ""); }}
              className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">{room?.name ?? "Data Room"}</h1>
            <span className="text-[10px] bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border border-purple-100 dark:border-purple-800 px-1.5 py-0.5 rounded font-medium">Data Room</span>
            <button onClick={() => setEditingName(true)} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Rename</button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-gray-200 dark:border-gray-800">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-blue-600 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px] gap-5 items-start">
        <div className="min-w-0 space-y-4">

          {tab === "tiles" && <RoomTilesEditor portalId={portalId} />}

          {tab === "content" && (
            <div className="space-y-4">
          {/* Section 6: Contacts */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Team Contacts</p>
              {!showCForm && <button onClick={() => setShowCForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Add contact</button>}
            </div>
            {contentLoading && !content ? <p className="text-xs text-gray-400">Loading…</p> : (
              <>
                {(content?.contacts ?? []).map(c => (
                  <div key={c.id} className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5">
                    {editCid === c.id ? (
                      <form onSubmit={e => saveContact(e, c.id)} className="space-y-1.5">
                        <input type="text" placeholder="Name *" value={ecName} onChange={e => setEcName(e.target.value)} required className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Title" value={ecTitle} onChange={e => setEcTitle(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="email" placeholder="Email" value={ecEmail} onChange={e => setEcEmail(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Phone" value={ecPhone} onChange={e => setEcPhone(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2">
                          <button type="submit" disabled={ecSaving} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">{ecSaving ? "Saving…" : "Save"}</button>
                          <button type="button" onClick={() => setEditCid(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
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
                          <button onClick={() => { setEditCid(c.id); setEcName(c.name); setEcTitle(c.title ?? ""); setEcEmail(c.email ?? ""); setEcPhone(c.phone ?? ""); }} className="text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Edit</button>
                          <button onClick={() => deleteContact(c.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Delete</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {showCForm && (
                  <form onSubmit={addContact} className="border border-blue-100 dark:border-blue-900/30 rounded-lg px-3 py-2.5 space-y-1.5 bg-blue-50/30 dark:bg-blue-950/10">
                    <input type="text" placeholder="Name *" value={cName} onChange={e => setCName(e.target.value)} required autoFocus className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <input type="text" placeholder="Title" value={cTitle} onChange={e => setCTitle(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <input type="email" placeholder="Email" value={cEmail} onChange={e => setCEmail(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <input type="text" placeholder="Phone" value={cPhone} onChange={e => setCPhone(e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <div className="flex gap-2">
                      <button type="submit" disabled={cSaving || !cName.trim()} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">{cSaving ? "Adding…" : "Add"}</button>
                      <button type="button" onClick={() => { setShowCForm(false); setCName(""); setCTitle(""); setCEmail(""); setCPhone(""); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    </div>
                  </form>
                )}
                {(content?.contacts ?? []).length === 0 && !showCForm && <p className="text-xs text-gray-400 py-1">No contacts added yet.</p>}
              </>
            )}
          </div>
          {/* Section 7: Updates */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Updates</p>
              {!showUForm && <button onClick={() => setShowUForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Post update</button>}
            </div>
            {showUForm && (
              <form onSubmit={postUpdate} className="border border-blue-100 dark:border-blue-900/30 rounded-lg px-3 py-2.5 space-y-1.5 bg-blue-50/30 dark:bg-blue-950/10">
                <input type="text" placeholder="Update title *" value={uTitle} onChange={e => setUTitle(e.target.value)} required autoFocus className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <AutoTextarea placeholder="Details (optional)…" value={uBody} onChange={e => setUBody(e.target.value)} rows={3} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
                <div className="flex gap-2">
                  <button type="submit" disabled={uSaving || !uTitle.trim()} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">{uSaving ? "Posting…" : "Post"}</button>
                  <button type="button" onClick={() => { setShowUForm(false); setUTitle(""); setUBody(""); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                </div>
              </form>
            )}
            {(content?.updates ?? []).length === 0 && !showUForm ? (
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
                      <button onClick={() => deleteUpdate(u.id)} className="text-[11px] text-gray-300 hover:text-red-500 transition-colors shrink-0 mt-0.5">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
            </div>
          )}

          {tab === "documents" && (
            <div className="space-y-4">
          {/* Section 2: Drive folder */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Documents Folder</p>
            {showFolderForm ? (
              <form onSubmit={saveFolder} className="flex gap-2 items-center">
                <input type="text" placeholder="Drive folder URL or ID…" value={folderInput} onChange={e => setFolderInput(e.target.value)} autoFocus
                  className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <button type="submit" disabled={!folderInput.trim() || folderSaving}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                  {folderSaving ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => { setShowFolderForm(false); setFolderInput(""); }}
                  className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Cancel</button>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                  <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {room?.portal_drive_folder_name ?? <span className="text-gray-400 italic">No folder linked</span>}
                  </span>
                </div>
                <button onClick={() => setShowFolderForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0">
                  {room?.portal_drive_folder_id ? "Change" : "Set folder"}
                </button>
              </div>
            )}
            {folderError && <p className="text-[11px] text-red-500 mt-1">{typeof folderError === "string" ? folderError : "Could not link folder. Check the URL and permissions."}</p>}
          </div>
          {/* Section 2b: Document descriptions */}
          {room?.portal_drive_folder_id && (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Document Descriptions</p>
                <button onClick={fetchRoomFiles} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Refresh</button>
              </div>
              <p className="text-xs text-gray-400">Add optional descriptions shown to investors below each file or folder name.</p>
              {roomFilesLoading && roomFiles.length === 0 ? (
                <p className="text-xs text-gray-400">Loading…</p>
              ) : roomFiles.length === 0 ? (
                <p className="text-xs text-gray-400 py-1">No files found in the linked folder.</p>
              ) : (
                <div className="space-y-1">
                  {roomFiles.map(f => {
                    const isFolder = f.mime_type === "application/vnd.google-apps.folder";
                    const typeLabel = isFolder ? "Folder"
                      : f.mime_type === "application/vnd.google-apps.document" ? "Doc"
                      : f.mime_type === "application/vnd.google-apps.spreadsheet" ? "Sheet"
                      : f.mime_type === "application/vnd.google-apps.presentation" ? "Slides"
                      : f.mime_type === "application/pdf" ? "PDF"
                      : f.mime_type?.startsWith("image/") ? "Image"
                      : "File";
                    const isEditing = editingFileId === f.file_id;
                    return (
                      <div key={f.file_id} className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5">
                        <div className="flex items-start gap-2.5">
                          <span className="text-[10px] font-bold uppercase tracking-wide rounded-md px-1.5 py-0.5 shrink-0 mt-0.5"
                            style={{ background: isFolder ? "#F59E0B18" : "#6B728018", color: isFolder ? "#F59E0B" : "#6B7280" }}>
                            {typeLabel}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{f.name}</p>
                            {isEditing ? (
                              <div className="mt-1.5 space-y-1.5">
                                <AutoTextarea
                                  autoFocus
                                  rows={2}
                                  value={fileDescDraft}
                                  onChange={e => setFileDescDraft(e.target.value)}
                                  placeholder="Add a description…"
                                  className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                                />
                                <div className="flex gap-2">
                                  <button onClick={() => saveFileDesc(f.file_id)} disabled={fileDescSaving}
                                    className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">
                                    {fileDescSaving ? "Saving…" : "Save"}
                                  </button>
                                  <button onClick={() => setEditingFileId(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-baseline gap-2 mt-0.5">
                                {f.description
                                  ? <p className="text-xs text-gray-500 dark:text-gray-400 flex-1 leading-snug">{f.description}</p>
                                  : <p className="text-xs text-gray-300 dark:text-gray-600 flex-1 italic">No description</p>
                                }
                                <button
                                  onClick={() => { setEditingFileId(f.file_id); setFileDescDraft(f.description ?? ""); }}
                                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0">
                                  {f.description ? "Edit" : "Add"}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
            </div>
          )}

          {tab === "access" && (
            <div className="space-y-4">
              <RoomAccessList portalId={portalId} />
          {/* Section 1: Link */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                </svg>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Portal Link</span>
              </div>
              {room?.is_active ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => { navigator.clipboard.writeText(portalUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    {copied ? "Copied!" : "Copy link"}
                  </button>
                  <a href={portalPath(portalIdentifier)} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Preview ↗</a>
                  <button onClick={revokeRoom} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Revoke</button>
                </div>
              ) : (
                <span className="text-xs text-red-400 font-medium">Revoked</span>
              )}
            </div>
            {room?.is_active && <p className="text-[11px] text-gray-400 truncate font-mono">{portalUrl}</p>}
            {room?.is_active && (
              showSlugForm ? (
                <form onSubmit={saveSlug} className="flex gap-2 items-center">
                  <span className="text-[11px] text-gray-400 shrink-0 font-mono">/portal/</span>
                  <input
                    type="text"
                    placeholder={room.slug ?? "short-name"}
                    value={slugInput}
                    onChange={e => { setSlugInput(e.target.value); setSlugError(""); }}
                    autoFocus
                    className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  />
                  <button type="submit" disabled={slugSaving}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                    {slugSaving ? "Saving…" : "Save"}
                  </button>
                  {room.slug && (
                    <button type="button" onClick={async () => { setSlugSaving(true); const r = await fetch(`${base}/slug`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: null }) }); if (r.ok) { setRoom(prev => prev ? { ...prev, slug: null } : prev); setShowSlugForm(false); } setSlugSaving(false); }}
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
                    {room.slug
                      ? <><span className="text-gray-300 dark:text-gray-600">Short URL: </span><span className="font-mono">/portal/{room.slug}</span></>
                      : <span className="italic">No short URL set</span>}
                  </span>
                  <button onClick={() => { setSlugInput(room.slug ?? ""); setShowSlugForm(true); }}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0">
                    {room.slug ? "Edit" : "Set short URL"}
                  </button>
                </div>
              )
            )}
          </div>
          {/* Section 4: Password */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4"/>
                </svg>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Password Protection</p>
              </div>
              <button onClick={() => togglePw(!(content?.is_password_protected ?? false))}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${content?.is_password_protected ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"}`}>
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${content?.is_password_protected ? "translate-x-4" : "translate-x-1"}`} />
              </button>
            </div>
            {content?.is_password_protected && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 dark:text-gray-400">Investors must authenticate before accessing documents. Add individual investor logins below for per-person tracking.</p>
                <div className="flex items-center justify-between gap-2 py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 dark:text-gray-300">Shared password</span>
                    {content?.has_portal_password && !showPwForm && (
                      <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded font-medium">Set</span>
                    )}
                    {pwSaved && <span className="text-[10px] text-green-600">Saved!</span>}
                  </div>
                  {!showPwForm && (
                    <button onClick={() => setShowPwForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      {content?.has_portal_password ? "Change" : "Set password"}
                    </button>
                  )}
                </div>
                {showPwForm && (
                  <form onSubmit={savePw} className="flex gap-2 items-center">
                    <input type="password" placeholder="New shared password…" value={pwInput} onChange={e => setPwInput(e.target.value)} autoFocus
                      className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <button type="submit" disabled={!pwInput.trim() || pwSaving}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0">
                      {pwSaving ? "Saving…" : "Save"}
                    </button>
                    <button type="button" onClick={() => { setShowPwForm(false); setPwInput(""); }} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Cancel</button>
                  </form>
                )}
              </div>
            )}
          </div>
          {/* Section 5: Investors */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Investors{viewers.length > 0 && <span className="ml-1.5 text-gray-400 normal-case font-normal">({viewers.length})</span>}
                </p>
              </div>
              {!showVForm && <button onClick={() => setShowVForm(true)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">+ Add investor</button>}
            </div>
            <p className="text-xs text-gray-400">Each investor gets a named login with their own password. Activity is tracked per investor.</p>

            {vLoading && viewers.length === 0 ? <p className="text-xs text-gray-400">Loading…</p> : (
              <>
                {viewers.map(v => (
                  <div key={v.viewer_id} className="border border-gray-100 dark:border-gray-800 rounded-lg px-3 py-2.5">
                    {editVid === v.viewer_id ? (
                      <form onSubmit={e => saveViewer(e, v.viewer_id)} className="space-y-1.5">
                        <input type="text" placeholder="Name *" value={evName} onChange={e => setEvName(e.target.value)} required
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="email" placeholder="Email" value={evEmail} onChange={e => setEvEmail(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="text" placeholder="Firm" value={evFirm} onChange={e => setEvFirm(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <input type="password" placeholder="New password (leave blank to keep)" value={evPw} onChange={e => setEvPw(e.target.value)}
                          className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        <div className="flex gap-2">
                          <button type="submit" disabled={evSaving} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">{evSaving ? "Saving…" : "Save"}</button>
                          <button type="button" onClick={() => setEditVid(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{v.name}</p>
                            {!v.is_active && <span className="text-[10px] text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">Disabled</span>}
                          </div>
                          <p className="text-[11px] text-gray-400">{[v.firm, v.email].filter(Boolean).join(" · ") || "No email or firm"}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => toggleViewer(v.viewer_id, !v.is_active)} className="text-[11px] text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">{v.is_active ? "Disable" : "Enable"}</button>
                          <button onClick={() => { setEditVid(v.viewer_id); setEvName(v.name); setEvEmail(v.email ?? ""); setEvFirm(v.firm ?? ""); setEvPw(""); }} className="text-xs text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Edit</button>
                          <button onClick={() => deleteViewer(v.viewer_id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors">Delete</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {showVForm && (
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
                      <button type="submit" disabled={vSaving || !vName.trim() || !vPw.trim()} className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium">{vSaving ? "Adding…" : "Add investor"}</button>
                      <button type="button" onClick={() => { setShowVForm(false); setVName(""); setVEmail(""); setVFirm(""); setVPw(""); }} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                    </div>
                  </form>
                )}
                {viewers.length === 0 && !showVForm && <p className="text-xs text-gray-400 py-1">No investors added yet.</p>}
              </>
            )}
          </div>
          {/* Section 8: Messaging toggle */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Portal Messaging</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Allow portal viewers to send messages to your team</p>
              </div>
              <button
                onClick={async () => {
                  if (!room) return;
                  const next = !room.messaging_enabled;
                  await fetch(`${base}/messaging`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ messaging_enabled: next }),
                  });
                  fetchRoom();
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${room?.messaging_enabled ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${room?.messaging_enabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
              </button>
            </div>
            {room?.messaging_enabled && (
              <div className="mt-2 p-2 rounded-lg bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900">
                <p className="text-[11px] text-blue-600 dark:text-blue-400">
                  ✓ Messaging enabled — messages appear in your team Messages panel
                </p>
              </div>
            )}
          </div>
            </div>
          )}

          {tab === "activity" && (
            <div className="space-y-4">
          {/* Section 9: Activity */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                </svg>
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Activity Log</p>
              </div>
              <button onClick={() => { if (!showActivity) { setShowActivity(true); fetchActivity(); } else setShowActivity(false); }}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                {showActivity ? "Hide" : "Show"}
              </button>
            </div>
            {showActivity && (
              <>
                {aLoading ? <p className="text-xs text-gray-400">Loading…</p> : activity.length === 0 ? (
                  <p className="text-xs text-gray-400 py-1">No activity recorded yet.</p>
                ) : (
                  <div className="divide-y divide-gray-50 dark:divide-gray-800 max-h-96 overflow-y-auto -mx-1 px-1">
                    {activity.map(e => (
                      <div key={e.log_id} className="flex items-start gap-3 py-2">
                        <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${e.event_type === "login" ? "bg-green-500" : e.event_type === "file_download" ? "bg-orange-400" : e.event_type === "file_view" ? "bg-blue-400" : "bg-gray-300"}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-xs font-medium text-gray-800 dark:text-gray-200">{e.viewer_name ?? "Anonymous"}</span>
                            <span className="text-[11px] text-gray-400">
                              {e.event_type === "login" ? "signed in" : e.event_type === "file_view" ? `viewed ${e.file_name ?? "a file"}` : e.event_type === "file_download" ? `downloaded ${e.file_name ?? "a file"}` : `visited ${e.section ?? "portal"}`}
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
                <button onClick={fetchActivity} className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">Refresh</button>
              </>
            )}
          </div>
            </div>
          )}

        </div>

        {/* Summary rail — what you check before sending the link */}
        <aside className="space-y-3 lg:sticky lg:top-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${room?.is_active ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {room?.is_active ? "Active" : "Revoked"}
              </span>
            </div>

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Link</p>
              <p className="text-[11px] font-mono text-gray-500 dark:text-gray-400 break-all">
                {room?.is_active ? portalUrl : "\u2014"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Investors</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                  {viewers.filter(v => v.is_active).length}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Access</p>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mt-1">
                  {content?.is_password_protected
                    ? (content?.has_portal_password || viewers.some(v => v.is_active) ? "Locked" : "No password")
                    : "Open"}
                </p>
              </div>
            </div>

            {content?.is_password_protected && !content?.has_portal_password && !viewers.some(v => v.is_active) && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed border-t border-gray-100 dark:border-gray-800 pt-2.5">
                Nobody can get in yet. Add an investor with a password, or set a room password, under Access.
              </p>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Documents folder</p>
            <p className="text-sm text-gray-700 dark:text-gray-300 break-words">
              {room?.portal_drive_folder_name ?? <span className="text-gray-300 dark:text-gray-600">Not linked</span>}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
