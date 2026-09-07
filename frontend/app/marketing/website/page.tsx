"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ─── Types ───────────────────────────────────────────────────────────────────

interface Post {
  id: number;
  slug: string;
  title: string;
  status: string;
  date: string;
  modified: string;
  link: string;
  excerpt: string;
  categories: number[];
  tags: number[];
}

interface PostDetail extends Post {
  content: string;
  content_rendered: string;
}

interface AcfBlock {
  block: string;
  raw_data: Record<string, unknown>;
  acf: Record<string, unknown>;
  fields: string[];
}

interface Page {
  id: number;
  slug: string;
  label: string;
  title: string;
  modified: string;
  link: string;
  blocks: AcfBlock[];
  error?: string;
}

interface Category {
  id: number;
  name: string;
  count: number;
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts: RequestInit = {}) {
  const r = await fetch(`/api/proxy${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail));
  }
  return r.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return iso; }
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

const STATUS_COLORS: Record<string, string> = {
  publish: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  draft:   "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  future:  "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  private: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  pending: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

const STATUS_LABELS: Record<string, string> = {
  publish: "Published",
  draft:   "Draft",
  future:  "Scheduled",
  private: "Private",
  pending: "Pending",
};

// ─── Post Editor ──────────────────────────────────────────────────────────────

const WP_ADMIN = "https://example.com/wp-admin";

function toLocalDatetimeValue(iso: string) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ""; }
}

function PostEditor({
  post,
  categories,
  onSave,
  onCancel,
  onDelete,
}: {
  post: PostDetail | null;
  categories: Category[];
  onSave: (data: { title: string; content: string; status: string; categories: number[]; date?: string }) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const isNew = !post?.id;
  const initStatus = post?.status === "future" ? "future" : (post?.status ?? "draft");

  const [title, setTitle] = useState(post?.title ?? "");
  const [content, setContent] = useState(post?.content ?? "");
  const [status, setStatus] = useState(initStatus);
  const [scheduleDate, setScheduleDate] = useState(() =>
    post?.status === "future" ? toLocalDatetimeValue(post.date) : ""
  );
  const [selCats, setSelCats] = useState<number[]>(post?.categories ?? []);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  function toggleCat(id: number) {
    setSelCats(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError("Title is required"); return; }
    if (status === "future" && !scheduleDate) { setError("Scheduled date is required"); return; }
    setSaving(true); setError(null);
    try {
      const payload: { title: string; content: string; status: string; categories: number[]; date?: string } = {
        title: title.trim(), content, status, categories: selCats,
      };
      if (status === "future" && scheduleDate) {
        payload.date = new Date(scheduleDate).toISOString();
      }
      await onSave(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(false); }
  }

  async function doDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : "Delete failed"); setDeleting(false); setDeleteConfirm(false); }
  }

  const submitLabel = saving ? "Saving…"
    : status === "publish" ? "Publish"
    : status === "future" ? "Schedule"
    : "Save Draft";

  return (
    <form onSubmit={submit} className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {isNew ? "New Post" : "Edit Post"}
          </h2>
          {!isNew && (
            <a
              href={`${WP_ADMIN}/post.php?post=${post!.id}&action=edit`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline">
              Edit in WordPress ↗
            </a>
          )}
        </div>
        <button type="button" onClick={onCancel}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Title *</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Post title"
            className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40">
              <option value="draft">Draft</option>
              <option value="publish">Published</option>
              <option value="future">Scheduled</option>
              <option value="private">Private</option>
            </select>
          </div>
          {status === "future" && (
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Publish date *</label>
              <input type="datetime-local" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)}
                min={toLocalDatetimeValue(new Date().toISOString())}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            </div>
          )}
        </div>

        {categories.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">Categories</label>
            <div className="flex flex-wrap gap-1.5">
              {categories.filter(c => c.id !== 1).map(cat => (
                <button key={cat.id} type="button" onClick={() => toggleCat(cat.id)}
                  className={`px-2.5 py-1 text-xs rounded border transition-colors ${selCats.includes(cat.id) ? "bg-blue-600 text-white border-blue-600" : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-blue-400"}`}>
                  {cat.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Content</label>
          <AutoTextarea value={content} onChange={e => setContent(e.target.value)}
            rows={20}
            placeholder="Write your post content here. You can use HTML or WordPress block markup."
            className="w-full resize-none border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm font-mono bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </div>

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
        <div>
          {!isNew && onDelete && (
            deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Delete permanently?</span>
                <button type="button" onClick={doDelete} disabled={deleting}
                  className="px-2.5 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60">
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button type="button" onClick={() => setDeleteConfirm(false)}
                  className="px-2.5 py-1 text-xs rounded text-gray-500 hover:text-gray-700">Cancel</button>
              </div>
            ) : (
              <button type="button" onClick={() => setDeleteConfirm(true)}
                className="text-xs text-red-500 hover:text-red-700">Delete post</button>
            )
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60">
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── Page Block Editor ────────────────────────────────────────────────────────

function BlockFieldEditor({
  pageId,
  block,
  blockIndex,
  onSaved,
}: {
  pageId: number;
  block: AcfBlock;
  blockIndex: number;
  onSaved: () => void;
}) {
  const initFields = (acf: Record<string, unknown>, fields: string[]) => {
    const init: Record<string, string> = {};
    for (const f of fields) {
      const val = acf[f];
      init[f] = typeof val === "string" ? val : val !== undefined ? JSON.stringify(val) : "";
    }
    return init;
  };

  const [fields, setFields] = useState<Record<string, string>>(() => initFields(block.acf, block.fields));

  useEffect(() => {
    setFields(initFields(block.acf, block.fields));
  }, [block]);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveField(field: string) {
    setSaving(field); setError(null);
    try {
      await apiFetch(`/marketing/website/pages/${pageId}/block`, {
        method: "PATCH",
        body: JSON.stringify({ block: block.block, field, value: fields[field], block_index: blockIndex }),
      });
      setSaved(field);
      setTimeout(() => setSaved(null), 2000);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally { setSaving(null); }
  }

  const isMultiline = (field: string, val: string) =>
    ["body", "steps", "items", "kpis", "subheading"].includes(field) || val.length > 100;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
          {block.block}
        </span>
      </div>
      {block.fields.map(field => (
        <div key={field}>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 capitalize">
            {field.replace(/_/g, " ")}
          </label>
          <div className="flex gap-2">
            {isMultiline(field, fields[field] ?? "") ? (
              <AutoTextarea
                value={fields[field] ?? ""}
                onChange={e => setFields(prev => ({ ...prev, [field]: e.target.value }))}
                rows={3}
                className="flex-1 resize-none border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            ) : (
              <input
                type="text"
                value={fields[field] ?? ""}
                onChange={e => setFields(prev => ({ ...prev, [field]: e.target.value }))}
                className="flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            )}
            <button
              onClick={() => saveField(field)}
              disabled={saving === field}
              className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-60 transition-colors"
            >
              {saving === field ? "…" : saved === field ? "✓" : "Save"}
            </button>
          </div>
        </div>
      ))}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ─── Page Panel ───────────────────────────────────────────────────────────────

function PagePanel({
  page,
  onClose,
  onSaved,
}: {
  page: Page;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{page.label}</h2>
          <a href={page.link} target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:underline">
            View live ↗
          </a>
        </div>
        <button type="button" onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {page.error && (
          <p className="text-sm text-red-500">{page.error}</p>
        )}
        {page.blocks.length === 0 && !page.error && (
          <p className="text-sm text-gray-400 py-6 text-center">
            No ACF blocks found on this page.
          </p>
        )}
        {page.blocks.map((block, i) => (
          <div key={`${block.block}-${i}`}
            className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setExpanded(expanded === i ? null : i)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">
                {block.block.replace(/-/g, " ")}
                <span className="text-xs font-normal text-gray-400 ml-2">
                  {block.fields.length} field{block.fields.length !== 1 ? "s" : ""}
                </span>
              </span>
              <svg
                className={`w-4 h-4 text-gray-400 transition-transform ${expanded === i ? "rotate-180" : ""}`}
                fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {expanded === i && (
              <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700">
                <BlockFieldEditor pageId={page.id} block={block} blockIndex={i} onSaved={onSaved} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type TabType = "posts" | "pages";

export default function WebsitePage() {
  const [tab, setTab] = useState<TabType>("posts");

  // Posts state
  const [posts, setPosts] = useState<Post[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [selectedPost, setSelectedPost] = useState<PostDetail | null | "new">(null);
  const [postLoading, setPostLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [postFilter, setPostFilter] = useState<"all" | "publish" | "draft" | "future">("all");

  // Pages state
  const [pages, setPages] = useState<Page[]>([]);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState<Page | null>(null);

  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    try {
      const data = await apiFetch("/marketing/website/posts?per_page=50&status=any");
      setPosts(data);
    } finally { setPostsLoading(false); }
  }, []);

  const selectedPageIdRef = useRef<number | null>(null);

  const loadPages = useCallback(async () => {
    setPagesLoading(true);
    try {
      const data = await apiFetch("/marketing/website/pages");
      setPages(data);
      if (selectedPageIdRef.current !== null) {
        const updated = data.find((p: Page) => p.id === selectedPageIdRef.current);
        if (updated) setSelectedPage(updated);
      }
    } finally { setPagesLoading(false); }
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const data = await apiFetch("/marketing/website/categories");
      setCategories(data);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { selectedPageIdRef.current = selectedPage?.id ?? null; }, [selectedPage]);

  useEffect(() => { loadPosts(); loadCategories(); }, [loadPosts, loadCategories]);
  useEffect(() => { if (tab === "pages") loadPages(); }, [tab, loadPages]);

  async function openPost(id: number) {
    setPostLoading(true);
    try {
      const data = await apiFetch(`/marketing/website/posts/${id}`);
      setSelectedPost(data);
    } finally { setPostLoading(false); }
  }

  async function savePost(data: { title: string; content: string; status: string; categories: number[]; date?: string }) {
    if (selectedPost === "new") {
      await apiFetch("/marketing/website/posts", { method: "POST", body: JSON.stringify(data) });
    } else if (selectedPost) {
      await apiFetch(`/marketing/website/posts/${selectedPost.id}`, { method: "PATCH", body: JSON.stringify(data) });
    }
    setSelectedPost(null);
    await loadPosts();
  }

  async function deletePost() {
    if (!selectedPost || selectedPost === "new") return;
    await apiFetch(`/marketing/website/posts/${selectedPost.id}`, { method: "DELETE" });
    setSelectedPost(null);
    await loadPosts();
  }

  const filteredPosts = postFilter === "all" ? posts : posts.filter(p => p.status === postFilter);

  const panelOpen = selectedPost !== null || selectedPage !== null;

  return (
    <div className="flex h-full">
      {/* Left panel */}
      <div className={`flex flex-col ${panelOpen ? "w-1/2 border-r border-gray-200 dark:border-gray-700" : "w-full"} transition-all`}>

        {/* Sub-tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0 px-6">
          {(["posts", "pages"] as TabType[]).map(t => (
            <button key={t} onClick={() => { setTab(t); setSelectedPost(null); setSelectedPage(null); }}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${tab === t ? "border-blue-600 text-blue-700 dark:text-blue-400" : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
              {t}
            </button>
          ))}
        </div>

        {tab === "posts" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 shrink-0">
              <div className="flex gap-1">
                {([
                  { value: "all",     label: "All"       },
                  { value: "publish", label: "Published" },
                  { value: "draft",   label: "Drafts"    },
                  { value: "future",  label: "Scheduled" },
                ] as const).map(f => (
                  <button key={f.value} onClick={() => setPostFilter(f.value)}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${postFilter === f.value ? "bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              <button onClick={() => setSelectedPost("new")}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New Post
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 pb-6">
              {postsLoading ? (
                <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>
              ) : filteredPosts.length === 0 ? (
                <div className="text-center py-16 text-gray-400 text-sm">No posts found.</div>
              ) : (
                <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
                  {filteredPosts.map(post => (
                    <button key={post.id}
                      onClick={() => openPost(post.id)}
                      className="w-full text-left flex items-start gap-3 px-5 py-4 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {post.title || "(untitled)"}
                          </span>
                          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[post.status] ?? "bg-gray-100 text-gray-600"}`}>
                            {STATUS_LABELS[post.status] ?? post.status}
                          </span>
                        </div>
                        {post.excerpt && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {stripHtml(post.excerpt)}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {post.status === "future" ? `Scheduled · ${fmtDate(post.date)}` : fmtDate(post.date)}
                        </p>
                      </div>
                      {postLoading && <div className="shrink-0 w-3 h-3 rounded-full border-2 border-blue-600 border-t-transparent animate-spin mt-1" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "pages" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-3 shrink-0">
              <span className="text-xs text-gray-400">{pages.length} pages</span>
              <button onClick={loadPages} disabled={pagesLoading}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-40">
                <svg className={`w-3.5 h-3.5 ${pagesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Reload
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 pb-6">
            {pagesLoading ? (
              <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>
            ) : (
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
                {pages.map(page => (
                  <button key={page.id}
                    onClick={() => { setSelectedPage(page); setSelectedPost(null); }}
                    className={`w-full text-left flex items-center justify-between px-5 py-4 transition-colors ${selectedPage?.id === page.id ? "bg-blue-50 dark:bg-blue-950/30" : "bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/50"}`}>
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{page.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {page.blocks.length} block{page.blocks.length !== 1 ? "s" : ""} · Updated {fmtDate(page.modified)}
                      </p>
                    </div>
                    <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      {/* Right panel */}
      {panelOpen && (
        <div className="w-1/2 flex flex-col overflow-hidden">
          {selectedPost !== null && (
            <PostEditor
              post={selectedPost === "new" ? null : selectedPost}
              categories={categories}
              onSave={savePost}
              onCancel={() => setSelectedPost(null)}
              onDelete={selectedPost !== "new" ? deletePost : undefined}
            />
          )}
          {selectedPage !== null && (
            <PagePanel
              page={selectedPage}
              onClose={() => setSelectedPage(null)}
              onSaved={loadPages}
            />
          )}
        </div>
      )}
    </div>
  );
}
