"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, BubbleMenu, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextStyle from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import TextAlign from "@tiptap/extension-text-align";
import { Extension } from "@tiptap/core";
import Link from "@tiptap/extension-link";

import { AutoTextarea } from "@/components/AutoTextarea";
type CampaignType = "email";
type CampaignStatus = "draft" | "scheduled" | "sent" | "failed";
type TopTab = "campaigns" | "templates" | "lists" | "settings";
type BlockType = "heading" | "text" | "button" | "callout" | "divider" | "image" | "logo";

interface Campaign {
  campaign_id: string;
  title: string;
  type: CampaignType;
  template_id: string | null;
  list_id: string | null;
  sender_name: string | null;
  sender_email: string | null;
  reply_to: string | null;
  business_name: string | null;
  business_address: string | null;
  unsubscribe_enabled: boolean;
  subject: string;
  body: string;
  body_html: string | null;
  recipient_list: string[];
  list_ids: string[];
  status: CampaignStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  sent_count: number;
  open_count: number;
  error_message: string | null;
  created_at: string;
}

interface CampaignPost {
  post_id: string;
  campaign_id: string;
  template_id: string | null;
  title: string;
  subject: string;
  body: string;
  body_html: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  sent_count: number;
  open_count: number;
  error_message: string | null;
  created_at: string;
  list_ids: string[];
}

interface CampaignTemplate {
  template_id: string;
  name: string;
  type: CampaignType;
  subject: string;
  body: string;
  body_html: string | null;
  sender_name: string | null;
  sender_email: string | null;
  reply_to: string | null;
  business_name: string | null;
  business_address: string | null;
  unsubscribe_enabled: boolean;
  updated_at: string;
}

interface ListScheduleEntry {
  list_id: string;
  name: string;
  frequency: "every" | "every_other" | "every_third" | "monthly";
  contact_count: number;
}

const FREQ_OPTIONS: { value: ListScheduleEntry["frequency"]; label: string }[] = [
  { value: "every", label: "Every email" },
  { value: "every_other", label: "Every other email" },
  { value: "every_third", label: "Every third email" },
  { value: "monthly", label: "Monthly" },
];

interface CampaignList {
  list_id: string;
  name: string;
  description: string | null;
  contact_count: number;
  created_at: string;
}

interface BrandSettings {
  font_family: string;
  font_size: number;
  heading_size: number;
  text_color: string;
  heading_color: string;
  button_color: string;
  button_text_color: string;
  brand_colors: string[];
  logo_url: string | null;
  business_name: string | null;
  business_address: string | null;
}

const DEFAULT_BRAND: BrandSettings = {
  font_family: "Arial, Helvetica, sans-serif",
  font_size: 15,
  heading_size: 28,
  text_color: "#374151",
  heading_color: "#111827",
  button_color: "#2563eb",
  button_text_color: "#ffffff",
  brand_colors: [],
  logo_url: null,
  business_name: null,
  business_address: null,
};

interface ContactEmail { email: string; label: string; is_primary: boolean; }
interface ListContact {
  contact_id: string;
  name: string;
  email: string;
  emails?: ContactEmail[];
  send_email?: string;
  organization: string | null;
  title: string | null;
  tags: string[];
}

interface EmailBlock {
  id: string;
  type: BlockType;
  fieldName?: string;
  text: string;
  url?: string;
  alt?: string;
  width?: number;
  blockWidth?: number;
  blockOffset?: number;
  blockMinHeight?: number;
  layout?: "full" | "half";
  align?: "left" | "center";
  color?: string;
  backgroundColor?: string;
  accentColor?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: "400" | "500" | "600" | "700";
  lineHeight?: number;
  blockSpacing?: number;
  radius?: number;
  verticalAlign?: "top" | "center" | "bottom";
}

const STATUS_STYLE: Record<CampaignStatus, string> = {
  draft: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  sent: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

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

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(value: string) {
  return escapeHtml(value)
    .replace(/\[size=(\d{1,3})\]([\s\S]+?)\[\/size\]/g, (_match, size, content) => {
      const fontSize = Math.min(72, Math.max(8, Number(size) || 15));
      return `<span style="font-size:${fontSize}px">${content}</span>`;
    })
    .replace(/\[color=(#[0-9a-fA-F]{3,8}|[a-z]+)\]([\s\S]+?)\[\/color\]/g, (_match, color, content) => {
      return `<span style="color:${color}">${content}</span>`;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function plainInline(value: string) {
  return value
    .replace(/\[size=\d{1,3}\]([\s\S]+?)\[\/size\]/g, "$1")
    .replace(/\[color=[^\]]+\]([\s\S]+?)\[\/color\]/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1");
}

function textFromHtml(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function encodeBlocks(blocks: EmailBlock[]) {
  try {
    return btoa(encodeURIComponent(JSON.stringify(blocks)));
  } catch {
    return "";
  }
}

function decodeBlocks(html?: string | null): EmailBlock[] | null {
  if (!html) return null;
  const match = html.match(/<!--founder_erp-email-blocks:([^>]+)-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(match[1]))) as EmailBlock[];
    const validTypes: BlockType[] = ["heading", "text", "button", "callout", "divider", "image", "logo"];
    return parsed
      .filter((b) => validTypes.includes(b.type))
      .map((b) => ({ ...b, id: b.id || uid() }));
  } catch {
    return null;
  }
}

function fmtDate(iso: string | null, short = false) {
  if (!iso) return "Unscheduled";
  try {
    const opts: Intl.DateTimeFormatOptions = short
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" };
    return new Date(iso).toLocaleDateString(undefined, opts);
  } catch { return iso; }
}

function toLocalDT(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ""; }
}

function defaultBlocks(seed?: { body?: string; body_html?: string | null }, brand?: BrandSettings): EmailBlock[] {
  const saved = decodeBlocks(seed?.body_html);
  if (saved?.length) return saved;
  const text = seed?.body || (seed?.body_html ? textFromHtml(seed.body_html) : "");
  if (text) return [{ id: uid(), type: "text", fieldName: "Body copy", text, align: "left" }];
  const b = brand ?? DEFAULT_BRAND;
  const logo: EmailBlock[] = b.logo_url
    ? [{ id: uid(), type: "logo", fieldName: "Logo", text: "", url: b.logo_url, alt: b.business_name ?? "Logo", width: 160, radius: 0, align: "center" }]
    : [];
  return [
    ...logo,
    { id: uid(), type: "heading", fieldName: "Hero headline", text: "Your headline", align: "center", fontFamily: b.font_family, fontSize: b.heading_size, color: b.heading_color },
    { id: uid(), type: "text", fieldName: "Intro copy", text: "Write a concise update for your audience.", align: "left", fontFamily: b.font_family, fontSize: b.font_size, color: b.text_color },
    { id: uid(), type: "button", fieldName: "Primary CTA", text: "Learn more", url: "https://example.com", align: "center", fontFamily: b.font_family, fontSize: b.font_size, backgroundColor: b.button_color, color: b.button_text_color },
  ];
}

function applyBrandDefaults(block: EmailBlock, brand: BrandSettings): EmailBlock {
  const b = { ...block };
  if (!b.fontFamily) b.fontFamily = brand.font_family;
  if (!b.color) {
    b.color = b.type === "heading" ? brand.heading_color
      : b.type === "button" ? brand.button_text_color
      : brand.text_color;
  }
  if (!b.backgroundColor && b.type === "button") b.backgroundColor = brand.button_color;
  if (!b.fontSize) b.fontSize = b.type === "heading" ? brand.heading_size : brand.font_size;
  return b;
}

const FONT_OPTIONS = [
  { label: "Inter", value: "Inter, Arial, sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Helvetica", value: "Helvetica, Arial, sans-serif" },
  { label: "Times", value: "'Times New Roman', Times, serif" },
  { label: "Verdana", value: "Verdana, sans-serif" },
];

const FONT_WEIGHT_OPTIONS: { label: string; value: EmailBlock["fontWeight"] }[] = [
  { label: "Regular", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Semibold", value: "600" },
  { label: "Bold", value: "700" },
];

const COLOR_SWATCHES = ["#111827", "#374151", "#ffffff", "#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b"];
const BACKGROUND_SWATCHES = ["#ffffff", "#f3f4f6", "#eff6ff", "#ecfdf5", "#fef3c7", "#fdf2f8", "#111827", "#2563eb"];
const EMAIL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
const BLOCK_TYPES: BlockType[] = ["heading", "text", "button", "image", "logo", "callout", "divider"];

// Tiptap extension: sets font-size via textStyle mark
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => (el as HTMLElement).style.fontSize?.replace("px", "") || null,
          renderHTML: (attrs) => attrs.fontSize ? { style: `font-size:${attrs.fontSize}px` } : {},
        },
      },
    }];
  },
});

// Convert old custom markup (**bold**, *italic*, [size=N]…[/size], [color=…]…[/color]) to Tiptap HTML.
// If the value already looks like HTML, pass it through unchanged.
function markupToHtml(text: string): string {
  if (!text) return "<p></p>";
  if (/<[a-z][\s\S]*?>/i.test(text)) return text;
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\[size=(\d{1,3})\]([\s\S]+?)\[\/size\]/g, (_, size, c) => `<span style="font-size:${size}px">${c}</span>`)
    .replace(/\[color=(#[0-9a-fA-F]{3,8}|[a-z]+)\]([\s\S]+?)\[\/color\]/g, (_, col, c) => `<span style="color:${col}">${c}</span>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
  return escaped.split("\n").map((line) => `<p>${line || "<br>"}</p>`).join("");
}

// Produce email-safe HTML from Tiptap HTML output for a block.
// Injects inline styles on <p> tags; keeps bold/italic/color/size spans intact.
function tiptapToEmailHtml(html: string, opts: {
  color: string; fontFamily: string; fontSize: number; lineHeight: number; textAlign: string; fontWeight?: string;
}): string {
  if (!html || html === "<p></p>") return "";
  const { color, fontFamily, fontSize, lineHeight, textAlign, fontWeight = "400" } = opts;
  const pStyle = `margin:0 0 16px;font-size:${fontSize}px;line-height:${lineHeight};color:${color};text-align:${textAlign};font-weight:${fontWeight};font-family:${fontFamily}`;
  return html
    .replace(/<p style="text-align:\s*([\w-]+)">/g, (_, ta) =>
      `<p style="margin:0 0 16px;font-size:${fontSize}px;line-height:${lineHeight};color:${color};text-align:${ta};font-weight:${fontWeight};font-family:${fontFamily}">`)
    .replace(/<p>/g, `<p style="${pStyle}">`)
    .replace(/<ul>/g, `<ul style="margin:0 0 16px;padding-left:24px;${pStyle}">`)
    .replace(/<ol>/g, `<ol style="margin:0 0 16px;padding-left:24px;${pStyle}">`)
    .replace(/<li>/g, `<li style="margin:0 0 4px">`);
}

// Strip all HTML tags to get plain text.
function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
const SELECT_CLASS = "appearance-none rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20fill=%22none%22%20viewBox=%220%200%2024%2024%22%20stroke=%22%23999%22%20stroke-width=%222%22%3E%3Cpath%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%20d=%22M6%209l6%206%206-6%22/%3E%3C/svg%3E')] bg-no-repeat bg-[right_0.65rem_center] bg-[length:0.85rem] px-3 py-2 pr-9 text-sm text-gray-800 dark:text-gray-100 shadow-sm outline-none transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const SELECT_CLASS_SM = `${SELECT_CLASS} py-1.5 text-xs`;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function blockStyle(b: EmailBlock) {
  return {
    align: b.align ?? "left",
    color: b.color,
    backgroundColor: b.backgroundColor,
    accentColor: b.accentColor,
    fontFamily: b.fontFamily || EMAIL_FONT,
    radius: b.radius ?? 8,
  };
}

const EMAIL_FONT = "Arial, Helvetica, sans-serif";

function renderBlocks(blocks: EmailBlock[]) {
  const wrapBlock = (b: EmailBlock, html: string) => {
    const offset = clamp(b.blockOffset ?? 0, 0, 70);
    const width = clamp(b.blockWidth ?? 100, 30, 100 - offset);
    const minH = b.blockMinHeight ? clamp(b.blockMinHeight, 4, 700) : 0;
    const minHeight = minH ? `min-height:${minH}px;` : "";
    const mbottom = b.blockSpacing !== undefined ? `margin-bottom:${b.blockSpacing}px;` : "";
    const margin = offset ? `0 0 0 ${offset}%` : width < 100 && (b.align ?? "left") === "center" ? "0 auto" : "0";
    const vAlign = minH && b.verticalAlign && b.verticalAlign !== "top"
      ? `display:flex;flex-direction:column;justify-content:${b.verticalAlign === "center" ? "center" : "flex-end"};`
      : "";
    return `<div style="width:${width}%;max-width:100%;margin:${margin};${minHeight}${mbottom}${vAlign}">${html}</div>`;
  };
  const renderBlock = (b: EmailBlock) => {
    const style = blockStyle(b);
    const align = style.align;
    const isHtml = (b.text || "").includes("<");
    if (b.type === "image" || b.type === "logo") {
      const src = escapeHtml(b.url || "");
      if (!src) return "";
      const width = b.width ?? (b.type === "logo" ? 160 : 640);
      const radius = b.radius ?? (b.type === "logo" ? 0 : 10);
      const margin = b.type === "logo" ? "0 0 24px" : "22px 0";
      const imageSizing = b.type === "logo"
        ? `width:${width}px;max-width:100%`
        : `width:100%;max-width:${width}px`;
      return wrapBlock(b, `<div style="text-align:${align};margin:${margin}"><img src="${src}" alt="${escapeHtml(b.alt || b.text || "")}" width="${width}" style="display:inline-block;${imageSizing};height:auto;border:0;border-radius:${radius}px"></div>`);
    }
    if (b.type === "heading") {
      const size = b.fontSize ?? 28;
      const weight = b.fontWeight ?? "700";
      const innerHtml = isHtml
        ? b.text.replace(/<\/?p[^>]*>/g, " ").trim()
        : renderInline(b.text);
      const lh = b.lineHeight ?? 1.5;
      return wrapBlock(b, `<h1 style="margin:0 0 18px;font-size:${size}px;line-height:${lh};color:${style.color || "#111827"};text-align:${align};font-weight:${weight};font-family:${style.fontFamily}">${innerHtml}</h1>`);
    }
    if (b.type === "button") {
      const href = escapeHtml(b.url || "#");
      const size = b.fontSize ?? 15;
      const weight = b.fontWeight ?? "600";
      const label = isHtml ? htmlToPlain(b.text) || "Open" : (b.text || "Open");
      return wrapBlock(b, `<div style="text-align:${align};margin:24px 0"><a href="${href}" style="display:inline-block;background:${style.backgroundColor || "#2563eb"};color:${style.color || "#ffffff"};text-decoration:none;border-radius:${style.radius}px;padding:12px 18px;font-size:${size}px;font-weight:${weight};font-family:${style.fontFamily}">${escapeHtml(label)}</a></div>`);
    }
    if (b.type === "callout") {
      const size = b.fontSize ?? 15;
      const weight = b.fontWeight ?? "400";
      const lh = b.lineHeight ?? 1.5;
      const content = isHtml
        ? tiptapToEmailHtml(b.text, { color: style.color || "#1e3a8a", fontFamily: style.fontFamily, fontSize: size, lineHeight: lh, textAlign: align, fontWeight: weight })
        : renderInline(b.text).replace(/\n/g, "<br>");
      return wrapBlock(b, `<div style="border-left:4px solid ${style.accentColor || "#2563eb"};background:${style.backgroundColor || "#eff6ff"};border-radius:${style.radius}px;padding:14px 16px;margin:18px 0">${content}</div>`);
    }
    if (b.type === "divider") {
      return wrapBlock(b, `<hr style="border:0;border-top:1px solid ${style.accentColor || "#e5e7eb"};margin:24px 0">`);
    }
    // text block
    const size = b.fontSize ?? 15;
    const weight = b.fontWeight ?? "400";
    const lh = b.lineHeight ?? 1.5;
    return wrapBlock(b, isHtml
      ? tiptapToEmailHtml(b.text, { color: style.color || "#374151", fontFamily: style.fontFamily, fontSize: size, lineHeight: lh, textAlign: align, fontWeight: weight })
      : `<p style="margin:0 0 16px;font-size:${size}px;line-height:${lh};color:${style.color || "#374151"};text-align:${align};font-weight:${weight};font-family:${style.fontFamily}">${renderInline(b.text).replace(/\n/g, "<br>")}</p>`);
  };

  const rows: string[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const first = blocks[i];
    if (first.layout !== "half") {
      rows.push(renderBlock(first));
      continue;
    }

    const second = blocks[i + 1]?.layout === "half" ? blocks[i + 1] : null;
    const left = renderBlock(first);
    const right = second ? renderBlock(second) : "";
    rows.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px"><tr><td width="50%" style="vertical-align:top;padding-right:8px">${left}</td><td width="50%" style="vertical-align:top;padding-left:8px">${right}</td></tr></table>`);
    if (second) i += 1;
  }

  const inner = rows.join("");

  const metadata = encodeBlocks(blocks);
  const comment = metadata ? `<!--founder_erp-email-blocks:${metadata}-->` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Type" content="text/html;charset=UTF-8"></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:${EMAIL_FONT}"><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f4f6"><tr><td style="padding:28px 16px"><div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px;border:1px solid #e5e7eb;font-family:${EMAIL_FONT}">${inner}</div></td></tr></table>${comment}</body></html>`;
}

function blocksToPlain(blocks: EmailBlock[]) {
  return blocks.filter((b) => b.type !== "divider").map((b) => {
    const t = b.text || "";
    return t.includes("<") ? htmlToPlain(t) : plainInline(t);
  }).join("\n\n").trim();
}

function Badge({ value }: { value: CampaignStatus }) {
  const cls = STATUS_STYLE[value];
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded capitalize ${cls}`}>{value}</span>;
}

function ColorControl({
  label, value, swatches, onChange,
}: {
  label: string;
  value: string;
  swatches: string[];
  onChange: (value: string) => void;
}) {
  const [hexInput, setHexInput] = useState(value);
  useEffect(() => { setHexInput(value); }, [value]);

  function commitHex(raw: string) {
    const v = raw.trim();
    // Accept #rgb, #rrggbb, #rrggbbaa
    if (/^#([0-9a-fA-F]{3,8})$/.test(v)) onChange(v);
  }

  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <input type="color" value={value.length === 7 ? value : "#000000"} onChange={(e) => { onChange(e.target.value); setHexInput(e.target.value); }}
          className="h-7 w-7 shrink-0 rounded border border-gray-300 dark:border-gray-600 bg-transparent p-0.5 cursor-pointer" />
        <input
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commitHex(hexInput)}
          placeholder="#000000"
          className="w-20 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-1.5 py-0.5 text-[11px] font-mono text-gray-800 dark:text-gray-200 focus:border-blue-500 outline-none" />
        <div className="flex flex-wrap gap-0.5">
          {swatches.map((color) => (
            <button key={color} type="button" onClick={() => { onChange(color); setHexInput(color); }} title={color}
              className={`h-4 w-4 rounded-full border ${value === color ? "border-blue-600 ring-1 ring-blue-500/40" : "border-gray-300 dark:border-gray-600"}`}
              style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ComplianceCanvasFooter({
  businessName, businessAddress, onBusinessNameChange, onBusinessAddressChange,
}: {
  businessName: string;
  businessAddress: string;
  onBusinessNameChange: (value: string) => void;
  onBusinessAddressChange: (value: string) => void;
}) {
  const inputClass = "w-full rounded border border-transparent bg-transparent px-2 py-1 text-center outline-none hover:border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20";
  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-8 border-t border-gray-200 pt-4 text-center text-[11px] leading-5 text-gray-500">
      <input value={businessName} onChange={(e) => onBusinessNameChange(e.target.value)} placeholder="Business name"
        className={`${inputClass} mx-auto block max-w-[420px] font-medium text-gray-600`} />
      <AutoTextarea value={businessAddress} onChange={(e) => onBusinessAddressChange(e.target.value)} rows={2} placeholder="Postal address"
        className={`${inputClass} mx-auto mt-1 block max-w-[420px] resize-none whitespace-pre-wrap`} />
      <p className="mt-2 text-blue-600 underline">Unsubscribe</p>
    </div>
  );
}

function publicAssetUrl(id: string) {
  const path = `/api/proxy/marketing/brand-assets/${id}/public`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// Module-level component — must NOT be defined inside EmailBuilder or it remounts on every render.
function RichTextBlock({ block, active, brand, activeEditorRef, onTextChange }: {
  block: EmailBlock;
  active: boolean;
  brand: BrandSettings;
  activeEditorRef: React.MutableRefObject<Editor | null>;
  onTextChange: (html: string) => void;
}) {
  const baseSize = block.fontSize ?? (block.type === "heading" ? brand.heading_size : brand.font_size);
  const colorSwatches = brand.brand_colors.length ? brand.brand_colors : COLOR_SWATCHES;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Underline,
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({ types: ["paragraph"] }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
    ],
    content: markupToHtml(block.text),
    editable: true,
    onUpdate: ({ editor: ed }) => { onTextChange(ed.getHTML()); },
  });

  useEffect(() => {
    if (active) activeEditorRef.current = editor ?? null;
    return () => { if (active) activeEditorRef.current = null; };
  }, [active, editor, activeEditorRef]);

  const lastExternal = useRef(block.text);
  useEffect(() => {
    if (!editor || block.text === lastExternal.current) return;
    lastExternal.current = block.text;
    const html = markupToHtml(block.text);
    if (editor.getHTML() !== html) editor.commands.setContent(html, false);
  }, [block.text, editor]);

  const btnBase = "h-7 w-7 rounded text-xs flex items-center justify-center transition-colors";
  const btnA = "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  const btnI = "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700";

  const toolbar = editor && (
    <div className="flex flex-wrap items-center gap-0.5 rounded-lg border border-gray-200 bg-white p-1 shadow-md dark:border-gray-700 dark:bg-gray-900">
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
        className={`${btnBase} font-bold ${editor.isActive("bold") ? btnA : btnI}`} title="Bold (Ctrl+B)">B</button>
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
        className={`${btnBase} italic ${editor.isActive("italic") ? btnA : btnI}`} title="Italic (Ctrl+I)">I</button>
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }}
        className={`${btnBase} underline ${editor.isActive("underline") ? btnA : btnI}`} title="Underline (Ctrl+U)">U</button>
      <button type="button" onMouseDown={(e) => {
        e.preventDefault();
        if (editor.isActive("link")) {
          editor.chain().focus().unsetLink().run();
        } else {
          const url = window.prompt("Link URL:", "https://");
          if (url) editor.chain().focus().setLink({ href: url }).run();
        }
      }} className={`${btnBase} ${editor.isActive("link") ? btnA : btnI}`} title="Add / remove link">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      </button>
      <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
        className={`${btnBase} ${editor.isActive("bulletList") ? btnA : btnI}`} title="Bullet list">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>
      </button>
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }}
        className={`${btnBase} ${editor.isActive("orderedList") ? btnA : btnI}`} title="Numbered list">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="1" y="8" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">1.</text><text x="1" y="14" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">2.</text><text x="1" y="20" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">3.</text></svg>
      </button>
      <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
      <input type="color" defaultValue={editor.getAttributes("textStyle").color || "#000000"}
        onInput={(e) => { editor.chain().focus().setColor((e.target as HTMLInputElement).value).run(); }}
        className="h-6 w-6 cursor-pointer rounded border border-gray-300 dark:border-gray-600 p-0.5 bg-transparent" title="Text color" />
      {colorSwatches.slice(0, 6).map((color) => (
        <button key={color} type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().setColor(color).run(); }}
          className="h-5 w-5 rounded-full border-2 border-white shadow-sm dark:border-gray-800 flex-shrink-0"
          style={{ backgroundColor: color }} title={color} />
      ))}
      <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
      <button type="button" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().unsetAllMarks().run(); }}
        className={`${btnBase} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`} title="Clear formatting">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 20h9M4.93 4.93l14.14 14.14M9 15l-4 5M19 5 9 15"/></svg>
      </button>
    </div>
  );

  return (
    <div>
      {editor && (
        <BubbleMenu editor={editor} tippyOptions={{ duration: 80, placement: "top-start" }}>
          {toolbar}
        </BubbleMenu>
      )}
      <EditorContent editor={editor}
        className="prose-sm max-w-none [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:my-0"
        style={{
          color: block.color || (block.type === "heading" ? (brand.heading_color || "#111827") : (brand.text_color || "#374151")),
          fontFamily: block.fontFamily || brand.font_family,
          fontSize: baseSize,
          lineHeight: block.lineHeight ?? 1.5,
          textAlign: (block.align ?? "left") as React.CSSProperties["textAlign"],
          fontWeight: block.fontWeight ?? (block.type === "heading" ? "700" : "400"),
        }} />
    </div>
  );
}

function EmailBuilder({
  blocks, onChange, footerPreview, brand = DEFAULT_BRAND,
}: {
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
  footerPreview?: React.ReactNode;
  brand?: BrandSettings;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<Record<string, string>>({});
  const [activeId, setActiveId] = useState<string | null>(blocks[0]?.id ?? null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const historyRef = useRef<EmailBlock[][]>([]);
  const activeEditorRef = useRef<Editor | null>(null);

  useEffect(() => {
    setActiveId((current) => {
      if (!blocks.length) return null;
      if (current && !blocks.some((b) => b.id === current)) return blocks[0].id;
      return current;
    });
  }, [blocks]);

  // Push current blocks to undo history, then call onChange.
  // Pass structural=false for plain text edits (browser handles those natively).
  function commit(newBlocks: EmailBlock[], structural = true) {
    if (structural) {
      historyRef.current = [...historyRef.current.slice(-29), blocks];
    }
    onChange(newBlocks);
  }

  useEffect(() => {
    function handleUndo(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "z") return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      // Let textarea/input and Tiptap editors handle their own undo
      if (tag === "TEXTAREA" || tag === "INPUT" || target?.closest?.(".ProseMirror")) return;
      e.preventDefault();
      const prev = historyRef.current.pop();
      if (prev) onChange(prev);
    }
    document.addEventListener("keydown", handleUndo);
    return () => document.removeEventListener("keydown", handleUndo);
  }, [onChange]);

  function update(id: string, patch: Partial<EmailBlock>) {
    const isTextOnly = Object.keys(patch).length === 1 && "text" in patch;
    commit(blocks.map((b) => b.id === id ? { ...b, ...patch } : b), !isTextOnly);
  }
  function moveBlock(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const sourceIndex = blocks.findIndex((b) => b.id === sourceId);
    const targetIndex = blocks.findIndex((b) => b.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...blocks];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    commit(next);
  }
  function placeBlockBeside(sourceId: string, targetId: string, side: "left" | "right") {
    if (sourceId === targetId) return;
    const source = blocks.find((b) => b.id === sourceId);
    const target = blocks.find((b) => b.id === targetId);
    if (!source || !target) return;
    const paired = blocks.filter((b) => b.id !== sourceId && b.id !== targetId);
    const targetIndex = paired.findIndex((b) => b.id === targetId);
    const sourceBlock = { ...source, layout: "half" as const, blockWidth: source.blockWidth ?? 50 };
    const targetBlock = { ...target, layout: "half" as const, blockWidth: target.blockWidth ?? 50 };
    const pair = side === "left" ? [sourceBlock, targetBlock] : [targetBlock, sourceBlock];
    paired.splice(targetIndex < 0 ? paired.length : targetIndex, 0, ...pair);
    commit(paired);
  }
  function startResize(e: React.PointerEvent<HTMLElement>, b: EmailBlock, edge: "left" | "right" | "top" | "bottom" | "topLeft" | "topRight" | "bottomLeft" | "bottomRight") {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const blockEl = e.currentTarget.closest("[data-email-block]") as HTMLElement | null;
    const parentEl = blockEl?.parentElement;
    if (!blockEl || !parentEl) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = blockEl.getBoundingClientRect();
    const parentWidth = parentEl.getBoundingClientRect().width || startRect.width;
    const startHeight = b.blockMinHeight ?? startRect.height;
    const startOffset = clamp(b.blockOffset ?? 0, 0, 70);
    const startWidthPct = clamp(b.blockWidth ?? 100, 30, 100 - startOffset);
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    function onMove(moveEvent: PointerEvent) {
      const dxPct = ((moveEvent.clientX - startX) / parentWidth) * 100;
      const dy = moveEvent.clientY - startY;
      const patch: Partial<EmailBlock> = {};
      const affectsLeft = edge === "left" || edge === "topLeft" || edge === "bottomLeft";
      const affectsRight = edge === "right" || edge === "topRight" || edge === "bottomRight";
      const affectsTop = edge === "top" || edge === "topLeft" || edge === "topRight";
      const affectsBottom = edge === "bottom" || edge === "bottomLeft" || edge === "bottomRight";

      if (affectsLeft) {
        const nextOffset = clamp(startOffset + dxPct, 0, startOffset + startWidthPct - 30);
        patch.blockOffset = Math.round(nextOffset);
        patch.blockWidth = Math.round(clamp(startWidthPct - (nextOffset - startOffset), 30, 100 - nextOffset));
      } else if (affectsRight) {
        patch.blockWidth = Math.round(clamp(startWidthPct + dxPct, 30, 100 - startOffset));
      }
      if (affectsTop) patch.blockMinHeight = Math.round(clamp(startHeight - dy, 4, 700));
      else if (affectsBottom) patch.blockMinHeight = Math.round(clamp(startHeight + dy, 4, 700));

      update(b.id, patch);
    }
    function onUp() {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  async function uploadImage(id: string, type: BlockType, file: File | null) {
    if (!file) return;
    if (!EMAIL_IMAGE_TYPES.has(file.type)) {
      setUploadError((prev) => ({ ...prev, [id]: "Use PNG, JPG, GIF, WebP, or SVG for email images" }));
      return;
    }
    setUploading(id);
    setUploadError((prev) => ({ ...prev, [id]: "" }));
    try {
      const form = new FormData();
      form.append("category", type === "logo" ? "logo" : "icons");
      form.append("file", file);
      const r = await fetch("/api/proxy/marketing/brand-assets/upload", { method: "POST", body: form });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(typeof err.detail === "string" ? err.detail : "Upload failed");
      }
      const asset = await r.json();
      update(id, {
        url: publicAssetUrl(asset.id),
        alt: blocks.find((b) => b.id === id)?.alt || file.name.replace(/\.[^.]+$/, ""),
      });
    } catch (err: unknown) {
      setUploadError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : "Upload failed" }));
    } finally {
      setUploading(null);
    }
  }
  function add(type: BlockType) {
    const base: Record<BlockType, EmailBlock> = {
      heading: { id: uid(), type, fieldName: "Headline", text: "New headline", align: "center" },
      text: { id: uid(), type, fieldName: "Text block", text: "Add a paragraph.", align: "left" },
      button: { id: uid(), type, fieldName: "Button", text: "Call to action", url: "https://example.com", align: "center" },
      callout: { id: uid(), type, fieldName: "Callout", text: "Add a highlighted note.", align: "left" },
      divider: { id: uid(), type, fieldName: "Divider", text: "" },
      image: { id: uid(), type, fieldName: "Image", text: "", url: "", alt: "", width: 640, radius: 10, align: "center" },
      logo: { id: uid(), type, fieldName: "Logo", text: "", url: brand.logo_url ?? "", alt: brand.business_name ?? "Logo", width: 160, radius: 0, align: "center" },
    };
    commit([...blocks, applyBrandDefaults(base[type], brand)]);
  }
  function AddBlockControl() {
    const labels: Record<BlockType, string> = {
      heading: "H", text: "¶", button: "Btn", image: "Img", logo: "Logo", callout: "Note", divider: "—",
    };
    return (
      <div className="pt-1">
        <p className="mb-1.5 text-[10px] font-semibold uppercase text-gray-400">Add block</p>
        <div className="flex flex-wrap gap-1">
          {BLOCK_TYPES.map((type) => (
            <button key={type} type="button" onClick={() => add(type)}
              className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-blue-500 dark:hover:bg-blue-950/30 dark:hover:text-blue-300 transition-colors">
              {labels[type]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderBlockSettings(b: EmailBlock) {
    return (
      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-gray-500" title="Label shown in the block list sidebar">Block label</label>
          <input value={b.fieldName ?? ""} onChange={(e) => update(b.id, { fieldName: e.target.value })} placeholder={b.type}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
        </div>
        {(b.type === "image" || b.type === "logo") && (
          <div className="grid grid-cols-1 gap-2">
            <label className="flex cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200">
              <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadImage(b.id, b.type, e.target.files?.[0] ?? null)} />
              {uploading === b.id ? "Uploading..." : b.url ? "Replace image" : `Upload ${b.type}`}
            </label>
            {uploadError[b.id] && <p className="text-xs text-red-500">{uploadError[b.id]}</p>}
            <div className="grid grid-cols-2 gap-2">
              <input value={b.alt ?? ""} onChange={(e) => update(b.id, { alt: e.target.value })} placeholder="Alt text"
                className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
              <div className="flex items-center gap-1">
                <input type="number" min={40} max={640} value={b.width ?? (b.type === "logo" ? 160 : 640)} onChange={(e) => update(b.id, { width: Number(e.target.value) || undefined })} placeholder="Width"
                  className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                <span className="shrink-0 text-[11px] text-gray-400">px</span>
              </div>
            </div>
          </div>
        )}
        {b.type !== "divider" && (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">Horizontal align</label>
              <div className="flex flex-wrap gap-1">
                {(["left", "center"] as const).map((align) => (
                  <button key={align} type="button" onClick={() => update(b.id, { align })}
                    className={`rounded px-2 py-1 text-xs capitalize ${b.align === align ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}>
                    {align}
                  </button>
                ))}
              </div>
            </div>
            {b.blockMinHeight && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-gray-500">Vertical align</label>
                <div className="flex flex-wrap gap-1">
                  {(["top", "center", "bottom"] as const).map((va) => (
                    <button key={va} type="button" onClick={() => update(b.id, { verticalAlign: va })}
                      className={`rounded px-2 py-1 text-xs capitalize ${(b.verticalAlign ?? "top") === va ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}>
                      {va}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {b.type !== "divider" && b.type !== "image" && b.type !== "logo" && (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-gray-500">Font</label>
                <select value={b.fontFamily || "Inter, Arial, sans-serif"} onChange={(e) => update(b.id, { fontFamily: e.target.value })}
                  className={`w-full ${SELECT_CLASS_SM}`}>
                  {FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-gray-500">Weight</label>
                <select value={b.fontWeight ?? "400"} onChange={(e) => update(b.id, { fontWeight: e.target.value as EmailBlock["fontWeight"] })}
                  className={`w-full ${SELECT_CLASS_SM}`}>
                  {FONT_WEIGHT_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-gray-500">Block font size</label>
                <div className="flex items-center gap-1">
                  <input type="number" min={8} max={72} value={b.fontSize ?? (b.type === "heading" ? 28 : 15)}
                    onChange={(e) => update(b.id, { fontSize: Number(e.target.value) || undefined })}
                    className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                  <span className="shrink-0 text-[11px] text-gray-400">px</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">Line spacing</label>
                  <select value={b.lineHeight ?? 1.5}
                    onChange={(e) => update(b.id, { lineHeight: Number(e.target.value) })}
                    className={`w-full ${SELECT_CLASS_SM}`}>
                    <option value={1}>Tight (1×)</option>
                    <option value={1.2}>Compact (1.2×)</option>
                    <option value={1.5}>Normal (1.5×)</option>
                    <option value={1.7}>Relaxed (1.7×)</option>
                    <option value={2}>Loose (2×)</option>
                    <option value={2.5}>Extra loose (2.5×)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">Block spacing</label>
                  <select value={b.blockSpacing ?? 16}
                    onChange={(e) => update(b.id, { blockSpacing: Number(e.target.value) })}
                    className={`w-full ${SELECT_CLASS_SM}`}>
                    <option value={0}>None</option>
                    <option value={8}>XS (8px)</option>
                    <option value={16}>Normal (16px)</option>
                    <option value={24}>Large (24px)</option>
                    <option value={40}>XL (40px)</option>
                    <option value={64}>2XL (64px)</option>
                  </select>
                </div>
              </div>
              {(b.type === "heading" || b.type === "text" || b.type === "callout") && (
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">Selected text size</label>
                  <div className="flex items-center gap-1">
                    <input type="number" min={8} max={72} placeholder="—"
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (!val || !activeEditorRef.current) return;
                        activeEditorRef.current.chain().focus().setMark("textStyle", { fontSize: String(val) }).run();
                      }}
                      className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                    <span className="shrink-0 text-[11px] text-gray-400">px</span>
                  </div>
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); activeEditorRef.current?.chain().focus().unsetMark("textStyle").run(); }}
                    className="mt-1 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                    Clear size
                  </button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {(() => {
                const colorSwatches = brand.brand_colors.length ? brand.brand_colors : COLOR_SWATCHES;
                const bgSwatches = brand.brand_colors.length ? brand.brand_colors : BACKGROUND_SWATCHES;
                return (<>
                  <ColorControl label="Text color" value={b.color ?? (b.type === "button" ? brand.button_text_color : b.type === "callout" ? "#1e3a8a" : b.type === "heading" ? brand.heading_color : brand.text_color)} swatches={colorSwatches} onChange={(color) => update(b.id, { color })} />
                  {(b.type === "button" || b.type === "callout") && (
                    <ColorControl label="Background" value={b.backgroundColor ?? (b.type === "button" ? brand.button_color : "#eff6ff")} swatches={bgSwatches} onChange={(backgroundColor) => update(b.id, { backgroundColor })} />
                  )}
                  {b.type === "callout" && (
                    <ColorControl label="Accent" value={b.accentColor ?? brand.button_color} swatches={colorSwatches} onChange={(accentColor) => update(b.id, { accentColor })} />
                  )}
                </>);
              })()}
            </div>
          </>
        )}
        {(b.type === "button" || b.type === "callout" || b.type === "image" || b.type === "logo") && (
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-500">Corner radius</label>
            <input type="range" min={0} max={24} value={b.radius ?? 8} onChange={(e) => update(b.id, { radius: Number(e.target.value) })}
              className="w-full accent-blue-600" />
          </div>
        )}
        {b.type === "divider" && (
          <ColorControl label="Line color" value={b.accentColor ?? "#e5e7eb"} swatches={COLOR_SWATCHES} onChange={(accentColor) => update(b.id, { accentColor })} />
        )}
      </div>
    );
  }

  function renderEditableBlock(b: EmailBlock) {
    const selected = activeId === b.id;
    const style = blockStyle(b);
    const textAlign = style.align;
    const fontFamily = style.fontFamily;
    const shellClass = `group relative rounded-lg border p-3 transition-colors ${selected ? "border-blue-500 bg-blue-50/30 ring-2 ring-blue-500/15 dark:bg-blue-950/10" : "border-transparent hover:border-gray-200 dark:hover:border-gray-700"}`;
    const blockOffset = clamp(b.blockOffset ?? 0, 0, 70);
    const blockWidth = clamp(b.blockWidth ?? 100, 30, 100 - blockOffset);
    const minH = b.blockMinHeight ? clamp(b.blockMinHeight, 4, 700) : undefined;
    const blockSizingStyle: React.CSSProperties = b.layout === "half" ? {
      // In a side-by-side row use flex-basis so the gap doesn't cause overflow
      flex: `1 1 ${blockWidth}%`,
      minWidth: 0,
      maxWidth: "100%",
      minHeight: minH,
      marginBottom: b.blockSpacing !== undefined ? b.blockSpacing : undefined,
      ...(minH && b.verticalAlign && b.verticalAlign !== "top" ? {
        display: "flex",
        flexDirection: "column",
        justifyContent: b.verticalAlign === "center" ? "center" : "flex-end",
      } : {}),
    } : {
      width: `${blockWidth}%`,
      maxWidth: "100%",
      minHeight: minH,
      marginBottom: b.blockSpacing !== undefined ? b.blockSpacing : undefined,
      ...(minH && b.verticalAlign && b.verticalAlign !== "top" ? {
        display: "flex",
        flexDirection: "column",
        justifyContent: b.verticalAlign === "center" ? "center" : "flex-end",
      } : {}),
      marginLeft: blockOffset ? `${blockOffset}%` : blockWidth < 100 && textAlign === "center" ? "auto" : undefined,
      marginRight: !blockOffset && blockWidth < 100 && textAlign === "center" ? "auto" : undefined,
    };

    return (
      <div key={b.id} data-email-block onClick={(e) => { e.stopPropagation(); setActiveId(b.id); }}
        onFocusCapture={() => setActiveId(b.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (draggingId) {
            const rect = e.currentTarget.getBoundingClientRect();
            placeBlockBeside(draggingId, b.id, e.clientX < rect.left + rect.width / 2 ? "left" : "right");
          }
          setDraggingId(null);
        }}
        className={shellClass}
        style={blockSizingStyle}>
        {/* Block controls — compact cluster in top-right corner, only on hover */}
        <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto">
          <span draggable
            onDragStart={(e) => { e.stopPropagation(); setDraggingId(b.id); }}
            onDragEnd={(e) => { e.stopPropagation(); setDraggingId(null); }}
            className="cursor-grab rounded p-1 text-gray-400 bg-white/90 dark:bg-gray-900/90 shadow-sm hover:bg-gray-50 hover:text-gray-600 active:cursor-grabbing dark:hover:bg-gray-800 dark:hover:text-gray-300"
            title="Drag to reorder">
            <svg width="8" height="14" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
              <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
              <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
            </svg>
          </span>
          <button type="button" onClick={(e) => {
            e.stopPropagation();
            const idx = blocks.findIndex((x) => x.id === b.id);
            const dup = { ...b, id: uid() };
            const next = [...blocks];
            next.splice(idx + 1, 0, dup);
            commit(next);
            setActiveId(dup.id);
          }} className="rounded p-1 text-[11px] text-gray-500 bg-white/90 dark:bg-gray-900/90 shadow-sm hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800" title="Duplicate">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); commit(blocks.filter((x) => x.id !== b.id)); }}
            className="rounded p-1 text-red-400 bg-white/90 dark:bg-gray-900/90 shadow-sm hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20" title="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <>
          {(b.type === "image" || b.type === "logo") && (
            <div className="space-y-2" style={{ textAlign }}>
              {b.url ? (
                <img src={b.url} alt={b.alt || ""} width={b.width ?? (b.type === "logo" ? 160 : 640)}
                  className="inline-block h-auto max-w-full"
                  style={{ borderRadius: b.radius ?? (b.type === "logo" ? 0 : 10), width: b.type === "logo" ? b.width ?? 160 : "100%", maxWidth: b.width ?? 640 }} />
              ) : (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-10 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-900">No image uploaded</div>
              )}
            </div>
          )}
          {(b.type === "heading" || b.type === "text" || b.type === "callout") && (
            <div className={b.type === "callout" ? "border-l-4 px-4 py-3" : undefined}
              style={b.type === "callout" ? { borderLeftColor: b.accentColor || "#2563eb", backgroundColor: b.backgroundColor || "#eff6ff", borderRadius: b.radius ?? 8 } : undefined}>
              <RichTextBlock block={b} active={selected} brand={brand} activeEditorRef={activeEditorRef}
                onTextChange={(html) => update(b.id, { text: html })} />
            </div>
          )}
          {b.type === "button" && (
            <div className="space-y-2" style={{ textAlign }}>
              <input value={b.text} onChange={(e) => update(b.id, { text: e.target.value })} placeholder="Button text"
                className="inline-block rounded border-0 px-4 py-3 text-center font-semibold outline-none ring-2 ring-transparent focus:ring-blue-500/30"
                style={{ backgroundColor: b.backgroundColor || brand.button_color, color: b.color || brand.button_text_color, borderRadius: b.radius ?? 8, fontFamily, fontSize: b.fontSize ?? 15 }} />
              <input value={b.url ?? ""} onChange={(e) => update(b.id, { url: e.target.value })} placeholder="https://..."
                className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300" />
            </div>
          )}
          {b.type === "divider" && (
            <hr style={{ border: 0, borderTop: `1px solid ${b.accentColor || "#e5e7eb"}`, margin: "12px 0" }} />
          )}
        </>
        <>
          <div role="button" tabIndex={0} onPointerDown={(e) => startResize(e, b, "left")}
            className="absolute -left-2 bottom-2 top-2 z-20 hidden w-4 cursor-ew-resize touch-none items-center justify-center group-hover:flex"
            aria-label="Resize block from left" title="Drag to resize">
            <div className="h-8 w-px max-h-full rounded bg-blue-400/60" />
          </div>
          <div role="button" tabIndex={0} onPointerDown={(e) => startResize(e, b, "right")}
            className="absolute -right-2 bottom-2 top-2 z-20 hidden w-4 cursor-ew-resize touch-none items-center justify-center group-hover:flex"
            aria-label="Resize block from right" title="Drag to resize">
            <div className="h-8 w-px max-h-full rounded bg-blue-400/60" />
          </div>
          <div role="button" tabIndex={0} onPointerDown={(e) => startResize(e, b, "top")}
            className="absolute -top-2 left-4 right-4 z-20 hidden h-4 cursor-ns-resize touch-none items-center justify-center group-hover:flex"
            aria-label="Resize block from top" title="Drag to resize">
            <div className="h-px w-8 rounded bg-blue-400/60" />
          </div>
          <div role="button" tabIndex={0} onPointerDown={(e) => startResize(e, b, "bottom")}
            className="absolute -bottom-2 left-4 right-4 z-20 hidden h-4 cursor-ns-resize touch-none items-center justify-center group-hover:flex"
            aria-label="Resize block from bottom" title="Drag to resize">
            <div className="h-px w-8 rounded bg-blue-400/60" />
          </div>
          {[
            ["topLeft", "-left-1.5 -top-1.5 cursor-nwse-resize"],
            ["topRight", "-right-1.5 -top-1.5 cursor-nesw-resize"],
            ["bottomLeft", "-bottom-1.5 -left-1.5 cursor-nesw-resize"],
            ["bottomRight", "-bottom-1.5 -right-1.5 cursor-nwse-resize"],
          ].map(([edgeName, pos]) => (
            <div key={edgeName} role="button" tabIndex={0} onPointerDown={(e) => startResize(e, b, edgeName as "topLeft" | "topRight" | "bottomLeft" | "bottomRight")}
              className={`absolute z-30 hidden h-2.5 w-2.5 touch-none rounded-sm bg-blue-500 shadow-sm group-hover:block ${pos}`}
              aria-label="Resize block" title="Drag corner to resize" />
          ))}
        </>
      </div>
    );
  }

  function renderCanvasRows() {
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const first = blocks[i];
      if (first.layout !== "half") {
        rows.push(renderEditableBlock(first));
        continue;
      }
      const second = blocks[i + 1]?.layout === "half" ? blocks[i + 1] : null;
      // Normalise: half-layout blocks that were created before explicit blockWidth was set
      // had their width enforced by CSS grid — default them to 50 so flex respects it.
      const norm = (b: EmailBlock) => b.blockWidth !== undefined ? b : { ...b, blockWidth: 50 };
      rows.push(
        <div key={`${first.id}-${second?.id ?? "empty"}`} className="flex items-start gap-3 min-w-0 overflow-hidden">
          {renderEditableBlock(norm(first))}
          {second ? renderEditableBlock(norm(second)) : <div className="flex-1 self-stretch rounded-lg border border-dashed border-gray-200 dark:border-gray-800" />}
        </div>
      );
      if (second) i += 1;
    }
    return rows;
  }
  const activeBlock = blocks.find((b) => b.id === activeId) ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[220px_minmax(620px,1fr)]">
      <aside className="min-w-0 self-start sticky top-3 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900 space-y-3">
        {activeBlock && (
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase text-gray-400">Block settings</p>
            {renderBlockSettings(activeBlock)}
          </div>
        )}
        <div className={`space-y-2${activeBlock ? " border-t border-gray-100 dark:border-gray-800 pt-3" : ""}`}>
          {blocks.map((b) => (
            <button key={b.id} type="button" draggable
              onClick={() => setActiveId(b.id)}
              onDragStart={() => setDraggingId(b.id)}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingId) moveBlock(draggingId, b.id);
                setDraggingId(null);
              }}
              className={`flex w-full cursor-grab items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors ${activeId === b.id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-200 bg-gray-50 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-950 dark:hover:border-gray-600"}`}>
              <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" className="shrink-0 text-gray-400" aria-hidden="true">
                <circle cx="3" cy="3" r="1.5"/><circle cx="7" cy="3" r="1.5"/>
                <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
                <circle cx="3" cy="13" r="1.5"/><circle cx="7" cy="13" r="1.5"/>
              </svg>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-gray-700 dark:text-gray-200">{b.fieldName || b.type}</span>
                <span className="block text-[10px] font-semibold uppercase text-gray-400">{b.type}</span>
              </span>
            </button>
          ))}
        </div>
        <AddBlockControl />
      </aside>
      <section onClick={() => setActiveId(null)} className="min-w-0 rounded-xl border border-gray-200 bg-gray-100 p-3 dark:border-gray-700 dark:bg-gray-950">
        <div className="mx-auto min-h-[760px] max-w-[760px] space-y-3 rounded-[14px] border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800">
          {blocks.length ? renderCanvasRows() : (
            <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-400 dark:border-gray-700">
              Add a block to start building this email.
            </div>
          )}
          {footerPreview}
        </div>
      </section>
    </div>
  );
}

function CampaignCard({ campaign, posts, selected, onClick, listName }: { campaign: Campaign; posts: CampaignPost[]; selected: boolean; onClick: () => void; listName: string }) {
  const activityDate = (p: CampaignPost) => new Date(p.sent_at ?? p.scheduled_at ?? p.created_at).getTime();
  const sortedPosts = [...posts].sort((a, b) => activityDate(b) - activityDate(a)).slice(0, 4);
  const showActivity = posts.length > 0;
  const mostRecentPost = posts.length > 0
    ? posts.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b)
    : null;
  const displayStatus = mostRecentPost ? mostRecentPost.status : campaign.status;
  return (
    <button onClick={onClick} className={`w-full text-left rounded-2xl border-2 p-4 transition-all ${selected ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600"}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-1 flex-1">{campaign.title}</p>
        <Badge value={displayStatus} />
      </div>
      {listName && <p className="text-xs text-gray-500 dark:text-gray-400 truncate mb-2">{listName}</p>}
      {showActivity ? (
        <div className="space-y-1 mt-2">
          {sortedPosts.map((p) => (
            <div key={p.post_id} className="flex items-center gap-2 text-xs text-gray-500">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.status === "sent" ? "bg-green-400" : p.status === "scheduled" ? "bg-blue-400" : "bg-gray-300 dark:bg-gray-600"}`} />
              <span className="truncate flex-1">{p.title || p.subject || "Untitled"}</span>
              <span className="shrink-0 text-gray-400">
                {p.status === "sent" ? fmtDate(p.sent_at, true) : p.status === "scheduled" ? fmtDate(p.scheduled_at, true) : "Draft"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400 mt-1">No posts yet</p>
      )}
    </button>
  );
}

function CampaignPanel({
  campaign, templates, lists, posts, brand, onClose, onSaved, onDeleted, onPostsChanged,
}: {
  campaign: Campaign | "new";
  templates: CampaignTemplate[];
  lists: CampaignList[];
  posts: CampaignPost[];
  brand: BrandSettings;
  onClose: () => void;
  onSaved: (campaign: Campaign) => void;
  onDeleted: () => void;
  onPostsChanged: () => void;
}) {
  const isNew = campaign === "new";
  const c = isNew ? null : campaign;
  const [title, setTitle] = useState(c?.title ?? "");
  const [templateId, setTemplateId] = useState(c?.template_id ?? "");
  const [schedule, setSchedule] = useState<ListScheduleEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPost, setEditingPost] = useState<CampaignPost | "new" | null>(null);

  // Load existing schedule for existing campaigns
  useEffect(() => {
    if (isNew || !c?.campaign_id) return;
    apiFetch(`/marketing/campaigns/${c.campaign_id}/list-schedule`)
      .then((rows: ListScheduleEntry[]) => setSchedule(rows))
      .catch(() => {});
  }, [isNew, c?.campaign_id]);

  function toggleListInSchedule(list: CampaignList) {
    setSchedule((prev) => {
      const exists = prev.find((s) => s.list_id === list.list_id);
      if (exists) return prev.filter((s) => s.list_id !== list.list_id);
      return [...prev, { list_id: list.list_id, name: list.name, frequency: "every", contact_count: list.contact_count }];
    });
  }

  function setFrequency(listId: string, frequency: ListScheduleEntry["frequency"]) {
    setSchedule((prev) => prev.map((s) => s.list_id === listId ? { ...s, frequency } : s));
  }

  async function saveCampaign(e?: React.FormEvent) {
    e?.preventDefault();
    if (!title.trim()) { setError("Campaign title is required"); return null; }
    if (!templateId) { setError("Choose a template"); return null; }
    if (schedule.length === 0) { setError("Add at least one recipient list"); return null; }
    setSaving(true); setError(null);
    try {
      const template = templates.find((t) => t.template_id === templateId);
      const payload = {
        title, type: "email" as CampaignType, template_id: templateId,
        list_id: schedule[0]?.list_id ?? null,
        list_ids: schedule.map((s) => s.list_id),
        subject: template?.subject ?? "",
        body: template?.body ?? "",
        body_html: template?.body_html ?? null,
      };
      const saved = isNew
        ? await apiFetch("/marketing/campaigns", { method: "POST", body: JSON.stringify(payload) })
        : await apiFetch(`/marketing/campaigns/${c!.campaign_id}`, { method: "PATCH", body: JSON.stringify(payload) });
      // Save the list schedule
      await apiFetch(`/marketing/campaigns/${saved.campaign_id}/list-schedule`, {
        method: "PUT",
        body: JSON.stringify({ schedules: schedule.map((s) => ({ list_id: s.list_id, frequency: s.frequency })) }),
      });
      onSaved(saved);
      return saved as Campaign;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function deleteCampaign() {
    if (isNew) return;
    await apiFetch(`/marketing/campaigns/${c!.campaign_id}`, { method: "DELETE" });
    onDeleted();
  }

  const currentTemplate = templates.find((t) => t.template_id === templateId);
  const [editingMeta, setEditingMeta] = useState(isNew);
  const [expandLists, setExpandLists] = useState(isNew);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      {editingPost ? (
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3 shrink-0">
          <button type="button" onClick={() => setEditingPost(null)}
            className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
            {isNew ? "New campaign" : c!.title}
          </button>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>
      ) : (
        <form onSubmit={async (e) => { e.preventDefault(); await saveCampaign(); setEditingMeta(false); setExpandLists(false); }}
          className="border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-start justify-between px-5 py-3.5 gap-3">
            <div className="min-w-0 flex-1">
              {editingMeta ? (
                <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-2.5 py-1.5 text-sm font-semibold bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" />
              ) : (
                <div className="flex items-center gap-1.5 group">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{isNew ? "New Campaign" : (c!.title || "Untitled")}</h2>
                  <button type="button" onClick={() => { setEditingMeta(true); setExpandLists(true); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 shrink-0">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                </div>
              )}
              {!editingMeta && !isNew && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="text-xs text-gray-400">
                    {currentTemplate ? currentTemplate.name : <span className="text-amber-500">No template</span>}
                  </span>
                  {schedule.length > 0 && (
                    <div className="flex flex-wrap gap-1 items-center">
                      {schedule.map((s) => (
                        <span key={s.list_id} className="inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                          {s.name}
                          <button type="button" onClick={() => toggleListInSchedule(lists.find((l) => l.list_id === s.list_id) ?? { list_id: s.list_id, name: s.name, description: null, contact_count: s.contact_count, created_at: "" })}
                            className="text-gray-400 hover:text-red-500 leading-none">×</button>
                        </span>
                      ))}
                      <button type="button" onClick={() => setExpandLists((v) => !v)}
                        className="text-[11px] text-blue-500 hover:text-blue-700">
                        {expandLists ? "Done" : "Edit lists"}
                      </button>
                    </div>
                  )}
                  {schedule.length === 0 && (
                    <button type="button" onClick={() => setExpandLists(true)} className="text-xs text-amber-500 hover:text-amber-600">+ Add recipient list</button>
                  )}
                </div>
              )}
            </div>
            <button type="button" onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-600 text-sm mt-0.5">Close</button>
          </div>

          {(editingMeta || isNew) && (
            <div className="px-5 pb-4 space-y-3">
              {!isNew && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Campaign name</label>
                  <input value={title} onChange={(e) => setTitle(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100" />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Default template</label>
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={`w-full ${SELECT_CLASS}`}>
                  <option value="">Select a template...</option>
                  {templates.map((t) => <option key={t.template_id} value={t.template_id}>{t.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {(expandLists || isNew) && (
            <div className="px-5 pb-4 space-y-2">
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                Recipient lists <span className="font-normal text-gray-400">— how often each receives an email</span>
              </p>
              {schedule.length > 0 && (
                <div className="space-y-1.5">
                  {schedule.map((s) => (
                    <div key={s.list_id} className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20 px-3 py-1.5">
                      <span className="flex-1 min-w-0 text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                        {s.name} <span className="font-normal text-gray-400">({s.contact_count})</span>
                      </span>
                      <select value={s.frequency} onChange={(e) => setFrequency(s.list_id, e.target.value as ListScheduleEntry["frequency"])}
                        className={`${SELECT_CLASS_SM} py-0.5 text-xs shrink-0`}>
                        {FREQ_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <button type="button" onClick={() => toggleListInSchedule(lists.find((l) => l.list_id === s.list_id) ?? { list_id: s.list_id, name: s.name, description: null, contact_count: s.contact_count, created_at: "" })}
                        className="shrink-0 text-gray-400 hover:text-red-500 leading-none text-base">×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {lists.filter((l) => !schedule.some((s) => s.list_id === l.list_id)).map((l) => (
                  <button key={l.list_id} type="button" onClick={() => toggleListInSchedule(l)}
                    className="rounded border border-gray-200 dark:border-gray-700 px-3 py-1 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
                    + {l.name} ({l.contact_count})
                  </button>
                ))}
                {lists.length === 0 && <p className="text-xs text-gray-400">Create lists in the Lists tab first.</p>}
              </div>
            </div>
          )}

          {(editingMeta || isNew || expandLists) && (
            <div className="px-5 pb-4 flex justify-between items-center">
              {error && <p className="text-xs text-red-500">{error}</p>}
              {!isNew && <button type="button" onClick={deleteCampaign} className="text-xs text-red-500 hover:text-red-700">Delete campaign</button>}
              <button type="submit" disabled={saving} className="ml-auto px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
                {saving ? "Saving..." : isNew ? "Create campaign" : "Save changes"}
              </button>
            </div>
          )}
        </form>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {isNew ? (
          <div className="text-center py-12 text-sm text-gray-400">Save the campaign before adding scheduled posts.</div>
        ) : editingPost ? (
          <PostEditor
            campaign={c!}
            post={editingPost}
            defaultTemplate={currentTemplate ?? null}
            templates={templates}
            lists={lists}
            brand={brand}
            onCancel={() => setEditingPost(null)}
            onSaved={() => { setEditingPost(null); onPostsChanged(); }}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Scheduled posts</p>
                <p className="text-xs text-gray-400">Create multiple emails inside this campaign.</p>
              </div>
              <button type="button" onClick={() => setEditingPost("new")} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white">New post</button>
            </div>
            {posts.length === 0 ? (
              <div className="text-center py-12 text-sm text-gray-400 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">No posts yet.</div>
            ) : (
              <div className="space-y-2">
                {posts.map((p) => {
                  // Resolve which lists this post goes to: post-level override → campaign schedule → nothing
                  const postListIds = p.list_ids?.length ? p.list_ids : schedule.map((s) => s.list_id);
                  const postListNames = postListIds
                    .map((id) => lists.find((l) => l.list_id === id)?.name)
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <div key={p.post_id} className="group relative rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-blue-400 transition-colors">
                      <button type="button" onClick={() => setEditingPost(p)} className="w-full text-left p-3 pr-8">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.title || p.subject || "Untitled post"}</p>
                            <p className="text-xs text-gray-500 truncate">{p.subject}</p>
                            <p className="text-xs text-gray-400 mt-1">
                              {p.status === "scheduled" ? `Scheduled ${fmtDate(p.scheduled_at, true)}` : p.status === "sent" ? `Sent ${fmtDate(p.sent_at, true)}` : "Draft"}
                              {postListNames ? ` · ${postListNames}` : ""}
                            </p>
                          </div>
                          <Badge value={p.status} />
                        </div>
                      </button>
                      {p.status !== "sent" && (
                        <button type="button"
                          onClick={async (e) => { e.stopPropagation(); if (!confirm("Delete this post?")) return; await apiFetch(`/marketing/campaigns/${c!.campaign_id}/posts/${p.post_id}`, { method: "DELETE" }); onPostsChanged(); }}
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 text-base leading-none">×</button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PostEditor({
  campaign, post, defaultTemplate, templates, lists, brand, onCancel, onSaved,
}: {
  campaign: Campaign;
  post: CampaignPost | "new";
  defaultTemplate: CampaignTemplate | null;
  templates: CampaignTemplate[];
  lists: CampaignList[];
  brand: BrandSettings;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isNew = post === "new";
  const p = isNew ? null : post;
  const initialTemplate = p?.template_id || defaultTemplate?.template_id || "";
  const seedTemplate = templates.find((t) => t.template_id === initialTemplate) ?? defaultTemplate;
  const [templateId, setTemplateId] = useState(initialTemplate);
  const [title, setTitle] = useState(p?.title || seedTemplate?.name || "");
  const [subject, setSubject] = useState(p?.subject || seedTemplate?.subject || campaign.subject || "");
  const [scheduledAt, setScheduledAt] = useState(toLocalDT(p?.scheduled_at ?? null));
  // Post-level list_ids override campaign list; empty = use campaign default
  const [postListIds, setPostListIds] = useState<string[]>(p?.list_ids ?? []);
  const [blocks, setBlocks] = useState<EmailBlock[]>(defaultBlocks({
    body: p?.body || seedTemplate?.body,
    body_html: p?.body_html || seedTemplate?.body_html,
  }));
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(isNew ? "idle" : "saved");
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSavedPayload = useRef("");
  const isSent = p?.status === "sent";

  // Autosave for existing (non-new, non-sent) posts — saves content only, never changes status/scheduled_at
  useEffect(() => {
    if (isNew || isSent) return;
    const current = JSON.stringify(contentPayload());
    if (current === lastSavedPayload.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}`, {
        method: "PATCH", body: JSON.stringify(contentPayload()),
      })
        .then(() => { lastSavedPayload.current = JSON.stringify(contentPayload()); setSaveState("saved"); })
        .catch(() => setSaveState("error"));
    }, 900);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, title, subject, postListIds, templateId]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.template_id === id);
    if (!t) return;
    setTitle(t.name);
    setSubject(t.subject);
    setBlocks(defaultBlocks({ body: t.body, body_html: t.body_html }));
  }

  function toggleList(listId: string) {
    setPostListIds((prev) => prev.includes(listId) ? prev.filter((id) => id !== listId) : [...prev, listId]);
  }

  function contentPayload() {
    return {
      title,
      template_id: templateId || null,
      subject,
      body: blocksToPlain(blocks),
      body_html: renderBlocks(blocks),
      list_ids: postListIds,
    };
  }

  async function save() {
    if (!title.trim() || !subject.trim()) { setError("Title and subject are required"); return; }
    setSaving(true); setSaveState("saving"); setError(null);
    try {
      if (isNew) {
        // Always create as draft — scheduling requires an explicit action
        await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts`, {
          method: "POST", body: JSON.stringify({ ...contentPayload(), status: "draft" }),
        });
      } else {
        await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}`, {
          method: "PATCH", body: JSON.stringify(contentPayload()),
        });
        lastSavedPayload.current = JSON.stringify(contentPayload());
      }
      setSaveState("saved");
      onSaved();
    } catch (err: unknown) { setSaveState("error"); setError(err instanceof Error ? err.message : "Save failed"); }
    finally { setSaving(false); }
  }

  async function schedulePost() {
    if (!title.trim() || !subject.trim()) { setError("Title and subject are required"); return; }
    if (!scheduledAt) { setError("Pick a send time first"); return; }
    setSaving(true); setError(null);
    try {
      const dt = new Date(scheduledAt).toISOString();
      if (isNew) {
        await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts`, {
          method: "POST", body: JSON.stringify({ ...contentPayload(), scheduled_at: dt, status: "scheduled" }),
        });
      } else {
        await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}`, {
          method: "PATCH", body: JSON.stringify({ ...contentPayload(), scheduled_at: dt, status: "scheduled" }),
        });
        lastSavedPayload.current = JSON.stringify(contentPayload());
      }
      setSaveState("saved");
      onSaved();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Schedule failed"); }
    finally { setSaving(false); }
  }

  async function unschedulePost() {
    if (isNew || !p) return;
    setSaving(true); setError(null);
    try {
      await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p.post_id}`, {
        method: "PATCH", body: JSON.stringify({ scheduled_at: null, status: "draft" }),
      });
      setScheduledAt("");
      onSaved();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Failed"); }
    finally { setSaving(false); }
  }

  async function sendNow() {
    if (isNew) { await save(); return; }
    if (!confirm("Send this post now?")) return;
    setSending(true); setError(null);
    try {
      await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}/send`, { method: "POST" });
      onSaved();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Send failed"); }
    finally { setSending(false); }
  }

  async function sendTest() {
    if (isNew) { setError("Save the post before sending a test."); return; }
    setTesting(true); setError(null);
    try { await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}/send-test`, { method: "POST" }); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : "Test failed"); }
    finally { setTesting(false); }
  }

  async function deletePost() {
    if (isNew || !confirm("Delete this post?")) return;
    await apiFetch(`/marketing/campaigns/${campaign.campaign_id}/posts/${p!.post_id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{isNew ? "New email" : title}</p>
          {!isNew && !isSent && (
            <p className={`text-[11px] mt-0.5 ${saveState === "error" ? "text-red-500" : "text-gray-400"}`}>
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Autosave failed" : ""}
            </p>
          )}
        </div>
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-700">Back</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Post title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={isSent}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 disabled:opacity-60" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={isSent}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 disabled:opacity-60" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Template</label>
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)} disabled={isSent}
            className={`w-full ${SELECT_CLASS}`}>
            <option value="">No template</option>
            {templates.map((t) => <option key={t.template_id} value={t.template_id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">
            {p?.status === "scheduled" ? "Scheduled for" : "Schedule for"}
          </label>
          {p?.status === "scheduled" ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-blue-700 dark:text-blue-300">{fmtDate(p.scheduled_at, true)}</span>
              <button type="button" onClick={unschedulePost} disabled={saving}
                className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-50">Unschedule</button>
            </div>
          ) : (
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} disabled={isSent}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 disabled:opacity-60" />
          )}
        </div>
      </div>
      {!isSent && <EmailBuilder blocks={blocks} onChange={setBlocks} brand={brand} />}
      {isSent && <iframe title="Sent preview" srcDoc={p?.body_html ?? ""} className="w-full h-[520px] bg-white rounded-lg border border-gray-200 dark:border-gray-700" />}
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex justify-between gap-2 border-t border-gray-200 dark:border-gray-700 pt-4">
        {!isNew && !isSent && <button type="button" onClick={deletePost} className="text-xs text-red-500 hover:text-red-700">Delete post</button>}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">Cancel</button>
          {!isSent && !isNew && <button type="button" onClick={sendTest} disabled={testing} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-60">{testing ? "Sending..." : "Test"}</button>}
          {!isSent && <button type="button" onClick={save} disabled={saving} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-60">{saving ? "Saving..." : "Save draft"}</button>}
          {!isSent && p?.status !== "scheduled" && scheduledAt && <button type="button" onClick={schedulePost} disabled={saving} className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60">{saving ? "Scheduling..." : "Confirm schedule"}</button>}
          {!isSent && !isNew && <button type="button" onClick={sendNow} disabled={sending} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">{sending ? "Sending..." : "Send now"}</button>}
        </div>
      </div>
    </div>
  );
}

function TemplatesTab({ templates, onReload, brand }: { templates: CampaignTemplate[]; onReload: () => void; brand: BrandSettings }) {
  const [selected, setSelected] = useState<CampaignTemplate | "new" | null>(null);
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {!selected && <div className="w-full min-w-0 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-gray-400">{templates.length} templates</span>
          <button onClick={() => setSelected("new")} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white">New Template</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {templates.map((t) => (
            <button key={t.template_id} onClick={() => setSelected(t)} className="text-left rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-blue-400">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.name}</p>
              <p className="text-xs text-gray-500 truncate mt-1">{t.subject}</p>
            </button>
          ))}
        </div>
      </div>}
      {selected && (
          <div className="w-full min-w-0 overflow-y-auto p-5">
            <TemplateEditor
              template={selected}
              onCancel={() => setSelected(null)}
              onSaved={onReload}
              onDeleted={() => { setSelected(null); onReload(); }}
              brand={brand}
            />
          </div>
      )}
    </div>
  );
}

function TemplateEditor({
  template, onCancel, onSaved, onDeleted, brand = DEFAULT_BRAND,
}: {
  template: CampaignTemplate | "new";
  onCancel: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  brand?: BrandSettings;
}) {
  const t = template === "new" ? null : template;
  // Track saved ID locally so new templates stay in the editor after first save
  const [savedId, setSavedId] = useState<string | null>(t?.template_id ?? null);
  const isNew = savedId === null;
  const [name, setName] = useState(t?.name ?? "");
  const [subject, setSubject] = useState(t?.subject ?? "");
  const [businessName, setBusinessName] = useState(t?.business_name ?? brand.business_name ?? "");
  const [businessAddress, setBusinessAddress] = useState(t?.business_address ?? brand.business_address ?? "");
  const [blocks, setBlocks] = useState<EmailBlock[]>(defaultBlocks({ body: t?.body, body_html: t?.body_html }, brand));
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(isNew ? "idle" : "saved");
  const lastSavedPayload = useRef("");

  function templatePayload() {
    return {
      name, type: "email" as CampaignType, subject, body: blocksToPlain(blocks), body_html: renderBlocks(blocks),
      sender_name: businessName || null,
      sender_email: null,
      reply_to: null,
      business_name: businessName || null,
      business_address: businessAddress || null,
      unsubscribe_enabled: true,
    };
  }

  async function save() {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaveState("saving");
    setError(null);
    const payload = templatePayload();
    try {
      if (isNew) {
        const created = await apiFetch("/marketing/campaign-templates", { method: "POST", body: JSON.stringify(payload) });
        lastSavedPayload.current = JSON.stringify(payload);
        setSavedId(created.template_id);
        setSaveState("saved");
        onSaved();
        // Stay in editor — autosave takes over from here
      } else {
        await apiFetch(`/marketing/campaign-templates/${savedId}`, { method: "PATCH", body: JSON.stringify(payload) });
        lastSavedPayload.current = JSON.stringify(payload);
        setSaveState("saved");
        onSaved();
      }
    } catch (err: unknown) {
      setSaveState("error");
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  useEffect(() => {
    lastSavedPayload.current = JSON.stringify(templatePayload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedId]);

  useEffect(() => {
    if (isNew) return;
    if (!name.trim()) {
      setSaveState("error");
      setError("Name is required");
      return;
    }
    const payload = templatePayload();
    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedPayload.current) return;
    setSaveState("saving");
    setError(null);
    const timer = window.setTimeout(() => {
      apiFetch(`/marketing/campaign-templates/${savedId}`, { method: "PATCH", body: JSON.stringify(payload) })
        .then(() => {
          lastSavedPayload.current = serialized;
          setSaveState("saved");
          onSaved();
        })
        .catch((err: unknown) => {
          setSaveState("error");
          setError(err instanceof Error ? err.message : "Autosave failed");
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [blocks, businessAddress, businessName, isNew, name, onSaved, savedId, subject]);

  async function remove() {
    if (isNew || !confirm("Delete this template?")) return;
    await apiFetch(`/marketing/campaign-templates/${savedId}`, { method: "DELETE" });
    onDeleted();
  }
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name"
            className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Default subject line"
            className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 outline-none placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300" />
          <p className={`text-[11px] ${saveState === "error" ? "text-red-500" : "text-gray-400"}`}>
            {isNew ? "Click “Create” to save, then edits autosave." : saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? (error ?? "Save failed") : "Autosaves changes"}
          </p>
        </div>
        <button onClick={onCancel} className="shrink-0 text-sm text-gray-500 hover:text-gray-700">Back</button>
      </div>
      <EmailBuilder
        blocks={blocks}
        onChange={setBlocks}
        brand={brand}
        footerPreview={
          <ComplianceCanvasFooter
            businessName={businessName}
            businessAddress={businessAddress}
            onBusinessNameChange={setBusinessName}
            onBusinessAddressChange={setBusinessAddress}
          />
        }
      />
      {saveState !== "error" && error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 pt-4">
        {!isNew && <button onClick={remove} className="text-xs text-red-500 hover:text-red-700">Delete template</button>}
        <div className="ml-auto flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300">Cancel</button>
          {isNew && <button onClick={save} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">Create</button>}
        </div>
      </div>
    </div>
  );
}

function ListsTab() {
  const [lists, setLists] = useState<CampaignList[]>([]);
  const [selected, setSelected] = useState<CampaignList | null>(null);
  const [contacts, setContacts] = useState<ListContact[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ListContact[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [manualEmail, setManualEmail] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ added: number; total: number; skipped: number } | null>(null);

  const loadLists = useCallback(async () => setLists(await apiFetch("/marketing/campaign-lists")), []);
  const loadContacts = useCallback(async (listId: string) => {
    setContacts(await apiFetch(`/marketing/campaign-lists/${listId}/contacts`));
  }, []);

  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => {
    if (!selected) return;
    loadContacts(selected.list_id);
  }, [selected, loadContacts]);
  useEffect(() => {
    if (!q.trim()) { setResults([]); setSearchError(null); return; }
    setSearchError(null);
    const t = setTimeout(() =>
      apiFetch(`/marketing/campaign-contacts-search?q=${encodeURIComponent(q)}`)
        .then(setResults)
        .catch(() => setSearchError("Search failed")),
    250);
    return () => clearTimeout(t);
  }, [q]);

  async function createList(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const l = await apiFetch("/marketing/campaign-lists", { method: "POST", body: JSON.stringify({ name: newName, description: newDesc || null }) });
    setNewName(""); setNewDesc("");
    await loadLists();
    setSelected(l);
  }
  async function deleteList(listId: string) {
    if (!confirm("Delete this list and all its contacts? This cannot be undone.")) return;
    await apiFetch(`/marketing/campaign-lists/${listId}`, { method: "DELETE" });
    if (selected?.list_id === listId) setSelected(null);
    await loadLists();
  }
  async function renameList(listId: string, name: string) {
    if (!name.trim()) return;
    await apiFetch(`/marketing/campaign-lists/${listId}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
    setRenamingId(null);
    await loadLists();
    if (selected?.list_id === listId) setSelected((prev) => prev ? { ...prev, name: name.trim() } : prev);
  }
  async function addContact(contact: ListContact, email: string) {
    if (!selected) return;
    setAdding(contact.contact_id);
    try {
      await apiFetch(`/marketing/campaign-lists/${selected.list_id}/contacts`, {
        method: "POST",
        body: JSON.stringify({ contacts: [{ contact_id: contact.contact_id, email }] }),
      });
      await loadContacts(selected.list_id);
      setQ(""); setResults([]);
      await loadLists();
    } finally { setAdding(null); }
  }

  async function importCsv(file: File) {
    if (!selected) return;
    setImporting(true); setImportResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/proxy/marketing/campaign-lists/${selected.list_id}/import-csv`, { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(typeof err.detail === "string" ? err.detail : "Import failed");
      }
      const result = await r.json();
      setImportResult(result);
      await loadContacts(selected.list_id);
      await loadLists();
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : "Import failed");
    } finally { setImporting(false); }
  }

  async function addManualEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !manualEmail.includes("@")) return;
    setAdding("manual");
    try {
      await apiFetch(`/marketing/campaign-lists/${selected.list_id}/contacts`, {
        method: "POST",
        body: JSON.stringify({ contacts: [{ contact_id: null, email: manualEmail.trim() }] }),
      });
      await loadContacts(selected.list_id);
      setManualEmail("");
      await loadLists();
    } finally { setAdding(null); }
  }
  async function removeContact(contactId: string) {
    if (!selected) return;
    await apiFetch(`/marketing/campaign-lists/${selected.list_id}/contacts/${contactId}`, { method: "DELETE" });
    setContacts((prev) => prev.filter((c) => c.contact_id !== contactId));
    await loadLists();
  }

  const inputClass = "rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100";

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left: list index */}
      <div className={`${selected ? "w-80 shrink-0 border-r border-gray-200 dark:border-gray-700" : "w-full"} min-w-0 overflow-y-auto p-6 space-y-4`}>
        <form onSubmit={createList} className="flex gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New list name" className={`flex-1 ${inputClass}`} />
          <button className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700">Create</button>
        </form>
        {lists.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No lists yet. Create one above.</p>}
        <div className="space-y-1.5">
          {lists.map((l) => (
            <div key={l.list_id} className={`flex items-center gap-2 rounded-xl border px-4 py-3 transition-colors ${selected?.list_id === l.list_id ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"}`}>
              {renamingId === l.list_id ? (
                <form onSubmit={(e) => { e.preventDefault(); renameList(l.list_id, renameValue); }} className="flex-1 flex items-center gap-2">
                  <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                    className={`flex-1 min-w-0 rounded border border-blue-400 px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/20`} />
                  <button type="submit" className="text-xs text-blue-600 hover:text-blue-700 font-medium shrink-0">Save</button>
                  <button type="button" onClick={() => setRenamingId(null)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">Cancel</button>
                </form>
              ) : (
                <>
                  <button onClick={() => setSelected(l)} className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{l.name}</p>
                    <p className="text-xs text-gray-400">{l.contact_count} contacts</p>
                  </button>
                  <button onClick={() => { setRenamingId(l.list_id); setRenameValue(l.name); }}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">
                    Rename
                  </button>
                  <button onClick={() => deleteList(l.list_id)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20">
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Right: contact management for selected list */}
      {selected && (
        <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 group">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{selected.name}</p>
                <button onClick={() => { setRenamingId(selected.list_id); setRenameValue(selected.name); }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
              <p className="text-xs text-gray-400">{contacts.length} contacts</p>
            </div>
            <button onClick={() => setSelected(null)} className="shrink-0 text-sm text-gray-500 hover:text-gray-700">Close</button>
          </div>

          {/* Search contacts */}
          <div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts by name, email, or organization…"
              className={`w-full ${inputClass}`} autoFocus />
            {searchError && <p className="mt-1 text-xs text-red-500">{searchError}</p>}
          </div>

          {/* CSV import */}
          <div>
            <label className={`flex items-center gap-2 cursor-pointer rounded-lg border border-dashed px-4 py-3 text-sm transition-colors ${importing ? "border-blue-300 text-blue-500" : "border-gray-300 dark:border-gray-600 text-gray-500 hover:border-blue-400 hover:text-blue-600 dark:hover:border-blue-500"}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {importing ? "Importing…" : "Import from CSV"}
              <input type="file" accept=".csv,text/csv" className="hidden" disabled={importing}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ""; }} />
            </label>
            {importResult && (
              <p className="mt-1.5 text-xs text-green-600 dark:text-green-400">
                Added {importResult.added} of {importResult.total} addresses{importResult.skipped > 0 ? ` (${importResult.skipped} already in list)` : ""}.
              </p>
            )}
          </div>

          {/* Add raw email */}
          <form onSubmit={addManualEmail} className="flex gap-2">
            <input value={manualEmail} onChange={(e) => setManualEmail(e.target.value)} type="email"
              placeholder="Or add an email directly (e.g. person@company.com)"
              className={`flex-1 ${inputClass}`} />
            <button type="submit" disabled={!manualEmail.includes("@") || adding === "manual"}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
              {adding === "manual" ? "Adding…" : "Add"}
            </button>
          </form>

          {results.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              {results.map((r) => {
                const emails = r.emails?.length ? r.emails : [{ email: r.email, label: "work", is_primary: true }];
                const alreadyAdded = contacts.some((c) => c.contact_id === r.contact_id);
                return (
                  <div key={r.contact_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.name}</p>
                      {r.organization && <p className="text-xs text-gray-400">{r.organization}</p>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 shrink-0">
                      {alreadyAdded ? (
                        <span className="px-2 py-0.5 text-xs rounded bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">Added</span>
                      ) : emails.map((em) => (
                        <button key={em.email} onClick={() => addContact(r, em.email)}
                          disabled={adding === r.contact_id}
                          className="px-2 py-0.5 text-xs rounded bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/30 dark:text-blue-300 disabled:opacity-50">
                          {adding === r.contact_id ? "Adding…" : em.email}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {q.trim() && results.length === 0 && !searchError && (
            <p className="text-sm text-gray-400 text-center py-4">No contacts found for "{q}"</p>
          )}

          {/* Current contacts */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">List members</p>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
              {contacts.map((c) => (
                <div key={c.contact_id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{c.name}</p>
                    <p className="text-xs text-gray-500 truncate">{c.send_email ?? c.email}{c.organization ? ` · ${c.organization}` : ""}</p>
                  </div>
                  <button onClick={() => removeContact(c.contact_id)} className="shrink-0 text-xs text-red-500 hover:text-red-700">Remove</button>
                </div>
              ))}
              {contacts.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No contacts yet — search above to add.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BrandSettingsTab({ brand, onSaved }: { brand: BrandSettings; onSaved: (b: BrandSettings) => void }) {
  const [form, setForm] = useState<BrandSettings>(brand);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [newColor, setNewColor] = useState("#000000");

  function patch(p: Partial<BrandSettings>) { setForm((prev) => ({ ...prev, ...p })); setSaved(false); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const result = await apiFetch("/marketing/brand-settings", { method: "PATCH", body: JSON.stringify(form) });
      onSaved(result);
      setSaved(true);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Save failed"); }
    finally { setSaving(false); }
  }

  async function uploadLogo(file: File | null) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("category", "logo");
      fd.append("file", file);
      const r = await fetch("/api/proxy/marketing/brand-assets/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error("Upload failed");
      const asset = await r.json();
      const url = `${window.location.origin}/api/proxy/marketing/brand-assets/${asset.id}/public`;
      patch({ logo_url: url });
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Upload failed"); }
    finally { setUploading(false); }
  }

  const labelClass = "block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1";
  const inputClass = "w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none";
  const sectionClass = "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5 space-y-4";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <form onSubmit={save} className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Brand Settings</h2>
          <p className="text-xs text-gray-400 mt-0.5">Defaults applied to new templates and blocks. Existing content is not overwritten.</p>
        </div>

        {/* Logo */}
        <div className={sectionClass}>
          <p className="text-xs font-semibold uppercase text-gray-400">Logo</p>
          <div className="flex items-center gap-4">
            {form.logo_url && (
              <img src={form.logo_url} alt="Logo preview" className="h-12 max-w-[160px] rounded object-contain border border-gray-200 dark:border-gray-700 bg-white p-1" />
            )}
            <label className="cursor-pointer rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadLogo(e.target.files?.[0] ?? null)} />
              {uploading ? "Uploading…" : form.logo_url ? "Replace logo" : "Upload logo"}
            </label>
            {form.logo_url && (
              <button type="button" onClick={() => patch({ logo_url: null })} className="text-xs text-red-500 hover:text-red-700">Remove</button>
            )}
          </div>
        </div>

        {/* Typography */}
        <div className={sectionClass}>
          <p className="text-xs font-semibold uppercase text-gray-400">Typography</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Default font</label>
              <select value={form.font_family} onChange={(e) => patch({ font_family: e.target.value })} className={`${inputClass} ${SELECT_CLASS}`}>
                {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div />
            <div>
              <label className={labelClass}>Body font size</label>
              <div className="flex items-center gap-1.5">
                <input type="number" min={10} max={24} value={form.font_size} onChange={(e) => patch({ font_size: Number(e.target.value) })} className={inputClass} />
                <span className="text-xs text-gray-400 shrink-0">px</span>
              </div>
            </div>
            <div>
              <label className={labelClass}>Heading font size</label>
              <div className="flex items-center gap-1.5">
                <input type="number" min={18} max={60} value={form.heading_size} onChange={(e) => patch({ heading_size: Number(e.target.value) })} className={inputClass} />
                <span className="text-xs text-gray-400 shrink-0">px</span>
              </div>
            </div>
          </div>
        </div>

        {/* Colors */}
        <div className={sectionClass}>
          <p className="text-xs font-semibold uppercase text-gray-400">Colors</p>
          <div className="grid grid-cols-2 gap-4">
            <ColorControl label="Body text" value={form.text_color} swatches={form.brand_colors.length ? form.brand_colors : COLOR_SWATCHES} onChange={(text_color) => patch({ text_color })} />
            <ColorControl label="Heading text" value={form.heading_color} swatches={form.brand_colors.length ? form.brand_colors : COLOR_SWATCHES} onChange={(heading_color) => patch({ heading_color })} />
            <ColorControl label="Button background" value={form.button_color} swatches={form.brand_colors.length ? form.brand_colors : BACKGROUND_SWATCHES} onChange={(button_color) => patch({ button_color })} />
            <ColorControl label="Button text" value={form.button_text_color} swatches={form.brand_colors.length ? form.brand_colors : COLOR_SWATCHES} onChange={(button_text_color) => patch({ button_text_color })} />
          </div>

          <div>
            <label className={labelClass}>Brand color palette <span className="font-normal text-gray-400">(overrides default swatches)</span></label>
            <div className="flex flex-wrap gap-2 mb-2">
              {form.brand_colors.map((c, i) => (
                <div key={i} className="flex items-center gap-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-1">
                  <div className="h-4 w-4 rounded-full border border-gray-300" style={{ backgroundColor: c }} />
                  <span className="text-[11px] font-mono text-gray-600 dark:text-gray-300">{c}</span>
                  <button type="button" onClick={() => patch({ brand_colors: form.brand_colors.filter((_, j) => j !== i) })} className="text-gray-400 hover:text-red-500 text-xs leading-none ml-1">×</button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)}
                className="h-8 w-10 shrink-0 rounded border border-gray-300 dark:border-gray-600 p-0.5 bg-transparent cursor-pointer" />
              <input value={newColor} onChange={(e) => setNewColor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = newColor.trim();
                    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) && !form.brand_colors.includes(v))
                      patch({ brand_colors: [...form.brand_colors, v] });
                  }
                }}
                placeholder="#rrggbb"
                className="w-28 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs font-mono text-gray-800 dark:text-gray-200 focus:border-blue-500 outline-none" />
              <button type="button" onClick={() => {
                const v = newColor.trim();
                if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) && !form.brand_colors.includes(v)) {
                  patch({ brand_colors: [...form.brand_colors, v] });
                  setNewColor("#000000");
                }
              }} className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                Add
              </button>
            </div>
          </div>
        </div>

        {/* Business / Compliance footer */}
        <div className={sectionClass}>
          <p className="text-xs font-semibold uppercase text-gray-400">Default Email Footer</p>
          <p className="text-[11px] text-gray-400">Auto-filled in new templates. Required for CAN-SPAM compliance.</p>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className={labelClass}>Business name</label>
              <input value={form.business_name ?? ""} onChange={(e) => patch({ business_name: e.target.value || null })} placeholder="Founder ERP Inc." className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Postal address</label>
              <AutoTextarea value={form.business_address ?? ""} onChange={(e) => patch({ business_address: e.target.value || null })} rows={2} placeholder="123 Main St, City, State ZIP" className={`${inputClass} resize-none`} />
            </div>
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60">
            {saving ? "Saving…" : "Save brand settings"}
          </button>
          {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
        </div>
      </form>
    </div>
  );
}

export default function CampaignsPage() {
  const [topTab, setTopTab] = useState<TopTab>("campaigns");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [lists, setLists] = useState<CampaignList[]>([]);
  const [postsByCampaign, setPostsByCampaign] = useState<Record<string, CampaignPost[]>>({});
  const [selected, setSelected] = useState<Campaign | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useState<BrandSettings>(DEFAULT_BRAND);
  const [leftPct, setLeftPct] = useState(30);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const data: Campaign[] = await apiFetch("/marketing/campaigns");
      setCampaigns(data);
      const pairs = await Promise.all(data.map(async (c) => [c.campaign_id, await apiFetch(`/marketing/campaigns/${c.campaign_id}/posts`)] as const));
      setPostsByCampaign(Object.fromEntries(pairs));
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Failed to load campaigns"); }
    finally { setLoading(false); }
  }, []);
  const loadTemplates = useCallback(async () => setTemplates(await apiFetch("/marketing/campaign-templates")), []);
  const loadLists = useCallback(async () => setLists(await apiFetch("/marketing/campaign-lists")), []);
  const loadBrand = useCallback(async () => {
    try { setBrand(await apiFetch("/marketing/brand-settings")); } catch { /* use defaults */ }
  }, []);

  useEffect(() => { loadCampaigns(); loadTemplates(); loadLists(); loadBrand(); }, [loadCampaigns, loadTemplates, loadLists, loadBrand]);

  function listNames(campaign: Campaign) {
    const ids = campaign.list_ids?.length ? campaign.list_ids : (campaign.list_id ? [campaign.list_id] : []);
    if (!ids.length) return "No recipient list";
    return ids.map((id) => lists.find((l) => l.list_id === id)?.name ?? id).join(", ");
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0 px-6 bg-white dark:bg-gray-900">
        {(["campaigns", "templates", "lists", "settings"] as TopTab[]).map((t) => (
          <button key={t} onClick={() => { setTopTab(t); setSelected(null); }}
            className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${topTab === t ? "border-blue-600 text-blue-700 dark:text-blue-400" : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
            {t === "campaigns" ? "emails" : t}
          </button>
        ))}
      </div>

      {topTab === "templates" && <TemplatesTab templates={templates} onReload={loadTemplates} brand={brand} />}
      {topTab === "lists" && <ListsTab />}
      {topTab === "settings" && <BrandSettingsTab brand={brand} onSaved={setBrand} />}

      {topTab === "campaigns" && (
        <div className="flex flex-1 min-h-0 overflow-hidden" ref={splitContainerRef}>
          <div className={`${selected ? "" : "w-full"} flex min-w-0 flex-col overflow-hidden`}
            style={selected ? { width: `${leftPct}%`, minWidth: 220, maxWidth: "70%" } : undefined}>
            <div className="flex items-center justify-between px-6 py-4 shrink-0">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Campaigns</p>
              </div>
              <button onClick={() => setSelected("new")} className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white">New Campaign</button>
            </div>
            {error && <p className="mx-6 mb-3 text-xs text-red-500">{error}</p>}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 space-y-6">
              {loading ? (
                <div className="text-center py-16 text-sm text-gray-400">Loading...</div>
              ) : campaigns.length === 0 ? (
                <div className="text-center py-16 text-sm text-gray-400">No campaigns yet.</div>
              ) : (
                <div className={`grid ${selected ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"} gap-3`}>
                  {campaigns.map((c) => (
                    <CampaignCard key={c.campaign_id} campaign={c} posts={postsByCampaign[c.campaign_id] ?? []}
                      selected={selected !== "new" && (selected as Campaign | null)?.campaign_id === c.campaign_id}
                      onClick={() => setSelected(c)}
                      listName={listNames(c)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          {selected && (
            <>
              {/* Drag handle */}
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  const container = splitContainerRef.current;
                  if (!container) return;
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  const onMove = (ev: PointerEvent) => {
                    const rect = container.getBoundingClientRect();
                    const pct = ((ev.clientX - rect.left) / rect.width) * 100;
                    setLeftPct(Math.min(70, Math.max(20, pct)));
                  };
                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }}
                className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-blue-400 dark:bg-gray-700 dark:hover:bg-blue-500 transition-colors touch-none select-none"
                title="Drag to resize"
              />
              <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <CampaignPanel
                campaign={selected}
                templates={templates}
                lists={lists}
                posts={selected === "new" ? [] : postsByCampaign[(selected as Campaign).campaign_id] ?? []}
                brand={brand}
                onClose={() => setSelected(null)}
                onSaved={(campaign) => { setSelected(campaign); loadCampaigns(); }}
                onDeleted={() => { setSelected(null); loadCampaigns(); }}
                onPostsChanged={loadCampaigns}
              />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
