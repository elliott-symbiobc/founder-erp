"use client";

/**
 * Editor for the tiles that make up the visual investor room (/investors).
 *
 * Tiles are curated content, not derived data — whatever is typed here is
 * exactly what the room renders. Each tile belongs to a section, carries a
 * type that decides which fields it has, and takes 1–4 columns of the room's
 * four-column grid.
 *
 * The field list per type is the single source of truth for both the form and
 * the room's renderers, so adding a field means adding it in FIELDS and in the
 * matching case of the room's Tile component.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RoomSectionId =
  | "overview" | "traction" | "science" | "team" | "raise" | "finance" | "governance";

export type BlockType = "stat" | "text" | "logo" | "person" | "list" | "chart" | "image" | "quote" | "docs";

interface RoomBlock {
  block_id: string;
  section: RoomSectionId;
  block_type: BlockType;
  position: number;
  is_visible: boolean;
  span: number;
  payload: Record<string, unknown>;
}

interface RoomSection {
  section: string;
  title: string | null;
  subtitle: string | null;
  position: number;
  is_visible: boolean;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const SECTIONS: { id: RoomSectionId; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "The opportunity at a glance" },
  { id: "traction", label: "Traction", hint: "Commercial engagements and proof points" },
  { id: "science",  label: "Science",  hint: "The platform and what makes it defensible" },
  { id: "team",     label: "Team",     hint: "Founders, operators and advisors" },
  { id: "raise",    label: "The Raise", hint: "SPV structure, terms and use of funds" },
  { id: "finance",  label: "Finance",  hint: "Financial position, projections and unit economics" },
  { id: "governance", label: "Governance", hint: "Board, cap table and how the SPV is governed" },
];

type FieldKind = "text" | "long" | "url";

interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
}

/** Repeatable sub-rows, for tiles that hold a collection. */
interface RepeatSpec {
  key: string;            // payload key holding the array
  label: string;
  columns: Field[];
}

const FIELDS: Record<BlockType, { label: string; blurb: string; fields: Field[]; repeat?: RepeatSpec }> = {
  stat: {
    label: "Stat",
    blurb: "One big number with a label.",
    fields: [
      { key: "label",   label: "Label",   kind: "text", placeholder: "Enterprise pilots" },
      { key: "value",   label: "Value",   kind: "text", placeholder: "5" },
      { key: "unit",    label: "Unit",    kind: "text", placeholder: "x, %, m" },
      { key: "caption", label: "Caption", kind: "long", placeholder: "Optional line under the number" },
    ],
  },
  text: {
    label: "Text",
    blurb: "A heading and a paragraph.",
    fields: [
      { key: "heading", label: "Heading", kind: "text", placeholder: "Why now" },
      { key: "body",    label: "Body",    kind: "long", placeholder: "Write the paragraph…" },
    ],
  },
  logo: {
    label: "Logo / client",
    blurb: "A company name or logo with a line about the engagement.",
    fields: [
      { key: "name",      label: "Name",       kind: "text", placeholder: "Kerry Inc." },
      { key: "detail",    label: "Detail",     kind: "long", placeholder: "Chicken bone residue upcycling" },
      { key: "image_url", label: "Logo URL",   kind: "url",  placeholder: "https://…" },
      { key: "href",      label: "Link",       kind: "url",  placeholder: "https://…" },
    ],
  },
  person: {
    label: "Person",
    blurb: "A founder, operator or advisor.",
    fields: [
      { key: "name",      label: "Name",      kind: "text" },
      { key: "title",     label: "Title",     kind: "text", placeholder: "Co-founder & CEO" },
      { key: "bio",       label: "Bio",       kind: "long" },
      { key: "image_url", label: "Photo URL", kind: "url",  placeholder: "https://…" },
      { key: "linkedin",  label: "LinkedIn",  kind: "url",  placeholder: "https://linkedin.com/in/…" },
    ],
  },
  list: {
    label: "List",
    blurb: "Rows of label and value — use of funds, terms, milestones.",
    fields: [{ key: "heading", label: "Heading", kind: "text", placeholder: "Use of funds" }],
    repeat: {
      key: "items",
      label: "Rows",
      columns: [
        { key: "label",  label: "Label",  kind: "text", placeholder: "Lab buildout" },
        { key: "value",  label: "Value",  kind: "text", placeholder: "40%" },
        { key: "detail", label: "Detail", kind: "text", placeholder: "Optional" },
      ],
    },
  },
  chart: {
    label: "Bar chart",
    blurb: "Labelled bars, scaled to the largest value.",
    fields: [
      { key: "heading", label: "Heading", kind: "text", placeholder: "Pipeline by stage" },
      { key: "unit",    label: "Unit",    kind: "text", placeholder: "%, k, projects" },
    ],
    repeat: {
      key: "series",
      label: "Bars",
      columns: [
        { key: "label", label: "Label", kind: "text", placeholder: "Pilot" },
        { key: "value", label: "Value", kind: "text", placeholder: "12" },
      ],
    },
  },
  image: {
    label: "Image",
    blurb: "A full-bleed image with an optional caption.",
    fields: [
      { key: "image_url", label: "Image URL", kind: "url", placeholder: "https://…" },
      { key: "alt",       label: "Alt text",  kind: "text" },
      { key: "caption",   label: "Caption",   kind: "text" },
    ],
  },
  docs: {
    label: "Documents",
    blurb: "A card linking to files in the room's Drive folder.",
    fields: [
      { key: "heading", label: "Heading", kind: "text", placeholder: "Financials" },
      { key: "caption", label: "Caption", kind: "long", placeholder: "Optional line under the heading" },
    ],
  },
  quote: {
    label: "Quote",
    blurb: "A pull quote with attribution.",
    fields: [
      { key: "body",        label: "Quote",       kind: "long" },
      { key: "attribution", label: "Attribution", kind: "text", placeholder: "Jane Doe" },
      { key: "role",        label: "Role",        kind: "text", placeholder: "VP R&D, Kerry" },
    ],
  },
};

const BLOCK_TYPES = Object.keys(FIELDS) as BlockType[];

// ── Component ─────────────────────────────────────────────────────────────────

export default function RoomTilesEditor({ portalId }: { portalId: string }) {
  const base = `/api/proxy/portals/room/${portalId}`;

  const [blocks, setBlocks]     = useState<RoomBlock[]>([]);
  const [sections, setSections] = useState<RoomSection[]>([]);
  // Overview's description is the portal's own description field, which the
  // generic portal view also shows. The other sections keep theirs on the
  // section row. Editing happens in one place either way.
  const [roomDescription, setRoomDescription] = useState("");
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState<string | null>(null);
  const [adding, setAdding]     = useState<RoomSectionId | null>(null);
  const [editing, setEditing]   = useState<string | null>(null);
  // Collapsed sections keep their header (title, description, tile count) and
  // hide only the tile list, so a long room stays scannable while editing.
  const [collapsed, setCollapsed] = useState<RoomSectionId[]>([]);

  const toggleCollapsed = (id: RoomSectionId) =>
    setCollapsed(c => (c.includes(id) ? c.filter(x => x !== id) : [...c, id]));

  const load = useCallback(async () => {
    setLoading(true);
    const [r, c] = await Promise.all([
      fetch(`${base}/blocks`),
      fetch(`${base}/content`),
    ]);
    if (r.ok) {
      const d = await r.json();
      setSections(d.sections ?? []);
      setBlocks(d.blocks ?? []);
    }
    if (c.ok) {
      const d = await c.json();
      setRoomDescription(d.description ?? "");
    }
    setLoading(false);
  }, [base]);

  useEffect(() => { load(); }, [load]);

  async function createBlock(section: RoomSectionId, type: BlockType, payload: Record<string, unknown>, span: number) {
    setBusy("new");
    const r = await fetch(`${base}/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, block_type: type, payload, span }),
    });
    if (r.ok) { setAdding(null); await load(); }
    setBusy(null);
  }

  async function patchBlock(id: string, patch: Record<string, unknown>) {
    setBusy(id);
    const r = await fetch(`${base}/blocks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) { setEditing(null); await load(); }
    setBusy(null);
  }

  async function removeBlock(id: string) {
    setBusy(id);
    await fetch(`${base}/blocks/${id}`, { method: "DELETE" });
    await load();
    setBusy(null);
  }

  /** Swap positions with the neighbour in the same section. */
  async function move(block: RoomBlock, dir: -1 | 1) {
    const peers = blocks.filter(b => b.section === block.section).sort((a, b) => a.position - b.position);
    const i = peers.findIndex(b => b.block_id === block.block_id);
    const j = i + dir;
    if (j < 0 || j >= peers.length) return;
    setBusy(block.block_id);
    await Promise.all([
      fetch(`${base}/blocks/${block.block_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: peers[j].position }),
      }),
      fetch(`${base}/blocks/${peers[j].block_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: peers[i].position }),
      }),
    ]);
    await load();
    setBusy(null);
  }

  async function saveSection(section: string, patch: Record<string, unknown>) {
    await fetch(`${base}/sections/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await load();
  }

  /** Title and description for one section, routed to wherever each lives. */
  async function saveHeading(section: RoomSectionId, title: string, description: string) {
    setBusy(`heading:${section}`);
    if (section === "overview") {
      await fetch(`${base}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim() || null }),
      });
      // Clear any subtitle left on the section row, or it would shadow the
      // description the room actually renders.
      await fetch(`${base}/sections/${section}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() || null, subtitle: null }),
      });
    } else {
      await fetch(`${base}/sections/${section}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || null,
          subtitle: description.trim() || null,
        }),
      });
    }
    await load();
    setBusy(null);
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <p className="text-sm text-gray-400">Loading tiles…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCollapsed(c => (c.length === SECTIONS.length ? [] : SECTIONS.map(s => s.id)))}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          {collapsed.length === SECTIONS.length ? "Expand all" : "Collapse all"}
        </button>
      </div>

      {SECTIONS.map(sec => {
        const meta      = sections.find(s => s.section === sec.id);
        const secBlocks = blocks
          .filter(b => b.section === sec.id)
          .sort((a, b) => a.position - b.position);
        const isCollapsed = collapsed.includes(sec.id) && adding !== sec.id;

        return (
          <div key={sec.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">

            {/* Section header — title and description edit in place */}
            <div className={`flex items-start justify-between gap-3 px-4 py-3 ${
              isCollapsed ? "" : "border-b border-gray-100 dark:border-gray-800"
            }`}>
              <button
                onClick={() => toggleCollapsed(sec.id)}
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? `Expand ${sec.label}` : `Collapse ${sec.label}`}
                className="shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-gray-800"
              >
                <svg viewBox="0 0 16 16" className={`w-3 h-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                     fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
              <SectionHeading
                defaultTitle={sec.label}
                defaultDescription={sec.hint}
                title={meta?.title ?? ""}
                description={sec.id === "overview" ? roomDescription : (meta?.subtitle ?? "")}
                tileCount={secBlocks.length}
                hidden={meta ? !meta.is_visible : false}
                saving={busy === `heading:${sec.id}`}
                onSave={(t, d) => saveHeading(sec.id, t, d)}
              />

              <div className="flex items-center gap-3 shrink-0 pt-0.5">
                <button
                  onClick={() => saveSection(sec.id, { is_visible: !(meta?.is_visible ?? true) })}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  {(meta?.is_visible ?? true) ? "Hide" : "Show"}
                </button>
                <button
                  onClick={() => setAdding(adding === sec.id ? null : sec.id)}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {adding === sec.id ? "Cancel" : "+ Tile"}
                </button>
              </div>
            </div>

            {/* Add form */}
            {!isCollapsed && adding === sec.id && (
              <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30">
                <TileForm
                  portalId={portalId}
                  saving={busy === "new"}
                  onCancel={() => setAdding(null)}
                  onSave={(type, payload, span) => createBlock(sec.id, type, payload, span)}
                />
              </div>
            )}

            {/* Tiles */}
            {isCollapsed ? null : secBlocks.length === 0 && adding !== sec.id ? (
              <p className="px-4 py-6 text-xs text-gray-400 text-center">
                No tiles yet. This section is hidden from the room until it has content.
              </p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {secBlocks.map((b, i) => (
                  <div key={b.block_id} className="px-4 py-3">
                    {editing === b.block_id ? (
                      <TileForm
                        portalId={portalId}
                        initialType={b.block_type}
                        initialPayload={b.payload}
                        initialSpan={b.span}
                        saving={busy === b.block_id}
                        onCancel={() => setEditing(null)}
                        onSave={(type, payload, span) =>
                          patchBlock(b.block_id, { block_type: type, payload, span })}
                      />
                    ) : (
                      <div className="flex items-start gap-3">
                        <div className="flex flex-col gap-0.5 pt-0.5 shrink-0">
                          <button
                            onClick={() => move(b, -1)}
                            disabled={i === 0 || busy === b.block_id}
                            className="text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-25 leading-none text-xs"
                          >▲</button>
                          <button
                            onClick={() => move(b, 1)}
                            disabled={i === secBlocks.length - 1 || busy === b.block_id}
                            className="text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-25 leading-none text-xs"
                          >▼</button>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded px-1.5 py-0.5">
                              {FIELDS[b.block_type].label}
                            </span>
                            <span className="text-[10px] text-gray-400">{["", "\u2153", "\u00bd", "\u2154", "full"][b.span] ?? ""}</span>
                            {!b.is_visible && (
                              <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">Hidden</span>
                            )}
                          </div>
                          <p className="text-sm text-gray-800 dark:text-gray-200 mt-1 truncate">
                            {summarise(b)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          <button
                            onClick={() => patchBlock(b.block_id, { is_visible: !b.is_visible })}
                            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                          >
                            {b.is_visible ? "Hide" : "Show"}
                          </button>
                          <button
                            onClick={() => setEditing(b.block_id)}
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => removeBlock(b.block_id)}
                            disabled={busy === b.block_id}
                            className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One-line preview of a tile, so the list is scannable without opening each one. */
function summarise(b: RoomBlock): string {
  const p = b.payload ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  switch (b.block_type) {
    case "stat":   return [pick("value"), pick("label")].filter(Boolean).join(" — ") || "Empty stat";
    case "list":
    case "chart":  return pick("heading") ?? `Untitled ${b.block_type}`;
    case "logo":
    case "person": return pick("name") ?? "Unnamed";
    case "quote":  return pick("body") ?? "Empty quote";
    case "image":  return pick("caption", "alt", "image_url") ?? "Image";
    case "docs": {
      const mirrored = Array.isArray(p.roles) ? (p.roles as unknown[]).length : 0;
      const n = mirrored || (Array.isArray(p.items) ? (p.items as unknown[]).length : 0);
      const noun = `${n} file${n === 1 ? "" : "s"}`;
      return `${pick("heading") ?? "Documents"} — ${mirrored ? `${noun}, synced` : noun}`;
    }
    default:       return pick("heading", "body") ?? "Empty";
  }
}

// ── Tile form ─────────────────────────────────────────────────────────────────

function TileForm({
  portalId,
  initialType,
  initialPayload,
  initialSpan,
  saving,
  onSave,
  onCancel,
}: {
  portalId: string;
  initialType?: BlockType;
  initialPayload?: Record<string, unknown>;
  initialSpan?: number;
  saving: boolean;
  onSave: (type: BlockType, payload: Record<string, unknown>, span: number) => void;
  onCancel: () => void;
}) {
  const [type, setType]       = useState<BlockType>(initialType ?? "stat");
  const [span, setSpan]       = useState<number>(initialSpan ?? 1);
  const [payload, setPayload] = useState<Record<string, unknown>>(initialPayload ?? {});

  const spec   = FIELDS[type];
  const repeat = spec.repeat;
  const docs   = Array.isArray(payload.items) && type === "docs"
    ? (payload.items as DocItem[])
    : [];
  const rows   = repeat && Array.isArray(payload[repeat.key])
    ? (payload[repeat.key] as Record<string, unknown>[])
    : [];

  const set = (k: string, v: string) => setPayload(prev => ({ ...prev, [k]: v }));

  const setRow = (i: number, k: string, v: string) => {
    if (!repeat) return;
    const next = rows.map((r, ri) => ri === i ? { ...r, [k]: v } : r);
    setPayload(prev => ({ ...prev, [repeat.key]: next }));
  };

  const addRow = () => {
    if (!repeat) return;
    setPayload(prev => ({ ...prev, [repeat.key]: [...rows, {}] }));
  };

  const removeRow = (i: number) => {
    if (!repeat) return;
    setPayload(prev => ({ ...prev, [repeat.key]: rows.filter((_, ri) => ri !== i) }));
  };

  const input = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const label = "block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1";

  return (
    <div className="space-y-3">

      {/* Type + width */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <label className={label}>Tile type</label>
          <select
            value={type}
            onChange={e => { setType(e.target.value as BlockType); setPayload({}); }}
            className={input}
          >
            {BLOCK_TYPES.map(t => (
              <option key={t} value={t}>{FIELDS[t].label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Width</label>
          <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs font-medium">
            {([[1, "⅓"], [2, "½"], [3, "⅔"], [4, "Full"]] as [number, string][]).map(([n, lbl]) => (
              <button
                key={n}
                type="button"
                onClick={() => setSpan(n)}
                title={`${lbl} of the row`}
                className={`px-3 py-2 transition-colors ${
                  span === n
                    ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                    : "bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-gray-400 pb-2 flex-1 min-w-[180px]">{spec.blurb}</p>
      </div>

      {/* Scalar fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {spec.fields.map(f => (
          <div key={f.key} className={f.kind === "long" ? "sm:col-span-2" : ""}>
            <label className={label}>{f.label}</label>
            {f.kind === "long" ? (
              <AutoTextarea
                rows={2}
                value={(payload[f.key] as string) ?? ""}
                placeholder={f.placeholder}
                onChange={e => set(f.key, e.target.value)}
                className={`${input} resize-none`}
              />
            ) : f.key === "image_url" ? (
              <ImageField
                portalId={portalId}
                value={(payload[f.key] as string) ?? ""}
                placeholder={f.placeholder}
                inputClass={input}
                onChange={v => set(f.key, v)}
              />
            ) : (
              <input
                type={f.kind === "url" ? "url" : "text"}
                value={(payload[f.key] as string) ?? ""}
                placeholder={f.placeholder}
                onChange={e => set(f.key, e.target.value)}
                className={input}
              />
            )}
          </div>
        ))}
      </div>

      {/* Documents: either hand-picked files, or mirrored from Marketing */}
      {type === "docs" && (
        <MarketingMirror
          roles={Array.isArray(payload.roles) ? (payload.roles as string[]) : []}
          onChange={roles => setPayload(prev => {
            const next = { ...prev, roles: roles.length ? roles : undefined };
            delete (next as Record<string, unknown>).role;   // retire the old single key
            return next;
          })}
        />
      )}
      {type === "docs" && !(Array.isArray(payload.roles) && payload.roles.length) && (
        <DrivePicker
          portalId={portalId}
          selected={docs}
          onChange={items => setPayload(prev => ({ ...prev, items }))}
        />
      )}

      {/* Repeatable rows */}
      {repeat && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={label + " mb-0"}>{repeat.label}</label>
            <button type="button" onClick={addRow} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
              + Add row
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="text-xs text-gray-400 py-2">No rows yet.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  {repeat.columns.map(c => (
                    <input
                      key={c.key}
                      type="text"
                      value={(row[c.key] as string) ?? ""}
                      placeholder={c.placeholder ?? c.label}
                      onChange={e => setRow(i, c.key, e.target.value)}
                      className={input}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-xs text-gray-400 hover:text-red-500 shrink-0 px-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(type, payload, span)}
          className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
        >
          {saving ? "Saving…" : "Save tile"}
        </button>
      </div>
    </div>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────

/**
 * A section's title and description, edited where they are read rather than
 * behind a Rename control. Save appears only once something changes, so the
 * header stays quiet while you are working on tiles.
 */
function SectionHeading({
  defaultTitle,
  defaultDescription,
  title,
  description,
  tileCount,
  hidden,
  saving,
  onSave,
}: {
  defaultTitle: string;
  defaultDescription: string;
  title: string;
  description: string;
  tileCount: number;
  hidden: boolean;
  saving: boolean;
  onSave: (title: string, description: string) => void;
}) {
  const [t, setT] = useState(title);
  const [d, setD] = useState(description);
  const [synced, setSynced] = useState({ title, description });

  // Adding or reordering a tile reloads the whole editor, which would other-
  // wise throw away a heading someone is midway through typing. Adopt incoming
  // values during render, but only for a field that has not been touched.
  if (synced.title !== title || synced.description !== description) {
    if (t === synced.title) setT(title);
    if (d === synced.description) setD(description);
    setSynced({ title, description });
  }

  const dirty = t !== title || d !== description;

  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <input
          value={t}
          onChange={e => setT(e.target.value)}
          placeholder={defaultTitle}
          className="min-w-0 flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100 bg-transparent border-0 border-b border-transparent hover:border-gray-200 dark:hover:border-gray-700 focus:border-blue-400 focus:outline-none px-0 py-0.5 placeholder-gray-400"
        />
        <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
          {tileCount} {tileCount === 1 ? "tile" : "tiles"}
        </span>
        {hidden && (
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded shrink-0">
            Hidden
          </span>
        )}
      </div>

      <AutoTextarea
        rows={1}
        value={d}
        onChange={e => setD(e.target.value)}
        placeholder={defaultDescription}
        className="w-full mt-1 text-xs text-gray-500 dark:text-gray-400 bg-transparent border-0 border-b border-transparent hover:border-gray-200 dark:hover:border-gray-700 focus:border-blue-400 focus:outline-none px-0 py-0.5 resize-none placeholder-gray-400 leading-relaxed"
      />

      {dirty && (
        <div className="flex items-center gap-2 mt-1.5">
          <button
            onClick={() => onSave(t, d)}
            disabled={saving}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
          >
            {saving ? "Saving…" : "Save heading"}
          </button>
          <button
            onClick={() => { setT(title); setD(description); }}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Drive picker ──────────────────────────────────────────────────────────────

interface DocItem { file_id: string; name: string; mime_type: string | null }

interface DriveFile { file_id: string; name: string; mime_type: string | null }

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Browse the room's linked Drive folder and pick files for a documents tile.
 *
 * Name and type are captured at pick time rather than resolved on every room
 * render — downloads go by file_id, so a rename keeps working and only the
 * label goes stale.
 */
function DrivePicker({
  portalId,
  selected,
  onChange,
}: {
  portalId: string;
  selected: DocItem[];
  onChange: (items: DocItem[]) => void;
}) {
  const [stack, setStack]     = useState<{ id: string | null; name: string }[]>([{ id: null, name: "Room folder" }]);
  const [files, setFiles]     = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);

  const current = stack[stack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qs = current.id ? `?folder_id=${encodeURIComponent(current.id)}` : "";
    fetch(`/api/proxy/portals/room/${portalId}/files${qs}`)
      .then(r => (r.ok ? r.json() : { files: [] }))
      .then(d => { if (!cancelled) setFiles(d.files ?? []); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [portalId, current.id]);

  const isPicked = (id: string) => selected.some(s => s.file_id === id);

  const toggle = (f: DriveFile) => {
    onChange(
      isPicked(f.file_id)
        ? selected.filter(s => s.file_id !== f.file_id)
        : [...selected, { file_id: f.file_id, name: f.name, mime_type: f.mime_type }]
    );
  };

  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
        Documents
      </label>

      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 flex-wrap px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800 text-xs">
          {stack.map((entry, i) => (
            <React.Fragment key={`${entry.id ?? "root"}-${i}`}>
              {i > 0 && <span className="text-gray-300 dark:text-gray-600">/</span>}
              <button
                type="button"
                onClick={() => setStack(stack.slice(0, i + 1))}
                className={i === stack.length - 1
                  ? "text-gray-700 dark:text-gray-200 font-medium"
                  : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"}
              >
                {entry.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="max-h-52 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
          {loading ? (
            <p className="px-3 py-4 text-xs text-gray-400">Loading…</p>
          ) : files.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400">
              Nothing here. Link a Drive folder under Documents first.
            </p>
          ) : (
            files.map(f => {
              const isFolder = f.mime_type === FOLDER_MIME;
              return (
                <div key={f.file_id} className="flex items-center gap-2.5 px-3 py-2">
                  {isFolder ? (
                    <button
                      type="button"
                      onClick={() => setStack([...stack, { id: f.file_id, name: f.name }])}
                      className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 min-w-0"
                    >
                      <span className="text-amber-500 shrink-0">▸</span>
                      <span className="truncate">{f.name}</span>
                    </button>
                  ) : (
                    <label className="flex items-center gap-2.5 cursor-pointer min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={isPicked(f.file_id)}
                        onChange={() => toggle(f)}
                        className="shrink-0"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-200 truncate">{f.name}</span>
                    </label>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {selected.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selected.map(s => (
            <span key={s.file_id} className="inline-flex items-center gap-1.5 text-[11px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded px-2 py-1">
              {s.name}
              <button
                type="button"
                onClick={() => onChange(selected.filter(x => x.file_id !== s.file_id))}
                className="text-gray-400 hover:text-red-500"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Marketing mirror ──────────────────────────────────────────────────────────

interface MarketingRole { role: string; label: string; file_name: string | null }

/**
 * Point a documents tile at Marketing instead of specific files.
 *
 * Off by default. When roles are selected the tile stops serving the files
 * picked here and serves whatever Marketing currently holds for each one, in
 * the order chosen — so a room cannot go stale behind a replaced deck.
 */
function MarketingMirror({
  roles,
  onChange,
}: {
  roles: string[];
  onChange: (roles: string[]) => void;
}) {
  const [available, setAvailable] = useState<MarketingRole[]>([]);
  const [failed, setFailed]       = useState(false);

  useEffect(() => {
    fetch("/api/proxy/marketing/roles")
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => setAvailable(Array.isArray(d) ? d : []))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  const on = roles.length > 0;

  const toggle = (role: string) =>
    onChange(roles.includes(role) ? roles.filter(r => r !== role) : [...roles, role]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={e => onChange(e.target.checked ? [available[0]?.role ?? "investor-deck"] : [])}
        />
        <span className="text-sm text-gray-700 dark:text-gray-200">
          Keep this tile up to date from Marketing
        </span>
      </label>

      {on ? (
        <div className="mt-2 pl-6">
          <p className="text-[11px] text-gray-400 mb-1.5">
            Pick every document this tile should show. They appear in the order selected.
          </p>
          <div className="space-y-1">
            {available.map(r => {
              const checked = roles.includes(r.role);
              const order = roles.indexOf(r.role) + 1;
              return (
                <label key={r.role} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(r.role)}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="text-sm text-gray-700 dark:text-gray-200">
                      {checked && <span className="text-gray-400 tabular-nums">{order}. </span>}
                      {r.label}
                    </span>
                    <span className="block text-[11px] text-gray-400 truncate">
                      {r.file_name ?? "Nothing assigned in Marketing — this one will not appear."}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-1 pl-6 text-[11px] text-gray-400">
          Off — the tile serves whichever files you pick below.
        </p>
      )}
    </div>
  );
}


// ── Image field ───────────────────────────────────────────────────────────────

/**
 * An image for a tile: either a URL, or a file chosen from this computer.
 *
 * Uploading stores the file and puts its address in the same field, so the tile
 * payload stays a single URL either way and nothing downstream has to know
 * where a picture came from.
 */
function ImageField({
  portalId,
  value,
  placeholder,
  inputClass,
  onChange,
}: {
  portalId: string;
  value: string;
  placeholder?: string;
  inputClass: string;
  onChange: (value: string) => void;
}) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`/api/proxy/portals/room/${portalId}/images`, {
        method: "POST",
        body: form,          // no Content-Type: the browser sets the boundary
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail ?? "Upload failed");
      onChange(d.url);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          placeholder={placeholder ?? "https://… or upload"}
          onChange={e => onChange(e.target.value)}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 shrink-0 whitespace-nowrap"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
      </div>

      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}

      {value && (
        <div className="flex items-center gap-2 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="h-12 w-12 rounded object-cover border border-gray-200 dark:border-gray-700" />
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs text-gray-400 hover:text-red-500"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
