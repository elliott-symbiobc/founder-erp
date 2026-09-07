"use client";

/**
 * Investor data room, at example.com/investors
 *
 * Gated end to end: nothing renders until the viewer authenticates against the
 * portal with slug "investors". Reuses the existing portal auth stack, so each
 * investor can have their own password and every visit lands in portal_access_log.
 *
 * Content is curated, not derived: every tile comes from portal_room_blocks.
 * Sections with no blocks render an empty state rather than inventing numbers.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────

/** The room is bound to a fixed portal slug so the URL can stay /investors. */
const ROOM_SLUG = "investors";

const SESSION_KEY = `portal_session_${ROOM_SLUG}`;

/** Whether this viewer has acknowledged confidentiality in this session. */
const ACK_KEY = `portal_confidentiality_ack_${ROOM_SLUG}`;

type SectionId =
  | "overview" | "traction" | "science" | "team" | "raise" | "finance" | "governance" | "documents";

const SECTION_ORDER: SectionId[] =
  ["overview", "traction", "science", "team", "raise", "finance", "governance", "documents"];

const SECTION_DEFAULTS: Record<SectionId, { title: string; subtitle: string }> = {
  overview:  { title: "Overview",        subtitle: "The opportunity at a glance" },
  traction:  { title: "Traction",        subtitle: "Commercial engagements and proof points" },
  science:   { title: "Science",         subtitle: "The platform and what makes it defensible" },
  team:      { title: "Team",            subtitle: "Founders, operators and advisors" },
  raise:     { title: "The Raise",       subtitle: "SPV structure, terms and use of funds" },
  finance:   { title: "Finance",         subtitle: "Financial position, projections and unit economics" },
  governance:{ title: "Governance",      subtitle: "Board, cap table and how the SPV is governed" },
  documents: { title: "Documents",       subtitle: "Diligence materials" },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoomSection {
  section: SectionId;
  title: string | null;
  subtitle: string | null;
  position: number;
  is_visible: boolean;
}

type BlockType = "stat" | "text" | "logo" | "person" | "list" | "chart" | "image" | "quote" | "docs";

interface RoomBlock {
  block_id: string;
  section: SectionId;
  block_type: BlockType;
  position: number;
  is_visible: boolean;
  span: number;
  payload: Record<string, unknown>;
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
  label: string | null;
  description: string | null;
  files: PortalFile[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

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

const FILE_KIND: Record<string, string> = {
  "application/vnd.google-apps.document":     "Doc",
  "application/vnd.google-apps.spreadsheet":  "Sheet",
  "application/vnd.google-apps.presentation": "Slides",
  "application/vnd.google-apps.folder":       "Folder",
  "application/pdf":                          "PDF",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InvestorRoomPage() {
  const [portal, setPortal]     = useState<PortalData | null>(null);
  const [sections, setSections] = useState<RoomSection[]>([]);
  // Sections turned off in the platform. They are absent from `sections`, which
  // on its own is indistinguishable from a section that was never configured.
  const [hiddenSections, setHiddenSections] = useState<string[]>([]);
  const [blocks, setBlocks]     = useState<RoomBlock[]>([]);
  const [loading, setLoading]   = useState(true);
  const [locked, setLocked]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [viewerName, setViewerName] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  // Sections open by default — collapsing is for readers who want to skim the
  // room rather than a saved preference, so it is not persisted.
  //
  // Documents is the exception. It sits last and lists the Drive folder in
  // full, so left open it buries the curated sections under a long file dump
  // and makes the room look like a folder. Collapsed, it reads as the reference
  // shelf it is; the nav rail expands it on the way in for anyone who wants it.
  const [collapsed, setCollapsed] = useState<SectionId[]>(["documents"]);
  // The rail is permanent from lg up. Narrower than that there is no room for a
  // fixed column beside the content, so the same rail becomes a drawer.
  const [menuOpen, setMenuOpen] = useState(false);

  // Investors should be able to read a document without downloading it. The
  // file is fetched through the portal's own proxy, so a preview is still
  // gated and still logged. It never becomes a Drive link.
  const [viewing, setViewing] = useState<{ file: PortalFile; url: string } | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  // Downloads take a copy of confidential material out of the room, so the
  // reminder gates the download rather than the page.
  const [pendingDownload, setPendingDownload] = useState<PortalFile | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const trackedOnce = useRef(false);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});

  const sessionHeaders = useCallback((override?: string): Record<string, string> => {
    let tok = override ?? null;
    if (!tok) {
      try { tok = sessionStorage.getItem(SESSION_KEY); } catch { tok = null; }
    }
    return tok ? { "X-Portal-Session": tok } : {};
  }, []);

  const track = useCallback((section: string) => {
    fetch(`/api/proxy/portal/${ROOM_SLUG}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({ event_type: "page_visit", section }),
    }).catch(() => {});
  }, [sessionHeaders]);

  const load = useCallback(async (session?: string) => {
    setLoading(true);
    setError(null);
    // A stalled request must surface as an error, not an endless spinner:
    // the loading state is byte-identical to the server-rendered shell, so a
    // hang here is indistinguishable from the page never booting at all.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    try {
      const headers = { "Content-Type": "application/json", ...sessionHeaders(session) };

      const r = await fetch(`/api/proxy/portal/${ROOM_SLUG}`, { headers, signal: abort.signal });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.detail ?? "This data room is unavailable.");
      }
      const data = await r.json();
      if (data.password_required) { setLocked(true); setLoading(false); return; }

      setPortal(data as PortalData);
      setLocked(false);

      const rr = await fetch(`/api/proxy/portal/${ROOM_SLUG}/room`, { headers, signal: abort.signal });
      if (rr.ok) {
        const room = await rr.json();
        setSections(room.sections ?? []);
        setHiddenSections(room.hidden_sections ?? []);
        setBlocks(room.blocks ?? []);
      }

      if (!trackedOnce.current) {
        trackedOnce.current = true;
        setTimeout(() => track("overview"), 400);
      }
    } catch (e: unknown) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setError(aborted
        ? "The data room took too long to respond. Reload to try again."
        : e instanceof Error ? e.message : "Unknown error");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, [sessionHeaders, track]);

  useEffect(() => {
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(SESSION_KEY); } catch { /* blocked site data */ }
    load(stored ?? undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackFile = useCallback((
    event: "file_view" | "file_download",
    file: { file_id: string; name: string },
  ) => {
    fetch(`/api/proxy/portal/${ROOM_SLUG}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({
        event_type: event, file_id: file.file_id, file_name: file.name, section: "documents",
      }),
    }).catch(() => {});
  }, [sessionHeaders]);

  /** Actually save the file, once confidentiality has been acknowledged.
   *
   * The room is session-gated, and a link click cannot carry the session
   * header. A plain navigation to the download URL is unauthenticated and
   * comes back 401. So fetch it with the session and save the result.
   */
  const startDownload = useCallback(async (file: PortalFile) => {
    setDownloading(file.file_id);
    setDownloadError(null);
    try {
      const r = await fetch(
        `/api/proxy/portal/${ROOM_SLUG}/files/${file.file_id}/download`,
        { headers: sessionHeaders() }
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
      // Released after the browser has had time to start writing the file.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      // Logged on success, so the access log records files that actually left.
      trackFile("file_download", file);
    } catch {
      setDownloadError(`Could not download ${file.name}. Please try again.`);
    } finally {
      setDownloading(null);
    }
  }, [sessionHeaders, trackFile]);

  /** Ask first, unless this viewer already agreed in this session. */
  const requestDownload = useCallback((file: PortalFile) => {
    let acked = false;
    try { acked = sessionStorage.getItem(ACK_KEY) === "1"; } catch { /* blocked site data */ }
    if (acked) { startDownload(file); return; }
    setPendingDownload(file);
  }, [startDownload]);

  const confirmDownload = useCallback(() => {
    const file = pendingDownload;
    if (!file) return;
    try { sessionStorage.setItem(ACK_KEY, "1"); } catch { /* blocked site data */ }
    // Record the acknowledgement itself, so the log shows they were told and
    // agreed, not merely that a file left the room.
    fetch(`/api/proxy/portal/${ROOM_SLUG}/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({
        event_type: "confidentiality_ack",
        file_id: file.file_id, file_name: file.name, section: "documents",
      }),
    }).catch(() => {});
    setPendingDownload(null);
    startDownload(file);
  }, [pendingDownload, sessionHeaders, startDownload]);

  const openViewer = useCallback(async (file: PortalFile) => {
    setViewerBusy(true);
    setViewerError(null);
    trackFile("file_view", file);
    try {
      const r = await fetch(
        `/api/proxy/portal/${ROOM_SLUG}/files/${file.file_id}/download`,
        { headers: sessionHeaders() }
      );
      if (!r.ok) throw new Error("Could not open this document");
      const blob = await r.blob();
      setViewing({ file, url: URL.createObjectURL(blob) });
    } catch {
      setViewerError("Could not open this document. Try downloading it instead.");
    } finally {
      setViewerBusy(false);
    }
  }, [sessionHeaders, trackFile]);

  const closeViewer = useCallback(() => {
    setViewing(prev => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setViewerError(null);
  }, []);

  // Object URLs hold the file in memory until released.
  useEffect(() => () => { if (viewing) URL.revokeObjectURL(viewing.url); }, [viewing]);

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeViewer(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing, closeViewer]);

  const onAuthed = useCallback((tok: string, name: string | null) => {
    try { sessionStorage.setItem(SESSION_KEY, tok); } catch { /* blocked site data */ }
    setViewerName(name);
    load(tok);
  }, [load]);

  // Highlight the nav entry for whichever section is currently in view.
  useEffect(() => {
    if (!portal) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target instanceof HTMLElement && visible.target.dataset.section) {
          setActiveSection(visible.target.dataset.section as SectionId);
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: [0.1, 0.5, 1] }
    );
    Object.values(sectionRefs.current).forEach(el => el && observer.observe(el));
    return () => observer.disconnect();
  }, [portal, blocks]);

  /** Section metadata merged with defaults, in display order. */
  const orderedSections = useMemo(() => {
    const byId = new Map(sections.map(s => [s.section, s]));
    const description = portal?.description?.trim() || null;
    return SECTION_ORDER
      .map(id => {
        const saved = byId.get(id);
        // Overview leads with the room's description when there is one; an
        // explicitly set section subtitle still wins over it.
        const fallback = id === "overview" && description
          ? description
          : SECTION_DEFAULTS[id].subtitle;
        return {
          id,
          title:    saved?.title    ?? SECTION_DEFAULTS[id].title,
          subtitle: saved?.subtitle ?? fallback,
          position: saved?.position ?? SECTION_ORDER.indexOf(id),
          hidden:   saved ? !saved.is_visible : hiddenSections.includes(id),
        };
      })
      .filter(s => !s.hidden)
      .sort((a, b) => a.position - b.position);
  }, [sections, hiddenSections, portal]);

  const blocksBySection = useMemo(() => {
    const m = new Map<SectionId, RoomBlock[]>();
    blocks.forEach(b => {
      const list = m.get(b.section) ?? [];
      list.push(b);
      m.set(b.section, list);
    });
    m.forEach(list => list.sort((a, b) => a.position - b.position));
    return m;
  }, [blocks]);

  const toggleSection = (id: SectionId) =>
    setCollapsed(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));

  const scrollTo = (id: SectionId) => {
    // Jumping from the rail should always land on something readable, so a
    // collapsed target opens on the way.
    setCollapsed(c => c.filter(x => x !== id));
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
    track(id);
  };

  // ── Render guards ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <p className="text-lg text-gray-500">Loading…</p>
        </div>
      </Shell>
    );
  }

  if (locked) return <Gate onSuccess={onAuthed} />;

  if (error) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <p className="text-lg text-red-600 max-w-sm text-center">{error}</p>
        </div>
      </Shell>
    );
  }

  if (!portal) return null;

  const documents = portal.files ?? [];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans lg:flex">

      {/* Drawer handle, below lg only. */}
      <button
        onClick={() => setMenuOpen(true)}
        aria-label="Open sections"
        className="lg:hidden fixed top-4 left-4 z-50 rounded-lg border border-gray-200 bg-white/90 backdrop-blur p-2.5 text-gray-600 shadow-sm"
      >
        <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor"
             strokeWidth={2} strokeLinecap="round">
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </button>

      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-gray-900/40 backdrop-blur-sm"
             onClick={() => setMenuOpen(false)} />
      )}

      {/* ── Side rail ────────────────────────────────────────────────────────── */}
      <aside
        className={`fixed lg:sticky lg:self-start top-0 z-40 h-screen w-64 shrink-0 flex flex-col
                    border-r border-gray-200 bg-white transition-transform
                    ${menuOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      >
        <div className="px-5 pt-6 pb-5">
          {/* Sized to the rail's width rather than a fixed height. The mark is
              a 2:1 wordmark, so a height that suited a top bar left most of the
              rail empty beside it. */}
          <img src="/api/logo" alt="Open ERP" className="w-full h-auto"
               onError={e => { const i = e.currentTarget; if (!i.src.includes("logo.svg")) i.src = "/logo.svg"; }} />
          <p className="mt-4 text-base font-medium text-gray-900 leading-snug">
            {portal.project_name}
          </p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-0.5">
          {orderedSections.map(s => {
            const active = activeSection === s.id;
            return (
              <button
                key={s.id}
                onClick={() => { scrollTo(s.id); setMenuOpen(false); }}
                aria-current={active ? "true" : undefined}
                className={`w-full text-left px-3 py-2 rounded-lg text-base font-medium border-l-2 transition-colors ${
                  active
                    ? "border-red-500 bg-red-50/60 text-gray-900"
                    : "border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                {s.title}
              </button>
            );
          })}
        </nav>

        {/* Sits after the nav so it reads directly under Documents, and stays
            put while the section list above it scrolls. */}
        <div className="px-5 py-4 border-t border-gray-100 shrink-0">
          <p className="text-base font-semibold text-gray-900">Elliott Notrica</p>
          <p className="text-sm text-gray-500">Founder/CEO</p>
          <div className="mt-2 space-y-1">
            <a href="mailto:elliott@example.com"
               className="block text-sm text-gray-500 hover:text-gray-900 transition-colors break-all">
              elliott@example.com
            </a>
            <a href="tel:+18777122640"
               className="block text-sm text-gray-500 hover:text-gray-900 transition-colors">
              O: 877.712.2640
            </a>
            <a href="tel:+13144202976"
               className="block text-sm text-gray-500 hover:text-gray-900 transition-colors">
              C: 314.420.2976
            </a>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-100 space-y-1.5 shrink-0">
          {viewerName && <p className="text-base text-gray-500 truncate">{viewerName}</p>}
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Confidential
          </p>
        </div>
      </aside>

      {/* ── Content column ───────────────────────────────────────────────────── */}
      {/* The footer belongs in here with the sections. Left as a sibling of the
          rail it becomes a third column in the row and squeezes the content. */}
      <div className="flex-1 min-w-0 flex flex-col">

      {/* ── Sections ─────────────────────────────────────────────────────────── */}
      {/* No width cap: the rail already takes its column, so capping the rest
          and centring it left a broad empty margin down both sides and squeezed
          the tile grid. The content fills the column and the 12-column grid
          keeps individual tiles to a readable width. */}
      <main className="w-full px-6 lg:px-8 py-10 pt-20 lg:pt-10 space-y-14">
        {orderedSections.map(s => {
          const isOpen = !collapsed.includes(s.id);
          return (
            <section
              key={s.id}
              data-section={s.id}
              ref={el => { sectionRefs.current[s.id] = el; }}
              className="scroll-mt-20 lg:scroll-mt-8"
            >
              <button
                onClick={() => toggleSection(s.id)}
                aria-expanded={isOpen}
                aria-controls={`section-body-${s.id}`}
                className="group w-full text-left mb-5 flex items-start gap-3"
              >
                <span className="mt-2 shrink-0 text-gray-400 group-hover:text-gray-700 transition-colors">
                  <svg viewBox="0 0 16 16" className={`w-4 h-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                       fill="none" stroke="currentColor" strokeWidth={2}
                       strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                </span>
                <span className="min-w-0">
                  <h2 className="text-3xl font-semibold tracking-tight text-gray-900">{s.title}</h2>
                  {s.subtitle && (
                    <p className="text-lg text-gray-600 mt-2 max-w-3xl leading-relaxed whitespace-pre-wrap">
                      {s.subtitle}
                    </p>
                  )}
                </span>
              </button>

              {isOpen && (
                <div id={`section-body-${s.id}`}>
                  {s.id === "documents" ? (
                    <DocumentGrid
                      files={documents}
                      onOpen={openViewer}
                      onDownload={requestDownload}
                    />
                  ) : (
                    <TileGrid
                      blocks={blocksBySection.get(s.id) ?? []}
                      sectionTitle={s.title}
                      hideEmptyState={s.id === "overview" && !!portal.description?.trim()}
                      onOpen={openViewer}
                      onDownload={requestDownload}
                    />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </main>

      {(downloading || downloadError) && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-lg">
          {downloadError ? (
            <div className="flex items-center gap-3">
              <span className="text-base text-red-600">{downloadError}</span>
              <button onClick={() => setDownloadError(null)} className="text-base text-gray-500 hover:text-gray-900">
                Dismiss
              </button>
            </div>
          ) : (
            <span className="text-base text-gray-600">Preparing your download…</span>
          )}
        </div>
      )}

      {pendingDownload && (
        <div className="fixed inset-0 z-[60] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center px-6">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-7 shadow-xl">
            <div className="w-11 h-11 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center mb-5 text-gray-500">
              <LockIcon size={18} />
            </div>
            <h2 className="text-2xl font-semibold mb-2">Confidential material</h2>
            <p className="text-lg text-gray-600 leading-relaxed">
              Everything in this data room is confidential and provided solely for your
              evaluation. Please do not forward, publish or share these documents, or
              their contents, with anyone outside your firm without our written consent.
            </p>
            <p className="text-base text-gray-400 leading-relaxed mt-3">
              You&apos;re about to download{" "}
              <span className="text-gray-600">{pendingDownload.name}</span>. Downloads are
              recorded against your account.
            </p>
            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => setPendingDownload(null)}
                className="text-base px-3 py-2 rounded-lg text-gray-500 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDownload}
                className="text-base px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors"
              >
                I agree, download
              </button>
            </div>
          </div>
        </div>
      )}

      {(viewing || viewerBusy || viewerError) && (
        <DocViewer
          file={viewing?.file ?? null}
          url={viewing?.url ?? null}
          busy={viewerBusy}
          error={viewerError}
          onClose={closeViewer}
          onDownload={requestDownload}
        />
      )}

      <footer className="border-t border-gray-200 mt-auto">
        <div className="w-full px-6 lg:px-8 py-6 flex items-center justify-between gap-4 text-xs text-gray-400">
          <span>Open ERP Bioculinary · Confidential, not for distribution</span>
          <span className="shrink-0">{new Date().getFullYear()}</span>
        </div>
      </footer>

      </div>
    </div>
  );
}

// ── Tile grid ─────────────────────────────────────────────────────────────────

/**
 * Tile widths, over a twelve-column grid.
 *
 * The grid had four columns, so the default width of 1 made every tile a
 * quarter, around 300px, which was tight before the type got bigger and
 * cramped afterwards. Twelve columns keep the same four steps but start them
 * wider: a third, a half, two thirds, full. Stored spans are unchanged.
 */
const SPAN_CLASS: Record<number, string> = {
  1: "md:col-span-4",
  2: "md:col-span-6",
  3: "md:col-span-8",
  4: "md:col-span-12",
};

function TileGrid({
  blocks,
  sectionTitle,
  hideEmptyState,
  onOpen,
  onDownload,
}: {
  blocks: RoomBlock[];
  sectionTitle: string;
  hideEmptyState?: boolean;
  onOpen: (f: PortalFile) => void;
  onDownload: (f: PortalFile) => void;
}) {
  if (blocks.length === 0) {
    if (hideEmptyState) return null;
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
        <p className="text-lg text-gray-400">No content in {sectionTitle} yet.</p>
        <p className="text-base text-gray-300 mt-1.5">
          Tiles added to this section from the platform will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
      {blocks.map(b => (
        <div key={b.block_id} className={SPAN_CLASS[b.span] ?? SPAN_CLASS[1]}>
          <Tile block={b} onOpen={onOpen} onDownload={onDownload} />
        </div>
      ))}
    </div>
  );
}

/** Frame shared by every tile so the grid reads as one system. */
function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`h-full rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition-colors hover:border-gray-300 ${className}`}>
      {children}
    </div>
  );
}

function Tile({ block, onOpen, onDownload }: {
  block: RoomBlock;
  onOpen: (f: PortalFile) => void;
  onDownload: (f: PortalFile) => void;
}) {
  const p = block.payload ?? {};

  switch (block.block_type) {
    case "stat": {
      const value = str(p.value);
      return (
        <Frame>
          {str(p.label) && (
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-gray-400">{str(p.label)}</p>
          )}
          <p className="mt-3 text-5xl font-semibold tracking-tight text-gray-900 tabular-nums">
            {value ?? "-"}
            {str(p.unit) && <span className="text-xl text-gray-500 ml-1">{str(p.unit)}</span>}
          </p>
          {str(p.caption) && <p className="mt-2 text-base text-gray-500 leading-relaxed">{str(p.caption)}</p>}
        </Frame>
      );
    }

    case "text":
      return (
        <Frame>
          {str(p.heading) && <h3 className="text-xl font-semibold text-gray-900 mb-2">{str(p.heading)}</h3>}
          {str(p.body) && (
            <p className="text-lg text-gray-600 leading-relaxed whitespace-pre-wrap">{str(p.body)}</p>
          )}
        </Frame>
      );

    case "logo":
      return (
        <Frame className="flex flex-col justify-between">
          <div className="h-10 flex items-center">
            {str(p.image_url)
              ? <img src={str(p.image_url)!} alt={str(p.name) ?? ""} className="max-h-10 max-w-full object-contain opacity-80" />
              : <span className="text-lg font-semibold text-gray-800">{str(p.name) ?? "-"}</span>}
          </div>
          {str(p.detail) && <p className="mt-4 text-base text-gray-500 leading-relaxed">{str(p.detail)}</p>}
        </Frame>
      );

    case "person":
      return (
        <Frame>
          <div className="flex items-center gap-3">
            {str(p.image_url) ? (
              <img src={str(p.image_url)!} alt={str(p.name) ?? ""} className="w-11 h-11 rounded-full object-cover" />
            ) : (
              <div className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center text-lg font-semibold text-gray-600">
                {(str(p.name) ?? "?").split(" ").map(w => w[0]).slice(0, 2).join("")}
              </div>
            )}
            <div className="min-w-0">
              <p className="text-xl font-semibold text-gray-900 break-words">{str(p.name) ?? "-"}</p>
              {str(p.title) && (
                <p className="text-base text-gray-500 break-words leading-snug">{str(p.title)}</p>
              )}
            </div>
          </div>
          {str(p.bio) && <p className="mt-3 text-base text-gray-500 leading-relaxed">{str(p.bio)}</p>}
        </Frame>
      );

    case "list": {
      const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
      return (
        <Frame>
          {str(p.heading) && <h3 className="text-xl font-semibold text-gray-900 mb-3">{str(p.heading)}</h3>}
          <ul className="divide-y divide-gray-100">
            {items.map((it, i) => (
              <li key={i} className="py-2 flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  <span className="text-lg text-gray-700">{str(it.label) ?? "-"}</span>
                  {str(it.detail) && <span className="block text-base text-gray-400 mt-0.5">{str(it.detail)}</span>}
                </div>
                {str(it.value) && (
                  <span className="text-lg font-medium text-gray-900 tabular-nums shrink-0">{str(it.value)}</span>
                )}
              </li>
            ))}
          </ul>
        </Frame>
      );
    }

    case "chart": {
      const series = Array.isArray(p.series) ? (p.series as Record<string, unknown>[]) : [];
      const values = series.map(s => Number(s.value) || 0);
      const max = Math.max(...values, 1);
      return (
        <Frame>
          {str(p.heading) && <h3 className="text-xl font-semibold text-gray-900 mb-4">{str(p.heading)}</h3>}
          <div className="space-y-2.5">
            {series.map((s, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between text-base mb-1">
                  <span className="text-gray-600">{str(s.label) ?? "-"}</span>
                  <span className="text-gray-800 tabular-nums">
                    {String(s.value ?? "")}{str(p.unit) ?? ""}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-red-500"
                    style={{ width: `${((Number(s.value) || 0) / max) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Frame>
      );
    }

    // contain, not cover: these are diagrams, and sizing the image to its grid
    // row by cropping cut the edges off the pipeline figure.
    case "image":
      return (
        <Frame className="p-0 overflow-hidden">
          {str(p.image_url) && (
            <img src={str(p.image_url)!} alt={str(p.alt) ?? ""}
                 className="w-full h-auto max-h-[70vh] object-contain" />
          )}
          {str(p.caption) && <p className="px-5 py-3 text-base text-gray-500">{str(p.caption)}</p>}
        </Frame>
      );

    case "docs": {
      const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
      const openDoc = onOpen;
      return (
        <Frame>
          {str(p.heading) && <h3 className="text-xl font-semibold text-gray-900 mb-1">{str(p.heading)}</h3>}
          {str(p.caption) && <p className="text-base text-gray-500 mb-3 leading-relaxed">{str(p.caption)}</p>}
          <ul className="divide-y divide-gray-100">
            {items.map((it, i) => {
              const id   = str(it.file_id);
              const name = str(it.name) ?? "Document";
              if (!id) return null;
              const mime = str(it.mime_type);
              const description = str(it.description);
              return (
                <li key={i} className="group flex items-start gap-2.5 py-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 shrink-0 w-14 text-center mt-0.5">
                    {FILE_KIND[mime ?? ""] ?? "File"}
                  </span>
                  <button
                    onClick={() => openDoc({ file_id: id, name, mime_type: mime,
                                             modified_time: null, size_bytes: null })}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="block text-lg text-gray-700 group-hover:text-gray-900 break-words">
                      {name}
                    </span>
                    {description && (
                      <span className="block text-base text-gray-500 break-words leading-snug">
                        {description}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => onDownload({ file_id: id, name, mime_type: mime,
                                                modified_time: null, size_bytes: null })}
                    title="Download"
                    className="text-gray-400 hover:text-gray-700 shrink-0 transition-colors"
                  >
                    <DownloadIcon />
                  </button>
                </li>
              );
            })}
          </ul>
          {items.length === 0 && <p className="text-base text-gray-400 py-2">No documents attached.</p>}
        </Frame>
      );
    }

    case "quote":
      return (
        <Frame>
          <p className="text-lg text-gray-800 leading-relaxed italic">
            {str(p.body) ? `“${str(p.body)}”` : "-"}
          </p>
          {str(p.attribution) && (
            <p className="mt-3 text-base text-gray-500">
              {str(p.attribution)}{str(p.role) ? ` · ${str(p.role)}` : ""}
            </p>
          )}
        </Frame>
      );

    default:
      return null;
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────

function DocumentGrid({
  files,
  onOpen,
  onDownload,
}: {
  files: PortalFile[];
  onOpen: (f: PortalFile) => void;
  onDownload: (f: PortalFile) => void;
}) {
  if (files.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
        <p className="text-lg text-gray-400">No documents linked yet.</p>
        <p className="text-base text-gray-300 mt-1.5">
          Connect a Drive folder to this room from the platform to populate this section.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
      {files.map(f => (
        <div key={f.file_id} className="group flex items-start gap-3 px-5 py-3">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 shrink-0 w-14 text-center mt-0.5">
            {FILE_KIND[f.mime_type ?? ""] ?? "File"}
          </span>

          <button onClick={() => onOpen(f)} className="flex-1 min-w-0 text-left">
            <span className="block text-lg text-gray-900 group-hover:text-gray-900 break-words">
              {f.name}
            </span>
            {f.description && (
              <span className="block text-base text-gray-500 break-words leading-snug">
                {f.description}
              </span>
            )}
          </button>

          <span className="text-xs text-gray-400 whitespace-nowrap shrink-0 hidden sm:block mt-1">
            {fmtDate(f.modified_time)}{f.size_bytes ? ` · ${fmtSize(f.size_bytes)}` : ""}
          </span>

          <button
            onClick={() => onDownload(f)}
            title="Download"
            className="text-gray-400 hover:text-gray-700 transition-colors shrink-0"
          >
            <DownloadIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Document viewer ───────────────────────────────────────────────────────────

/**
 * Read a document in place.
 *
 * The file is already in memory as a blob fetched through the portal's proxy,
 * so the preview needs no Drive link and no second request, and the view is
 * logged the same way a download is.
 */
function DocViewer({
  file,
  url,
  busy,
  error,
  onClose,
  onDownload,
}: {
  file: PortalFile | null;
  url: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDownload: (f: PortalFile) => void;
}) {
  const isImage = (file?.mime_type ?? "").startsWith("image/");

  return (
    <div
      className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-sm flex flex-col"
      onClick={onClose}
    >
      <div
        className="flex items-center gap-4 px-6 py-3 shrink-0 bg-white border-b border-gray-200"
        onClick={e => e.stopPropagation()}
      >
        <span className="text-lg text-gray-900 flex-1 min-w-0 break-words">
          {file?.name ?? "Document"}
        </span>
        {file && (
          <button
            onClick={() => onDownload(file)}
            className="text-base text-gray-500 hover:text-gray-900 transition-colors shrink-0"
          >
            Download
          </button>
        )}
        <button
          onClick={onClose}
          className="text-base text-gray-500 hover:text-gray-900 transition-colors shrink-0"
        >
          Close ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 p-4" onClick={e => e.stopPropagation()}>
        {busy ? (
          <div className="h-full flex items-center justify-center">
            <p className="rounded-lg bg-white px-4 py-2.5 text-lg text-gray-500 shadow">Opening…</p>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center">
            <p className="rounded-lg bg-white px-4 py-2.5 text-lg text-red-600 max-w-sm text-center shadow">
              {error}
            </p>
          </div>
        ) : url && isImage ? (
          <div className="h-full flex items-center justify-center">
            <img src={url} alt={file?.name ?? ""} className="max-h-full max-w-full object-contain rounded-lg" />
          </div>
        ) : url ? (
          <iframe src={url} title={file?.name ?? "Document"} className="w-full h-full rounded-lg bg-white" />
        ) : null}
      </div>
    </div>
  );
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * Email-first access.
 *
 * One link goes to everyone. The email decides the next step: allowlisted
 * people set a password (or log in with the one they set), everyone else files
 * a request the team approves or denies.
 */

type GateStep = "email" | "login" | "register" | "request" | "sent" | "pending" | "denied";

function Gate({ onSuccess }: { onSuccess: (token: string, name: string | null) => void }) {
  const [step, setStep]         = useState<GateStep>("email");
  const [email, setEmail]       = useState("");
  const [name, setName]         = useState("");
  const [firm, setFirm]         = useState("");
  const [note, setNote]         = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm]   = useState("");
  const [reason, setReason]     = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`/api/proxy/portal/${ROOM_SLUG}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.detail ?? "Something went wrong");
    return d;
  };

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const d = await post("identify", { email: email.trim().toLowerCase() });
      if (d.name && !name) setName(d.name);
      if (d.reason) setReason(d.reason);
      setStep(d.status === "unknown" ? "request" : (d.status as GateStep));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const d = await post("login", { email: email.trim().toLowerCase(), password });
      onSuccess(d.session_token, d.viewer_name ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Incorrect password");
    } finally { setBusy(false); }
  }

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr("Passwords do not match"); return; }
    if (password.length < 8)  { setErr("Password must be at least 8 characters"); return; }
    setBusy(true); setErr(null);
    try {
      const d = await post("register", {
        email: email.trim().toLowerCase(), password, name: name.trim() || null,
      });
      onSuccess(d.session_token, d.viewer_name ?? null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not create your access");
    } finally { setBusy(false); }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await post("request-access", {
        email: email.trim().toLowerCase(),
        name: name.trim() || null,
        firm: firm.trim() || null,
        note: note.trim() || null,
      });
      setStep("sent");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not send your request");
    } finally { setBusy(false); }
  }

  const field = (extra = "") =>
    `w-full px-3 py-2.5 text-lg rounded-lg bg-white border text-gray-900 placeholder-gray-400 outline-none transition-colors ${
      err ? "border-red-400" : "border-gray-200 focus:border-gray-400"
    } ${extra}`;

  const submitBtn = "w-full py-2.5 text-lg font-semibold rounded-lg bg-red-600 hover:bg-red-500 text-white disabled:bg-gray-100 disabled:text-gray-400 transition-colors";

  const back = (
    <button
      type="button"
      onClick={() => { setStep("email"); setErr(null); setPassword(""); setConfirm(""); }}
      className="text-base text-gray-400 hover:text-gray-700 transition-colors"
    >
      ← Use a different email
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex flex-col">
      <header className="border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center">
          <img src="/api/logo" alt="Open ERP" className="h-9 w-auto"
               onError={e => { const i = e.currentTarget; if (!i.src.includes("logo.svg")) i.src = "/logo.svg"; }} />
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div className="w-11 h-11 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center mb-5 text-gray-500">
              <LockIcon size={18} />
            </div>

            {step === "email" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Investor data room</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-6">
                  Enter your email to continue. If you haven&apos;t been given access yet,
                  you can request it here.
                </p>
                <form onSubmit={submitEmail} className="flex flex-col gap-3">
                  <input
                    type="email" value={email} autoFocus required
                    onChange={e => { setEmail(e.target.value); setErr(null); }}
                    placeholder="you@firm.com" className={field()}
                  />
                  {err && <p className="text-base text-red-600">{err}</p>}
                  <button type="submit" disabled={busy || !email.trim()} className={submitBtn}>
                    {busy ? "Checking…" : "Continue"}
                  </button>
                </form>
              </>
            )}

            {step === "login" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Welcome back{name ? `, ${name}` : ""}</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-6">
                  Enter the password you set for <span className="text-gray-700">{email}</span>.
                </p>
                <form onSubmit={submitLogin} className="flex flex-col gap-3">
                  <input
                    type="password" value={password} autoFocus required
                    onChange={e => { setPassword(e.target.value); setErr(null); }}
                    placeholder="Password" className={field()}
                  />
                  {err && <p className="text-base text-red-600">{err}</p>}
                  <button type="submit" disabled={busy || !password} className={submitBtn}>
                    {busy ? "Verifying…" : "Enter"}
                  </button>
                  {back}
                </form>
              </>
            )}

            {step === "register" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Set your password</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-6">
                  <span className="text-gray-700">{email}</span> is on the access list.
                  Choose a password to enter the room. You&apos;ll use it next time.
                </p>
                <form onSubmit={submitRegister} className="flex flex-col gap-3">
                  <input
                    type="text" value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Your name" className={field()}
                  />
                  <input
                    type="password" value={password} autoFocus required
                    onChange={e => { setPassword(e.target.value); setErr(null); }}
                    placeholder="Choose a password" className={field()}
                  />
                  <input
                    type="password" value={confirm} required
                    onChange={e => { setConfirm(e.target.value); setErr(null); }}
                    placeholder="Confirm password" className={field()}
                  />
                  <p className="text-xs text-gray-400">At least 8 characters.</p>
                  {err && <p className="text-base text-red-600">{err}</p>}
                  <button type="submit" disabled={busy || !password || !confirm} className={submitBtn}>
                    {busy ? "Setting up…" : "Create access"}
                  </button>
                  {back}
                </form>
              </>
            )}

            {step === "request" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Request access</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-6">
                  <span className="text-gray-700">{email}</span> isn&apos;t on the access list.
                  Tell us who you are and we&apos;ll review your request.
                </p>
                <form onSubmit={submitRequest} className="flex flex-col gap-3">
                  <input type="text" value={name} autoFocus onChange={e => setName(e.target.value)}
                         placeholder="Your name" className={field()} />
                  <input type="text" value={firm} onChange={e => setFirm(e.target.value)}
                         placeholder="Firm" className={field()} />
                  <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                            placeholder="Anything we should know? (optional)"
                            className={field("resize-none")} />
                  {err && <p className="text-base text-red-600">{err}</p>}
                  <button type="submit" disabled={busy} className={submitBtn}>
                    {busy ? "Sending…" : "Send request"}
                  </button>
                  {back}
                </form>
              </>
            )}

            {step === "sent" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Request sent</h1>
                <p className="text-lg text-gray-500 leading-relaxed">
                  Thanks, your request has been sent to the Open ERP team. If it&apos;s approved
                  you&apos;ll get an email at <span className="text-gray-700">{email}</span>
                  {" "}with a link to set your password.
                </p>
              </>
            )}

            {step === "pending" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">Request pending</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-5">
                  We already have a request from <span className="text-gray-700">{email}</span> and
                  it&apos;s still under review. You&apos;ll get an email once it&apos;s decided.
                </p>
                {back}
              </>
            )}

            {step === "denied" && (
              <>
                <h1 className="text-2xl font-semibold mb-1.5">No access</h1>
                <p className="text-lg text-gray-500 leading-relaxed mb-5">
                  {reason ?? "This email doesn't have access to the room."}
                </p>
                {back}
              </>
            )}
          </div>

          <p className="text-xs text-gray-300 text-center mt-5">
            Access is logged. Confidential, not for distribution.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Chrome ────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans flex flex-col">
      <header className="border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center">
          <img src="/api/logo" alt="Open ERP" className="h-9 w-auto"
               onError={e => { const i = e.currentTarget; if (!i.src.includes("logo.svg")) i.src = "/logo.svg"; }} />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />
    </svg>
  );
}
