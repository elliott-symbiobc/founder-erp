"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import LogoImage from "@/components/LogoImage";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ──────────────────────────────────────────────────────────────────────

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
}

interface Invoice {
  invoice_id: string;
  invoice_number: string;
  contact_id: string | null;
  contact_name: string | null;
  contact_organization: string | null;
  contact_email: string | null;
  project_id: string | null;
  project_name: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  currency: string;
  line_items: LineItem[];
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  notes: string | null;
  created_at: string;
  // Stripe is the delivery and collection channel; the platform stays the
  // system of record. These come back from the invoice row itself.
  stripe_invoice_id: string | null;
  stripe_hosted_url: string | null;
  stripe_status: string | null;
  sent_at: string | null;
  document_url?: string | null;
  document_name?: string | null;
}

interface Contact {
  contact_id: string;
  name: string;
  organization: string | null;
}

interface Project {
  project_id: string;
  name: string;
}

interface Stats {
  by_status: Record<string, { count: number; total_value: number }>;
  grand_total: number;
}

interface CatalogItem {
  item_id: string;
  name: string;
  description: string | null;
  unit_price: number;
  unit: string;
  category: string | null;
}

interface FormattingSettings {
  companyName: string;
  companyTagline: string;
  companyAddress: string;
  companyEmail: string;
  companyWebsite: string;
  defaultCurrency: string;
  defaultPaymentTerms: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUSES = ["draft", "sent", "paid", "overdue", "cancelled"] as const;

const STATUS_STYLES: Record<string, string> = {
  draft:     "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  sent:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  paid:      "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  overdue:   "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300",
  cancelled: "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", sent: "Sent", paid: "Paid", overdue: "Overdue", cancelled: "Cancelled",
};

const STATUS_DOT: Record<string, string> = {
  draft: "bg-gray-400",
  sent: "bg-blue-500",
  paid: "bg-green-500",
  overdue: "bg-red-500",
  cancelled: "bg-gray-300",
};

const LS_FORMATTING_KEY = "founder_erp_invoice_formatting";

const DEFAULT_FORMATTING: FormattingSettings = {
  companyName: "Founder ERP",
  companyTagline: "",
  companyAddress: "",
  companyEmail: "",
  companyWebsite: "erp.example.com",
  defaultCurrency: "USD",
  defaultPaymentTerms: "",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtCurrency(amount: number | null, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function emptyLineItem(): LineItem {
  return { description: "", quantity: 1, unit_price: 0, amount: 0 };
}

function fmtTaxRate(rate: number) {
  // rate is stored as 0–1 (e.g. 0.085 = 8.5%); display up to 4 decimals, no trailing zeros
  return parseFloat((rate * 100).toFixed(4)).toString();
}

function calcTotals(lines: LineItem[], taxRateNum: number) {
  const subtotal  = lines.reduce((s, it) => s + it.amount, 0);
  const taxAmount = Math.round(subtotal * taxRateNum * 100) / 100;
  return { subtotal, taxAmount, total: subtotal + taxAmount };
}

function loadFormatting(): FormattingSettings {
  if (typeof window === "undefined") return DEFAULT_FORMATTING;
  try {
    const raw = localStorage.getItem(LS_FORMATTING_KEY);
    return raw ? { ...DEFAULT_FORMATTING, ...JSON.parse(raw) } : DEFAULT_FORMATTING;
  } catch {
    return DEFAULT_FORMATTING;
  }
}

// ── StyledSelect ──────────────────────────────────────────────────────────────


/** Pick a contact by typing, not by scrolling.
 *
 *  A <select> is fine for five options and unusable for a contact book: the
 *  only way to reach a name is to know where it sits in the list. This filters
 *  on name and organization as you type, keeps the keyboard working (arrows,
 *  Enter, Escape) and shows the current choice when closed.
 */
function ContactPicker({
  value, contacts, onChange, placeholder = "Search contacts…",
}: {
  value: string;
  contacts: Contact[];
  onChange: (contactId: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const chosen = contacts.find((c) => c.contact_id === value) ?? null;
  const label = (c: Contact) => c.name + (c.organization ? ` (${c.organization})` : "");

  const q = query.trim().toLowerCase();
  const matches = !q ? contacts : contacts.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    (c.organization ?? "").toLowerCase().includes(q));

  useEffect(() => {
    function away(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false); setQuery("");
      }
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const pick = (id: string) => { onChange(id); setOpen(false); setQuery(""); };

  const cls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg " +
              "px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 " +
              "focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400";

  return (
    <div className="relative" ref={box}>
      <input
        value={open ? query : (chosen ? label(chosen) : "")}
        placeholder={chosen ? label(chosen) : placeholder}
        onFocus={() => { setOpen(true); setQuery(""); setActive(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (matches[active]) pick(matches[active].contact_id);
          } else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
        className={cls} />

      {value && !open && (
        // Clearing has to be possible: "— No contact —" was a real choice in
        // the dropdown this replaces.
        <button type="button" onClick={() => onChange("")}
                title="clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400
                           hover:text-gray-700 dark:hover:text-gray-200 text-sm">
          ×
        </button>
      )}

      {open && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border
                        border-gray-200 bg-white shadow-lg dark:border-gray-700
                        dark:bg-gray-800">
          <button type="button" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick("")}
                  className="block w-full px-3 py-1.5 text-left text-sm text-gray-500
                             hover:bg-gray-50 dark:hover:bg-gray-700">
            — No contact —
          </button>
          {matches.map((c, i) => (
            <button key={c.contact_id} type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(c.contact_id)}
                    className={"block w-full px-3 py-1.5 text-left text-sm " +
                      (i === active ? "bg-blue-50 dark:bg-gray-700 " : "") +
                      "text-gray-800 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-gray-700"}>
              {c.name}
              {c.organization && (
                <span className="ml-1 text-xs text-gray-400">{c.organization}</span>
              )}
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-3 py-2 text-sm text-gray-400">
              No contact matches “{query}”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StyledSelect({
  value, onChange, children, className = "",
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        className={`w-full appearance-none text-sm pl-3 pr-8 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 cursor-pointer transition-colors ${className}`}
      >
        {children}
      </select>
      <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
}

// ── StatusSelect ──────────────────────────────────────────────────────────────

function StatusSelect({ value, onChange }: {
  value: string;
  onChange: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        className={`text-xs font-medium px-2.5 py-1 rounded flex items-center gap-1 transition-opacity hover:opacity-80 ${STATUS_STYLES[value]}`}
      >
        {STATUS_LABELS[value]}
        <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl py-1 min-w-[140px]">
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={(e) => { e.stopPropagation(); onChange(s); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${value === s ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-600 dark:text-gray-400"}`}
            >
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[s]}`} />
              {STATUS_LABELS[s]}
              {value === s && (
                <svg className="ml-auto w-3 h-3 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CatalogPicker ─────────────────────────────────────────────────────────────

function CatalogPicker({
  catalog, onPick, onClose,
}: {
  catalog: CatalogItem[];
  onPick: (item: CatalogItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = catalog.filter(
    (it) =>
      it.name.toLowerCase().includes(query.toLowerCase()) ||
      (it.category ?? "").toLowerCase().includes(query.toLowerCase()) ||
      (it.description ?? "").toLowerCase().includes(query.toLowerCase())
  );

  const groups: Record<string, CatalogItem[]> = {};
  for (const it of filtered) {
    const cat = it.category ?? "Uncategorised";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  }

  return (
    <div className="absolute z-50 mt-1 w-80 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl overflow-hidden">
      <div className="p-2 border-b border-gray-100 dark:border-gray-800">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search catalog…"
          className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {Object.keys(groups).length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-6">No items found</p>
        ) : (
          Object.entries(groups).map(([cat, items]) => (
            <div key={cat}>
              <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide px-3 pt-2 pb-1">{cat}</p>
              {items.map((it) => (
                <button
                  key={it.item_id}
                  onClick={() => { onPick(it); onClose(); }}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 text-left"
                >
                  <div>
                    <p className="text-sm text-gray-800 dark:text-gray-200">{it.name}</p>
                    {it.description && <p className="text-xs text-gray-400 truncate max-w-[180px]">{it.description}</p>}
                  </div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 ml-3 shrink-0">
                    {fmtCurrency(it.unit_price)}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="p-2 border-t border-gray-100 dark:border-gray-800">
        <button onClick={onClose} className="w-full text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── LineItemEditor ─────────────────────────────────────────────────────────────

function LineItemEditor({
  lines, setLines, catalog, currency, onSaveToCatalog,
}: {
  lines: LineItem[];
  setLines: (fn: (prev: LineItem[]) => LineItem[]) => void;
  catalog: CatalogItem[];
  currency?: string;
  onSaveToCatalog?: (item: LineItem) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  function update(i: number, key: keyof LineItem, raw: string) {
    setLines((ls) =>
      ls.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, [key]: key === "description" ? raw : parseFloat(raw) || 0 };
        if (key !== "description") next.amount = Math.round(next.quantity * next.unit_price * 100) / 100;
        return next;
      })
    );
  }

  function pickFromCatalog(item: CatalogItem) {
    setLines((ls) => [...ls, { description: item.name, quantity: 1, unit_price: item.unit_price, amount: item.unit_price }]);
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-12 gap-1.5 px-1">
        <span className="col-span-5 text-xs text-gray-400">Description</span>
        <span className="col-span-2 text-xs text-gray-400 text-right">Qty</span>
        <span className="col-span-2 text-xs text-gray-400 text-right">Unit Price</span>
        <span className="col-span-2 text-xs text-gray-400 text-right">Amount</span>
        <span className="col-span-1" />
      </div>

      {lines.map((item, i) => (
        <div key={i} className="grid grid-cols-12 gap-1.5 items-center group">
          <input
            value={item.description}
            onChange={(e) => update(i, "description", e.target.value)}
            placeholder="Description"
            className="col-span-5 text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="number" min="0" step="any"
            value={item.quantity}
            onChange={(e) => update(i, "quantity", e.target.value)}
            className="col-span-2 text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="number" min="0" step="any"
            value={item.unit_price}
            onChange={(e) => update(i, "unit_price", e.target.value)}
            className="col-span-2 text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <div className="col-span-2 text-xs text-right font-medium text-gray-700 dark:text-gray-300 pr-1">
            {fmtCurrency(item.amount, currency)}
          </div>
          <div className="col-span-1 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onSaveToCatalog && item.description.trim() && (
              <button
                onClick={() => onSaveToCatalog(item)}
                title="Save to catalog"
                className="text-gray-300 hover:text-blue-500 dark:text-gray-600 dark:hover:text-blue-400"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
              title="Remove"
              className="text-gray-300 hover:text-red-400 dark:text-gray-600 dark:hover:text-red-400"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 pt-0.5 relative" ref={pickerRef}>
        <button
          onClick={() => setLines((ls) => [...ls, emptyLineItem()])}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          + Add line
        </button>
        {catalog.length > 0 && (
          <>
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              From catalog
            </button>
            {pickerOpen && (
              <CatalogPicker
                catalog={catalog}
                onPick={pickFromCatalog}
                onClose={() => setPickerOpen(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── SaveToCatalogModal ────────────────────────────────────────────────────────

function SaveToCatalogModal({
  item, onSave, onClose,
}: {
  item: LineItem;
  onSave: (saved: CatalogItem) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(item.description);
  const [description, setDescription] = useState("");
  const [unitPrice, setUnitPrice] = useState(String(item.unit_price));
  const [unit, setUnit] = useState("each");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch("/api/proxy/invoices/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          unit_price: parseFloat(unitPrice) || 0,
          unit: unit || "each",
          category: category || null,
        }),
      });
      if (res.ok) { onSave(await res.json()); }
    } finally {
      setSaving(false);
    }
  }

  const fieldCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/30 dark:bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Save to Catalog</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={fieldCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit Price</label>
              <input type="number" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className={fieldCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Unit</label>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="each, hour, day…" className={fieldCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Category (optional)</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Lab Services, Equipment…" className={fieldCls} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700">Cancel</button>
          <button onClick={submit} disabled={saving || !name.trim()} className="text-sm text-white bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-lg disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const cards = [
    { label: "Total Outstanding", value: fmtCurrency(stats.grand_total), color: "text-gray-900 dark:text-gray-100" },
    { label: "Draft",   value: fmtCurrency(stats.by_status.draft?.total_value   ?? 0), color: "text-gray-500 dark:text-gray-400" },
    { label: "Sent",    value: fmtCurrency(stats.by_status.sent?.total_value    ?? 0), color: "text-blue-600 dark:text-blue-400" },
    { label: "Paid",    value: fmtCurrency(stats.by_status.paid?.total_value    ?? 0), color: "text-green-600 dark:text-green-400" },
    { label: "Overdue", value: fmtCurrency(stats.by_status.overdue?.total_value ?? 0), color: "text-red-600 dark:text-red-400" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
      {cards.map((c) => (
        <div key={c.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 px-4 py-3">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{c.label}</p>
          <p className={`text-sm font-semibold ${c.color}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ── Invoice Row ───────────────────────────────────────────────────────────────

function InvoiceRow({
  invoice, onSelect, onStatusChange, onDelete,
}: {
  invoice: Invoice;
  onSelect: (inv: Invoice) => void;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <tr
      className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer border-b border-gray-100 dark:border-gray-800 group"
      onClick={() => onSelect(invoice)}
    >
      <td className="px-4 py-3 text-sm font-mono text-gray-700 dark:text-gray-300 whitespace-nowrap">{invoice.invoice_number}</td>
      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        <div>{invoice.contact_name ?? <span className="text-gray-400">—</span>}</div>
        {invoice.contact_organization && <div className="text-xs text-gray-400">{invoice.contact_organization}</div>}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{invoice.project_name ?? "—"}</td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(invoice.issue_date)}</td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(invoice.due_date)}</td>
      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100 text-right whitespace-nowrap">{fmtCurrency(invoice.total, invoice.currency)}</td>
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <StatusSelect value={invoice.status} onChange={(s) => onStatusChange(invoice.invoice_id, s)} />
      </td>
      <td className="px-3 py-3 w-10" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => { if (confirm(`Delete ${invoice.invoice_number}?`)) onDelete(invoice.invoice_id); }}
          title="Delete invoice"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 dark:text-gray-700 dark:hover:text-red-400 p-1 rounded"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

// ── Invoice Panel ─────────────────────────────────────────────────────────────


/** Send, collect, and reconcile through Stripe.
 *
 *  Every button here is one call to stripe_billing.py. The platform remains
 *  the system of record: sending pushes a copy to Stripe and lets Stripe email
 *  a payable invoice, and the webhook writes payment back — so an invoice paid
 *  in Stripe becomes paid here without anyone re-typing it.
 *
 *  Sync exists because a webhook can be missed: it pulls Stripe's current view
 *  of one invoice rather than assuming ours is right.
 */
function StripeActions({ invoice, onRefresh }: {
  invoice: Invoice;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const call = async (action: string, label: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(action); setNote(""); setLink(null);
    try {
      const r = await fetch(
        `/api/proxy/stripe/invoices/${invoice.invoice_id}/${action}`,
        { method: "POST", cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail ?? `${label} failed (${r.status})`);
      if (action === "payment-link") setLink(d.hosted_invoice_url ?? d.payment_url ?? null);
      setNote(action === "send" && d.emailed_to
        ? `Emailed to ${d.emailed_to}.`
        : `${label} done.`);
      onRefresh();
    } catch (e: any) {
      setNote(String(e?.message ?? e));
    } finally { setBusy(""); }
  };

  const sent = Boolean(invoice.stripe_invoice_id);
  const btn = "text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50";

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Stripe</span>
        {invoice.stripe_status && (
          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[10px]
                           text-gray-600 dark:border-gray-700 dark:text-gray-400">
            {invoice.stripe_status}
          </span>
        )}
        {invoice.sent_at && (
          <span className="text-[10px] text-gray-400">
            sent {new Date(invoice.sent_at).toLocaleDateString()}
          </span>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {!sent && (
            <button onClick={() => call("send", "Send",
                      `Email this invoice to ${invoice.contact_email ?? "the contact"} via Stripe?`)}
                    disabled={!!busy || !invoice.contact_email}
                    title={invoice.contact_email
                      ? "push to Stripe, finalize, and let Stripe email it"
                      : "the contact has no email address"}
                    className={btn + " border-blue-200 text-blue-600 hover:bg-blue-50 dark:border-blue-900"}>
              {busy === "send" ? "Sending…" : "Send via Stripe"}
            </button>
          )}
          <button onClick={() => call("payment-link", "Payment link")}
                  disabled={!!busy}
                  title="finalize and return a payable URL without emailing"
                  className={btn + " border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700"}>
            {busy === "payment-link" ? "Creating…" : "Payment link"}
          </button>
          {sent && (
            <>
              <button onClick={() => call("resend", "Resend", "Email this invoice again?")}
                      disabled={!!busy}
                      className={btn + " border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700"}>
                {busy === "resend" ? "Resending…" : "Resend"}
              </button>
              <button onClick={() => call("sync", "Sync")} disabled={!!busy}
                      title="pull Stripe's current view — a webhook can be missed"
                      className={btn + " border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700"}>
                {busy === "sync" ? "Syncing…" : "Sync"}
              </button>
              <button onClick={() => call("void", "Void",
                        "Void this invoice in Stripe? Ours is left as it is.")}
                      disabled={!!busy}
                      className={btn + " border-red-200 text-red-500 hover:bg-red-50 dark:border-red-900"}>
                Void
              </button>
            </>
          )}
        </div>
      </div>

      {(invoice.stripe_hosted_url || link) && (
        <a href={(link ?? invoice.stripe_hosted_url) as string} target="_blank" rel="noreferrer"
           className="mt-2 block truncate text-xs text-blue-600 hover:underline">
          {link ? "Payment link — " : "Hosted invoice — "}
          {link ?? invoice.stripe_hosted_url}
        </a>
      )}
      {note && <p className="mt-2 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

function InvoicePanel({
  invoice, catalog, contacts, projects, onClose, onDelete, onRefresh, onCatalogUpdate,
}: {
  invoice: Invoice;
  catalog: CatalogItem[];
  contacts: Contact[];
  projects: Project[];
  onClose: () => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onCatalogUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Invoice>>({});
  const [editLines, setEditLines] = useState<LineItem[]>([]);
  const [editTaxRate, setEditTaxRate] = useState("0");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saveToCatalogItem, setSaveToCatalogItem] = useState<LineItem | null>(null);

  useEffect(() => {
    setForm({
      status: invoice.status,
      contact_id: invoice.contact_id ?? "",
      project_id: invoice.project_id ?? "",
      issue_date: invoice.issue_date ?? "",
      due_date: invoice.due_date ?? "",
      paid_date: invoice.paid_date ?? "",
      notes: invoice.notes ?? "",
    });
    setEditLines((invoice.line_items ?? []).map((it) => ({ ...it })));
    setEditTaxRate(String(Math.round((invoice.tax_rate ?? 0) * 100 * 100) / 100));
    setEditing(false);
  }, [invoice.invoice_id]);

  const editTaxRateNum = parseFloat(editTaxRate) / 100 || 0;
  const { subtotal: editSubtotal, taxAmount: editTaxAmount, total: editTotal } = calcTotals(editLines, editTaxRateNum);

  async function downloadPdf() {
    setDownloading(true);
    try {
      const fmt = loadFormatting();
      const params = new URLSearchParams();
      if (fmt.companyName)    params.set("company_name",    fmt.companyName);
      if (fmt.companyTagline) params.set("company_tagline", fmt.companyTagline);
      if (fmt.companyAddress) params.set("company_address", fmt.companyAddress);
      if (fmt.companyEmail)   params.set("company_email",   fmt.companyEmail);
      if (fmt.companyWebsite) params.set("company_website", fmt.companyWebsite);
      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/proxy/invoices/${invoice.invoice_id}/pdf${query}`);
      if (!res.ok) throw new Error("PDF generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${invoice.invoice_number}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  }

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/proxy/invoices/${invoice.invoice_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: form.status,
          contact_id: form.contact_id || null,
          project_id: form.project_id || null,
          issue_date: form.issue_date || null,
          due_date: form.due_date || null,
          paid_date: form.paid_date || null,
          notes: form.notes || null,
          line_items: editLines.filter((it) => it.description.trim()),
          tax_rate: editTaxRateNum,
        }),
      });
      onRefresh();
      setEditing(false);
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-800 shadow-xl flex flex-col overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <p className="text-xs text-gray-400 font-mono">{invoice.invoice_number}</p>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{invoice.contact_name ?? "No contact"}</h2>
            {invoice.project_name && <p className="text-xs text-gray-400 mt-0.5">{invoice.project_name}</p>}
          </div>
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} className="text-xs text-gray-400 hover:text-gray-600 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700">Cancel</button>
                <button onClick={save} disabled={saving} className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg disabled:opacity-50">
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            ) : (
              <>
                <button onClick={downloadPdf} disabled={downloading}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-50 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {downloading ? "Generating…" : "PDF"}
                </button>
                <button onClick={() => setEditing(true)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 transition-colors">Edit</button>
                <button
                  onClick={() => { if (confirm("Delete this invoice?")) onDelete(invoice.invoice_id); }}
                  className="text-xs text-red-500 hover:text-red-700 px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900 transition-colors"
                >
                  Delete
                </button>
              </>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 ml-1">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-5">

          {!editing && <StripeActions invoice={invoice} onRefresh={onRefresh} />}

          {/* Contact + Project (editable) */}
          {editing && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-400 mb-1">Contact</p>
                <ContactPicker value={form.contact_id ?? ""} contacts={contacts}
                               onChange={(id) => setForm((f) => ({ ...f, contact_id: id }))} />
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">Project</p>
                <StyledSelect value={form.project_id ?? ""} onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}>
                  <option value="">— No project —</option>
                  {projects.map((p) => (
                    <option key={p.project_id} value={p.project_id}>{p.name}</option>
                  ))}
                </StyledSelect>
              </div>
            </div>
          )}

          {/* Status + Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-400 mb-1">Status</p>
              {editing ? (
                <StyledSelect value={form.status ?? ""} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </StyledSelect>
              ) : (
                <span className={`inline-block text-xs font-medium px-2.5 py-1 rounded ${STATUS_STYLES[invoice.status]}`}>
                  {STATUS_LABELS[invoice.status]}
                </span>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Issue Date</p>
              {editing ? (
                <input type="date" value={form.issue_date ?? ""} onChange={(e) => setForm((f) => ({ ...f, issue_date: e.target.value }))}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              ) : (
                <p className="text-sm text-gray-700 dark:text-gray-300">{fmtDate(invoice.issue_date)}</p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Due Date</p>
              {editing ? (
                <input type="date" value={form.due_date ?? ""} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              ) : (
                <p className="text-sm text-gray-700 dark:text-gray-300">{fmtDate(invoice.due_date)}</p>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-400 mb-1">Paid Date</p>
              {editing ? (
                <input type="date" value={form.paid_date ?? ""} onChange={(e) => setForm((f) => ({ ...f, paid_date: e.target.value }))}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              ) : (
                <p className="text-sm text-gray-700 dark:text-gray-300">{fmtDate(invoice.paid_date)}</p>
              )}
            </div>
          </div>

          {/* Line Items */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Line Items</p>
            {editing ? (
              <LineItemEditor
                lines={editLines}
                setLines={setEditLines}
                catalog={catalog}
                currency={invoice.currency}
                onSaveToCatalog={(it) => setSaveToCatalogItem(it)}
              />
            ) : (
              <div className="border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400">
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium w-16">Qty</th>
                      <th className="px-3 py-2 text-right font-medium w-24">Unit Price</th>
                      <th className="px-3 py-2 text-right font-medium w-24">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(invoice.line_items ?? []).map((item, i) => (
                      <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{item.description}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{item.quantity}</td>
                        <td className="px-3 py-2 text-right text-gray-600 dark:text-gray-400">{fmtCurrency(item.unit_price, invoice.currency)}</td>
                        <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300">{fmtCurrency(item.amount, invoice.currency)}</td>
                      </tr>
                    ))}
                    {(!invoice.line_items || invoice.line_items.length === 0) && (
                      <tr><td colSpan={4} className="px-3 py-3 text-center text-gray-400 text-xs">No line items</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Totals */}
          <div className="border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1.5">
            {editing ? (
              <>
                <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>Subtotal</span><span>{fmtCurrency(editSubtotal, invoice.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>Tax Rate (%)</span>
                  <input
                    type="number" min="0" max="100" step="any"
                    value={editTaxRate}
                    onChange={(e) => setEditTaxRate(e.target.value)}
                    className="w-24 text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-right focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
                  />
                </div>
                {editTaxAmount > 0 && (
                  <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                    <span>Tax Amount</span><span>{fmtCurrency(editTaxAmount, invoice.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold text-gray-900 dark:text-gray-100 pt-1.5 border-t border-gray-100 dark:border-gray-800">
                  <span>Total</span><span>{fmtCurrency(editTotal, invoice.currency)}</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>Subtotal</span><span>{fmtCurrency(invoice.subtotal, invoice.currency)}</span>
                </div>
                {/* Tax rate — click Edit to change */}
                <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>Tax Rate</span>
                  <span className="flex items-center gap-1.5">
                    {fmtTaxRate(invoice.tax_rate)}%
                    <button
                      onClick={() => setEditing(true)}
                      title="Edit tax rate"
                      className="text-gray-300 hover:text-blue-500 dark:text-gray-600 dark:hover:text-blue-400 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                  </span>
                </div>
                {invoice.tax_rate > 0 && (
                  <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                    <span>Tax Amount</span>
                    <span>{fmtCurrency(invoice.tax_amount, invoice.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold text-gray-900 dark:text-gray-100 pt-1 border-t border-gray-100 dark:border-gray-800">
                  <span>Total</span><span>{fmtCurrency(invoice.total, invoice.currency)}</span>
                </div>
              </>
            )}
          </div>

          {/* Notes */}
          {(invoice.notes || editing) && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">Notes</p>
              {editing ? (
                <AutoTextarea value={form.notes ?? ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={3} placeholder="Add notes…"
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              ) : (
                <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{invoice.notes}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {saveToCatalogItem && (
        <SaveToCatalogModal
          item={saveToCatalogItem}
          onSave={() => { setSaveToCatalogItem(null); onCatalogUpdate(); }}
          onClose={() => setSaveToCatalogItem(null)}
        />
      )}
    </div>
  );
}

// ── New Invoice Modal ─────────────────────────────────────────────────────────

function NewInvoiceModal({
  contacts, projects, catalog, onClose, onCreated, onCatalogUpdate,
}: {
  contacts: Contact[];
  projects: Project[];
  catalog: CatalogItem[];
  onClose: () => void;
  onCreated: () => void;
  onCatalogUpdate: () => void;
}) {
  const fmt = loadFormatting();
  const [form, setForm] = useState({
    contact_id: "", project_id: "", status: "draft",
    issue_date: new Date().toISOString().slice(0, 10),
    due_date: "", currency: fmt.defaultCurrency || "USD",
    tax_rate: "0",
    notes: fmt.defaultPaymentTerms || "",
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLineItem()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveToCatalogItem, setSaveToCatalogItem] = useState<LineItem | null>(null);

  function setField(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  const taxRateNum = parseFloat(form.tax_rate) / 100 || 0;
  const { subtotal, taxAmount, total } = calcTotals(lineItems, taxRateNum);

  const inputCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400";

  async function submit() {
    if (!lineItems.some((it) => it.description.trim())) {
      setError("Add at least one line item with a description.");
      return;
    }
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/proxy/invoices/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: form.contact_id || null,
          project_id: form.project_id || null,
          status: form.status,
          issue_date: form.issue_date || null,
          due_date: form.due_date || null,
          currency: form.currency,
          line_items: lineItems.filter((it) => it.description.trim()),
          tax_rate: taxRateNum,
          notes: form.notes || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create invoice");
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      <div className="absolute inset-0 bg-black/30 dark:bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">New Invoice</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-5">
          {/* Contact + Project */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Bill To (Contact)</label>
              <ContactPicker value={form.contact_id} contacts={contacts}
                             onChange={(id) => setField("contact_id", id)} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Project</label>
              <StyledSelect value={form.project_id} onChange={(e) => setField("project_id", e.target.value)}>
                <option value="">— No project —</option>
                {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
              </StyledSelect>
            </div>
          </div>
          {/* Dates + Status + Currency */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Issue Date</label>
              <input type="date" value={form.issue_date} onChange={(e) => setField("issue_date", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Due Date</label>
              <input type="date" value={form.due_date} onChange={(e) => setField("due_date", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Status</label>
              <StyledSelect value={form.status} onChange={(e) => setField("status", e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </StyledSelect>
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Currency</label>
              <StyledSelect value={form.currency} onChange={(e) => setField("currency", e.target.value)}>
                {["USD","EUR","GBP","CAD","AUD"].map(c => <option key={c} value={c}>{c}</option>)}
              </StyledSelect>
            </div>
          </div>
          {/* Line Items */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Line Items</p>
            <LineItemEditor
              lines={lineItems}
              setLines={setLineItems}
              catalog={catalog}
              currency={form.currency}
              onSaveToCatalog={(it) => setSaveToCatalogItem(it)}
            />
          </div>
          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64 space-y-1.5">
              <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                <span>Subtotal</span><span>{fmtCurrency(subtotal, form.currency)}</span>
              </div>
              <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                <span>Tax Rate (%)</span>
                <input type="number" min="0" max="100" step="any" value={form.tax_rate}
                  onChange={(e) => setField("tax_rate", e.target.value)}
                  className="w-24 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-right focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400" />
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>Tax Amount</span><span>{fmtCurrency(taxAmount, form.currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-semibold text-gray-900 dark:text-gray-100 pt-1.5 border-t border-gray-100 dark:border-gray-800">
                <span>Total</span><span>{fmtCurrency(total, form.currency)}</span>
              </div>
            </div>
          </div>
          {/* Notes */}
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Notes (optional)</label>
            <AutoTextarea value={form.notes} onChange={(e) => setField("notes", e.target.value)} rows={2}
              placeholder="Payment terms, references, etc."
              className={`${inputCls} resize-none`} />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700">Cancel</button>
            <button onClick={submit} disabled={saving} className="text-sm text-white bg-blue-600 hover:bg-blue-700 px-5 py-2 rounded-lg disabled:opacity-50 font-medium">
              {saving ? "Creating…" : "Create Invoice"}
            </button>
          </div>
        </div>
      </div>

      {saveToCatalogItem && (
        <SaveToCatalogModal
          item={saveToCatalogItem}
          onSave={() => { setSaveToCatalogItem(null); onCatalogUpdate(); }}
          onClose={() => setSaveToCatalogItem(null)}
        />
      )}
    </div>
  );
}

// ── Catalog Tab ───────────────────────────────────────────────────────────────

function CatalogTab({
  catalog, onRefresh,
}: {
  catalog: CatalogItem[];
  onRefresh: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<CatalogItem>>({});
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ name: "", description: "", unit_price: "", unit: "each", category: "" });
  const [saving, setSaving] = useState(false);

  const groups: Record<string, CatalogItem[]> = {};
  for (const it of catalog) {
    const cat = it.category ?? "Uncategorised";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(it);
  }

  async function saveEdit(id: string) {
    setSaving(true);
    try {
      await fetch(`/api/proxy/invoices/catalog/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          description: editForm.description || null,
          unit_price: editForm.unit_price,
          unit: editForm.unit,
          category: editForm.category || null,
        }),
      });
      setEditingId(null);
      onRefresh();
    } finally { setSaving(false); }
  }

  async function deleteItem(id: string) {
    if (!confirm("Remove this catalog item?")) return;
    await fetch(`/api/proxy/invoices/catalog/${id}`, { method: "DELETE" });
    onRefresh();
  }

  async function createItem() {
    if (!newForm.name.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/proxy/invoices/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newForm.name,
          description: newForm.description || null,
          unit_price: parseFloat(newForm.unit_price) || 0,
          unit: newForm.unit || "each",
          category: newForm.category || null,
        }),
      });
      setShowNew(false);
      setNewForm({ name: "", description: "", unit_price: "", unit: "each", category: "" });
      onRefresh();
    } finally { setSaving(false); }
  }

  const inputCls = "text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 w-full focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400";

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {catalog.length} saved item{catalog.length !== 1 ? "s" : ""} — pick from catalog when editing any invoice
        </p>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Item
        </button>
      </div>

      {showNew && (
        <div className="mb-4 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-xl p-4 space-y-3">
          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300">New Catalog Item</p>
          <div className="grid grid-cols-12 gap-2">
            <input value={newForm.name} onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Name *" className={`col-span-4 ${inputCls}`} />
            <input value={newForm.description} onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Description" className={`col-span-4 ${inputCls}`} />
            <input type="number" min="0" step="any" value={newForm.unit_price}
              onChange={(e) => setNewForm((f) => ({ ...f, unit_price: e.target.value }))}
              placeholder="Price" className={`col-span-2 ${inputCls}`} />
            <input value={newForm.unit} onChange={(e) => setNewForm((f) => ({ ...f, unit: e.target.value }))}
              placeholder="Unit" className={`col-span-2 ${inputCls}`} />
          </div>
          <div className="grid grid-cols-12 gap-2 items-center">
            <input value={newForm.category} onChange={(e) => setNewForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="Category (optional)" className={`col-span-4 ${inputCls}`} />
            <div className="col-span-8 flex justify-end gap-2">
              <button onClick={() => setShowNew(false)} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700">Cancel</button>
              <button onClick={createItem} disabled={saving || !newForm.name.trim()}
                className="text-sm text-white bg-blue-600 hover:bg-blue-700 px-4 py-1 rounded-lg disabled:opacity-50 transition-colors">
                {saving ? "Saving…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

      {catalog.length === 0 && !showNew ? (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-400 mb-2">No catalog items yet</p>
          <p className="text-xs text-gray-400">Save a line item from any invoice using the bookmark icon, or add one above.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-left font-medium">Category</th>
                <th className="px-4 py-3 text-right font-medium">Unit Price</th>
                <th className="px-4 py-3 text-left font-medium">Unit</th>
                <th className="px-4 py-3 w-20" />
              </tr>
            </thead>
            <tbody>
              {catalog.map((it) => (
                <tr key={it.item_id} className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  {editingId === it.item_id ? (
                    <>
                      <td className="px-3 py-2"><input value={editForm.name ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} /></td>
                      <td className="px-3 py-2"><input value={editForm.description ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} className={inputCls} /></td>
                      <td className="px-3 py-2"><input value={editForm.category ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))} className={inputCls} /></td>
                      <td className="px-3 py-2"><input type="number" min="0" step="any" value={editForm.unit_price ?? 0} onChange={(e) => setEditForm((f) => ({ ...f, unit_price: parseFloat(e.target.value) || 0 }))} className={`${inputCls} text-right`} /></td>
                      <td className="px-3 py-2"><input value={editForm.unit ?? ""} onChange={(e) => setEditForm((f) => ({ ...f, unit: e.target.value }))} className={inputCls} /></td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 justify-end">
                          <button onClick={() => setEditingId(null)} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700">Cancel</button>
                          <button onClick={() => saveEdit(it.item_id)} disabled={saving} className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded-lg disabled:opacity-50">Save</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200 font-medium">{it.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 max-w-[200px] truncate">{it.description ?? "—"}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{it.category ?? "—"}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-800 dark:text-gray-200 text-right">{fmtCurrency(it.unit_price)}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{it.unit}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <button onClick={() => { setEditingId(it.item_id); setEditForm({ ...it }); }}
                            className="text-xs text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Edit</button>
                          <button onClick={() => deleteItem(it.item_id)}
                            className="text-xs text-red-400 hover:text-red-600">Delete</button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Formatting Tab ────────────────────────────────────────────────────────────

function FormattingTab() {
  const [settings, setSettings] = useState<FormattingSettings>(DEFAULT_FORMATTING);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setSettings(loadFormatting()); }, []);

  function set(key: keyof FormattingSettings, value: string) {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function save() {
    localStorage.setItem(LS_FORMATTING_KEY, JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const fieldCls = "w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors";

  return (
    <div className="max-w-2xl space-y-8">

      {/* Logo */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Logo</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Appears in PDF invoice headers. Upload or change your logo in{" "}
          <a href="/settings" className="text-blue-600 dark:text-blue-400 hover:underline">Settings</a>.
        </p>
        <div className="flex items-center gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
          <div className="h-12 w-36 flex items-center">
            <LogoImage className="h-10 w-auto max-w-[130px] object-contain" />
          </div>
          <a href="/settings" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            Change logo →
          </a>
        </div>
      </div>

      {/* Company Info */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Company Info</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Printed in the PDF invoice header.</p>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Company Name</label>
              <input value={settings.companyName} onChange={(e) => set("companyName", e.target.value)} className={fieldCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tagline</label>
              <input value={settings.companyTagline} onChange={(e) => set("companyTagline", e.target.value)} placeholder="e.g. Operations Technology" className={fieldCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Address</label>
            <input value={settings.companyAddress} onChange={(e) => set("companyAddress", e.target.value)} placeholder="123 Main St, City, State ZIP" className={fieldCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Email</label>
              <input value={settings.companyEmail} onChange={(e) => set("companyEmail", e.target.value)} placeholder="billing@company.com" className={fieldCls} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Website</label>
              <input value={settings.companyWebsite} onChange={(e) => set("companyWebsite", e.target.value)} placeholder="company.com" className={fieldCls} />
            </div>
          </div>
        </div>
      </div>

      {/* Invoice Defaults */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Invoice Defaults</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Pre-filled values when creating a new invoice.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Default Currency</label>
            <div className="relative max-w-xs">
              <select
                value={settings.defaultCurrency}
                onChange={(e) => set("defaultCurrency", e.target.value)}
                className={`${fieldCls} appearance-none pr-8`}
              >
                <option value="USD">USD — US Dollar</option>
                <option value="EUR">EUR — Euro</option>
                <option value="GBP">GBP — British Pound</option>
                <option value="CAD">CAD — Canadian Dollar</option>
                <option value="AUD">AUD — Australian Dollar</option>
              </select>
              <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Default Payment Terms</label>
            <AutoTextarea
              value={settings.defaultPaymentTerms}
              onChange={(e) => set("defaultPaymentTerms", e.target.value)}
              rows={2}
              placeholder="e.g. Net 30. Payment due within 30 days of invoice date."
              className={`${fieldCls} resize-none`}
            />
            <p className="text-xs text-gray-400 mt-1">Pre-fills the notes field on new invoices.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 pb-4">
        <button onClick={save} className="text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 px-5 py-2 rounded-lg transition-colors">
          Save Settings
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Saved
          </span>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReceivablesPage() {
  const [tab, setTab] = useState<"invoices" | "catalog" | "formatting">("invoices");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const params = filterStatus ? `?status=${filterStatus}` : "";
      const [invRes, statsRes] = await Promise.all([
        fetch(`/api/proxy/invoices/${params}`),
        fetch("/api/proxy/invoices/stats"),
      ]);
      if (invRes.ok) { const d = await invRes.json(); setInvoices(d.invoices ?? []); }
      if (statsRes.ok) setStats(await statsRes.json());
    } finally { setLoading(false); }
  }, [filterStatus]);

  const loadCatalog = useCallback(async () => {
    const res = await fetch("/api/proxy/invoices/catalog");
    if (res.ok) { const d = await res.json(); setCatalog(d.items ?? []); }
  }, []);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  useEffect(() => {
    Promise.all([
      fetch("/api/proxy/contacts/?limit=500").then((r) => r.ok ? r.json() : { contacts: [] }),
      fetch("/api/proxy/projects/?limit=500").then((r) => r.ok ? r.json() : { projects: [] }),
    ]).then(([cd, pd]) => { setContacts(cd.contacts ?? []); setProjects(pd.projects ?? []); });
  }, []);

  async function handleStatusChange(id: string, status: string) {
    await fetch(`/api/proxy/invoices/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadInvoices();
    if (selectedInvoice?.invoice_id === id) {
      const res = await fetch(`/api/proxy/invoices/${id}`);
      if (res.ok) setSelectedInvoice(await res.json());
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/proxy/invoices/${id}`, { method: "DELETE" });
    setSelectedInvoice(null);
    loadInvoices();
  }

  async function handleRefresh() {
    loadInvoices();
    if (selectedInvoice) {
      const res = await fetch(`/api/proxy/invoices/${selectedInvoice.invoice_id}`);
      if (res.ok) setSelectedInvoice(await res.json());
    }
  }

  function tabLabel(t: string) {
    if (t === "catalog") return `Catalog${catalog.length > 0 ? ` (${catalog.length})` : ""}`;
    if (t === "formatting") return "Formatting";
    return "Receivables";
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Receivables</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {stats ? `${invoices.length} invoice${invoices.length !== 1 ? "s" : ""}` : "Loading…"}
          </p>
        </div>
        {tab === "invoices" && (
          <button onClick={() => setShowNew(true)}
            className="flex items-center gap-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Invoice
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-800">
        {(["invoices", "catalog", "formatting"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}>
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {tab === "catalog" ? (
        <CatalogTab catalog={catalog} onRefresh={loadCatalog} />
      ) : tab === "formatting" ? (
        <FormattingTab />
      ) : (
        <>
          <StatsBar stats={stats} />

          {/* Filter */}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-gray-400">Filter:</span>
            {["", ...STATUSES].map((s) => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className={`text-xs px-3 py-1.5 rounded transition-colors ${
                  filterStatus === s
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}>
                {s === "" ? "All" : STATUS_LABELS[s]}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
            ) : invoices.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-sm text-gray-400 mb-2">No invoices yet</p>
                <button onClick={() => setShowNew(true)} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
                  Create your first invoice
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                      <th className="px-4 py-3 text-left font-medium">Invoice #</th>
                      <th className="px-4 py-3 text-left font-medium">Client</th>
                      <th className="px-4 py-3 text-left font-medium">Project</th>
                      <th className="px-4 py-3 text-left font-medium">Issued</th>
                      <th className="px-4 py-3 text-left font-medium">Due</th>
                      <th className="px-4 py-3 text-right font-medium">Total</th>
                      <th className="px-4 py-3 text-left font-medium">Status</th>
                      <th className="px-3 py-3 w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <InvoiceRow
                        key={inv.invoice_id}
                        invoice={inv}
                        onSelect={setSelectedInvoice}
                        onStatusChange={handleStatusChange}
                        onDelete={handleDelete}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Detail Panel */}
      {selectedInvoice && (
        <InvoicePanel
          invoice={selectedInvoice}
          catalog={catalog}
          contacts={contacts}
          projects={projects}
          onClose={() => setSelectedInvoice(null)}
          onDelete={handleDelete}
          onRefresh={handleRefresh}
          onCatalogUpdate={loadCatalog}
        />
      )}

      {/* New Invoice Modal */}
      {showNew && (
        <NewInvoiceModal
          contacts={contacts}
          projects={projects}
          catalog={catalog}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadInvoices(); }}
          onCatalogUpdate={loadCatalog}
        />
      )}
    </div>
  );
}
