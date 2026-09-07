"use client";

import React, { useEffect, useState, useCallback, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import * as XLSX from "xlsx";
import { Avatar } from "@/components/Avatar";

import { AutoTextarea } from "@/components/AutoTextarea";
import { EntityActivity } from "@/components/comms/EntityActivity";
// ── Types ──────────────────────────────────────────────────────────────────────

interface Opportunity {
  opportunity_id: string;
  title: string;
  stage: string;
  deadline: string | null;
  deadline_time: string | null;
  tags: string[];
  /** The instrument — a value from the funding_types vocabulary. */
  funding_type: string | null;
  /** Whether it costs equity. Split out of funding_type by migration 125. */
  dilution: string | null;
  /** NUMERIC as of migration 126 — the award ceiling, never prose. */
  amount: number | null;
  amount_currency: string | null;
  /** Ranges, equity stakes, in-kind benefits, conditions on the award. */
  amount_notes: string | null;
  decision_date: string | null;
  funding_dispersion: string | null;
  source_link: string | null;
  // Screening properties (134). eligibility sits on the board rather than in
  // the details tab because it is what disqualifies a row outright.
  eligibility: string | null;
  cost_share_match: string | null;
  org_fit: string;
  last_verified: string | null;
  next_action: string | null;
  /** Notes are dated entries (migration 129); the list payload carries only a
   *  preview. The full log loads in the detail panel. */
  latest_note: string | null;
  notes_count: number;
  gcal_event_id: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  linked_project_id: string | null;
  created_at?: string | null;
}

type OppNote = {
  note_id: string;
  body: string;
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
};

type OppStageEvent = {
  history_id: string;
  changed_at: string;
  stage_from: string | null;
  stage_to: string;
  changed_by_name: string | null;
};

interface EnrichResult {
  funding_type?: string | null;
  dilution?: string | null;
  amount?: number | null;
  amount_currency?: string | null;
  amount_notes?: string | null;
  tags?: string[];
  notes?: string | null;
  decision_date?: string | null;
  enrichment_summary?: string;
}

interface Investor {
  investor_id: string;
  status: string | null;
  name: string | null;
  role: string | null;
  firm: string | null;
  firm_type: string | null;
  investor_type: string | null;
  intro_type: string | null;
  intro_notes: string | null;
  /** Everyone who could make the introduction, resolved server-side so the
   *  panel can name them without a second fetch. Empty when nobody is. */
  intro_contacts: ContactHit[];
  email: string | null;
  notes: string | null;
  office_phone: string | null;
  cell_phone: string | null;
  tags: string[];
  funding_type: string | null;
  avg_check_size: string | null;
  source_link: string | null;
  // enrichment fields
  hq: string | null;
  address: string | null;
  geo_focus: string | null;
  investment_stage: string | null;
  focus: string | null;
  fund_size: string | null;
  fund_launch_year: string | null;
  website: string | null;
  linkedin: string | null;
  portfolio_url: string | null;
  partners: string | null;
  description: string | null;
  check_size_min: string | null;
  check_size_max: string | null;
  portfolio: string[];
  enriched_fields: string[];
  // scoring fields
  score_focus: number | null;
  score_stage: number | null;
  score_check: number | null;
  score_geo: number | null;
  score_portfolio: number | null;
  total_score: number | null;
  tier: string | null;
  enrichment_notes: string | null;
  is_priority: boolean;
  // Fixed pipeline ladder driving the kanban board (see sql/migrations/092).
  pipeline_stage: string;
  closed_lost_reason: string | null;
  close_reason_code: string | null;
  revisit_date: string | null;
  revisit_trigger: string | null;
  end_date: string | null;
  /** Server-owned; restarts on every stage move. */
  stage_entered_at: string | null;
  /** How we reach them — 'linkedin' when there is no workable email. */
  outreach_channel: string;
  last_comm_at: string | null;
  last_comm_direction: string | null;
  scheduled_count: number;
  open_tasks: { task_id: string; title: string; due_date: string | null }[];
  linked_project_id: string | null;
  outreach_date: string | null;
  // Owner of the relationship — shown as an avatar beside the firm name.
  assigned_to: string | null;
  assigned_to_name: string | null;
}

type EditingCell = { id: string; field: string; value: string } | null;
type FundingViewMode = "list" | "kanban" | "gantt";

/** Columns of the applications list that can be ordered. Tags and Notes are
 *  left out: sorting rows by a bag of labels is not a question anyone asks. */
type OppSortKey = "stage" | "title" | "deadline" | "funding_type" | "amount" | "decision_date";
type OppSort = { key: OppSortKey; dir: "asc" | "desc" };

/** A list header you can order by. Declared out here rather than inside the tab
 *  so it keeps its identity between renders — a component redefined each render
 *  is remounted each render, and the button would lose focus on its own click. */
function SortableTh({ label, sortKey, sort, onSort }: {
  label: string; sortKey: OppSortKey; sort: OppSort; onSort: (k: OppSortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className="text-left px-4 py-3 font-medium">
      <button onClick={() => onSort(sortKey)} title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors ${
          active ? "text-gray-800 dark:text-gray-200"
                 : "hover:text-gray-700 dark:hover:text-gray-300"}`}>
        {label}
        {active && <span className="text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STAGES = ["New", "In Progress", "Applied", "Won", "Rejected", "Withdrawn"];

const STAGE_STYLES: Record<string, string> = {
  New:          "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "In Progress":"bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  Applied:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  Won:          "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  Rejected:     "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300",
  Withdrawn:    "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

// ── Investor statuses (dynamic, DB-backed) ──────────────────────────────────────

type InvestorStatus = { id: number; name: string; color: string; sort_order: number; investor_count?: number };

const STATUS_COLOR_KEYS = ["gray", "yellow", "blue", "green", "red", "orange", "purple", "pink", "teal", "indigo"] as const;

const STATUS_COLOR_CLASSES: Record<string, string> = {
  gray:   "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  blue:   "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  green:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  red:    "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  pink:   "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  teal:   "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

const STATUS_DOT_CLASSES: Record<string, string> = {
  gray: "bg-gray-400", yellow: "bg-amber-500", blue: "bg-blue-500",
  green: "bg-green-500", red: "bg-red-500", orange: "bg-orange-500",
  purple: "bg-purple-500", pink: "bg-pink-500", teal: "bg-teal-500", indigo: "bg-indigo-500",
};

// Module-level store so all sibling components share + refresh together
let _statuses: InvestorStatus[] = [
  { id: -1, name: "Awaiting Us",   color: "red",   sort_order: 0 },
  { id: -2, name: "Awaiting Investor", color: "green", sort_order: 1 },
];
const _statusListeners = new Set<() => void>();
async function refreshStatuses() {
  try {
    const res = await fetch("/api/proxy/dilutive/statuses");
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      _statuses = data;
      _statusListeners.forEach((l) => l());
    }
  } catch { /* keep defaults */ }
}
function useInvestorStatuses(): InvestorStatus[] {
  return React.useSyncExternalStore(
    (cb) => { _statusListeners.add(cb); return () => _statusListeners.delete(cb); },
    () => _statuses,
    () => _statuses,
  );
}
function statusColorKey(statuses: InvestorStatus[], name: string): string {
  return statuses.find((s) => s.name === name)?.color ?? "gray";
}
function statusChipClass(statuses: InvestorStatus[], name: string): string {
  return STATUS_COLOR_CLASSES[statusColorKey(statuses, name)] ?? STATUS_COLOR_CLASSES.gray;
}

/** Dot colour for a status — the accent used on cards and in the status tag. */
function statusDotClass(statuses: InvestorStatus[], name: string | null): string {
  if (!name) return "bg-zinc-300 dark:bg-zinc-600";
  return STATUS_DOT_CLASSES[statusColorKey(statuses, name)] ?? STATUS_DOT_CLASSES.gray;
}

/** Status as /crm renders it: a coloured dot beside plain text, not a pill. */
function InvestorStatusTag({ status, statuses }: { status: string | null; statuses: InvestorStatus[] }) {
  if (!status) return <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotClass(statuses, status)}`} />
      <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{status}</span>
    </span>
  );
}

// ── Investor types (dynamic, DB-backed) ──────────────────────────────────────

type InvestorTypeOption = { id: number; name: string; color: string; sort_order: number; investor_count?: number };

let _investorTypes: InvestorTypeOption[] = [
  { id: -1, name: "VC",                             color: "indigo", sort_order: 0 },
  { id: -2, name: "Angel (individual)",             color: "pink",   sort_order: 1 },
  { id: -3, name: "Angel (syndicate)",              color: "purple", sort_order: 2 },
  { id: -4, name: "Government (Equity Investment)", color: "blue",   sort_order: 3 },
  { id: -5, name: "Nonprofit (Equity Investment)",  color: "teal",   sort_order: 4 },
];
const _investorTypeListeners = new Set<() => void>();
async function refreshInvestorTypes() {
  try {
    const res = await fetch("/api/proxy/dilutive/investor-types");
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      _investorTypes = data;
      _investorTypeListeners.forEach((l) => l());
    }
  } catch { /* keep defaults */ }
}
function useInvestorTypes(): InvestorTypeOption[] {
  return React.useSyncExternalStore(
    (cb) => { _investorTypeListeners.add(cb); return () => _investorTypeListeners.delete(cb); },
    () => _investorTypes,
    () => _investorTypes,
  );
}
function investorTypeChipClass(types: InvestorTypeOption[], name: string): string {
  const color = types.find((t) => t.name === name)?.color ?? "gray";
  return STATUS_COLOR_CLASSES[color] ?? STATUS_COLOR_CLASSES.gray;
}

// ── Generic DB-backed option list (Focus, Stage, Funding Type) ───────────────

type NamedColorOption = {
  id: number; name: string; color: string; sort_order: number;
  investor_count?: number; opportunity_count?: number;
};

/** `path` is relative to /api/proxy — the non-dilutive vocabularies live under
 *  /funding, not /dilutive, so the module prefix cannot be assumed here. */
function makeOptionStore(path: string, defaults: NamedColorOption[]) {
  let options = defaults;
  const listeners = new Set<() => void>();
  async function refresh() {
    try {
      const res = await fetch(`/api/proxy/${path}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        options = data;
        listeners.forEach((l) => l());
      }
    } catch { /* keep defaults */ }
  }
  function useOptions(): NamedColorOption[] {
    return React.useSyncExternalStore(
      (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      () => options,
      () => options,
    );
  }
  return { refresh, useOptions };
}

function optionChipClass(options: NamedColorOption[], name: string): string {
  const color = options.find((o) => o.name.toLowerCase() === name.toLowerCase())?.color ?? "gray";
  return STATUS_COLOR_CLASSES[color] ?? STATUS_COLOR_CLASSES.gray;
}

const focusOptionsStore = makeOptionStore("dilutive/focus-options", [
  { id: -1, name: "Climate tech", color: "green",  sort_order: 0 },
  { id: -2, name: "Deep tech",    color: "indigo", sort_order: 1 },
  { id: -3, name: "Food System",  color: "orange", sort_order: 2 },
  { id: -4, name: "Impact tech",  color: "teal",   sort_order: 3 },
  { id: -5, name: "AgriTech",     color: "yellow", sort_order: 4 },
  { id: -6, name: "Generalist",   color: "gray",   sort_order: 5 },
  { id: -7, name: "Other",        color: "purple", sort_order: 6 },
]);
const refreshFocusOptions = focusOptionsStore.refresh;
const useFocusOptions = focusOptionsStore.useOptions;

const stageOptionsStore = makeOptionStore("dilutive/stage-options", [
  { id: -1, name: "Pre-seed",    color: "gray",   sort_order: 0 },
  { id: -2, name: "Seed",        color: "blue",   sort_order: 1 },
  { id: -3, name: "Series A",    color: "indigo", sort_order: 2 },
  { id: -4, name: "Series B",    color: "purple", sort_order: 3 },
  { id: -5, name: "Series B+",   color: "pink",   sort_order: 4 },
  { id: -6, name: "Series C",    color: "red",    sort_order: 5 },
  { id: -7, name: "Growth",      color: "orange", sort_order: 6 },
  { id: -8, name: "Later Stage", color: "yellow", sort_order: 7 },
  { id: -9, name: "Pre-IPO",     color: "teal",   sort_order: 8 },
]);
const refreshStageOptions = stageOptionsStore.refresh;
const useStageOptions = stageOptionsStore.useOptions;

// ── Funding types (non-dilutive instrument vocabulary) ───────────────────────
// Defaults mirror the seed in 125_funding_types so a cold render before the
// fetch lands shows the real list rather than an empty dropdown.

const fundingTypesStore = makeOptionStore("funding/funding-types", [
  { id: -1, name: "Grant",       color: "green",  sort_order: 0 },
  { id: -2, name: "Accelerator", color: "blue",   sort_order: 10 },
  { id: -3, name: "Competition", color: "purple", sort_order: 20 },
  { id: -4, name: "Fellowship",  color: "teal",   sort_order: 30 },
  { id: -5, name: "Prize",       color: "yellow", sort_order: 40 },
  { id: -6, name: "Loan",        color: "orange", sort_order: 50 },
  { id: -7, name: "Other",       color: "gray",   sort_order: 99 },
]);
const refreshFundingTypes = fundingTypesStore.refresh;
const useFundingTypes = fundingTypesStore.useOptions;

/** The other half of what funding_type used to mean. Two values and a blank —
 *  a lookup table would be ceremony, so this one stays a constant. */
const OPENERP_FIT_OPTIONS = ["Tier 1", "Tier 2", "Tier 3", "Unrated"] as const;

const RECORD_STATUS_OPTIONS = [
  "Unenriched", "Enriched (desk)", "Enriched (verified)", "Ineligible",
] as const;

const FIT_STYLES: Record<string, string> = {
  "Tier 1":  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "Tier 2":  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "Tier 3":  "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  "Unrated": "bg-zinc-50 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500",
};

/** Tier 1 is a direct thesis match; the chip is the fastest read on the board. */
function FitChip({ value }: { value: string | null | undefined }) {
  if (!value || value === "Unrated") return null;
  return (
    <span title={`Open ERP fit: ${value}`}
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${FIT_STYLES[value] ?? FIT_STYLES.Unrated}`}>
      {value}
    </span>
  );
}

type OpportunityDetails = {
  record_status: string;
  fit_rationale: string | null;
  equity_taken: string | null;
  focus_areas: string | null;
  application_requirements: string | null;
  program_contact: string | null;
  sources: string | null;
  data_gaps: string | null;
};

const DILUTION_OPTIONS = [
  { value: "non-dilutive", label: "Non-Dilutive" },
  { value: "dilutive",     label: "Dilutive" },
] as const;

function dilutionLabel(v: string | null | undefined): string | null {
  return DILUTION_OPTIONS.find((d) => d.value === v)?.label ?? null;
}

/** Reads the vocabulary itself rather than taking it as a prop, so the kanban
 *  card, the table row and the detail header cannot drift apart on colour. */
function FundingTypeChip({ value, className = "" }: { value: string | null | undefined; className?: string }) {
  const types = useFundingTypes();
  if (!value) return null;
  return (
    <span title={`Funding type: ${value}`}
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${optionChipClass(types, value)} ${className}`}>
      {value}
    </span>
  );
}

/** Deliberately quieter than the type chip: dilution is a qualifier on the
 *  instrument, not a peer of it, and two loud badges per row read as noise. */
function DilutionTag({ value }: { value: string | null | undefined }) {
  const label = dilutionLabel(value);
  if (!label) return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${
      value === "dilutive"
        ? "border-indigo-200 text-indigo-600 dark:border-indigo-800/60 dark:text-indigo-300"
        : "border-emerald-200 text-emerald-600 dark:border-emerald-800/60 dark:text-emerald-300"
    }`}>
      {label}
    </span>
  );
}

const TAG_COLORS: Record<string, string> = {
  "grant":             "#16a34a",
  "pitch competition": "#7c3aed",
  "accelerator":       "#0284c7",
  "partnership":       "#d97706",
  "africa funding":    "#dc2626",
  "vc":                "#6366f1",
  "cvc":               "#0891b2",
  "angel":             "#db2777",
};

function tagColor(tag: string) {
  return TAG_COLORS[tag.toLowerCase()] ?? "#6b7280";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function isOverdue(d: string | null) {
  if (!d) return false;
  return new Date(d + "T00:00:00") < new Date();
}

function isLinkUrl(s: string | null) {
  if (!s) return false;
  return s.startsWith("http://") || s.startsWith("https://");
}

// ── Money ────────────────────────────────────────────────────────────────────
// amount is NUMERIC and amount_currency is an ISO code (126_funding_amount).
// Eleven records are not USD, so the symbol is never assumed.

const CURRENCIES = ["USD", "EUR", "GBP", "CHF", "CAD", "AUD", "JPY"] as const;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", CHF: "CHF ", CAD: "C$", AUD: "A$", JPY: "¥",
};

function currencySymbol(code: string | null | undefined) {
  return CURRENCY_SYMBOLS[code || "USD"] ?? "$";
}

/** Whole dollars, thousands separated — awards are never quoted to the cent,
 *  and '$250,000' beside '$1,500' is the comparison the board is actually for. */
function fmtAward(amount: number | null | undefined, currency?: string | null) {
  if (amount === null || amount === undefined) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return currencySymbol(currency) + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Apply a fixed width to a class string that already carries `w-full`.
 *
 *  Tailwind resolves conflicting utilities by their order in the generated
 *  stylesheet, not by their order in the class attribute — and `.w-full` is
 *  emitted after every numbered width. So `inputCls + " w-24"` silently loses
 *  and the control renders full width regardless. The base width has to go. */
function fixedWidth(base: string, w: string) {
  return base.replace(/\bw-full\b/, "").trim() + " " + w;
}

/** The money control: currency, the figure, and a note underneath for what a
 *  figure cannot say — an equity stake, an in-kind award, a range, a condition.
 *  All of that used to be crammed into the amount string itself. */
function MoneyField({ amount, currency, notes, onChange, inputCls }: {
  amount: string;
  currency: string;
  notes: string;
  onChange: (patch: { amount?: string; amount_currency?: string; amount_notes?: string }) => void;
  inputCls: string;
}) {
  const sym = currencySymbol(currency).trim();
  // A three-letter code would collide with the field's own padding; those
  // currencies are named by the select beside it instead.
  const inline = sym.length <= 2;
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {/* StyledSelect puts the class string on the <select> but wraps it in a
            div, and that div is the flex item. While the string said w-full the
            wrapper was full width and shrink-0 landed on the wrong element, so
            the currency box ate the row and the figure was squeezed to nothing. */}
        <div className="shrink-0">
          <StyledSelect value={currency || "USD"}
            onChange={(e) => onChange({ amount_currency: e.target.value })}
            className={fixedWidth(inputCls, "w-[86px]")}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </StyledSelect>
        </div>
        {/* min-w-0 is load-bearing: a flex item defaults to min-width:auto, and
            an <input>'s intrinsic width is ~20 characters. Without it the figure
            box refuses to shrink, overflows the column and gets clipped — the
            amount you typed scrolls out of sight. */}
        <div className="relative flex-1 min-w-0">
          {inline && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
              {sym}
            </span>
          )}
          {/* Spinner arrows steal ~20px from a box that is already tight, and a
              scroll wheel over them silently changes a funding figure. */}
          <input type="number" min="0" step="any" inputMode="decimal"
            value={amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            className={inputCls + " min-w-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              + (inline ? " pl-7" : "")} placeholder="100000" />
        </div>
      </div>
      <input type="text" value={notes}
        onChange={(e) => onChange({ amount_notes: e.target.value })}
        className={inputCls + " text-xs"}
        placeholder="Notes — range, equity stake, in-kind benefits…" />
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => {
        const c = tagColor(tag);
        return (
          <span key={tag}
            className="text-[10px] px-1.5 py-0.5 rounded border font-medium"
            style={{ backgroundColor: c + "22", color: c, borderColor: c + "55" }}>
            {tag}
          </span>
        );
      })}
    </div>
  );
}

/** Cards show the first few tags and a +N chip for the rest. Clicking the chip
 *  expands them in place — a quick look without opening the record. The chip
 *  used to carry the overflow in a `title` alone, which is unreadable on touch
 *  and gone by the time the pointer arrives anywhere useful. */
function CardTags({ tags, limit = CARD_TAG_LIMIT, className = "" }: {
  tags: string[]; limit?: number; className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (tags.length === 0) return null;

  const hidden = tags.length - limit;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <TagList tags={expanded ? tags : tags.slice(0, limit)} />
      {hidden > 0 && (
        <button
          type="button"
          // The card itself opens the detail panel; expanding tags must not.
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          title={expanded ? "Show fewer" : tags.slice(limit).join(", ")}
          className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:border-zinc-400 hover:text-zinc-600 dark:hover:border-zinc-500 dark:hover:text-zinc-300 transition-colors">
          {expanded ? "− less" : `+${hidden}`}
        </button>
      )}
    </div>
  );
}

// ── Inline cell editor ─────────────────────────────────────────────────────────

function InlineText({
  value,
  placeholder,
  onCommit,
  onCancel,
  className = "",
  multiline = false,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  className?: string;
  multiline?: boolean;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const base = "w-full text-xs px-1.5 py-0.5 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-[80px]";

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onCommit((e.target as HTMLInputElement).value); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  }

  if (multiline) {
    return (
      <AutoTextarea ref={ref as React.RefObject<HTMLTextAreaElement>}
        defaultValue={value} placeholder={placeholder}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={handleKey}
        rows={2}
        className={`${base} ${className} resize-none`} />
    );
  }
  return (
    <input ref={ref as React.RefObject<HTMLInputElement>}
      type="text" defaultValue={value} placeholder={placeholder}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={handleKey}
      className={`${base} ${className}`} />
  );
}

function InlineDate({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input ref={ref} type="date" defaultValue={value}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onCommit((e.target as HTMLInputElement).value); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      className="text-xs px-1.5 py-0.5 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
  );
}

function StyledSelect({
  className = "", children, ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const fullWidth = className.includes("w-full");
  return (
    <div className={`relative ${fullWidth ? "block w-full" : "inline-block"}`}>
      <select {...rest} className={`${className} appearance-none pr-8 ${rest.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
        {children}
      </select>
      <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}

function InlineSelect({
  value,
  options,
  onCommit,
  onCancel,
}: {
  value: string;
  options: string[];
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <select ref={ref}
      defaultValue={value}
      onChange={(e) => onCommit(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      className="w-full max-w-full text-xs px-1.5 py-0.5 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 truncate">
      {options.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
    </select>
  );
}

// Wrapper that turns any cell into a click-to-edit cell
function EditableCell({
  rowId, field, editing, value, onStartEdit, onCommit, onCancel,
  display, editType = "text", selectOptions = [], placeholder, multiline = false,
  className = "",
}: {
  rowId: string;
  field: string;
  editing: EditingCell;
  value: string;
  onStartEdit: (id: string, field: string, value: string) => void;
  onCommit: (id: string, field: string, value: string) => void;
  onCancel: () => void;
  display: React.ReactNode;
  editType?: "text" | "select" | "date";
  selectOptions?: string[];
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const isEditing = editing?.id === rowId && editing?.field === field;

  if (isEditing) {
    if (editType === "select") {
      return (
        <td className={`px-4 py-2 ${className}`}>
          <InlineSelect
            value={editing!.value}
            options={selectOptions}
            onCommit={(v) => onCommit(rowId, field, v)}
            onCancel={onCancel}
          />
        </td>
      );
    }
    if (editType === "date") {
      return (
        <td className={`px-2 py-1 ${className}`}>
          <InlineDate
            value={editing!.value}
            onCommit={(v) => onCommit(rowId, field, v)}
            onCancel={onCancel}
          />
        </td>
      );
    }
    return (
      <td className={`px-4 py-2 ${className}`}>
        <InlineText
          value={editing!.value}
          placeholder={placeholder}
          onCommit={(v) => onCommit(rowId, field, v)}
          onCancel={onCancel}
          multiline={multiline}
        />
      </td>
    );
  }

  return (
    <td
      className={`px-4 py-2 cursor-text group/cell ${className}`}
      onClick={() => onStartEdit(rowId, field, value)}
      title="Click to edit"
    >
      <div className="relative">
        {display}
        <span className="absolute -top-0.5 -right-0.5 opacity-0 group-hover/cell:opacity-40 transition-opacity">
          <svg className="w-2.5 h-2.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15H9v-2.828z" />
          </svg>
        </span>
      </div>
    </td>
  );
}

// ── Delete confirm ─────────────────────────────────────────────────────────────

function DeleteConfirm({ title, onConfirm, onCancel }: {
  title: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-sm p-6">
        <p className="text-sm text-gray-800 dark:text-gray-200 mb-1 font-medium">Delete?</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-5">{title}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">Delete</button>
        </div>
      </div>
    </div>
  );
}

// ── Add Opportunity Modal ──────────────────────────────────────────────────────

const EMPTY_OPP_FORM = {
  title: "", stage: "New", deadline: "", deadline_time: "", tags: "",
  funding_type: "", dilution: "",
  amount: "", amount_currency: "USD", amount_notes: "",
  decision_date: "", funding_dispersion: "", source_link: "", notes: "",
};

function AddOpportunityModal({ onClose, onSaved, initialStage }: { onClose: () => void; onSaved: () => void; initialStage?: string }) {
  const [form, setForm] = useState({ ...EMPTY_OPP_FORM, stage: initialStage ?? EMPTY_OPP_FORM.stage });
  const fundingTypes = useFundingTypes();
  const [saving, setSaving] = useState(false);
  function set(field: string, value: string) { setForm((f) => ({ ...f, [field]: value })); }

  async function save() {
    if (!form.title.trim()) return;
    setSaving(true);
    await fetch("/api/proxy/funding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title.trim(), stage: form.stage,
        deadline: form.deadline || null,
        deadline_time: form.deadline_time || null,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        funding_type: form.funding_type || null,
        dilution: form.dilution || null,
        amount: form.amount === "" ? null : Number(form.amount),
        amount_currency: form.amount_currency || "USD",
        amount_notes: form.amount_notes.trim() || null,
        decision_date: form.decision_date || null,
        funding_dispersion: form.funding_dispersion || null,
        source_link: form.source_link || null, notes: form.notes || null,
      }),
    });
    setSaving(false); onSaved(); onClose();
  }

  const inputCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Add Opportunity</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title *</label>
            <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} className={inputCls} placeholder="Grant / competition name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Stage</label>
              <StyledSelect value={form.stage} onChange={(e) => set("stage", e.target.value)} className={inputCls}>
                {STAGES.map((s) => <option key={s}>{s}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Funding Type</label>
              <StyledSelect value={form.funding_type} onChange={(e) => set("funding_type", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {fundingTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Dilution</label>
              <StyledSelect value={form.dilution} onChange={(e) => set("dilution", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {DILUTION_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </StyledSelect>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Deadline</label>
            <div className="flex gap-1">
              <input type="date" value={form.deadline} onChange={(e) => set("deadline", e.target.value)} className={inputCls + " flex-1 min-w-0"} />
              {/* Wide enough for "12:00 PM" and not a pixel more. */}
              <input type="time" value={form.deadline_time} onChange={(e) => set("deadline_time", e.target.value)} className={fixedWidth(inputCls, "w-[124px]") + " shrink-0"} />
            </div>
          </div>
          {/* Amount takes the full row. Sharing it with the deadline left the
              figure roughly 130px once the currency select was subtracted —
              a seven-figure award did not fit, and neither did the note. */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Amount</label>
            <MoneyField amount={form.amount} currency={form.amount_currency}
              notes={form.amount_notes} inputCls={inputCls}
              onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Decision Date</label>
              <input type="text" value={form.decision_date} onChange={(e) => set("decision_date", e.target.value)} className={inputCls} placeholder="Mid-July" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Funding Dispersion</label>
              <input type="text" value={form.funding_dispersion} onChange={(e) => set("funding_dispersion", e.target.value)} className={inputCls} placeholder="End of August…" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tags (comma-separated)</label>
            <input type="text" value={form.tags} onChange={(e) => set("tags", e.target.value)} className={inputCls} placeholder="Grant, Accelerator…" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Link</label>
            <input type="text" value={form.source_link} onChange={(e) => set("source_link", e.target.value)} className={inputCls} placeholder="https://…" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} className={inputCls} placeholder="Additional context…" />
          </div>
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
          <button onClick={save} disabled={saving || !form.title.trim()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving…" : "Add Opportunity"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add Investor Modal ─────────────────────────────────────────────────────────

const EMPTY_INV_FORM = {
  status: "", name: "", role: "", firm: "", investor_type: "",
  intro_type: "", intro_notes: "", email: "", notes: "",
  office_phone: "", cell_phone: "", tags: "", avg_check_size: "", source_link: "",
};

function AddInvestorModal({ onClose, onSaved, initialStatus, initialStage, initialPriority }: {
  onClose: () => void; onSaved: () => void;
  initialStatus?: string; initialStage?: string; initialPriority?: boolean;
}) {
  const statuses = useInvestorStatuses();
  const investorTypes = useInvestorTypes();
  const [form, setForm] = useState({ ...EMPTY_INV_FORM, status: initialStatus ?? EMPTY_INV_FORM.status });
  const [saving, setSaving] = useState(false);
  function set(field: string, value: string) { setForm((f) => ({ ...f, [field]: value })); }
  const isIndividual = /individual/i.test(form.investor_type);

  async function save() {
    setSaving(true);
    await fetch("/api/proxy/dilutive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: form.status || null,
        pipeline_stage: initialStage ?? "Lead",
        is_priority: initialPriority ?? false,
        name: form.name || null,
        // An individual angel has no firm and no role in one — never send
        // values typed before the type was switched.
        role: isIndividual ? null : (form.role || null),
        firm: isIndividual ? null : (form.firm || null),
        investor_type: form.investor_type || null,
        intro_type: form.intro_type || null, intro_notes: form.intro_notes || null,
        email: form.email || null, notes: form.notes || null,
        office_phone: form.office_phone || null, cell_phone: form.cell_phone || null,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        avg_check_size: form.avg_check_size || null, source_link: form.source_link || null,
      }),
    });
    setSaving(false); onSaved(); onClose();
  }

  const inputCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Add Investor</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Status</label>
              <StyledSelect value={form.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {statuses.map((s) => <option key={s.name}>{s.name}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Type</label>
              <StyledSelect value={form.investor_type} onChange={(e) => set("investor_type", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {investorTypes.map((t) => <option key={t.id}>{t.name}</option>)}
              </StyledSelect>
            </div>
          </div>
          {/* An individual angel has no firm and no role within one, so the
              form drops both rather than asking for something that cannot exist. */}
          {isIndividual ? (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name</label>
              <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)}
                className={inputCls} placeholder="Angel&apos;s name" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Name</label>
                  <input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} placeholder="Contact name" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Role</label>
                  <input type="text" value={form.role} onChange={(e) => set("role", e.target.value)} className={inputCls} placeholder="Partner, Associate…" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Firm</label>
                <input type="text" value={form.firm} onChange={(e) => set("firm", e.target.value)} className={inputCls} placeholder="Firm name" />
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Intro Type</label>
              <StyledSelect value={form.intro_type} onChange={(e) => set("intro_type", e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option>Warm</option>
                <option>Cold</option>
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Avg. Check Size</label>
              <input type="text" value={form.avg_check_size} onChange={(e) => set("avg_check_size", e.target.value)} className={inputCls} placeholder="$500K, $1–5M…" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Intro Notes</label>
            <input type="text" value={form.intro_notes} onChange={(e) => set("intro_notes", e.target.value)} className={inputCls} placeholder="How the intro was made…" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email</label>
            <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={inputCls} placeholder="investor@firm.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Office Phone</label>
              <input type="text" value={form.office_phone} onChange={(e) => set("office_phone", e.target.value)} className={inputCls} placeholder="(312) 555-0100" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Cell Phone</label>
              <input type="text" value={form.cell_phone} onChange={(e) => set("cell_phone", e.target.value)} className={inputCls} placeholder="(312) 555-0101" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tags (comma-separated)</label>
            <input type="text" value={form.tags} onChange={(e) => set("tags", e.target.value)} className={inputCls} placeholder="VC, Agri-Food…" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Link</label>
            <input type="text" value={form.source_link} onChange={(e) => set("source_link", e.target.value)} className={inputCls} placeholder="https://…" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} className={inputCls} placeholder="Additional context…" />
          </div>
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving…" : "Add Investor"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Gantt View ─────────────────────────────────────────────────────────────────

const G_DAY_PX = 28;
const G_ROW_H  = 40;
const G_LABEL_W = 240;

function addDays(d: Date, n: number) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function dateToIso(d: Date) { return d.toISOString().slice(0, 10); }

function FundingGanttView({ rows, onPatch }: {
  rows: Opportunity[];
  onPatch: (id: string, patch: Record<string, unknown>) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef   = useRef<{ id: string; type: "move" | "resize"; startX: number; origStart: number; origDue: number; rangeStartMs: number } | null>(null);
  const [preview, setPreview] = useState<Record<string, { start: number; due: number }>>({});
  const previewRef = useRef<Record<string, { start: number; due: number }>>({});
  useEffect(() => { previewRef.current = preview; }, [preview]);

  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);

  const { rangeStart, totalDays } = useMemo(() => {
    const ms: number[] = [today.getTime()];
    for (const r of rows) {
      if (r.deadline) ms.push(new Date(r.deadline + "T00:00:00").getTime());
    }
    const minMs = Math.min(...ms) - 14 * 86400000;
    const maxMs = Math.max(...ms) + 30 * 86400000;
    const rs = new Date(minMs); rs.setHours(0,0,0,0);
    return { rangeStart: rs, totalDays: Math.max(60, Math.ceil((maxMs - rs.getTime()) / 86400000)) };
  }, [rows, today]);

  const todayDay = useMemo(() =>
    Math.floor((today.getTime() - rangeStart.getTime()) / 86400000),
    [today, rangeStart]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, (todayDay - 5) * G_DAY_PX);
  }, [todayDay]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current; if (!d) return;
      const delta = Math.round((e.clientX - d.startX) / G_DAY_PX);
      let ns = d.origStart, nd = d.origDue;
      if (d.type === "move") { ns += delta; nd += delta; }
      else { nd = Math.max(d.origStart + 1, d.origDue + delta); }
      setPreview(p => ({ ...p, [d.id]: { start: ns, due: nd } }));
    }
    function onUp() {
      const d = dragRef.current; if (!d) return;
      const p = previewRef.current[d.id];
      if (p && (p.start !== d.origStart || p.due !== d.origDue)) {
        const rs = new Date(d.rangeStartMs);
        onPatch(d.id, { deadline: dateToIso(addDays(rs, p.due)) });
      }
      dragRef.current = null;
      setPreview(p => { const n = { ...p }; if (d) delete n[d.id]; return n; });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [onPatch]);

  function getDeadlineDay(opp: Opportunity): number | null {
    const p = preview[opp.opportunity_id];
    if (p) return p.due;
    if (!opp.deadline) return null;
    const dd = new Date(opp.deadline + "T00:00:00"); dd.setHours(0,0,0,0);
    return Math.floor((dd.getTime() - rangeStart.getTime()) / 86400000);
  }

  function startDrag(e: React.PointerEvent, id: string, type: "move" | "resize", sd: number, dd: number) {
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { id, type, startX: e.clientX, origStart: sd, origDue: dd, rangeStartMs: rangeStart.getTime() };
  }

  const monthHeaders = useMemo(() => {
    const result: { label: string; x: number; width: number }[] = [];
    let curr = new Date(rangeStart);
    const end = addDays(rangeStart, totalDays);
    while (curr < end) {
      const mStart = Math.floor((curr.getTime() - rangeStart.getTime()) / 86400000);
      const next = new Date(curr.getFullYear(), curr.getMonth() + 1, 1);
      const mEnd = next < end ? next : end;
      result.push({
        label: curr.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        x: mStart * G_DAY_PX,
        width: Math.ceil((mEnd.getTime() - curr.getTime()) / 86400000) * G_DAY_PX,
      });
      curr = next;
    }
    return result;
  }, [rangeStart, totalDays]);

  const timelineW = totalDays * G_DAY_PX;
  const datedRows  = rows.filter(r => r.deadline !== null);
  const undatedRows = rows.filter(r => !r.deadline);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-gray-400 dark:text-gray-500">No opportunities to display.</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden select-none">
      <div ref={scrollRef} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 280px)" }}>
        <div style={{ display: "inline-block", minWidth: "100%", width: G_LABEL_W + timelineW }}>
          {/* Header */}
          <div className="flex sticky top-0 z-20 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <div className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-800/60 border-r border-gray-200 dark:border-gray-700 flex items-end pb-2 px-4"
              style={{ width: G_LABEL_W, minWidth: G_LABEL_W, height: 52 }}>
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Opportunity</span>
            </div>
            <div style={{ position: "relative", width: timelineW, flexShrink: 0, height: 52 }}>
              {monthHeaders.map((m, i) => (
                <div key={i} style={{ position: "absolute", left: m.x, width: m.width, top: 0, height: 26 }}
                  className="border-r border-gray-200 dark:border-gray-700 px-2 flex items-center">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">{m.label}</span>
                </div>
              ))}
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 26, display: "flex" }}>
                {Array.from({ length: totalDays }, (_, i) => {
                  const d = addDays(rangeStart, i);
                  const isToday = i === todayDay;
                  const isWknd = d.getDay() === 0 || d.getDay() === 6;
                  const show = totalDays < 90 ? true : i % 7 === 0 || d.getDate() === 1;
                  return (
                    <div key={i} style={{ width: G_DAY_PX, flexShrink: 0 }}
                      className={`border-l border-gray-100 dark:border-gray-800 flex items-center justify-center ${isWknd ? "bg-gray-50/60 dark:bg-gray-800/30" : ""}`}>
                      {show && (
                        <span className={`text-[10px] ${isToday ? "text-blue-600 font-bold" : isWknd ? "text-gray-300 dark:text-gray-600" : "text-gray-400 dark:text-gray-600"}`}>
                          {d.getDate()}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Dated rows grouped by stage */}
          {STAGES.map(stage => {
            const stageRows = datedRows.filter(r => r.stage === stage);
            if (stageRows.length === 0) return null;
            return (
              <div key={stage}>
                <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/40" style={{ height: 28 }}>
                  <div className="sticky left-0 z-10 bg-gray-50/80 dark:bg-gray-800/40 flex items-center px-4 gap-2"
                    style={{ width: G_LABEL_W, minWidth: G_LABEL_W }}>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${STAGE_STYLES[stage] ?? "bg-gray-100 text-gray-600"}`}>{stage}</span>
                    <span className="text-[10px] text-gray-400">{stageRows.length}</span>
                  </div>
                  <div style={{ width: timelineW }} />
                </div>
                {stageRows.map(opp => {
                  const dueDay = getDeadlineDay(opp);
                  if (dueDay === null) return null;
                  const overdue = isOverdue(opp.deadline);
                  const won = opp.stage === "Won";
                  const rejected = opp.stage === "Rejected" || opp.stage === "Withdrawn";
                  const markerX = dueDay * G_DAY_PX + G_DAY_PX / 2;

                  let markerColor = "#3b82f6"; // blue
                  if (won)             markerColor = "#22c55e"; // green
                  else if (rejected)   markerColor = "#9ca3af"; // gray
                  else if (overdue)    markerColor = "#ef4444"; // red
                  else if (opp.stage === "New")         markerColor = "#a78bfa"; // violet
                  else if (opp.stage === "In Progress") markerColor = "#f59e0b"; // amber

                  const timeLabel = opp.deadline_time ? ` ${opp.deadline_time}` : "";

                  return (
                    <div key={opp.opportunity_id} className="flex border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50/30 dark:hover:bg-gray-800/20 group"
                      style={{ height: G_ROW_H }}>
                      <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3"
                        style={{ width: G_LABEL_W, minWidth: G_LABEL_W }}>
                        <span className={`text-xs truncate flex-1 font-medium ${rejected ? "line-through text-gray-400" : "text-gray-800 dark:text-gray-100"}`}>
                          {opp.title}
                        </span>
                        {opp.deadline && (
                          <span className={`text-[10px] flex-shrink-0 font-medium ${overdue && !rejected ? "text-red-500" : "text-gray-400"}`}>
                            {fmtDate(opp.deadline)}{timeLabel}
                          </span>
                        )}
                      </div>
                      <div style={{ position: "relative", width: timelineW, flexShrink: 0 }}>
                        {/* Today line */}
                        <div style={{ position: "absolute", left: todayDay * G_DAY_PX, top: 0, bottom: 0, width: 1, zIndex: 1, pointerEvents: "none" }}
                          className="bg-blue-400/50" />
                        {/* Weekend shading */}
                        {Array.from({ length: totalDays }, (_, i) => {
                          const d = addDays(rangeStart, i);
                          if (d.getDay() !== 0 && d.getDay() !== 6) return null;
                          return <div key={i} style={{ position: "absolute", left: i * G_DAY_PX, top: 0, bottom: 0, width: G_DAY_PX, pointerEvents: "none" }}
                            className="bg-gray-50/50 dark:bg-gray-800/20" />;
                        })}
                        {/* Deadline marker — draggable vertical pin */}
                        <div
                          style={{ position: "absolute", left: markerX - 1, top: 0, bottom: 0, width: 2, zIndex: 2, cursor: "grab", background: markerColor + "60" }}
                          onPointerDown={e => startDrag(e, opp.opportunity_id, "move", dueDay, dueDay)}
                        />
                        {/* Diamond marker at deadline */}
                        <div
                          style={{
                            position: "absolute",
                            left: markerX - 7,
                            top: G_ROW_H / 2 - 7,
                            width: 14, height: 14,
                            background: markerColor,
                            transform: "rotate(45deg)",
                            zIndex: 3,
                            cursor: "grab",
                            borderRadius: 2,
                          }}
                          title={`${opp.title} — ${opp.deadline}${timeLabel}`}
                          onPointerDown={e => startDrag(e, opp.opportunity_id, "move", dueDay, dueDay)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Undated rows */}
          {undatedRows.length > 0 && (
            <>
              <div className="flex border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/40" style={{ height: 28 }}>
                <div className="sticky left-0 z-10 bg-gray-50/80 dark:bg-gray-800/40 flex items-center px-4"
                  style={{ width: G_LABEL_W, minWidth: G_LABEL_W }}>
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">No deadline</span>
                </div>
                <div style={{ width: timelineW }} />
              </div>
              {undatedRows.map(opp => (
                <div key={opp.opportunity_id} className="flex border-b border-gray-100 dark:border-gray-800" style={{ height: G_ROW_H }}>
                  <div className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex items-center gap-2 px-3"
                    style={{ width: G_LABEL_W, minWidth: G_LABEL_W }}>
                    <span className="text-xs truncate text-gray-500 dark:text-gray-400">{opp.title}</span>
                  </div>
                  <div style={{ width: timelineW }} className="flex items-center px-4">
                    <span className="text-xs text-gray-400 italic">Set a deadline to appear on chart</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Kanban column configs ──────────────────────────────────────────────────────

// ── Non-dilutive application stages ───────────────────────────────────────────
// The same six stages the list and gantt already use — only the board's
// presentation changed, to match the column treatment in /crm and on the
// investor board. "Not Applied" stays the display label for Withdrawn, and the
// two terminal columns ship collapsed as they do on the other two boards.

type NonDilStage = {
  id: string;
  label: string;
  autoCollapse?: boolean;
  description: string;
  requirements: string;
  color: { header: string; card: string; dot: string; bg: string };
};

const NONDIL_KANBAN_COLS: NonDilStage[] = [
  {
    id: "New",
    label: "New",
    description: "A funding opportunity has been found but not yet weighed against our programme fit, budget or timeline.",
    requirements: "To In Progress: screened as a fit, an owner assigned, and the deadline confirmed.",
    color: {
      header: "text-violet-600 dark:text-violet-300",
      card: "border-violet-200 dark:border-violet-800/40",
      dot: "bg-violet-500",
      bg: "bg-violet-50 dark:bg-violet-900/10",
    },
  },
  {
    id: "In Progress",
    label: "In Progress",
    description: "Actively being worked — narrative, budget and supporting documents in preparation ahead of the deadline.",
    requirements: "To Applied: the full application has been submitted and the submission confirmed by the funder.",
    color: {
      header: "text-amber-600 dark:text-amber-300",
      card: "border-amber-200 dark:border-amber-800/40",
      dot: "bg-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/10",
    },
  },
  {
    id: "Applied",
    label: "Applied",
    description: "Submitted and waiting on the funder's decision.",
    requirements: "To Won or Rejected: the funder's decision has been received in writing.",
    color: {
      header: "text-blue-600 dark:text-blue-300",
      card: "border-blue-200 dark:border-blue-800/40",
      dot: "bg-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/10",
    },
  },
  {
    id: "Won",
    label: "Won",
    description: "Awarded. The money is committed and the work moves to delivery.",
    requirements: "Terminal stage. Track the award and its reporting obligations on the linked Grant project.",
    color: {
      header: "text-green-600 dark:text-green-300",
      card: "border-green-200 dark:border-green-800/40",
      dot: "bg-green-500",
      bg: "bg-green-50 dark:bg-green-900/10",
    },
  },
  {
    id: "Rejected",
    label: "Rejected",
    autoCollapse: true,
    description: "The funder declined the application.",
    requirements: "Terminal stage. Record the feedback while it is fresh — re-applying next cycle starts a new opportunity.",
    color: {
      header: "text-red-600 dark:text-red-400",
      card: "border-red-200 dark:border-red-800/40",
      dot: "bg-red-500",
      bg: "bg-red-50 dark:bg-red-900/10",
    },
  },
  {
    id: "Withdrawn",
    label: "Not Applied",
    autoCollapse: true,
    description: "Not pursued — the deadline passed, the fit was wrong, or the application was pulled before submission.",
    requirements: "Terminal stage. Drag back to New or In Progress if the programme reopens.",
    color: {
      header: "text-gray-500 dark:text-gray-400",
      card: "border-gray-200 dark:border-gray-700/40",
      dot: "bg-gray-400",
      bg: "bg-gray-50 dark:bg-gray-900/10",
    },
  },
];

/** Tags shown on a board card before the rest roll into a "+N" chip. Keeps a
 *  13-tag row the same height as a 1-tag row. */
const CARD_TAG_LIMIT = 3;

function nonDilStage(id: string): NonDilStage {
  return NONDIL_KANBAN_COLS.find(c => c.id === id) ?? NONDIL_KANBAN_COLS[0];
}

/** Deadline-derived urgency — the non-dilutive stand-in for the CRM's
 *  server-computed urgency flag. The terminal stages own their colour; for
 *  everything else the deadline is the only thing that makes a card urgent. */
function nonDilUrgency(opp: Opportunity): { cls: string; label: string } {
  if (opp.stage === "Won")       return { cls: "bg-emerald-600", label: "Won" };
  if (opp.stage === "Rejected")  return { cls: "bg-zinc-400", label: "Rejected" };
  if (opp.stage === "Withdrawn") return { cls: "bg-zinc-400", label: "Not applied" };
  // Submitted — the deadline is behind us by definition, so counting down to it
  // (or flagging it passed) would be noise. The decision is what's pending now.
  if (opp.stage === "Applied")   return { cls: "bg-blue-500", label: "Submitted" };
  if (!opp.deadline)             return { cls: "bg-zinc-300 dark:bg-zinc-600", label: "No deadline set" };
  const days = Math.round(
    (new Date(opp.deadline + "T00:00:00").getTime() - new Date(new Date().toDateString()).getTime()) / 86400000,
  );
  if (days < 0)  return { cls: "bg-red-500", label: "Deadline passed" };
  if (days <= 7) return { cls: "bg-amber-400", label: `${days}d to deadline` };
  return { cls: "bg-green-500", label: `${days}d to deadline` };
}

// ── Investor pipeline stages ──────────────────────────────────────────────────
// Fixed ladder mirroring the contract pipeline in /crm. "Lead" is the holding
// pen for the un-worked import and shows only on the All Investors board; the
// Priority board starts at Prospect. The two closed stages ship collapsed.

type InvestorStage = {
  id: string;
  /** Holding pen only — never gets a board column. */
  leadOnly?: boolean;
  autoCollapse?: boolean;
  /** What the stage means. */
  description: string;
  /** What has to be true before a card leaves this stage. */
  requirements: string;
  color: { header: string; card: string; dot: string; bg: string };
};

/** A way a deal can end. Options are rows on the server, and the colour comes
 *  with them — the group decides it, so a reason added there tomorrow renders
 *  correctly here with no change. */
type CloseReason = {
  code: string;
  label: string;
  reason_group: "revisit" | "lost";
  group_label: string;
  fill: string;
  text_color: string;
  stage: string;
  requires_revisit: boolean;
  excludes_reporting: boolean;
};

let _closeReasons: CloseReason[] = [];
const _closeReasonListeners = new Set<() => void>();
let _closeReasonsLoaded = false;

function useCloseReasons(): CloseReason[] {
  const reasons = React.useSyncExternalStore(
    (cb) => { _closeReasonListeners.add(cb); return () => _closeReasonListeners.delete(cb); },
    () => _closeReasons,
    () => _closeReasons,
  );
  useEffect(() => {
    if (_closeReasonsLoaded) return;
    _closeReasonsLoaded = true;
    fetch("/api/proxy/dilutive/close-reasons")
      .then(r => r.ok ? r.json() : [])
      .then(d => { if (Array.isArray(d)) { _closeReasons = d; _closeReasonListeners.forEach(l => l()); } })
      .catch(() => {});
  }, []);
  return reasons;
}

/** The ending badge, wherever a record shows one. Colour is whatever the group
 *  says it is, never chosen per option. */
function CloseReasonBadge({ code, className = "" }: { code: string | null | undefined; className?: string }) {
  const reasons = useCloseReasons();
  const r = reasons.find(x => x.code === code);
  if (!r) return null;
  return (
    <span title={`${r.group_label} · ${r.label}`}
      style={{ backgroundColor: r.fill, color: r.text_color }}
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${className}`}>
      {r.label}
    </span>
  );
}

const INVESTOR_STAGES: InvestorStage[] = [
  {
    id: "Lead",
    leadOnly: true,
    description: "Investors in the database that have not yet been screened against our thesis or worked.",
    requirements: "To move to Prospect: screened as a fit for our thesis and funding stage, and starred as a priority investor.",
    color: {
      header: "text-slate-600 dark:text-slate-300",
      card: "border-slate-200 dark:border-slate-700/40",
      dot: "bg-slate-400",
      bg: "bg-slate-50 dark:bg-slate-900/10",
    },
  },
  {
    id: "Prospect",
    description: "Investors identified to fit with our thesis and funding stage.",
    requirements: "To move to Qualification: initial email or application sent and response received. Initial meeting scheduled.",
    color: {
      header: "text-blue-600 dark:text-blue-300",
      card: "border-blue-200 dark:border-blue-800/40",
      dot: "bg-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/10",
    },
  },
  {
    id: "Qualification",
    description: "Investors that have responded to initial outreach, demonstrated interest, and scheduled an initial meeting.",
    requirements: "To move to Negotiation or Closed Lost: initial meeting completed, primary contact information filled out.",
    color: {
      header: "text-purple-600 dark:text-purple-300",
      card: "border-purple-200 dark:border-purple-800/40",
      dot: "bg-purple-500",
      bg: "bg-purple-50 dark:bg-purple-900/10",
    },
  },
  {
    id: "Negotiation",
    description: "Investors actively working towards a term sheet — diligence, terms and check size under discussion.",
    requirements: "To move to Closed Won: terms agreed and commitment confirmed in writing. To move to Closed Lost: the investor passes or goes cold.",
    color: {
      header: "text-orange-600 dark:text-orange-300",
      card: "border-orange-200 dark:border-orange-800/40",
      dot: "bg-orange-500",
      bg: "bg-orange-50 dark:bg-orange-900/10",
    },
  },
  {
    id: "Nurture",
    description: "Ended for now, with a date to come back. Not lost — waiting on a trigger.",
    requirements: "To move back into the pipeline: the revisit trigger has happened, or they have re-engaged.",
    color: {
      header: "text-amber-600 dark:text-amber-300",
      card: "border-amber-200 dark:border-amber-800/40",
      dot: "bg-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/10",
    },
  },
  {
    id: "Closed Lost",
    autoCollapse: true,
    description: "Investors that passed or went cold. The reason for the loss is captured on the card.",
    requirements: "Terminal stage. Drag back to an earlier stage to re-open — the loss reason is cleared.",
    color: {
      header: "text-red-600 dark:text-red-400",
      card: "border-red-200 dark:border-red-800/40",
      dot: "bg-red-500",
      bg: "bg-red-50 dark:bg-red-900/10",
    },
  },
  {
    id: "Closed Won",
    autoCollapse: true,
    description: "Investors that have committed capital to the round.",
    requirements: "Terminal stage. Track the committed amount and close mechanics on the round.",
    color: {
      header: "text-green-600 dark:text-green-300",
      card: "border-green-200 dark:border-green-800/40",
      dot: "bg-green-500",
      bg: "bg-green-50 dark:bg-green-900/10",
    },
  },
];

function investorStageColor(id: string): InvestorStage["color"] {
  return (INVESTOR_STAGES.find(s => s.id === id) ?? INVESTOR_STAGES[0]).color;
}

/** Columns the board shows — Lead is a list-only holding pen, never a column. */
const INVESTOR_BOARD_STAGES = INVESTOR_STAGES.filter(s => !s.leadOnly);

// Per-column sort, same two-mode toggle /crm uses. "firm" is the default
// ordering; "status" surfaces whatever is waiting on us at the top.
type InvestorSortMode = "firm" | "status";

const INVESTOR_STATUS_ORDER: Record<string, number> = {
  "Awaiting Us": 0, "Awaiting Investor": 1,
};

function sortInvestors(rows: Investor[], mode: InvestorSortMode): Investor[] {
  const list = [...rows];
  const byName = (a: Investor, b: Investor) =>
    (a.firm ?? a.name ?? "").localeCompare(b.firm ?? b.name ?? "", undefined, { sensitivity: "base" });
  if (mode === "status") {
    // Unstatused records sort last, then ties fall back to the default order.
    list.sort((a, b) => {
      const ra = INVESTOR_STATUS_ORDER[a.status ?? ""] ?? 99;
      const rb = INVESTOR_STATUS_ORDER[b.status ?? ""] ?? 99;
      return ra - rb || byName(a, b);
    });
  } else {
    list.sort(byName);
  }
  return list;
}

function daysInStage(since: string | null): number | null {
  if (!since) return null;
  const t = new Date(since).getTime();
  if (!isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/** Per-column sort toggle glyph. Shared with the applications board. */
function InvestorSortIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h13M3 12h9M3 18h5m9-3v6m0 0l3-3m-3 3l-3-3" />
    </svg>
  );
}

/** Collapse/expand chevron for a board column header. */
function BoardChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${collapsed ? "-rotate-90" : ""}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/** Hover card explaining a stage and its exit criteria. Structural on purpose:
 *  the investor ladder and the non-dilutive one both satisfy it, so the two
 *  boards explain themselves the same way /crm does. */
function StageInfoIcon({ stage, label }: {
  stage: { id: string; description: string; requirements: string; color: { header: string } };
  label?: string;
}) {
  const title = label ?? stage.id;
  return (
    <span className="relative group/info inline-flex items-center" onClick={e => e.stopPropagation()}>
      <svg viewBox="0 0 20 20" fill="currentColor" aria-label={`About ${title}`}
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-help">
        <path fillRule="evenodd" clipRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 012 0v5a1 1 0 11-2 0V9zm1-4.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z" />
      </svg>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-5 z-30 hidden group-hover/info:block w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2.5 shadow-lg"
      >
        <span className={`block text-[11px] font-semibold normal-case tracking-normal ${stage.color.header}`}>{title}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-gray-600 dark:text-gray-300 normal-case tracking-normal font-normal">
          {stage.description}
        </span>
        <span className="mt-1.5 block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400 normal-case tracking-normal font-normal">
          {stage.requirements}
        </span>
      </span>
    </span>
  );
}

// ── View toggle ────────────────────────────────────────────────────────────────

function ViewToggle({ mode, onChange, showGantt = true }: { mode: FundingViewMode; onChange: (m: FundingViewMode) => void; showGantt?: boolean }) {
  const views = (showGantt ? ["list", "kanban", "gantt"] : ["list", "kanban"]) as FundingViewMode[];
  const icons: Record<FundingViewMode, React.ReactNode> = {
    list: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
    kanban: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7" />
      </svg>
    ),
    gantt: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h8M3 10h14M3 14h6M3 18h10" />
      </svg>
    ),
  };
  return (
    <div className="flex items-center border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {views.map((m) => (
        <button key={m} onClick={() => onChange(m)} title={`${m.charAt(0).toUpperCase() + m.slice(1)} view`}
          className={`px-2.5 py-1.5 transition-colors ${
            mode === m ? "bg-blue-600 text-white" : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}>
          {icons[m]}
        </button>
      ))}
    </div>
  );
}

// ── Edit Opportunity Modal ─────────────────────────────────────────────────────

function EditOpportunityModal({ opp, onClose, onSaved, onDelete }: {
  opp: Opportunity; onClose: () => void; onSaved: () => void; onDelete: () => void;
}) {
  const [form, setForm] = useState({
    title: opp.title, stage: opp.stage,
    deadline: opp.deadline ?? "", deadline_time: opp.deadline_time ?? "",
    tags: opp.tags.join(", "),
    funding_type: opp.funding_type ?? "", dilution: opp.dilution ?? "",
    amount: opp.amount === null || opp.amount === undefined ? "" : String(opp.amount),
    amount_currency: opp.amount_currency ?? "USD",
    amount_notes: opp.amount_notes ?? "",
    decision_date: opp.decision_date ?? "", funding_dispersion: opp.funding_dispersion ?? "",
    source_link: opp.source_link ?? "",
  });
  const fundingTypes = useFundingTypes();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  function set(field: string, value: string) { setForm((f) => ({ ...f, [field]: value })); }

  async function save() {
    if (!form.title.trim()) return;
    setSaving(true);
    await fetch(`/api/proxy/funding/${opp.opportunity_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title.trim(), stage: form.stage,
        deadline: form.deadline || null,
        deadline_time: form.deadline_time || null,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        funding_type: form.funding_type || null,
        dilution: form.dilution || null,
        amount: form.amount === "" ? null : Number(form.amount),
        amount_currency: form.amount_currency || "USD",
        amount_notes: form.amount_notes.trim() || null,
        decision_date: form.decision_date || null,
        funding_dispersion: form.funding_dispersion || null,
        source_link: form.source_link || null,
      }),
    });
    setSaving(false); onSaved(); onClose();
  }

  const inputCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Edit Opportunity</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setConfirmDelete(true)} className="text-gray-400 hover:text-red-500 transition-colors p-1" title="Delete">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Title *</label>
            <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Stage</label>
              <StyledSelect value={form.stage} onChange={(e) => set("stage", e.target.value)} className={inputCls}>
                {STAGES.map((s) => <option key={s}>{s}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Funding Type</label>
              <StyledSelect value={form.funding_type} onChange={(e) => set("funding_type", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {fundingTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </StyledSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Dilution</label>
              <StyledSelect value={form.dilution} onChange={(e) => set("dilution", e.target.value)} className={inputCls}>
                <option value="">—</option>
                {DILUTION_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </StyledSelect>
            </div>
            <div />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Deadline</label>
            <input type="date" value={form.deadline} onChange={(e) => set("deadline", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Amount</label>
            <MoneyField amount={form.amount} currency={form.amount_currency}
              notes={form.amount_notes} inputCls={inputCls}
              onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Decision Date</label>
              <input type="text" value={form.decision_date} onChange={(e) => set("decision_date", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Funding Dispersion</label>
              <input type="text" value={form.funding_dispersion} onChange={(e) => set("funding_dispersion", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tags (comma-separated)</label>
            <input type="text" value={form.tags} onChange={(e) => set("tags", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Link</label>
            <input type="text" value={form.source_link} onChange={(e) => set("source_link", e.target.value)} className={inputCls} />
          </div>
          {/* Notes are a dated log now, added from the detail panel — editing
              them here would mean picking one entry to overwrite. */}
          <p className="text-[11px] text-gray-400">
            Notes and stage history live on the record — open it to add a note.
          </p>
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
          <button onClick={save} disabled={saving || !form.title.trim()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
      {confirmDelete && (
        <DeleteConfirm title={form.title} onConfirm={onDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </div>
  );
}

const TIER_OPTIONS = [
  { key: "Tier 1 — Strong Fit",   label: "T1 — Strong Fit",   cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800" },
  { key: "Tier 2 — Good Fit",     label: "T2 — Good Fit",     cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800" },
  { key: "Tier 3 — Possible Fit", label: "T3 — Possible Fit", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-700" },
  { key: "Tier 4 — Weak Fit",     label: "T4 — Weak Fit",     cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-700" },
  { key: "Tier 5 — No Fit",       label: "T5 — No Fit",       cls: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800" },
];

// ── Investor owner (assignee) ─────────────────────────────────────────────────

type AssignableUser = { user_id: string; email: string; display_name: string };

/** Shared, cached across every avatar and picker on the page. */
let _assignableUsers: AssignableUser[] = [];
const _assignableListeners = new Set<() => void>();
let _assignableLoaded = false;

async function refreshAssignableUsers() {
  try {
    const res = await fetch("/api/proxy/funding/users");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      _assignableUsers = data;
      _assignableListeners.forEach((l) => l());
    }
  } catch {}
}

function useAssignableUsers(): AssignableUser[] {
  const users = React.useSyncExternalStore(
    (cb) => { _assignableListeners.add(cb); return () => _assignableListeners.delete(cb); },
    () => _assignableUsers,
    () => _assignableUsers,
  );
  useEffect(() => {
    if (!_assignableLoaded) { _assignableLoaded = true; refreshAssignableUsers(); }
  }, []);
  return users;
}

/** The signed-in user's email, cached the same way. Used to work out who the
 *  *other* people on the team are — the ones a composed email should copy. */

/** Display name for a user id, from the shared cache. */
function assignableName(userId: string | null): string | null {
  if (!userId) return null;
  return _assignableUsers.find(u => u.user_id === userId)?.display_name ?? null;
}

/** The firm cell leads with the owner avatar, so the "Firm" header is inset to
 *  sit over the firm name instead of over the avatar:
 *  cell px-4 (16) + avatar (20) + gap-1.5 (6) − header px-2 (8) = 34. */
const FIRM_LABEL_INSET = 34;

/** Pixel-sized wrapper over the shared platform avatar — call sites here think
 *  in px, the shared component takes the Tailwind spacing scale (5 → 20px). */
function UserAvatar({ name, size = 20 }: { name: string | null; size?: number }) {
  return <Avatar name={name} size={size / 4} />;
}

/** Read-only avatar for lists — hover shows who owns the record. */
function AssigneeAvatar({ name, size = 20 }: { name: string | null; size?: number }) {
  return (
    <span title={name ? `Owner: ${name}` : "Unassigned"} className="inline-flex shrink-0">
      <UserAvatar name={name} size={size} />
    </span>
  );
}

/** Avatar that opens a picker. Used beside the firm name in the detail panel. */
function AssigneePicker({ assignedTo, assignedName, onAssign, size = 28 }: {
  assignedTo: string | null;
  assignedName: string | null;
  onAssign: (userId: string | null) => void;
  size?: number;
}) {
  const users = useAssignableUsers();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // The list carries the authoritative display name; fall back to whatever the
  // record was loaded with so the avatar is never blank while users load.
  const current = users.find(u => u.user_id === assignedTo);
  const shownName = current?.display_name ?? assignedName ?? null;

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button onClick={() => setOpen(o => !o)}
        title={shownName ? `Owner: ${shownName} — click to reassign` : "Unassigned — click to assign an owner"}
        className="rounded ring-offset-1 ring-offset-white dark:ring-offset-zinc-900 hover:ring-2 hover:ring-blue-400/60 transition-all">
        <UserAvatar name={shownName} size={size} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 w-56 max-h-72 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-1">
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Investor owner
          </p>
          <button onClick={() => { onAssign(null); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors ${!assignedTo ? "bg-blue-50 dark:bg-blue-950/30" : ""}`}>
            <UserAvatar name={null} size={20} />
            <span className="text-zinc-500 dark:text-zinc-400 italic">Unassigned</span>
          </button>
          {users.map(u => (
            <button key={u.user_id} onClick={() => { onAssign(u.user_id); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors ${assignedTo === u.user_id ? "bg-blue-50 dark:bg-blue-950/30" : ""}`}>
              <UserAvatar name={u.display_name} size={20} />
              <span className="text-zinc-700 dark:text-zinc-200 truncate">{u.display_name}</span>
              {assignedTo === u.user_id && <span className="ml-auto text-blue-500">✓</span>}
            </button>
          ))}
          {users.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-400 italic">No users found.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── CRM-style detail primitives ───────────────────────────────────────────────
// Mirrors components/crm/DealDetailView.tsx so the investor panel reads the same
// as a deal: collapsible cards, a fixed label column, and click-to-edit fields
// that save on blur rather than through a Save button.

const D_CARD = "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl";
const D_INPUT = "text-xs text-zinc-800 dark:text-zinc-100 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500/30";

/** `datetime-local` is wall-clock text carrying no zone; these are the two
 *  directions of that conversion, both through the browser's local time — which
 *  is what "send it at 9am" means to the person typing it. Seconds are dropped
 *  on purpose: the sweep that posts queued mail runs every 15 minutes, so a
 *  precise second is a promise the send could not keep. */

/** Opens the picker on a sensible moment instead of an empty box. */

const D_LABEL = "text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wide";

/** Grow a textarea to fit its contents, so nothing has to be dragged open.
 *  `minPx` keeps an empty box looking like the field it is rather than a
 *  single line. Runs on every value change, and on `active` so a box that was
 *  hidden when the text arrived is sized correctly the moment it appears. */
function useAutoGrow(value: string, minPx = 0, active = true) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, minPx)}px`;
  }, [value, minPx, active]);
  return ref;
}

/** Click-to-edit text / textarea cell. Commits on blur, only when changed. */
function AutoField({ value, onSave, placeholder = "—", multiline = false, type = "text" }: {
  value: string; onSave: (v: string | null) => void;
  placeholder?: string; multiline?: boolean; type?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const taRef = useAutoGrow(draft, 0, editing);
  useEffect(() => { setDraft(value); }, [value]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft.trim() || null);
  };

  if (editing) {
    if (multiline) {
      return (
        <AutoTextarea ref={taRef} autoFocus value={draft}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          className={D_INPUT + " w-full resize-none overflow-hidden"}
          style={{ minHeight: 48 }} />
      );
    }
    return (
      <input autoFocus type={type} value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={D_INPUT + " w-full"} />
    );
  }
  return (
    <span onClick={() => setEditing(true)}
      className={`text-xs cursor-text leading-relaxed whitespace-pre-wrap break-words rounded transition-colors ${
        value ? "text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
              : "text-zinc-300 dark:text-zinc-600 italic hover:text-zinc-400"
      }`}>
      {value || placeholder}
    </span>
  );
}

/** Select that reads as plain text at rest and only shows its control — border,
 *  background, chevron — on hover or focus. Still a real <select>, so one click
 *  opens the native list; nothing has to be clicked twice. */
function QuietSelect({ value, onChange, className = "", tone = "text-zinc-700 dark:text-zinc-200", children }: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** Text colour — passed as one class so it never collides with the default. */
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`group relative inline-flex items-center ${className}`}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`peer w-full appearance-none cursor-pointer rounded-md border border-transparent bg-transparent py-1 pl-1.5 pr-5 text-xs transition-colors hover:border-zinc-200 hover:bg-white dark:hover:border-zinc-700 dark:hover:bg-zinc-800 focus:border-zinc-200 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500/30 dark:focus:border-zinc-700 dark:focus:bg-zinc-800 ${tone}`}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-1 h-3 w-3 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 peer-focus:opacity-100"
        fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_1fr] gap-2 items-start">
      <span className={D_LABEL + " pt-0.5"}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Collapsible section — collapsed by default, with a summary shown when closed. */
function DetailSection({ title, summary, defaultOpen = false, children }: {
  title: string; summary?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={D_CARD}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors rounded-xl">
        <svg className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 shrink-0">{title}</h3>
        {!open && summary && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 truncate ml-1 min-w-0">{summary}</span>
        )}
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

/** A link field with an open-in-new-tab affordance. Kept at module scope: a
 *  component defined inside a render body is a new type on every render, which
 *  would remount the field and drop an edit in progress. */
function DetailLinkRow({ label, value, onSave }: {
  label: string; value: string | null; onSave: (v: string | null) => void;
}) {
  return (
    <DetailRow label={label}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <AutoField value={value ?? ""} type="url" placeholder="+ Add link" onSave={onSave} />
        </div>
        {value && (
          <a href={value} target="_blank" rel="noopener noreferrer"
            className="shrink-0 text-zinc-400 hover:text-blue-600 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>
    </DetailRow>
  );
}

// ── History — stage moves, outreach and logged activities ───────────────────
// One reverse-chronological feed of what has already happened. Stage moves and
// the outreach stamp are read-only records; activities are user-authored.
// Deliberately no tasks: what is still to be done lives in Activity above, and
// keeping one list of them means there is never a question of which is current.

type HistoryNote = {
  note_id: string;
  body: string;
  author_name: string | null;
  created_at: string;
};

type HistoryEntry = {
  kind: "stage" | "outreach" | "activity";
  id: string;
  at: string;
  notes?: HistoryNote[];
  status_from?: string | null;
  status_to?: string;
  actor_name?: string | null;
  title?: string;
  description?: string | null;
  owner_id?: string | null;
};

type HistoryPayload = {
  outreach_date: string | null;
  linked_project_id: string | null;
  entries: HistoryEntry[];
};

function histDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = v.length <= 10 ? new Date(v + "T00:00:00") : new Date(v);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Note thread on a single history entry. Any entry kind can carry one, so a
 *  status change can record why it happened. On entries with no notes yet the
 *  add affordance stays hidden until hover — a long feed would otherwise be a
 *  wall of "+ Add note". */
function EntryNotes({ notes, onAdd, onEdit, onDelete }: {
  notes: HistoryNote[];
  onAdd: (body: string) => Promise<void>;
  onEdit: (noteId: string, body: string) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try { await onAdd(body); setDraft(""); setAdding(false); }
    finally { setBusy(false); }
  }

  if (notes.length === 0 && !adding) {
    return (
      <button onClick={() => setAdding(true)}
        className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity mt-1">
        + Add note
      </button>
    );
  }

  return (
    <div className="mt-1.5 pl-3 border-l-2 border-zinc-100 dark:border-zinc-800 space-y-1.5">
      {/* Just the text. Clicking it edits the same box in place — no author or
          date chrome, which said nothing useful on a two-person team. */}
      {notes.map(n => (
        <div key={n.note_id} className="group/note flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <AutoField value={n.body} multiline placeholder="Empty note"
              onSave={v => { if (v) onEdit(n.note_id, v); }} />
          </div>
          <button onClick={() => onDelete(n.note_id)} title="Delete note"
            className="text-[10px] text-zinc-300 dark:text-zinc-600 opacity-0 group-hover/note:opacity-100 hover:text-red-500 transition-opacity shrink-0">✕</button>
        </div>
      ))}

      {adding ? (
        <div className="space-y-1">
          <AutoTextarea autoFocus value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") { setAdding(false); setDraft(""); } }}
            rows={2} placeholder="Add a note…"
            className={D_INPUT + " w-full resize-none"} />
          <div className="flex items-center gap-1.5">
            <button onClick={submit} disabled={busy || !draft.trim()}
              className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {busy ? "Adding…" : "Add note"}
            </button>
            <button onClick={() => { setAdding(false); setDraft(""); }}
              className="text-[10px] px-1 text-zinc-400 hover:text-zinc-600">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          + Add note
        </button>
      )}
    </div>
  );
}

function HistorySection({ investorId, outreachDate, onPatchInvestor, refreshKey }: {
  investorId: string;
  outreachDate: string | null;
  onPatchInvestor: (fields: Partial<Investor>) => Promise<void>;
  refreshKey: number;
}) {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  // Logging an activity is a note and nothing else. The date (today) and the
  // owner (whoever is logging it) are stamped server-side — recorded but never
  // asked for. Tasks belong to the Activity section above, which is where the
  // investor's real to-do list lives; History only records what happened.
  const blankForm = () => ({ text: "" });
  const [form, setForm] = useState(blankForm);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/dilutive/${investorId}/history`);
    if (r.ok) setData(await r.json());
  }, [investorId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  function openForm() {
    setForm(blankForm());
    setAdding(true);
  }

  async function saveActivity() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await fetch(`/api/proxy/dilutive/${investorId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: form.text.trim() }),
      });
      setAdding(false);
      await load();
    } finally { setBusy(false); }
  }

  async function patchActivity(id: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/dilutive/activities/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields),
    });
    await load();
  }

  async function deleteActivity(id: string) {
    await fetch(`/api/proxy/dilutive/activities/${id}`, { method: "DELETE" });
    await load();
  }

  async function addNote(entryKind: string, entryId: string, body: string) {
    await fetch(`/api/proxy/dilutive/${investorId}/history-notes`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry_kind: entryKind, entry_id: entryId, body }),
    });
    await load();
  }

  async function editNote(noteId: string, body: string) {
    await fetch(`/api/proxy/dilutive/history-notes/${noteId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    await load();
  }

  async function deleteNote(noteId: string) {
    await fetch(`/api/proxy/dilutive/history-notes/${noteId}`, { method: "DELETE" });
    await load();
  }

  const entries = data?.entries ?? [];
  const activityCount = entries.filter(e => e.kind === "activity").length;
  const summary = entries.length
    ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${activityCount ? ` · ${activityCount} logged` : ""}`
    : "Nothing recorded yet";

  return (
    <DetailSection title="History" summary={summary}>
      <div className="space-y-3">

        {/* Outreach date — the one dated field that lives on the investor itself */}
        <DetailRow label="Outreach Date">
          <div className="flex items-center gap-2">
            <input type="date"
              value={outreachDate ? outreachDate.slice(0, 10) : ""}
              onChange={async e => {
                await onPatchInvestor({ outreach_date: e.target.value || null } as Partial<Investor>);
                await load();  // the stamp is a feed entry — re-sort around the new date
              }}
              className={D_INPUT + " cursor-pointer"} />
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
              Stamped on first outreach; editable
            </span>
          </div>
        </DetailRow>

        <div className="flex items-center gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
          {!adding && (
            <button onClick={openForm}
              className="text-[11px] px-2 py-1 rounded border border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
              + Log activity
            </button>
          )}
          <span className="ml-auto text-[10px] text-zinc-300 dark:text-zinc-600">Newest first</span>
        </div>

        {/* New activity form */}
        {adding && (
          <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/40 dark:bg-blue-950/10 p-3 space-y-2">
            <AutoTextarea autoFocus value={form.text}
              onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
              placeholder="What happened?"
              rows={3} className={D_INPUT + " w-full resize-none"} />

            <div className="flex items-center gap-2 pt-1">
              <button onClick={saveActivity} disabled={busy || !form.text.trim()}
                className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {busy ? "Saving…" : "Log activity"}
              </button>
              <button onClick={() => setAdding(false)}
                className="text-xs px-3 py-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded-lg">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Feed */}
        {entries.length === 0 ? (
          <p className="text-xs text-zinc-400 italic">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-2">
            {entries.map(e => {
              if (e.kind === "activity") {
                return (
                  <li key={e.id} className="group rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 space-y-2">
                    {/* The activity is one editable box; its date sits alongside
                        for chronology, and edits happen in place. */}
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <AutoField value={e.title ?? ""} multiline placeholder="Empty activity"
                          onSave={v => patchActivity(e.id, { title: v || e.title })} />
                      </div>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0 pt-0.5">
                        {histDate(e.at)}
                      </span>
                      <button onClick={() => deleteActivity(e.id)}
                        title="Delete this activity"
                        className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">✕</button>
                    </div>

                    <EntryNotes notes={e.notes ?? []}
                      onAdd={b => addNote("activity", e.id, b)}
                      onEdit={editNote} onDelete={deleteNote} />
                  </li>
                );
              }

              const dot = e.kind === "outreach" ? "bg-blue-400" : "bg-violet-400";
              const label =
                e.kind === "outreach" ? "First outreach sent"
                : e.status_from ? `${e.status_from} → ${e.status_to}` : `Started at ${e.status_to}`;

              return (
                <li key={`${e.kind}:${e.id}`} className="group px-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                    <span className="text-zinc-700 dark:text-zinc-300">{label}</span>
                    <span className="ml-auto flex items-center gap-1.5 text-zinc-400 dark:text-zinc-500 shrink-0">
                      <span className="tabular-nums">{histDate(e.at)}</span>
                      {e.actor_name && <span>by {e.actor_name}</span>}
                    </span>
                  </div>
                  <EntryNotes notes={e.notes ?? []}
                    onAdd={b => addNote(e.kind, e.id, b)}
                    onEdit={editNote} onDelete={deleteNote} />
                </li>
              );
            })}
          </ol>
        )}

        <p className="text-[10px] text-zinc-300 dark:text-zinc-600 italic">
          Stage moves and the outreach stamp are recorded automatically.
        </p>
      </div>
    </DetailSection>
  );
}

// ── Investor Detail Panel ──────────────────────────────────────────────────────
// Laid out like the CRM deal detail view (components/crm/DealDetailView.tsx):
// an always-visible General card, collapsible sections that summarise
// themselves when closed, and click-to-edit fields that save on blur — there is
// no Save button and nothing to discard.

// ── Communications ────────────────────────────────────────────────────────────

type CommAddress = {
  address_id: string;
  email: string;
  contact_id: string | null;
  contact_name: string | null;
  is_primary: boolean;
  is_organizational: boolean;
  sendable: boolean;
};

/** The sign-off an email from this record will carry. Authored as plain text —
 *  one line per line, `Label [https://…]` for a link — and rendered to HTML
 *  server-side, so what the composer previews is what actually goes out. */
type Signature = {
  signature: string;
  preview_html: string;
  editable: boolean;
  owner_name: string | null;
};

/** A composed email parked before it goes anywhere. Physically the same row a
 *  queued send uses, but with no send time on it, so nothing will ever pick it
 *  up on a timer — it waits until someone opens it back up. */

type Attachment = {
  id: string;
  name: string;
  mime_type: string | null;
  size: number | null;
  /** 'drive' pulls at send time; 'upload' came off a computer. */
  source?: "drive" | "upload";
};
type ContactHit = {
  contact_id: string;
  name: string;
  email: string | null;
  organization: string | null;
};
type EmailTemplate = {
  template_id: string;
  name: string;
  kind: string;
  subject: string;
  body: string;
  default_delay_days: number | null;
  /** Shared documents that come with the template. Picking it attaches them. */
  attachments: Attachment[];
};

/** "3d ago" / "just now" — same shape the projects module uses. */
function agoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return null;
  const days = Math.floor(ms / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return "just now";
}

/** Inbound ↓ / outbound ↑ with the age, as shown on cards and in the panel. */
function LastContact({ at, direction, channel }: {
  at: string | null; direction: string | null; channel?: string;
}) {
  if (!at) {
    if (channel === "linkedin") {
      return (
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 font-medium"
          title="No email address on file — outreach happens on LinkedIn, so no mail can be tracked">
          LinkedIn only
        </span>
      );
    }
    return <span className="text-[10px] text-zinc-300 dark:text-zinc-600">No contact yet</span>;
  }
  const inbound = direction === "inbound";
  // A conversation where they are waiting on us goes amber after two weeks.
  const stale = !inbound && (daysInStage(at) ?? 0) >= 14;
  return (
    <span
      className={`text-[10px] font-medium ${stale ? "text-amber-600 dark:text-amber-400" : "text-zinc-400 dark:text-zinc-500"}`}
      title={`${inbound ? "Received from them" : "Sent by us"} on ${new Date(at).toLocaleString()}`}
    >
      {inbound ? "↓" : "↑"} {agoLabel(at)}
    </span>
  );
}

/** Contacts on an investor, rendered the way the project detail pane does it:
 *  a list of real people with avatars, not a grid of free-text fields. Each row
 *  is a `contacts` record reachable from the Contacts module, linked through
 *  comm_addresses so the Gmail sync matches it. */
/** Everyone who could make the introduction.
 *
 *  Distinct from the Contacts card lower down, which lists people *at the firm*
 *  reachable by email. These are the people on our side of the table who know
 *  someone there. Attach-only: a warm intro by definition comes from somebody
 *  already in the contact book, so there is no create-a-person path here. */
function WarmIntroContacts({ investorId, contacts, onChanged }: {
  investorId: string;
  contacts: ContactHit[];
  onChanged: (next: ContactHit[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setHits([]); return; }
    setSearching(true);
    try {
      const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(q)}&limit=15`);
      if (r.ok) {
        const data = await r.json();
        setHits((data.contacts ?? data ?? []).map((c: Record<string, unknown>) => ({
          contact_id: String(c.contact_id),
          name: String(c.name ?? ""),
          email: (c.email as string) ?? null,
          organization: (c.organization as string) ?? null,
        })));
      }
    } finally { setSearching(false); }
  }, []);

  function close() { setOpen(false); setQuery(""); setHits([]); }

  async function attach(c: ContactHit) {
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy/dilutive/${investorId}/intro-contacts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: c.contact_id }),
      });
      if (r.ok) onChanged([...contacts, c]);
      close();
    } finally { setBusy(false); }
  }

  async function detach(contactId: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy/dilutive/${investorId}/intro-contacts/${contactId}`,
        { method: "DELETE" });
      if (r.ok) onChanged(contacts.filter(c => c.contact_id !== contactId));
    } finally { setBusy(false); }
  }

  // Someone already attached is not a candidate — offering them again just
  // produces a no-op round trip.
  const attached = new Set(contacts.map(c => c.contact_id));
  const candidates = hits.filter(h => !attached.has(h.contact_id));

  return (
    <div className="space-y-1.5">
      {contacts.map(c => (
        <div key={c.contact_id}
          className="flex items-center gap-2 rounded-md bg-zinc-50 dark:bg-zinc-800/50 px-2 py-1.5">
          <UserAvatar name={c.name} size={24} />
          <div className="min-w-0 flex-1">
            <a href={`/contacts/${c.contact_id}`}
              className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:underline">
              {c.name}
            </a>
            <p className="truncate text-[10px] text-zinc-400">
              {[c.organization, c.email].filter(Boolean).join(" · ") || "No details on file"}
            </p>
          </div>
          <button onClick={() => detach(c.contact_id)} disabled={busy}
            className="shrink-0 text-[10px] text-zinc-400 hover:text-red-500 disabled:opacity-40">
            Remove
          </button>
        </div>
      ))}

      {open ? (
        <div className="space-y-1.5">
          <div className="relative">
            <input autoFocus value={query}
              onChange={e => { setQuery(e.target.value); search(e.target.value); }}
              onKeyDown={e => { if (e.key === "Escape") close(); }}
              placeholder="Search contacts…" className={D_INPUT + " w-full"} />
            {searching && <span className="absolute right-2 top-1.5 text-[10px] text-zinc-400">…</span>}
          </div>
          {candidates.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
              {candidates.map(h => (
                <button key={h.contact_id} onClick={() => attach(h)} disabled={busy}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40">
                  <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{h.name}</span>
                  {h.organization && <span className="text-[10px] text-zinc-400 ml-1.5">· {h.organization}</span>}
                  {h.email && <span className="block truncate text-[10px] text-zinc-400">{h.email}</span>}
                </button>
              ))}
            </div>
          )}
          {query.trim().length >= 2 && !searching && candidates.length === 0 && (
            <p className="text-[10px] text-zinc-400">
              {hits.length > 0
                ? "Already attached."
                : "No contact matches that — add them in Contacts first."}
            </p>
          )}
          <button onClick={close}
            className="text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setOpen(true)}
          className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
          {contacts.length ? "+ Add another contact" : "+ Attach a contact"}
        </button>
      )}
    </div>
  );
}

function InvestorContacts({ inv, onChanged }: { inv: Investor; onChanged: () => void }) {
  const [addresses, setAddresses] = useState<CommAddress[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Searching the existing book first, so the same person is not created twice.
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<ContactHit | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/proxy/comms/investor/${inv.investor_id}`);
    if (r.ok) setAddresses((await r.json()).addresses ?? []);
  }, [inv.investor_id]);
  useEffect(() => { load(); }, [load]);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setHits([]); return; }
    setSearching(true);
    try {
      const r = await fetch(`/api/proxy/contacts?search=${encodeURIComponent(q)}&limit=15`);
      if (r.ok) {
        const data = await r.json();
        setHits((data.contacts ?? data ?? []).map((c: Record<string, unknown>) => ({
          contact_id: String(c.contact_id),
          name: String(c.name ?? ""),
          email: (c.email as string) ?? null,
          organization: (c.organization as string) ?? null,
        })));
      }
    } finally { setSearching(false); }
  }, []);

  function reset() {
    setName(""); setEmail(""); setRole("");
    setQuery(""); setHits([]); setPicked(null); setAdding(false);
  }

  async function add() {
    const payload = picked
      ? { contact_id: picked.contact_id, email: (picked.email ?? email).trim(), role: role.trim() || null }
      : { email: email.trim(), name: name.trim() || null, role: role.trim() || null };
    if (!payload.email) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/proxy/comms/investor/${inv.investor_id}/contacts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert(typeof e.detail === "string" ? e.detail : "Could not add that contact.");
        return;
      }
      reset();
      await load(); onChanged();
    } finally { setBusy(false); }
  }

  async function patchAddress(id: string, fields: Record<string, unknown>) {
    await fetch(`/api/proxy/comms/addresses/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    await load(); onChanged();
  }

  async function remove(id: string) {
    await fetch(`/api/proxy/comms/addresses/${id}`, { method: "DELETE" });
    setConfirmRemove(null);
    await load(); onChanged();
  }

  return (
    <div className={D_CARD + " p-4 space-y-3"}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
          Contacts
          <span className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 px-1.5 py-0.5 rounded">
            {addresses.length}
          </span>
        </span>
        <button onClick={() => setAdding(a => !a)}
          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700">+ Add</button>
      </div>

      {adding && (
        <div className="space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
          {picked ? (
            <div className="flex items-center gap-2 rounded-md bg-zinc-50 dark:bg-zinc-800/50 px-2 py-1.5">
              <UserAvatar name={picked.name} size={24} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{picked.name}</p>
                <p className="text-[10px] text-zinc-400 truncate">
                  {[picked.email, picked.organization].filter(Boolean).join(" · ") || "No email on file"}
                </p>
              </div>
              <button onClick={() => { setPicked(null); setQuery(""); }}
                className="text-[10px] text-zinc-400 hover:text-zinc-600">Change</button>
            </div>
          ) : (
            <>
              {/* Search the existing book first — the same person should not be
                  created twice just because two records mention them. */}
              <div className="relative">
                <input autoFocus value={query}
                  onChange={e => { setQuery(e.target.value); search(e.target.value); }}
                  placeholder="Search existing contacts…" className={D_INPUT + " w-full"} />
                {searching && <span className="absolute right-2 top-1.5 text-[10px] text-zinc-400">…</span>}
              </div>
              {hits.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                  {hits.map(h => (
                    <button key={h.contact_id}
                      onClick={() => { setPicked(h); setHits([]); setEmail(h.email ?? ""); }}
                      className="w-full text-left px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                      <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{h.name}</span>
                      {h.organization && <span className="text-[10px] text-zinc-400 ml-1.5">· {h.organization}</span>}
                      {h.email && <span className="block text-[10px] text-zinc-400 truncate">{h.email}</span>}
                    </button>
                  ))}
                </div>
              )}
              {query.trim().length >= 2 && !searching && hits.length === 0 && (
                <p className="text-[10px] text-zinc-400">No match — fill in the fields below to create a new contact.</p>
              )}
              <div className="grid grid-cols-2 gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-2">
                <input value={name} onChange={e => setName(e.target.value)}
                  placeholder="Name (blank for a shared inbox)" className={D_INPUT} />
                <input value={role} onChange={e => setRole(e.target.value)}
                  placeholder="Role" className={D_INPUT} />
              </div>
              <input value={email} onChange={e => setEmail(e.target.value)} type="email"
                onKeyDown={e => { if (e.key === "Enter") add(); }}
                placeholder="name@firm.com" className={D_INPUT + " w-full"} />
            </>
          )}
          {picked && (
            <input value={role} onChange={e => setRole(e.target.value)}
              placeholder="Role on this investor" className={D_INPUT + " w-full"} />
          )}
          <div className="flex items-center gap-2">
            <button onClick={add} disabled={busy || (!picked && !email.trim()) || (!!picked && !picked.email && !email.trim())}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy ? "Adding…" : picked ? "Link contact" : "Create contact"}
            </button>
            <button onClick={reset}
              className="text-xs px-2 py-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">Cancel</button>
          </div>
          <p className="text-[10px] text-zinc-400">
            Linking starts matching their email onto this investor&apos;s Activity feed.
          </p>
        </div>
      )}

      {addresses.length === 0 ? (
        // A contact can exist on the record without ever having been linked —
        // a name typed in during import, or someone reached on LinkedIn who has
        // no email to link. That person is real and belongs here, not only in
        // the list behind this panel.
        (inv.name || inv.role || inv.email) ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <UserAvatar name={inv.name ?? inv.firm ?? null} size={28} />
              <div className="flex-1 min-w-0">
                <AutoField value={inv.name ?? ""} placeholder="+ Add name"
                  onSave={v => patchInvestor(inv, { name: v }, onChanged)} />
                <AutoField value={inv.role ?? ""} placeholder="+ Add role"
                  onSave={v => patchInvestor(inv, { role: v }, onChanged)} />
              </div>
            </div>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-500">
              {inv.outreach_channel === "linkedin"
                ? "On the record only — worked through LinkedIn, so there is no address to link."
                : "On the record only. Add their email below to link them as a contact, so mail syncs against them."}
            </p>
          </div>
        ) : (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 italic">
            {inv.outreach_channel === "linkedin"
              ? "No email on file — this investor is worked through LinkedIn."
              : "No contacts linked."}
          </p>
        )
      ) : (
        <div className="space-y-2">
          {addresses.map(a => (
            <div key={a.address_id} className="flex items-center gap-2 group/contact">
              <UserAvatar name={a.is_organizational ? (inv.firm ?? a.email) : (a.contact_name ?? a.email)} size={28} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {a.contact_id ? (
                    <a href={`/contacts/${a.contact_id}`}
                      className="text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400 truncate">
                      {a.contact_name ?? a.email}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{a.email}</span>
                  )}
                  {a.is_primary && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Primary</span>
                  )}
                  {a.is_organizational && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                      title="A shared inbox for the firm rather than a person">Shared inbox</span>
                  )}
                  {!a.sendable && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      title="Tracked for incoming mail, but nothing can be sent here">No-reply</span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{a.email}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover/contact:opacity-100 transition-opacity">
                {a.sendable && <a href={`mailto:${a.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Email</a>}
                {!a.is_primary && a.sendable && (
                  <button onClick={() => patchAddress(a.address_id, { is_primary: true })}
                    className="text-[10px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 px-1">Set Primary</button>
                )}
                {confirmRemove === a.address_id ? (
                  <div className="flex items-center gap-1">
                    <button onClick={() => remove(a.address_id)}
                      className="text-[10px] px-1.5 py-0.5 bg-red-600 text-white rounded font-medium">Remove</button>
                    <button onClick={() => setConfirmRemove(null)}
                      className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmRemove(a.address_id)}
                    title="Unlink from this investor — the contact record is kept"
                    className="text-[10px] text-zinc-300 hover:text-red-500 dark:text-zinc-600 dark:hover:text-red-400 px-1">✕</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The name held on the investor record itself. Shown whenever it is set,
          including alongside linked addresses: it is what the list displays, so
          hiding it here is what made people look for it in the wrong place —
          and where it disagrees with a linked contact, that is worth seeing. */}
      {addresses.length > 0 && (inv.name || inv.role) && (
        <div className="flex items-center gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-2">
          <UserAvatar name={inv.name ?? null} size={20} />
          <div className="flex-1 min-w-0">
            <AutoField value={inv.name ?? ""} placeholder="+ Add name"
              onSave={v => patchInvestor(inv, { name: v }, onChanged)} />
          </div>
          <div className="min-w-0 flex-1">
            <AutoField value={inv.role ?? ""} placeholder="+ Add role"
              onSave={v => patchInvestor(inv, { role: v }, onChanged)} />
          </div>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0"
            title="Held on the investor record — this is the name the list shows">
            on record
          </span>
        </div>
      )}

      {/* Phone numbers stay on the investor record — they are not per-address. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 border-t border-zinc-100 dark:border-zinc-800 pt-3">
        <DetailRow label="Office">
          <AutoField value={inv.office_phone ?? ""} placeholder="+ Add phone" onSave={v => patchInvestor(inv, { office_phone: v }, onChanged)} />
        </DetailRow>
        <DetailRow label="Cell">
          <AutoField value={inv.cell_phone ?? ""} placeholder="+ Add phone" onSave={v => patchInvestor(inv, { cell_phone: v }, onChanged)} />
        </DetailRow>
        <DetailRow label="Address">
          <AutoField value={inv.address ?? ""} placeholder="+ Add address" onSave={v => patchInvestor(inv, { address: v }, onChanged)} />
        </DetailRow>
      </div>
    </div>
  );
}

async function patchInvestor(inv: Investor, fields: Partial<Investor>, onChanged: () => void) {
  await fetch(`/api/proxy/dilutive/${inv.investor_id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  onChanged();
}

/* ── Transfer between boards ───────────────────────────────────────────────
   An investor and an opportunity are the same thing seen from two angles, and
   which board a record belongs on is a judgement that changes. The two shapes
   do not line up field for field, so the dialog shows the mapping the server
   will actually apply — it is read from the same plan that performs the write,
   rather than described here a second time and left to drift. */

type TransferPreview = {
  direction: "investor_to_opportunity" | "opportunity_to_investor";
  source_label: string;
  target_label: string;
  stages: string[];
  default_stage: string;
  statuses?: string[];
  default_status?: string | null;
  mapped: { from: string; to: string; value: string | number | null }[];
  folded: boolean;
  folded_preview: string | null;
  dropped: string[];
  carries: Record<string, number>;
};

/* Moving takes everything by default — the record is leaving, so anything left
   behind is orphaned. Duplicating takes only what is true of both records at
   once: notes and contacts describe the counterparty, whereas a second copy of
   the mail history and the to-do list is the same work appearing twice. The
   server applies these same defaults; sending them explicitly just keeps the
   boxes and the outcome in step. */
const CARRY_DEFAULTS = {
  move: { emails: true, notes: true, tasks: true, contacts: true },
  duplicate: { emails: false, notes: true, tasks: false, contacts: true },
} as const;

const CARRY_LABEL: Record<string, string> = {
  emails: "Email history",
  addresses: "Tracked addresses",
  scheduled: "Queued sends",
  tasks: "Tasks",
  notes: "Notes",
  contacts: "Contacts",
  intro_contacts: "Warm intro contacts",
};

function TransferControl({ from, id, onDone }: {
  from: "investor" | "opportunity";
  id: string;
  /** A move leaves this panel showing a record that no longer exists; a
   *  duplicate leaves it perfectly valid. The caller decides what to close. */
  onDone: (mode: "move" | "duplicate") => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<"move" | "duplicate">("move");
  const [carry, setCarry] = useState<Record<string, boolean>>({ ...CARRY_DEFAULTS.move });

  /* Switching mode resets the boxes rather than carrying a tick across: what is
     safe to move is not what is safe to have twice, and a stale tick is how a
     duplicate quietly clones somebody's to-do list. */
  function pickMode(next: "move" | "duplicate") {
    setMode(next);
    setCarry({ ...CARRY_DEFAULTS[next] });
  }
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);

  const toBoard = from === "investor" ? "Opportunities" : "Investors";

  async function load() {
    setOpen(true); setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/proxy/transfers/${from}/${id}/preview`);
      if (!r.ok) { setError("Could not work out what would transfer."); return; }
      const p: TransferPreview = await r.json();
      setPreview(p);
      setStage(p.default_stage);
      setStatus(p.default_status ?? "");
    } catch {
      setError("Could not work out what would transfer.");
    } finally { setLoading(false); }
  }

  async function run() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const target = from === "investor" ? "to-opportunity" : "to-investor";
      const r = await fetch(`/api/proxy/transfers/${from}/${id}/${target}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage,
          ...(preview.statuses ? { status } : {}),
          keep_source: mode === "duplicate",
          carry,
        }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => null);
        setError(detail?.detail ?? "The transfer did not go through.");
        return;
      }
      setOpen(false);
      onDone(mode);
    } catch {
      setError("The transfer did not go through.");
    } finally { setBusy(false); }
  }

  // Only the counts that are non-zero are worth a checkbox; offering to carry
  // nought emails is a decision nobody needs to make.
  const carryable = preview
    ? Object.entries(preview.carries).filter(([, n]) => n > 0)
    : [];

  return (
    <>
      <button onClick={load}
        title={`Move this record to the ${toBoard} board`}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/30 hover:bg-sky-100 dark:hover:bg-sky-900/40 transition-colors">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
        Transfer to {toBoard}
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => !busy && setOpen(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                Transfer to {toBoard}
              </h2>
              <button onClick={() => !busy && setOpen(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {loading && <div className="p-8 text-center text-xs text-gray-500">Working out what would move…</div>}

            {preview && !loading && (
              <div className="p-5 space-y-4">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{preview.source_label}</span>
                  {" becomes "}
                  {from === "investor" ? "an opportunity" : "an investor"}
                  {" called "}
                  <span className="font-medium text-gray-900 dark:text-gray-100">{preview.target_label}</span>.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      {from === "investor" ? "Stage on the board" : "Pipeline stage"}
                    </label>
                    <StyledSelect value={stage} onChange={e => setStage(e.target.value)}
                      className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40">
                      {preview.stages.map(s => <option key={s} value={s}>{s}</option>)}
                    </StyledSelect>
                  </div>
                  {preview.statuses && preview.statuses.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Status</label>
                      <StyledSelect value={status} onChange={e => setStatus(e.target.value)}
                        className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40">
                        {preview.statuses.map(s => <option key={s} value={s}>{s}</option>)}
                      </StyledSelect>
                    </div>
                  )}
                </div>

                {/* Move or duplicate. Two cards rather than a checkbox because
                    the choice changes what the buttons below default to, and a
                    tickbox tucked at the bottom reads as an afterthought. */}
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ["move", `Move to ${toBoard}`,
                     "The record leaves this board and takes its history with it."],
                    ["duplicate", "Duplicate",
                     `Keep it here and put a copy on ${toBoard} as well.`],
                  ] as const).map(([value, title, blurb]) => (
                    <button key={value} type="button" onClick={() => pickMode(value)}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                        mode === value
                          ? "border-sky-400 dark:border-sky-600 bg-sky-50 dark:bg-sky-950/30"
                          : "border-gray-200 dark:border-gray-700 hover:border-gray-300"}`}>
                      <span className={`block text-xs font-medium ${
                        mode === value ? "text-sky-800 dark:text-sky-200"
                                       : "text-gray-700 dark:text-gray-300"}`}>{title}</span>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                        {blurb}
                      </span>
                    </button>
                  ))}
                </div>

                {/* The mapping, from the plan the write will use. Blank rows are
                    shown rather than hidden: knowing a field arrives empty is
                    the difference between a transfer and a surprise. */}
                <div>
                  <span className="block text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1.5">
                    Fields
                  </span>
                  <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
                    {preview.mapped.map(m => (
                      <div key={m.from} className="flex items-baseline gap-2 px-3 py-1.5 text-xs">
                        <span className="text-gray-400 w-28 flex-shrink-0">{m.from}</span>
                        <span className="text-gray-300 dark:text-gray-600">→</span>
                        <span className="text-gray-500 w-28 flex-shrink-0">{m.to}</span>
                        <span className={`truncate ${m.value == null || m.value === ""
                          ? "text-gray-300 dark:text-gray-600 italic" : "text-gray-800 dark:text-gray-200"}`}>
                          {m.value == null || m.value === "" ? "empty" : String(m.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {preview.folded && (
                  <div className="text-xs">
                    <button onClick={() => setShowNote(v => !v)}
                      className="text-blue-600 dark:text-blue-400 hover:underline">
                      {showNote ? "Hide" : "Show"} the note that carries everything else
                    </button>
                    {showNote && (
                      <pre className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 text-[11px] leading-relaxed text-gray-700 dark:text-gray-300 font-sans">
                        {preview.folded_preview}
                      </pre>
                    )}
                  </div>
                )}

                {carryable.length > 0 && (
                  <div>
                    <span className="block text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1.5">
                      {mode === "move" ? "Bring with it" : "Copy across as well"}
                    </span>
                    <div className="space-y-1">
                      {carryable.map(([key, n]) => {
                        // Addresses, queued sends and warm intros are not
                        // separately switchable — they move with the thing they
                        // belong to — so they are listed, not offered.
                        // A queued send that exists twice arrives twice, so it
                        // is the one thing a duplicate leaves strictly alone.
                        if (key === "scheduled" && mode === "duplicate") return null;
                        const rides = key === "addresses" ? "emails"
                          : key === "scheduled" ? "emails"
                          : key === "intro_contacts" ? "contacts" : null;
                        const owner = rides ?? key;
                        return (
                          <label key={key} className={`flex items-center gap-2 text-xs ${rides ? "pl-6 text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>
                            {!rides && (
                              <input type="checkbox" checked={carry[owner] !== false}
                                onChange={e => setCarry(c => ({ ...c, [owner]: e.target.checked }))}
                                className="rounded border-gray-300" />
                            )}
                            {rides && <span className="text-gray-300">↳</span>}
                            {CARRY_LABEL[key] ?? key}
                            <span className="text-gray-400 tabular-nums">({n})</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {mode === "move" && preview.dropped.length > 0 && (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                    <span className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                      Does not survive the move
                    </span>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                      {preview.dropped.map(d => <li key={d}>· {d}</li>)}
                    </ul>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={() => setOpen(false)} disabled={busy}
                    className="px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={run} disabled={busy || !stage}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
                    {busy
                      ? (mode === "move" ? "Transferring…" : "Duplicating…")
                      : (mode === "move" ? `Transfer to ${toBoard}` : `Duplicate into ${toBoard}`)}
                  </button>
                </div>
              </div>
            )}

            {error && !preview && !loading && (
              <div className="p-5 text-xs text-red-600 dark:text-red-400">{error}</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}


function InvestorDetailPanel({ inv, onClose, onSaved, onDelete }: {
  inv: Investor; onClose: () => void; onSaved: () => void; onDelete: () => void;
}) {
  const statuses = useInvestorStatuses();
  const investorTypes = useInvestorTypes();

  // Local authoritative copy: each edit patches the server and merges here, so
  // the panel stays live without waiting for the list behind it to reload.
  const [rec, setRec] = useState<Investor>(inv);
  useEffect(() => { setRec(inv); }, [inv]);

  // The panel title edits the firm name; kept in step with the record so an
  // enrichment pass that rewrites it is reflected here too.
  const [firmDraft, setFirmDraft] = useState(inv.firm ?? "");
  useEffect(() => { setFirmDraft(rec.firm ?? ""); }, [rec.firm]);

  const [saving, setSaving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkingProject, setLinkingProject] = useState(false);
  const [togglingPriority, setTogglingPriority] = useState(false);
  const [stageLossPrompt, setStageLossPrompt] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  const patch = useCallback(async (fields: Partial<Investor>) => {
    setRec(p => ({ ...p, ...fields }));
    setSaving(true);
    try {
      await fetch(`/api/proxy/dilutive/${inv.investor_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      // A status move appends to the read-only log — pull it again.
      if ("status" in fields) setHistoryKey(k => k + 1);
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [inv.investor_id, onSaved]);

  /** Re-read the record after something outside this panel wrote to it. */
  const reload = useCallback(async () => {
    const r = await fetch(`/api/proxy/dilutive/${inv.investor_id}`);
    if (r.ok) setRec(await r.json());
  }, [inv.investor_id]);

  async function createGrantProject() {
    setLinkingProject(true);
    try {
      const r = await fetch(`/api/proxy/dilutive/${inv.investor_id}/link-project`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setRec(p => ({ ...p, linked_project_id: d.project_id }));
        onSaved();
      }
    } finally { setLinkingProject(false); }
  }

  async function togglePriority() {
    setTogglingPriority(true);
    try {
      const next = !rec.is_priority;
      const resp = await fetch(`/api/proxy/dilutive/${inv.investor_id}/priority`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_priority: next }),
      });
      if (resp.ok) { setRec(p => ({ ...p, is_priority: next })); onSaved(); }
    } finally {
      setTogglingPriority(false);
    }
  }

  async function runEnrich() {
    setEnriching(true); setEnrichError(null);
    try {
      const resp = await fetch(`/api/proxy/dilutive/enrich-batch-v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investor_ids: [inv.investor_id], max_investors: 1 }),
      });
      if (!resp.ok) {
        let msg = "Enrichment failed.";
        try {
          const body = await resp.json();
          const detail = body?.detail ?? "";
          if (detail.includes("usage limits") || detail.includes("regain access")) {
            const match = detail.match(/(\d{4}-\d{2}-\d{2})/);
            msg = match ? `API rate limit reached. Resets ${match[1]}.` : "API rate limit reached.";
          } else if (detail) {
            msg = detail;
          }
        } catch {}
        setEnrichError(msg);
        return;
      }
      const data = await resp.json();
      const result = data?.results?.[0];
      if (result?.status === "error") {
        setEnrichError(result.error ?? "Enrichment failed.");
      } else {
        // The agent writes straight to the DB — re-read to show what it found.
        await reload();
        onSaved();
      }
    } finally {
      setEnriching(false);
    }
  }

  const s = (v: string | null | undefined) => v ?? "";
  const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
  const hostOf = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  };

  const portfolio = rec.portfolio ?? [];
  const links: [string, string | null][] = [
    ["Website", rec.website], ["LinkedIn", rec.linkedin],
    ["Portfolio URL", rec.portfolio_url], ["Source Link", rec.source_link],
  ];
  const linkCount = links.filter(([, v]) => v).length;
  const checkRange = rec.check_size_min || rec.check_size_max
    ? [rec.check_size_min, rec.check_size_max].filter(Boolean).join("–")
    : null;

  const profileSummary = joined(rec.investment_stage, rec.focus, checkRange, rec.hq) || "Not set";
  const notesSummary = joined(
    rec.tags.length ? `${rec.tags.length} tag${rec.tags.length === 1 ? "" : "s"}` : null,
    rec.notes ? rec.notes.replace(/\s+/g, " ").slice(0, 60) : null,
  ) || "Empty";

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" />
      {/* Panel */}
      <div className="w-full max-w-2xl bg-zinc-50 dark:bg-zinc-950 h-full overflow-hidden shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex-1 min-w-0 pr-4 flex items-start gap-3">
            {/* Investor owner — sits to the left of the firm name */}
            <div className="pt-0.5">
              <AssigneePicker
                assignedTo={rec.assigned_to}
                assignedName={rec.assigned_to_name}
                onAssign={async uid => {
                  // Name is display-only and not a stored column — resolve it
                  // locally so the avatar updates without a refetch.
                  setRec(p => ({ ...p, assigned_to_name: assignableName(uid) }));
                  await patch({ assigned_to: uid });
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
            <input
              className="w-full text-xl font-bold text-zinc-900 dark:text-zinc-50 bg-transparent border-0 outline-none focus:bg-zinc-50 dark:focus:bg-zinc-800 rounded-lg px-1 -mx-1 py-0.5 transition-colors"
              value={firmDraft}
              onChange={e => setFirmDraft(e.target.value)}
              onBlur={() => { const v = firmDraft.trim(); if (v !== s(rec.firm)) patch({ firm: v || null }); }}
              placeholder="Firm name"
            />
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <InvestorStatusTag status={rec.status} statuses={statuses} />
              {/* Pipeline stage — the column this record sits in on the board. */}
              <QuietSelect
                value={rec.pipeline_stage}
                onChange={next => {
                  if (next === rec.pipeline_stage) return;
                  // Closing as lost always captures a reason first.
                  if (next === "Closed Lost") { setStageLossPrompt(true); return; }
                  patch({ pipeline_stage: next, closed_lost_reason: null });
                }}
                className="font-medium"
                tone={investorStageColor(rec.pipeline_stage).header}
              >
                {INVESTOR_STAGES.map(st => <option key={st.id} value={st.id}>{st.id}</option>)}
              </QuietSelect>
              {rec.investor_type && <span className="text-xs text-zinc-500 dark:text-zinc-400">{rec.investor_type}</span>}
              {rec.hq && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"/></svg>
                  {rec.hq}
                </span>
              )}
              {rec.website && (
                <a href={rec.website} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                  {hostOf(rec.website)}
                  <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              )}
              <span className={`text-[11px] transition-opacity ${saving ? "text-zinc-400 opacity-100" : "opacity-0"}`}>Saving…</span>
            </div>
            {rec.close_reason_code && (
              <div className="mt-1 flex items-center gap-2">
                <CloseReasonBadge code={rec.close_reason_code} />
                {rec.revisit_date && (
                  <span className="text-[11px] text-amber-700 dark:text-amber-400">
                    Revisit {histDate(rec.revisit_date)}
                    {rec.revisit_trigger ? ` · ${rec.revisit_trigger}` : ""}
                  </span>
                )}
              </div>
            )}
            {rec.closed_lost_reason && (
              <p className="mt-2 rounded-md border border-red-100 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-2 py-1 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                <span className="font-semibold">Lost: </span>{rec.closed_lost_reason}
              </p>
            )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <button onClick={togglePriority} disabled={togglingPriority}
                title={rec.is_priority ? "Remove from priority list" : "Add to priority list"}
                className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 ${rec.is_priority ? "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-100" : "border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-amber-500 hover:border-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20"}`}>
                <span className="text-base leading-none">{rec.is_priority ? "★" : "☆"}</span>
                {rec.is_priority ? "Priority" : "Add to priority"}
              </button>
              <button onClick={runEnrich} disabled={enriching}
                title="Auto-enrich with AI"
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-50 transition-colors">
                {enriching
                  ? <><span className="animate-spin inline-block w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full" />Enriching…</>
                  : <><svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>Enrich</>
                }
              </button>
              <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <TransferControl from="investor" id={rec.investor_id}
              onDone={m => { onSaved(); if (m === "move") onClose(); }} />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">

          {enrichError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-xs text-red-600 dark:text-red-400 flex items-center justify-between">
              {enrichError}
              <button onClick={() => setEnrichError(null)} className="ml-2 hover:text-red-800">✕</button>
            </div>
          )}

          {/* CONTACTS — real contact records, as in the project detail pane */}
          <InvestorContacts inv={rec} onChanged={() => { reload(); onSaved(); }} />

          {/* Alignment score — read-only, written by the scoring pass. Collapsed to
              a single line by default; the five sub-scores are detail you rarely
              need while working a record. */}
          {rec.total_score != null && (
            <div className={D_CARD + " px-3 py-2"}>
              <button onClick={() => setFitOpen(o => !o)}
                className="flex w-full items-center gap-2 text-left">
                <svg className={`w-3 h-3 shrink-0 text-zinc-400 transition-transform ${fitOpen ? "" : "-rotate-90"}`}
                  fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {rec.tier && (() => {
                  const ts = TIER_OPTIONS.find(t => rec.tier!.startsWith(t.key.split(" — ")[0]));
                  return ts ? <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${ts.cls}`}>{ts.label.split(" — ")[0]}</span> : null;
                })()}
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{rec.tier?.replace(/^[A-Z0-9]+ — /, "") ?? "Alignment"}</span>
                <span className="ml-auto text-xs font-semibold text-zinc-500 dark:text-zinc-400 shrink-0">
                  {rec.total_score}<span className="font-normal text-zinc-400">/20</span>
                </span>
              </button>
              {fitOpen && <>
              <div className="grid grid-cols-5 gap-1.5 mt-3">
                {([
                  ["Focus",     rec.score_focus],
                  ["Stage",     rec.score_stage],
                  ["Check",     rec.score_check],
                  ["Geo",       rec.score_geo],
                  ["Portfolio", rec.score_portfolio],
                ] as [string, number | null][]).map(([label, score]) => (
                  <div key={label} className="flex flex-col items-center gap-1">
                    <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded h-1.5 overflow-hidden">
                      <div className={`h-full rounded transition-all ${score == null ? "w-0" : score >= 3 ? "bg-green-500" : score >= 2 ? "bg-yellow-400" : score >= 1 ? "bg-orange-400" : "bg-red-400"}`}
                        style={{ width: score != null ? `${(score / 4) * 100}%` : "0%" }} />
                    </div>
                    <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{label}</div>
                    <div className={`text-xs font-semibold leading-none ${score == null ? "text-zinc-300 dark:text-zinc-600" : score >= 3 ? "text-green-600 dark:text-green-400" : score >= 2 ? "text-yellow-600 dark:text-yellow-400" : "text-red-500 dark:text-red-400"}`}>
                      {score ?? "—"}
                    </div>
                  </div>
                ))}
              </div>
              {rec.enrichment_notes && (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700">{rec.enrichment_notes}</p>
              )}
              </>}
            </div>
          )}

          {/* GENERAL — always visible */}
          <div className={D_CARD + " p-3 space-y-2.5"}>
            <div className="flex flex-wrap items-center gap-2">
              <QuietSelect value={s(rec.status)} onChange={v => patch({ status: v || null })}>
                <option value="">— Status —</option>
                {statuses.map(st => <option key={st.name} value={st.name}>{st.name}</option>)}
              </QuietSelect>
              <QuietSelect value={s(rec.investor_type)} onChange={v => patch({ investor_type: v || null })}>
                <option value="">— Type —</option>
                {investorTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </QuietSelect>
              {/* Drives the "LinkedIn only" badge on the card. Set automatically
                  when a contact is added, overridable here. */}
              <QuietSelect value={rec.outreach_channel ?? "email"}
                onChange={v => patch({ outreach_channel: v })}>
                <option value="email">Reached by email</option>
                <option value="linkedin">LinkedIn only</option>
                <option value="form">Web form only</option>
                <option value="other">Other channel</option>
              </QuietSelect>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <DetailRow label="Intro Type">
                <QuietSelect value={s(rec.intro_type)} onChange={v => patch({ intro_type: v || null })} className="w-full">
                  <option value="">—</option>
                  <option value="Warm">Warm</option>
                  <option value="Cold">Cold</option>
                </QuietSelect>
              </DetailRow>
              <DetailRow label="Avg. Check Size">
                <AutoField value={s(rec.avg_check_size)} placeholder="+ Add"
                  onSave={v => patch({ avg_check_size: v })} />
              </DetailRow>
            </div>

            <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <span className={D_LABEL + " block mb-1"}>Warm Intro Contacts</span>
              {/* Writes go straight to the link endpoints, not through patch() —
                  so the local copy is updated here, and onSaved refreshes the
                  list behind the panel. */}
              <WarmIntroContacts investorId={rec.investor_id}
                contacts={rec.intro_contacts ?? []}
                onChanged={next => { setRec(p => ({ ...p, intro_contacts: next })); onSaved(); }} />
            </div>

            <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <span className={D_LABEL + " block mb-1"}>Intro Notes</span>
              <AutoField value={s(rec.intro_notes)} multiline placeholder="+ How the introduction came about"
                onSave={v => patch({ intro_notes: v })} />
            </div>

            <div className="pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <span className={D_LABEL + " block mb-1"}>Description</span>
              <AutoField value={s(rec.description)} multiline placeholder="+ Add a firm description"
                onSave={v => patch({ description: v })} />
            </div>
          </div>

          {/* Linked grant project */}
          <div className="flex flex-wrap items-center gap-1.5">
            {rec.linked_project_id ? (
              <a href={`/projects/${rec.linked_project_id}`}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 transition-colors font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
                </svg>
                View linked Grant project →
              </a>
            ) : (
              <button onClick={createGrantProject} disabled={linkingProject}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-400 hover:bg-violet-100 disabled:opacity-50 transition-colors font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {linkingProject ? "Creating…" : "Create Grant & Funding Project"}
              </button>
            )}
          </div>

          {/* ACTIVITY — the same component the CRM and the applications board
              use. Investors ran a private fork of it until it drifted a release
              behind; there was never anything in the fork the shared one lacked. */}
          <EntityActivity entityType="investor" entityId={rec.investor_id}
            assignedTo={rec.assigned_to ?? null}
            outreachChannel={rec.outreach_channel ?? null}
            onChanged={() => { reload(); onSaved(); }} />

          {/* INVESTMENT PROFILE */}
          <DetailSection title="Investment Profile" summary={profileSummary}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              <DetailRow label="HQ">
                <AutoField value={s(rec.hq)} placeholder="City, Country" onSave={v => patch({ hq: v })} />
              </DetailRow>
              <DetailRow label="Geo Focus">
                <AutoField value={s(rec.geo_focus)} placeholder="US, Europe…" onSave={v => patch({ geo_focus: v })} />
              </DetailRow>
              <DetailRow label="Stage">
                <AutoField value={s(rec.investment_stage)} placeholder="Seed, Series A…" onSave={v => patch({ investment_stage: v })} />
              </DetailRow>
              <DetailRow label="Focus">
                <AutoField value={s(rec.focus)} placeholder="Deep Tech, SaaS…" onSave={v => patch({ focus: v })} />
              </DetailRow>
              <DetailRow label="Check Min">
                <AutoField value={s(rec.check_size_min)} placeholder="$500K" onSave={v => patch({ check_size_min: v })} />
              </DetailRow>
              <DetailRow label="Check Max">
                <AutoField value={s(rec.check_size_max)} placeholder="$2M" onSave={v => patch({ check_size_max: v })} />
              </DetailRow>
              <DetailRow label="Fund Size">
                <AutoField value={s(rec.fund_size)} placeholder="$50M" onSave={v => patch({ fund_size: v })} />
              </DetailRow>
              <DetailRow label="Fund Year">
                <AutoField value={s(rec.fund_launch_year)} placeholder="2019" onSave={v => patch({ fund_launch_year: v })} />
              </DetailRow>
            </div>
            <div className="pt-2 mt-2 border-t border-zinc-100 dark:border-zinc-800">
              <DetailRow label="Partners">
                <AutoField value={s(rec.partners)} placeholder="+ Partner names" onSave={v => patch({ partners: v })} />
              </DetailRow>
            </div>
          </DetailSection>

          {/* PORTFOLIO */}
          <DetailSection title="Portfolio"
            summary={portfolio.length ? `${portfolio.length} compan${portfolio.length === 1 ? "y" : "ies"}` : "None listed"}>
            {portfolio.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {portfolio.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-700 dark:hover:text-blue-400 transition-colors border border-zinc-200 dark:border-zinc-700">
                    {hostOf(url)}
                    <svg className="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                  </a>
                ))}
              </div>
            )}
            <span className={D_LABEL + " block mb-1"}>One URL per line</span>
            <AutoField value={portfolio.join("\n")} multiline
              placeholder={"+ https://company1.com"}
              onSave={v => patch({ portfolio: v ? v.split("\n").map(x => x.trim()).filter(Boolean) : [] })} />
          </DetailSection>

          {/* LINKS */}
          <DetailSection title="Links"
            summary={linkCount ? `${linkCount} link${linkCount === 1 ? "" : "s"}` : "None"}>
            <div className="space-y-2">
              <DetailLinkRow label="Website" value={rec.website} onSave={v => patch({ website: v })} />
              <DetailLinkRow label="LinkedIn" value={rec.linkedin} onSave={v => patch({ linkedin: v })} />
              <DetailLinkRow label="Portfolio URL" value={rec.portfolio_url} onSave={v => patch({ portfolio_url: v })} />
              <DetailLinkRow label="Source Link" value={rec.source_link} onSave={v => patch({ source_link: v })} />
            </div>
          </DetailSection>

          {/* CONTACT */}

          {/* NOTES & TAGS */}
          <DetailSection title="Notes & Tags" summary={notesSummary}>
            <div className="space-y-3">
              <div>
                <span className={D_LABEL + " block mb-1"}>Tags <span className="normal-case font-normal">(comma-separated)</span></span>
                {rec.tags.length > 0 && (
                  <div className="mb-1.5"><TagList tags={rec.tags} /></div>
                )}
                <AutoField value={rec.tags.join(", ")} placeholder="+ federal, seed"
                  onSave={v => patch({ tags: v ? v.split(",").map(x => x.trim()).filter(Boolean) : [] })} />
              </div>
              <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <span className={D_LABEL + " block mb-1"}>Notes</span>
                <AutoField value={s(rec.notes)} multiline placeholder="+ Add notes"
                  onSave={v => patch({ notes: v })} />
              </div>
            </div>
          </DetailSection>

          {/* HISTORY — status changes, outreach, follow-ups, logged activities */}
          <HistorySection investorId={inv.investor_id} outreachDate={rec.outreach_date}
            onPatchInvestor={patch} refreshKey={historyKey} />

          <p className="text-[11px] text-zinc-300 dark:text-zinc-600 text-right pt-1">#{inv.investor_id}</p>

          <div className="pt-2 flex justify-end">
            <button onClick={() => setConfirmDelete(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors font-medium">
              Delete investor
            </button>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <DeleteConfirm
          title={`${rec.firm ?? rec.name ?? "Investor"}`}
          onConfirm={onDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {stageLossPrompt && (
        <ClosedLostReasonModal
          investor={rec}
          onCancel={() => setStageLossPrompt(false)}
          onConfirm={payload => {
            setStageLossPrompt(false);
            // The stage is the category's decision, not this component's — the
            // server routes revisit to Nurture and lost to Closed Lost.
            patch(payload as Partial<Investor>);
          }}
        />
      )}
    </div>
  );
}

// ── Suggested emails ──────────────────────────────────────────────────────────
// An application has no contacts, so mail cannot be matched to it by address
// the way investor mail is. The sync matches on the funder's DOMAIN and on the
// opportunity TITLE appearing in the SUBJECT — good signals, but not good
// enough to file unreviewed into a timeline shared with thousands of investor
// emails. They queue here instead.
//
// Accepting also registers the sender against the record, so the rest of that
// conversation files itself by the ordinary exact-address rule and never comes
// back through this tray.

type EmailSuggestion = {
  suggestion_id: string;
  gmail_message_id: string;
  thread_id: string | null;
  subject: string | null;
  snippet: string | null;
  from_email: string | null;
  occurred_at: string;
  direction: string | null;
  match_reason: string[];
};

// ── Application ───────────────────────────────────────────────────────────────
// What the funder asked and what we wrote. Entered by hand, and wired to the
// Knowledge Base both ways (133): pull a standing answer in as a draft, or send
// a written one back out once it has been proven on a real submission.

type ApplicationAnswer = {
  answer_id: string;
  question: string;
  answer: string | null;
  word_limit: number | null;
  kb_entry_id: string | null;
  kb_question: string | null;
  author_name: string | null;
  updated_at: string;
};

function countWords(text: string | null): number {
  return (text || "").trim() ? (text || "").trim().split(/\s+/).length : 0;
}

function ApplicationAnswerRow({ item, onChanged }: {
  item: ApplicationAnswer;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(item.answer ?? "");
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => { setDraft(item.answer ?? ""); }, [item.answer]);

  const words = countWords(draft);
  const over = item.word_limit != null && words > item.word_limit;

  async function patch(fields: Partial<ApplicationAnswer>) {
    setSaving("save");
    await fetch(`/api/proxy/funding/application/${item.answer_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSaving(null);
    onChanged();
  }

  async function toKb() {
    setSaving("kb");
    const res = await fetch(`/api/proxy/funding/application/${item.answer_id}/to-kb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setSaving(null);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ detail: "Could not save." }));
      alert(typeof e.detail === "string" ? e.detail : "Could not save.");
      return;
    }
    const d = await res.json();
    onChanged();
    alert(d.created ? "Added to the Knowledge Base." : "Updated the linked Knowledge Base entry.");
  }

  async function remove() {
    if (!confirm(`Remove "${item.question}" from this application?`)) return;
    await fetch(`/api/proxy/funding/application/${item.answer_id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.answer?.trim() ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`}
          title={item.answer?.trim() ? "Answered" : "Not yet answered"} />
        <span className="flex-1 min-w-0 text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
          {item.question}
        </span>
        {item.kb_entry_id && (
          <span className="text-[9px] px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-300 shrink-0"
            title={`Linked to the Knowledge Base: ${item.kb_question ?? ""}`}>KB</span>
        )}
        {item.word_limit != null && (
          <span className={`text-[10px] shrink-0 tabular-nums ${over ? "text-red-500 font-medium" : "text-zinc-400"}`}>
            {words}/{item.word_limit}
          </span>
        )}
        <svg className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-zinc-100 dark:border-zinc-800">
          <AutoTextarea value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={() => { if (draft !== (item.answer ?? "")) patch({ answer: draft.trim() || null }); }}
            rows={5} placeholder="What we wrote…"
            className="w-full text-xs leading-relaxed border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-2 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none" />

          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[10px] text-zinc-400">Word limit</label>
            <input type="number" min="0" defaultValue={item.word_limit ?? ""}
              onBlur={e => {
                const v = e.target.value.trim();
                const next = v === "" ? null : Number(v);
                if (next !== item.word_limit) patch({ word_limit: next });
              }}
              placeholder="—"
              className="w-20 text-[11px] border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            <span className={`text-[10px] tabular-nums ${over ? "text-red-500 font-medium" : "text-zinc-400"}`}>
              {words} word{words === 1 ? "" : "s"}{over ? " — over limit" : ""}
            </span>

            <button onClick={toKb} disabled={saving !== null || !draft.trim()}
              title={item.kb_entry_id ? "Update the linked Knowledge Base entry" : "Add this answer to the Knowledge Base"}
              className="ml-auto text-[11px] px-2.5 py-1 rounded-md border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40">
              {saving === "kb" ? "Saving…" : item.kb_entry_id ? "Update KB" : "Save to KB"}
            </button>
            <button onClick={remove} className="text-zinc-300 hover:text-red-500" title="Remove question">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ApplicationSection({ opportunityId, onCount }: {
  opportunityId: string;
  /** Reported up so the collapsed section header can say how far along it is. */
  onCount?: (answered: number, total: number) => void;
}) {
  const [items, setItems] = useState<ApplicationAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [newQuestion, setNewQuestion] = useState("");
  const [picking, setPicking] = useState(false);
  const [kb, setKb] = useState<KbEntry[]>([]);
  const [kbSearch, setKbSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/proxy/funding/${opportunityId}/application`);
    setItems(res.ok ? await res.json() : []);
    setLoading(false);
  }, [opportunityId]);
  useEffect(() => { load(); }, [load]);

  // Fetched only when the picker opens — most visits never touch it.
  useEffect(() => {
    if (!picking || kb.length) return;
    fetch("/api/proxy/funding/kb").then(r => r.ok ? r.json() : []).then(setKb).catch(() => {});
  }, [picking, kb.length]);

  async function add(body: Record<string, unknown>) {
    await fetch(`/api/proxy/funding/${opportunityId}/application`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    load();
  }

  const answered = items.filter(i => i.answer?.trim()).length;
  useEffect(() => { onCount?.(answered, items.length); }, [answered, items.length, onCount]);

  const kbFiltered = useMemo(() => {
    const q = kbSearch.trim().toLowerCase();
    const used = new Set(items.map(i => i.kb_entry_id).filter(Boolean));
    return kb
      .filter(e => !used.has(e.entry_id))
      .filter(e => !q || e.question.toLowerCase().includes(q) || (e.answer ?? "").toLowerCase().includes(q));
  }, [kb, kbSearch, items]);

  return (
    <div className="space-y-2">
      {loading ? (
        <p className="text-[11px] text-zinc-400 py-2">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-zinc-400 py-2">
          Nothing recorded yet. Add the funder&apos;s questions as you answer them, or pull
          a standing answer from the Knowledge Base.
        </p>
      ) : (
        <>
          <p className="text-[10px] text-zinc-400 tabular-nums">{answered}/{items.length} answered</p>
          <div className="space-y-1.5">
            {items.map(i => <ApplicationAnswerRow key={i.answer_id} item={i} onChanged={load} />)}
          </div>
        </>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <input value={newQuestion} onChange={e => setNewQuestion(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && newQuestion.trim()) {
              add({ question: newQuestion.trim() });
              setNewQuestion("");
            }
          }}
          placeholder="Add a question the funder asked…"
          className="flex-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        <button
          onClick={() => { if (newQuestion.trim()) { add({ question: newQuestion.trim() }); setNewQuestion(""); } }}
          disabled={!newQuestion.trim()}
          className="px-2.5 py-1.5 text-[11px] bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40 shrink-0">
          Add
        </button>
        <button onClick={() => setPicking(v => !v)}
          className="px-2.5 py-1.5 text-[11px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 shrink-0">
          From KB
        </button>
      </div>

      {picking && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/10 p-2 space-y-1.5">
          <input value={kbSearch} onChange={e => setKbSearch(e.target.value)}
            placeholder="Search the Knowledge Base…"
            className="w-full text-[11px] border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          <div className="max-h-56 overflow-y-auto space-y-1">
            {kbFiltered.length === 0 ? (
              <p className="text-[10px] text-zinc-400 py-2 text-center">
                {kb.length ? "Nothing left to pull in." : "Loading…"}
              </p>
            ) : kbFiltered.map(e => (
              <button key={e.entry_id}
                onClick={() => { add({ kb_entry_id: e.entry_id }); setPicking(false); setKbSearch(""); }}
                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-white dark:hover:bg-zinc-900 transition-colors">
                <span className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.answer?.trim() ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                  <span className="text-[11px] text-zinc-700 dark:text-zinc-300 truncate">{e.question}</span>
                  <span className="text-[9px] text-zinc-400 ml-auto shrink-0">{e.category}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Attaching a thread by hand ─────────────────────────────────────────────
   The matcher files mail on evidence — a known address, a thread already held,
   a domain or a distinctive phrase from the title. What it cannot catch is the
   correspondence with nothing to catch: a programme officer writing from a
   personal address, an intro forwarded by a third party, a thread that predates
   the record. This is the way in for those, and attaching one teaches the
   matcher the address, so the automatic sync owns the conversation afterwards. */

type GmailThreadHit = {
  thread_id: string;
  subject: string;
  from_email: string | null;
  participants: string[];
  message_count: number;
  last_date: string | null;
  snippet: string;
  attached_count: number;
  mailboxes: { user_id: string; email: string; thread_id: string }[];
};

function AttachEmailThread({ entityType, entityId, defaultQuery, onAttached }: {
  entityType: "funding" | "investor" | "deal";
  entityId: string;
  /** The record's own name — the search anyone would type first. */
  defaultQuery?: string;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(defaultQuery ?? "");
  const [hits, setHits] = useState<GmailThreadHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailboxes, setMailboxes] = useState<string[]>([]);

  async function search() {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true); setError(null); setHits(null);
    try {
      const r = await fetch(
        `/api/proxy/comms/${entityType}/${entityId}/gmail-search?q=${encodeURIComponent(q)}&limit=8`);
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.detail === "google_not_connected"
          ? "No Gmail account is connected."
          : "Gmail search failed. Try again.");
        return;
      }
      const data = await r.json();
      setHits(data.threads ?? []);
      setMailboxes(data.mailboxes_searched ?? []);
    } catch {
      setError("Gmail search failed. Try again.");
    } finally { setSearching(false); }
  }

  async function attach(hit: GmailThreadHit) {
    // Whichever of our mailboxes holds it — the ids only mean anything inside
    // the one they came from, so they travel together.
    const mb = hit.mailboxes[0];
    setBusy(hit.thread_id); setError(null);
    try {
      const r = await fetch(`/api/proxy/comms/${entityType}/${entityId}/attach-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: mb.thread_id, mailbox_user_id: mb.user_id }),
      });
      if (!r.ok) { setError("Could not attach that thread."); return; }
      const res = await r.json();
      setHits(prev => (prev ?? []).map(h => h.thread_id === hit.thread_id
        ? { ...h, attached_count: h.message_count } : h));
      if (res.attached > 0) onAttached();
    } catch {
      setError("Could not attach that thread.");
    } finally { setBusy(null); }
  }

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); if (!hits && query.trim().length > 1) search(); }}
        className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        Find an email thread to attach
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") search(); if (e.key === "Escape") setOpen(false); }}
          placeholder="Search Gmail — words, from:someone@, subject:…"
          className={D_INPUT + " flex-1"} />
        <button onClick={search} disabled={searching || query.trim().length < 2}
          className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
          {searching ? "Searching…" : "Search"}
        </button>
        <button onClick={() => setOpen(false)}
          className="text-[11px] px-2 py-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          Close
        </button>
      </div>

      {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}

      {hits !== null && hits.length === 0 && !searching && (
        <p className="text-[11px] text-zinc-400">
          Nothing matched{mailboxes.length > 0 && ` in ${mailboxes.join(" or ")}`}.
        </p>
      )}

      {hits !== null && hits.length > 0 && (
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {hits.map(h => {
            const done = h.attached_count >= h.message_count;
            const partial = h.attached_count > 0 && !done;
            return (
              <div key={h.thread_id}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2">
                <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {h.message_count} message{h.message_count === 1 ? "" : "s"}
                  </span>
                  {/* Which of our mailboxes holds it. Worth showing: a thread
                      only a colleague has is exactly the one that never
                      reached this record on its own. */}
                  {h.mailboxes.map(m => (
                    <span key={m.user_id}
                      className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500">
                      {m.email.split("@")[0]}
                    </span>
                  ))}
                  {h.last_date && (
                    <span className="text-[10px] text-zinc-400 ml-auto">
                      {new Date(h.last_date).toLocaleDateString("en-US",
                        { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                  )}
                </div>
                <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                  {h.subject}
                </p>
                {h.participants.length > 0 && (
                  <p className="text-[10px] text-zinc-500 truncate">
                    {h.participants.slice(0, 4).join(", ")}
                    {h.participants.length > 4 && ` +${h.participants.length - 4}`}
                  </p>
                )}
                {h.snippet && <p className="text-[10px] text-zinc-400 line-clamp-2 mt-0.5">{h.snippet}</p>}
                <div className="flex items-center gap-2 mt-1.5">
                  <button onClick={() => attach(h)} disabled={busy === h.thread_id || done}
                    className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
                    {busy === h.thread_id ? "Attaching…"
                      : done ? "Attached"
                      : partial ? `Attach the other ${h.message_count - h.attached_count}`
                      : "Attach thread"}
                  </button>
                  {partial && (
                    <span className="text-[10px] text-zinc-400">
                      {h.attached_count} of {h.message_count} already here
                    </span>
                  )}
                  <a href={`https://mail.google.com/mail/u/0/#all/${h.mailboxes[0].thread_id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-[11px] text-blue-500 hover:underline ml-auto">
                    Open in Gmail
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-zinc-400">
        Attaching records the whole thread and starts tracking the addresses on it,
        so replies arrive here on their own from then on.
      </p>
    </div>
  );
}


function SuggestedEmails({ opportunityId, onAccepted }: {
  opportunityId: string;
  onAccepted: () => void;
}) {
  const [items, setItems] = useState<EmailSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/proxy/funding/${opportunityId}/suggestions?status=suggested`);
    setItems(res.ok ? await res.json() : []);
    setLoading(false);
  }, [opportunityId]);
  useEffect(() => { load(); }, [load]);

  async function resolve(id: string, action: "accept" | "dismiss") {
    setBusy(id);
    await fetch(`/api/proxy/funding/suggestions/${id}/${action}`, { method: "POST" });
    setBusy(null);
    setItems(prev => prev.filter(s => s.suggestion_id !== id));
    if (action === "accept") onAccepted();
  }

  if (loading) return <p className="text-[11px] text-zinc-400 py-2">Checking for matched emails…</p>;
  if (items.length === 0) {
    return (
      <p className="text-[11px] text-zinc-400 py-2">
        No emails awaiting review. New mail matching this opportunity&apos;s domain or title
        will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {items.map(s => (
        <div key={s.suggestion_id}
          className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/10 px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
              s.direction === "inbound"
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}>
              {s.direction === "inbound" ? "Received" : "Sent"}
            </span>
            {/* Why it matched, so a reviewer can judge the guess rather than
                take it on trust. Both reasons together is a strong signal. */}
            {s.match_reason.map(r => (
              <span key={r} className="text-[9px] px-1.5 py-0.5 rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400">
                {r === "domain" ? "domain match" : r === "subject" ? "subject match" : r}
              </span>
            ))}
            <span className="text-[10px] text-zinc-400 ml-auto">
              {new Date(s.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>
          <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
            {s.subject || "(no subject)"}
          </p>
          {s.from_email && <p className="text-[10px] text-zinc-500 truncate">{s.from_email}</p>}
          {s.snippet && <p className="text-[10px] text-zinc-400 line-clamp-2 mt-0.5">{s.snippet}</p>}
          <div className="flex items-center gap-2 mt-1.5">
            <button onClick={() => resolve(s.suggestion_id, "accept")} disabled={busy === s.suggestion_id}
              className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
              Accept
            </button>
            <button onClick={() => resolve(s.suggestion_id, "dismiss")} disabled={busy === s.suggestion_id}
              className="text-[11px] px-2.5 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-40">
              Dismiss
            </button>
            {s.thread_id && (
              <a href={`https://mail.google.com/mail/u/0/#all/${s.thread_id}`}
                target="_blank" rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:underline ml-auto">
                Open in Gmail
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Opportunity Detail Panel ───────────────────────────────────────────────────

/** Opportunity detail — same shape as InvestorDetailPanel and the /crm deal
 *  drawer: a local authoritative copy of the record, every field saving itself
 *  on blur, and the rarely-needed groups folded into collapsible sections.
 *  There is deliberately no Save button; nothing here can be left unsaved. */
/** Notes and stage moves as one timeline, newest first. Notes are dated,
 *  authored entries (129 replaced the blob); stage moves come from
 *  funding_stage_history, so "who moved this to Applied and when" is on the
 *  record instead of in someone's memory. */
function OppTimeline({ opportunityId, version, onChanged }: {
  opportunityId: string;
  /** Bumped by the panel when something outside this component adds a note. */
  version: number;
  onChanged: () => void;
}) {
  const [notes, setNotes] = useState<OppNote[]>([]);
  const [history, setHistory] = useState<OppStageEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [n, h] = await Promise.all([
      fetch(`/api/proxy/funding/${opportunityId}/notes`).then(r => r.ok ? r.json() : []),
      fetch(`/api/proxy/funding/${opportunityId}/history`).then(r => r.ok ? r.json() : []),
    ]);
    setNotes(Array.isArray(n) ? n : []);
    setHistory(Array.isArray(h) ? h : []);
  }, [opportunityId]);
  useEffect(() => { load(); }, [load, version]);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    await fetch(`/api/proxy/funding/${opportunityId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    setDraft("");
    load();
    onChanged();
  }

  async function saveNote(noteId: string, body: string) {
    await fetch(`/api/proxy/funding/notes/${noteId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    load();
    onChanged();
  }

  async function removeNote(noteId: string) {
    if (!confirm("Delete this note?")) return;
    await fetch(`/api/proxy/funding/notes/${noteId}`, { method: "DELETE" });
    load();
    onChanged();
  }

  const fmtWhen = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // One stream: note cards and stage-move lines, interleaved by time.
  const items = [
    ...notes.map(n => ({ at: n.created_at, key: n.note_id, note: n as OppNote, evt: null as OppStageEvent | null })),
    ...history.map(h => ({ at: h.changed_at, key: h.history_id, note: null as OppNote | null, evt: h as OppStageEvent })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <AutoTextarea value={draft} onChange={e => setDraft(e.target.value)} rows={2}
          placeholder="Add a note…"
          className="flex-1 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-2 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none" />
        <button onClick={add} disabled={busy || !draft.trim()}
          className="shrink-0 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40">
          Add
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-[11px] text-zinc-400 py-2">No notes or stage changes recorded yet.</p>
      )}

      <div className="space-y-1.5">
        {items.map(item => item.note ? (
          <div key={item.key} className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{fmtWhen(item.note.created_at)}</span>
              {item.note.author_name && (
                <span className="text-[10px] text-zinc-400">· {item.note.author_name}</span>
              )}
              <button onClick={() => removeNote(item.note!.note_id)}
                className="ml-auto text-zinc-300 hover:text-red-500" title="Delete note">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <AutoField value={item.note.body} multiline placeholder="—"
              onSave={v => { if (v) saveNote(item.note!.note_id, v); }} />
          </div>
        ) : (
          // A stage move: a quiet system line, not a card — it is context, not content.
          <div key={item.key} className="flex items-center gap-1.5 px-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <span>
              {item.evt!.stage_from
                ? <>Moved <span className="font-medium text-zinc-500 dark:text-zinc-400">{item.evt!.stage_from}</span> → <span className="font-medium text-zinc-500 dark:text-zinc-400">{item.evt!.stage_to}</span></>
                : <>Created as <span className="font-medium text-zinc-500 dark:text-zinc-400">{item.evt!.stage_to}</span></>}
              {" · "}{fmtWhen(item.evt!.changed_at)}
              {item.evt!.changed_by_name ? ` · ${item.evt!.changed_by_name}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The Opportunity Details record — enrichment metadata, one row per
 *  opportunity, joined on the id rather than the title (134). Loaded lazily:
 *  the board never needs it, only an open panel does. */
function OpportunityDetailsSection({ opportunityId, onStatus }: {
  opportunityId: string;
  onStatus?: (status: string) => void;
}) {
  const [rec, setRec] = useState<OpportunityDetails | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/proxy/funding/${opportunityId}/details`);
    const d = res.ok ? await res.json() : null;
    setRec(d);
    setLoading(false);
    if (d) onStatus?.(d.record_status);
  }, [opportunityId, onStatus]);
  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (fields: Partial<OpportunityDetails>) => {
    setRec(p => (p ? { ...p, ...fields } : p));
    if (fields.record_status) onStatus?.(fields.record_status);
    await fetch(`/api/proxy/funding/${opportunityId}/details`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  }, [opportunityId, onStatus]);

  if (loading || !rec) {
    return <p className="text-[11px] text-zinc-400 py-2">Loading…</p>;
  }

  // 'Unknown' is a researched answer meaning "we looked and could not source
  // it", so it is shown as written rather than treated as an empty field.
  const s2 = (v: string | null) => v ?? "";

  return (
    <div className="space-y-2.5">
      <DetailRow label="Record Status">
        <QuietSelect value={rec.record_status}
          onChange={v => patch({ record_status: v })}>
          {RECORD_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </QuietSelect>
      </DetailRow>
      <DetailRow label="Equity Taken">
        <AutoField value={s2(rec.equity_taken)} placeholder="+ None — equity-free"
          onSave={v => patch({ equity_taken: v })} />
      </DetailRow>
      <DetailRow label="Fit Rationale">
        <AutoField value={s2(rec.fit_rationale)} multiline placeholder="+ why this tier"
          onSave={v => patch({ fit_rationale: v })} />
      </DetailRow>
      <DetailRow label="Focus Areas">
        <AutoField value={s2(rec.focus_areas)} multiline placeholder="+ stated thematic scope"
          onSave={v => patch({ focus_areas: v })} />
      </DetailRow>
      <DetailRow label="Requirements">
        <AutoField value={s2(rec.application_requirements)} multiline
          placeholder="+ LOI, partner, pitch video, financials"
          onSave={v => patch({ application_requirements: v })} />
      </DetailRow>
      <DetailRow label="Program Contact">
        <AutoField value={s2(rec.program_contact)} placeholder="+ name / email / org"
          onSave={v => patch({ program_contact: v })} />
      </DetailRow>
      <DetailRow label="Sources">
        <AutoField value={s2(rec.sources)} multiline placeholder="+ URLs and documents"
          onSave={v => patch({ sources: v })} />
      </DetailRow>
      <DetailRow label="Data Gaps">
        <AutoField value={s2(rec.data_gaps)} multiline placeholder="+ what is still unverified"
          onSave={v => patch({ data_gaps: v })} />
      </DetailRow>
    </div>
  );
}

function OpportunityDetailPanel({ opp, onClose, onSaved, onDelete }: {
  opp: Opportunity; onClose: () => void; onSaved: () => void; onDelete: () => void;
}) {
  const [rec, setRec] = useState<Opportunity>(opp);
  useEffect(() => { setRec(opp); }, [opp]);

  const fundingTypes = useFundingTypes();

  // The panel title edits the opportunity title; kept in step with the record
  // so an enrichment pass that rewrites it is reflected here too.
  const [titleDraft, setTitleDraft] = useState(opp.title);
  useEffect(() => { setTitleDraft(rec.title); }, [rec.title]);

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkingProject, setLinkingProject] = useState(false);

  // Deadline date and time are drafted locally and committed on blur — bound
  // straight to the record they would fire a PATCH per keystroke in the time
  // field, and every other field in this panel already saves on blur.
  const [deadlineDraft, setDeadlineDraft] = useState(opp.deadline ?? "");
  const [deadlineTimeDraft, setDeadlineTimeDraft] = useState(opp.deadline_time ?? "");
  useEffect(() => { setDeadlineDraft(rec.deadline ?? ""); }, [rec.deadline]);
  useEffect(() => { setDeadlineTimeDraft(rec.deadline_time ?? ""); }, [rec.deadline_time]);

  // AI enrichment state
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<EnrichResult | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  // Bumped when a note is written from outside OppTimeline (the enricher), so
  // the timeline refetches without owning that write itself.
  const [timelineVersion, setTimelineVersion] = useState(0);
  // Accepting a suggestion writes a comm_messages row; remounting EntityActivity
  // is how it picks that up, since the panel owns its own fetch.
  const [activityVersion, setActivityVersion] = useState(0);

  const [detailsStatus, setDetailsStatus] = useState("Unenriched");

  const [applicationCount, setApplicationCount] = useState<[number, number]>([0, 0]);
  const handleApplicationCount = useCallback(
    (answered: number, total: number) => setApplicationCount([answered, total]), []);
  const applicationSummary = applicationCount[1]
    ? `${applicationCount[0]}/${applicationCount[1]} answered`
    : "None recorded";

  const detachEmail = useCallback(async (gmailMessageId: string, subject: string) => {
    if (!confirm(`Detach "${subject || "this email"}" from this opportunity?`)) return;
    await fetch(`/api/proxy/funding/${opp.opportunity_id}/detach-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gmail_message_id: gmailMessageId }),
    });
    setActivityVersion(v => v + 1);
  }, [opp.opportunity_id]);
  const addNote = useCallback(async (body: string) => {
    await fetch(`/api/proxy/funding/${opp.opportunity_id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setTimelineVersion(v => v + 1);
    onSaved();
  }, [opp.opportunity_id, onSaved]);

  const patch = useCallback(async (fields: Partial<Opportunity>) => {
    setRec(p => ({ ...p, ...fields }));
    setSaving(true);
    try {
      await fetch(`/api/proxy/funding/${opp.opportunity_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [opp.opportunity_id, onSaved]);

  async function createGrantProject() {
    setLinkingProject(true);
    try {
      const r = await fetch(`/api/proxy/funding/${opp.opportunity_id}/link-project`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setRec(p => ({ ...p, linked_project_id: d.project_id }));
        onSaved();
      }
    } finally { setLinkingProject(false); }
  }

  async function runEnrich() {
    setEnriching(true); setEnrichResult(null); setEnrichError(null);
    try {
      const resp = await fetch(`/api/proxy/funding/${opp.opportunity_id}/enrich`, { method: "POST" });
      if (!resp.ok) { setEnrichError("Enrichment failed. Try again."); return; }
      setEnrichResult(await resp.json());
    } finally {
      setEnriching(false);
    }
  }

  /** Enrichment writes straight through, like every other field in the panel. */
  function applyAllEnrich() {
    if (!enrichResult) return;
    const fields: Partial<Opportunity> = {};
    if (enrichResult.funding_type)  fields.funding_type = enrichResult.funding_type;
    if (enrichResult.dilution)      fields.dilution = enrichResult.dilution;
    if (enrichResult.amount != null) {
      fields.amount = enrichResult.amount;
      if (enrichResult.amount_currency) fields.amount_currency = enrichResult.amount_currency;
    }
    if (enrichResult.amount_notes)  fields.amount_notes = enrichResult.amount_notes;
    if (enrichResult.tags?.length)  fields.tags = enrichResult.tags;
    // Enrichment findings land as a dated note, not an overwrite of anything.
    if (enrichResult.notes)         addNote(enrichResult.notes);
    if (enrichResult.decision_date) fields.decision_date = enrichResult.decision_date;
    if (Object.keys(fields).length) patch(fields);
    setEnrichResult(null);
  }

  async function syncToCalendar() {
    if (!rec.deadline) { setSyncError("Set a deadline date first."); return; }
    setSyncing(true); setSyncError(null);
    try {
      const time = rec.deadline_time || "09:00";
      const [hh, mm] = time.split(":");
      const endH = String(Math.min(23, parseInt(hh) + 1)).padStart(2, "0");
      const startDt = `${rec.deadline}T${hh}:${mm}:00`;
      const endDt   = `${rec.deadline}T${endH}:${mm}:00`;

      const calBody = {
        title: `Funding Deadline: ${rec.title}`,
        description: `Stage: ${rec.stage}`
          + (rec.amount !== null && rec.amount !== undefined
              ? `\nAmount: ${fmtAward(rec.amount, rec.amount_currency)}` : "")
          + (rec.amount_notes ? `\nAmount notes: ${rec.amount_notes}` : "")
          + (rec.latest_note ? `\n\n${rec.latest_note}` : ""),
        start: startDt, end: endDt, timezone: "UTC",
      };

      const url = rec.gcal_event_id
        ? `/api/proxy/calendar/events/${rec.gcal_event_id}`
        : `/api/proxy/calendar/events`;

      const resp = await fetch(url, {
        method: rec.gcal_event_id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calBody),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setSyncError(err.detail === "google_not_connected"
          ? "Google Calendar not connected. Connect in Settings."
          : "Calendar sync failed. Try again.");
        return;
      }

      const data = await resp.json();
      await patch({ gcal_event_id: data.id as string });
    } finally {
      setSyncing(false);
    }
  }

  const s = (v: string | null | undefined) => v ?? "";
  const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
  const hostOf = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  };

  const stage = nonDilStage(rec.stage);
  const urgency = nonDilUrgency(rec);
  const notesSummary = joined(
    rec.tags.length ? `${rec.tags.length} tag${rec.tags.length === 1 ? "" : "s"}` : null,
    rec.notes_count ? `${rec.notes_count} note${rec.notes_count === 1 ? "" : "s"}` : null,
    rec.latest_note ? rec.latest_note.replace(/\s+/g, " ").slice(0, 60) : null,
  ) || "Empty";

  // Fit first, then whatever disqualifies it — the two things worth seeing
  // without opening the section.
  const screeningSummary = joined(
    rec.org_fit && rec.org_fit !== "Unrated" ? rec.org_fit : null,
    rec.eligibility ? rec.eligibility.replace(/\s+/g, " ").slice(0, 44) : null,
  ) || "Not screened";

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" />
      {/* Panel */}
      <div className="w-full max-w-2xl bg-zinc-50 dark:bg-zinc-950 h-full overflow-hidden shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="flex-1 min-w-0 pr-4 flex items-start gap-3">
            {/* Owner — sits to the left of the title, as on an investor */}
            <div className="pt-0.5">
              <AssigneePicker
                assignedTo={rec.assignee_id}
                assignedName={rec.assignee_name}
                onAssign={async uid => {
                  setRec(p => ({ ...p, assignee_name: assignableName(uid) }));
                  await patch({ assignee_id: uid });
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <input
                className="w-full text-xl font-bold text-zinc-900 dark:text-zinc-50 bg-transparent border-0 outline-none focus:bg-zinc-50 dark:focus:bg-zinc-800 rounded-lg px-1 -mx-1 py-0.5 transition-colors"
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={() => { const v = titleDraft.trim(); if (v && v !== rec.title) patch({ title: v }); }}
                placeholder="Opportunity title"
              />
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${urgency.cls}`} title={`Urgency: ${urgency.label}`} />
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{urgency.label}</span>
                </span>
                {/* Stage — the column this record sits in on the board. */}
                <QuietSelect
                  value={rec.stage}
                  onChange={next => { if (next !== rec.stage) patch({ stage: next }); }}
                  className="font-medium"
                  tone={stage.color.header}
                >
                  {NONDIL_KANBAN_COLS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </QuietSelect>
                <FundingTypeChip value={rec.funding_type} />
                <DilutionTag value={rec.dilution} />
                {rec.amount !== null && rec.amount !== undefined && (
                  <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 tabular-nums"
                    title={rec.amount_notes ?? undefined}>
                    {fmtAward(rec.amount, rec.amount_currency)}
                  </span>
                )}
                {isLinkUrl(rec.source_link) && (
                  <a href={rec.source_link!} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                    {hostOf(rec.source_link!)}
                    <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                  </a>
                )}
                <span className={`text-[11px] transition-opacity ${saving ? "text-zinc-400 opacity-100" : "opacity-0"}`}>Saving…</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="flex items-center gap-2">
              <button onClick={runEnrich} disabled={enriching}
                title="Auto-enrich with AI"
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/30 hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-50 transition-colors">
                {enriching
                  ? <><span className="animate-spin inline-block w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full" />Enriching…</>
                  : <><svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>Enrich</>
                }
              </button>
              <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <TransferControl from="opportunity" id={rec.opportunity_id}
              onDone={m => { onSaved(); if (m === "move") onClose(); }} />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">

          {enrichError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-xs text-red-600 dark:text-red-400 flex items-center justify-between">
              {enrichError}
              <button onClick={() => setEnrichError(null)} className="ml-2 hover:text-red-800">✕</button>
            </div>
          )}

          {enrichResult && (
            <div className="rounded-xl border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-violet-600 dark:text-violet-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
                  <span className="text-xs font-semibold text-violet-800 dark:text-violet-300">AI Enrichment</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={applyAllEnrich} className="text-xs px-2.5 py-1 bg-violet-600 text-white rounded-lg hover:bg-violet-700 font-medium">Apply All</button>
                  <button onClick={() => setEnrichResult(null)} className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 rounded">Dismiss</button>
                </div>
              </div>
              {enrichResult.enrichment_summary && (
                <p className="text-xs text-violet-700 dark:text-violet-400 italic">{enrichResult.enrichment_summary}</p>
              )}
              <div className="space-y-2">
                {([
                  ["Funding Type",  enrichResult.funding_type,  () => patch({ funding_type: enrichResult.funding_type! })],
                  ["Dilution",      dilutionLabel(enrichResult.dilution), () => patch({ dilution: enrichResult.dilution! })],
                  ["Amount",        fmtAward(enrichResult.amount, enrichResult.amount_currency), () => patch({ amount: enrichResult.amount!, amount_currency: enrichResult.amount_currency ?? "USD" })],
                  ["Amount Notes",  enrichResult.amount_notes,  () => patch({ amount_notes: enrichResult.amount_notes! })],
                  ["Tags",          enrichResult.tags?.length ? enrichResult.tags.join(", ") : null, () => patch({ tags: enrichResult.tags! })],
                  ["Decision Date", enrichResult.decision_date, () => patch({ decision_date: enrichResult.decision_date! })],
                ] as [string, string | null | undefined, () => void][]).map(([label, value, apply]) => value ? (
                  <div key={label} className="flex items-center justify-between bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 border border-violet-100 dark:border-violet-900">
                    <div className="min-w-0">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{value}</p>
                    </div>
                    <button onClick={apply} className="text-xs text-violet-600 hover:text-violet-800 font-medium shrink-0 ml-2">Apply</button>
                  </div>
                ) : null)}
                {enrichResult.notes && (
                  <div className="bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 border border-violet-100 dark:border-violet-900">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">Notes</p>
                      <button onClick={() => addNote(enrichResult.notes!)} className="text-xs text-violet-600 hover:text-violet-800 font-medium">Add as note</button>
                    </div>
                    <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">{enrichResult.notes}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* GENERAL — always visible */}
          <div className={D_CARD + " p-3 space-y-2.5"}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
              <DetailRow label="Funding Type">
                <QuietSelect value={rec.funding_type ?? ""}
                  onChange={v => patch({ funding_type: v || null })}>
                  <option value="">—</option>
                  {fundingTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </QuietSelect>
              </DetailRow>
              <DetailRow label="Dilution">
                <QuietSelect value={rec.dilution ?? ""}
                  onChange={v => patch({ dilution: v || null })}>
                  <option value="">—</option>
                  {DILUTION_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </QuietSelect>
              </DetailRow>
              <DetailRow label="Amount">
                <span className="flex items-center gap-1">
                  <span className="text-xs text-zinc-400">{currencySymbol(rec.amount_currency).trim()}</span>
                  <AutoField
                    value={rec.amount === null || rec.amount === undefined ? "" : String(rec.amount)}
                    placeholder="+ 250000" type="number"
                    onSave={v => patch({ amount: v === null ? null : Number(v) })} />
                  <QuietSelect value={rec.amount_currency ?? "USD"} className="w-20"
                    tone="text-zinc-400 dark:text-zinc-500"
                    onChange={v => patch({ amount_currency: v })}>
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </QuietSelect>
                </span>
              </DetailRow>
              {/* Directly under Amount: what the figure cannot carry. An award
                  with no cash at all lives here with Amount left empty. */}
              <DetailRow label="Amount Notes">
                <AutoField value={s(rec.amount_notes)} multiline
                  placeholder="+ range, equity stake, in-kind benefits…"
                  onSave={v => patch({ amount_notes: v })} />
              </DetailRow>
              <DetailRow label="Dispersion">
                <AutoField value={s(rec.funding_dispersion)} placeholder="+ Lump sum, Milestone…"
                  onSave={v => patch({ funding_dispersion: v })} />
              </DetailRow>
              <DetailRow label="Decision Date">
                <AutoField value={s(rec.decision_date)} placeholder="+ 2026-06-01"
                  onSave={v => patch({ decision_date: v })} />
              </DetailRow>
            </div>

            {/* Deadline — the field the whole board is sorted by, so it keeps
                its own row with the calendar action beside it. */}
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <DetailRow label="Deadline">
                <div className="flex items-center gap-2 flex-wrap">
                  <input type="date" value={deadlineDraft}
                    onChange={e => setDeadlineDraft(e.target.value)}
                    onBlur={() => { if (deadlineDraft !== s(rec.deadline)) patch({ deadline: deadlineDraft || null }); }}
                    className={D_INPUT} />
                  <input type="time" value={deadlineTimeDraft}
                    onChange={e => setDeadlineTimeDraft(e.target.value)}
                    onBlur={() => { if (deadlineTimeDraft !== s(rec.deadline_time)) patch({ deadline_time: deadlineTimeDraft || null }); }}
                    className={D_INPUT} />
                  <button
                    onClick={syncToCalendar}
                    disabled={syncing || !rec.deadline}
                    title={rec.gcal_event_id ? "Update Google Calendar event" : "Add to Google Calendar"}
                    className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                      rec.gcal_event_id
                        ? "bg-green-50 text-green-700 border-green-200 hover:bg-green-100 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800"
                        : "bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                    }`}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19.5 3h-2V1.5A1.5 1.5 0 0016 0h-1a1.5 1.5 0 00-1.5 1.5V3h-7V1.5A1.5 1.5 0 005 0H4a1.5 1.5 0 00-1.5 1.5V3h-2A.5.5 0 000 3.5v17A3.5 3.5 0 003.5 24h17a3.5 3.5 0 003.5-3.5v-17a.5.5 0 00-.5-.5zm-1 17.5a2.5 2.5 0 01-2.5 2.5h-12A2.5 2.5 0 011.5 20.5V8h18v12.5z"/>
                    </svg>
                    {syncing ? "Syncing…" : rec.gcal_event_id ? "Synced" : "Add to Cal"}
                  </button>
                </div>
              </DetailRow>
              {syncError && <p className="text-[11px] text-red-500 mt-1">{syncError}</p>}
            </div>
          </div>

          {/* Linked grant project */}
          <div className="flex flex-wrap items-center gap-1.5">
            {rec.linked_project_id ? (
              <a href={`/projects/${rec.linked_project_id}`}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 transition-colors font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
                </svg>
                View linked Grant project →
              </a>
            ) : (
              <button onClick={createGrantProject} disabled={linkingProject}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-400 hover:bg-violet-100 disabled:opacity-50 transition-colors font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {linkingProject ? "Creating…" : "Create Grant & Funding Project"}
              </button>
            )}
          </div>

          {/* ACTIVITY — the same comms panel the investor and CRM boards use,
              on entity_type 'funding' (130). Drive attachments are gone; email
              arrives through the matcher instead of being searched for by hand. */}
          <DetailSection title="Activity" defaultOpen>
            <div className="space-y-3">
              {/* Suggestions are a waiting room, not a second list — accepting
                  one moves it into the timeline below, which is the single
                  place attached mail lives, opens and is removed from. */}
              <SuggestedEmails opportunityId={opp.opportunity_id}
                onAccepted={() => setActivityVersion(v => v + 1)} />
              {/* The other way in. The matcher offers what it can prove belongs
                  here; this is for the thread it had nothing to go on. */}
              <AttachEmailThread entityType="funding" entityId={opp.opportunity_id}
                defaultQuery={rec.title}
                onAttached={() => setActivityVersion(v => v + 1)} />
              <EntityActivity key={activityVersion} entityType="funding"
                entityId={opp.opportunity_id}
                assignedTo={rec.assignee_id ?? null}
                onChanged={onSaved}
                onRemoveMessage={detachEmail} />
            </div>
          </DetailSection>

          {/* SCREENING — can we apply, what does it cost, is it worth it, what next.
              Open by default: these four answers decide whether the rest of the
              panel is worth reading at all. */}
          <DetailSection title="Screening" summary={screeningSummary} defaultOpen>
            <div className="space-y-2.5">
              <DetailRow label="Open ERP Fit">
                <QuietSelect value={rec.org_fit ?? "Unrated"}
                  onChange={v => patch({ org_fit: v })}>
                  {OPENERP_FIT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </QuietSelect>
              </DetailRow>
              <DetailRow label="Eligibility">
                <AutoField value={s(rec.eligibility)} multiline
                  placeholder="+ blockers first — e.g. EU incorporation required"
                  onSave={v => patch({ eligibility: v })} />
              </DetailRow>
              <DetailRow label="Cost Share / Match">
                <AutoField value={s(rec.cost_share_match)}
                  placeholder="+ 25% match, $19 fee, or None"
                  onSave={v => patch({ cost_share_match: v })} />
              </DetailRow>
              <DetailRow label="Next Action">
                <AutoField value={s(rec.next_action)}
                  placeholder="+ File LOI by Jan 21"
                  onSave={v => patch({ next_action: v })} />
              </DetailRow>
              <DetailRow label="Last Verified">
                <AutoField value={s(rec.last_verified)} type="date"
                  placeholder="+ never verified"
                  onSave={v => patch({ last_verified: v })} />
              </DetailRow>
            </div>
          </DetailSection>

          {/* OPPORTUNITY DETAILS — enrichment metadata, off the decision view. */}
          <DetailSection title="Opportunity Details" summary={detailsStatus}>
            <OpportunityDetailsSection opportunityId={opp.opportunity_id}
              onStatus={setDetailsStatus} />
          </DetailSection>

          {/* APPLICATION — what the funder asked and what we wrote back. */}
          <DetailSection title="Application" summary={applicationSummary}>
            <ApplicationSection opportunityId={opp.opportunity_id}
              onCount={handleApplicationCount} />
          </DetailSection>

          {/* LINKS */}
          <DetailSection title="Links" summary={rec.source_link ? hostOf(rec.source_link) : "None"}>
            <div className="space-y-2">
              <DetailLinkRow label="Source Link" value={rec.source_link} onSave={v => patch({ source_link: v })} />
            </div>
          </DetailSection>

          {/* NOTES & HISTORY */}
          <DetailSection title="Notes & History" summary={notesSummary} defaultOpen>
            <div className="space-y-3">
              <div>
                <span className={D_LABEL + " block mb-1"}>Tags <span className="normal-case font-normal">(comma-separated)</span></span>
                {rec.tags.length > 0 && (
                  <div className="mb-1.5"><TagList tags={rec.tags} /></div>
                )}
                <AutoField value={rec.tags.join(", ")} placeholder="+ federal, phase-1"
                  onSave={v => patch({ tags: v ? v.split(",").map(x => x.trim()).filter(Boolean) : [] })} />
              </div>
              <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <OppTimeline opportunityId={opp.opportunity_id}
                  version={timelineVersion} onChanged={onSaved} />
              </div>
            </div>
          </DetailSection>

          <div className="text-[11px] text-zinc-300 dark:text-zinc-600 text-right pt-1 space-y-0.5">
            {rec.gcal_event_id && <p className="text-green-600/70 dark:text-green-500/70">Google Calendar event linked</p>}
            {rec.created_at && <p>Created {new Date(rec.created_at).toLocaleDateString()}</p>}
            <p>#{opp.opportunity_id}</p>
          </div>

          <div className="pt-2 flex justify-end">
            <button onClick={() => setConfirmDelete(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors font-medium">
              Delete opportunity
            </button>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <DeleteConfirm title={rec.title} onConfirm={onDelete} onCancel={() => setConfirmDelete(false)} />
      )}
    </div>
  );
}

// ── Non-Dilutive Kanban ────────────────────────────────────────────────────────

type NonDilSort = "deadline_asc" | "deadline_desc" | "manual";
type NonDilSortState = { board: NonDilSort; cols: Record<string, NonDilSort> };

const NONDIL_SORT_KEY = "nondil_sort";

/* Soonest-first everywhere except Withdrawn, where every deadline is in the
   past and the useful end of the list is the recent one. That was previously
   hard-coded into the comparator; here it is just the starting position of a
   control anyone can move. */
const DEFAULT_NONDIL_SORT: NonDilSortState = {
  board: "deadline_asc",
  cols: { Withdrawn: "deadline_desc" },
};

const NONDIL_SORT_CHOICES = [
  ["deadline_asc", "Deadline ↑", "Soonest deadline first"],
  ["deadline_desc", "Deadline ↓", "Latest deadline first"],
  ["manual", "Manual", "Leave each column in the order it arrives"],
] as const;

function NonDilutiveKanban({
  rows,
  selectedIds,
  onToggleSelect,
  onReload,
  onAddInCol,
}: {
  rows: Opportunity[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onReload: () => void;
  onAddInCol: (stage: string) => void;
}) {
  const dragId = useRef<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The two terminal columns start closed, as they do on the investor board
  // and in /crm.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(NONDIL_KANBAN_COLS.filter(c => c.autoCollapse).map(c => c.id)),
  );
  const [detailOpp, setDetailOpp] = useState<Opportunity | null>(null);

  // The panel now survives a refetch, so re-point it at the refreshed row
  // instead of leaving it on the snapshot it opened with. Falls back to the
  // snapshot when the row is not in the current set — a search that filters it
  // out should not slam an open panel shut mid-edit.
  useEffect(() => {
    setDetailOpp(prev => prev
      ? (rows.find(r => r.opportunity_id === prev.opportunity_id) ?? prev)
      : null);
  }, [rows]);

  // Editable column labels persisted to localStorage
  const [colLabels, setColLabels] = useState<Record<string, string>>(() => {
    try {
      const stored = localStorage.getItem("nondil_col_labels");
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColLabel, setEditingColLabel] = useState("");

  function getColLabel(col: NonDilStage) {
    return colLabels[col.id] ?? col.label;
  }
  function startEditColLabel(col: NonDilStage) {
    setEditingColId(col.id);
    setEditingColLabel(getColLabel(col));
  }
  function saveColLabel(colId: string) {
    const trimmed = editingColLabel.trim();
    if (trimmed) {
      const next = { ...colLabels, [colId]: trimmed };
      setColLabels(next);
      try { localStorage.setItem("nondil_col_labels", JSON.stringify(next)); } catch {}
    }
    setEditingColId(null);
  }

  // Inline card editing
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineForm, setInlineForm] = useState<{ title: string; deadline: string; amount: string; amount_notes: string; notes: string }>(
    { title: "", deadline: "", amount: "", amount_notes: "", notes: "" });

  function startInlineEdit(opp: Opportunity, e: React.MouseEvent) {
    e.stopPropagation();
    setInlineEditId(opp.opportunity_id);
    setInlineForm({
      title: opp.title, deadline: opp.deadline ?? "",
      amount: opp.amount === null || opp.amount === undefined ? "" : String(opp.amount),
      amount_notes: opp.amount_notes ?? "",
      notes: "",
    });
  }

  async function saveInlineEdit(oppId: string) {
    await fetch(`/api/proxy/funding/${oppId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: inlineForm.title.trim() || undefined,
        deadline: inlineForm.deadline || null,
        amount: inlineForm.amount.trim() === "" ? null : Number(inlineForm.amount),
        amount_notes: inlineForm.amount_notes.trim() || null,
      }),
    });
    // The card's note box appends to the log rather than editing it — it starts
    // empty every time, so a quick edit can never clobber an earlier entry.
    if (inlineForm.notes.trim()) {
      await fetch(`/api/proxy/funding/${oppId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: inlineForm.notes.trim() }),
      });
    }
    setInlineEditId(null);
    onReload();
  }

  /* Sorting is two settings, not one. The bar above the board answers "put
     every column in deadline order" in a single click; a column can still
     disagree with it, and Withdrawn does by default. Both persist, like the
     column labels above — a sort you have to re-apply after every reload is
     not really a setting. */
  const [sort, setSort] = useState<NonDilSortState>(() => {
    try {
      const stored = localStorage.getItem(NONDIL_SORT_KEY);
      if (stored) return { ...DEFAULT_NONDIL_SORT, ...JSON.parse(stored) };
    } catch { /* a corrupt entry is not worth failing the board over */ }
    return DEFAULT_NONDIL_SORT;
  });

  function persistSort(next: NonDilSortState) {
    setSort(next);
    try { localStorage.setItem(NONDIL_SORT_KEY, JSON.stringify(next)); } catch {}
  }

  /** Every column at once — including the ones that had been set individually,
   *  which is the whole point of a control that says "every column". */
  function sortAllColumns(mode: NonDilSort) {
    persistSort({ board: mode, cols: {} });
  }

  /** One column steps out of line: deadline ↑ → deadline ↓ → manual → ↑. */
  function cycleColSort(colId: string) {
    const order: NonDilSort[] = ["deadline_asc", "deadline_desc", "manual"];
    const current = sort.cols[colId] ?? sort.board;
    const next = order[(order.indexOf(current) + 1) % order.length];
    persistSort({ ...sort, cols: { ...sort.cols, [colId]: next } });
  }

  const sortFor = (colId: string): NonDilSort => sort.cols[colId] ?? sort.board;
  const overrideCount = Object.keys(sort.cols).length;

  const byCol: Record<string, Opportunity[]> = {};
  for (const col of NONDIL_KANBAN_COLS) byCol[col.id] = [];
  for (const opp of rows) {
    if (byCol[opp.stage]) byCol[opp.stage].push(opp);
    else byCol["Applied"]?.push(opp);
  }
  // Sort each column to whatever it is currently set to.
  for (const col of NONDIL_KANBAN_COLS) {
    const mode = sortFor(col.id);
    if (mode === "manual") continue;
    const dir = mode === "deadline_asc" ? 1 : -1;
    byCol[col.id].sort((a, b) => {
      // An application with no deadline has nothing to sort on, so it sinks to
      // the bottom in both directions. Reversing the sort should not float the
      // unscheduled ones to the top of the board.
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return a.deadline < b.deadline ? -dir : a.deadline > b.deadline ? dir : 0;
    });
  }

  function toggleCollapse(colId: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }

  async function handleColDrop(stage: string) {
    if (!dragId.current) return;
    const id = dragId.current;
    dragId.current = null;
    setDragOverCol(null);
    setDraggingId(null);
    await fetch(`/api/proxy/funding/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage }),
    });
    onReload();
  }

  async function doDelete(opp: Opportunity) {
    await fetch(`/api/proxy/funding/${opp.opportunity_id}`, { method: "DELETE" });
    onReload();
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex items-center gap-1.5 px-4 pt-3 text-[11px] shrink-0">
          <span className="text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium mr-0.5">
            Sort every column
          </span>
          {NONDIL_SORT_CHOICES.map(([mode, label, hint]) => (
            <button key={mode} onClick={() => sortAllColumns(mode)} title={hint}
              className={`px-2 py-0.5 rounded-md border transition-colors ${
                sort.board === mode && overrideCount === 0
                  ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 font-medium"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"}`}>
              {label}
            </button>
          ))}
          {overrideCount > 0 && (
            <span className="text-gray-400 dark:text-gray-500">
              · {overrideCount} column{overrideCount === 1 ? "" : "s"} set on its own
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-2 px-4 pb-4 pt-2 h-full min-w-max items-start">
        {NONDIL_KANBAN_COLS.map(col => {
          const colItems = byCol[col.id] ?? [];
          const isCollapsed = collapsed.has(col.id);
          const isColOver = dragOverCol === col.id;
          const st = col.color;
          const colMode = sortFor(col.id);

          return (
            <div key={col.id} className={`flex flex-col shrink-0 transition-all ${isCollapsed ? "w-10" : "w-60"}`}>
              {/* Column header */}
              <div
                className={`flex items-center gap-1.5 mb-2 px-1 cursor-pointer select-none ${isCollapsed ? "flex-col gap-2" : "justify-between"}`}
                onClick={() => toggleCollapse(col.id)}
                title={isCollapsed ? `Expand ${getColLabel(col)}` : `Collapse ${getColLabel(col)}`}
              >
                {isCollapsed ? (
                  <>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide ${st.header} whitespace-nowrap`}
                      style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                    >
                      {getColLabel(col)}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">{colItems.length}</span>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                      {editingColId === col.id ? (
                        <input
                          autoFocus
                          className="text-xs font-semibold bg-white dark:bg-gray-800 border border-blue-400 rounded px-1 py-0.5 w-24 outline-none"
                          value={editingColLabel}
                          onChange={e => setEditingColLabel(e.target.value)}
                          onBlur={() => saveColLabel(col.id)}
                          onKeyDown={e => { if (e.key === "Enter") saveColLabel(col.id); if (e.key === "Escape") setEditingColId(null); }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className={`text-xs font-semibold uppercase tracking-wide truncate ${st.header}`}
                          onDoubleClick={e => { e.stopPropagation(); startEditColLabel(col); }}
                          title="Double-click to rename"
                        >
                          {getColLabel(col)}
                        </span>
                      )}
                      <StageInfoIcon stage={col} label={getColLabel(col)} />
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-gray-400 dark:text-gray-600 tabular-nums">{colItems.length}</span>
                      <button
                        onClick={e => { e.stopPropagation(); cycleColSort(col.id); }}
                        className={`transition-colors ml-0.5 p-0.5 ${
                          colMode === "manual"
                            ? "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                            : st.header}`}
                        title={
                          colMode === "deadline_asc"
                            ? "Deadline, soonest first — click for latest first"
                            : colMode === "deadline_desc"
                              ? "Deadline, latest first — click for manual order"
                              : "Manual order — click to sort by deadline"
                        }
                      >
                        {/* Same glyph flipped, so the arrow points the way the
                            list runs rather than needing a second icon. */}
                        <span className={`inline-block ${colMode === "deadline_desc" ? "scale-y-[-1]" : ""}`}>
                          <InvestorSortIcon />
                        </span>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); onAddInCol(col.id); }}
                        className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors ml-0.5 p-0.5"
                        title={`Add to ${getColLabel(col)}`}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                      <BoardChevronIcon collapsed={false} />
                    </div>
                  </>
                )}
              </div>

              {/* Cards — the list itself is the drop zone */}
              {!isCollapsed && (
                <div
                  className={`flex flex-col gap-2 flex-1 overflow-y-auto pr-0.5 rounded-lg transition-colors ${
                    draggingId && isColOver ? `${st.bg} ring-1 ring-inset ${st.card}` : ""
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOverCol(col.id); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null); }}
                  onDrop={() => handleColDrop(col.id)}
                >
                  {colItems.length === 0 ? (
                    <div className={`border border-dashed rounded-lg p-4 text-center transition-colors ${
                      draggingId && isColOver ? `${st.card} border-solid` : "border-gray-200 dark:border-white/8"
                    }`}>
                      <p className="text-xs text-gray-400 dark:text-gray-600">No applications here.</p>
                    </div>
                  ) : colItems.map(opp => {
                    const isBeingDragged = draggingId === opp.opportunity_id;
                    const isSelected = selectedIds.has(opp.opportunity_id);
                    const isInlineEditing = inlineEditId === opp.opportunity_id;
                    const urgency = nonDilUrgency(opp);
                    const overdue = isOverdue(opp.deadline) && !["Won", "Rejected", "Withdrawn"].includes(opp.stage);
                    const deadlineLabel = opp.deadline
                      ? new Date(opp.deadline + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
                      : null;

                    if (isInlineEditing) {
                      return (
                        <div key={opp.opportunity_id}
                          className="bg-white dark:bg-zinc-900 border border-blue-400 dark:border-blue-500 rounded-lg shadow-sm p-3 space-y-2"
                          onClick={e => e.stopPropagation()}>
                          <input
                            autoFocus
                            value={inlineForm.title}
                            onChange={e => setInlineForm(f => ({ ...f, title: e.target.value }))}
                            onKeyDown={e => { if (e.key === "Enter") saveInlineEdit(opp.opportunity_id); if (e.key === "Escape") setInlineEditId(null); }}
                            className="w-full text-xs font-medium bg-transparent border-0 border-b border-blue-300 dark:border-blue-600 focus:outline-none focus:border-blue-500 pb-0.5 text-gray-900 dark:text-gray-50"
                            placeholder="Title"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="text-[10px] text-gray-400 mb-0.5">Deadline</p>
                              <input
                                type="date"
                                value={inlineForm.deadline}
                                onChange={e => setInlineForm(f => ({ ...f, deadline: e.target.value }))}
                                className={D_INPUT + " w-full"}
                              />
                            </div>
                            <div>
                              <p className="text-[10px] text-gray-400 mb-0.5">Amount</p>
                              <input
                                type="number" min="0" step="any" inputMode="decimal"
                                value={inlineForm.amount}
                                onChange={e => setInlineForm(f => ({ ...f, amount: e.target.value }))}
                                placeholder="250000"
                                className={D_INPUT + " w-full"}
                              />
                            </div>
                          </div>
                          <input
                            type="text"
                            value={inlineForm.amount_notes}
                            onChange={e => setInlineForm(f => ({ ...f, amount_notes: e.target.value }))}
                            placeholder="Amount notes — range, equity, in-kind…"
                            className={D_INPUT + " w-full text-[11px]"}
                          />
                          <AutoTextarea
                            value={inlineForm.notes}
                            onChange={e => setInlineForm(f => ({ ...f, notes: e.target.value }))}
                            rows={2}
                            placeholder="Add a note…"
                            className={D_INPUT + " w-full resize-none"}
                          />
                          <div className="flex justify-end gap-2 pt-0.5">
                            <button
                              onClick={() => setInlineEditId(null)}
                              className="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            >Cancel</button>
                            <button
                              onClick={() => saveInlineEdit(opp.opportunity_id)}
                              className="px-2.5 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
                            >Save</button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={opp.opportunity_id}
                        draggable
                        onDragStart={() => { dragId.current = opp.opportunity_id; setDraggingId(opp.opportunity_id); }}
                        onDragEnd={() => { dragId.current = null; setDraggingId(null); setDragOverCol(null); }}
                        onClick={() => setDetailOpp(opp)}
                        className={`relative group/card bg-white dark:bg-zinc-900 border rounded-lg p-3 hover:shadow-sm transition-all cursor-grab active:cursor-grabbing ${
                          isBeingDragged ? "opacity-40" : "opacity-100"
                        } ${
                          isSelected
                            ? "border-blue-400 dark:border-blue-500 ring-1 ring-blue-400/40"
                            : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600"
                        }`}
                      >
                        {/* Accent bar — deadline urgency, the CRM's flag treatment */}
                        <div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded ${urgency.cls}`}
                          title={`Urgency: ${urgency.label}`} />

                        {/* Card actions, revealed on hover as in /crm */}
                        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity">
                          <button
                            onClick={e => startInlineEdit(opp, e)}
                            className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-blue-500 rounded"
                            aria-label="Quick edit">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                            </svg>
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); doDelete(opp); }}
                            className="w-5 h-5 flex items-center justify-center text-gray-300 hover:text-red-400 rounded"
                            aria-label="Delete">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>

                        <div className="pl-3">
                          {/* Title */}
                          <div className="flex items-start gap-1.5 min-w-0 pr-10">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onClick={e => e.stopPropagation()}
                              onChange={e => { e.stopPropagation(); onToggleSelect(opp.opportunity_id); }}
                              className={`mt-0.5 shrink-0 w-3 h-3 accent-blue-600 cursor-pointer transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover/card:opacity-100"}`}
                            />
                            <p className="min-w-0 flex-1 text-xs font-medium text-gray-900 dark:text-white break-words line-clamp-2" title={opp.title}>
                              {opp.title}
                            </p>
                            {isLinkUrl(opp.source_link) && (
                              <a href={opp.source_link!} target="_blank" rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="shrink-0 mt-0.5 text-gray-300 hover:text-blue-500 transition-colors"
                                title="Open source link">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            )}
                          </div>

                          {(opp.funding_type || opp.dilution || opp.org_fit !== "Unrated") && (
                            <span className="inline-flex items-center gap-1 mt-1 max-w-full align-top flex-wrap">
                              <FitChip value={opp.org_fit} />
                              <FundingTypeChip value={opp.funding_type} className="break-words" />
                              <DilutionTag value={opp.dilution} />
                            </span>
                          )}

                          {/* Owner sits with the urgency signal — who is on it
                              and how pressing it is are the same question. The
                              amount is a property of the award, not of the work,
                              so it keeps its own side. */}
                          <div className="flex items-start gap-1.5 mt-1.5 flex-wrap">
                            <span className={`inline-block mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${urgency.cls}`} title={`Urgency: ${urgency.label}`} />
                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">{urgency.label}</span>
                            {opp.assignee_name && (
                              <div className="flex items-center gap-1 shrink-0" title={`Owner: ${opp.assignee_name}`}>
                                <AssigneeAvatar name={opp.assignee_name} size={16} />
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[64px]">
                                  {opp.assignee_name.split(" ")[0]}
                                </span>
                              </div>
                            )}
                            <div className="ml-auto flex items-start gap-1.5 min-w-0 max-w-full">
                              {opp.amount !== null && opp.amount !== undefined ? (
                                <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono tabular-nums min-w-0 break-words line-clamp-2 text-right"
                                  title={opp.amount_notes ? `Amount: ${fmtAward(opp.amount, opp.amount_currency)} — ${opp.amount_notes}` : `Amount: ${fmtAward(opp.amount, opp.amount_currency)}`}>
                                  {fmtAward(opp.amount, opp.amount_currency)}
                                </span>
                              ) : opp.amount_notes ? (
                                // Non-cash award: the note is the whole story.
                                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 italic min-w-0 line-clamp-2 text-right"
                                  title={opp.amount_notes}>{opp.amount_notes}</span>
                              ) : null}
                            </div>
                          </div>

                          {opp.tags.length > 0 && (
                            <CardTags tags={opp.tags}
                              className="border-t border-zinc-100 dark:border-zinc-800 pt-2 mt-2" />
                          )}

                          {(deadlineLabel || opp.decision_date || !opp.deadline) && (
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              {deadlineLabel && (
                                <span className={`text-[10px] ${overdue ? "text-red-600 dark:text-red-400 font-medium" : "text-zinc-400 dark:text-zinc-500"}`}
                                  title="Deadline">
                                  ⌛ {deadlineLabel}{overdue && " · late"}
                                </span>
                              )}
                              {opp.decision_date && (
                                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 min-w-0 break-words" title="Decision date">
                                  Dec: {opp.decision_date}
                                </span>
                              )}
                              {!opp.deadline && !["Won", "Rejected", "Withdrawn"].includes(opp.stage) && (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400"
                                  title="An open application with no deadline cannot be chased">
                                  no deadline
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Collapsed pill */}
              {isCollapsed && colItems.length > 0 && (
                <div className={`mt-1 rounded-lg ${st.bg} border ${st.card} flex items-center justify-center py-4`}
                  style={{ minHeight: "60px" }}>
                  <span className={`text-xs font-semibold ${st.header}`}>{colItems.length}</span>
                </div>
              )}
            </div>
          );
        })}
        </div>
        </div>
      </div>

      {detailOpp && (
        <OpportunityDetailPanel
          opp={detailOpp}
          onClose={() => setDetailOpp(null)}
          onSaved={onReload}
          onDelete={async () => { await doDelete(detailOpp); setDetailOpp(null); }}
        />
      )}
    </>
  );
}

// ── Dilutive Kanban ────────────────────────────────────────────────────────────

/** Asked before a deal is allowed to end. Category first, because it decides
 *  everything else: where the record goes, what colour it wears, and whether a
 *  revisit plan is required before it can be saved. */
function ClosedLostReasonModal({
  investor, onCancel, onConfirm,
}: {
  investor: Investor;
  onCancel: () => void;
  onConfirm: (payload: {
    close_reason_code: string;
    closed_lost_reason: string;
    revisit_date?: string;
    revisit_trigger?: string;
  }) => void;
}) {
  const reasons = useCloseReasons();
  const [code, setCode] = useState(investor.close_reason_code ?? "");
  const [reason, setReason] = useState(investor.closed_lost_reason ?? "");
  const [revisitDate, setRevisitDate] = useState(investor.revisit_date ?? "");
  const [revisitTrigger, setRevisitTrigger] = useState(investor.revisit_trigger ?? "");
  const label = investor.firm || investor.name || "this investor";

  const picked = reasons.find(r => r.code === code);
  const needsRevisit = picked?.requires_revisit ?? false;
  const ready = !!picked && reason.trim().length > 0
    && (!needsRevisit || (revisitDate && revisitTrigger.trim()));

  // Grouped in the list, so the difference between "come back to this" and
  // "this is over" is visible while choosing rather than after saving.
  const groups = ["revisit", "lost"].map(g => ({
    key: g,
    label: reasons.find(r => r.reason_group === g)?.group_label ?? g,
    items: reasons.filter(r => r.reason_group === g),
  })).filter(g => g.items.length);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Close this opportunity</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Why did {label} not go ahead?</p>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Category</label>
            <StyledSelect value={code} onChange={e => setCode(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100">
              <option value="">— Choose a category —</option>
              {groups.map(g => (
                <optgroup key={g.key} label={g.label}>
                  {g.items.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
                </optgroup>
              ))}
            </StyledSelect>
            {picked && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                <CloseReasonBadge code={picked.code} />
                <span>→ moves to <span className="font-medium">{picked.stage}</span></span>
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">What happened</label>
            <AutoTextarea rows={3} value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Passed — outside their stage; revisit at Series A."
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
          </div>

          {/* A revisit is a promise to come back. It has to say when, and on
              what — otherwise it is a loss with a friendlier label. */}
          {needsRevisit && (
            <div className="space-y-2 rounded-lg border p-3" style={{ backgroundColor: picked!.fill + "55", borderColor: picked!.fill }}>
              <p className="text-[11px] font-medium" style={{ color: picked!.text_color }}>
                Reach out later — both fields required
              </p>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Revisit date</label>
                <input type="date" value={revisitDate} onChange={e => setRevisitDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Revisit trigger</label>
                <input value={revisitTrigger} onChange={e => setRevisitTrigger(e.target.value)}
                  placeholder="e.g. Once the Series A is signed"
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100" />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100 dark:border-gray-800">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            onClick={() => onConfirm({
              close_reason_code: code,
              closed_lost_reason: reason.trim(),
              ...(needsRevisit ? { revisit_date: revisitDate, revisit_trigger: revisitTrigger.trim() } : {}),
            })}
            disabled={!ready}
            className="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">
            {picked ? `Move to ${picked.stage}` : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where endings went. Split first by whether the deal is coming back, because
 *  that is the only distinction that changes what anyone does next; the reasons
 *  underneath say why. */
function ClosedLostReport() {
  type Row = { code: string; label: string; count: number; due_now: number };
  type Group = { label: string; fill: string; text_color: string; total: number; due_now: number; reasons: Row[] };
  const [data, setData] = useState<{
    groups: Record<string, Group>;
    total: number;
    uncategorised: number;
    excluded_from_reporting: { total: number; reasons: { code: string; label: string; count: number }[] };
  } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || data) return;
    fetch("/api/proxy/dilutive/reports/closed-lost")
      .then(r => r.ok ? r.json() : null).then(setData).catch(() => {});
  }, [open, data]);

  return (
    <div className="mb-3 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Closed &amp; parked — breakdown</span>
        {data && <span className="text-[11px] text-gray-400">{data.total} categorised</span>}
        <span className="ml-auto text-[11px] text-gray-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-100 dark:border-white/10 pt-3">
          {!data ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(["revisit", "lost"] as const).map(key => {
                  const g = data.groups[key];
                  if (!g) return null;
                  return (
                    <div key={key} className="rounded-lg border border-gray-100 dark:border-white/10 p-3">
                      <div className="flex items-baseline gap-2">
                        <span style={{ backgroundColor: g.fill, color: g.text_color }}
                          className="rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none">
                          {g.label}
                        </span>
                        <span className="text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{g.total}</span>
                        {key === "revisit" && g.due_now > 0 && (
                          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                            {g.due_now} due now
                          </span>
                        )}
                      </div>
                      <ul className="mt-2 space-y-1">
                        {g.reasons.length === 0 && <li className="text-[11px] text-gray-400 italic">None yet</li>}
                        {g.reasons.map(r => (
                          <li key={r.code} className="flex items-baseline gap-2 text-[11px]">
                            <span className="text-gray-600 dark:text-gray-300 truncate">{r.label}</span>
                            {r.due_now > 0 && <span className="text-amber-600 dark:text-amber-400">{r.due_now} due</span>}
                            <span className="ml-auto tabular-nums text-gray-500 dark:text-gray-400">{r.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
                {data.uncategorised > 0 && (
                  <span>{data.uncategorised} ended before categories existed</span>
                )}
                {data.excluded_from_reporting.total > 0 && (
                  <span title={data.excluded_from_reporting.reasons.map(r => `${r.label}: ${r.count}`).join(", ")}>
                    {data.excluded_from_reporting.total} excluded from reporting
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DilutiveKanban({
  rows,
  selectedIds,
  onToggleSelect,
  onPatchLocal,
  onReload,
  onAddInCol,
}: {
  rows: Investor[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onPatchLocal: (id: string, fields: Partial<Investor>) => void;
  onReload: () => void;
  onAddInCol: (stage: string) => void;
}) {
  const statuses = useInvestorStatuses();
  const stages = INVESTOR_BOARD_STAGES;
  const dragId = useRef<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(INVESTOR_STAGES.filter(s => s.autoCollapse).map(s => s.id)),
  );
  const [editInv, setEditInv] = useState<Investor | null>(null);
  const [lossPrompt, setLossPrompt] = useState<Investor | null>(null);
  const [sortMode, setSortMode] = useState<Record<string, InvestorSortMode>>({});
  const [taskError, setTaskError] = useState<string | null>(null);

  const firstStage = stages[0]?.id ?? "Prospect";
  const byStage: Record<string, Investor[]> = {};
  for (const s of stages) byStage[s.id] = [];
  for (const inv of rows) {
    // Lead has no column here, so a record still sitting in it lands in the
    // first stage the board shows.
    (byStage[inv.pipeline_stage] ?? byStage[firstStage]).push(inv);
  }

  function toggleCollapse(colId: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }

  // Move the card locally first, then reconcile. On failure the card goes back
  // where it came from rather than sitting in a stage the server rejected.
  async function setStage(id: string, pipeline_stage: string, ending?: Record<string, string>) {
    const before = rows.find(r => r.investor_id === id);
    if (!before) return;
    const body = ending ? { ...ending } : { pipeline_stage };

    onPatchLocal(id, {
      // An ending's stage comes from its category; the server has the mapping,
      // so the optimistic guess uses the same one the dialog showed.
      pipeline_stage: (ending?.pipeline_stage as string) ?? pipeline_stage,
      // The server drops the reason on any move back into the pipeline — match it.
      closed_lost_reason: ending?.closed_lost_reason ?? null,
      close_reason_code: ending?.close_reason_code ?? null,
      stage_entered_at: new Date().toISOString(),
    });

    const r = await fetch(`/api/proxy/dilutive/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      onPatchLocal(id, {
        pipeline_stage: before.pipeline_stage,
        closed_lost_reason: before.closed_lost_reason,
        close_reason_code: before.close_reason_code,
        stage_entered_at: before.stage_entered_at,
      });
    }
    onReload();
  }

  function handleColDrop(stage: string) {
    const id = dragId.current;
    dragId.current = null;
    setDragOverCol(null);
    setDraggingId(null);
    if (!id) return;
    const inv = rows.find(r => r.investor_id === id);
    if (!inv || inv.pipeline_stage === stage) return;
    // Any ending asks why first. The category then decides where it actually
    // lands, which is why Nurture asks too — a card dragged there is a revisit,
    // and a revisit without a date is the thing this prevents.
    if (stage === "Closed Lost" || stage === "Nurture") { setLossPrompt(inv); return; }
    setStage(id, stage);
  }

  async function doDelete(inv: Investor) {
    await fetch(`/api/proxy/dilutive/${inv.investor_id}`, { method: "DELETE" });
    onReload();
  }

  /** Drop a task off the card immediately, then reconcile. */
  function dropTaskLocally(taskId: string) {
    const owner = rows.find(r => (r.open_tasks ?? []).some(t => t.task_id === taskId));
    if (owner) {
      onPatchLocal(owner.investor_id, {
        open_tasks: (owner.open_tasks ?? []).filter(t => t.task_id !== taskId),
      });
    }
  }

  /** A failed write must say so — silently reloading just puts the row back
   *  and looks like the click did nothing. */
  async function taskWrite(taskId: string, init: RequestInit, failure: string) {
    dropTaskLocally(taskId);
    const r = await fetch(`/api/proxy/tasks/${taskId}`, init);
    if (!r.ok) setTaskError(failure);
    onReload();
  }

  const onTaskDone = (taskId: string) => taskWrite(taskId, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "done", kanban_status: "done" }),
  }, "Could not mark that task done.");

  const onTaskDelete = (taskId: string) => taskWrite(taskId, { method: "DELETE" },
    "Could not delete that task.");

  return (
    <>
      {taskError && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2">
          <span className="text-xs text-red-700 dark:text-red-300">{taskError}</span>
          <button onClick={() => setTaskError(null)}
            className="ml-auto text-xs text-red-500 hover:text-red-700">✕</button>
        </div>
      )}

      {/* One horizontally scrolling row of full-height columns. Each column
          scrolls its own cards, so the page itself never scrolls. */}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex gap-2 p-4 h-full min-w-max items-start">
        {stages.map(stage => {
          const mode = sortMode[stage.id] ?? "firm";
          const colItems = sortInvestors(byStage[stage.id] ?? [], mode);
          const isCollapsed = collapsed.has(stage.id);
          const isColOver = dragOverCol === stage.id;
          const st = stage.color;

          return (
            <div key={stage.id} className={`flex flex-col shrink-0 transition-all ${isCollapsed ? "w-10" : "w-60"}`}>
              {/* Column header — the column scrolls under it, so it needs no
                  sticky treatment; this is /crm's header exactly. */}
              <div
                className={`flex items-center gap-1.5 mb-2 px-1 cursor-pointer select-none ${isCollapsed ? "flex-col gap-2" : "justify-between"}`}
                onClick={() => toggleCollapse(stage.id)}
                title={isCollapsed ? `Expand ${stage.id}` : `Collapse ${stage.id}`}
              >
                {isCollapsed ? (
                  <>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${st.header} whitespace-nowrap`}
                      style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                      {stage.id}
                    </span>
                    <span className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">{colItems.length}</span>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                      <span className={`text-xs font-semibold uppercase tracking-wide truncate ${st.header}`}>{stage.id}</span>
                      <StageInfoIcon stage={stage} />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-400 dark:text-gray-600 tabular-nums">{colItems.length}</span>
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setSortMode(prev => ({ ...prev, [stage.id]: mode === "status" ? "firm" : "status" }));
                        }}
                        className={`transition-colors ml-0.5 p-0.5 ${mode === "status" ? st.header : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}
                        title={mode === "status" ? "Sorted by status — click to sort by firm name" : "Sort by status"}>
                        <InvestorSortIcon />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); onAddInCol(stage.id); }}
                        className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors ml-0.5 p-0.5"
                        title={`Add to ${stage.id}`}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                      <BoardChevronIcon collapsed={false} />
                    </div>
                  </>
                )}
              </div>

              {/* Cards — drop zone */}
              {!isCollapsed && (
                <div
                  className={`flex flex-col gap-2 flex-1 overflow-y-auto pr-0.5 rounded-lg transition-colors ${
                    draggingId && isColOver ? `${st.bg} ring-1 ring-inset ${st.card}` : ""
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOverCol(stage.id); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol(null); }}
                  onDrop={e => { e.preventDefault(); handleColDrop(stage.id); }}
                >
                  {colItems.length === 0 ? (
                    <div className={`border border-dashed rounded-lg p-4 text-center transition-colors ${
                      draggingId && isColOver ? `${st.card} border-solid` : "border-gray-200 dark:border-white/8"
                    }`}>
                      <p className="text-xs text-gray-400 dark:text-gray-600">No investors here.</p>
                    </div>
                  ) : colItems.map(inv => {
                    const isBeingDragged = draggingId === inv.investor_id;
                    const isSelected = selectedIds.has(inv.investor_id);

                    return (
                      <div key={inv.investor_id}
                        draggable
                        onDragStart={() => { dragId.current = inv.investor_id; setDraggingId(inv.investor_id); }}
                        onDragEnd={() => { dragId.current = null; setDraggingId(null); setDragOverCol(null); }}
                        onClick={() => setEditInv(inv)}
                        // Border stays neutral — the only colour on a card is
                        // its status accent bar.
                        className={`relative bg-white dark:bg-gray-900 rounded-lg border cursor-pointer group transition-all duration-150 ${
                          isBeingDragged
                            ? "opacity-40"
                            : isSelected
                            ? "border-blue-400 dark:border-blue-500 shadow-sm shadow-blue-500/10"
                            : "border-zinc-200 dark:border-zinc-700 hover:shadow-md hover:shadow-gray-200/60 dark:hover:shadow-black/20 hover:-translate-y-0.5 hover:border-zinc-300 dark:hover:border-zinc-600"
                        }`}
                      >
                        {/* Accent bar reflects who owes the next move. */}
                        <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg ${statusDotClass(statuses, inv.status)}`} />
                        <div className="px-3 pt-2.5 pb-3 pl-4">
                          {/* Firm — the deal itself, so it leads the card. */}
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex items-start gap-1.5 flex-1 min-w-0">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onClick={e => e.stopPropagation()}
                                onChange={e => { e.stopPropagation(); onToggleSelect(inv.investor_id); }}
                                className="mt-0.5 flex-shrink-0 accent-blue-600 cursor-pointer"
                              />
                              <p className="min-w-0 text-sm font-semibold text-gray-900 dark:text-gray-50 leading-snug truncate"
                                title={inv.firm ?? inv.name ?? undefined}>
                                {inv.firm ?? inv.name ?? <span className="text-gray-400 font-normal italic">Unnamed</span>}
                              </p>
                              {inv.investor_type && (
                                <span className="flex-shrink-0 mt-0.5 text-[11px] text-gray-400 dark:text-gray-500"
                                  title="Investor type">
                                  {inv.investor_type}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); doDelete(inv); }}
                              className="opacity-0 group-hover:opacity-100 w-5 h-5 flex-shrink-0 flex items-center justify-center text-gray-300 hover:text-red-400 rounded transition-all"
                              aria-label="Delete">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>

                          {/* Our owner + their contact. An unassigned record
                              shows no avatar at all — a "?" square says nothing. */}
                          <p className="text-xs text-gray-600 dark:text-gray-300 mb-1.5 flex items-center gap-1.5 min-w-0">
                            {inv.assigned_to_name && <AssigneeAvatar name={inv.assigned_to_name} size={20} />}
                            {/* With no firm the title IS the person — an angel
                                is their own contact, so saying "no contact yet"
                                under their own name is nonsense. */}
                            <span className="truncate">
                              {inv.firm && inv.name && (
                                <>
                                  {inv.name}
                                  {inv.role && <span className="text-gray-400"> · {inv.role}</span>}
                                </>
                              )}
                              {!inv.firm && (inv.role ?? (inv.investor_type ? "" : null))}
                              {inv.firm && !inv.name && (
                                <span className="text-gray-300 dark:text-gray-600">No contact yet</span>
                              )}
                            </span>
                          </p>

                          {/* Status, the stage they invest at, and their cheque */}
                          <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                            <InvestorStatusTag status={inv.status} statuses={statuses} />
                            {inv.investment_stage && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 font-medium"
                                title="Stage they invest at">
                                {inv.investment_stage}
                              </span>
                            )}
                            {inv.avg_check_size && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900 font-semibold"
                                title="Average check size">
                                {inv.avg_check_size}
                              </span>
                            )}
                          </div>

                          {/* Last contact + anything queued to go out */}
                          <div className="mt-1.5 flex items-center gap-2">
                            <LastContact at={inv.last_comm_at} direction={inv.last_comm_direction}
                              channel={inv.outreach_channel} />
                            {inv.scheduled_count > 0 && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400"
                                title="Follow-up queued — cancels itself if they reply">
                                ⏱ {inv.scheduled_count} queued
                              </span>
                            )}
                          </div>

                          {/* Open tasks, with the two actions worth having on a card */}
                          {(inv.open_tasks ?? []).length > 0 && (
                            <div className="mt-1.5 space-y-0.5">
                              {(inv.open_tasks ?? []).slice(0, 3).map(t => {
                                const overdue = t.due_date
                                  && new Date(t.due_date) < new Date(new Date().toDateString());
                                return (
                                  <div key={t.task_id} className="flex items-center gap-1.5 group/task">
                                    <input type="checkbox" checked={false}
                                      onClick={e => e.stopPropagation()}
                                      onChange={e => { e.stopPropagation(); onTaskDone(t.task_id); }}
                                      title="Mark done"
                                      className="accent-blue-600 cursor-pointer shrink-0 w-3 h-3" />
                                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate">{t.title}</span>
                                    {t.due_date && (
                                      <span className={`text-[10px] shrink-0 ${overdue ? "text-red-600 dark:text-red-400 font-medium" : "text-zinc-400"}`}>
                                        {overdue ? "overdue" : new Date(t.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                                      </span>
                                    )}
                                    <button
                                      onClick={e => { e.stopPropagation(); onTaskDelete(t.task_id); }}
                                      title="Delete task"
                                      className="ml-auto shrink-0 opacity-0 group-hover/task:opacity-100 text-zinc-300 hover:text-red-500 transition-opacity">
                                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                      </svg>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Nothing planned on a live record is the thing worth
                              seeing — the board flags it rather than inventing a task. */}
                          {(inv.open_tasks ?? []).length === 0 && inv.scheduled_count === 0
                            && !["Closed Won", "Closed Lost"].includes(inv.pipeline_stage) && (
                            <p className="mt-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                              title="No open task and no scheduled follow-up on this investor">
                              No follow-up planned
                            </p>
                          )}

                          {/* Why we lost it — only ever set on Closed Lost. */}
                          {inv.close_reason_code && (
                            <div className="mt-1"><CloseReasonBadge code={inv.close_reason_code} /></div>
                          )}
                          {inv.closed_lost_reason && (
                            <p className="mt-2 rounded-md border border-red-100 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 px-2 py-1 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
                              <span className="font-semibold">Lost: </span>{inv.closed_lost_reason}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Collapsed pill */}
              {isCollapsed && colItems.length > 0 && (
                <div className={`mt-1 rounded-lg ${st.bg} border ${st.card} flex items-center justify-center py-4`}
                  style={{ minHeight: "60px" }}>
                  <span className={`text-xs font-semibold ${st.header}`}>{colItems.length}</span>
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>

      {lossPrompt && (
        <ClosedLostReasonModal
          investor={lossPrompt}
          onCancel={() => setLossPrompt(null)}
          onConfirm={payload => {
            const inv = lossPrompt;
            setLossPrompt(null);
            setStage(inv.investor_id, "Closed Lost", payload as unknown as Record<string, string>);
          }}
        />
      )}

      {editInv && (
        <InvestorDetailPanel
          inv={editInv}
          onClose={() => setEditInv(null)}
          onSaved={() => { onReload(); }}
          onDelete={async () => { await doDelete(editInv); setEditInv(null); }}
        />
      )}
    </>
  );
}

// ── Non-Dilutive Tab ───────────────────────────────────────────────────────────

function NonDilutiveTab({ forceAdd, onAddConsumed }: { forceAdd: boolean; onAddConsumed: () => void }) {
  const [rows, setRows] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const fundingTypes = useFundingTypes();
  // Leading blank so an inline edit can clear the type back to unset — the
  // select is the only way to reach that cell now that it is not free text.
  const fundingTypeNames = useMemo(
    () => ["", ...fundingTypes.map((t) => t.name)], [fundingTypes]);
  const [showSettings, setShowSettings] = useState(false);
  // List view had no way into a record; the notes log lives there, so it needs one.
  const [detailOpp, setDetailOpp] = useState<Opportunity | null>(null);

  // The panel now survives a refetch, so re-point it at the refreshed row
  // instead of leaving it on the snapshot it opened with. Falls back to the
  // snapshot when the row is not in the current set — a search that filters it
  // out should not slam an open panel shut mid-edit.
  useEffect(() => {
    setDetailOpp(prev => prev
      ? (rows.find(r => r.opportunity_id === prev.opportunity_id) ?? prev)
      : null);
  }, [rows]);
  const [showAdd, setShowAdd] = useState(false);
  const [addingForStage, setAddingForStage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Opportunity | null>(null);
  const [editing, setEditing] = useState<EditingCell>(null);
  const [viewMode, setViewMode] = useState<FundingViewMode>("kanban");

  /* The board sorts by deadline within each column; the flat list had no
     ordering at all, so a deadline you could read was still a deadline you
     could not queue by. Deadline ascending is the default because the next
     thing due is the reason to open this view. */
  const [listSort, setListSort] = useState<OppSort>({ key: "deadline", dir: "asc" });

  const listRows = useMemo(() => {
    const sign = listSort.dir === "asc" ? 1 : -1;
    const cell = (o: Opportunity): string | number | null => {
      switch (listSort.key) {
        // Board order, not alphabetical — "Applied" belongs after "In Progress",
        // and only the stage ladder knows that.
        case "stage": return STAGES.indexOf(o.stage);
        case "amount": return o.amount;
        case "title": return (o.title ?? "").toLowerCase();
        case "funding_type": return (o.funding_type ?? "").toLowerCase();
        case "deadline": return o.deadline;
        case "decision_date": return o.decision_date;
      }
    };
    const empty = (v: string | number | null) => v === null || v === undefined || v === "";
    return [...rows].sort((a, b) => {
      const x = cell(a), y = cell(b);
      // Blank cells sink in both directions. Reversing a sort should not
      // promote the rows that have nothing in the column you asked about.
      if (empty(x)) return empty(y) ? 0 : 1;
      if (empty(y)) return -1;
      return x! < y! ? -sign : x! > y! ? sign : 0;
    });
  }, [rows, listSort]);

  function sortByColumn(key: OppSortKey) {
    setListSort(s => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "asc" });
  }


  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState<
    | { phase: "idle" }
    | { phase: "uploading" }
    | { phase: "done"; inserted: number; updated: number; skipped_duplicate: number; total_in_db: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (filterStage && viewMode === "list") params.set("stage", filterStage);
    const res = await fetch(`/api/proxy/funding?${params}`);
    const data = await res.json();
    setRows(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [search, filterStage, viewMode]);

  useEffect(() => { load(); }, [load]);
  // The vocabulary backs every type dropdown and chip on this tab; fetched once
  // here rather than per-component, the way the dilutive tab primes its own.
  useEffect(() => { refreshFundingTypes(); }, []);
  useEffect(() => { if (forceAdd) { setShowAdd(true); onAddConsumed(); } }, [forceAdd, onAddConsumed]);

  /** Downloads what the toolbar is currently showing, not the whole table. */
  async function exportCsv() {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (filterStage) params.set("stage", filterStage);
    const res = await fetch(`/api/proxy/funding/export?${params}`);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = match ? match[1] : "applications.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportState({ phase: "uploading" });
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/proxy/funding/import", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        setImportState({ phase: "error", message: err.detail ?? "Upload failed" });
        return;
      }
      setImportState({ phase: "done", ...(await res.json()) });
      load();
    } catch (err: unknown) {
      setImportState({ phase: "error", message: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.opportunity_id)));
  }

  async function bulkDelete() {
    await Promise.all([...selectedIds].map(id => fetch(`/api/proxy/funding/${id}`, { method: "DELETE" })));
    setSelectedIds(new Set());
    load();
  }

  async function bulkSetStage(stage: string) {
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/proxy/funding/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      })
    ));
    setSelectedIds(new Set());
    load();
  }

  function startEdit(id: string, field: string, value: string) {
    setEditing({ id, field, value });
  }

  async function commitEdit(id: string, field: string, raw: string) {
    setEditing(null);
    const value = raw.trim();
    // Optimistic update
    setRows((prev) =>
      prev.map((r) => r.opportunity_id === id ? { ...r, [field]: value || null } : r)
    );
    await fetch(`/api/proxy/funding/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value || null }),
    });
  }

  async function doDelete(opp: Opportunity) {
    await fetch(`/api/proxy/funding/${opp.opportunity_id}`, { method: "DELETE" });
    setDeleting(null);
    load();
  }

  const counts = STAGES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = rows.filter((r) => r.stage === s).length;
    return acc;
  }, {});

  const Editable = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editing} onStartEdit={startEdit} onCommit={commitEdit} onCancel={() => setEditing(null)} />
  );

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Chrome — pinned above the board, the way /crm pins its header. */}
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3 border-b border-gray-200 dark:border-white/8">
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl text-sm">
          <span className="font-medium text-blue-700 dark:text-blue-300">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-blue-600 dark:text-blue-400">Move to:</span>
            {STAGES.map(s => (
              <button key={s} onClick={() => bulkSetStage(s)}
                className={`text-xs px-2 py-1 rounded border font-medium ${STAGE_STYLES[s]}`}>
                {s}
              </button>
            ))}
            <button onClick={bulkDelete}
              className="text-xs px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium">
              Delete
            </button>
            <button onClick={() => setSelectedIds(new Set())}
              className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Settings sits first, before the stage filters — it configures the
            board rather than filtering it. */}
        <button onClick={() => setShowSettings(true)}
          title="Applications settings — knowledge base, opportunity discovery, funding types"
          className="shrink-0 p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        {(viewMode === "list") && STAGES.map((s) => counts[s] > 0 && (
          <button key={s}
            onClick={() => setFilterStage(filterStage === s ? "" : s)}
            className={`text-xs px-2.5 py-1 rounded border font-medium transition-all ${
              filterStage === s ? STAGE_STYLES[s] + " ring-2 ring-offset-1 ring-current" : STAGE_STYLES[s]
            }`}>
            {s} · {counts[s]}
          </button>
        ))}
        <div className="relative ml-auto">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search applications…"
            className="w-48 pl-9 pr-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </div>
        {filterStage && viewMode === "list" && (
          <button onClick={() => setFilterStage("")}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Clear filter
          </button>
        )}
        <ViewToggle mode={viewMode} onChange={(m) => { setViewMode(m); setSelectedIds(new Set()); }} />

        {/* Import CSV */}
        <input
          ref={importInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={handleImportFile}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importState.phase === "uploading"}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {importState.phase === "uploading" ? (
            <>
              <span className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M8 12l4-4m0 0l4 4m-4-4v8" />
              </svg>
              Import CSV
            </>
          )}
        </button>
        {/* Export CSV */}
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-4-4m4 4l4-4" />
          </svg>
          Export CSV
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Opportunity
        </button>
      </div>

      {/* Import result banner */}
      {importState.phase === "done" && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-xl text-sm">
          <svg className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-green-800 dark:text-green-300">
            {importState.inserted} added, {importState.updated} updated
            {importState.skipped_duplicate > 0 && `, ${importState.skipped_duplicate} duplicate row${importState.skipped_duplicate === 1 ? "" : "s"} skipped`}
            {" "}· {importState.total_in_db} total
          </span>
          <button onClick={() => setImportState({ phase: "idle" })}
            className="ml-auto text-green-600 hover:text-green-800 dark:hover:text-green-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {importState.phase === "error" && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-sm">
          <span className="text-red-700 dark:text-red-300">{importState.message}</span>
          <button onClick={() => setImportState({ phase: "idle" })}
            className="ml-auto text-red-600 hover:text-red-800 dark:hover:text-red-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      </div>

      {/* Kanban view — owns the rest of the viewport.
          Stays mounted through a refetch. It was previously gated on !loading,
          which unmounted it on every reload — and the open detail panel is its
          state, so saving a field or syncing mail threw you back to the board
          mid-edit. The spinner is only for the first load, when there is
          genuinely nothing to show. */}
      {viewMode === "kanban" && (
        loading && rows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <NonDilutiveKanban
            rows={rows}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onReload={load}
            onAddInCol={(stage) => setAddingForStage(stage)}
          />
        )
      )}

      {/* Gantt view */}
      {viewMode === "gantt" && !(loading && rows.length === 0) && (
        <div className="flex-1 overflow-auto p-4">
        <FundingGanttView
          rows={rows}
          onPatch={async (id, patch) => {
            setRows(prev => prev.map(r => r.opportunity_id === id ? { ...r, ...patch } : r));
            await fetch(`/api/proxy/funding/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            });
          }}
        />
        </div>
      )}

      {/* List view */}
      {viewMode === "list" && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-40">
            <p className="text-sm text-gray-400 dark:text-gray-500">No opportunities found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b-2 border-gray-200 dark:border-gray-700">
                  <th className="px-4 py-3 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="accent-blue-600 cursor-pointer" />
                  </th>
                  <SortableTh label="Stage" sortKey="stage" sort={listSort} onSort={sortByColumn} />
                  <SortableTh label="Title" sortKey="title" sort={listSort} onSort={sortByColumn} />
                  <SortableTh label="Deadline" sortKey="deadline" sort={listSort} onSort={sortByColumn} />
                  <th className="text-left px-4 py-3 font-medium">Tags</th>
                  <SortableTh label="Type" sortKey="funding_type" sort={listSort} onSort={sortByColumn} />
                  <SortableTh label="Amount" sortKey="amount" sort={listSort} onSort={sortByColumn} />
                  <SortableTh label="Decision" sortKey="decision_date" sort={listSort} onSort={sortByColumn} />
                  <th className="text-left px-4 py-3 font-medium">Notes</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {listRows.map((opp) => (
                  <tr key={opp.opportunity_id}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors group ${selectedIds.has(opp.opportunity_id) ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}>
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={selectedIds.has(opp.opportunity_id)}
                        onChange={() => toggleSelect(opp.opportunity_id)} className="accent-blue-600 cursor-pointer" />
                    </td>
                    <Editable rowId={opp.opportunity_id} field="stage" value={opp.stage}
                      editType="select" selectOptions={STAGES}
                      display={
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${STAGE_STYLES[opp.stage] ?? "bg-gray-100 text-gray-600"}`}>
                          {opp.stage}
                        </span>
                      } />
                    <Editable rowId={opp.opportunity_id} field="title" value={opp.title}
                      className="max-w-xs"
                      display={
                        isLinkUrl(opp.source_link)
                          ? <a href={opp.source_link!} target="_blank" rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="font-medium text-gray-900 dark:text-gray-100 hover:text-blue-600 truncate block">
                              {opp.title}
                              <svg className="inline w-3 h-3 ml-1 opacity-50" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          : <span className="font-medium text-gray-900 dark:text-gray-100 truncate block">{opp.title}</span>
                      } />
                    <Editable rowId={opp.opportunity_id} field="deadline" value={opp.deadline ?? ""}
                      placeholder="YYYY-MM-DD"
                      display={
                        opp.deadline
                          ? <span className={`text-xs ${isOverdue(opp.deadline) && (opp.stage === "New" || opp.stage === "In Progress") ? "text-red-500 font-medium" : "text-gray-600 dark:text-gray-400"}`}>
                              {fmtDate(opp.deadline)}
                            </span>
                          : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      } />
                    <Editable rowId={opp.opportunity_id} field="tags" value={opp.tags.join(", ")}
                      placeholder="Grant, Accelerator…"
                      display={opp.tags.length > 0 ? <TagList tags={opp.tags} /> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <Editable rowId={opp.opportunity_id} field="funding_type" value={opp.funding_type ?? ""}
                      editType="select" selectOptions={fundingTypeNames}
                      display={
                        opp.funding_type
                          ? <span className="inline-flex items-center gap-1.5">
                              <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${optionChipClass(fundingTypes, opp.funding_type)}`}>
                                {opp.funding_type}
                              </span>
                              <DilutionTag value={opp.dilution} />
                            </span>
                          : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      } />
                    <Editable rowId={opp.opportunity_id} field="amount"
                      value={opp.amount === null || opp.amount === undefined ? "" : String(opp.amount)}
                      placeholder="100000"
                      display={
                        opp.amount !== null && opp.amount !== undefined
                          ? <span className="text-xs font-medium text-gray-700 dark:text-gray-300 tabular-nums"
                              title={opp.amount_notes ?? undefined}>
                              {fmtAward(opp.amount, opp.amount_currency)}
                              {opp.amount_notes && <span className="ml-1 text-gray-400">*</span>}
                            </span>
                          : opp.amount_notes
                            // No figure, but the award is real — an in-kind or
                            // unpublished prize. The note is all there is to show.
                            ? <span className="text-xs text-gray-500 dark:text-gray-400 italic truncate block max-w-[14rem]"
                                title={opp.amount_notes}>{opp.amount_notes}</span>
                            : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      } />
                    <Editable rowId={opp.opportunity_id} field="decision_date" value={opp.decision_date ?? ""}
                      placeholder="Mid-July"
                      display={
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {opp.decision_date && opp.decision_date.toLowerCase() !== "unknown"
                            ? opp.decision_date
                            : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          {opp.funding_dispersion && <span className="block text-[10px] text-gray-400">Disp: {opp.funding_dispersion}</span>}
                        </span>
                      } />
                    {/* Read-only preview: the log is edited on the record, where
                        each entry keeps its own date and author. */}
                    <td className="px-4 py-2 max-w-[200px]"
                      onClick={() => setDetailOpp(opp)}>
                      {opp.latest_note ? (
                        <span className="cursor-pointer" title={opp.latest_note}>
                          <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{opp.latest_note}</span>
                          {opp.notes_count > 1 && (
                            <span className="text-[10px] text-gray-400">+{opp.notes_count - 1} more</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setDeleting(opp)} className="p-1 text-gray-400 hover:text-red-500 rounded" title="Delete">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      )}

      {(showAdd || addingForStage !== null) && (
        <AddOpportunityModal
          initialStage={addingForStage ?? "Applied"}
          onClose={() => { setShowAdd(false); setAddingForStage(null); }}
          onSaved={load}
        />
      )}
      {deleting && <DeleteConfirm title={deleting.title} onConfirm={() => doDelete(deleting)} onCancel={() => setDeleting(null)} />}
      {showSettings && <ApplicationsSettingsModal onClose={() => { setShowSettings(false); load(); }} />}
      {detailOpp && (
        <OpportunityDetailPanel
          opp={detailOpp}
          onClose={() => setDetailOpp(null)}
          onSaved={load}
          onDelete={async () => { await doDelete(detailOpp); setDetailOpp(null); }}
        />
      )}
    </div>
  );
}

// ── Multi-select tag cell (Focus, Stage) — checklist + search + create-new ────

function MultiOptionTagCell({
  investorId, value, onSave, options, createEndpoint, refreshOptions,
}: {
  investorId: string;
  value: string | null;
  onSave: (id: string, val: string) => Promise<void>;
  options: NamedColorOption[];
  createEndpoint?: string;
  refreshOptions?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setInput(""); } }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = (value ?? "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const selectedLower = selected.map(s => s.toLowerCase());
  const names = options.map(o => o.name);
  const filtered = names.filter(o => o.toLowerCase().includes(input.toLowerCase()));
  const canCreate = !!(createEndpoint && input.trim() && !names.some(o => o.toLowerCase() === input.toLowerCase().trim()));

  async function toggle(name: string) {
    const isOn = selectedLower.includes(name.toLowerCase());
    const next = isOn ? selected.filter(s => s.toLowerCase() !== name.toLowerCase()) : [...selected, name];
    await onSave(investorId, next.join(", "));
  }

  async function create(name: string) {
    if (!createEndpoint) return;
    await fetch(`/api/proxy/dilutive/${createEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refreshOptions?.();
    setInput("");
    await toggle(name);
  }

  return (
    <td className="px-2 py-1 overflow-hidden" onClick={() => setOpen(true)}>
      <div ref={ref} className="relative">
        {selected.length
          ? <div className="flex flex-wrap gap-1 max-w-full overflow-hidden">
              {selected.map(s => (
                <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${optionChipClass(options, s)}`}>{s}</span>
              ))}
            </div>
          : <span className="text-gray-300 dark:text-gray-600 text-xs cursor-pointer">—</span>
        }
        {open && (
          <div className="absolute left-0 top-full mt-1 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
            <input autoFocus value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setInput(""); } if (e.key === "Enter" && (canCreate || filtered.length === 1)) (canCreate ? create(input.trim()) : toggle(filtered[0])); }}
              className="w-full px-2.5 py-1.5 text-xs border-b border-gray-100 dark:border-gray-800 bg-transparent text-gray-900 dark:text-gray-100 outline-none"
              placeholder="Search or create…" />
            <div className="max-h-52 overflow-y-auto py-1">
              {filtered.map(o => {
                const isOn = selectedLower.includes(o.toLowerCase());
                return (
                  <button key={o} onClick={() => toggle(o)}
                    className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2">
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${isOn ? "bg-blue-600 border-blue-600" : "border-gray-300 dark:border-gray-600"}`}>
                      {isOn && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium truncate ${optionChipClass(options, o)}`}>{o}</span>
                  </button>
                );
              })}
              {canCreate && (
                <button onClick={() => create(input.trim())}
                  className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2 text-blue-600 dark:text-blue-400">
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">{input.trim()}</span>
                  <span className="text-gray-400 text-[10px]">create</span>
                </button>
              )}
              {filtered.length === 0 && !canCreate && (
                <p className="px-2.5 py-2 text-xs text-gray-400">No matches</p>
              )}
            </div>
          </div>
        )}
      </div>
    </td>
  );
}

// ── Enrichment helper ─────────────────────────────────────────────────────────

function enrichedCls(_inv: Investor, _field: string) {
  return "";
}

// ── Investor Table (draggable columns, tight padding) ─────────────────────────

const INV_COLS = [
  { key: "firm",          label: "Firm",       defaultW: 180 },
  { key: "status",        label: "Status",     defaultW: 130 },
  { key: "tier",          label: "Fit",        defaultW: 48  },
  { key: "focus",         label: "Focus",      defaultW: 130 },
  { key: "investment_stage", label: "Stage",   defaultW: 180 },
  { key: "investor_type", label: "Type",       defaultW: 210 },
  { key: "name",          label: "Contact",    defaultW: 140 },
  { key: "role",          label: "Role",       defaultW: 120 },
  { key: "intro_type",    label: "Intro",      defaultW: 70  },
  { key: "outreach_date", label: "Outreached", defaultW: 90  },
  { key: "notes",         label: "Notes",      defaultW: 180 },
  { key: "email",         label: "Email",      defaultW: 180 },
  { key: "check_size_min", label: "Min",       defaultW: 110 },
  { key: "check_size_max", label: "Max",       defaultW: 110 },
] as const;

type InvColKey = typeof INV_COLS[number]["key"];

function InvestorTable({
  rows, selectedIds, allSelected,
  onToggleSelectAll, onToggleSelect,
  editing, onStartEdit, onCommitEdit, onCancelEdit,
  onDelete, onOpenDetail,
}: {
  rows: Investor[];
  selectedIds: Set<string>;
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleSelect: (id: string) => void;
  editing: EditingCell;
  onStartEdit: (id: string, field: string, value: string) => void;
  onCommitEdit: (id: string, field: string, value: string) => Promise<void>;
  onCancelEdit: () => void;
  onDelete: (inv: Investor) => void;
  onOpenDetail: (inv: Investor) => void;
}) {
  const statuses = useInvestorStatuses();
  const statusNames = statuses.map((s) => s.name);
  const investorTypes = useInvestorTypes();
  const focusOptions = useFocusOptions();
  const stageOptions = useStageOptions();
  const defaultColWidths = useMemo(
    () => Object.fromEntries(INV_COLS.map(c => [c.key, c.defaultW])) as Record<InvColKey, number>,
    []
  );
  const [colWidths, setColWidths] = useState<Record<InvColKey, number>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("dil_inv_col_widths") ?? "null");
      if (stored) return { ...defaultColWidths, ...stored };
    } catch { /* fall through to defaults */ }
    return defaultColWidths;
  });
  useEffect(() => {
    try { localStorage.setItem("dil_inv_col_widths", JSON.stringify(colWidths)); } catch {}
  }, [colWidths]);

  const defaultColOrder = useMemo(() => INV_COLS.map(c => c.key), []);
  const [colOrder, setColOrder] = useState<InvColKey[]>(() => {
    try {
      const stored: string[] = JSON.parse(localStorage.getItem("dil_inv_col_order") ?? "null");
      if (Array.isArray(stored) && stored.length) {
        const knownKeys = new Set(defaultColOrder);
        const valid = stored.filter((k): k is InvColKey => knownKeys.has(k as InvColKey));
        const missing = defaultColOrder.filter(k => !valid.includes(k));
        if (valid.length) return [...valid, ...missing];
      }
    } catch { /* fall through to defaults */ }
    return defaultColOrder;
  });
  useEffect(() => {
    try { localStorage.setItem("dil_inv_col_order", JSON.stringify(colOrder)); } catch {}
  }, [colOrder]);
  const [sortCol, setSortCol] = useState<InvColKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const resizeRef = useRef<{ col: InvColKey; startX: number; startW: number } | null>(null);
  const reorderRef = useRef<{ fromIdx: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function startResize(col: InvColKey, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col, startX: e.clientX, startW: colWidths[col] };
    function onMove(ev: MouseEvent) {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      setColWidths(prev => ({ ...prev, [resizeRef.current!.col]: Math.max(40, resizeRef.current!.startW + delta) }));
    }
    function onUp() {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onDragStart(idx: number, e: React.DragEvent) {
    reorderRef.current = { fromIdx: idx };
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(idx: number, e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(idx);
  }
  function onDrop(toIdx: number) {
    if (!reorderRef.current || reorderRef.current.fromIdx === toIdx) { setDragOver(null); return; }
    const from = reorderRef.current.fromIdx;
    setColOrder(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    reorderRef.current = null;
    setDragOver(null);
  }
  function onDragEnd() { reorderRef.current = null; setDragOver(null); }

  const orderedCols = colOrder.map(k => INV_COLS.find(c => c.key === k)!);
  const totalW = orderedCols.reduce((s, c) => s + colWidths[c.key], 0) + 72;

  function toggleSort(col: InvColKey) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortCol] ?? "";
      const bv = (b as unknown as Record<string, unknown>)[sortCol] ?? "";
      const aStr = String(av).toLowerCase();
      const bStr = String(bv).toLowerCase();
      if (aStr < bStr) return sortDir === "asc" ? -1 : 1;
      if (aStr > bStr) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [rows, sortCol, sortDir]);

  const Editable = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editing} onStartEdit={onStartEdit} onCommit={onCommitEdit} onCancel={onCancelEdit} />
  );

  return (
    <div className="overflow-x-auto">
      <table className="text-sm border-collapse" style={{ tableLayout: "fixed", width: totalW }}>
        <colgroup>
          <col style={{ width: 32 }} />
          {orderedCols.map(c => <col key={c.key} style={{ width: colWidths[c.key] }} />)}
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b-2 border-gray-200 dark:border-gray-700">
            <th className="px-1.5 py-2 w-8 border-b border-gray-200 dark:border-gray-700">
              <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} className="accent-blue-600 cursor-pointer" />
            </th>
            {orderedCols.map((c, idx) => (
              <th key={c.key}
                draggable
                onDragStart={(e) => onDragStart(idx, e)}
                onDragOver={(e) => onDragOver(idx, e)}
                onDrop={() => onDrop(idx)}
                onDragEnd={onDragEnd}
                className={`relative text-left px-2 py-2 font-medium border-b border-gray-200 dark:border-gray-700 select-none overflow-hidden transition-colors ${dragOver === idx ? "bg-blue-100 dark:bg-blue-900/30" : ""}`}>
                <button
                  type="button"
                  onClick={() => toggleSort(c.key)}
                  style={c.key === "firm" ? { paddingLeft: FIRM_LABEL_INSET } : undefined}
                  className="flex items-center gap-1 w-full text-left cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 group"
                >
                  <span className="truncate">{c.label}</span>
                  <span className="flex-shrink-0 text-gray-300 dark:text-gray-600 group-hover:text-gray-400 dark:group-hover:text-gray-500 transition-colors">
                    {sortCol === c.key
                      ? (sortDir === "asc" ? "↑" : "↓")
                      : "↕"}
                  </span>
                </button>
                {/* resize handle — right edge */}
                <div
                  onMouseDown={(e) => startResize(c.key, e)}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-blue-400/50 transition-colors z-10"
                />
              </th>
            ))}
            <th className="border-b border-gray-200 dark:border-gray-700" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {sortedRows.map((inv) => (
            <tr key={inv.investor_id}
              className={`hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors group border-b border-gray-200 dark:border-gray-700 ${selectedIds.has(inv.investor_id) ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}>
              <td className="px-1.5 py-1">
                <input type="checkbox" checked={selectedIds.has(inv.investor_id)}
                  onChange={() => onToggleSelect(inv.investor_id)} className="accent-blue-600 cursor-pointer" />
              </td>
              {orderedCols.map(c => {
                const dash = <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>;
                switch (c.key) {
                  case "status": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="status" value={inv.status ?? ""}
                      editType="select" selectOptions={["", ...statusNames]}
                      display={<InvestorStatusTag status={inv.status} statuses={statuses} />} />
                  );
                  case "tier": {
                    const tierStyle = !inv.tier ? null
                      : inv.tier.startsWith("Tier 1") ? { cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800",  label: "T1" }
                      : inv.tier.startsWith("Tier 2") ? { cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-200 dark:border-blue-800",    label: "T2" }
                      : inv.tier.startsWith("Tier 3") ? { cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800", label: "T3" }
                      : inv.tier.startsWith("Tier 4") ? { cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-800", label: "T4" }
                      : { cls: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800", label: "T5" };
                    const scoreTitle = inv.total_score != null
                      ? `${inv.tier}\nScore: ${inv.total_score}/20\nFocus: ${inv.score_focus ?? "—"}  Stage: ${inv.score_stage ?? "—"}  Check: ${inv.score_check ?? "—"}  Geo: ${inv.score_geo ?? "—"}  Portfolio: ${inv.score_portfolio ?? "—"}${inv.enrichment_notes ? "\n" + inv.enrichment_notes : ""}`
                      : "Not scored yet";
                    return (
                      <td key={c.key} className="px-1 py-1 text-center">
                        {tierStyle ? (
                          <span title={scoreTitle} className={`cursor-default text-[10px] font-semibold px-1.5 py-0.5 rounded border ${tierStyle.cls}`}>{tierStyle.label}</span>
                        ) : (
                          <span className="text-gray-200 dark:text-gray-700 text-xs">—</span>
                        )}
                      </td>
                    );
                  }
                  case "firm": return (
                    <td key={c.key} className="px-4 py-2 overflow-hidden">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <AssigneeAvatar name={inv.assigned_to_name} size={20} />
                        {inv.is_priority && (
                          <span className="flex-shrink-0 text-amber-400 text-sm leading-none" title="Priority">★</span>
                        )}
                        {inv.firm ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onOpenDetail(inv); }}
                            className="font-medium text-sm text-left text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 truncate transition-colors"
                            title="Open details"
                          >
                            {inv.firm}
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); onOpenDetail(inv); }}
                            className="text-gray-300 dark:text-gray-600 text-xs hover:text-blue-400 transition-colors"
                            title="Open details"
                          >—</button>
                        )}
                        {inv.linked_project_id && (
                          <a
                            href={`/projects/${inv.linked_project_id}`}
                            onClick={(e) => e.stopPropagation()}
                            title="Linked grant project"
                            className="flex-shrink-0 text-emerald-500 dark:text-emerald-400 hover:text-emerald-700 transition-colors"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 01-5.656-5.656l-1.102 1.101" />
                            </svg>
                          </a>
                        )}
                        {(inv.website || inv.source_link) && isLinkUrl((inv.website || inv.source_link)!) && (
                          <a
                            href={(inv.website || inv.source_link)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex-shrink-0 text-gray-300 hover:text-blue-500 dark:text-gray-600 dark:hover:text-blue-400 transition-colors"
                            title="Open website"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </td>
                  );
                  case "name": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="name" value={inv.name ?? ""} placeholder="Contact name"
                      display={inv.name ? <span className="text-xs text-gray-700 dark:text-gray-300 truncate block">{inv.name}</span> : dash} />
                  );
                  case "role": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="role" value={inv.role ?? ""} placeholder="Partner…"
                      display={inv.role ? <span className="text-xs text-gray-500 dark:text-gray-400 truncate block">{inv.role}</span> : dash} />
                  );
                  case "investor_type": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="investor_type" value={inv.investor_type ?? ""} editType="select" selectOptions={["", ...investorTypes.map(t => t.name)]}
                      display={inv.investor_type
                        ? <span className={`inline-block max-w-full truncate align-bottom text-[10px] px-1.5 py-0.5 rounded font-medium ${investorTypeChipClass(investorTypes, inv.investor_type)}`} title={inv.investor_type}>{inv.investor_type}</span>
                        : dash} />
                  );
                  case "investment_stage": return (
                    <MultiOptionTagCell key={c.key} investorId={inv.investor_id} value={inv.investment_stage} onSave={(id, val) => onCommitEdit(id, "investment_stage", val)}
                      options={stageOptions} createEndpoint="stage-options" refreshOptions={refreshStageOptions} />
                  );
                  case "focus": return (
                    <MultiOptionTagCell key={c.key} investorId={inv.investor_id} value={inv.focus} onSave={(id, val) => onCommitEdit(id, "focus", val)}
                      options={focusOptions} createEndpoint="focus-options" refreshOptions={refreshFocusOptions} />
                  );
                  case "intro_type": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="intro_type" value={inv.intro_type ?? ""} editType="select" selectOptions={["", "Warm", "Cold"]}
                      display={inv.intro_type
                        ? <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${inv.intro_type === "Warm" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>{inv.intro_type}</span>
                        : dash} />
                  );
                  case "outreach_date": {
                    const dateVal = inv.outreach_date ? inv.outreach_date.slice(0, 10) : "";
                    return (
                      <Editable key={c.key} rowId={inv.investor_id} field="outreach_date" value={dateVal}
                        editType="date"
                        display={inv.outreach_date
                          ? <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(inv.outreach_date).toLocaleDateString()}</span>
                          : dash} />
                    );
                  }
                  case "email": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="email" value={inv.email ?? ""} placeholder="email@firm.com"
                      display={
                        inv.email
                          ? <a href={`mailto:${inv.email}`} onClick={(e) => e.stopPropagation()} className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate block">{inv.email}</a>
                          : inv.linkedin
                            ? <a href={inv.linkedin} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-500 dark:text-blue-400 hover:underline truncate block">LinkedIn ↗</a>
                            : dash
                      } />
                  );
                  case "check_size_min": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="check_size_min" value={inv.check_size_min ?? ""} placeholder="$250K…"
                      display={<span className={`text-xs truncate block ${inv.check_size_min ? enrichedCls(inv, "check_size_min") || "text-gray-600 dark:text-gray-400" : "text-gray-300 dark:text-gray-600"}`}>{inv.check_size_min ?? "—"}</span>} />
                  );
                  case "check_size_max": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="check_size_max" value={inv.check_size_max ?? ""} placeholder="$5M…"
                      display={<span className={`text-xs truncate block ${inv.check_size_max ? enrichedCls(inv, "check_size_max") || "text-gray-600 dark:text-gray-400" : "text-gray-300 dark:text-gray-600"}`}>{inv.check_size_max ?? "—"}</span>} />
                  );
                  case "notes": return (
                    <Editable key={c.key} rowId={inv.investor_id} field="notes" value={inv.notes ?? ""} placeholder="Notes…" multiline
                      display={
                        <div className="flex flex-col gap-0.5 min-w-0">
                          {inv.notes && <span className={`text-xs truncate block ${enrichedCls(inv, "notes") || "text-gray-500 dark:text-gray-400"}`} title={inv.notes}>{inv.notes}</span>}
                          {inv.enrichment_notes && (
                            <span className="text-[10px] text-purple-500 dark:text-purple-400 truncate block" title={inv.enrichment_notes}>{inv.enrichment_notes}</span>
                          )}
                          {!inv.notes && !inv.enrichment_notes && dash}
                        </div>
                      } />
                  );
                  default: return <td key={(c as {key: string}).key} />;
                }
              })}
              <td className="px-1 py-1 whitespace-nowrap">
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => onOpenDetail(inv)} className="p-1 text-gray-400 hover:text-blue-500 rounded" title="Open details">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <button onClick={() => onDelete(inv)} className="p-1 text-gray-400 hover:text-red-500 rounded" title="Delete">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── HQ normalization ──────────────────────────────────────────────────────────

function normalizeFacets(raw: Record<string, string[]>): {
  display: Record<string, string[]>;
  hqExpand: Record<string, string[]>;
  focusExpand: Record<string, string[]>;
} {
  // Backend now returns pre-normalized facets.
  // We still need expand maps so filter selections can be passed as raw DB values to the API.
  // Since backend already normalized, canonical === raw for each value — expand maps are identity.
  const hqExpand: Record<string, string[]> = {};
  if (raw.hq) {
    for (const v of raw.hq) hqExpand[v] = [v];
  }
  const focusExpand: Record<string, string[]> = {};
  if (raw.focus) {
    for (const v of raw.focus) focusExpand[v] = [v];
  }
  return { display: raw, hqExpand, focusExpand };
}

// ── Filter Panel ──────────────────────────────────────────────────────────────

// Owner is a filter but not a plain string facet — its values are user ids
// resolved to names for display, so it gets its own section in the panel.
type ColFilterKey = "focus" | "investor_type" | "hq" | "stage" | "geo_focus" | "assigned_to";
type ColFilters = Partial<Record<ColFilterKey, Set<string>>>;
/** Sentinel value for "has no owner". */
const UNASSIGNED = "none";

const FILTER_FIELDS: { key: "focus" | "investor_type" | "hq" | "stage" | "geo_focus"; label: string; facetKey: string }[] = [
  { key: "focus",         label: "Focus",            facetKey: "focus" },
  { key: "investor_type", label: "Type",             facetKey: "investor_type" },
  { key: "stage",         label: "Investment Stage", facetKey: "investment_stage" },
  { key: "hq",            label: "HQ Country",       facetKey: "hq" },
  { key: "geo_focus",     label: "Geo Focus",        facetKey: "geo_focus" },
];

function FilterPanel({
  facets, colFilters, onToggle, onClear, onClearAll, onClose,
  statuses, filterStatus, onSetStatus,
  filterTier, onSetTier,
  filterEnriched, onSetEnriched,
}: {
  facets: Record<string, string[]>;
  colFilters: ColFilters;
  onToggle: (field: ColFilterKey, val: string) => void;
  onClear: (field: ColFilterKey) => void;
  onClearAll: () => void;
  onClose: () => void;
  statuses: InvestorStatus[];
  filterStatus: string;
  onSetStatus: (s: string) => void;
  filterTier: string;
  onSetTier: (t: string) => void;
  filterEnriched: "enriched" | "unenriched" | "";
  onSetEnriched: (v: "enriched" | "unenriched" | "") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<Record<string, string>>({});
  const focusOptions = useFocusOptions();
  const assignableUsers = useAssignableUsers();
  const ownerOptions = useMemo(
    () => [
      { value: UNASSIGNED, label: "Unassigned", name: null as string | null },
      ...assignableUsers.map(u => ({ value: u.user_id, label: u.display_name, name: u.display_name as string | null })),
    ],
    [assignableUsers],
  );

  useEffect(() => {
    function handler(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  function handleClearAll() {
    onClearAll();
    onSetStatus("");
    onSetTier("");
    onSetEnriched("");
  }

  return (
    <div ref={ref}
      className="absolute left-0 top-full mt-1.5 w-[760px] max-h-[560px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Filter investors</span>
        <div className="flex items-center gap-2">
          <button onClick={handleClearAll} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800">
            Clear all
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="overflow-y-auto flex-1">
        {/* Status + Tier row */}
        <div className="grid grid-cols-2 gap-0 divide-x divide-gray-100 dark:divide-gray-800 border-b border-gray-100 dark:border-gray-800">
          {/* Status */}
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Status</span>
              {filterStatus && <button onClick={() => onSetStatus("")} className="text-[10px] text-blue-500 hover:text-blue-700">clear</button>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {statuses.map(s => (
                <button key={s.name} onClick={() => onSetStatus(filterStatus === s.name ? "" : s.name)}
                  className={`text-[10px] px-2 py-0.5 rounded border font-medium transition-all ${
                    filterStatus === s.name
                      ? statusChipClass(statuses, s.name) + " ring-2 ring-offset-1 ring-current"
                      : statusChipClass(statuses, s.name)
                  }`}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          {/* Tier */}
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Fit Tier</span>
              {filterTier && <button onClick={() => onSetTier("")} className="text-[10px] text-blue-500 hover:text-blue-700">clear</button>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TIER_OPTIONS.map(t => (
                <button key={t.key} onClick={() => onSetTier(filterTier === t.key ? "" : t.key)}
                  className={`text-[10px] px-2 py-0.5 rounded border font-medium transition-all ${t.cls} ${
                    filterTier === t.key ? "ring-2 ring-offset-1 ring-current" : "opacity-70 hover:opacity-100"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {/* Owner */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Owner</span>
            {(colFilters.assigned_to?.size ?? 0) > 0 && (
              <button onClick={() => onClear("assigned_to")} className="text-[10px] text-blue-500 hover:text-blue-700">
                clear ({colFilters.assigned_to!.size})
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {ownerOptions.map(o => {
              const active = colFilters.assigned_to?.has(o.value) ?? false;
              return (
                <button key={o.value} onClick={() => onToggle("assigned_to", o.value)}
                  className={`flex items-center gap-1.5 text-[11px] pl-1 pr-2 py-0.5 rounded border font-medium transition-all ${
                    active
                      ? "bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300"
                      : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-blue-300 hover:text-blue-600"
                  }`}>
                  <UserAvatar name={o.name} size={16} />
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        {/* Enriched */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Enrichment</span>
            {filterEnriched && <button onClick={() => onSetEnriched("")} className="text-[10px] text-blue-500 hover:text-blue-700">clear</button>}
          </div>
          <div className="flex gap-1.5">
            {([["enriched", "Enriched"], ["unenriched", "Not enriched"]] as const).map(([val, label]) => (
              <button key={val} onClick={() => onSetEnriched(filterEnriched === val ? "" : val)}
                className={`text-[10px] px-2.5 py-0.5 rounded border font-medium transition-all ${
                  filterEnriched === val
                    ? "bg-violet-100 dark:bg-violet-900/40 border-violet-400 text-violet-700 dark:text-violet-300 ring-2 ring-offset-1 ring-violet-400"
                    : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-300 hover:text-violet-600"
                }`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* Facet fields */}
        <div className="grid grid-cols-2 gap-0 divide-x divide-gray-100 dark:divide-gray-800">
          {FILTER_FIELDS.map(f => {
            const options = facets[f.facetKey] ?? [];
            const active = colFilters[f.key] ?? new Set<string>();
            const q = search[f.key] ?? "";
            const filtered = options.filter(o => o.toLowerCase().includes(q.toLowerCase()));
            return (
              <div key={f.key} className="p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{f.label}</span>
                  {active.size > 0 && (
                    <button onClick={() => onClear(f.key)} className="text-[10px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">
                      clear ({active.size})
                    </button>
                  )}
                </div>
                {options.length > 8 && (
                  <input
                    value={q}
                    onChange={e => setSearch(s => ({ ...s, [f.key]: e.target.value }))}
                    placeholder={`Search ${f.label.toLowerCase()}…`}
                    className="w-full px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 outline-none focus:ring-1 focus:ring-blue-500/40 mb-1"
                  />
                )}
                <div className="space-y-0.5 max-h-48 overflow-y-auto">
                  {filtered.slice(0, 40).map(o => (
                    <label key={o} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={active.has(o)}
                        onChange={() => onToggle(f.key, o)}
                        className="accent-blue-600 flex-shrink-0"
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1">{o}</span>
                      {f.key === "focus" && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${optionChipClass(focusOptions, o)}`}>{o}</span>
                      )}
                    </label>
                  ))}
                  {filtered.length === 0 && <p className="text-xs text-gray-400 px-1.5 py-2">No options</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Investor Settings Tab ──────────────────────────────────────────────────────

type RubricDimension = {
  label: string;
  description: string;
  max: number;
  levels: Record<string, string>;
};

type ScoringCriteria = {
  company_stage: string;
  target_raise_min: number;
  target_raise_max: number;
  target_stages: string[];
  target_geo: string[];
  target_sectors: string[];
  check_target_min: number;
  check_target_max: number;
};

const DEFAULT_CRITERIA: ScoringCriteria = {
  company_stage: "Pre-seed",
  target_raise_min: 500000,
  target_raise_max: 3000000,
  target_stages: ["Pre-seed", "Seed"],
  target_geo: ["United States", "North America", "Canada"],
  target_sectors: [],
  check_target_min: 500000,
  check_target_max: 2000000,
};

const STAGE_OPTIONS = ["Pre-seed", "Seed", "Series A", "Series B", "Series C", "Growth", "Late Stage"];

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function parseMoney(s: string): number {
  const v = s.toUpperCase().replace(/[$,]/g, "").trim();
  if (v.endsWith("M")) return parseFloat(v) * 1_000_000;
  if (v.endsWith("K")) return parseFloat(v) * 1_000;
  return parseFloat(v) || 0;
}

/** Email template library — lives in Settings and feeds the compose box in
 *  every investor's Activity section. */
/** A document kept for reuse and offered in every composer. */
type LibraryDoc = {
  id: string;
  name: string;
  filename: string;
  mime_type: string | null;
  size: number | null;
  uploaded_by: string | null;
};

const SETTINGS_INPUT = "w-full text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/30";

/** Which shared documents a template carries. Only documents from the shelf —
 *  a template is reused for months, so pointing it at a one-off upload would
 *  mean an email that quietly stops carrying its attachment one day. */
function TemplateAttachments({ picked, library, onChange }: {
  picked: Attachment[];
  library: LibraryDoc[];
  onChange: (next: Attachment[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const available = library.filter(d => !picked.some(p => p.id === d.id));

  return (
    <div className="space-y-1.5">
      {picked.map(f => (
        <div key={f.id} className="flex items-center gap-2 rounded-md border border-gray-200 dark:border-white/10 px-2 py-1">
          <span className="text-[11px] text-gray-700 dark:text-gray-300 truncate flex-1">{f.name}</span>
          {f.size && <span className="text-[10px] text-gray-400 shrink-0">{Math.round(f.size / 1024)} KB</span>}
          <button onClick={() => onChange(picked.filter(x => x.id !== f.id))}
            className="text-[10px] text-gray-300 hover:text-red-500 shrink-0">✕</button>
        </div>
      ))}

      {adding && available.length > 0 && (
        <div className="max-h-32 overflow-y-auto rounded-md border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5">
          {available.map(d => (
            <button key={d.id}
              onClick={() => {
                onChange([...picked, {
                  id: d.id, name: d.filename, mime_type: d.mime_type,
                  size: d.size, source: "upload" as const,
                }]);
                setAdding(false);
              }}
              className="w-full text-left px-2.5 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              <span className="text-[11px] text-gray-700 dark:text-gray-300">{d.name}</span>
              {d.size && <span className="text-[10px] text-gray-400 ml-1.5">{Math.round(d.size / 1024)} KB</span>}
            </button>
          ))}
        </div>
      )}

      {library.length === 0 ? (
        <p className="text-[10px] text-gray-400">
          Upload something under Shared documents below to attach it to a template.
        </p>
      ) : available.length > 0 ? (
        <button onClick={() => setAdding(v => !v)}
          className="text-[11px] px-2 py-1 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
          {adding ? "Cancel" : "+ Attach document"}
        </button>
      ) : null}
    </div>
  );
}

function EmailTemplatesSettings() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<EmailTemplate>>({});
  const [busy, setBusy] = useState(false);

  const [library, setLibrary] = useState<LibraryDoc[]>([]);

  const load = useCallback(() => {
    fetch("/api/proxy/comms/templates?scope=investor")
      .then(r => r.json()).then(setTemplates).catch(() => {});
  }, []);
  const loadLibrary = useCallback(() => {
    fetch("/api/proxy/comms/library").then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  function startNew() {
    setEditing("new");
    setDraft({ name: "", kind: "outreach", subject: "", body: "", default_delay_days: null, attachments: [] });
  }

  function startEdit(t: EmailTemplate) {
    setEditing(t.template_id);
    setDraft({ ...t });
  }

  async function save() {
    if (!draft.name?.trim()) return;
    setBusy(true);
    try {
      const isNew = editing === "new";
      await fetch(`/api/proxy/comms/templates${isNew ? "" : `/${editing}`}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name, kind: draft.kind ?? "outreach", scope: "investor",
          subject: draft.subject ?? "", body: draft.body ?? "",
          default_delay_days: draft.default_delay_days || null,
          attachments: draft.attachments ?? [],
        }),
      });
      setEditing(null);
      load();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Delete this template?")) return;
    await fetch(`/api/proxy/comms/templates/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="px-4 pb-4 pt-3 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] text-gray-400">
        Placeholders are filled per investor before sending:{" "}
        <code className="text-[10px]">{"{{firm}}"}</code>{" "}
        <code className="text-[10px]">{"{{contact_name}}"}</code>{" "}
        <code className="text-[10px]">{"{{focus}}"}</code>{" "}
        <code className="text-[10px]">{"{{stage}}"}</code>{" "}
        <code className="text-[10px]">{"{{check_size}}"}</code>
      </p>

      {templates.map(t => (
        <div key={t.template_id} className="border border-gray-200 dark:border-white/10 rounded-lg">
          {editing === t.template_id ? (
            <div className="p-3 space-y-2">
              <div className="flex gap-2">
                <input value={draft.name ?? ""} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  placeholder="Template name" className={SETTINGS_INPUT} />
                <StyledSelect value={draft.kind ?? "outreach"}
                  onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}
                  className={SETTINGS_INPUT + " w-36"}>
                  <option value="outreach">Outreach</option>
                  <option value="follow_up">Follow-up</option>
                </StyledSelect>
                <input type="number" min={1} max={90} value={draft.default_delay_days ?? ""}
                  onChange={e => setDraft(d => ({ ...d, default_delay_days: e.target.value ? Number(e.target.value) : null }))}
                  placeholder="Delay" title="Default days to wait when queued as a follow-up"
                  className={SETTINGS_INPUT + " w-20"} />
              </div>
              <input value={draft.subject ?? ""} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
                placeholder="Subject" className={SETTINGS_INPUT} />
              <AutoTextarea value={draft.body ?? ""} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
                rows={7} placeholder="Body" className={SETTINGS_INPUT + " resize-y"} />
              <TemplateAttachments picked={draft.attachments ?? []} library={library}
                onChange={next => setDraft(d => ({ ...d, attachments: next }))} />
              <div className="flex items-center gap-1.5">
                <button onClick={save} disabled={busy || !draft.name?.trim()}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">Save</button>
                <button onClick={() => setEditing(null)}
                  className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
                t.kind === "follow_up"
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              }`}>{t.kind === "follow_up" ? "Follow-up" : "Outreach"}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{t.name}</p>
                <p className="text-[11px] text-gray-400 truncate">{t.subject || "No subject"}</p>
              </div>
              {(t.attachments?.length ?? 0) > 0 && (
                <span className="text-[10px] text-gray-400 shrink-0"
                  title={t.attachments.map(f => f.name).join(", ")}>
                  📎 {t.attachments.length}
                </span>
              )}
              {t.default_delay_days && (
                <span className="text-[10px] text-gray-400 shrink-0">{t.default_delay_days}d</span>
              )}
              <button onClick={() => startEdit(t)}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline shrink-0">Edit</button>
              <button onClick={() => remove(t.template_id)}
                className="text-[11px] text-gray-400 hover:text-red-500 shrink-0">Delete</button>
            </div>
          )}
        </div>
      ))}

      {editing === "new" ? (
        <div className="border border-gray-200 dark:border-white/10 rounded-lg p-3 space-y-2">
          <div className="flex gap-2">
            <input autoFocus value={draft.name ?? ""} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
              placeholder="Template name" className={SETTINGS_INPUT} />
            <StyledSelect value={draft.kind ?? "outreach"}
              onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}
              className={SETTINGS_INPUT + " w-36"}>
              <option value="outreach">Outreach</option>
              <option value="follow_up">Follow-up</option>
            </StyledSelect>
            <input type="number" min={1} max={90} value={draft.default_delay_days ?? ""}
              onChange={e => setDraft(d => ({ ...d, default_delay_days: e.target.value ? Number(e.target.value) : null }))}
              placeholder="Delay" title="Default days to wait when queued as a follow-up"
              className={SETTINGS_INPUT + " w-20"} />
          </div>
          <input value={draft.subject ?? ""} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
            placeholder="Subject" className={SETTINGS_INPUT} />
          <AutoTextarea value={draft.body ?? ""} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            rows={7} placeholder="Body" className={SETTINGS_INPUT + " resize-y"} />
          <TemplateAttachments picked={draft.attachments ?? []} library={library}
            onChange={next => setDraft(d => ({ ...d, attachments: next }))} />
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={busy || !draft.name?.trim()}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">Save</button>
            <button onClick={() => setEditing(null)}
              className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={startNew}
          className="w-full text-[11px] px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          + Add template
        </button>
      )}

      <SignatureSettings />
      <SharedDocuments />
    </div>
  );
}

/** Your sign-off, editable here as well as from the composer.
 *
 *  Same record either way — PUT /comms/signature only ever writes your own, so
 *  this is a second door to one setting, not a second setting. Worth having
 *  because the composer only exposes it mid-email, and changing your signature
 *  is not something you go and write an email to do. */
function SignatureSettings() {
  const [sig, setSig] = useState<Signature | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/proxy/comms/signature")
      .then(r => (r.ok ? r.json() : null)).then(setSig).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/proxy/comms/signature", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: draft }),
      });
      if (!r.ok) { setError("Could not save your signature."); return; }
      setSig(await r.json());
      setEditing(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Email signature</p>
      <p className="text-[10px] text-gray-400">
        Added to the bottom of every email you send from here. Yours alone — emails sent
        from someone else&apos;s mailbox carry theirs.
      </p>

      {editing ? (
        <div className="space-y-1.5 rounded-lg border border-gray-200 dark:border-white/10 p-2.5">
          <AutoTextarea autoFocus value={draft} onChange={e => setDraft(e.target.value)}
            rows={5} className={SETTINGS_INPUT + " w-full resize-y font-mono text-[11px]"} />
          <p className="text-[10px] text-gray-400">
            One line per line. <span className="font-mono">Label [https://…]</span> becomes a link.
            The Open ERP logo is added for you.
          </p>
          <div className="flex items-center gap-1.5">
            <button onClick={save} disabled={busy}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium disabled:opacity-40">
              {busy ? "Saving…" : "Save signature"}
            </button>
            <button onClick={() => setEditing(false)}
              className="text-[11px] px-2 py-1.5 text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-2 space-y-2">
          {sig?.preview_html ? (
            <div className="text-[11px]" dangerouslySetInnerHTML={{ __html: sig.preview_html }} />
          ) : (
            <p className="text-[11px] text-gray-400">No signature yet.</p>
          )}
          <button onClick={() => { setDraft(sig?.signature ?? ""); setEditing(true); }}
            className="text-[10px] text-gray-400 hover:text-blue-600">
            {sig?.preview_html ? "Edit signature" : "+ Add a signature"}
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}
    </div>
  );
}

/** Documents kept for reuse — the deck, the one-pager, the NDA. Uploaded once
 *  here and offered in every composer, so nobody has to find the current
 *  version on their own laptop before writing an email. */
function SharedDocuments() {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");

  const load = useCallback(() => {
    fetch("/api/proxy/comms/library").then(r => r.json()).then(setDocs).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const r = await fetch("/api/proxy/comms/library", { method: "POST", body: form });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          setError(typeof e.detail === "string" ? e.detail : `Could not upload ${file.name}.`);
        }
      }
      load();
    } finally { setBusy(false); }
  }

  async function rename(id: string) {
    await fetch(`/api/proxy/comms/library/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: renameTo }),
    });
    setRenaming(null); load();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove "${name}" from shared documents?`)) return;
    const r = await fetch(`/api/proxy/comms/library/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      // 409: something queued still attaches it, so deleting would break a send.
      setError(typeof e.detail === "string" ? e.detail : "Could not remove that document.");
      return;
    }
    setError(null); load();
  }

  return (
    <div className="pt-3 mt-1 border-t border-gray-100 dark:border-white/10 space-y-2">
      <p className="text-[11px] font-semibold text-gray-500 dark:text-gray-400">Shared documents</p>
      <p className="text-[10px] text-gray-400">
        Available as attachments in every email composer. Renaming changes only the name
        shown here — recipients still see the original filename.
      </p>

      {docs.map(d => (
        <div key={d.id} className="group flex items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-2.5 py-1.5">
          {renaming === d.id ? (
            <>
              <input autoFocus value={renameTo} onChange={e => setRenameTo(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") rename(d.id); if (e.key === "Escape") setRenaming(null); }}
                className={SETTINGS_INPUT + " flex-1"} />
              <button onClick={() => rename(d.id)}
                className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Save</button>
              <button onClick={() => setRenaming(null)}
                className="text-[11px] px-1 text-gray-400 hover:text-gray-600">Cancel</button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-gray-700 dark:text-gray-300 truncate">{d.name}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  {d.filename}
                  {d.size ? ` · ${Math.round(d.size / 1024)} KB` : ""}
                  {d.uploaded_by ? ` · ${d.uploaded_by}` : ""}
                </p>
              </div>
              <button onClick={() => { setRenaming(d.id); setRenameTo(d.name); }}
                className="shrink-0 text-[10px] text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">Rename</button>
              <button onClick={() => remove(d.id, d.name)}
                className="shrink-0 text-[10px] text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
            </>
          )}
        </div>
      ))}

      {error && (
        <p className="rounded-md bg-red-50 dark:bg-red-950/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">{error}</p>
      )}

      <label className="block w-full text-center text-[11px] px-3 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer">
        {busy ? "Uploading…" : "+ Upload document"}
        <input type="file" multiple className="hidden"
          onChange={e => { upload(e.target.files); e.target.value = ""; }} />
      </label>
    </div>
  );
}

function InvestorSettingsTab() {
  const [rubric, setRubric] = useState<Record<string, RubricDimension> | null>(null);
  const [thresholds, setThresholds] = useState({ tier1: 17, tier2: 13, tier3: 9, tier4: 5 });
  const [criteria, setCriteria] = useState<ScoringCriteria>(DEFAULT_CRITERIA);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [rescored, setRescored] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [enrichStatus, setEnrichStatus] = useState<{ enriched: number; pending: number; total: number } | null>(null);
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichBatch, setEnrichBatch] = useState(5);
  const [enrichResult, setEnrichResult] = useState<{ processed?: number; succeeded?: number; failed?: number; errors?: { firm?: string; error?: string }[] } | null>(null);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [rubricExpanded, setRubricExpanded] = useState(false);
  const [discoveryExpanded, setDiscoveryExpanded] = useState(false);
  const [discoveryRunning, setDiscoveryRunning] = useState(false);
  const [discoveryPages, setDiscoveryPages] = useState(2);
  const [discoveryResult, setDiscoveryResult] = useState<{ fetched?: number; inserted?: number; duplicates_skipped?: number; credits_used?: number; errors?: unknown[] } | null>(null);
  const [sectorInput, setSectorInput] = useState("");
  const [geoInput, setGeoInput] = useState("");
  const [listOptionsExpanded, setListOptionsExpanded] = useState(false);
  const [templatesExpanded, setTemplatesExpanded] = useState(false);
  const [showManageStatuses, setShowManageStatuses] = useState(false);
  const [showManageTypes, setShowManageTypes] = useState(false);
  const [showManageFocus, setShowManageFocus] = useState(false);
  const [showManageStages, setShowManageStages] = useState(false);
  const statuses = useInvestorStatuses();
  const investorTypes = useInvestorTypes();
  const focusOptions = useFocusOptions();
  const stageOptions = useStageOptions();

  useEffect(() => {
    Promise.all([
      fetch("/api/proxy/dilutive/scoring-rubric").then(r => r.json()),
      fetch("/api/proxy/dilutive/enrich-status").then(r => r.json()),
    ]).then(([rubricData, enrichData]) => {
      setRubric(rubricData.rubric);
      setThresholds(rubricData.tier_thresholds ?? { tier1: 17, tier2: 13, tier3: 9, tier4: 5 });
      setCriteria({ ...DEFAULT_CRITERIA, ...(rubricData.criteria ?? {}) });
      setEnrichStatus(enrichData);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function saveRubric() {
    setSaving(true);
    try {
      await fetch("/api/proxy/dilutive/scoring-rubric", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubric, tier_thresholds: thresholds, criteria }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  async function clearScores() {
    if (!confirm("Clear all scores and tiers for all investors? This cannot be undone.")) return;
    setClearing(true);
    try {
      await fetch("/api/proxy/dilutive/scores", { method: "DELETE" });
      setRescored(null);
    } finally {
      setClearing(false);
    }
  }

  function toggleStage(stage: string) {
    setCriteria(prev => ({
      ...prev,
      target_stages: prev.target_stages.includes(stage)
        ? prev.target_stages.filter(s => s !== stage)
        : [...prev.target_stages, stage],
    }));
  }

  function addSector(s: string) {
    const trimmed = s.trim();
    if (trimmed && !criteria.target_sectors.includes(trimmed)) {
      setCriteria(prev => ({ ...prev, target_sectors: [...prev.target_sectors, trimmed] }));
    }
    setSectorInput("");
  }

  function addGeo(g: string) {
    const trimmed = g.trim();
    if (trimmed && !criteria.target_geo.includes(trimmed)) {
      setCriteria(prev => ({ ...prev, target_geo: [...prev.target_geo, trimmed] }));
    }
    setGeoInput("");
  }

  async function rescore() {
    setRescoring(true);
    setRescored(null);
    try {
      const r = await fetch("/api/proxy/dilutive/rescore", { method: "POST" });
      const d = await r.json();
      setRescored(d.updated ?? 0);
    } finally {
      setRescoring(false);
    }
  }

  async function runEnrichBatch(allInvestors = false, allUnenriched = false) {
    setEnrichRunning(true);
    setEnrichResult(null);
    try {
      const body = allInvestors
        ? { all_investors: true, max_investors: 5000 }
        : allUnenriched
        ? { max_investors: 5000 }
        : { max_investors: enrichBatch };
      const r = await fetch("/api/proxy/dilutive/enrich-batch-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setEnrichResult(d);
      const s = await fetch("/api/proxy/dilutive/enrich-status").then(x => x.json());
      setEnrichStatus(s);
    } finally {
      setEnrichRunning(false);
    }
  }

  async function runDiscovery() {
    setDiscoveryRunning(true);
    setDiscoveryResult(null);
    try {
      const r = await fetch("/api/proxy/dilutive/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_pages: discoveryPages, page_size: 100 }),
      });
      const d = await r.json();
      setDiscoveryResult(d);
    } finally {
      setDiscoveryRunning(false);
    }
  }

  function updateLevel(dim: string, lvl: string, val: string) {
    setRubric(prev => prev ? {
      ...prev,
      [dim]: { ...prev[dim], levels: { ...prev[dim].levels, [lvl]: val } },
    } : prev);
  }

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-sm text-gray-400">Loading…</div>;
  }

  const enrichPct = enrichStatus && enrichStatus.total > 0
    ? Math.round((enrichStatus.enriched / enrichStatus.total) * 100) : 0;

  const TIER_LABELS = [
    { key: "tier1", label: "Tier 1 — Strong Fit", cls: "text-green-700 dark:text-green-400" },
    { key: "tier2", label: "Tier 2 — Good Fit",   cls: "text-blue-700 dark:text-blue-400" },
    { key: "tier3", label: "Tier 3 — Possible",   cls: "text-yellow-700 dark:text-yellow-400" },
    { key: "tier4", label: "Tier 4 — Weak Fit",   cls: "text-orange-700 dark:text-orange-400" },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-3 py-2">

      {/* Email Templates */}
      <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
        <button onClick={() => setTemplatesExpanded(e => !e)}
          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
          <div className="w-6 h-6 rounded-md bg-violet-100 dark:bg-violet-950 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Email Templates</span>
            <p className="text-[11px] text-gray-400">Reusable outreach and follow-up emails, offered in every investor&apos;s Activity section</p>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${templatesExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {templatesExpanded && <EmailTemplatesSettings />}
      </div>

      {/* Status & Type Options */}
      <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
        <button onClick={() => setListOptionsExpanded(e => !e)}
          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
          <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-950 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Status &amp; Type Options</span>
            <p className="text-[11px] text-gray-400">Customize the dropdown values used across the investor table</p>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${listOptionsExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {listOptionsExpanded && (
          <div className="px-4 pb-4 pt-1 grid grid-cols-2 gap-4 border-t border-gray-100 dark:border-white/10">
            <div>
              <div className="flex items-center justify-between mb-2 mt-3">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Statuses</span>
                <button onClick={() => setShowManageStatuses(true)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium">Manage</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {statuses.map(s => (
                  <span key={s.id} className={`text-[11px] px-2 py-0.5 rounded font-medium ${statusChipClass(statuses, s.name)}`}>{s.name}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2 mt-3">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Types</span>
                <button onClick={() => setShowManageTypes(true)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium">Manage</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {investorTypes.map(t => (
                  <span key={t.id} className={`text-[11px] px-2 py-0.5 rounded font-medium ${investorTypeChipClass(investorTypes, t.name)}`}>{t.name}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2 mt-3">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Focus</span>
                <button onClick={() => setShowManageFocus(true)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium">Manage</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {focusOptions.map(f => (
                  <span key={f.id} className={`text-[11px] px-2 py-0.5 rounded font-medium ${optionChipClass(focusOptions, f.name)}`}>{f.name}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2 mt-3">
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Stages</span>
                <button onClick={() => setShowManageStages(true)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium">Manage</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stageOptions.map(s => (
                  <span key={s.id} className={`text-[11px] px-2 py-0.5 rounded font-medium ${optionChipClass(stageOptions, s.name)}`}>{s.name}</span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {showManageStatuses && (
        <ManageStatusesModal onClose={() => setShowManageStatuses(false)} onChanged={() => refreshStatuses()} />
      )}
      {showManageTypes && (
        <ManageInvestorTypesModal onClose={() => setShowManageTypes(false)} onChanged={() => refreshInvestorTypes()} />
      )}
      {showManageFocus && (
        <ManageOptionListModal title="Manage focus" endpoint="focus-options" useOptions={useFocusOptions} refresh={refreshFocusOptions}
          onClose={() => setShowManageFocus(false)} onChanged={() => refreshFocusOptions()} />
      )}
      {showManageStages && (
        <ManageOptionListModal title="Manage stages" endpoint="stage-options" useOptions={useStageOptions} refresh={refreshStageOptions}
          onClose={() => setShowManageStages(false)} onChanged={() => refreshStageOptions()} />
      )}

      {/* Enrichment Agent */}
      <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
        <button onClick={() => setAgentExpanded(e => !e)}
          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
          <div className="w-6 h-6 rounded-md bg-purple-100 dark:bg-purple-950 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-white">Investor Enrichment</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 font-medium">Active</span>
            </div>
            {enrichStatus && (
              <div className="flex items-center gap-3 mt-1">
                <div className="flex-1 h-1 bg-gray-100 dark:bg-white/10 rounded overflow-hidden">
                  <div className="h-full bg-purple-500 rounded transition-all" style={{ width: `${enrichPct}%` }} />
                </div>
                <span className="text-[10px] text-gray-400 shrink-0">
                  {enrichStatus.enriched}/{enrichStatus.total} enriched · {enrichStatus.pending} pending
                </span>
              </div>
            )}
          </div>
          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${agentExpanded ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {agentExpanded && (
          <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 space-y-2 bg-gray-50 dark:bg-white/2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">Investors per run:</span>
              <StyledSelect value={enrichBatch} onChange={e => setEnrichBatch(Number(e.target.value))} disabled={enrichRunning}
                className="text-xs pl-2 pr-6 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none w-auto">
                {[1, 3, 5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </StyledSelect>
              <span className="text-[10px] text-gray-400">~${(enrichBatch * 0.077).toFixed(2)} est. cost</span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => runEnrichBatch(false)} disabled={enrichRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                  {enrichRunning ? (
                    <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>Running…</>
                  ) : "Run batch"}
                </button>
                <button onClick={() => { if (confirm("Enrich all unenriched investors?")) runEnrichBatch(false, true); }} disabled={enrichRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                  Enrich all
                </button>
              </div>
            </div>
            {enrichResult && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {enrichResult.processed != null
                  ? <>✓ {enrichResult.succeeded}/{enrichResult.processed} succeeded
                      {(enrichResult.failed ?? 0) > 0 && <span className="text-red-500"> · {enrichResult.failed} failed</span>}</>
                  : null}
              </div>
            )}
            <div className="text-[10px] text-gray-400 space-y-1">
              <p className="font-medium text-gray-500 dark:text-gray-400">Pipeline per investor:</p>
              <div className="space-y-0.5 pl-2">
                <p><span className="text-gray-600 dark:text-gray-300">1. Fundable /investor/search</span> — fuzzy name match → Fundable ID ($0.011/call)</p>
                <p><span className="text-gray-600 dark:text-gray-300">2. Fundable /investor</span> — full profile: HQ, top industries, deal history, website, LinkedIn ($0.066/call)</p>
                <p><span className="text-gray-600 dark:text-gray-300">3. Apollo /organizations/enrich</span> — city, state, founded year, employee count, keywords (free)</p>
                <p><span className="text-gray-600 dark:text-gray-300">4. Claude Sonnet + web search</span> — fund size, check size range, active thesis (only if gaps remain)</p>
                <p><span className="text-gray-600 dark:text-gray-300">5. Scoring</span> — Claude scores all 5 rubric dimensions and writes tier</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Discovery Agent */}
      <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
        <button onClick={() => setDiscoveryExpanded(e => !e)}
          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
          <div className="w-6 h-6 rounded-md bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-white">Investor Discovery</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-medium">On-demand</span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Find new investors via Fundable filter search</p>
          </div>
          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${discoveryExpanded ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {discoveryExpanded && (
          <div className="border-t border-gray-100 dark:border-white/8 px-4 py-3 space-y-3 bg-gray-50 dark:bg-white/2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">Pages to fetch:</span>
              <StyledSelect value={discoveryPages} onChange={e => setDiscoveryPages(Number(e.target.value))} disabled={discoveryRunning}
                className="text-xs pl-2 pr-6 py-1 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none">
                {[1, 2, 4, 6, 8, 10].map(n => <option key={n} value={n}>{n} ({n * 100} investors)</option>)}
              </StyledSelect>
              <span className="text-[10px] text-gray-400">~${(discoveryPages * 0.66).toFixed(2)} est. cost</span>
              <button onClick={runDiscovery} disabled={discoveryRunning}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
                {discoveryRunning ? (
                  <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>Discovering…</>
                ) : "Run discovery"}
              </button>
            </div>
            {discoveryResult && (
              <div className="text-xs space-y-0.5">
                <p className="text-gray-700 dark:text-gray-300">
                  ✓ <strong>{discoveryResult.inserted}</strong> new investors added
                  {" · "}<span className="text-gray-400">{discoveryResult.fetched} fetched, {discoveryResult.duplicates_skipped} already in DB</span>
                </p>
                {(discoveryResult.credits_used ?? 0) > 0 && (
                  <p className="text-gray-400">${discoveryResult.credits_used?.toFixed(2)} credits used</p>
                )}
                {(discoveryResult.errors?.length ?? 0) > 0 && (
                  <p className="text-red-500">{discoveryResult.errors?.length} page errors</p>
                )}
              </div>
            )}
            <p className="text-[10px] text-gray-400">
              Searches Fundable for investors matching the configured industry filters. Deduplicates against existing records and imports net-new.
            </p>
          </div>
        )}
      </div>

      {/* Scoring Criteria + Tier Thresholds */}
      <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
        <button onClick={() => setRubricExpanded(e => !e)}
          className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-white/3 transition-colors text-left">
          <div className="w-6 h-6 rounded-md bg-yellow-100 dark:bg-yellow-950 flex items-center justify-center shrink-0">
            <svg className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-white">Scoring Criteria &amp; Tiers</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">what you're looking for · scored automatically</span>
          </div>
          <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${rubricExpanded ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {rubricExpanded && (
          <div className="border-t border-gray-100 dark:border-white/8 bg-gray-50 dark:bg-white/2 divide-y divide-gray-100 dark:divide-white/8">

            {/* Target Investment Stages */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">Target Investor Stages</p>
              <p className="text-[10px] text-gray-400 mb-3">Investors who write checks at these stages score higher.</p>
              <div className="flex flex-wrap gap-1.5">
                {STAGE_OPTIONS.map(s => {
                  const active = criteria.target_stages.includes(s);
                  return (
                    <button key={s} onClick={() => toggleStage(s)}
                      className={`text-xs px-2.5 py-1 rounded border font-medium transition-colors ${
                        active
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "bg-white dark:bg-white/5 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400 hover:border-blue-400"
                      }`}>
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Check Size */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">Target Check Size Range</p>
              <p className="text-[10px] text-gray-400 mb-3">Investors whose typical first check overlaps this range score higher.</p>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-gray-400 block mb-1">Min</label>
                  <input type="text"
                    defaultValue={formatMoney(criteria.check_target_min)}
                    onBlur={e => setCriteria(prev => ({ ...prev, check_target_min: parseMoney(e.target.value) || prev.check_target_min }))}
                    className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40" />
                </div>
                <span className="text-gray-400 mt-4">–</span>
                <div className="flex-1">
                  <label className="text-[10px] text-gray-400 block mb-1">Max</label>
                  <input type="text"
                    defaultValue={formatMoney(criteria.check_target_max)}
                    onBlur={e => setCriteria(prev => ({ ...prev, check_target_max: parseMoney(e.target.value) || prev.check_target_max }))}
                    className="w-full text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40" />
                </div>
              </div>
            </div>

            {/* Target Sectors */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">Target Sectors / Thesis</p>
              <p className="text-[10px] text-gray-400 mb-3">More sector matches in the investor's thesis → higher focus score.</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {criteria.target_sectors.map(s => (
                  <span key={s} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">
                    {s}
                    <button onClick={() => setCriteria(prev => ({ ...prev, target_sectors: prev.target_sectors.filter(x => x !== s) }))}
                      className="text-purple-400 hover:text-purple-600 leading-none">×</button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input type="text" placeholder="Add sector…" value={sectorInput}
                  onChange={e => setSectorInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addSector(sectorInput); }}}
                  className="flex-1 text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40" />
                <button onClick={() => addSector(sectorInput)} disabled={!sectorInput.trim()}
                  className="px-2.5 py-1.5 text-xs bg-gray-100 dark:bg-white/10 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 disabled:opacity-40">Add</button>
              </div>
            </div>

            {/* Target Geography */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-2">Target Geography</p>
              <p className="text-[10px] text-gray-400 mb-3">Investors with these regions in their geo focus or HQ score higher.</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {criteria.target_geo.map(g => (
                  <span key={g} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                    {g}
                    <button onClick={() => setCriteria(prev => ({ ...prev, target_geo: prev.target_geo.filter(x => x !== g) }))}
                      className="text-emerald-400 hover:text-emerald-600 leading-none">×</button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input type="text" placeholder="Add region/country…" value={geoInput}
                  onChange={e => setGeoInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addGeo(geoInput); }}}
                  className="flex-1 text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40" />
                <button onClick={() => addGeo(geoInput)} disabled={!geoInput.trim()}
                  className="px-2.5 py-1.5 text-xs bg-gray-100 dark:bg-white/10 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 disabled:opacity-40">Add</button>
              </div>
            </div>

            {/* Tier Thresholds */}
            <div className="px-4 py-4">
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-3">Tier Thresholds <span className="font-normal text-gray-400">(min score / 20 to reach each tier)</span></p>
              <div className="grid grid-cols-2 gap-2">
                {TIER_LABELS.map(t => (
                  <div key={t.key} className="flex items-center gap-2">
                    <span className={`text-xs font-medium w-28 shrink-0 ${t.cls}`}>{t.label}</span>
                    <span className="text-xs text-gray-400">≥</span>
                    <input type="number" min={0} max={20} step={1}
                      value={thresholds[t.key as keyof typeof thresholds]}
                      onChange={e => setThresholds(prev => ({ ...prev, [t.key]: Number(e.target.value) }))}
                      className="w-14 text-xs px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-500/40 tabular-nums" />
                    <span className="text-[10px] text-gray-400">/ 20</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer actions */}
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button onClick={rescore} disabled={rescoring}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-50 transition-colors">
                  {rescoring ? "Rescoring…" : "Re-score all investors"}
                </button>
                <button onClick={clearScores} disabled={clearing}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-800/50 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 transition-colors">
                  {clearing ? "Clearing…" : "Clear all scores"}
                </button>
                {rescored !== null && (
                  <span className="text-xs text-green-600 dark:text-green-400">✓ {rescored} updated</span>
                )}
              </div>
              <button onClick={saveRubric} disabled={saving}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${saved ? "bg-green-600 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"} disabled:opacity-60`}>
                {saved ? "Saved" : saving ? "Saving…" : "Save criteria"}
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ── Dilutive Tab ───────────────────────────────────────────────────────────────

function DilutiveTab() {
  // Priority and the full list are separate boards, split the same way
  // /crm splits R&D and Portfolio contracts.
  const [innerTab, setInnerTab] = useState<"priority" | "all" | "settings">("priority");
  const priorityOnly = innerTab === "priority";
  const statuses = useInvestorStatuses();
  const assignableUsers = useAssignableUsers();
  const [rows, setRows] = useState<Investor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterTier, setFilterTier] = useState("");
  const [filterEnriched, setFilterEnriched] = useState<"enriched" | "unenriched" | "">("");
  const [showAdd, setShowAdd] = useState(false);
  const [addingForStage, setAddingForStage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Investor | null>(null);
  const [detailInv, setDetailInv] = useState<Investor | null>(null);
  const [editing, setEditing] = useState<EditingCell>(null);
  // ?investor=<id> opens that record straight away — how a task, a link in a
  // note or a bookmark reaches one investor rather than the board.
  const deepLinkParams = useSearchParams();
  const deepLinkInvestor = deepLinkParams.get("investor");
  const [deepLinkDone, setDeepLinkDone] = useState(false);

  useEffect(() => {
    if (!deepLinkInvestor || deepLinkDone) return;
    setDeepLinkDone(true);
    // Fetched by id rather than found in `rows`: the record may be on another
    // page of the list, or filtered out of the board entirely.
    fetch(`/api/proxy/dilutive/${deepLinkInvestor}`)
      .then(r => r.ok ? r.json() : null)
      .then(inv => { if (inv?.investor_id) setDetailInv(inv); })
      .catch(() => {});
  }, [deepLinkInvestor, deepLinkDone]);
  const [boardView, setBoardView] = useState<FundingViewMode>("kanban");
  // The board is the priority pipeline. The full list of 2,400+ records is a
  // table only — it is a directory to work through, not a pipeline.
  const viewMode: FundingViewMode = priorityOnly ? boardView : "list";
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 100;

  // Column filters: { field → Set<value> }
  const [colFilters, setColFilters] = useState<ColFilters>({});
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [rawFacets, setRawFacets] = useState<Record<string, string[]>>({});
  const { display: displayFacets, hqExpand, focusExpand } = useMemo(
    () => normalizeFacets(rawFacets),
    [rawFacets],
  );

  useEffect(() => {
    fetch("/api/proxy/dilutive/facets").then(r => r.json()).then(setRawFacets).catch(() => {});
    refreshStatuses();
    refreshInvestorTypes();
    refreshFocusOptions();
    refreshStageOptions();
  }, []);

  const [importState, setImportState] = useState<
    | { phase: "idle" }
    | { phase: "uploading" }
    | { phase: "done"; inserted: number; updated: number; skipped_duplicate: number; total_in_db: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const importInputRef = useRef<HTMLInputElement>(null);

  const activeFilterCount = Object.values(colFilters).reduce((n, s) => n + (s?.size ?? 0), 0)
    + (filterStatus ? 1 : 0) + (filterTier ? 1 : 0) + (filterEnriched ? 1 : 0);

  // `silent` mirrors /crm's fetchBoard: a refetch triggered by a drag must not
  // flip `loading`, because the board renders under `!loading` and would
  // unmount — taking collapsed columns, per-column sort and any open panel
  // with it.
  const load = useCallback(async (p: number, silent = false) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (priorityOnly) params.set("priority_only", "true");
    if (filterStatus && viewMode === "list") params.set("status", filterStatus);
    if (filterTier && viewMode === "list") params.set("tier", filterTier);
    if (filterEnriched) params.set("enriched", filterEnriched);
    if (colFilters.focus?.size) {
      const rawVals = [...colFilters.focus].flatMap(v => focusExpand[v] ?? [v]);
      params.set("focus", [...new Set(rawVals)].join(","));
    }
    if (colFilters.investor_type?.size) params.set("investor_type", [...colFilters.investor_type].join(","));
    if (colFilters.hq?.size) {
      const rawVals = [...colFilters.hq].flatMap(v => hqExpand[v] ?? [v]);
      params.set("hq", [...new Set(rawVals)].join(","));
    }
    if (colFilters.stage?.size)     params.set("stage",     [...colFilters.stage].join(","));
    if (colFilters.geo_focus?.size) params.set("geo_focus", [...colFilters.geo_focus].join(","));
    if (colFilters.assigned_to?.size) params.set("assigned_to", [...colFilters.assigned_to].join(","));
    if (viewMode === "kanban") {
      params.set("limit", "5000");
      params.set("offset", "0");
    } else {
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(p * PAGE_SIZE));
    }
    const res = await fetch(`/api/proxy/dilutive?${params}`);
    const data = await res.json();
    setRows(data.rows ?? []);
    setTotal(data.total ?? 0);
    setLoading(false);
  }, [search, filterStatus, filterTier, filterEnriched, viewMode, priorityOnly, colFilters, hqExpand, focusExpand]);

  useEffect(() => { setPage(0); }, [search, filterStatus, filterTier, filterEnriched, viewMode, priorityOnly, colFilters]);
  useEffect(() => { load(page); }, [page, load]);

  function toggleColFilter(field: keyof ColFilters, val: string) {
    setColFilters(prev => {
      const next = { ...prev };
      const s = new Set(next[field] ?? []);
      if (s.has(val)) s.delete(val); else s.add(val);
      if (s.size === 0) delete next[field]; else next[field] = s;
      return next;
    });
  }

  function clearFilter(field: keyof ColFilters) {
    setColFilters(prev => { const n = { ...prev }; delete n[field]; return n; });
  }

  /** Optimistic local write, so a drag lands instantly. */
  const patchRowLocal = useCallback((id: string, fields: Partial<Investor>) => {
    setRows(prev => prev.map(r => r.investor_id === id ? { ...r, ...fields } : r));
  }, []);

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.investor_id)));
  }

  async function bulkSetPriority(is_priority: boolean) {
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/proxy/dilutive/${id}/priority`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_priority }),
      })
    ));
    setSelectedIds(new Set());
    load(page);
  }

  async function bulkDelete() {
    await Promise.all([...selectedIds].map(id => fetch(`/api/proxy/dilutive/${id}`, { method: "DELETE" })));
    setSelectedIds(new Set());
    load(page);
  }

  async function bulkAssign(userId: string | null) {
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/proxy/dilutive/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_to: userId }),
      })
    ));
    setSelectedIds(new Set());
    load(page);
  }

  async function bulkSetStatus(status: string) {
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/proxy/dilutive/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
    ));
    setSelectedIds(new Set());
    load(page);
  }

  async function exportCsv() {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (filterStatus) params.set("status", filterStatus);
    if (colFilters.focus?.size) {
      const rawVals = [...colFilters.focus].flatMap(v => focusExpand[v] ?? [v]);
      params.set("focus", [...new Set(rawVals)].join(","));
    }
    if (colFilters.investor_type?.size) params.set("investor_type", [...colFilters.investor_type].join(","));
    if (colFilters.hq?.size) {
      const rawVals = [...colFilters.hq].flatMap(v => hqExpand[v] ?? [v]);
      params.set("hq", [...new Set(rawVals)].join(","));
    }
    if (colFilters.stage?.size)     params.set("stage",     [...colFilters.stage].join(","));
    if (colFilters.geo_focus?.size) params.set("geo_focus", [...colFilters.geo_focus].join(","));
    if (colFilters.assigned_to?.size) params.set("assigned_to", [...colFilters.assigned_to].join(","));
    if (priorityOnly) params.set("priority_only", "true");
    if (filterEnriched) params.set("enriched", filterEnriched);
    const res = await fetch(`/api/proxy/dilutive/export?${params}`);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const nameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = nameMatch ? nameMatch[1] : "investors.csv";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function startEdit(id: string, field: string, value: string) {
    setEditing({ id, field, value });
  }

  async function commitEdit(id: string, field: string, raw: string) {
    setEditing(null);
    const value = raw.trim();
    setRows((prev) =>
      prev.map((r) => r.investor_id === id ? { ...r, [field]: value || null } : r)
    );
    await fetch(`/api/proxy/dilutive/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value || null }),
    });
  }

  async function doDelete(inv: Investor) {
    await fetch(`/api/proxy/dilutive/${inv.investor_id}`, { method: "DELETE" });
    setDeleting(null);
    load(page);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportState({ phase: "uploading" });
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/proxy/dilutive/import", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        setImportState({ phase: "error", message: err.detail ?? "Upload failed" });
        return;
      }
      const result = await res.json();
      setImportState({ phase: "done", ...result });
      setPage(0);
    } catch (err: unknown) {
      setImportState({ phase: "error", message: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  const Editable = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editing} onStartEdit={startEdit} onCommit={commitEdit} onCancel={() => setEditing(null)} />
  );

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;

  return (
    <div className="h-full flex flex-col min-h-0">

      {/* Chrome — pinned above the board, the way /crm pins its header. */}
      <div className="shrink-0 px-4 pt-4 pb-3 space-y-3 border-b border-gray-200 dark:border-white/8">
      {/* Inner tab bar */}
      <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-white/8 rounded-lg p-0.5 w-fit">
        {([
          ["priority", "\u2605 Priority Investors"],
          ["all",      "All Investors"],
          ["settings", "Settings"],
        ] as const).map(([t, label]) => (
          <button key={t} onClick={() => { setInnerTab(t); setSelectedIds(new Set()); setPage(0); }}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              innerTab === t
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {innerTab !== "settings" && <>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl text-sm">
          <span className="font-medium text-blue-700 dark:text-blue-300">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <span className="text-xs text-blue-600 dark:text-blue-400">Move to:</span>
            {statuses.map(s => (
              <button key={s.name} onClick={() => bulkSetStatus(s.name)}
                className={`text-xs px-2 py-1 rounded border font-medium whitespace-nowrap ${statusChipClass(statuses, s.name)}`}>
                {s.name}
              </button>
            ))}
            <div className="w-px h-4 bg-blue-200 dark:bg-blue-700" />
            <span className="text-xs text-blue-600 dark:text-blue-400">Assign to:</span>
            <select value="" onChange={e => { if (e.target.value) bulkAssign(e.target.value === "__none__" ? null : e.target.value); }}
              className="text-xs px-2 py-1 rounded border border-blue-200 dark:border-blue-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 cursor-pointer">
              <option value="">— Pick owner —</option>
              <option value="__none__">Unassigned</option>
              {assignableUsers.map(u => <option key={u.user_id} value={u.user_id}>{u.display_name}</option>)}
            </select>
            <div className="w-px h-4 bg-blue-200 dark:bg-blue-700" />
            <button onClick={() => bulkSetPriority(true)}
              className="text-xs px-3 py-1.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium whitespace-nowrap">
              ★ Add to priority
            </button>
            <button onClick={() => bulkSetPriority(false)}
              className="text-xs px-3 py-1.5 border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium whitespace-nowrap">
              ☆ Remove priority
            </button>
            <div className="w-px h-4 bg-blue-200 dark:bg-blue-700" />
            <button onClick={bulkDelete}
              className="text-xs px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium">
              Delete
            </button>
            <button onClick={() => setSelectedIds(new Set())}
              className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Filter button */}
        <div className="relative">
          <button
            onClick={() => setShowFilterPanel(p => !p)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
              showFilterPanel || activeFilterCount > 0
                ? "bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M7 8h10M11 12h2M13 16h-2" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 px-1.5 py-0.5 bg-blue-600 text-white text-[10px] rounded font-semibold leading-none">{activeFilterCount}</span>
            )}
          </button>

          {showFilterPanel && (
            <FilterPanel
              facets={displayFacets}
              colFilters={colFilters}
              onToggle={toggleColFilter}
              onClear={clearFilter}
              onClearAll={() => setColFilters({})}
              onClose={() => setShowFilterPanel(false)}
              statuses={statuses}
              filterStatus={filterStatus}
              onSetStatus={setFilterStatus}
              filterTier={filterTier}
              onSetTier={setFilterTier}
              filterEnriched={filterEnriched}
              onSetEnriched={setFilterEnriched}
            />
          )}
        </div>

        {/* Active filter chips */}
        {(Object.entries(colFilters) as [ColFilterKey, Set<string>][]).map(([field, vals]) =>
          [...vals].map(val => (
            <span key={`${field}:${val}`}
              className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded border border-blue-200 dark:border-blue-700">
              <span className="text-blue-500 dark:text-blue-400 font-medium capitalize">
                {field === "assigned_to" ? "owner" : field.replace("_", " ")}:
              </span>
              {/* Owner values are user ids — show the person, not the uuid. */}
              {field === "assigned_to"
                ? (val === UNASSIGNED ? "Unassigned" : assignableName(val) ?? "Unknown user")
                : val}
              <button onClick={() => toggleColFilter(field, val)} className="ml-0.5 hover:text-blue-900 dark:hover:text-blue-100">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))
        )}
        {activeFilterCount > 1 && (
          <button onClick={() => setColFilters({})} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1">
            Clear all
          </button>
        )}

        <div className="relative ml-auto">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search investors…"
            className="w-48 pl-9 pr-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        </div>
        {priorityOnly && (
          <ViewToggle mode={boardView} onChange={(m) => { setBoardView(m); setSelectedIds(new Set()); }} showGantt={false} />
        )}

        {/* Import CSV */}
        <input
          ref={importInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={handleImportFile}
        />
        <button
          onClick={() => importInputRef.current?.click()}
          disabled={importState.phase === "uploading"}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {importState.phase === "uploading" ? (
            <>
              <span className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M8 12l4-4m0 0l4 4m-4-4v8" />
              </svg>
              Import CSV
            </>
          )}
        </button>
        {/* Export CSV */}
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 12V4m0 8l-4-4m4 4l4-4" />
          </svg>
          Export CSV
        </button>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Investor
        </button>
      </div>

      {/* Import result banner */}
      {importState.phase === "done" && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-xl text-sm">
          <svg className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-green-800 dark:text-green-300 font-medium">
            Import complete — {importState.inserted} added
            {importState.updated > 0 && `, ${importState.updated} enriched`}
            {importState.skipped_duplicate > 0 && `, ${importState.skipped_duplicate} deduped`}
            . {importState.total_in_db} total investors.
          </span>
          <button onClick={() => setImportState({ phase: "idle" })}
            className="ml-auto text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      {importState.phase === "error" && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-sm">
          <svg className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <span className="text-red-800 dark:text-red-300">{importState.message}</span>
          <button onClick={() => setImportState({ phase: "idle" })}
            className="ml-auto text-red-500 hover:text-red-700">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      </>}
      </div>

      {innerTab === "settings" && (
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <InvestorSettingsTab />
        </div>
      )}

      {innerTab !== "settings" && <>

      {/* Kanban view — owns the rest of the viewport */}
      {viewMode === "kanban" && !loading && (
        <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-4 pt-3"><ClosedLostReport /></div>
        <DilutiveKanban
          rows={rows}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onPatchLocal={patchRowLocal}
          onReload={() => load(page, true)}
          onAddInCol={(stage) => setAddingForStage(stage)}
        />
        </div>
      )}

      {/* List view */}
      {viewMode === "list" && (
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-40">
            <p className="text-sm text-gray-400 dark:text-gray-500">No investors found.</p>
          </div>
        ) : (
          <InvestorTable
            rows={rows}
            selectedIds={selectedIds}
            allSelected={allSelected}
            onToggleSelectAll={toggleSelectAll}
            onToggleSelect={toggleSelect}
            editing={editing}
            onStartEdit={startEdit}
            onCommitEdit={commitEdit}
            onCancelEdit={() => setEditing(null)}
            onDelete={setDeleting}
            onOpenDetail={setDetailInv}
          />
        )}

        {/* Pagination — belongs to the table; the board loads every row at once */}
        {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()} investors
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >← Prev</button>
            {Array.from({ length: Math.min(7, Math.ceil(total / PAGE_SIZE)) }, (_, i) => {
              const totalPages = Math.ceil(total / PAGE_SIZE);
              let p: number;
              if (totalPages <= 7) {
                p = i;
              } else if (page < 4) {
                p = i;
              } else if (page > totalPages - 5) {
                p = totalPages - 7 + i;
              } else {
                p = page - 3 + i;
              }
              return (
                <button key={p} onClick={() => setPage(p)}
                  className={`w-7 h-7 text-xs rounded border font-medium transition-colors ${
                    p === page
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}>
                  {p + 1}
                </button>
              );
            })}
            <button
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage(p => p + 1)}
              className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
            >Next →</button>
          </div>
        </div>
        )}
        </div>
      )}

      </>}

      {(showAdd || addingForStage !== null) && (
        <AddInvestorModal
          // A card added straight onto the board is ours to move next.
          initialStatus={priorityOnly ? "Awaiting Us" : ""}
          // Adding from a board column drops the card straight into that stage;
          // the toolbar button files it under the board's own first stage.
          initialStage={addingForStage ?? (priorityOnly ? "Prospect" : "Lead")}
          initialPriority={priorityOnly}
          onClose={() => { setShowAdd(false); setAddingForStage(null); }}
          onSaved={() => load(page)}
        />
      )}
      {deleting && (
        <DeleteConfirm
          title={`${deleting.name ?? "Investor"}${deleting.firm ? ` @ ${deleting.firm}` : ""}`}
          onConfirm={() => doDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {detailInv && (
        <InvestorDetailPanel
          inv={detailInv}
          onClose={() => {
            setDetailInv(null);
            if (deepLinkInvestor) {
              const next = new URLSearchParams(Array.from(deepLinkParams.entries()));
              next.delete("investor");
              window.history.replaceState(null, "", `/funding?${next.toString()}`);
            }
          }}
          onSaved={() => load(page)}
          onDelete={async () => { await doDelete(detailInv); setDetailInv(null); }}
        />
      )}
    </div>
  );
}

// ── Manage Statuses Modal ──────────────────────────────────────────────────────

function ManageStatusesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const statuses = useInvestorStatuses();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>("purple");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addStatus() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError("");
    const res = await fetch("/api/proxy/dilutive/statuses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: newColor }),
    });
    setBusy(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ detail: "Failed" }));
      setError(typeof e.detail === "string" && e.detail.includes("duplicate") ? "That status already exists." : "Could not add status.");
      return;
    }
    setNewName("");
    await refreshStatuses();
    onChanged();
  }

  async function recolor(id: number, color: string) {
    await fetch(`/api/proxy/dilutive/statuses/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await refreshStatuses();
    onChanged();
  }

  async function remove(id: number, count: number) {
    const fallback = statuses.find((s) => s.id !== id)?.name ?? "";
    const target = fallback || "no status";
    if (count > 0 && !confirm(`Reassign ${count} investor(s) to "${target}" and delete this status?`)) return;
    await fetch(`/api/proxy/dilutive/statuses/${id}${fallback ? `?reassign_to=${encodeURIComponent(fallback)}` : ""}`, { method: "DELETE" });
    await refreshStatuses();
    onChanged();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Manage statuses</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-2">
          {statuses.map((s) => (
            <div key={s.id} className="flex items-center gap-2">
              <span className={`text-[11px] px-2 py-0.5 rounded font-medium flex-shrink-0 ${statusChipClass(statuses, s.name)}`}>
                {s.name}
              </span>
              <span className="text-xs text-gray-400 flex-shrink-0">{s.investor_count ?? 0}</span>
              <div className="flex items-center gap-1 ml-auto">
                {STATUS_COLOR_KEYS.map((c) => (
                  <button key={c} onClick={() => recolor(s.id, c)}
                    title={c}
                    className={`w-4 h-4 rounded-full ${STATUS_DOT_CLASSES[c]} ${s.color === c ? "ring-2 ring-offset-1 ring-gray-400 dark:ring-offset-gray-900" : ""}`} />
                ))}
                <button onClick={() => remove(s.id, s.investor_count ?? 0)}
                  className="ml-1 p-1 text-gray-400 hover:text-red-500" title="Delete status">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-800 space-y-2">
          <div className="flex items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addStatus(); }}
              placeholder="New status name…"
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            <button onClick={addStatus} disabled={busy || !newName.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40">
              Add
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">Color:</span>
            {STATUS_COLOR_KEYS.map((c) => (
              <button key={c} onClick={() => setNewColor(c)}
                className={`w-5 h-5 rounded-full ${STATUS_DOT_CLASSES[c]} ${newColor === c ? "ring-2 ring-offset-1 ring-gray-400 dark:ring-offset-gray-900" : ""}`} />
            ))}
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function ManageInvestorTypesModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const types = useInvestorTypes();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addType() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError("");
    const res = await fetch("/api/proxy/dilutive/investor-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ detail: "Failed" }));
      setError(typeof e.detail === "string" && e.detail.includes("duplicate") ? "That type already exists." : "Could not add type.");
      return;
    }
    setNewName("");
    await refreshInvestorTypes();
    onChanged();
  }

  async function recolor(id: number, color: string) {
    await fetch(`/api/proxy/dilutive/investor-types/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await refreshInvestorTypes();
    onChanged();
  }

  async function remove(id: number, count: number) {
    if (count > 0 && !confirm(`Clear the type on ${count} investor(s) and delete this type?`)) return;
    await fetch(`/api/proxy/dilutive/investor-types/${id}`, { method: "DELETE" });
    await refreshInvestorTypes();
    onChanged();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Manage types</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-2">
          {types.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <span className={`text-[11px] px-2 py-0.5 rounded font-medium flex-shrink-0 ${investorTypeChipClass(types, t.name)}`}>
                {t.name}
              </span>
              <span className="text-xs text-gray-400 flex-shrink-0">{t.investor_count ?? 0}</span>
              <div className="flex items-center gap-1 ml-auto">
                {STATUS_COLOR_KEYS.map((c) => (
                  <button key={c} onClick={() => recolor(t.id, c)}
                    title={c}
                    className={`w-4 h-4 rounded-full ${STATUS_DOT_CLASSES[c]} ${t.color === c ? "ring-2 ring-offset-1 ring-gray-400 dark:ring-offset-gray-900" : ""}`} />
                ))}
                <button onClick={() => remove(t.id, t.investor_count ?? 0)}
                  className="ml-1 p-1 text-gray-400 hover:text-red-500" title="Delete type">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-800 space-y-2">
          <div className="flex items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addType(); }}
              placeholder="New type name…"
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            <button onClick={addType} disabled={busy || !newName.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40">
              Add
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function ManageOptionListModal({
  title, endpoint, useOptions, refresh, onClose, onChanged,
}: {
  title: string;
  endpoint: string;
  useOptions: () => NamedColorOption[];
  refresh: () => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const options = useOptions();
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError("");
    const res = await fetch(`/api/proxy/dilutive/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ detail: "Failed" }));
      setError(typeof e.detail === "string" && e.detail.includes("duplicate") ? "That option already exists." : "Could not add option.");
      return;
    }
    setNewName("");
    await refresh();
    onChanged();
  }

  async function recolor(id: number, color: string) {
    await fetch(`/api/proxy/dilutive/${endpoint}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await refresh();
    onChanged();
  }

  async function remove(id: number, count: number) {
    if (count > 0 && !confirm(`Remove this value from ${count} investor(s) and delete this option?`)) return;
    await fetch(`/api/proxy/dilutive/${endpoint}/${id}`, { method: "DELETE" });
    await refresh();
    onChanged();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-2">
          {options.map((o) => (
            <div key={o.id} className="flex items-center gap-2">
              <span className={`text-[11px] px-2 py-0.5 rounded font-medium flex-shrink-0 ${optionChipClass(options, o.name)}`}>
                {o.name}
              </span>
              <span className="text-xs text-gray-400 flex-shrink-0">{o.investor_count ?? 0}</span>
              <div className="flex items-center gap-1 ml-auto">
                {STATUS_COLOR_KEYS.map((c) => (
                  <button key={c} onClick={() => recolor(o.id, c)}
                    title={c}
                    className={`w-4 h-4 rounded-full ${STATUS_DOT_CLASSES[c]} ${o.color === c ? "ring-2 ring-offset-1 ring-gray-400 dark:ring-offset-gray-900" : ""}`} />
                ))}
                <button onClick={() => remove(o.id, o.investor_count ?? 0)}
                  className="ml-1 p-1 text-gray-400 hover:text-red-500" title="Delete option">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-100 dark:border-gray-800 space-y-2">
          <div className="flex items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              placeholder="New option name…"
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            <button onClick={add} disabled={busy || !newName.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40">
              Add
            </button>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Fundraising Plan Tab ──────────────────────────────────────────────────────

// FP&A model funding entry shape (mirrors FundingEntry in fpa/page.tsx)
interface FpaFundingEntry {
  id: string;
  name: string;
  type: "equity" | "safe" | "convertible_note" | "grant" | "sbir" | "loan";
  pre_money_valuation: number;
  dilution_pct: number;
  date: string;
  amount: number;
  disbursement: "lump_sum" | "monthly";
  start_date: string;
  end_date: string;
  monthly_amount: number;
  annual_increase_pct: number;
  notes: string;
}

// Plan-only metadata stored in funding_plan (per FP&A entry id)
interface TrancheMeta {
  milestone: string;
  color: string;
  status: "planned" | "active" | "closed";
  plan_notes: string;
}

// What we persist in funding_plan table
interface FundraisePlanStore {
  meta: Record<string, TrancheMeta>;
  strategic_notes: string;
  show_grant_overlay: boolean;
}

// Display tranche (union of FP&A financial data + plan metadata)
interface FundraiseTranche {
  id: string;
  name: string;
  type: "dilutive" | "non-dilutive";
  fpa_type: FpaFundingEntry["type"];
  amount_k: number;
  valuation_k: number;
  target_month: string;
  disbursement: "lump_sum" | "monthly";
  monthly_amount: number;
  // plan-only
  milestone: string;
  plan_notes: string;
  color: string;
  status: "planned" | "active" | "closed";
}

interface FundraisePlan {
  tranches: FundraiseTranche[];
  strategic_notes: string;
  show_grant_overlay: boolean;
}

const PLAN_COLORS = ["#6366f1","#3b82f6","#8b5cf6","#10b981","#f59e0b","#ec4899","#14b8a6","#f97316"];

const FPA_DILUTIVE = ["equity", "safe", "convertible_note"];

const FPA_TYPE_LABELS: Record<FpaFundingEntry["type"], string> = {
  equity: "Equity", safe: "SAFE", convertible_note: "Conv. Note",
  grant: "Grant", sbir: "SBIR/STTR", loan: "Loan",
};

function entryToTranche(e: FpaFundingEntry, meta: TrancheMeta | undefined, idx: number): FundraiseTranche {
  const isDilutive = FPA_DILUTIVE.includes(e.type);
  const amountK = e.disbursement === "monthly"
    ? Math.round((e.monthly_amount || 0) * 12 / 1000)
    : Math.round((e.amount || 0) / 1000);
  const targetMonth = e.disbursement === "monthly"
    ? (e.start_date || "").slice(0, 7)
    : (e.date || "").slice(0, 7);
  return {
    id: e.id,
    name: e.name || FPA_TYPE_LABELS[e.type],
    type: isDilutive ? "dilutive" : "non-dilutive",
    fpa_type: e.type,
    amount_k: amountK,
    valuation_k: isDilutive ? Math.round((e.pre_money_valuation || 0) / 1000) : 0,
    target_month: targetMonth || dateToMonth(new Date()),
    disbursement: e.disbursement || "lump_sum",
    monthly_amount: e.monthly_amount || 0,
    milestone: meta?.milestone ?? "",
    plan_notes: meta?.plan_notes ?? (e.notes || ""),
    color: meta?.color ?? PLAN_COLORS[idx % PLAN_COLORS.length],
    status: meta?.status ?? "planned",
  };
}

// Map a funding opportunity to a minimal FpaFundingEntry for import
function oppToFpaEntry(opp: Opportunity): FpaFundingEntry {
  // amount is NUMERIC since 126_funding_amount — no more stripping non-digits
  // out of '$50K - $1M' and hoping the survivor meant something.
  const rawAmt = Number(opp.amount) || 0;
  // Was sniffed out of the funding_type free text ("equity"/"vc"/"safe"); the
  // dilution column answers it outright now. Unset reads as non-dilutive, which
  // is what the string test did too when it matched nothing.
  const isDilutive = opp.dilution === "dilutive";
  return {
    id: crypto.randomUUID(),
    name: opp.title,
    type: isDilutive ? "equity" : "grant",
    pre_money_valuation: 0,
    dilution_pct: 0,
    date: opp.decision_date || opp.funding_dispersion || opp.deadline || "",
    amount: rawAmt,
    disbursement: "lump_sum",
    start_date: "",
    end_date: "",
    monthly_amount: 0,
    annual_increase_pct: 0,
    // The FP&A entry takes the most recent note; the full log stays on the
    // opportunity rather than being flattened into a forecast row.
    notes: [opp.latest_note, opp.amount_notes].filter(Boolean).join(" — "),
  };
}

function monthToDate(m: string): Date { const [y, mo] = m.split("-").map(Number); return new Date(y, mo - 1, 1); }
function dateToMonth(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function fmtMonth(m: string): string { const d = monthToDate(m); return d.toLocaleDateString("en-US", { month: "short", year: "numeric" }); }
function fmtK(k: number): string {
  const v = Math.round(k * 1000);
  if (Math.abs(v) >= 1_000_000) return `${v < 0 ? "-$" : "$"}${(Math.abs(v) / 1_000_000).toFixed(1)}M`;
  return `${v < 0 ? "-$" : "$"}${Math.abs(v).toLocaleString()}`;
}

function FundraisePlanTab() {
  const [fpaEntries, setFpaEntries] = useState<FpaFundingEntry[]>([]);
  const [planStore, setPlanStore] = useState<FundraisePlanStore>({ meta: {}, strategic_notes: "", show_grant_overlay: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<FpaFundingEntry | null>(null);
  const [metaDraft, setMetaDraft] = useState<TrancheMeta | null>(null);
  const [grantRows, setGrantRows] = useState<Opportunity[]>([]);
  const [showOppPicker, setShowOppPicker] = useState(false);
  const [allOpps, setAllOpps] = useState<Opportunity[]>([]);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [monthlyData, setMonthlyData] = useState<Array<{ year: number; month: number; ebitda: number }>>([]);
  const [chartViewStart, setChartViewStart] = useState<number | null>(null);
  const [chartViewEnd, setChartViewEnd] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/proxy/fpa/model").then(r => r.ok ? r.json() : null),
      fetch("/api/proxy/funding/plan").then(r => r.ok ? r.json() : null),
      fetch("/api/proxy/funding").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/fpa/model/monthly").then(r => r.ok ? r.json() : []),
    ]).then(([fpaModel, planData, opps, monthly]) => {
      setFpaEntries((fpaModel?.funding_schedule || []) as FpaFundingEntry[]);
      if (planData && planData.meta) {
        setPlanStore(planData as FundraisePlanStore);
      } else if (planData && planData.tranches) {
        const meta: Record<string, TrancheMeta> = {};
        for (const t of planData.tranches) {
          meta[t.id] = { milestone: t.milestone || "", color: t.color || PLAN_COLORS[0], status: t.status || "planned", plan_notes: t.notes || "" };
        }
        setPlanStore({ meta, strategic_notes: planData.strategic_notes || "", show_grant_overlay: planData.show_grant_overlay ?? true });
      }
      setGrantRows((opps as Opportunity[]).filter(o => o.deadline));
      setAllOpps(opps as Opportunity[]);
      setMonthlyData((monthly as Array<{ year: number; month: number; ebitda: number }>) || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function savePlanMeta(updated: FundraisePlanStore) {
    setSaving(true);
    try {
      await fetch("/api/proxy/funding/plan", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
    } finally { setSaving(false); }
  }

  async function saveFpaEntries(entries: FpaFundingEntry[], msg = "Saved to FP&A model") {
    setSaving(true);
    try {
      const r = await fetch("/api/proxy/fpa/model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funding_schedule: entries }),
      });
      if (r.ok) { setFpaEntries(entries); showSync(msg); }
    } finally { setSaving(false); }
  }

  function showSync(msg: string) {
    setSyncMsg(msg);
    setTimeout(() => setSyncMsg(null), 3000);
  }

  function updateMeta(id: string, patch: Partial<TrancheMeta>) {
    const updated = { ...planStore, meta: { ...planStore.meta, [id]: { ...(planStore.meta[id] || { milestone: "", color: PLAN_COLORS[0], status: "planned" as const, plan_notes: "" }), ...patch } } };
    setPlanStore(updated);
    savePlanMeta(updated);
  }

  function updateFpaEntry(id: string, patch: Partial<FpaFundingEntry>) {
    const updated = fpaEntries.map(e => e.id === id ? { ...e, ...patch } : e);
    saveFpaEntries(updated, "FP&A model updated");
  }

  function flushDraft() {
    if (editDraft && editId) {
      const updated = fpaEntries.map(e => e.id === editId ? editDraft : e);
      saveFpaEntries(updated, "FP&A model updated");
    }
    if (metaDraft && editId) {
      updateMeta(editId, metaDraft);
    }
  }

  function openEdit(id: string, fpaEntry: FpaFundingEntry) {
    if (editId && editId !== id) flushDraft();
    setEditId(id);
    setEditDraft({ ...fpaEntry });
    setMetaDraft({ ...(planStore.meta[id] || { milestone: "", color: PLAN_COLORS[0], status: "planned" as const, plan_notes: "" }) });
  }

  function closeEdit() {
    flushDraft();
    setEditId(null);
    setEditDraft(null);
    setMetaDraft(null);
  }

  function removeFpaEntry(id: string) {
    saveFpaEntries(fpaEntries.filter(e => e.id !== id), "Entry removed from FP&A model");
    const updatedMeta = { ...planStore.meta };
    delete updatedMeta[id];
    const updated = { ...planStore, meta: updatedMeta };
    setPlanStore(updated);
    savePlanMeta(updated);
  }

  function addNewEntry() {
    const newE: FpaFundingEntry = {
      id: crypto.randomUUID(), name: "New Round", type: "equity",
      pre_money_valuation: 0, dilution_pct: 0,
      date: dateToMonth(new Date()) + "-01", amount: 100000,
      disbursement: "lump_sum", start_date: "", end_date: "",
      monthly_amount: 0, annual_increase_pct: 0, notes: "",
    };
    const updated = [...fpaEntries, newE];
    saveFpaEntries(updated, "New entry added to FP&A model");
    setEditId(newE.id);
  }

  async function importOpportunity(opp: Opportunity) {
    const entry = oppToFpaEntry(opp);
    const updated = [...fpaEntries, entry];
    await saveFpaEntries(updated, `"${opp.title}" added to FP&A model`);
    setShowOppPicker(false);
  }

  if (loading) return <div className="flex items-center justify-center h-40"><p className="text-sm text-gray-400">Loading…</p></div>;

  const tranches = fpaEntries.map((e, i) => entryToTranche(e, planStore.meta[e.id], i));

  const sorted = [...tranches].sort((a, b) => a.target_month.localeCompare(b.target_month));
  const totalDilutive = sorted.filter(t => t.type === "dilutive").reduce((s, t) => s + t.amount_k, 0);
  const totalNonDil = sorted.filter(t => t.type === "non-dilutive").reduce((s, t) => s + t.amount_k, 0);
  const totalRaised = totalDilutive + totalNonDil;

  // Cumulative amounts for chart Y axis (raised capital step line)
  let runningTotal = 0;
  const sortedWithCumul = sorted.map(t => {
    runningTotal += t.amount_k;
    return { ...t, cumul_k: runningTotal };
  });

  // Cash balance series: ebitda (includes grants/revenue) + non-P&L inflows (equity + loans)
  const nonPnlInflows: Record<string, number> = {};
  for (const e of fpaEntries) {
    const isDilutive = ["equity", "safe", "convertible_note"].includes(e.type);
    const isLoan = e.type === "loan";
    if (!isDilutive && !isLoan) continue; // grants/SBIRs already in ebitda via grant_revenue
    if (e.disbursement === "monthly" && e.start_date && (e.monthly_amount || 0) > 0) {
      const s = new Date(e.start_date);
      const end = e.end_date ? new Date(e.end_date) : new Date(s.getFullYear() + 10, 11, 31);
      let c = new Date(s.getFullYear(), s.getMonth(), 1);
      while (c <= end) {
        const key = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}`;
        nonPnlInflows[key] = (nonPnlInflows[key] || 0) + (e.monthly_amount || 0) / 1000;
        c = new Date(c.getFullYear(), c.getMonth() + 1, 1);
      }
    } else if (e.date) {
      const key = e.date.slice(0, 7);
      nonPnlInflows[key] = (nonPnlInflows[key] || 0) + (e.amount || 0) / 1000;
    }
  }
  let cashBal = 0;
  const cashSeries = [...monthlyData]
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
    .map(md => {
      const key = `${md.year}-${String(md.month).padStart(2, "0")}`;
      cashBal += (md.ebitda || 0) / 1000 + (nonPnlInflows[key] || 0);
      return { month: key, cash_k: Math.round(cashBal * 10) / 10 };
    });

  // Chart dimensions
  const SVG_W = 900; const SVG_H = 280;
  const PAD_L = 64; const PAD_R = 32; const PAD_T = 24; const PAD_B = 48;
  const chartW = SVG_W - PAD_L - PAD_R;
  const chartH = SVG_H - PAD_T - PAD_B;

  // X axis: cover both tranches and full model range
  const trancheMonths = sorted.map(t => t.target_month);
  const mdMonths = monthlyData.map(md => `${md.year}-${String(md.month).padStart(2, "0")}`);
  const allDates = [...trancheMonths, ...mdMonths].filter(Boolean);
  const dataStartMonth = allDates.length ? allDates.reduce((a, b) => a < b ? a : b) : dateToMonth(new Date());
  const dataEndMonth   = allDates.length ? allDates.reduce((a, b) => a > b ? a : b) : dateToMonth(new Date(Date.now() + 365 * 86400000));
  const dataStartDate  = new Date(monthToDate(dataStartMonth).getTime() - 30 * 86400000);
  const dataEndDate    = new Date(monthToDate(dataEndMonth).getTime() + 60 * 86400000);

  // All years in data
  const today = new Date();
  const allDataYears = Array.from(new Set(allDates.map(m => parseInt(m.slice(0, 4))))).sort();

  // Apply chart view window (null = use data bounds)
  const startDate = chartViewStart ? new Date(chartViewStart, 0, 1) : dataStartDate;
  const endDate   = chartViewEnd   ? new Date(chartViewEnd,   11, 31) : dataEndDate;
  const totalMs   = Math.max(1, endDate.getTime() - startDate.getTime());

  const visibleYears = allDataYears.filter(y => y >= startDate.getFullYear() && y <= endDate.getFullYear());

  function xOf(month: string): number {
    const ms = monthToDate(month).getTime() - startDate.getTime();
    return PAD_L + (ms / totalMs) * chartW;
  }

  // Y axis: span raised capital AND cash balance (which can go negative)
  const cashMin = cashSeries.length ? Math.min(...cashSeries.map(c => c.cash_k)) : 0;
  const cashMax = cashSeries.length ? Math.max(...cashSeries.map(c => c.cash_k)) : 0;
  const minY = Math.min(0, cashMin) * 1.1;
  const maxY = Math.max(totalRaised, cashMax, 500) * 1.15;
  const yRange = maxY - minY;

  function yOf(val_k: number): number {
    return PAD_T + chartH - ((val_k - minY) / yRange) * chartH;
  }

  // Generate month tick marks
  const ticks: { month: string; x: number }[] = [];
  let cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cur <= endDate) {
    const m = dateToMonth(cur);
    const x = xOf(m);
    if (x >= PAD_L && x <= PAD_L + chartW) ticks.push({ month: m, x });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  // Step-up cumulative raised line
  const stepPath = sortedWithCumul.length > 0 ? (() => {
    let path = `M ${PAD_L},${yOf(0)}`;
    let prevCumul = 0;
    for (const t of sortedWithCumul) {
      const x = xOf(t.target_month);
      path += ` L ${x},${yOf(prevCumul)} L ${x},${yOf(t.cumul_k)}`;
      prevCumul = t.cumul_k;
    }
    path += ` L ${PAD_L + chartW},${yOf(prevCumul)}`;
    return path;
  })() : "";

  // Y axis ticks
  const yStep = yRange <= 2000 ? 500 : yRange <= 5000 ? 1000 : yRange <= 10000 ? 2000 : 5000;
  const yTicks: number[] = [];
  for (let v = Math.ceil(minY / yStep) * yStep; v <= maxY; v += yStep) yTicks.push(v);

  const inputCls = "w-full text-xs border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500/40";

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Dilutive Target", value: fmtK(totalDilutive), sub: `${sorted.filter(t=>t.type==="dilutive").length} rounds` },
          { label: "Non-Dilutive Target", value: fmtK(totalNonDil || 0), sub: "Grants & competitions" },
          { label: "Total Capital Target", value: fmtK(totalRaised), sub: "All sources combined" },
        ].map(s => (
          <div key={s.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <p className="text-[11px] text-gray-400 dark:text-gray-500 uppercase tracking-wide">{s.label}</p>
            <p className="text-xl font-bold text-gray-900 dark:text-gray-50 mt-1">{s.value}</p>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Fundraising Timeline & Cash Position</h3>
          <div className="flex items-center gap-4 text-[11px] text-gray-500">
            <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-indigo-500 opacity-60" style={{ display: "inline-block" }} /> Capital raised</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-emerald-500" style={{ display: "inline-block" }} /> Cash balance</span>
          </div>
        </div>

        {/* Range controls — matches FP&A model view controls */}
        <div className="flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 mb-3">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">View period:</span>
          <div className="flex items-center gap-2">
            <StyledSelect
              value={chartViewStart ?? startDate.getFullYear()}
              onChange={e => setChartViewStart(Number(e.target.value))}
              className="text-xs pl-2 pr-6 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              {allDataYears.filter(y => y <= (chartViewEnd ?? endDate.getFullYear())).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </StyledSelect>
            <span className="text-xs text-gray-400">→</span>
            <StyledSelect
              value={chartViewEnd ?? endDate.getFullYear()}
              onChange={e => setChartViewEnd(Number(e.target.value))}
              className="text-xs pl-2 pr-6 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              {allDataYears.filter(y => y >= (chartViewStart ?? startDate.getFullYear())).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </StyledSelect>
          </div>
          <span className="text-xs text-gray-400">({visibleYears.length} yr{visibleYears.length !== 1 ? "s" : ""})</span>
          <div className="flex gap-1 ml-auto">
            {[
              { label: "1Y",  s: today.getFullYear(), e: today.getFullYear() },
              { label: "2Y",  s: today.getFullYear(), e: today.getFullYear() + 1 },
              { label: "5Y",  s: today.getFullYear(), e: today.getFullYear() + 4 },
              { label: "10Y", s: today.getFullYear(), e: today.getFullYear() + 9 },
              { label: "All", s: null as number | null, e: null as number | null },
            ].map(p => {
              const active = p.s === null
                ? chartViewStart === null && chartViewEnd === null
                : chartViewStart === p.s && chartViewEnd === p.e;
              return (
                <button key={p.label} onClick={() => { setChartViewStart(p.s); setChartViewEnd(p.e); }}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${active ? "border-blue-400 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-blue-500 hover:border-blue-400"}`}>
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="w-full overflow-x-auto">
          <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" style={{ minWidth: 600 }}>
            {/* Y gridlines + labels */}
            {yTicks.map(v => (
              <g key={v}>
                <line x1={PAD_L} x2={PAD_L + chartW} y1={yOf(v)} y2={yOf(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.2 : 0.06} strokeWidth={v === 0 ? 1 : 1} />
                <text x={PAD_L - 6} y={yOf(v) + 4} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={v === 0 ? 0.6 : 0.4}>
                  {fmtK(v)}
                </text>
              </g>
            ))}

            {/* X axis ticks */}
            {ticks.map(({ month, x }) => {
              const d = monthToDate(month);
              const isJan = d.getMonth() === 0;
              const label = d.toLocaleDateString("en-US", { month: "short" });
              return (
                <g key={month}>
                  <line x1={x} x2={x} y1={PAD_T} y2={PAD_T + chartH + 4} stroke="currentColor" strokeOpacity={isJan ? 0.15 : 0.05} strokeWidth={isJan ? 1 : 0.5} />
                  <text x={x} y={PAD_T + chartH + 16} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.5}>{label}</text>
                  {isJan && <text x={x} y={PAD_T + chartH + 28} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.7} fontWeight="600">{d.getFullYear()}</text>}
                </g>
              );
            })}

            {/* Step-up cumulative raised area fill */}
            {stepPath && (
              <path d={`${stepPath} L ${PAD_L + chartW},${yOf(0)} L ${PAD_L},${yOf(0)} Z`}
                fill="#6366f1" fillOpacity={0.07} />
            )}

            {/* Step-up cumulative raised line */}
            {stepPath && (
              <path d={stepPath} fill="none" stroke="#6366f1" strokeWidth={2} strokeOpacity={0.5} />
            )}

            {/* Cash balance area (above zero green, below zero red) */}
            {cashSeries.length > 1 && (() => {
              const pts = cashSeries.filter(c => {
                const x = xOf(c.month);
                return x >= PAD_L && x <= PAD_L + chartW;
              });
              if (pts.length < 2) return null;
              const linePts = pts.map(c => `${xOf(c.month)},${yOf(c.cash_k)}`).join(" L ");
              const zeroY = yOf(0);
              return (
                <g>
                  <path d={`M ${xOf(pts[0].month)},${zeroY} L ${linePts} L ${xOf(pts[pts.length-1].month)},${zeroY} Z`}
                    fill="#10b981" fillOpacity={0.08} />
                  <path d={`M ${linePts}`} fill="none" stroke="#10b981" strokeWidth={2} strokeOpacity={0.9} />
                </g>
              );
            })()}

            {/* Today line */}
            {(() => {
              const todayX = xOf(dateToMonth(new Date()));
              return todayX >= PAD_L && todayX <= PAD_L + chartW ? (
                <g>
                  <line x1={todayX} x2={todayX} y1={PAD_T} y2={PAD_T + chartH} stroke="#3b82f6" strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="4 2" />
                  <text x={todayX + 3} y={PAD_T + 12} fontSize={9} fill="#3b82f6" fillOpacity={0.7}>Today</text>
                </g>
              ) : null;
            })()}

            {/* Raise markers */}
            {sortedWithCumul.map(t => {
              const x = xOf(t.target_month);
              const y = yOf(t.cumul_k);
              if (x < PAD_L || x > PAD_L + chartW) return null;
              return (
                <g key={t.id} style={{ cursor: "pointer" }} onClick={() => { const e = fpaEntries.find(f => f.id === t.id); if (e) openEdit(t.id, e); }}>
                  {t.status === "active" && <circle cx={x} cy={y} r={7} fill={t.color} fillOpacity={0.2} />}
                  <circle cx={x} cy={y} r={4} fill={t.color} />
                  <text x={x} y={y + 20} textAnchor="middle" fontSize={9} fill={t.color} fontWeight="700">+{fmtK(t.amount_k)}</text>
                  <text x={x} y={y - 12} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.8} fontWeight="600">
                    {t.name.length > 16 ? t.name.slice(0, 15) + "…" : t.name}
                  </text>
                </g>
              );
            })}

            {/* Cash balance dots at key raise events */}
            {sortedWithCumul.map(t => {
              const x = xOf(t.target_month);
              if (x < PAD_L || x > PAD_L + chartW) return null;
              const cashAtMonth = cashSeries.find(c => c.month === t.target_month);
              if (!cashAtMonth) return null;
              const y = yOf(cashAtMonth.cash_k);
              return (
                <g key={`cash-${t.id}`}>
                  <circle cx={x} cy={y} r={3} fill="#10b981" />
                  <text x={x} y={y - 8} textAnchor="middle" fontSize={8} fill="#10b981" fillOpacity={0.85} fontWeight="600">
                    {fmtK(cashAtMonth.cash_k)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <p className="text-[10px] text-gray-400 mt-2 text-center">
          Purple step = cumulative capital raised · Green line = cash balance (P&L + equity + loans) · Click a marker to edit
        </p>
      </div>

      {/* Sync status banner */}
      {syncMsg && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-lg text-xs text-green-700 dark:text-green-300">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
          {syncMsg}
        </div>
      )}

      {/* Opportunity import modal */}
      {showOppPicker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowOppPicker(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-xl w-full max-w-lg max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Import Funding Opportunity to FP&A Model</h3>
              <button onClick={() => setShowOppPicker(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 divide-y divide-gray-50 dark:divide-gray-800">
              {allOpps.length === 0 && <p className="text-sm text-gray-400 p-4 text-center">No opportunities found</p>}
              {allOpps.map(opp => (
                <div key={opp.opportunity_id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{opp.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STAGE_STYLES[opp.stage] || ""}`}>{opp.stage}</span>
                      {opp.amount !== null && opp.amount !== undefined && (
                        <span className="text-xs text-gray-500 tabular-nums">{fmtAward(opp.amount, opp.amount_currency)}</span>
                      )}
                      <FundingTypeChip value={opp.funding_type} />
                    </div>
                  </div>
                  <button onClick={() => importOpportunity(opp)}
                    className="flex-shrink-0 text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">
                    Add to Model
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Funding entries (synced with FP&A) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Funding Entries</h3>
            <p className="text-xs text-gray-400 mt-0.5">Financial data synced with FP&A model · Plan metadata saved here</p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <span className="text-xs text-gray-400">Saving…</span>}
            <button onClick={() => setShowOppPicker(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              Import Opportunity
            </button>
            <button onClick={addNewEntry}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              New Entry
            </button>
          </div>
        </div>

        {sorted.length === 0 && (
          <div className="text-center py-10 text-sm text-gray-400 bg-white dark:bg-gray-900 rounded-xl border border-dashed border-gray-200 dark:border-gray-700">
            No funding entries in FP&A model. Add one above or import from Opportunities.
          </div>
        )}

        {sorted.map(t => {
          const isEditing = editId === t.id;
          const fpaEntry = fpaEntries.find(e => e.id === t.id);
          return (
            <div key={t.id} className={`rounded-xl border bg-white dark:bg-gray-900 overflow-hidden transition-all ${isEditing ? "border-blue-400 dark:border-blue-600 shadow-md" : "border-gray-200 dark:border-gray-700"}`}>
              <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => { if (isEditing) { closeEdit(); } else if (fpaEntry) { openEdit(t.id, fpaEntry); } }}>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: t.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t.name}</p>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono">{FPA_TYPE_LABELS[t.fpa_type]}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      t.status === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      : t.status === "closed" ? "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                      : "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                    }`}>{t.status}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                    <span className="text-xs text-gray-500">{fmtMonth(t.target_month)}</span>
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{fmtK(t.amount_k)}</span>
                    {t.type === "dilutive" && t.valuation_k > 0 && <span className="text-xs text-gray-500">@ {fmtK(t.valuation_k)} pre-money</span>}
                    {t.milestone && <span className="text-xs text-gray-400 italic truncate">{t.milestone}</span>}
                  </div>
                </div>
                <svg className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isEditing ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
              </div>

              {isEditing && fpaEntry && editDraft && metaDraft && (
                <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-4 space-y-4 bg-gray-50/50 dark:bg-gray-800/20">
                  {/* FP&A financial fields */}
                  <p className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wide">Financial Data → synced to FP&A model</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Name</label>
                      <input className={inputCls} value={editDraft.name}
                        onChange={e => setEditDraft(d => d ? { ...d, name: e.target.value } : d)}
                        onBlur={() => editDraft && saveFpaEntries(fpaEntries.map(e => e.id === t.id ? editDraft : e), "FP&A model updated")} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Type</label>
                      <StyledSelect className={inputCls} value={editDraft.type} onChange={e => {
                        const updated = { ...editDraft, type: e.target.value as FpaFundingEntry["type"] };
                        setEditDraft(updated);
                        saveFpaEntries(fpaEntries.map(f => f.id === t.id ? updated : f), "FP&A model updated");
                      }}>
                        <option value="equity">Equity</option>
                        <option value="safe">SAFE</option>
                        <option value="convertible_note">Conv. Note</option>
                        <option value="grant">Grant</option>
                        <option value="sbir">SBIR/STTR</option>
                        <option value="loan">Loan</option>
                      </StyledSelect>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Amount ($)</label>
                      <input type="number" className={inputCls} value={editDraft.amount}
                        onChange={e => setEditDraft(d => d ? { ...d, amount: +e.target.value } : d)}
                        onBlur={() => editDraft && saveFpaEntries(fpaEntries.map(e => e.id === t.id ? editDraft : e), "FP&A model updated")} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Date</label>
                      <input type="date" className={inputCls} value={editDraft.date || editDraft.start_date} onChange={e => {
                        const patch = FPA_DILUTIVE.includes(editDraft.type) ? { date: e.target.value } : { start_date: e.target.value };
                        const updated = { ...editDraft, ...patch };
                        setEditDraft(updated);
                        saveFpaEntries(fpaEntries.map(f => f.id === t.id ? updated : f), "FP&A model updated");
                      }} />
                    </div>
                    {FPA_DILUTIVE.includes(editDraft.type) && (
                      <div>
                        <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Pre-Money Val ($)</label>
                        <input type="number" className={inputCls} value={editDraft.pre_money_valuation}
                          onChange={e => setEditDraft(d => d ? { ...d, pre_money_valuation: +e.target.value } : d)}
                          onBlur={() => editDraft && saveFpaEntries(fpaEntries.map(e => e.id === t.id ? editDraft : e), "FP&A model updated")} />
                      </div>
                    )}
                  </div>

                  {/* Plan-only fields */}
                  <p className="text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wide">Plan Metadata → saved here only</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Status</label>
                      <StyledSelect className={inputCls} value={metaDraft.status} onChange={e => {
                        const updated = { ...metaDraft, status: e.target.value as TrancheMeta["status"] };
                        setMetaDraft(updated);
                        updateMeta(t.id, updated);
                      }}>
                        <option value="planned">Planned</option>
                        <option value="active">Active</option>
                        <option value="closed">Closed</option>
                      </StyledSelect>
                    </div>
                    <div>
                      <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Color</label>
                      <div className="flex gap-1.5 mt-1">
                        {PLAN_COLORS.map(c => (
                          <button key={c} onClick={() => { setMetaDraft(d => d ? { ...d, color: c } : d); updateMeta(t.id, { color: c }); }}
                            className={`w-5 h-5 rounded-full transition-transform ${metaDraft.color === c ? "ring-2 ring-offset-1 ring-gray-400 scale-110" : ""}`}
                            style={{ background: c }} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Milestone Trigger</label>
                    <input className={inputCls} value={metaDraft.milestone}
                      onChange={e => setMetaDraft(d => d ? { ...d, milestone: e.target.value } : d)}
                      onBlur={() => metaDraft && updateMeta(t.id, metaDraft)}
                      placeholder="What needs to happen before this raise…" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 uppercase tracking-wide mb-1">Plan Notes</label>
                    <AutoTextarea className={inputCls} rows={2} value={metaDraft.plan_notes}
                      onChange={e => setMetaDraft(d => d ? { ...d, plan_notes: e.target.value } : d)}
                      onBlur={() => metaDraft && updateMeta(t.id, metaDraft)} />
                  </div>
                  <button onClick={() => { removeFpaEntry(t.id); setEditId(null); setEditDraft(null); setMetaDraft(null); }}
                    className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 font-medium">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    Remove from FP&A Model
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Strategic notes */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Strategic Notes</h3>
        <AutoTextarea
          className="w-full text-sm text-gray-700 dark:text-gray-300 bg-transparent border-0 outline-none resize-none leading-relaxed"
          rows={3}
          value={planStore.strategic_notes}
          onChange={e => setPlanStore(p => ({ ...p, strategic_notes: e.target.value }))}
          onBlur={() => savePlanMeta(planStore)}
          placeholder="Strategic context, investor interest, partnership notes…"
        />
      </div>
    </div>
  );
}

// ── Management Tab (Cap Table) ────────────────────────────────────────────────

interface CapRound {
  round_id: string;
  name: string;
  round_type: string;
  status: string;
  close_date: string | null;
  pre_money_val: string | null;
  amount_raised: string | null;
  share_price: string | null;
  new_shares_issued: number | null;
  lead_investor: string | null;
  safe_cap: string | null;
  discount_pct: string | null;
  interest_rate_pct: string | null;
  maturity_date: string | null;
  mfn: boolean;
  pro_rata_rights: boolean;
  board_seat: boolean;
  notes: string | null;
  sort_order: number;
  security_count: number;
  document_count: number;
  total_invested: string;
}

interface CapHolder {
  holder_id: string;
  name: string;
  holder_type: string;
  email: string | null;
  entity_name: string | null;
  notes: string | null;
  sort_order: number;
  security_count: number;
  document_count: number;
  total_shares: string;
  total_invested: string;
}

interface CapSecurity {
  security_id: string;
  holder_id: string;
  holder_name: string;
  holder_type: string;
  round_id: string | null;
  round_name: string | null;
  round_type: string | null;
  security_type: string;
  share_class: string | null;
  shares: number | null;
  investment_amount: string | null;
  price_per_share: string | null;
  grant_date: string | null;
  vesting_schedule: string | null;
  cliff_months: number | null;
  fully_vested_date: string | null;
  safe_cap: string | null;
  discount_pct: string | null;
  notes: string | null;
}

interface CapDocument {
  document_id: string;
  holder_id: string | null;
  holder_name: string | null;
  round_id: string | null;
  round_name: string | null;
  doc_type: string;
  name: string;
  url: string | null;
  drive_file_id: string | null;
  signed_date: string | null;
  notes: string | null;
  stored_name: string | null;
  mime_type: string | null;
  file_size: number | null;
}

const ROUND_TYPES = ["angel", "safe", "convertible_note", "priced", "option_pool", "founders", "warrant"];
const ROUND_STATUSES = ["planned", "open", "closed"];
const HOLDER_TYPES = ["founder", "investor", "advisor", "employee", "option_pool"];
const SECURITY_TYPES = ["common", "preferred", "safe", "convertible_note", "option", "warrant"];
const DOC_TYPES = ["safe", "side_letter", "term_sheet", "subscription_agreement", "voting_agreement", "ipa", "board_consent", "pro_rata", "other"];

const ROUND_TYPE_LABELS: Record<string, string> = {
  angel: "Angel", safe: "SAFE", convertible_note: "Conv. Note", priced: "Priced Round",
  option_pool: "Option Pool", founders: "Founders", warrant: "Warrant",
};
const HOLDER_TYPE_LABELS: Record<string, string> = {
  founder: "Founder", investor: "Investor", advisor: "Advisor",
  employee: "Employee", option_pool: "Option Pool",
};
const DOC_TYPE_LABELS: Record<string, string> = {
  safe: "SAFE", side_letter: "Side Letter", term_sheet: "Term Sheet",
  subscription_agreement: "Subscription Agreement", voting_agreement: "Voting Agreement",
  ipa: "IPA", board_consent: "Board Consent", pro_rata: "Pro-Rata", other: "Other",
};

const HOLDER_TYPE_COLORS: Record<string, string> = {
  founder:     "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  investor:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  advisor:     "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  employee:    "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  option_pool: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
};
const ROUND_STATUS_COLORS: Record<string, string> = {
  planned: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  open:    "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  closed:  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
};

function fmtMoney(v: string | number | null): string {
  if (v === null || v === "" || v === undefined) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function fmtShares(v: string | number | null): string {
  if (v === null || v === "" || v === undefined) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n) || n === 0) return "—";
  return n.toLocaleString();
}

function gDriveDownloadUrl(url: string): string {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}

// ── Add Round Modal ────────────────────────────────────────────────────────────

function AddRoundModal({ onClose, onSaved }: { onClose: () => void; onSaved: (r: CapRound) => void }) {
  const [form, setForm] = useState({
    name: "", round_type: "safe", status: "open", close_date: "",
    pre_money_val: "", amount_raised: "", lead_investor: "",
    safe_cap: "", discount_pct: "", interest_rate_pct: "", maturity_date: "",
    mfn: false, pro_rata_rights: false, board_seat: false, notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/proxy/cap-table/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          pre_money_val:     form.pre_money_val     ? parseFloat(form.pre_money_val)     : null,
          amount_raised:     form.amount_raised     ? parseFloat(form.amount_raised)     : null,
          safe_cap:          form.safe_cap          ? parseFloat(form.safe_cap)          : null,
          discount_pct:      form.discount_pct      ? parseFloat(form.discount_pct)      : null,
          interest_rate_pct: form.interest_rate_pct ? parseFloat(form.interest_rate_pct) : null,
          close_date:        form.close_date    || null,
          maturity_date:     form.maturity_date || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved(await res.json());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const isSafe = form.round_type === "safe" || form.round_type === "convertible_note";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg p-6 overflow-y-auto max-h-[90vh]">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">New Funding Round</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Name *</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Pre-Seed SAFE, Series A…" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Type</label>
              <StyledSelect value={form.round_type} onChange={e => setForm(f => ({ ...f, round_type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {ROUND_TYPES.map(t => <option key={t} value={t}>{ROUND_TYPE_LABELS[t] ?? t}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Status</label>
              <StyledSelect value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {ROUND_STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Close Date</label>
              <input type="date" value={form.close_date} onChange={e => setForm(f => ({ ...f, close_date: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Lead Investor</label>
              <input value={form.lead_investor} onChange={e => setForm(f => ({ ...f, lead_investor: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Investor / firm name" />
            </div>
            {!isSafe && (
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Pre-Money Valuation</label>
                <input type="number" value={form.pre_money_val} onChange={e => setForm(f => ({ ...f, pre_money_val: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="5000000" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Amount Raised</label>
              <input type="number" value={form.amount_raised} onChange={e => setForm(f => ({ ...f, amount_raised: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="500000" />
            </div>
            {isSafe && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Valuation Cap</label>
                  <input type="number" value={form.safe_cap} onChange={e => setForm(f => ({ ...f, safe_cap: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="5000000" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Discount %</label>
                  <input type="number" value={form.discount_pct} onChange={e => setForm(f => ({ ...f, discount_pct: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="20" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Maturity Date</label>
                  <input type="date" value={form.maturity_date} onChange={e => setForm(f => ({ ...f, maturity_date: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                {form.round_type === "convertible_note" && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Interest Rate %</label>
                    <input type="number" value={form.interest_rate_pct} onChange={e => setForm(f => ({ ...f, interest_rate_pct: e.target.value }))}
                      className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="8" />
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex gap-4 pt-1">
            {[
              { key: "mfn", label: "MFN" },
              { key: "pro_rata_rights", label: "Pro-Rata" },
              { key: "board_seat", label: "Board Seat" },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={(form as Record<string, unknown>)[key] as boolean}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))}
                  className="rounded" />
                <span className="text-xs text-gray-600 dark:text-gray-400">{label}</span>
              </label>
            ))}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Create Round"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Holder Modal ────────────────────────────────────────────────────────────

function AddHolderModal({ onClose, onSaved }: { onClose: () => void; onSaved: (h: CapHolder) => void }) {
  const [form, setForm] = useState({ name: "", holder_type: "investor", email: "", entity_name: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/proxy/cap-table/holders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, email: form.email || null, entity_name: form.entity_name || null, notes: form.notes || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved(await res.json());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Add Equity Holder</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Jane Smith" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Type</label>
              <StyledSelect value={form.holder_type} onChange={e => setForm(f => ({ ...f, holder_type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {HOLDER_TYPES.map(t => <option key={t} value={t}>{HOLDER_TYPE_LABELS[t] ?? t}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Email</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="jane@fund.com" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Entity / Fund Name</label>
            <input value={form.entity_name} onChange={e => setForm(f => ({ ...f, entity_name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Acme Ventures I, LLC" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Add Holder"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Security Modal ──────────────────────────────────────────────────────────

function AddSecurityModal({
  holder, rounds, onClose, onSaved,
}: {
  holder: CapHolder;
  rounds: CapRound[];
  onClose: () => void;
  onSaved: (s: CapSecurity) => void;
}) {
  const [form, setForm] = useState({
    security_type: "common", share_class: "", round_id: "",
    shares: "", investment_amount: "", price_per_share: "",
    grant_date: "", vesting_schedule: "", cliff_months: "", fully_vested_date: "",
    safe_cap: "", discount_pct: "", notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/proxy/cap-table/securities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holder_id:         holder.holder_id,
          round_id:          form.round_id          || null,
          security_type:     form.security_type,
          share_class:       form.share_class        || null,
          shares:            form.shares             ? parseInt(form.shares)              : null,
          investment_amount: form.investment_amount  ? parseFloat(form.investment_amount) : null,
          price_per_share:   form.price_per_share    ? parseFloat(form.price_per_share)   : null,
          grant_date:        form.grant_date         || null,
          vesting_schedule:  form.vesting_schedule   || null,
          cliff_months:      form.cliff_months       ? parseInt(form.cliff_months)        : null,
          fully_vested_date: form.fully_vested_date  || null,
          safe_cap:          form.safe_cap           ? parseFloat(form.safe_cap)          : null,
          discount_pct:      form.discount_pct       ? parseFloat(form.discount_pct)      : null,
          notes:             form.notes              || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved(await res.json());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const isSafe = form.security_type === "safe" || form.security_type === "convertible_note";
  const hasShares = form.security_type === "common" || form.security_type === "preferred" || form.security_type === "option" || form.security_type === "warrant";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg p-6 overflow-y-auto max-h-[90vh]">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-0.5">Add Security</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{holder.name}</p>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Security Type</label>
              <StyledSelect value={form.security_type} onChange={e => setForm(f => ({ ...f, security_type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {SECURITY_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1).replace("_", " ")}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Share Class</label>
              <input value={form.share_class} onChange={e => setForm(f => ({ ...f, share_class: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Common A, Series Seed…" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Round</label>
              <StyledSelect value={form.round_id} onChange={e => setForm(f => ({ ...f, round_id: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— None —</option>
                {rounds.map(r => <option key={r.round_id} value={r.round_id}>{r.name}</option>)}
              </StyledSelect>
            </div>
            {hasShares && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Shares</label>
                  <input type="number" value={form.shares} onChange={e => setForm(f => ({ ...f, shares: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="1000000" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Price / Share</label>
                  <input type="number" step="0.000001" value={form.price_per_share} onChange={e => setForm(f => ({ ...f, price_per_share: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0.0001" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Grant Date</label>
                  <input type="date" value={form.grant_date} onChange={e => setForm(f => ({ ...f, grant_date: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Vesting Schedule</label>
                  <input value={form.vesting_schedule} onChange={e => setForm(f => ({ ...f, vesting_schedule: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="4yr / 1yr cliff" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Cliff (months)</label>
                  <input type="number" value={form.cliff_months} onChange={e => setForm(f => ({ ...f, cliff_months: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="12" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Fully Vested</label>
                  <input type="date" value={form.fully_vested_date} onChange={e => setForm(f => ({ ...f, fully_vested_date: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </>
            )}
            {isSafe && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Investment Amount</label>
                  <input type="number" value={form.investment_amount} onChange={e => setForm(f => ({ ...f, investment_amount: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="50000" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Valuation Cap</label>
                  <input type="number" value={form.safe_cap} onChange={e => setForm(f => ({ ...f, safe_cap: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="5000000" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Discount %</label>
                  <input type="number" value={form.discount_pct} onChange={e => setForm(f => ({ ...f, discount_pct: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="20" />
                </div>
              </>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Add Security"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add Document Modal ──────────────────────────────────────────────────────────

function AddDocumentModal({
  holders, rounds, defaultHolderId, defaultRoundId, onClose, onSaved,
}: {
  holders: CapHolder[];
  rounds: CapRound[];
  defaultHolderId?: string;
  defaultRoundId?: string;
  onClose: () => void;
  onSaved: (d: CapDocument) => void;
}) {
  const [form, setForm] = useState({
    doc_type: "safe", name: "", url: "",
    holder_id: defaultHolderId ?? "",
    round_id:  defaultRoundId  ?? "",
    signed_date: "", notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Name is required"); return; }
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/proxy/cap-table/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_type:    form.doc_type,
          name:        form.name,
          url:         form.url        || null,
          holder_id:   form.holder_id  || null,
          round_id:    form.round_id   || null,
          signed_date: form.signed_date || null,
          notes:       form.notes      || null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved(await res.json());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Add Document</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Type</label>
              <StyledSelect value={form.doc_type} onChange={e => setForm(f => ({ ...f, doc_type: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                {DOC_TYPES.map(t => <option key={t} value={t}>{DOC_TYPE_LABELS[t] ?? t}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Signed Date</label>
              <input type="date" value={form.signed_date} onChange={e => setForm(f => ({ ...f, signed_date: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Document Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Jane Smith SAFE — Pre-Seed" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">URL / Drive Link</label>
            <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://drive.google.com/…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Holder</label>
              <StyledSelect value={form.holder_id} onChange={e => setForm(f => ({ ...f, holder_id: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— None —</option>
                {holders.map(h => <option key={h.holder_id} value={h.holder_id}>{h.name}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Round</label>
              <StyledSelect value={form.round_id} onChange={e => setForm(f => ({ ...f, round_id: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— None —</option>
                {rounds.map(r => <option key={r.round_id} value={r.round_id}>{r.name}</option>)}
              </StyledSelect>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Notes</label>
            <AutoTextarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Saving…" : "Add Document"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Holder Detail Drawer ────────────────────────────────────────────────────────

function HolderDrawer({
  holder, rounds, onClose, onUpdated,
}: {
  holder: CapHolder;
  rounds: CapRound[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [securities, setSecurities] = useState<CapSecurity[]>([]);
  const [documents, setDocuments] = useState<CapDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [editH, setEditH] = useState<CapHolder>({ ...holder });
  const [drawerTab, setDrawerTab] = useState<"overview" | "securities" | "documents">("overview");
  const [addSec, setAddSec] = useState(false);
  const [addDoc, setAddDoc] = useState(false);
  const [deletingSec, setDeletingSec] = useState<CapSecurity | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<CapDocument | null>(null);
  const [editingSec, setEditingSec] = useState<{ id: string; field: string; value: string } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [sRes, dRes] = await Promise.all([
        fetch(`/api/proxy/cap-table/securities?holder_id=${holder.holder_id}`),
        fetch(`/api/proxy/cap-table/documents?holder_id=${holder.holder_id}`),
      ]);
      setSecurities(sRes.ok ? await sRes.json() : []);
      setDocuments(dRes.ok ? await dRes.json() : []);
      setLoading(false);
    })();
  }, [holder.holder_id]);

  async function saveHolder(field: string, value: string) {
    const res = await fetch(`/api/proxy/cap-table/holders/${holder.holder_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value || null }),
    });
    if (res.ok) { setEditH(h => ({ ...h, [field]: value })); onUpdated(); }
  }

  async function patchSecurity(secId: string, field: string, rawVal: string) {
    const numFields = new Set(["shares", "investment_amount", "price_per_share", "safe_cap", "discount_pct", "cliff_months"]);
    const val = numFields.has(field) ? (rawVal ? parseFloat(rawVal) : null) : (rawVal || null);
    const payload: Record<string, unknown> = { [field]: val };

    // Auto-calc shares when investment + price are both present
    if (field === "investment_amount" || field === "price_per_share") {
      const sec = securities.find(s => s.security_id === secId);
      if (sec) {
        const inv   = field === "investment_amount" ? parseFloat(rawVal) : parseFloat(sec.investment_amount ?? "0");
        const price = field === "price_per_share"   ? parseFloat(rawVal) : parseFloat(sec.price_per_share   ?? "0");
        if (inv > 0 && price > 0) payload.shares = Math.round(inv / price);
      }
    }

    await fetch(`/api/proxy/cap-table/securities/${secId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const updated = await (await fetch(`/api/proxy/cap-table/securities?holder_id=${holder.holder_id}`)).json();
    setSecurities(updated);
    setEditingSec(null);
    onUpdated();
  }

  async function deleteSecurity(sec: CapSecurity) {
    await fetch(`/api/proxy/cap-table/securities/${sec.security_id}`, { method: "DELETE" });
    setSecurities(s => s.filter(x => x.security_id !== sec.security_id));
    setDeletingSec(null);
    onUpdated();
  }

  async function deleteDocument(doc: CapDocument) {
    await fetch(`/api/proxy/cap-table/documents/${doc.document_id}`, { method: "DELETE" });
    setDocuments(d => d.filter(x => x.document_id !== doc.document_id));
    setDeletingDoc(null);
    onUpdated();
  }

  async function uploadDocumentFile(docId: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/proxy/cap-table/documents/${docId}/upload`, { method: "POST", body: fd });
    if (res.ok) {
      const updated = await res.json();
      setDocuments(d => d.map(x => x.document_id === docId ? { ...x, ...updated } : x));
    }
  }

  const CellSec = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editingSec} onStartEdit={(id, f, v) => setEditingSec({ id, field: f, value: v })}
      onCommit={patchSecurity} onCancel={() => setEditingSec(null)} />
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-2xl bg-white dark:bg-gray-900 shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${HOLDER_TYPE_COLORS[editH.holder_type] ?? "bg-gray-100 text-gray-600"}`}>
                {HOLDER_TYPE_LABELS[editH.holder_type] ?? editH.holder_type}
              </span>
            </div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{editH.name}</h2>
            {editH.entity_name && <p className="text-xs text-gray-500 dark:text-gray-400">{editH.entity_name}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-0 px-6 border-b border-gray-100 dark:border-gray-800">
          {(["overview", "securities", "documents"] as const).map(t => (
            <button key={t} onClick={() => setDrawerTab(t)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors capitalize ${
                drawerTab === t
                  ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}>
              {t}{t === "securities" && securities.length > 0 && ` (${securities.length})`}
              {t === "documents"  && documents.length  > 0 && ` (${documents.length})`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <p className="text-xs text-gray-400 dark:text-gray-500">Loading…</p>
          ) : drawerTab === "overview" ? (
            <div className="space-y-4">
              {/* Editable fields */}
              {[
                { label: "Name",        field: "name",        value: editH.name        ?? "", type: "text" as const },
                { label: "Email",       field: "email",       value: editH.email       ?? "", type: "text" as const },
                { label: "Entity",      field: "entity_name", value: editH.entity_name ?? "", type: "text" as const },
                { label: "Type",        field: "holder_type", value: editH.holder_type ?? "", type: "select" as const, options: HOLDER_TYPES },
                { label: "Notes",       field: "notes",       value: editH.notes       ?? "", type: "text" as const, multiline: true },
              ].map(({ label, field, value, type, options, multiline }) => (
                <FieldRow key={field} label={label} value={value} type={type} options={options} multiline={multiline}
                  onSave={v => saveHolder(field, v)} />
              ))}
              {/* Summary stats */}
              <div className="pt-2 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-4 py-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total Shares</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{fmtShares(holder.total_shares)}</p>
                </div>
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-4 py-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total Invested</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{fmtMoney(holder.total_invested)}</p>
                </div>
              </div>
            </div>
          ) : drawerTab === "securities" ? (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setAddSec(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add Security
                </button>
              </div>
              {securities.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-8">No securities yet</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800">
                        {["Type", "Class", "Round", "Shares", "Invested", "Cap", "Disc%", "Vesting", ""].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {securities.map(sec => (
                        <tr key={sec.security_id} className="group hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <CellSec rowId={sec.security_id} field="security_type" value={sec.security_type}
                            editType="select" selectOptions={SECURITY_TYPES}
                            display={<span className="font-medium">{sec.security_type}</span>} />
                          <CellSec rowId={sec.security_id} field="share_class" value={sec.share_class ?? ""}
                            placeholder="Class A…"
                            display={sec.share_class
                              ? <span>{sec.share_class}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <td className="px-3 py-2 whitespace-nowrap text-gray-500 dark:text-gray-400">
                            {sec.round_name ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <CellSec rowId={sec.security_id} field="shares" value={sec.shares?.toString() ?? ""}
                            placeholder="1000000"
                            display={sec.shares
                              ? <span className="font-medium">{sec.shares.toLocaleString()}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <CellSec rowId={sec.security_id} field="investment_amount" value={sec.investment_amount ?? ""}
                            placeholder="50000"
                            display={sec.investment_amount
                              ? <span className="font-medium">{fmtMoney(sec.investment_amount)}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <CellSec rowId={sec.security_id} field="safe_cap" value={sec.safe_cap ?? ""}
                            placeholder="5000000"
                            display={sec.safe_cap
                              ? <span>{fmtMoney(sec.safe_cap)}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <CellSec rowId={sec.security_id} field="discount_pct" value={sec.discount_pct ?? ""}
                            placeholder="20"
                            display={sec.discount_pct
                              ? <span>{sec.discount_pct}%</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <CellSec rowId={sec.security_id} field="vesting_schedule" value={sec.vesting_schedule ?? ""}
                            placeholder="4yr/1yr…"
                            display={sec.vesting_schedule
                              ? <span className="truncate max-w-[80px] block" title={sec.vesting_schedule}>{sec.vesting_schedule}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>} />
                          <td className="px-3 py-2">
                            <button onClick={() => setDeletingSec(sec)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setAddDoc(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add Document
                </button>
              </div>
              {documents.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-8">No documents yet</p>
              ) : (
                <div className="space-y-2">
                  {documents.map(doc => (
                    <div key={doc.document_id} className="group flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                            {DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}
                          </span>
                          {doc.signed_date && (
                            <span className="text-xs text-gray-400 dark:text-gray-500">· {doc.signed_date}</span>
                          )}
                          {doc.url && (
                            <span className="text-xs text-green-600 dark:text-green-400 font-medium">· Linked</span>
                          )}
                        </div>
                        {doc.url ? (
                          <a href={doc.url} target="_blank" rel="noopener noreferrer"
                            className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline truncate block">
                            {doc.name}
                          </a>
                        ) : (
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{doc.name}</p>
                        )}
                        {doc.notes && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{doc.notes}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 mt-0.5">
                        {doc.url && (
                          <a href={gDriveDownloadUrl(doc.url)} target="_blank" rel="noopener noreferrer" title="Download"
                            className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-blue-500 rounded transition-opacity">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                            </svg>
                          </a>
                        )}
                        <button onClick={() => setDeletingDoc(doc)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {addSec && (
        <AddSecurityModal holder={holder} rounds={rounds} onClose={() => setAddSec(false)}
          onSaved={s => { setSecurities(prev => [...prev, s]); setAddSec(false); onUpdated(); }} />
      )}
      {addDoc && (
        <AddDocumentModal holders={[holder]} rounds={rounds} defaultHolderId={holder.holder_id}
          onClose={() => setAddDoc(false)}
          onSaved={d => { setDocuments(prev => [...prev, d]); setAddDoc(false); }} />
      )}
      {deletingSec && (
        <DeleteConfirm title={`${deletingSec.security_type} security`}
          onConfirm={() => deleteSecurity(deletingSec)} onCancel={() => setDeletingSec(null)} />
      )}
      {deletingDoc && (
        <DeleteConfirm title={deletingDoc.name}
          onConfirm={() => deleteDocument(deletingDoc)} onCancel={() => setDeletingDoc(null)} />
      )}
    </div>
  );
}

// Helper: inline edit field row for the drawer overview
function FieldRow({ label, value, type, options, multiline, onSave }: {
  label: string; value: string; type: "text" | "select"; options?: string[];
  multiline?: boolean; onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function commit() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  return (
    <div className="flex items-start gap-3">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 w-20 shrink-0 pt-1">{label}</span>
      {editing ? (
        type === "select" ? (
          <StyledSelect value={draft} autoFocus onChange={e => { setDraft(e.target.value); setEditing(false); onSave(e.target.value); }}
            onBlur={() => setEditing(false)}
            className="flex-1 text-sm px-2 py-1 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none">
            {(options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
          </StyledSelect>
        ) : multiline ? (
          <AutoTextarea value={draft} autoFocus rows={3}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === "Escape") { setEditing(false); setDraft(value); } }}
            className="flex-1 text-sm px-2 py-1 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none resize-none" />
        ) : (
          <input value={draft} autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setEditing(false); setDraft(value); } }}
            className="flex-1 text-sm px-2 py-1 rounded border border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none" />
        )
      ) : (
        <button onClick={() => { setDraft(value); setEditing(true); }}
          className="flex-1 text-left text-sm text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors group/fr">
          {value || <span className="text-gray-300 dark:text-gray-600 italic">Click to edit…</span>}
          <span className="ml-1 opacity-0 group-hover/fr:opacity-40">
            <svg className="w-2.5 h-2.5 inline text-blue-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15H9v-2.828z" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}

// ── Main ManagementTab ─────────────────────────────────────────────────────────

type MgmtSubTab = "cap-table" | "rounds" | "documents";

// ── Standalone Rounds Tab ──────────────────────────────────────────────────────
function RoundsTab() {
  const [rounds,     setRounds]     = useState<CapRound[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [addRound,   setAddRound]   = useState(false);
  const [deletingRound, setDeletingRound] = useState<CapRound | null>(null);
  const [editingRound,  setEditingRound]  = useState<{ id: string; field: string; value: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/proxy/cap-table/rounds");
    setRounds(r.ok ? await r.json() : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function patchRound(roundId: string, field: string, rawVal: string) {
    const numFields  = new Set(["pre_money_val", "amount_raised", "share_price", "safe_cap", "discount_pct", "interest_rate_pct", "new_shares_issued", "sort_order"]);
    const boolFields = new Set(["mfn", "pro_rata_rights", "board_seat"]);
    let val: unknown = rawVal || null;
    if (numFields.has(field))  val = rawVal ? parseFloat(rawVal) : null;
    if (boolFields.has(field)) val = rawVal === "true";
    const res = await fetch(`/api/proxy/cap-table/rounds/${roundId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: val }),
    });
    if (res.ok) {
      const updated: CapRound = await res.json();
      setRounds(rs => rs.map(r => r.round_id === roundId ? { ...r, ...updated } : r));
    }
    setEditingRound(null);
  }

  async function deleteRound(r: CapRound) {
    await fetch(`/api/proxy/cap-table/rounds/${r.round_id}`, { method: "DELETE" });
    setRounds(rs => rs.filter(x => x.round_id !== r.round_id));
    setDeletingRound(null);
  }

  const CellR = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editingRound}
      onStartEdit={(id, f, v) => setEditingRound({ id, field: f, value: v })}
      onCommit={patchRound} onCancel={() => setEditingRound(null)} />
  );

  // Summary stats across rounds
  const totalRaised = rounds.reduce((s, r) => s + parseFloat(r.amount_raised ?? "0"), 0);
  const totalSafeCap = rounds.filter(r => r.round_type === "safe").reduce((s, r) => s + parseFloat(r.safe_cap ?? "0"), 0);

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Funding Rounds</h2>
          {rounds.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">{rounds.length} rounds · {fmtMoney(totalRaised)} raised</span>
              {totalSafeCap > 0 && <span className="text-xs text-gray-500 dark:text-gray-400">· {fmtMoney(totalSafeCap)} aggregate SAFE cap</span>}
            </div>
          )}
        </div>
        <button onClick={() => setAddRound(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Round
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <p className="text-sm text-gray-400">Loading…</p>
        </div>
      ) : rounds.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-52 gap-3">
          <svg className="w-10 h-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-gray-500 dark:text-gray-400">No funding rounds yet</p>
          <button onClick={() => setAddRound(true)} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add First Round</button>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: "Total Rounds",   value: rounds.length.toString() },
              { label: "Total Raised",   value: fmtMoney(totalRaised) },
              { label: "Aggregate SAFE Cap", value: totalSafeCap > 0 ? fmtMoney(totalSafeCap) : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  {["Name", "Type", "Status", "Date", "Pre-Money", "Raised", "Lead", "SAFE Cap", "Disc%", "MFN", "Pro-Rata", "Board", ""].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {rounds.map(r => (
                  <tr key={r.round_id} className="group hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <CellR rowId={r.round_id} field="name" value={r.name}
                      display={<span className="font-medium text-gray-900 dark:text-gray-100">{r.name}</span>} />
                    <CellR rowId={r.round_id} field="round_type" value={r.round_type}
                      editType="select" selectOptions={ROUND_TYPES}
                      display={<span className="text-xs font-medium text-gray-600 dark:text-gray-400">{ROUND_TYPE_LABELS[r.round_type] ?? r.round_type}</span>} />
                    <CellR rowId={r.round_id} field="status" value={r.status}
                      editType="select" selectOptions={ROUND_STATUSES}
                      display={
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROUND_STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-600"}`}>
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      } />
                    <CellR rowId={r.round_id} field="close_date" value={r.close_date ?? ""} placeholder="YYYY-MM-DD"
                      display={r.close_date ? <span className="text-xs text-gray-600 dark:text-gray-400">{r.close_date}</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="pre_money_val" value={r.pre_money_val ?? ""} placeholder="5000000"
                      display={r.pre_money_val ? <span className="text-xs tabular-nums">{fmtMoney(r.pre_money_val)}</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="amount_raised" value={r.amount_raised ?? ""} placeholder="500000"
                      display={r.amount_raised ? <span className="text-xs font-medium text-green-700 dark:text-green-400 tabular-nums">{fmtMoney(r.amount_raised)}</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="lead_investor" value={r.lead_investor ?? ""} placeholder="Firm name…"
                      display={r.lead_investor ? <span className="text-xs text-gray-700 dark:text-gray-300">{r.lead_investor}</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="safe_cap" value={r.safe_cap ?? ""} placeholder="5000000"
                      display={r.safe_cap ? <span className="text-xs tabular-nums">{fmtMoney(r.safe_cap)}</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="discount_pct" value={r.discount_pct ?? ""} placeholder="20"
                      display={r.discount_pct ? <span className="text-xs tabular-nums">{r.discount_pct}%</span> : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <td className="px-3 py-3 text-center"><input type="checkbox" checked={r.mfn} readOnly className="rounded pointer-events-none" /></td>
                    <td className="px-3 py-3 text-center"><input type="checkbox" checked={r.pro_rata_rights} readOnly className="rounded pointer-events-none" /></td>
                    <td className="px-3 py-3 text-center"><input type="checkbox" checked={r.board_seat} readOnly className="rounded pointer-events-none" /></td>
                    <td className="px-3 py-3">
                      <button onClick={() => setDeletingRound(r)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {addRound && (
        <AddRoundModal onClose={() => setAddRound(false)}
          onSaved={r => { setRounds(rs => [...rs, r]); setAddRound(false); }} />
      )}
      {deletingRound && (
        <DeleteConfirm title={deletingRound.name}
          onConfirm={() => deleteRound(deletingRound)} onCancel={() => setDeletingRound(null)} />
      )}
    </>
  );
}

function ManagementTab() {
  const [subTab, setSubTab] = useState<MgmtSubTab>("cap-table");
  const [holders,    setHolders]    = useState<CapHolder[]>([]);
  const [rounds,     setRounds]     = useState<CapRound[]>([]);
  const [securities, setSecurities] = useState<CapSecurity[]>([]);
  const [documents,  setDocuments]  = useState<CapDocument[]>([]);
  const [loading,    setLoading]    = useState(true);

  const [addHolder,   setAddHolder]   = useState(false);
  const [addRound,    setAddRound]    = useState(false);
  const [addDoc,      setAddDoc]      = useState(false);
  const [selectedHolder, setSelectedHolder] = useState<CapHolder | null>(null);
  const [deletingHolder, setDeletingHolder] = useState<CapHolder | null>(null);
  const [deletingRound,  setDeletingRound]  = useState<CapRound  | null>(null);
  const [deletingDoc,    setDeletingDoc]    = useState<CapDocument | null>(null);

  const [editingRound,  setEditingRound]  = useState<{ id: string; field: string; value: string } | null>(null);
  const [editingDoc,    setEditingDoc]    = useState<{ id: string; field: string; value: string } | null>(null);
  const [editingHolder, setEditingHolder] = useState<{ id: string; field: string; value: string } | null>(null);

  const load = useCallback(async () => {
    const [hRes, rRes, sRes, dRes] = await Promise.all([
      fetch("/api/proxy/cap-table/holders"),
      fetch("/api/proxy/cap-table/rounds"),
      fetch("/api/proxy/cap-table/securities"),
      fetch("/api/proxy/cap-table/documents"),
    ]);
    setHolders(hRes.ok ? await hRes.json() : []);
    setRounds(rRes.ok  ? await rRes.json() : []);
    setSecurities(sRes.ok ? await sRes.json() : []);
    setDocuments(dRes.ok  ? await dRes.json() : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Cap table derived stats ──
  const totalShares = securities.reduce((s, x) => s + (x.shares ?? 0), 0);
  const totalInvested = securities.reduce((s, x) => s + parseFloat(x.investment_amount ?? "0"), 0);

  // % ownership per holder (shares basis — SAFEs show as "TBD" if no shares)
  function ownershipPct(h: CapHolder): string {
    const sh = parseFloat(h.total_shares ?? "0");
    if (totalShares === 0 || sh === 0) return "—";
    return (sh / totalShares * 100).toFixed(2) + "%";
  }

  // ── Excel exports ──
  // ── Shared xlsx style helpers ──────────────────────────────────────────────
  function xlCell(v: unknown, s: Record<string, unknown>): XLSX.CellObject {
    const t = typeof v === "number" ? "n" : "s";
    return { v, t, s } as XLSX.CellObject;
  }
  const S = {
    title:      { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1E3A5F" } }, alignment: { horizontal: "left" } },
    subtitle:   { font: { sz: 10, color: { rgb: "FFFFFF" } },             fill: { fgColor: { rgb: "2B5797" } }, alignment: { horizontal: "left" } },
    sectionHdr: { font: { bold: true, sz: 10, color: { rgb: "1E3A5F" } }, fill: { fgColor: { rgb: "D9E1F2" } }, alignment: { horizontal: "left" } },
    colHdr:     { font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "243F60" } }, alignment: { horizontal: "center" }, border: { bottom: { style: "medium", color: { rgb: "FFFFFF" } } } },
    colHdrR:    { font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "243F60" } }, alignment: { horizontal: "right" }, border: { bottom: { style: "medium", color: { rgb: "FFFFFF" } } } },
    total:      { font: { bold: true, sz: 10, color: { rgb: "1E3A5F" } }, fill: { fgColor: { rgb: "E2EFDA" } }, border: { top: { style: "medium", color: { rgb: "70AD47" } } } },
    totalR:     { font: { bold: true, sz: 10, color: { rgb: "1E3A5F" } }, fill: { fgColor: { rgb: "E2EFDA" } }, border: { top: { style: "medium", color: { rgb: "70AD47" } } }, alignment: { horizontal: "right" } },
    subtotal:   { font: { bold: true, sz: 10, italic: true, color: { rgb: "404040" } }, fill: { fgColor: { rgb: "F2F2F2" } }, alignment: { horizontal: "right" } },
    data:       { font: { sz: 10 }, alignment: { horizontal: "left" } },
    dataR:      { font: { sz: 10 }, alignment: { horizontal: "right" } },
    dataC:      { font: { sz: 10 }, alignment: { horizontal: "center" } },
    money:      { font: { sz: 10 }, alignment: { horizontal: "right" }, numFmt: '"$"#,##0' },
    moneyBold:  { font: { bold: true, sz: 10 }, alignment: { horizontal: "right" }, numFmt: '"$"#,##0', fill: { fgColor: { rgb: "E2EFDA" } }, border: { top: { style: "medium", color: { rgb: "70AD47" } } } },
    pct:        { font: { sz: 10 }, alignment: { horizontal: "right" }, numFmt: '0.00%' },
    pctBold:    { font: { bold: true, sz: 10 }, alignment: { horizontal: "right" }, numFmt: '0.00%', fill: { fgColor: { rgb: "E2EFDA" } }, border: { top: { style: "medium", color: { rgb: "70AD47" } } } },
    num:        { font: { sz: 10 }, alignment: { horizontal: "right" }, numFmt: '#,##0' },
    numBold:    { font: { bold: true, sz: 10 }, alignment: { horizontal: "right" }, numFmt: '#,##0', fill: { fgColor: { rgb: "E2EFDA" } }, border: { top: { style: "medium", color: { rgb: "70AD47" } } } },
    pending:    { font: { sz: 10, italic: true, color: { rgb: "C00000" } }, alignment: { horizontal: "left" } },
    note:       { font: { sz: 9, italic: true, color: { rgb: "7F7F7F" } }, alignment: { horizontal: "left", wrapText: true } },
    input:      { font: { bold: true, sz: 10, color: { rgb: "1F497D" } }, fill: { fgColor: { rgb: "DCE6F1" } }, alignment: { horizontal: "right" } },
    calc:       { font: { sz: 10, color: { rgb: "404040" } }, alignment: { horizontal: "right" } },
  };
  function setSheetMeta(ws: XLSX.WorkSheet, cols: number[], freezeRow?: number) {
    ws["!cols"] = cols.map(w => ({ wch: w }));
    if (freezeRow !== undefined) ws["!freeze"] = { xSplit: 0, ySplit: freezeRow };
  }
  function setCells(ws: XLSX.WorkSheet, rowIdx: number, cells: XLSX.CellObject[]) {
    cells.forEach((cell, c) => { ws[XLSX.utils.encode_cell({ r: rowIdx, c })] = cell; });
  }
  function mergeRow(ws: XLSX.WorkSheet, row: number, from: number, to: number) {
    ws["!merges"] = [...(ws["!merges"] ?? []), { s: { r: row, c: from }, e: { r: row, c: to } }];
  }
  function updateRef(ws: XLSX.WorkSheet) {
    const cells = Object.keys(ws).filter(k => !k.startsWith("!"));
    if (!cells.length) return;
    let minR = Infinity, minC = Infinity, maxR = 0, maxC = 0;
    cells.forEach(addr => {
      const { r, c } = XLSX.utils.decode_cell(addr);
      if (r < minR) minR = r; if (c < minC) minC = c;
      if (r > maxR) maxR = r; if (c > maxC) maxC = c;
    });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
  }

  // Full internal export — 3 sheets: Cap Table Summary, SAFE Instrument Detail, Conversion Model
  function exportFullCapTable() {
    const FD_TARGET = 200000;
    const POOL_PCT  = 0.10;

    const safeSecs = securities.filter(s => {
      const cap = parseFloat(String(s.safe_cap ?? rounds.find(r => r.round_id === s.round_id)?.safe_cap ?? "0"));
      return cap > 0 && parseFloat(String(s.investment_amount ?? "0")) > 0;
    });
    const safeSum = safeSecs.reduce((acc, s) => {
      const amt = parseFloat(String(s.investment_amount ?? "0"));
      const cap = parseFloat(String(s.safe_cap ?? rounds.find(r => r.round_id === s.round_id)?.safe_cap ?? "0"));
      return acc + (cap > 0 ? amt / cap : 0);
    }, 0);
    const employeePool = Math.round(FD_TARGET * POOL_PCT);
    const coCap        = safeSum > 0 ? Math.round((FD_TARGET - employeePool) / (1 + safeSum)) : FD_TARGET - employeePool;

    interface SC { holder: string; entity: string; tranche: string; date: string; amount: number; cap: number; safePrice: number; units: number; unitsFrac: number; mfn: boolean; proRata: boolean; discount: number | null; status: string; provisions: string; }
    const safeConversions: SC[] = safeSecs.map(s => {
      const h     = holders.find(x => x.holder_id === s.holder_id);
      const r     = s.round_id ? rounds.find(x => x.round_id === s.round_id) : null;
      const amt   = parseFloat(String(s.investment_amount ?? "0"));
      const cap   = parseFloat(String(s.safe_cap ?? r?.safe_cap ?? "0"));
      const price = cap > 0 ? cap / coCap : 0;
      const units = price > 0 ? amt / price : 0;
      const disc  = parseFloat(String(s.discount_pct ?? r?.discount_pct ?? "0")) || null;
      const provisions = [r?.pro_rata_rights ? "Pro rata" : "", r?.mfn ? "MFN" : "", disc ? `${disc}% discount` : "", s.notes ?? ""].filter(Boolean).join("; ");
      return {
        holder: h?.name ?? "Unknown", entity: h?.entity_name ?? "",
        tranche: s.share_class ?? r?.name ?? "", date: s.grant_date ?? "",
        amount: amt, cap, safePrice: Math.round(price * 100) / 100,
        units: Math.round(units), unitsFrac: units / FD_TARGET,
        mfn: r?.mfn ?? false, proRata: r?.pro_rata_rights ?? false, discount: disc,
        status: r?.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : "",
        provisions,
      };
    });

    // ── Sheet 1: Cap Table Summary ──────────────────────────────────────────
    const ws1: XLSX.WorkSheet = { "!merges": [] };
    const NCOLS1 = 7;
    let R = 0;
    // Title
    setCells(ws1, R, [xlCell("YOUR COMPANY LLC — CAP TABLE", S.title)]);
    mergeRow(ws1, R++, 0, NCOLS1 - 1);
    setCells(ws1, R, [xlCell(`As of ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}  |  Pre-Conversion (SAFE instruments outstanding)`, S.subtitle)]);
    mergeRow(ws1, R++, 0, NCOLS1 - 1);
    setCells(ws1, R, [xlCell("NOTE: IN THE PROCESS OF CONVERSION TO C CORP", S.subtitle)]);
    mergeRow(ws1, R++, 0, NCOLS1 - 1);
    R++; // blank
    // Section header
    setCells(ws1, R, [xlCell("EQUITY HOLDERS (PRE-CONVERSION)", S.sectionHdr)]);
    mergeRow(ws1, R++, 0, NCOLS1 - 1);
    // Column headers
    setCells(ws1, R, [
      xlCell("Holder", S.colHdr), xlCell("Entity / Type", S.colHdr), xlCell("Security", S.colHdr),
      xlCell("Units", S.colHdrR), xlCell("Pre-Conv %", S.colHdrR), xlCell("Post-Conv %", S.colHdrR), xlCell("Notes", S.colHdr),
    ]);
    const headerRow1 = R++;
    // Data rows
    holders.forEach(h => {
      const hSecs    = securities.filter(s => s.holder_id === h.holder_id);
      const secTypes = [...new Set(hSecs.map(s => s.security_type))].join(", ");
      const preConvPct  = parseFloat(h.total_shares ?? "0") > 0 && totalShares > 0 ? parseFloat(h.total_shares ?? "0") / totalShares : 0;
      const isFdr       = h.holder_type === "founder";
      const isPool      = h.holder_type === "option_pool";
      const convUnitsH  = safeConversions.filter(c => c.holder === h.name).reduce((a, c) => a + c.units, 0);
      const postConvFrac = isFdr ? coCap / FD_TARGET : isPool ? POOL_PCT : convUnitsH > 0 ? convUnitsH / FD_TARGET : 0;
      const units = parseFloat(h.total_shares ?? "0") || (isPool ? employeePool : isFdr ? coCap : 0);
      setCells(ws1, R++, [
        xlCell(h.name, { ...S.data, font: { bold: true, sz: 10 } }),
        xlCell(h.entity_name ?? HOLDER_TYPE_LABELS[h.holder_type] ?? h.holder_type, S.dataC),
        xlCell(secTypes, S.dataC),
        xlCell(units || null, S.num),
        xlCell(preConvPct || null, S.pct),
        xlCell(postConvFrac || null, S.pct),
        xlCell(hSecs.map(s => s.notes).filter(Boolean).join("; "), S.note),
      ]);
    });
    // Totals row
    setCells(ws1, R++, [
      xlCell("TOTAL", S.total), xlCell("", S.total), xlCell("", S.total),
      xlCell(FD_TARGET, S.numBold), xlCell(1, S.pctBold), xlCell(1, S.pctBold), xlCell("", S.total),
    ]);
    setSheetMeta(ws1, [28, 22, 16, 12, 12, 12, 40], headerRow1 + 1);
    updateRef(ws1);
    ws1["!rows"] = [{ hpt: 22 }, { hpt: 14 }, { hpt: 14 }];

    // ── Sheet 2: SAFE Instrument Detail ────────────────────────────────────
    const ws2: XLSX.WorkSheet = { "!merges": [] };
    const NCOLS2 = 8;
    R = 0;
    setCells(ws2, R, [xlCell("YOUR COMPANY — SAFE INSTRUMENT DETAIL", S.title)]);
    mergeRow(ws2, R++, 0, NCOLS2 - 1);
    R++; // blank
    setCells(ws2, R, [
      xlCell("Investor", S.colHdr), xlCell("Entity", S.colHdr), xlCell("Date", S.colHdr),
      xlCell("Amount", S.colHdrR), xlCell("Post-Money Cap", S.colHdrR), xlCell("Gov. Law", S.colHdr),
      xlCell("Status", S.colHdr), xlCell("Special Provisions", S.colHdr),
    ]);
    const headerRow2 = R++;
    safeConversions.forEach(c => {
      const isPending = c.status.toLowerCase() === "pending";
      setCells(ws2, R++, [
        xlCell(c.holder,    isPending ? S.pending : S.data),
        xlCell(c.entity,    S.dataC),
        xlCell(c.date,      S.dataC),
        xlCell(c.amount,    S.money),
        xlCell(c.cap,       S.money),
        xlCell("",          S.dataC),
        xlCell(c.status,    S.dataC),
        xlCell(c.provisions, S.note),
      ]);
    });
    // blank + subtotals by holder
    R++;
    const holderTotals: Record<string, number> = {};
    safeConversions.forEach(c => { holderTotals[c.holder] = (holderTotals[c.holder] ?? 0) + c.amount; });
    Object.entries(holderTotals).forEach(([name, total]) => {
      setCells(ws2, R++, [
        xlCell(`${name} Total`, S.subtotal), xlCell("", S.subtotal), xlCell("", S.subtotal),
        xlCell(total, { ...S.subtotal, numFmt: '"$"#,##0' }),
        xlCell("", S.subtotal), xlCell("", S.subtotal), xlCell("", S.subtotal), xlCell("", S.subtotal),
      ]);
    });
    const grandTotal = safeConversions.reduce((a, c) => a + c.amount, 0);
    setCells(ws2, R++, [
      xlCell("Grand Total SAFEs (incl. pending)", S.total), xlCell("", S.total), xlCell("", S.total),
      xlCell(grandTotal, S.moneyBold),
      xlCell("", S.total), xlCell("", S.total), xlCell("", S.total), xlCell("", S.total),
    ]);
    setSheetMeta(ws2, [24, 20, 12, 14, 16, 12, 12, 48], headerRow2 + 1);
    updateRef(ws2);
    ws2["!rows"] = [{ hpt: 22 }];

    // ── Sheet 3: Conversion Model ───────────────────────────────────────────
    const ws3: XLSX.WorkSheet = { "!merges": [] };
    const NCOLS3 = 5;
    R = 0;
    setCells(ws3, R, [xlCell("YOUR COMPANY — SAFE CONVERSION MODEL", S.title)]);
    mergeRow(ws3, R++, 0, NCOLS3 - 1);
    setCells(ws3, R, [xlCell("Blue = inputs you can change  |  Black = calculated formulas", S.subtitle)]);
    mergeRow(ws3, R++, 0, NCOLS3 - 1);
    R++;
    setCells(ws3, R, [xlCell("ASSUMPTIONS", S.sectionHdr)]);
    mergeRow(ws3, R++, 0, NCOLS3 - 1);
    setCells(ws3, R++, [xlCell("Parameter", S.colHdr), xlCell("Value", S.colHdrR), xlCell("Notes", S.colHdr)]);
    setCells(ws3, R++, [xlCell("Total fully diluted units (target)", S.data), xlCell(FD_TARGET, { ...S.input, numFmt: "#,##0" }), xlCell("Top-level input", S.note)]);
    setCells(ws3, R++, [xlCell("Employee pool % (of fully diluted)", S.data), xlCell(POOL_PCT, { ...S.input, numFmt: "0.0%" }), xlCell("10% profits interest pool per term sheet", S.note)]);
    safeConversions.forEach(c => {
      setCells(ws3, R++, [xlCell(`${c.holder} — purchase amount`, S.data), xlCell(c.amount, { ...S.input, numFmt: '"$"#,##0' }), xlCell(`Source: ${c.tranche || "SAFE"}, ${c.date}`, S.note)]);
    });
    R++;
    setCells(ws3, R, [xlCell("CONVERSION CALCULATIONS", S.sectionHdr)]);
    mergeRow(ws3, R++, 0, NCOLS3 - 1);
    setCells(ws3, R++, [
      xlCell("Holder", S.colHdr), xlCell("Units", S.colHdrR),
      xlCell("% of Total", S.colHdrR), xlCell("Safe Price", S.colHdrR), xlCell("Notes", S.colHdr),
    ]);
    const founderH = holders.find(h => h.holder_type === "founder");
    setCells(ws3, R++, [
      xlCell(founderH?.name ?? "Founder", S.data), xlCell(coCap, { ...S.calc, numFmt: "#,##0" }),
      xlCell(coCap / FD_TARGET, S.pct), xlCell("—", S.dataC), xlCell("Common units; diluted upon SAFE conversion", S.note),
    ]);
    setCells(ws3, R++, [
      xlCell("Employee / Advisor Pool", S.data), xlCell(employeePool, { ...S.calc, numFmt: "#,##0" }),
      xlCell(POOL_PCT, S.pct), xlCell("—", S.dataC), xlCell(`${(POOL_PCT * 100).toFixed(0)}% profits interest pool; excluded from SAFE denominator`, S.note),
    ]);
    safeConversions.forEach(c => {
      setCells(ws3, R++, [
        xlCell(`${c.holder} ($${(c.cap / 1000).toFixed(0)}K cap)${c.status === "Pending" ? " — PENDING" : ""}`, c.status === "Pending" ? S.pending : S.data),
        xlCell(c.units, { ...S.calc, numFmt: "#,##0" }),
        xlCell(c.unitsFrac, S.pct),
        xlCell(c.safePrice, { ...S.calc, numFmt: '"$"#,##0.00' }),
        xlCell(`Safe Price = cap / Co.Cap; Units = amt / Safe Price`, S.note),
      ]);
    });
    setCells(ws3, R++, [
      xlCell("TOTAL (fully diluted)", S.total), xlCell(FD_TARGET, S.numBold),
      xlCell(1, S.pctBold), xlCell("", S.total), xlCell("", S.total),
    ]);
    setSheetMeta(ws3, [36, 14, 12, 12, 46]);
    updateRef(ws3);
    ws3["!rows"] = [{ hpt: 22 }, { hpt: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "Cap Table Summary");
    XLSX.utils.book_append_sheet(wb, ws2, "SAFE Instrument Detail");
    XLSX.utils.book_append_sheet(wb, ws3, "Conversion Model");
    XLSX.writeFile(wb, `OpenERP_CapTable_Internal_${new Date().toISOString().slice(0, 10)}.xlsx`, { cellStyles: true });
  }

  // Investor-facing export — simple, shareable, formatted
  function exportInvestorView() {
    const FD_TARGET = 200000;
    const POOL_PCT  = 0.10;
    const safeSecs = securities.filter(s => {
      const cap = parseFloat(String(s.safe_cap ?? rounds.find(r => r.round_id === s.round_id)?.safe_cap ?? "0"));
      return cap > 0 && parseFloat(String(s.investment_amount ?? "0")) > 0;
    });
    const safeSum = safeSecs.reduce((acc, s) => {
      const amt = parseFloat(String(s.investment_amount ?? "0"));
      const cap = parseFloat(String(s.safe_cap ?? rounds.find(r => r.round_id === s.round_id)?.safe_cap ?? "0"));
      return acc + (cap > 0 ? amt / cap : 0);
    }, 0);
    const employeePool = Math.round(FD_TARGET * POOL_PCT);
    const coCap        = safeSum > 0 ? Math.round((FD_TARGET - employeePool) / (1 + safeSum)) : FD_TARGET - employeePool;

    const ws: XLSX.WorkSheet = { "!merges": [] };
    const NCOLS = 5;
    let R = 0;

    // Title
    setCells(ws, R, [xlCell("YOUR COMPANY LLC — INVESTOR CAP TABLE SUMMARY", S.title)]);
    mergeRow(ws, R++, 0, NCOLS - 1);
    setCells(ws, R, [xlCell(`As of ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}  |  Post-Money Valuation (on conversion)`, S.subtitle)]);
    mergeRow(ws, R++, 0, NCOLS - 1);
    R++;

    // Column headers
    setCells(ws, R, [
      xlCell("Investor / Holder",      S.colHdr),
      xlCell("Total Amount Invested",  S.colHdrR),
      xlCell("Round",                  S.colHdr),
      xlCell("Date Invested",          S.colHdr),
      xlCell("% Ownership (converted)", S.colHdrR),
    ]);
    const headerRow = R++;

    // Include investors + employee/advisor pool
    const viewHolders = holders.filter(h => h.holder_type === "investor" || h.holder_type === "option_pool");
    let grandTotalInvested = 0;

    viewHolders.forEach(h => {
      const hSecs      = securities.filter(s => s.holder_id === h.holder_id);
      const roundNames = [...new Set(hSecs.map(s => s.round_name).filter(Boolean))].join(", ");
      const grantDates = hSecs.map(s => s.grant_date).filter(Boolean).sort();
      const dateRange  = grantDates.length > 1
        ? `${grantDates[0]} – ${grantDates[grantDates.length - 1]}`
        : (grantDates[0] ?? "");
      const isPool     = h.holder_type === "option_pool";
      const invested   = parseFloat(h.total_invested ?? "0") || 0;
      grandTotalInvested += invested;

      // Ownership: investors use SAFE conversion units; pool uses POOL_PCT
      const convUnits   = isPool ? employeePool : safeSum > 0
        ? safeSecs.filter(s => s.holder_id === h.holder_id).reduce((a, s) => {
            const amt = parseFloat(String(s.investment_amount ?? "0"));
            const cap = parseFloat(String(s.safe_cap ?? rounds.find(r => r.round_id === s.round_id)?.safe_cap ?? "0"));
            const price = cap > 0 ? cap / coCap : 0;
            return a + (price > 0 ? amt / price : 0);
          }, 0)
        : 0;
      const ownershipFrac = convUnits > 0 ? convUnits / FD_TARGET : null;

      setCells(ws, R++, [
        xlCell(h.name, { ...S.data, font: { bold: !isPool, sz: 10 } }),
        xlCell(isPool ? null : invested, S.money),
        xlCell(isPool ? "Employee / Advisor Pool" : roundNames, S.dataC),
        xlCell(isPool ? "Ongoing" : dateRange, S.dataC),
        xlCell(ownershipFrac, S.pct),
      ]);
    });

    // Totals
    setCells(ws, R++, [
      xlCell("TOTAL", S.total),
      xlCell(grandTotalInvested, S.moneyBold),
      xlCell("", S.total),
      xlCell("", S.total),
      xlCell(1, S.pctBold),
    ]);

    // Source note
    R++;
    setCells(ws, R, [xlCell("Source: Executed SAFE agreements, Pro Rata Agreements, Side Letters, Term Sheets — Your Company LLC (2025–2026)", { ...S.note, fill: undefined })]);
    mergeRow(ws, R++, 0, NCOLS - 1);
    setCells(ws, R, [xlCell("Post-conversion % is illustrative; depends on Company Capitalization at conversion. Employee/Advisor pool excluded from SAFE denominator per SAFE definitions.", { ...S.note, fill: undefined })]);
    mergeRow(ws, R++, 0, NCOLS - 1);

    setSheetMeta(ws, [30, 22, 28, 22, 22], headerRow + 1);
    updateRef(ws);
    ws["!rows"] = [{ hpt: 22 }, { hpt: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Investor Summary");
    XLSX.writeFile(wb, `OpenERP_Investor_Summary_${new Date().toISOString().slice(0, 10)}.xlsx`, { cellStyles: true });
  }

  // ── Patch helpers ──
  async function patchRound(roundId: string, field: string, rawVal: string) {
    const numFields = new Set(["pre_money_val", "amount_raised", "share_price", "safe_cap", "discount_pct", "interest_rate_pct", "new_shares_issued", "sort_order"]);
    const boolFields = new Set(["mfn", "pro_rata_rights", "board_seat"]);
    let val: unknown = rawVal || null;
    if (numFields.has(field)) val = rawVal ? parseFloat(rawVal) : null;
    if (boolFields.has(field)) val = rawVal === "true";
    const res = await fetch(`/api/proxy/cap-table/rounds/${roundId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: val }),
    });
    if (res.ok) {
      const updated: CapRound = await res.json();
      setRounds(rs => rs.map(r => r.round_id === roundId ? { ...r, ...updated } : r));
    }
    setEditingRound(null);
  }

  async function patchDoc(docId: string, field: string, rawVal: string) {
    const res = await fetch(`/api/proxy/cap-table/documents/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: rawVal || null }),
    });
    if (res.ok) {
      const updated: CapDocument = await res.json();
      setDocuments(ds => ds.map(d => d.document_id === docId ? { ...d, ...updated } : d));
    }
    setEditingDoc(null);
  }

  const CellR = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editingRound} onStartEdit={(id, f, v) => setEditingRound({ id, field: f, value: v })}
      onCommit={patchRound} onCancel={() => setEditingRound(null)} />
  );

  const CellD = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editingDoc} onStartEdit={(id, f, v) => setEditingDoc({ id, field: f, value: v })}
      onCommit={patchDoc} onCancel={() => setEditingDoc(null)} />
  );

  async function patchHolder(holderId: string, field: string, rawVal: string) {
    const res = await fetch(`/api/proxy/cap-table/holders/${holderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: rawVal || null }),
    });
    if (res.ok) {
      const updated: CapHolder = await res.json();
      setHolders(hs => hs.map(h => h.holder_id === holderId ? { ...h, ...updated } : h));
    }
    setEditingHolder(null);
  }

  const CellH = (props: Omit<Parameters<typeof EditableCell>[0], "editing" | "onStartEdit" | "onCommit" | "onCancel">) => (
    <EditableCell {...props} editing={editingHolder} onStartEdit={(id, f, v) => setEditingHolder({ id, field: f, value: v })}
      onCommit={patchHolder} onCancel={() => setEditingHolder(null)} />
  );

  async function deleteHolder(h: CapHolder) {
    await fetch(`/api/proxy/cap-table/holders/${h.holder_id}`, { method: "DELETE" });
    setHolders(hs => hs.filter(x => x.holder_id !== h.holder_id));
    setDeletingHolder(null);
  }

  async function deleteRound(r: CapRound) {
    await fetch(`/api/proxy/cap-table/rounds/${r.round_id}`, { method: "DELETE" });
    setRounds(rs => rs.filter(x => x.round_id !== r.round_id));
    setDeletingRound(null);
  }

  async function deleteDoc(d: CapDocument) {
    await fetch(`/api/proxy/cap-table/documents/${d.document_id}`, { method: "DELETE" });
    setDocuments(ds => ds.filter(x => x.document_id !== d.document_id));
    setDeletingDoc(null);
  }

  async function uploadDocFile(docId: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/proxy/cap-table/documents/${docId}/upload`, { method: "POST", body: fd });
    if (res.ok) {
      const updated = await res.json();
      setDocuments(ds => ds.map(d => d.document_id === docId ? { ...d, ...updated } : d));
    }
  }

  // Group holders by type for the cap table view
  const groupOrder: CapHolder["holder_type"][] = ["founder", "employee", "advisor", "investor", "option_pool"];
  const grouped = groupOrder
    .map(type => ({ type, items: holders.filter(h => h.holder_type === type) }))
    .filter(g => g.items.length > 0);

  const subTabs: { id: MgmtSubTab; label: string }[] = [
    { id: "cap-table",  label: "Cap Table" },
    { id: "rounds",     label: "Rounds" },
    { id: "documents",  label: "Documents" },
  ];

  return (
    <>
      {/* Sub-tab bar + actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-0 border-b border-gray-200 dark:border-gray-700">
          {subTabs.map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                subTab === t.id
                  ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {subTab === "cap-table" && holders.length > 0 && (
            <>
              <button onClick={exportInvestorView}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Investor View
              </button>
              <button onClick={exportFullCapTable}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Full Export
              </button>
            </>
          )}
          {subTab === "cap-table" && (
            <button onClick={() => setAddHolder(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Holder
            </button>
          )}
          {subTab === "rounds" && (
            <button onClick={() => setAddRound(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Round
            </button>
          )}
          {subTab === "documents" && (
            <button onClick={() => setAddDoc(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Document
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>
        </div>
      ) : subTab === "cap-table" ? (
        <>
          {/* Summary strip */}
          {holders.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-5">
              {[
                { label: "Total Shareholders", value: holders.length.toString() },
                { label: "Total Shares Issued", value: totalShares > 0 ? totalShares.toLocaleString() : "—" },
                { label: "Total Capital Raised", value: fmtMoney(totalInvested) },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                  <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{value}</p>
                </div>
              ))}
            </div>
          )}

          {holders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-52 gap-3">
              <svg className="w-10 h-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
              </svg>
              <p className="text-sm text-gray-500 dark:text-gray-400">No equity holders yet</p>
              <button onClick={() => setAddHolder(true)}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                Add First Holder
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Type</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Entity</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400">Shares</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400">Invested</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400">% Ownership</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">Securities</th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">Docs</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {grouped.map(({ type, items }) => (
                    <React.Fragment key={type}>
                      {/* Group header row */}
                      <tr className="border-t border-gray-200 dark:border-gray-700">
                        <td colSpan={9} className="px-4 pt-3 pb-1">
                          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                            {HOLDER_TYPE_LABELS[type] ?? type}s
                          </span>
                        </td>
                      </tr>
                      {items.map(h => (
                        <tr key={h.holder_id} className="group hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors cursor-pointer"
                          onClick={() => { if (!editingHolder) setSelectedHolder(h); }}>
                          <CellH rowId={h.holder_id} field="name" value={h.name}
                            display={
                              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">
                                {h.name}
                              </span>
                            } />
                          <CellH rowId={h.holder_id} field="holder_type" value={h.holder_type}
                            editType="select" selectOptions={HOLDER_TYPES}
                            display={
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${HOLDER_TYPE_COLORS[h.holder_type] ?? "bg-gray-100 text-gray-600"}`}>
                                {HOLDER_TYPE_LABELS[h.holder_type] ?? h.holder_type}
                              </span>
                            } />
                          <CellH rowId={h.holder_id} field="entity_name" value={h.entity_name ?? ""} placeholder="Entity name…"
                            display={
                              h.entity_name
                                ? <span className="text-xs text-gray-500 dark:text-gray-400">{h.entity_name}</span>
                                : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                            } />
                          <td className="px-4 py-3 text-right text-xs font-medium text-gray-700 dark:text-gray-300 tabular-nums">
                            {fmtShares(h.total_shares)}
                          </td>
                          <td className="px-4 py-3 text-right text-xs font-medium text-gray-700 dark:text-gray-300 tabular-nums">
                            {fmtMoney(h.total_invested)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 tabular-nums">
                              {ownershipPct(h)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {h.security_count > 0 ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-medium">
                                {h.security_count}
                              </span>
                            ) : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {h.document_count > 0 ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 font-medium">
                                {h.document_count}
                              </span>
                            ) : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
                          </td>
                          <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                            <button onClick={() => setDeletingHolder(h)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                  {/* Totals row */}
                  {holders.length > 0 && (
                    <tr className="bg-gray-50 dark:bg-gray-800 border-t-2 border-gray-300 dark:border-gray-600 font-semibold">
                      <td className="px-4 py-3 text-xs font-semibold text-gray-700 dark:text-gray-300" colSpan={3}>Total</td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{fmtShares(totalShares)}</td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums">{fmtMoney(totalInvested)}</td>
                      <td className="px-4 py-3 text-right text-xs font-semibold text-gray-900 dark:text-gray-100">100%</td>
                      <td colSpan={3}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : subTab === "rounds" ? (
        rounds.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-52 gap-3">
            <svg className="w-10 h-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-gray-500 dark:text-gray-400">No funding rounds yet</p>
            <button onClick={() => setAddRound(true)}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Add First Round
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  {["Name", "Type", "Status", "Date", "Pre-Money", "Raised", "Lead", "Cap", "Disc%", "MFN", "Pro-Rata", "Board", ""].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {rounds.map(r => (
                  <tr key={r.round_id} className="group hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <CellR rowId={r.round_id} field="name" value={r.name}
                      display={<span className="font-medium text-gray-900 dark:text-gray-100">{r.name}</span>} />
                    <CellR rowId={r.round_id} field="round_type" value={r.round_type}
                      editType="select" selectOptions={ROUND_TYPES}
                      display={<span className="text-xs font-medium text-gray-600 dark:text-gray-400">{ROUND_TYPE_LABELS[r.round_type] ?? r.round_type}</span>} />
                    <CellR rowId={r.round_id} field="status" value={r.status}
                      editType="select" selectOptions={ROUND_STATUSES}
                      display={
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROUND_STATUS_COLORS[r.status] ?? "bg-gray-100 text-gray-600"}`}>
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      } />
                    <CellR rowId={r.round_id} field="close_date" value={r.close_date ?? ""} placeholder="YYYY-MM-DD"
                      display={r.close_date
                        ? <span className="text-xs text-gray-600 dark:text-gray-400">{r.close_date}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="pre_money_val" value={r.pre_money_val ?? ""} placeholder="5000000"
                      display={r.pre_money_val
                        ? <span className="text-xs text-gray-700 dark:text-gray-300 tabular-nums">{fmtMoney(r.pre_money_val)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="amount_raised" value={r.amount_raised ?? ""} placeholder="500000"
                      display={r.amount_raised
                        ? <span className="text-xs font-medium text-green-700 dark:text-green-400 tabular-nums">{fmtMoney(r.amount_raised)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="lead_investor" value={r.lead_investor ?? ""} placeholder="Firm name…"
                      display={r.lead_investor
                        ? <span className="text-xs text-gray-700 dark:text-gray-300">{r.lead_investor}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="safe_cap" value={r.safe_cap ?? ""} placeholder="5000000"
                      display={r.safe_cap
                        ? <span className="text-xs text-gray-700 dark:text-gray-300 tabular-nums">{fmtMoney(r.safe_cap)}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellR rowId={r.round_id} field="discount_pct" value={r.discount_pct ?? ""} placeholder="20"
                      display={r.discount_pct
                        ? <span className="text-xs text-gray-700 dark:text-gray-300 tabular-nums">{r.discount_pct}%</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={r.mfn} readOnly
                        className="rounded pointer-events-none" />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={r.pro_rata_rights} readOnly
                        className="rounded pointer-events-none" />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={r.board_seat} readOnly
                        className="rounded pointer-events-none" />
                    </td>
                    <td className="px-3 py-3">
                      <button onClick={() => setDeletingRound(r)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        /* Documents tab */
        documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-52 gap-3">
            <svg className="w-10 h-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <p className="text-sm text-gray-500 dark:text-gray-400">No documents yet</p>
            <button onClick={() => setAddDoc(true)}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Add First Document
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  {["Type", "Name", "Holder", "Round", "Signed", "Notes", "Link", ""].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {documents.map(doc => (
                  <tr key={doc.document_id} className="group hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <CellD rowId={doc.document_id} field="doc_type" value={doc.doc_type}
                      editType="select" selectOptions={DOC_TYPES}
                      display={
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                          {DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}
                        </span>
                      } />
                    <CellD rowId={doc.document_id} field="name" value={doc.name}
                      display={
                        doc.url ? (
                          <a href={doc.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                            className="font-medium text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                            {doc.name}
                            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                            </svg>
                          </a>
                        ) : (
                          <span className="font-medium text-gray-900 dark:text-gray-100">{doc.name}</span>
                        )
                      } />
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {doc.holder_name ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {doc.round_name ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <CellD rowId={doc.document_id} field="signed_date" value={doc.signed_date ?? ""} placeholder="YYYY-MM-DD"
                      display={doc.signed_date
                        ? <span className="text-xs text-gray-600 dark:text-gray-400">{doc.signed_date}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellD rowId={doc.document_id} field="notes" value={doc.notes ?? ""} placeholder="Notes…" multiline
                      className="max-w-[180px]"
                      display={doc.notes
                        ? <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{doc.notes}</span>
                        : <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>} />
                    <CellD rowId={doc.document_id} field="url" value={doc.url ?? ""} placeholder="Paste Drive URL…"
                      display={
                        doc.url ? (
                          <div className="flex items-center gap-2">
                            <a href={doc.url} target="_blank" rel="noopener noreferrer" title="View"
                              className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z" /><circle cx="12" cy="12" r="3" />
                              </svg>
                            </a>
                            <a href={gDriveDownloadUrl(doc.url)} target="_blank" rel="noopener noreferrer" title="Download"
                              className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                              </svg>
                            </a>
                          </div>
                        ) : (
                          <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>
                        )
                      } />
                    <td className="px-4 py-3">
                      <button onClick={() => setDeletingDoc(doc)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 rounded transition-opacity">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Modals */}
      {addHolder && (
        <AddHolderModal onClose={() => setAddHolder(false)}
          onSaved={h => { setHolders(hs => [...hs, h]); setAddHolder(false); }} />
      )}
      {addRound && (
        <AddRoundModal onClose={() => setAddRound(false)}
          onSaved={r => { setRounds(rs => [...rs, r]); setAddRound(false); }} />
      )}
      {addDoc && (
        <AddDocumentModal holders={holders} rounds={rounds}
          onClose={() => setAddDoc(false)}
          onSaved={d => { setDocuments(ds => [...ds, d]); setAddDoc(false); }} />
      )}
      {selectedHolder && (
        <HolderDrawer holder={selectedHolder} rounds={rounds}
          onClose={() => setSelectedHolder(null)}
          onUpdated={load} />
      )}
      {deletingHolder && (
        <DeleteConfirm title={deletingHolder.name}
          onConfirm={() => deleteHolder(deletingHolder)} onCancel={() => setDeletingHolder(null)} />
      )}
      {deletingRound && (
        <DeleteConfirm title={deletingRound.name}
          onConfirm={() => deleteRound(deletingRound)} onCancel={() => setDeletingRound(null)} />
      )}
      {deletingDoc && (
        <DeleteConfirm title={deletingDoc.name}
          onConfirm={() => deleteDoc(deletingDoc)} onCancel={() => setDeletingDoc(null)} />
      )}
    </>
  );
}

// ── Applications settings ─────────────────────────────────────────────────────
// Everything that configures the Applications board rather than living on a
// record: the answers we reuse across applications, where new opportunities get
// found, and the funding type vocabulary.

type KbEntry = {
  entry_id: string;
  category: string;
  question: string;
  answer: string | null;
  links: string[];
  tags: string[];
  sort_order: number;
  updated_by_name: string | null;
  updated_at: string | null;
};

type ResearchPlatform = {
  platform_id: string;
  name: string;
  url: string | null;
  category: string | null;
  notes: string | null;
  is_active: boolean;
  last_checked: string | null;
  sort_order: number;
};

type SettingsSection = "kb" | "discovery" | "types";

const SETTINGS_SECTIONS: { id: SettingsSection; label: string; blurb: string }[] = [
  { id: "kb", label: "Open ERP Knowledge Base",
    blurb: "Answers and information used to fill out applications — general questions and requirements, information about us, links to videos and material, and documents." },
  { id: "discovery", label: "Opportunity Discovery",
    blurb: "Where new competitions, accelerators, grants and other opportunities get found." },
  { id: "types", label: "Funding Types",
    blurb: "The vocabulary behind the Funding Type dropdown." },
];

/** One knowledge base entry. Answers are long, so the body only mounts when the
 *  row is open — the panel routinely holds twenty-odd of these. */
function KbEntryRow({ entry, onChanged }: { entry: KbEntry; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(entry.answer ?? "");
  const [linkDraft, setLinkDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(entry.answer ?? ""); }, [entry.answer]);

  const answered = !!entry.answer?.trim();

  async function patch(fields: Partial<KbEntry>) {
    setSaving(true);
    await fetch(`/api/proxy/funding/kb/${entry.entry_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSaving(false);
    onChanged();
  }

  async function remove() {
    if (!confirm(`Delete "${entry.question}"?`)) return;
    await fetch(`/api/proxy/funding/kb/${entry.entry_id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
        {/* Answered / blank at a glance — the panel is a checklist as much as a store. */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${answered ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600"}`}
          title={answered ? "Answered" : "Not yet answered"} />
        <span className="flex-1 min-w-0 text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
          {entry.question}
        </span>
        {entry.links.length > 0 && (
          <span className="text-[10px] text-gray-400 shrink-0">{entry.links.length} link{entry.links.length === 1 ? "" : "s"}</span>
        )}
        <svg className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
          <AutoTextarea value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== (entry.answer ?? "")) patch({ answer: draft.trim() || null }); }}
            rows={4} placeholder="Answer — reused verbatim across applications…"
            className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none" />

          {entry.links.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.links.map((l) => (
                <span key={l} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-300">
                  <a href={l} target="_blank" rel="noopener noreferrer" className="truncate max-w-[220px] hover:underline">{l}</a>
                  <button onClick={() => patch({ links: entry.links.filter((x) => x !== l) })}
                    className="text-blue-300 hover:text-red-500" title="Remove link">×</button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && linkDraft.trim()) {
                  patch({ links: [...entry.links, linkDraft.trim()] });
                  setLinkDraft("");
                }
              }}
              placeholder="Add a link — video, deck, document…"
              className="flex-1 text-[11px] border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
            <span className="text-[10px] text-gray-400 shrink-0">
              {saving ? "Saving…" : entry.updated_by_name ? `Last edited by ${entry.updated_by_name}` : ""}
            </span>
            <button onClick={remove} className="text-gray-400 hover:text-red-500 shrink-0" title="Delete entry">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function KnowledgeBaseSection() {
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newCategory, setNewCategory] = useState("General");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/proxy/funding/kb");
    setEntries(res.ok ? await res.json() : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(entries.map((e) => e.category))), [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.question.toLowerCase().includes(q) || (e.answer ?? "").toLowerCase().includes(q));
  }, [entries, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, KbEntry[]>();
    filtered.forEach((e) => {
      if (!map.has(e.category)) map.set(e.category, []);
      map.get(e.category)!.push(e);
    });
    return Array.from(map.entries());
  }, [filtered]);

  const answered = entries.filter((e) => e.answer?.trim()).length;

  async function add() {
    const question = newQuestion.trim();
    if (!question) return;
    await fetch("/api/proxy/funding/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, category: newCategory.trim() || "General" }),
    });
    setNewQuestion("");
    load();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search questions and answers…"
          className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">
          {answered}/{entries.length} answered
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="text-xs text-gray-400 py-6 text-center">
          {search ? "Nothing matches that." : "No entries yet."}
        </p>
      ) : grouped.map(([category, rows]) => (
        <div key={category} className="space-y-1.5">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{category}</p>
          {rows.map((e) => <KbEntryRow key={e.entry_id} entry={e} onChanged={load} />)}
        </div>
      ))}

      <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
        <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
          list="kb-categories" placeholder="Category"
          className="w-32 shrink-0 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        <datalist id="kb-categories">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>
        <input value={newQuestion} onChange={(e) => setNewQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="New question or requirement…"
          className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        <button onClick={add} disabled={!newQuestion.trim()}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40 shrink-0">
          Add
        </button>
      </div>
    </div>
  );
}

/** One research platform. The descriptions carry real institutional knowledge —
 *  which sources already produced pipeline rows, which are blocked by the
 *  US-LLC incorporation constraint, which are paywalled — so the row expands to
 *  show it rather than burying it in a title attribute. */
function PlatformRow({ platform: p, onToggle, onSaveNotes, onRemove }: {
  platform: ResearchPlatform;
  onToggle: () => void;
  onSaveNotes: (notes: string) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(p.notes ?? "");
  useEffect(() => { setDraft(p.notes ?? ""); }, [p.notes]);

  return (
    <div className={`rounded-lg border transition-colors ${
      p.is_active
        ? "border-gray-200 dark:border-gray-800"
        : "border-dashed border-gray-200 dark:border-gray-800 opacity-60"
    }`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <input type="checkbox" checked={p.is_active} onChange={onToggle}
          className="accent-blue-600 cursor-pointer shrink-0"
          title={p.is_active ? "Included in sweeps" : "Excluded from sweeps"} />

        {/* The name toggles the description; the link is its own control, so a
            click never has to guess between reading and navigating away. */}
        <button onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left group">
          <svg className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="min-w-0">
            <span className="text-xs font-medium text-gray-800 dark:text-gray-200 group-hover:text-blue-600 truncate block">
              {p.name}
            </span>
            {p.category && (
              <span className="text-[10px] text-gray-400 truncate block">{p.category}</span>
            )}
          </span>
        </button>

        {p.url && (
          <a href={p.url} target="_blank" rel="noopener noreferrer"
            title={`Open ${p.url}`}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 text-[10px] font-medium text-gray-500 hover:text-blue-600 hover:border-blue-300 dark:hover:border-blue-700 transition-colors">
            Open
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}

        <button onClick={onRemove} className="text-gray-400 hover:text-red-500 shrink-0" title="Remove">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="px-2.5 pb-2.5 pt-1 space-y-2 border-t border-gray-100 dark:border-gray-800">
          {p.url && (
            <a href={p.url} target="_blank" rel="noopener noreferrer"
              className="text-[10px] text-blue-500 hover:underline break-all block">
              {p.url}
            </a>
          )}
          <AutoTextarea value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== (p.notes ?? "")) onSaveNotes(draft.trim()); }}
            rows={4} placeholder="What this source is, what it is good for, and what blocks us…"
            className="w-full text-[11px] leading-relaxed border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none" />
          {p.last_checked && (
            <p className="text-[10px] text-gray-400">
              Last checked {new Date(p.last_checked).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function OpportunityDiscoverySection() {
  const [platforms, setPlatforms] = useState<ResearchPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", url: "", category: "" });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/proxy/funding/research-platforms");
    setPlatforms(res.ok ? await res.json() : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const usedCategories = useMemo(
    () => Array.from(new Set(platforms.map((p) => p.category).filter(Boolean) as string[])).sort(),
    [platforms]);

  async function patch(id: string, fields: Partial<ResearchPlatform>) {
    await fetch(`/api/proxy/funding/research-platforms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    load();
  }

  async function add() {
    if (!form.name.trim()) return;
    await fetch("/api/proxy/funding/research-platforms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        url: form.url.trim() || null,
        category: form.category.trim() || null,
      }),
    });
    setForm({ name: "", url: "", category: "" });
    load();
  }

  async function remove(p: ResearchPlatform) {
    if (!confirm(`Remove "${p.name}"?`)) return;
    await fetch(`/api/proxy/funding/research-platforms/${p.platform_id}`, { method: "DELETE" });
    load();
  }

  const inputCls = "text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Opportunity Research Platforms</h4>
          <span className="text-[10px] text-gray-400">{platforms.filter((p) => p.is_active).length} active</span>
        </div>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Sources scanned for new competitions, accelerators and grants. Untick a source to
          keep it on the list without including it in a sweep.
        </p>

        {loading ? (
          <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>
        ) : platforms.length === 0 ? (
          <p className="text-xs text-gray-400 py-6 text-center">No platforms yet.</p>
        ) : (
          <div className="space-y-1">
            {platforms.map((p) => (
              <PlatformRow key={p.platform_id} platform={p}
                onToggle={() => patch(p.platform_id, { is_active: !p.is_active })}
                onSaveNotes={(notes) => patch(p.platform_id, { notes })}
                onRemove={() => remove(p)} />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Platform name" className={fixedWidth(inputCls, "w-40") + " shrink-0"} />
          <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="https://…" className={inputCls + " flex-1"} />
          {/* Offered from what is already in use — these read as descriptions
              ("Aggregator — grant database"), not as the funding-type vocabulary. */}
          <input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            list="platform-categories" placeholder="Type of source" className={fixedWidth(inputCls, "w-44") + " shrink-0"} />
          <datalist id="platform-categories">
            {usedCategories.map((c) => <option key={c} value={c} />)}
          </datalist>
          <button onClick={add} disabled={!form.name.trim()}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40 shrink-0">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

/** The funding type vocabulary, managed the way investor types are on the other
 *  tab — add, recolour, delete with reassignment. */
function FundingTypesSection() {
  const types = useFundingTypes();
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError("");
    const res = await fetch("/api/proxy/funding/funding-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setBusy(false);
    if (!res.ok) {
      const e = await res.json().catch(() => ({ detail: "Failed" }));
      setError(typeof e.detail === "string" && e.detail.includes("duplicate")
        ? "That type already exists." : "Could not add type.");
      return;
    }
    setNewName("");
    await refreshFundingTypes();
  }

  async function recolor(id: number, color: string) {
    await fetch(`/api/proxy/funding/funding-types/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    await refreshFundingTypes();
  }

  async function remove(id: number, count: number) {
    if (count > 0 && !confirm(`Clear the type on ${count} application(s) and delete it?`)) return;
    await fetch(`/api/proxy/funding/funding-types/${id}`, { method: "DELETE" });
    await refreshFundingTypes();
  }

  return (
    <div className="space-y-2">
      {types.map((t) => (
        <div key={t.id} className="flex items-center gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded font-medium shrink-0 ${optionChipClass(types, t.name)}`}>
            {t.name}
          </span>
          <span className="text-xs text-gray-400 shrink-0">{t.opportunity_count ?? 0}</span>
          <div className="flex items-center gap-1 ml-auto">
            {STATUS_COLOR_KEYS.map((c) => (
              <button key={c} onClick={() => recolor(t.id, c)} title={c}
                className={`w-4 h-4 rounded-full ${STATUS_DOT_CLASSES[c]} ${t.color === c ? "ring-2 ring-offset-1 ring-gray-400 dark:ring-offset-gray-900" : ""}`} />
            ))}
            <button onClick={() => remove(t.id, t.opportunity_count ?? 0)}
              className="ml-1 p-1 text-gray-400 hover:text-red-500" title="Delete type">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
        <input value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="New funding type…"
          className="flex-1 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40" />
        <button onClick={add} disabled={busy || !newName.trim()}
          className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-40">
          Add
        </button>
      </div>
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

function ApplicationsSettingsModal({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>("kb");
  const active = SETTINGS_SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-3xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Applications Settings</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <nav className="w-56 shrink-0 border-r border-gray-100 dark:border-gray-800 p-3 space-y-1 overflow-y-auto">
            {SETTINGS_SECTIONS.map((s) => (
              <button key={s.id} onClick={() => setSection(s.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  section === s.id
                    ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}>
                {s.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{active.label}</h3>
              <p className="text-[11px] text-gray-400 leading-relaxed mt-1">{active.blurb}</p>
            </div>
            {section === "kb"        && <KnowledgeBaseSection />}
            {section === "discovery" && <OpportunityDiscoverySection />}
            {section === "types"     && <FundingTypesSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

type FundingTab = "non-dilutive" | "dilutive" | "plan" | "rounds" | "management" | "reports";

function FundingContent() {
  const searchParams = useSearchParams();
  const activeTab = (searchParams.get("tab") ?? "non-dilutive") as FundingTab;

  // The shell hands this route the viewport and stops scrolling it, as it does
  // for /crm. The two board tabs use that height to fill the page; the
  // document-shaped tabs keep their padded, centred column and simply own the
  // scroll container now instead of borrowing the shell's.
  const board = activeTab === "non-dilutive" || activeTab === "dilutive";

  return (
    <div className="h-full flex flex-col min-h-0">
      {activeTab === "non-dilutive" && (
        <NonDilutiveTab forceAdd={false} onAddConsumed={() => {}} />
      )}
      {activeTab === "dilutive" && <DilutiveTab />}
      {!board && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-6 pb-24 space-y-5 max-w-7xl mx-auto">
            {activeTab === "plan" && <FundraisePlanTab />}
            {activeTab === "rounds" && <RoundsTab />}
            {activeTab === "management" && <ManagementTab />}
            {activeTab === "reports" && (
              <div className="flex items-center justify-center h-64">
                <p className="text-sm text-gray-400 dark:text-gray-500">Reports — coming soon.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FundingPage() {
  return <Suspense><FundingContent /></Suspense>;
}
