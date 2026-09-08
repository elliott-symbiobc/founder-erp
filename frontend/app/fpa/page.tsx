"use client";

import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { AutoTextarea } from "@/components/AutoTextarea";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
  PieChart, Pie, Cell, ReferenceArea,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────

interface AnnualData {
  year: number;
  // Revenue streams
  rd_contract_revenue?: number;
  portfolio_revenue?: number;
  maintenance_revenue?: number;
  grant_revenue?: number;
  consumable_revenue?: number;
  licensing_revenue?: number;
  total_revenue?: number;
  revenue: number; // alias for total_revenue
  direct_expenses?: number;
  gross_margin?: number;
  // Expense categories
  tech_comp?: number;
  exec_comp?: number;
  ga_comp?: number;
  sales_comp?: number;
  office_expense?: number;
  legal_accounting?: number;
  software?: number;
  total_opex: number;
  ebitda: number;
}

interface MonthlyData {
  year: number;
  month: number;
  month_name: string;
  rd_contract_revenue: number;
  portfolio_revenue: number;
  maintenance_revenue: number;
  grant_revenue: number;
  consumable_revenue: number;
  licensing_revenue: number;
  total_revenue: number;
  tech_comp: number;
  exec_comp: number;
  ga_comp: number;
  sales_comp: number;
  office_expense: number;
  legal_accounting: number;
  software: number;
  total_opex: number;
  ebitda: number;
  gross_margin?: number;
  direct_expenses?: number;
}

interface EquityRound {
  round: number;
  amount: number;
  date: string;
  notes: string;
}

interface ContractEntry {
  id: string;
  name: string;
  type: "rd_contract" | "portfolio" | "maintenance" | "grant" | "consumable_recurring" | "licensing_recurring";
  client: string;
  start_date: string;
  end_date: string;          // recurring: optional end; fixed: unused
  duration_months: number;   // fixed contracts only
  total_value: number;       // fixed contracts only
  monthly_amount: number;    // recurring contracts only
  annual_increase_pct: number; // recurring: annual growth rate
  probability: number;
  status: "active" | "pipeline" | "completed";
  notes: string;
  // post-contract recurring
  recurring_after_fixed?: boolean;
  recurring_consumable_amount?: number;
  recurring_licensing_amount?: number;
  recurring_years?: number;
  tags?: string[];
}

interface HeadcountEntry {
  id: string;
  role: string;
  department: "tech" | "exec" | "ga" | "sales";
  start_date: string;
  end_date: string;
  annual_salary: number;
  benefits_pct: number;
  annual_raise_pct: number;
  salary_overrides: Record<string, number>; // year string → exact annual salary
  notes: string;
}

interface ExpenseEntry {
  id: string;
  name: string;
  category: "office_expense" | "legal_accounting" | "software" | "direct_expenses";
  monthly_amount: number;
  annual_increase_pct: number;
  amount_overrides: Record<string, number>; // year string → exact monthly amount
  start_date: string;
  end_date: string;
  notes: string;
}

interface FundingEntry {
  id: string;
  name: string;
  type: "equity" | "safe" | "convertible_note" | "grant" | "sbir" | "loan";
  // dilutive only
  pre_money_valuation: number;
  dilution_pct: number;
  date: string;          // close/award date (lump sum)
  amount: number;        // total for lump sum or equity
  // non-dilutive recurring
  disbursement: "lump_sum" | "monthly";
  start_date: string;
  end_date: string;
  monthly_amount: number;
  annual_increase_pct: number;
  notes: string;
}

interface ModelVersion {
  version_id: string;
  created_at: string;
  created_by: string | null;
  change_summary: string | null;
  scenario_name: string | null;
  is_default: boolean;
  version_number: string | null;
}

interface AuditEntry {
  year: number;
  month: number;
  revenue_components: { contract_id: string; name: string; type: string; monthly_value: number; formula: string }[];
  headcount_components: { employee_id: string; role: string; department: string; monthly_cost: number; formula: string }[];
  ga_components: { name: string; value: number; source: string }[];
}

interface FpaModel {
  model_id: string;
  version: string;
  version_number: string | null;
  exit_multiple: number;
  exit_year: number;
  start_year: number;
  working_capital: number;
  starting_valuation: number;
  original_equity: number;
  non_cash_equity: number;
  financing_charges_pct: number;
  sba_rate: number;
  bank_debt_rate: number;
  mezz_rate: number;
  hy_rate: number;
  rd_contract_avg_value: number;
  rd_contract_duration_months: number;
  portfolio_contract_avg_value: number;
  portfolio_contract_duration_months: number;
  annual_data: AnnualData[];
  monthly_data: MonthlyData[];
  equity_rounds: EquityRound[];
  notes: string | null;
  contract_pipeline: ContractEntry[];
  headcount_schedule: HeadcountEntry[];
  expense_schedule: ExpenseEntry[];
  funding_schedule: FundingEntry[];
  change_summary: string | null;
  burn_mode: "auto" | "manual";
  manual_burn_entries: ManualBurnEntry[];
  pending_liabilities: { label: string; amount: number }[];
  excluded_burn_categories: string[];
}

interface ManualEmployee {
  name: string;
  annual_salary: number;
  benefits_pct: number;  // decimal, e.g. 0.25
}

interface ManualBurnEntry {
  label: string;
  type: "simple" | "employees";
  monthly_amount: number;        // used when type === "simple"
  employees?: ManualEmployee[];  // used when type === "employees"
}

interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  name: string | null;
  title: string | null;
  role: string;
  is_active: boolean;
  last_login: string | null;
  created_at: string | null;
}

interface Scenario {
  scenario_id: string;
  name: string;
  description: string | null;
  created_at: string;
  created_by: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fmt$(n: number, decimals = 0): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`;
}

function fmtParen(n: number): string {
  const abs = Math.abs(n / 1000);
  const s = abs < 1 ? `$${(n / 1000).toFixed(0)}` : `$${abs.toFixed(0)}`;
  return n < 0 ? `(${s})` : s;
}

// Y-axis tick formatter – abbreviates raw dollar values
const fmtK = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${Math.round(v / 1_000)}K` : `$${v}`;
// v is raw dollars – full comma-formatted
const fmtRaw = (v: number) => fmt$(v);

function RoleBadge({ role }: { role: string }) {
  const cls =
    role === "admin"
      ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      : role === "user"
      ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {role}
    </span>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub: string;
  positive?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
      <p
        className={`text-2xl font-bold ${
          positive === false
            ? "text-red-600 dark:text-red-400"
            : positive === true
            ? "text-green-600 dark:text-green-400"
            : "text-gray-900 dark:text-gray-100"
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-gray-400 mt-1">{sub}</p>
    </div>
  );
}

// ── Custom Tooltip for chart ──────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-gray-700 dark:text-gray-200 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt$(p.value)}
        </p>
      ))}
    </div>
  );
}

// ── P&L Table ─────────────────────────────────────────────────────────────

const PNL_ROWS: { label: string; field: keyof AnnualData | "_gm_pct" | "_ebitda_pct"; isExpense?: boolean; isBold?: boolean; isFormula?: boolean }[] = [
  { label: "Revenue", field: "revenue", isBold: true },
  { label: "Gross Margin", field: "gross_margin", isBold: true, isFormula: true },
  { label: "Gross Margin %", field: "_gm_pct", isFormula: true },
  { label: "Technical Comp", field: "tech_comp", isExpense: true },
  { label: "Executive Comp", field: "exec_comp", isExpense: true },
  { label: "Sales Comp", field: "sales_comp", isExpense: true },
  { label: "Office Expense", field: "office_expense", isExpense: true },
  { label: "Legal & Accounting", field: "legal_accounting", isExpense: true },
  { label: "Software", field: "software", isExpense: true },
  { label: "Total OpEx", field: "total_opex", isExpense: true, isBold: true, isFormula: true },
  { label: "EBITDA", field: "ebitda", isBold: true, isFormula: true },
  { label: "EBITDA Margin %", field: "_ebitda_pct", isFormula: true },
];

function PnlTable({ data }: { data: AnnualData[] }) {
  const [showLater, setShowLater] = useState(false);
  const splitIdx = Math.ceil(data.length / 2);
  const early = data.slice(0, splitIdx);
  const later = data.slice(splitIdx);
  const visible = showLater ? later : early;
  const earlyLabel = early.length > 0 ? `${early[0].year}–${early[early.length - 1].year}` : "";
  const laterLabel = later.length > 0 ? `${later[0].year}–${later[later.length - 1].year}` : "";

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-800 text-white">
              <th className="text-left px-3 py-2 font-semibold w-40">Metric</th>
              {visible.map((d) => (
                <th key={d.year} className="text-right px-3 py-2 font-semibold">{d.year}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PNL_ROWS.map(({ label, field, isExpense, isBold, isFormula }) => {
              const isEbitda = field === "ebitda";
              return (
                <tr
                  key={label}
                  className={`border-t border-gray-100 dark:border-gray-800 ${
                    isBold ? "bg-gray-50 dark:bg-gray-800/50" : ""
                  } ${isEbitda ? "border-t-2 border-gray-300 dark:border-gray-600" : ""}`}
                >
                  <td className={`px-3 py-1.5 ${isBold ? "font-semibold" : "pl-5"} text-gray-700 dark:text-gray-300`}>
                    {label}
                  </td>
                  {visible.map((d) => {
                    let val: number | string;
                    if (field === "_gm_pct") {
                      val = d.revenue ? `${(((d.gross_margin ?? 0) / d.revenue) * 100).toFixed(1)}%` : "—";
                    } else if (field === "_ebitda_pct") {
                      val = d.revenue && d.ebitda > 0 ? `${((d.ebitda / d.revenue) * 100).toFixed(1)}%` : "—";
                    } else {
                      val = d[field as keyof AnnualData] as number;
                    }

                    const isNeg = typeof val === "number" && (isExpense || val < 0);
                    const displayVal = typeof val === "string"
                      ? val
                      : isExpense
                      ? fmtParen(-Math.abs(val))
                      : val < 0
                      ? `(${fmt$(Math.abs(val))})`
                      : fmt$(val);

                    return (
                      <td
                        key={d.year}
                        className={`text-right px-3 py-1.5 font-mono ${
                          field === "ebitda"
                            ? d.ebitda >= 0
                              ? "text-green-600 dark:text-green-400 font-bold"
                              : "text-red-600 dark:text-red-400 font-bold"
                            : isNeg
                            ? "text-red-700 dark:text-red-400"
                            : "text-gray-800 dark:text-gray-200"
                        }`}
                      >
                        {displayVal}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => setShowLater(false)}
          className={`text-xs px-3 py-1 rounded border transition-colors ${
            !showLater
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400"
              : "border-gray-300 dark:border-gray-600 text-gray-500 hover:text-gray-700"
          }`}
        >
          {earlyLabel}
        </button>
        {later.length > 0 && (
        <button
          onClick={() => setShowLater(true)}
          className={`text-xs px-3 py-1 rounded border transition-colors ${
            showLater
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400"
              : "border-gray-300 dark:border-gray-600 text-gray-500 hover:text-gray-700"
          }`}
        >
          {laterLabel}
        </button>
        )}
      </div>
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────

// ── Excel Upload & Viewer ─────────────────────────────────────────────────

function ExcelViewer() {
  const [info, setInfo] = useState<{ uploaded: boolean; filename?: string; uploaded_at?: string; size?: number; parsed_years?: number[]; parsed_metrics?: string[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [iframeKey, setIframeKey] = useState(0); // bump to reload iframe

  useEffect(() => {
    Promise.all([
      fetch("/api/proxy/fpa/model/excel-info").then(r => r.json()),
      fetch("/api/proxy/fpa/model/excel-sheets").then(r => r.ok ? r.json() : []),
    ]).then(([inf, sh]) => {
      setInfo(inf);
      if (Array.isArray(sh) && sh.length) {
        setSheets(sh);
        setActiveSheet(sh[0]);
      }
    });
  }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/proxy/fpa/model/upload-excel", { method: "POST", body: form });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "Upload failed" }));
        setUploadError(err.detail ?? "Upload failed");
        return;
      }
      const result = await r.json();
      const [newInfo, newSheets] = await Promise.all([
        fetch("/api/proxy/fpa/model/excel-info").then(r2 => r2.json()),
        fetch("/api/proxy/fpa/model/excel-sheets").then(r2 => r2.ok ? r2.json() : []),
      ]);
      setInfo({ ...newInfo, parsed_years: result.parsed_years, parsed_metrics: result.parsed_metrics });
      if (Array.isArray(newSheets) && newSheets.length) {
        setSheets(newSheets);
        setActiveSheet(newSheets[0]);
      }
      setIframeKey(k => k + 1);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function switchSheet(name: string) {
    setActiveSheet(name);
    setIframeKey(k => k + 1);
  }

  const fmtSize = (b: number) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const htmlUrl = activeSheet
    ? `/api/proxy/fpa/model/excel-html?sheet=${encodeURIComponent(activeSheet)}`
    : "/api/proxy/fpa/model/excel-html";

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Excel Model</h2>
          {info?.uploaded && (
            <p className="text-xs text-gray-400 mt-0.5">
              {info.filename} · {fmtSize(info.size ?? 0)} · {new Date(info.uploaded_at!).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {info.parsed_years?.length ? ` · parsed ${info.parsed_years.join(", ")}` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {info?.uploaded && (
            <a href="/api/proxy/fpa/model/export"
              className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 transition-colors">
              Download
            </a>
          )}
          <label className={`px-3 py-1.5 text-xs rounded font-medium cursor-pointer transition-colors ${uploading ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 text-white"}`}>
            {uploading ? "Uploading…" : info?.uploaded ? "Replace" : "Upload Excel"}
            <input type="file" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      </div>

      {uploadError && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">{uploadError}</div>
      )}

      {info?.uploaded && info.parsed_metrics?.length ? (
        <div className="px-4 py-2 bg-green-50 dark:bg-green-950/30 border-b border-green-200 dark:border-green-800 text-xs text-green-700 dark:text-green-400">
          Model updated from Excel — detected: {info.parsed_metrics.join(", ")}. Charts and comparisons now use this data.
        </div>
      ) : null}

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex border-b border-gray-100 dark:border-gray-800 overflow-x-auto">
          {sheets.map(s => (
            <button key={s} onClick={() => switchSheet(s)}
              className={`px-4 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors -mb-px ${
                s === activeSheet
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}>{s}</button>
          ))}
        </div>
      )}

      {/* Viewer */}
      {!info?.uploaded ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400">
          <svg className="w-10 h-10 opacity-40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <p className="text-sm">Upload your Excel model to view it here</p>
          <p className="text-xs">Supports .xlsx · Max 20 MB · Formatting preserved</p>
        </div>
      ) : (
        <iframe
          key={iframeKey}
          src={htmlUrl}
          className="w-full border-0"
          style={{ height: 600 }}
          sandbox="allow-same-origin"
          title="Excel viewer"
        />
      )}
    </div>
  );
}

function ModelTab({ model }: { model: FpaModel }) {
  const allData = model.annual_data;
  const currentYear = new Date().getFullYear();
  const [monthlyData, setMonthlyData] = useState<MonthlyData[]>([]);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const allYears = allData.map(d => d.year);
  const [viewStart, setViewStart] = useState<number>(allYears[0] ?? currentYear);
  const [viewEnd, setViewEnd] = useState<number>(allYears[allYears.length - 1] ?? currentYear);
  const data = allData.filter(d => d.year >= viewStart && d.year <= viewEnd);

  useEffect(() => {
    fetch("/api/proxy/fpa/model/monthly").then(r => r.ok ? r.json() : []).then(setMonthlyData);
  }, []);

  const nowYr = data.find(d => d.year === currentYear) ?? data[0];
  const lastYr = data[data.length - 1];
  const exitVal = model.exit_multiple * (lastYr?.ebitda ?? 0);
  const breakevenYear = data.find(d => d.ebitda > 0)?.year ?? "—";

  // Revenue by stream – stacked bar (annual)
  const revenueStreamData = data.map(d => ({
    year: String(d.year),
    "R&D": Math.round(d.rd_contract_revenue ?? 0),
    "Portfolio": Math.round(d.portfolio_revenue ?? 0),
    "Maintenance": Math.round(d.maintenance_revenue ?? 0),
    "Grants": Math.round(d.grant_revenue ?? 0),
    "Consumables": Math.round(d.consumable_revenue ?? 0),
    "Licensing": Math.round(d.licensing_revenue ?? 0),
    "EBITDA": Math.round(d.ebitda),
  }));

  // Expense breakdown – stacked bar (annual)
  const expenseData = data.map(d => ({
    year: String(d.year),
    "Tech Comp": Math.round(d.tech_comp ?? 0),
    "Exec Comp": Math.round(d.exec_comp ?? 0),
    "Sales Comp": Math.round(d.sales_comp ?? 0),
    "G&A Comp": Math.round(d.ga_comp ?? 0),
    "Office": Math.round(d.office_expense ?? 0),
    "Legal & Acctg": Math.round(d.legal_accounting ?? 0),
    "Software": Math.round(d.software ?? 0),
  }));

  // Monthly chart for selected year
  const monthlyForYear = monthlyData.filter(m => m.year === selectedYear);
  const monthlyChartData = monthlyForYear.map(m => ({
    month: m.month_name.slice(0, 3),
    Revenue: Math.round(m.total_revenue),
    "Tech+Exec": Math.round((m.tech_comp ?? 0) + (m.exec_comp ?? 0) + (m.sales_comp ?? 0)),
    Office: Math.round(m.office_expense ?? 0),
    EBITDA: Math.round(m.ebitda),
  }));



  const [revChartType, setRevChartType] = useState<"bar" | "line">("bar");
  const [expChartType, setExpChartType] = useState<"bar" | "line">("bar");

  const REV_SERIES = [
    { key: "R&D", color: "#3b82f6" },
    { key: "Portfolio", color: "#8b5cf6" },
    { key: "Maintenance", color: "#06b6d4" },
    { key: "Grants", color: "#10b981" },
    { key: "Consumables", color: "#f97316" },
    { key: "Licensing", color: "#a855f7" },
  ];
  const EXP_SERIES = [
    { key: "Tech Comp", color: "#3b82f6" },
    { key: "Exec Comp", color: "#8b5cf6" },
    { key: "Sales Comp", color: "#ec4899" },
    { key: "G&A Comp", color: "#f97316" },
    { key: "Office", color: "#14b8a6" },
    { key: "Legal & Acctg", color: "#eab308" },
    { key: "Software", color: "#64748b" },
  ];

  function ChartTypeToggle({ value, onChange }: { value: "bar" | "line"; onChange: (v: "bar" | "line") => void }) {
    return (
      <div className="flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
        {(["bar","line"] as const).map(t => (
          <button key={t} onClick={() => onChange(t)}
            className={`px-2.5 py-1 capitalize transition-colors ${value === t ? "bg-blue-600 text-white" : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
            {t}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* View period controls */}
      <div className="flex flex-wrap items-center gap-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2.5">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">View period:</span>
        <div className="flex items-center gap-2">
          <select value={viewStart} onChange={e => setViewStart(Number(e.target.value))}
            className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200">
            {allYears.filter(y => y <= viewEnd).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <span className="text-xs text-gray-400">→</span>
          <select value={viewEnd} onChange={e => setViewEnd(Number(e.target.value))}
            className="text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200">
            {allYears.filter(y => y >= viewStart).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <span className="text-xs text-gray-400">({data.length} year{data.length !== 1 ? "s" : ""})</span>
        <div className="flex gap-1 ml-auto">
          {[
            { label: "3Y", start: currentYear, end: currentYear + 2 },
            { label: "5Y", start: currentYear, end: currentYear + 4 },
            { label: "All", start: allYears[0], end: allYears[allYears.length - 1] },
          ].map(p => (
            <button key={p.label} onClick={() => { setViewStart(p.start ?? allYears[0]); setViewEnd(p.end ?? allYears[allYears.length - 1]); }}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${viewStart === p.start && viewEnd === p.end ? "border-blue-400 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-blue-500 hover:border-blue-400"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label={`${currentYear} Revenue`} value={fmt$(nowYr?.revenue ?? 0)} sub="Annual model" />
        <KpiCard label={`${currentYear} EBITDA`}
          value={nowYr ? (nowYr.ebitda < 0 ? `(${fmt$(Math.abs(nowYr.ebitda))})` : fmt$(nowYr.ebitda)) : "—"}
          sub={nowYr?.ebitda ?? 0 < 0 ? "Net loss" : "Net income"} positive={(nowYr?.ebitda ?? -1) >= 0} />
        <KpiCard label="Breakeven Year" value={String(breakevenYear)} sub="EBITDA positive" positive />
        <KpiCard label={`${lastYr?.year} Exit`} value={fmt$(exitVal)} sub={`${model.exit_multiple}× EBITDA`} positive />
      </div>

      {/* Revenue by Stream */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Revenue by Stream</h2>
          <ChartTypeToggle value={revChartType} onChange={setRevChartType} />
        </div>
        <p className="text-xs text-gray-400 mb-3">R&D · Portfolio · Maintenance · Grants · Consumables · Licensing</p>
        <ResponsiveContainer width="100%" height={260}>
          {revChartType === "bar" ? (
            <BarChart data={revenueStreamData} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} width={65} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="#9ca3af" />
              {REV_SERIES.map((s, i) => <Bar key={s.key} dataKey={s.key} stackId="rev" fill={s.color} radius={i === REV_SERIES.length - 1 ? [2,2,0,0] : [0,0,0,0]} />)}
              <Bar dataKey="EBITDA" fill="none" stroke="#f59e0b" strokeWidth={2} />
              <ReferenceArea x={currentYear} x2={currentYear} fill="#3b82f6" fillOpacity={0.06} strokeOpacity={0} />
            </BarChart>
          ) : (
            <LineChart data={revenueStreamData} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} width={65} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="#9ca3af" />
              {REV_SERIES.map(s => <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 3 }} />)}
              <Line type="monotone" dataKey="EBITDA" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 2" dot={{ r: 3 }} />
            </LineChart>
          ) as React.ReactElement}
        </ResponsiveContainer>
      </div>

      {/* Expense Breakdown */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Operating Expenses by Category</h2>
          <ChartTypeToggle value={expChartType} onChange={setExpChartType} />
        </div>
        <p className="text-xs text-gray-400 mb-3">{currentYear} budget = {fmt$(nowYr?.total_opex ?? 0)}</p>
        <ResponsiveContainer width="100%" height={260}>
          {expChartType === "bar" ? (
            <BarChart data={expenseData} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} width={65} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {EXP_SERIES.map((s, i) => <Bar key={s.key} dataKey={s.key} stackId="exp" fill={s.color} radius={i === EXP_SERIES.length - 1 ? [2,2,0,0] : [0,0,0,0]} />)}
              <ReferenceArea x={currentYear} x2={currentYear} fill="#3b82f6" fillOpacity={0.06} strokeOpacity={0} />
            </BarChart>
          ) : (
            <LineChart data={expenseData} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} width={65} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {EXP_SERIES.map(s => <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={{ r: 3 }} />)}
            </LineChart>
          ) as React.ReactElement}
        </ResponsiveContainer>
      </div>

      {/* Monthly Detail */}
      {monthlyData.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Monthly Detail</h2>
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
              {[...new Set(monthlyData.map(m => m.year))].map(yr => (
                <button key={yr} onClick={() => setSelectedYear(yr)}
                  className={`px-3 py-1.5 transition-colors ${selectedYear === yr ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
                  {yr}
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={monthlyChartData} margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10 }} width={55} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Bar dataKey="Revenue" fill="#3b82f6" radius={[2,2,0,0]} />
              <Bar dataKey="Tech+Exec" fill="#8b5cf6" radius={[2,2,0,0]} />
              <Bar dataKey="Office" fill="#14b8a6" radius={[2,2,0,0]} />
              <Bar dataKey="EBITDA" fill="#22c55e" radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Full P&L Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Annual P&L Detail</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                <th className="text-left px-3 py-2 font-medium sticky left-0 bg-gray-50 dark:bg-gray-800">Line Item</th>
                {data.map(d => <th key={d.year} className="text-right px-3 py-2 font-medium">{d.year}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {[
                { label: "R&D Contract Revenue", key: "rd_contract_revenue", indent: 1 },
                { label: "Portfolio Revenue", key: "portfolio_revenue", indent: 1 },
                { label: "Maintenance Revenue", key: "maintenance_revenue", indent: 1 },
                { label: "Grant Revenue", key: "grant_revenue", indent: 1 },
                { label: "Consumable Revenue", key: "consumable_revenue", indent: 1 },
                { label: "Licensing Revenue", key: "licensing_revenue", indent: 1 },
                { label: "Total Revenue", key: "total_revenue", bold: true },
                { label: "Direct Expenses", key: "direct_expenses", indent: 1 },
                { label: "Gross Margin", key: "gross_margin", bold: true },
                null, // divider
                { label: "Technical Compensation", key: "tech_comp", indent: 1 },
                { label: "Executive Compensation", key: "exec_comp", indent: 1 },
                { label: "G&A Compensation", key: "ga_comp", indent: 1 },
                { label: "Sales Compensation", key: "sales_comp", indent: 1 },
                { label: "Office Expense", key: "office_expense", indent: 1 },
                { label: "Legal & Accounting", key: "legal_accounting", indent: 1 },
                { label: "Software", key: "software", indent: 1 },
                { label: "Total Operating Expenses", key: "total_opex", bold: true },
                null,
                { label: "EBITDA", key: "ebitda", bold: true, highlight: true },
              ].map((row, ri) => {
                if (!row) return <tr key={`div-${ri}`} className="h-px bg-gray-100 dark:bg-gray-800"><td colSpan={data.length + 1} /></tr>;
                return (
                  <tr key={row.key} className={row.highlight ? "bg-blue-50 dark:bg-blue-950/30" : ri % 2 === 0 ? "" : "bg-gray-50/40 dark:bg-gray-800/20"}>
                    <td className={`px-3 py-1.5 sticky left-0 bg-inherit ${row.bold ? "font-semibold text-gray-800 dark:text-gray-100" : "text-gray-600 dark:text-gray-400"} ${row.indent ? "pl-6" : ""}`}>
                      {row.label}
                    </td>
                    {data.map(d => {
                      const v = ((d as unknown as Record<string, unknown>)[row.key] as number | undefined) ?? 0;
                      const isNeg = v < 0;
                      return (
                        <td key={d.year} className={`px-3 py-1.5 text-right font-mono ${row.bold ? "font-semibold" : ""} ${isNeg ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
                          {v !== 0 ? fmt$(v) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Excel Tab ─────────────────────────────────────────────────────────────

function ExcelTab() {
  return (
    <div className="space-y-4">
      <ExcelViewer />
    </div>
  );
}

// ── Assumptions Tab ───────────────────────────────────────────────────────

// ── Assumptions Tab ────────────────────────────────────────────────────────

type CostField = "tech_comp" | "exec_comp" | "ga_comp" | "sales_comp" | "software" | "office_expense" | "legal_accounting";
type SectionId = "comp" | "opex" | "revenue";

interface ParamRow { key: CostField; label: string; section: SectionId }
const PARAM_ROWS: ParamRow[] = [
  { key: "tech_comp",        label: "Tech Comp ($/mo)",       section: "comp" },
  { key: "exec_comp",        label: "Exec Comp ($/mo)",       section: "comp" },
  { key: "sales_comp",       label: "Sales Comp ($/mo)",      section: "comp" },
  { key: "ga_comp",          label: "G&A Comp ($/mo)",        section: "comp" },
  { key: "software",         label: "Software ($/mo)",        section: "opex" },
  { key: "office_expense",   label: "Office Expense ($/mo)",  section: "opex" },
  { key: "legal_accounting", label: "Legal & Acctg ($/mo)",   section: "opex" },
];

const SECTION_LABELS: Record<SectionId, string> = {
  comp:    "Compensation",
  opex:    "Operating Costs",
  revenue: "Revenue",
};

// per-year monthly averages for cost fields + annual totals for revenue
type YearDrivers = Record<CostField, number> & { total_revenue: number };
type Drivers = Record<number, YearDrivers>;

function initDrivers(monthly: MonthlyData[]): Drivers {
  const sums: Record<number, Record<string, number>> = {};
  for (const m of monthly) {
    if (!sums[m.year]) sums[m.year] = { cnt: 0, total_revenue: 0 };
    sums[m.year].cnt += 1;
    sums[m.year].total_revenue += m.total_revenue;
    for (const { key } of PARAM_ROWS) {
      sums[m.year][key] = (sums[m.year][key] ?? 0) + (m[key] ?? 0);
    }
  }
  const out: Drivers = {};
  for (const [yr, s] of Object.entries(sums)) {
    const cnt = s.cnt ?? 12;
    out[+yr] = { total_revenue: s.total_revenue ?? 0 } as YearDrivers;
    for (const { key } of PARAM_ROWS) {
      out[+yr][key] = Math.round((s[key] ?? 0) / cnt);
    }
  }
  return out;
}

// Apply drivers to produce new monthly_data + annual_data
function applyDrivers(original: MonthlyData[], drivers: Drivers): { monthly: MonthlyData[]; annual: AnnualData[] } {
  const monthly = original.map(m => {
    const d = drivers[m.year];
    if (!d) return m;
    const updated: MonthlyData = { ...m };
    for (const { key } of PARAM_ROWS) updated[key] = d[key];
    // spread revenue evenly across 12 months
    const monthlyRev = Math.round(d.total_revenue / 12);
    updated.total_revenue = monthlyRev;
    updated.rd_contract_revenue = monthlyRev;
    updated.portfolio_revenue = 0;
    updated.maintenance_revenue = 0;
    updated.grant_revenue = 0;
    updated.total_opex = PARAM_ROWS.reduce((s, r) => s + (updated[r.key] ?? 0), 0);
    const directExp = updated.direct_expenses ?? 0;
    updated.gross_margin = updated.total_revenue - directExp;
    updated.ebitda = (updated.gross_margin ?? updated.total_revenue) - updated.total_opex;
    return updated;
  });
  const annualMap: Record<number, AnnualData> = {};
  for (const m of monthly) {
    const yr = m.year;
    if (!annualMap[yr]) annualMap[yr] = {
      year: yr, revenue: 0, total_opex: 0, ebitda: 0,
      rd_contract_revenue: 0, portfolio_revenue: 0, maintenance_revenue: 0, grant_revenue: 0,
      total_revenue: 0, tech_comp: 0, exec_comp: 0, ga_comp: 0, sales_comp: 0,
      office_expense: 0, legal_accounting: 0, software: 0, direct_expenses: 0, gross_margin: 0,
    };
    const a = annualMap[yr];
    a.revenue = (a.revenue ?? 0) + m.total_revenue;
    a.total_revenue = a.revenue;
    a.total_opex += m.total_opex;
    a.ebitda += m.ebitda;
    a.gross_margin = (a.gross_margin ?? 0) + (m.gross_margin ?? m.total_revenue);
    a.direct_expenses = (a.direct_expenses ?? 0) + (m.direct_expenses ?? 0);
    for (const { key } of PARAM_ROWS) {
      (a as unknown as Record<string, number>)[key] = ((a as unknown as Record<string, number>)[key] ?? 0) + m[key];
    }
  }
  return { monthly, annual: Object.values(annualMap).sort((a, b) => a.year - b.year) };
}

function _AssumptionsTab_REMOVED({ model, onSave }: { model: FpaModel; onSave: (updated: Partial<FpaModel>) => Promise<void> }) {
  const originalDrivers = useMemo(() => initDrivers(model.monthly_data ?? []), [model]);
  const years = useMemo(() => [...new Set((model.monthly_data ?? []).map(m => m.year))].sort(), [model]);

  const [drivers, setDrivers] = useState<Drivers>(() => initDrivers(model.monthly_data ?? []));
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(["comp", "opex", "revenue"]);
  const [collapsed, setCollapsed] = useState<Set<SectionId>>(new Set());
  const [saving, setSaving] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");

  const isDirty = useMemo(() => {
    return years.some(yr =>
      PARAM_ROWS.some(({ key }) => (drivers[yr]?.[key] ?? 0) !== (originalDrivers[yr]?.[key] ?? 0)) ||
      (drivers[yr]?.total_revenue ?? 0) !== (originalDrivers[yr]?.total_revenue ?? 0)
    );
  }, [drivers, originalDrivers, years]);

  const preview = useMemo(() => applyDrivers(model.monthly_data ?? [], drivers), [drivers, model]);

  function setDriver(year: number, key: CostField | "total_revenue", value: number) {
    setDrivers(prev => ({
      ...prev,
      [year]: { ...prev[year], [key]: value },
    }));
  }

  function reset() {
    setDrivers(initDrivers(model.monthly_data ?? []));
    setCommitMsg("");
  }

  async function commitToDb() {
    setSaving(true);
    setCommitMsg("");
    try {
      await onSave({ annual_data: preview.annual, monthly_data: preview.monthly, write_excel: true } as Partial<FpaModel> & { write_excel: boolean });
      setCommitMsg("Saved to DB and Excel.");
      // Reset drivers to new baseline (the committed values)
      setDrivers(initDrivers(preview.monthly));
    } catch {
      setCommitMsg("Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function moveSection(id: SectionId, dir: -1 | 1) {
    setSectionOrder(prev => {
      const idx = prev.indexOf(id);
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  function toggleCollapse(id: SectionId) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const currentYear = new Date().getFullYear();

  return (
    <div className="space-y-4">
      {/* Sticky action bar */}
      <div className={`flex items-center justify-between rounded-lg px-4 py-2.5 border transition-colors ${
        isDirty
          ? "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-700"
          : "bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700"
      }`}>
        <div className="flex items-center gap-3">
          {isDirty ? (
            <span className="text-sm text-amber-700 dark:text-amber-300 font-medium">Unsaved changes — preview reflected in Model tab</span>
          ) : (
            <span className="text-sm text-gray-500 dark:text-gray-400">Edit parameters below. Changes preview instantly in the Model tab.</span>
          )}
          {commitMsg && <span className="text-xs text-green-600 dark:text-green-400">{commitMsg}</span>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={reset}
            disabled={!isDirty || saving}
            className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            Reset to Original
          </button>
          <button
            onClick={commitToDb}
            disabled={!isDirty || saving}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded font-medium transition-colors"
          >
            {saving ? "Saving…" : "Commit → DB + Excel"}
          </button>
        </div>
      </div>

      {/* Preview summary strip */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
          Live Preview — Annual Totals {isDirty && <span className="ml-2 text-amber-500 normal-case font-normal">(unsaved changes)</span>}
        </p>
        <div className="overflow-x-auto">
          <table className="text-xs w-full">
            <thead>
              <tr className="text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left pb-1.5 font-medium">Year</th>
                {years.map(yr => <th key={yr} className={`text-right pb-1.5 px-2 font-medium ${yr === currentYear ? "text-blue-600 dark:text-blue-400" : ""}`}>{yr}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {[
                { label: "Revenue", key: "revenue" as keyof AnnualData, color: "text-green-700 dark:text-green-400" },
                { label: "Total OpEx", key: "total_opex" as keyof AnnualData, color: "text-red-600 dark:text-red-400" },
                { label: "EBITDA", key: "ebitda" as keyof AnnualData, color: "" },
              ].map(row => (
                <tr key={row.key}>
                  <td className="py-1 font-medium text-gray-600 dark:text-gray-300">{row.label}</td>
                  {years.map(yr => {
                    const a = preview.annual.find(d => d.year === yr);
                    const val = (a?.[row.key] ?? 0) as number;
                    const color = row.key === "ebitda"
                      ? val >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                      : row.color;
                    return (
                      <td key={yr} className={`py-1 px-2 text-right font-mono ${color} ${yr === currentYear ? "font-bold" : ""}`}>
                        {val >= 0 ? fmtRaw(val) : `(${fmtRaw(Math.abs(val))})`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Parameter sections */}
      {sectionOrder.map((secId, secIdx) => {
        const rows = secId === "revenue"
          ? null  // revenue handled separately below
          : PARAM_ROWS.filter(r => r.section === secId);
        const isCollapsed = collapsed.has(secId);

        return (
          <div key={secId} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
            {/* Section header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <button
                onClick={() => toggleCollapse(secId)}
                className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white"
              >
                <svg className={`w-4 h-4 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                {SECTION_LABELS[secId]}
              </button>
              <div className="flex gap-1">
                <button onClick={() => moveSection(secId, -1)} disabled={secIdx === 0} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
                </button>
                <button onClick={() => moveSection(secId, 1)} disabled={secIdx === sectionOrder.length - 1} className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
              </div>
            </div>

            {!isCollapsed && (
              <div className="overflow-x-auto p-4">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                      <th className="text-left pb-2 font-medium w-44">Parameter</th>
                      {years.map(yr => (
                        <th key={yr} className={`text-right pb-2 px-2 font-medium ${yr === currentYear ? "text-blue-600 dark:text-blue-400" : ""}`}>{yr}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {secId === "revenue" ? (
                      <tr>
                        <td className="py-1.5 pr-3 font-medium text-gray-600 dark:text-gray-300">Annual Revenue ($)</td>
                        {years.map(yr => {
                          const orig = originalDrivers[yr]?.total_revenue ?? 0;
                          const cur = drivers[yr]?.total_revenue ?? 0;
                          const dirty = cur !== orig;
                          return (
                            <td key={yr} className="py-1 px-1">
                              <input
                                type="number"
                                className={`w-24 px-1.5 py-0.5 text-right text-xs border rounded bg-transparent focus:outline-none transition-colors ${
                                  dirty
                                    ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200"
                                    : "border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-400 hover:bg-white dark:hover:bg-gray-800 focus:bg-white dark:focus:bg-gray-800 text-gray-800 dark:text-gray-200"
                                }`}
                                value={cur}
                                onChange={e => setDriver(yr, "total_revenue", parseFloat(e.target.value) || 0)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ) : rows!.map(({ key, label }) => (
                      <tr key={key}>
                        <td className="py-1.5 pr-3 font-medium text-gray-600 dark:text-gray-300">{label}</td>
                        {years.map(yr => {
                          const orig = originalDrivers[yr]?.[key] ?? 0;
                          const cur = drivers[yr]?.[key] ?? 0;
                          const dirty = cur !== orig;
                          return (
                            <td key={yr} className="py-1 px-1">
                              <input
                                type="number"
                                className={`w-24 px-1.5 py-0.5 text-right text-xs border rounded bg-transparent focus:outline-none transition-colors ${
                                  dirty
                                    ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200"
                                    : "border-transparent hover:border-gray-300 dark:hover:border-gray-600 focus:border-blue-400 hover:bg-white dark:hover:bg-gray-800 focus:bg-white dark:focus:bg-gray-800 text-gray-800 dark:text-gray-200"
                                }`}
                                value={cur}
                                onChange={e => setDriver(yr, key, parseFloat(e.target.value) || 0)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Equity rounds (collapsed by default) */}
      <EquityRoundsSection model={model} onSave={onSave} />
    </div>
  );
}

function _EquityRoundsSection_REMOVED({ model, onSave }: { model: FpaModel; onSave: (updated: Partial<FpaModel>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [roundsDraft, setRoundsDraft] = useState<EquityRound[]>(model.equity_rounds || []);
  const [saving, setSaving] = useState(false);
  const isDirty = JSON.stringify(roundsDraft) !== JSON.stringify(model.equity_rounds || []);

  function cumulative(idx: number) {
    return roundsDraft.slice(0, idx + 1).reduce((s, r) => s + (r.amount || 0), 0);
  }

  async function save() {
    setSaving(true);
    try { await onSave({ equity_rounds: roundsDraft }); } finally { setSaving(false); }
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white">
          <svg className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          Equity Financing Rounds
        </button>
        {isDirty && open && (
          <button onClick={save} disabled={saving} className="text-xs px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50">
            {saving ? "Saving…" : "Save rounds"}
          </button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3">
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left pb-2 font-medium">Round</th>
                  <th className="text-right pb-2 font-medium">Amount</th>
                  <th className="text-left pb-2 font-medium px-3">Date</th>
                  <th className="text-right pb-2 font-medium">Cumulative</th>
                  <th className="text-left pb-2 font-medium px-3">Notes</th>
                </tr>
              </thead>
              <tbody>
                {roundsDraft.map((rnd, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="py-1.5 font-medium text-gray-700 dark:text-gray-300">{rnd.round ?? i + 1}</td>
                    <td className="py-1.5 text-right">
                      <input type="number" className="w-28 px-2 py-0.5 text-right text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                        value={rnd.amount}
                        onChange={e => setRoundsDraft(r => r.map((x, j) => j === i ? { ...x, amount: parseFloat(e.target.value) || 0 } : x))} />
                    </td>
                    <td className="py-1.5 px-3">
                      <input type="text" className="w-28 px-2 py-0.5 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                        value={rnd.date}
                        onChange={e => setRoundsDraft(r => r.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
                    </td>
                    <td className="py-1.5 text-right font-mono text-gray-600 dark:text-gray-400">${cumulative(i).toLocaleString()}</td>
                    <td className="py-1.5 px-3">
                      <input type="text" className="w-36 px-2 py-0.5 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200"
                        value={rnd.notes ?? ""}
                        onChange={e => setRoundsDraft(r => r.map((x, j) => j === i ? { ...x, notes: e.target.value } : x))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={() => setRoundsDraft(r => [...r, { round: r.length + 1, amount: 0, date: "", notes: "" }])}
            className="mt-3 text-xs px-3 py-1.5 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >+ Add round</button>
        </div>
      )}
    </div>
  );
}

// ── Drivers Tab ──────────────────────────────────────────────────────────────

function uuid4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const CONTRACT_TYPE_LABELS: Record<ContractEntry["type"], string> = {
  rd_contract: "R&D Contract",
  portfolio: "Portfolio",
  maintenance: "Maintenance",
  grant: "Grant",
  consumable_recurring: "Consumables (Recurring)",
  licensing_recurring: "Licensing (Recurring)",
};
const RECURRING_CONTRACT_TYPES: ContractEntry["type"][] = ["consumable_recurring", "licensing_recurring"];

const DEPT_LABELS: Record<HeadcountEntry["department"], string> = {
  tech: "Technical",
  exec: "Executive",
  ga: "G&A",
  sales: "Sales",
};

const EXP_CATEGORY_LABELS: Record<ExpenseEntry["category"], string> = {
  office_expense: "Office / Rent & Utilities",
  legal_accounting: "Legal & Accounting",
  software: "Software & Apps",
  direct_expenses: "Lab Consumables / Direct",
};

const FUND_TYPE_LABELS: Record<FundingEntry["type"], string> = {
  equity: "Equity Round",
  safe: "SAFE",
  convertible_note: "Convertible Note",
  grant: "Grant",
  sbir: "SBIR / STTR",
  loan: "Loan / Debt",
};
const DILUTIVE_TYPES: FundingEntry["type"][] = ["equity", "safe", "convertible_note"];
const NONDILUTIVE_TYPES: FundingEntry["type"][] = ["grant", "sbir", "loan"];

// ── Gantt Chart ───────────────────────────────────────────────────────────────

interface GanttSegment {
  startDate: Date;
  endDate: Date;
  color: string;
}

interface GanttRow {
  id: string;
  label: string;
  sublabel?: string;
  tags?: string[];
  startDate: Date | null;
  endDate: Date | null;
  color: string; // tailwind bg class
  pointInTime?: boolean;
  countable?: boolean;
  segments?: GanttSegment[];
  expandable?: boolean;
  children?: GanttRow[];
}

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

type TrackEntry = { startDate: Date; endDate: Date; label?: string };

function GanttChart({ rows, modelYears, ratioRows, viewStart, activeTrack, serviceTrack }: {
  rows: GanttRow[];
  modelYears: number[];
  ratioRows?: GanttRow[];
  viewStart?: Date;
  activeTrack?: TrackEntry[];
  serviceTrack?: TrackEntry[];
}) {
  const [zoom, setZoom] = useState<"year" | "month">("year");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  function toggleRow(id: string) {
    setExpandedRows(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const countableRows = rows.filter(r => r.countable && r.startDate && r.endDate);
  const hasRatio = !!ratioRows && countableRows.length > 0;
  const hasActiveBars = (activeTrack && activeTrack.length > 0) || (serviceTrack && serviceTrack.length > 0);

  function getConcurrency(from: Date, to: Date) {
    return countableRows.filter(r =>
      r.startDate!.getTime() < to.getTime() && r.endDate!.getTime() > from.getTime()
    );
  }

  function getRatioCounts(from: Date, to: Date): { contracts: number; tech: number } {
    const contracts = (ratioRows || []).filter(r =>
      r.startDate && r.endDate &&
      r.startDate.getTime() < to.getTime() && r.endDate.getTime() > from.getTime()
    ).length;
    const tech = getConcurrency(from, to).length;
    return { contracts, tech };
  }

  const startYear = viewStart ? viewStart.getFullYear() : modelYears[0];
  const minDate = new Date(startYear, 0, 1).getTime();
  const maxDate = new Date(modelYears[modelYears.length - 1], 11, 31).getTime();
  const totalMs = maxDate - minDate;
  const pct = (d: Date) => Math.max(0, Math.min(100, ((d.getTime() - minDate) / totalMs) * 100));

  const displayYears = modelYears.filter(yr => yr >= startYear);

  // Generate all months for monthly view
  const allMonths = displayYears.flatMap(yr =>
    Array.from({ length: 12 }, (_, i) => ({ yr, mo: i, label: MONTH_SHORT[i], key: `${yr}-${i}` }))
  );

  if (rows.length === 0) return (
    <div className="px-4 py-8 text-center text-gray-400 text-xs">No entries to display.</div>
  );

  return (
    <div>
      <div className="flex items-center justify-end mb-2 gap-2">
        <span className="text-xs text-gray-400">Zoom:</span>
        {(["year","month"] as const).map(z => (
          <button key={z} onClick={() => setZoom(z)}
            className={`text-xs px-2 py-0.5 rounded border transition-colors ${zoom === z ? "border-blue-400 bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-blue-500"}`}>
            {z === "year" ? "Yearly" : "Monthly"}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: zoom === "month" ? `${224 + allMonths.length * 36}px` : "600px" }}>
          {/* Header */}
          {zoom === "year" ? (
            <div className="flex ml-56 mb-1">
              {displayYears.map(yr => (
                <div key={yr} className="flex-1 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 border-l border-gray-200 dark:border-gray-700 py-1.5">{yr}</div>
              ))}
            </div>
          ) : (
            <div className="flex ml-56 mb-1">
              {allMonths.map(({ yr, mo, label, key }, i) => (
                <div key={key} style={{ width: 36, flexShrink: 0 }}
                  className={`text-center border-l py-1 ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-200 dark:border-gray-700"}`}>
                  {(mo === 0 || i === 0)
                    ? <span className="text-xs font-semibold text-gray-500">{yr}</span>
                    : mo % 3 === 0 ? <span className="text-xs text-gray-400">{label}</span> : null}
                </div>
              ))}
            </div>
          )}

          {/* Rows */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map(row => {
              const start = row.startDate;
              const end = row.endDate;
              const leftPct = start ? pct(start) : 0;
              const rightPct = end ? pct(end) : 100;
              const widthPct = Math.max(row.pointInTime ? 0.8 : 0.4, rightPct - leftPct);
              const isExpanded = expandedRows.has(row.id);
              return (
                <Fragment key={row.id}>
                  <div className="flex items-center min-h-11 py-1">
                    <div className="w-56 px-2 flex-shrink-0 flex items-center gap-1">
                      {row.expandable ? (
                        <button onClick={() => toggleRow(row.id)}
                          className="text-gray-400 hover:text-blue-500 flex-shrink-0 p-0.5 rounded transition-colors">
                          <svg className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      ) : <div className="w-4 flex-shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{row.label}</p>
                        {row.sublabel && <p className="text-xs text-gray-400 truncate">{row.sublabel}</p>}
                        {row.tags && row.tags.length > 0 && (
                          <div className="flex flex-wrap gap-0.5 mt-0.5">
                            {row.tags.map(t => (
                              <span key={t} className="px-1 rounded text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 text-xs">{t}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {zoom === "year" ? (
                      <div className="flex-1 relative h-6 bg-gray-50 dark:bg-gray-800/30 rounded overflow-hidden">
                        {displayYears.map((yr, i) => (
                          <div key={yr} className="absolute top-0 bottom-0 border-l border-gray-200 dark:border-gray-700" style={{ left: `${(i / displayYears.length) * 100}%` }} />
                        ))}
                        {row.segments ? (
                          row.segments.map((seg, si) => {
                            const sl = pct(seg.startDate);
                            const sr = pct(seg.endDate);
                            const sw = Math.max(0.3, sr - sl);
                            const rnd = si === 0 ? "rounded-l" : si === row.segments!.length - 1 ? "rounded-r" : "";
                            return (
                              <div key={si} className={`absolute top-1 bottom-1 ${rnd} ${seg.color} opacity-85 hover:opacity-100 transition-opacity`}
                                style={{ left: `${sl}%`, width: `${sw}%` }}
                                title={`${seg.startDate.toLocaleDateString()} → ${seg.endDate.toLocaleDateString()}`} />
                            );
                          })
                        ) : start && (
                          <div className={`absolute top-1 bottom-1 rounded ${row.color} opacity-85 hover:opacity-100 transition-opacity`}
                            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                            title={`${start.toLocaleDateString()} → ${end ? end.toLocaleDateString() : "ongoing"}`} />
                        )}
                      </div>
                    ) : (
                      <div className="flex" style={{ height: 36 }}>
                        {allMonths.map(({ yr, mo, key }) => {
                          const cellStart = new Date(yr, mo, 1).getTime();
                          const cellEnd = new Date(yr, mo + 1, 0).getTime();
                          let active = false;
                          let barColor = row.color;
                          if (row.segments) {
                            const activeSeg = row.segments.find(s => s.startDate.getTime() <= cellEnd && s.endDate.getTime() >= cellStart);
                            active = !!activeSeg;
                            if (activeSeg) barColor = activeSeg.color;
                          } else {
                            active = !!(start && end
                              ? start.getTime() <= cellEnd && end.getTime() >= cellStart
                              : start ? start.getTime() <= cellEnd : false);
                          }
                          return (
                            <div key={key} style={{ width: 36, flexShrink: 0, height: 36 }}
                              className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"} flex items-center justify-center`}>
                              {active && <div className={`w-full h-4 mx-0.5 rounded-sm ${barColor} opacity-85`} />}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  {/* Expanded children */}
                  {isExpanded && row.children?.map(child => {
                    const cs = child.startDate;
                    const ce = child.endDate;
                    const clPct = cs ? pct(cs) : 0;
                    const crPct = ce ? pct(ce) : 100;
                    const cwPct = Math.max(0.4, crPct - clPct);
                    return (
                      <div key={child.id} className="flex items-center min-h-9 py-0.5 bg-gray-50/60 dark:bg-gray-800/20">
                        <div className="w-56 pl-8 pr-2 flex-shrink-0">
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{child.label}</p>
                          {child.sublabel && <p className="text-xs text-gray-400 truncate">{child.sublabel}</p>}
                        </div>
                        {zoom === "year" ? (
                          <div className="flex-1 relative h-5 overflow-hidden">
                            {displayYears.map((yr, i) => (
                              <div key={yr} className="absolute top-0 bottom-0 border-l border-gray-200 dark:border-gray-700" style={{ left: `${(i / displayYears.length) * 100}%` }} />
                            ))}
                            {cs && (
                              <div className={`absolute top-0.5 bottom-0.5 rounded ${child.color} opacity-60`}
                                style={{ left: `${clPct}%`, width: `${cwPct}%` }}
                                title={`${cs.toLocaleDateString()} → ${ce ? ce.toLocaleDateString() : "ongoing"}`} />
                            )}
                          </div>
                        ) : (
                          <div className="flex" style={{ height: 36 }}>
                            {allMonths.map(({ yr, mo, key }) => {
                              const cellStart = new Date(yr, mo, 1).getTime();
                              const cellEnd = new Date(yr, mo + 1, 0).getTime();
                              const active = cs && ce
                                ? cs.getTime() <= cellEnd && ce.getTime() >= cellStart
                                : cs ? cs.getTime() <= cellEnd : false;
                              return (
                                <div key={key} style={{ width: 36, flexShrink: 0, height: 36 }}
                                  className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"} flex items-center justify-center`}>
                                  {active && <div className={`w-full h-3 mx-0.5 rounded-sm ${child.color} opacity-60`} />}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>

          {/* Existing ratio bar (headcount gantt) */}
          {(countableRows.length > 0 || hasRatio) && !hasActiveBars && (
            <div className="flex items-center h-6 mt-1 border-t border-dashed border-gray-200 dark:border-gray-700 pt-1">
              <div className="w-56 px-3 flex-shrink-0">
                <p className="text-xs text-gray-400 italic">{hasRatio ? "contracts/tech" : "concurrent"}</p>
              </div>
              {zoom === "year" ? (
                <div className="flex-1 flex h-5">
                  {displayYears.map(yr => {
                    if (hasRatio) {
                      const { contracts, tech } = getRatioCounts(new Date(yr, 0, 1), new Date(yr, 11, 31, 23));
                      if (tech === 0) return <div key={yr} className="flex-1 border-l border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 rounded-sm" />;
                      const ratio = contracts / tech;
                      const bg = ratio === 0 ? "bg-gray-100 dark:bg-gray-800" : ratio < 1 ? "bg-green-300 dark:bg-green-800" : ratio < 2 ? "bg-yellow-300 dark:bg-yellow-800" : ratio < 3 ? "bg-orange-300 dark:bg-orange-800" : "bg-red-400 dark:bg-red-700";
                      const text = ratio === 0 ? "text-gray-300 dark:text-gray-600" : ratio < 1 ? "text-green-800 dark:text-green-200" : ratio < 2 ? "text-yellow-800 dark:text-yellow-200" : "text-white";
                      return (
                        <div key={yr} title={`${contracts} contracts / ${tech} tech = ${ratio.toFixed(1)}`}
                          className={`flex-1 border-l border-gray-200 dark:border-gray-700 flex items-center justify-center rounded-sm ${bg}`}>
                          <span className={`text-xs font-bold ${text}`}>{ratio.toFixed(1)}</span>
                        </div>
                      );
                    } else {
                      const active = getConcurrency(new Date(yr, 0, 1), new Date(yr, 11, 31, 23));
                      const n = active.length;
                      const bg = n === 0 ? "bg-gray-100 dark:bg-gray-800" : n === 1 ? "bg-green-300 dark:bg-green-800" : n === 2 ? "bg-yellow-300 dark:bg-yellow-800" : n === 3 ? "bg-orange-300 dark:bg-orange-800" : "bg-red-400 dark:bg-red-700";
                      const text = n === 0 ? "text-gray-300 dark:text-gray-600" : n === 1 ? "text-green-800 dark:text-green-200" : n === 2 ? "text-yellow-800 dark:text-yellow-200" : "text-white";
                      return (
                        <div key={yr} title={n > 0 ? `${n} concurrent: ${active.map(r => r.label).join(", ")}` : ""}
                          className={`flex-1 border-l border-gray-200 dark:border-gray-700 flex items-center justify-center rounded-sm ${bg}`}>
                          {n > 0 && <span className={`text-xs font-bold ${text}`}>{n}</span>}
                        </div>
                      );
                    }
                  })}
                </div>
              ) : (
                <div className="flex" style={{ height: 20 }}>
                  {allMonths.map(({ yr, mo, key }) => {
                    if (hasRatio) {
                      const { contracts, tech } = getRatioCounts(new Date(yr, mo, 1), new Date(yr, mo + 1, 0, 23));
                      if (tech === 0) return <div key={key} style={{ width: 36, flexShrink: 0, height: 20 }} className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"}`} />;
                      const ratio = contracts / tech;
                      const bg = ratio === 0 ? "" : ratio < 1 ? "bg-green-300 dark:bg-green-800" : ratio < 2 ? "bg-yellow-300 dark:bg-yellow-800" : ratio < 3 ? "bg-orange-300 dark:bg-orange-800" : "bg-red-400 dark:bg-red-700";
                      return (
                        <div key={key} style={{ width: 36, flexShrink: 0, height: 20 }}
                          title={`${contracts}/${tech} = ${ratio.toFixed(1)}`}
                          className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"} flex items-center justify-center ${bg}`}>
                          {ratio > 0 && <span className="text-xs font-bold text-white dark:text-gray-100" style={{ fontSize: 10 }}>{ratio.toFixed(1)}</span>}
                        </div>
                      );
                    } else {
                      const active = getConcurrency(new Date(yr, mo, 1), new Date(yr, mo + 1, 0, 23));
                      const n = active.length;
                      const bg = n === 0 ? "" : n === 1 ? "bg-green-300 dark:bg-green-800" : n === 2 ? "bg-yellow-300 dark:bg-yellow-800" : n === 3 ? "bg-orange-300 dark:bg-orange-800" : "bg-red-400 dark:bg-red-700";
                      return (
                        <div key={key} style={{ width: 36, flexShrink: 0, height: 20 }}
                          title={n > 0 ? `${n} concurrent: ${active.map(r => r.label).join(", ")}` : ""}
                          className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"} flex items-center justify-center ${bg}`}>
                          {n > 0 && <span className="text-xs font-bold text-white dark:text-gray-100">{n}</span>}
                        </div>
                      );
                    }
                  })}
                </div>
              )}
            </div>
          )}

          {/* Active projects + Licensing/Service bars (contracts gantt) */}
          {hasActiveBars && (() => {
            function countTrack(track: TrackEntry[], from: Date, to: Date) {
              return track.filter(r => r.startDate.getTime() < to.getTime() && r.endDate.getTime() > from.getTime());
            }
            function barBg(n: number) {
              return n === 0 ? "bg-gray-100 dark:bg-gray-800" : n === 1 ? "bg-green-200 dark:bg-green-900" : n === 2 ? "bg-green-400 dark:bg-green-700" : n <= 4 ? "bg-blue-400 dark:bg-blue-700" : "bg-blue-600 dark:bg-blue-500";
            }
            function barText(n: number) {
              return n === 0 ? "text-gray-300 dark:text-gray-600" : n <= 2 ? "text-green-900 dark:text-green-100" : "text-white";
            }
            function svcBg(n: number) {
              return n === 0 ? "bg-gray-100 dark:bg-gray-800" : n === 1 ? "bg-orange-200 dark:bg-orange-900" : n === 2 ? "bg-orange-300 dark:bg-orange-800" : n <= 4 ? "bg-orange-500 dark:bg-orange-600" : "bg-orange-600 dark:bg-orange-500";
            }
            const aTrack = activeTrack || [];
            const sTrack = serviceTrack || [];
            const bars: Array<{ label: string; track: TrackEntry[]; bg: (n:number)=>string; text: (n:number)=>string }> = [
              ...(aTrack.length > 0 ? [{ label: "active projects", track: aTrack, bg: barBg, text: barText }] : []),
              ...(sTrack.length > 0 ? [{ label: "licensing/service", track: sTrack, bg: svcBg, text: barText }] : []),
            ];
            return (
              <div className="mt-2 border-t border-dashed border-gray-200 dark:border-gray-700 pt-2 space-y-1">
                {bars.map(bar => (
                  <div key={bar.label} className="flex items-center h-6">
                    <div className="w-56 px-3 flex-shrink-0">
                      <p className="text-xs text-gray-400 italic">{bar.label}</p>
                    </div>
                    {zoom === "year" ? (
                      <div className="flex-1 flex h-5">
                        {displayYears.map(yr => {
                          const items = countTrack(bar.track, new Date(yr, 0, 1), new Date(yr, 11, 31, 23));
                          const n = items.length;
                          const labels = items.map(r => r.label || "").filter(Boolean).join(", ");
                          return (
                            <div key={yr} title={labels || undefined}
                              className={`flex-1 border-l border-gray-200 dark:border-gray-700 flex items-center justify-center rounded-sm ${bar.bg(n)}`}>
                              {n > 0 && <span className={`text-xs font-bold ${bar.text(n)}`}>{n}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex" style={{ height: 20 }}>
                        {allMonths.map(({ yr, mo, key }) => {
                          const items = countTrack(bar.track, new Date(yr, mo, 1), new Date(yr, mo + 1, 0, 23));
                          const n = items.length;
                          return (
                            <div key={key} style={{ width: 36, flexShrink: 0, height: 20 }}
                              className={`border-l ${mo === 0 ? "border-gray-400 dark:border-gray-500" : "border-gray-100 dark:border-gray-800"} flex items-center justify-center ${bar.bg(n)}`}>
                              {n > 0 && <span className={`font-bold ${bar.text(n)}`} style={{ fontSize: 10 }}>{n}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Today line */}
          {zoom === "year" && (() => {
            const todayPct = pct(new Date());
            if (todayPct < 0 || todayPct > 100) return null;
            const nearLeft = todayPct < 8;
            return (
              <div className="flex ml-56 mt-2 relative h-4">
                <div className="flex-1 relative">
                  <div className="absolute top-0 bottom-0 border-l-2 border-blue-500 opacity-70" style={{ left: `${todayPct}%` }}>
                    <span
                      className="absolute top-0 text-blue-500 font-medium whitespace-nowrap"
                      style={{ fontSize: 10, ...(nearLeft ? { left: 4 } : { transform: "translateX(-50%)" }) }}>
                      {new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}

function DriversTab({ model, onModelUpdate }: { model: FpaModel; onModelUpdate: (m: FpaModel) => void }) {
  const [contracts, setContracts] = useState<ContractEntry[]>(() =>
    (model.contract_pipeline || []).map(c => {
      // migrate old single-type fields to split consumable/licensing amounts
      const oldAmt = (c as {recurring_monthly_amount?: number}).recurring_monthly_amount ?? 0;
      const oldType = (c as {recurring_type?: string}).recurring_type ?? "consumable_recurring";
      const migratedConsumable = (c as {recurring_consumable_amount?: number}).recurring_consumable_amount ?? (oldType === "consumable_recurring" ? oldAmt : 0);
      const migratedLicensing  = (c as {recurring_licensing_amount?: number}).recurring_licensing_amount  ?? (oldType === "licensing_recurring"  ? oldAmt : 0);
      return { end_date: "", monthly_amount: 0, annual_increase_pct: 0, recurring_after_fixed: false, recurring_consumable_amount: migratedConsumable, recurring_licensing_amount: migratedLicensing, recurring_years: 3, ...c, id: c.id || uuid4() };
    })
  );
  const [contractSubTab, setContractSubTab] = useState<"fixed" | "recurring">("fixed");
  const [headcount, setHeadcount] = useState<HeadcountEntry[]>(() =>
    (model.headcount_schedule || []).map(e => ({ salary_overrides: {}, ...e, id: e.id || uuid4() }))
  );
  const [expenses, setExpenses] = useState<ExpenseEntry[]>(() =>
    (model.expense_schedule || []).map(e => ({ amount_overrides: {}, ...e, id: e.id || uuid4() }))
  );
  const [editExpense, setEditExpense] = useState<string | null>(null);
  const [funding, setFunding] = useState<FundingEntry[]>(() =>
    (model.funding_schedule || []).map(f => ({ ...f, id: f.id || uuid4() }))
  );
  const [editFunding, setEditFunding] = useState<string | null>(null);
  const [fundSubTab, setFundSubTab] = useState<"dilutive" | "nondilutive">("dilutive");
  const [section, setSection] = useState<"contracts" | "headcount" | "expenses" | "funding">("contracts");
  const [sectionView, setSectionView] = useState<Record<string, "table" | "gantt">>({});
  const [recalcing, setRecalcing] = useState(false);
  const [previewAnnual, setPreviewAnnual] = useState<AnnualData[]>(model.annual_data || []);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editContract, setEditContract] = useState<string | null>(null);
  const [editHeadcount, setEditHeadcount] = useState<string | null>(null);
  const [contractFilter, setContractFilter] = useState("");
  const [contractSort, setContractSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState<Record<string, string>>({});
  const [expandedHeadcount, setExpandedHeadcount] = useState<Set<string>>(new Set());
  const [expandedExpenses, setExpandedExpenses] = useState<Set<string>>(new Set());
  const modelYears = useMemo(() => {
    const sy = model.start_year || new Date().getFullYear();
    return Array.from({ length: 10 }, (_, i) => sy + i);
  }, [model.start_year]);

  // Auto-save: debounce 1.2s after any driver change
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(async () => {
      setRecalcing(true);
      setSaveMsg(null);
      try {
        const r = await fetch("/api/proxy/fpa/model", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contract_pipeline: contracts, headcount_schedule: headcount, expense_schedule: expenses, funding_schedule: funding }),
        });
        if (!r.ok) { setSaveMsg({ ok: false, text: "Save failed" }); return; }
        const r2 = await fetch("/api/proxy/fpa/model/recalculate", { method: "POST" });
        if (!r2.ok) { setSaveMsg({ ok: false, text: "Recalculation failed" }); return; }
        const data = await r2.json();
        setPreviewAnnual(data.annual_data || []);
        onModelUpdate({ ...model, contract_pipeline: contracts, headcount_schedule: headcount, expense_schedule: expenses, funding_schedule: funding, annual_data: data.annual_data, monthly_data: data.monthly_data });
        setSaveMsg({ ok: true, text: "Saved" });
      } finally {
        setRecalcing(false);
      }
    }, 1200);
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current); };
  }, [contracts, headcount, expenses, funding]); // eslint-disable-line react-hooks/exhaustive-deps


  function addContract(type: ContractEntry["type"] = "rd_contract") {
    const isRecurring = RECURRING_CONTRACT_TYPES.includes(type);
    const c: ContractEntry = {
      id: uuid4(), name: isRecurring ? "New Recurring Revenue" : "New Contract",
      type, client: "",
      start_date: new Date().toISOString().slice(0, 10),
      end_date: "", duration_months: 6, total_value: 0,
      monthly_amount: 0, annual_increase_pct: 0,
      probability: 1.0, status: "pipeline", notes: "",
      recurring_after_fixed: false, recurring_consumable_amount: 0, recurring_licensing_amount: 0, recurring_years: 3,
      tags: selectedTags.size > 0 ? [...selectedTags] : [],
    };
    setContracts(prev => [...prev, c]);
    setEditContract(c.id);
  }

  function updateContract(id: string, field: keyof ContractEntry, value: unknown) {
    setContracts(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  }

  function updateFixedContract(id: string, field: "start_date" | "end_date" | "duration_months", value: string | number) {
    setContracts(prev => prev.map(c => {
      if (c.id !== id) return c;
      if (field === "duration_months") {
        const dur = Math.max(1, parseInt(String(value)) || 1);
        const start = c.start_date ? new Date(c.start_date) : null;
        const end = start ? new Date(start.getFullYear(), start.getMonth() + dur, 1).toISOString().slice(0, 10) : "";
        return { ...c, duration_months: dur, end_date: end };
      } else if (field === "start_date") {
        const startStr = String(value);
        const start = startStr ? new Date(startStr) : null;
        const dur = c.duration_months || 1;
        const end = start ? new Date(start.getFullYear(), start.getMonth() + dur, 1).toISOString().slice(0, 10) : "";
        return { ...c, start_date: startStr, end_date: end };
      } else {
        const endStr = String(value);
        const end = endStr ? new Date(endStr) : null;
        const start = c.start_date ? new Date(c.start_date) : null;
        const dur = (start && end) ? Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())) : c.duration_months;
        return { ...c, end_date: endStr, duration_months: dur };
      }
    }));
  }

  function removeContract(id: string) {
    setContracts(prev => prev.filter(c => c.id !== id));
  }

  function addHeadcount() {
    const e: HeadcountEntry = {
      id: uuid4(), role: "New Role", department: "tech",
      start_date: new Date().toISOString().slice(0, 10),
      end_date: "", annual_salary: 0, benefits_pct: 0.25, annual_raise_pct: 0.03, salary_overrides: {}, notes: "",
    };
    setHeadcount(prev => [...prev, e]);
    setEditHeadcount(e.id);
  }

  function updateHeadcount(id: string, field: keyof HeadcountEntry, value: unknown) {
    setHeadcount(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  }

  function removeHeadcount(id: string) {
    setHeadcount(prev => prev.filter(e => e.id !== id));
  }

  function addExpense() {
    const e: ExpenseEntry = {
      id: uuid4(), name: "New Expense", category: "office_expense",
      monthly_amount: 0, annual_increase_pct: 0.02, amount_overrides: {},
      start_date: new Date().toISOString().slice(0, 10),
      end_date: "", notes: "",
    };
    setExpenses(prev => [...prev, e]);
    setEditExpense(e.id);
  }

  function updateExpense(id: string, field: keyof ExpenseEntry, value: unknown) {
    setExpenses(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
  }

  function removeExpense(id: string) {
    setExpenses(prev => prev.filter(e => e.id !== id));
  }

  function addFunding(type: FundingEntry["type"]) {
    const isDilutive = DILUTIVE_TYPES.includes(type);
    const f: FundingEntry = {
      id: uuid4(),
      name: type === "sbir" ? "SBIR Phase I" : type === "grant" ? "New Grant" : type === "loan" ? "New Loan" : "New Round",
      type,
      pre_money_valuation: 0, dilution_pct: 0,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      disbursement: isDilutive ? "lump_sum" : "monthly",
      start_date: new Date().toISOString().slice(0, 10),
      end_date: "", monthly_amount: 0, annual_increase_pct: 0,
      notes: "",
    };
    setFunding(prev => [...prev, f]);
    setEditFunding(f.id);
  }

  function updateFunding(id: string, field: keyof FundingEntry, value: unknown) {
    setFunding(prev => prev.map(f => f.id === id ? { ...f, [field]: value } : f));
  }

  function removeFunding(id: string) {
    setFunding(prev => prev.filter(f => f.id !== id));
  }

  const years = useMemo(() => [...new Set(previewAnnual.map(d => d.year))].sort(), [previewAnnual]);
  const previewByYear = useMemo(() => Object.fromEntries(previewAnnual.map(d => [d.year, d])), [previewAnnual]);

  // Pipeline totals
  const totalPipelineValue = contracts.reduce((s, c) => s + (c.total_value || 0), 0);
  const totalWeighted = contracts.reduce((s, c) => s + (c.total_value || 0) * (c.probability || 0), 0);
  const totalMonthlyPayroll = headcount.reduce((s, e) => s + (e.annual_salary || 0) / 12 * (1 + (e.benefits_pct || 0.25)), 0);

  const allContractTags = useMemo(() => {
    const seen = new Set<string>();
    contracts.forEach(c => (c.tags || []).forEach(t => seen.add(t)));
    return [...seen].sort();
  }, [contracts]);

  const sortedFilteredContracts = useMemo(() => {
    const q = contractFilter.toLowerCase();
    let result = q
      ? contracts.filter(c =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.client || "").toLowerCase().includes(q) ||
          CONTRACT_TYPE_LABELS[c.type].toLowerCase().includes(q) ||
          (c.tags || []).some(t => t.toLowerCase().includes(q))
        )
      : contracts;
    if (selectedTags.size > 0) {
      result = result.filter(c => [...selectedTags].every(t => (c.tags || []).includes(t)));
    }
    if (contractSort) {
      result = [...result].sort((a, b) => {
        let va: string | number = "", vb: string | number = "";
        switch (contractSort.field) {
          case "name":     va = a.name || ""; vb = b.name || ""; break;
          case "type":     va = CONTRACT_TYPE_LABELS[a.type]; vb = CONTRACT_TYPE_LABELS[b.type]; break;
          case "client":   va = a.client || ""; vb = b.client || ""; break;
          case "start":    va = a.start_date || ""; vb = b.start_date || ""; break;
          case "end":      va = a.end_date || ""; vb = b.end_date || ""; break;
          case "duration": va = a.duration_months || 0; vb = b.duration_months || 0; break;
          case "value":    va = a.total_value || 0; vb = b.total_value || 0; break;
          case "monthly":  va = a.monthly_amount || 0; vb = b.monthly_amount || 0; break;
          case "growth":   va = a.annual_increase_pct || 0; vb = b.annual_increase_pct || 0; break;
          case "status":   va = a.status || ""; vb = b.status || ""; break;
        }
        const cmp = typeof va === "number"
          ? va - (vb as number)
          : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return contractSort.dir === "asc" ? cmp : -cmp;
      });
    }
    return result;
  }, [contracts, contractFilter, contractSort, selectedTags]);

  function toggleContractSort(field: string) {
    setContractSort(s => s?.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" });
  }

  function tagColor(tag: string) {
    const palette = ["bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300","bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300","bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300","bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300","bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300","bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300"];
    return palette[tag.split("").reduce((h, c) => h + c.charCodeAt(0), 0) % palette.length];
  }

  const inputCls = "px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 w-full";
  const selCls = inputCls + " cursor-pointer";

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
        {recalcing
          ? <><span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /><span className="text-blue-600 dark:text-blue-400">Saving…</span></>
          : saveMsg?.ok
            ? <><span className="text-green-600 dark:text-green-400">✓ Saved</span></>
            : saveMsg
              ? <span className="text-red-500">{saveMsg.text}</span>
              : <span>Changes save automatically.</span>
        }
      </div>

      {/* Preview strip */}
      {previewAnnual.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 overflow-x-auto">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Model Preview — Annual</p>
          <table className="text-xs w-full min-w-max">
            <thead>
              <tr className="text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left pb-1.5 font-medium pr-4">Metric</th>
                {years.map(y => <th key={y} className="text-right pb-1.5 px-2 font-medium">{y}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {[
                { label: "Revenue", key: "total_revenue" as keyof AnnualData, color: "text-green-700 dark:text-green-400" },
                { label: "Total OpEx", key: "total_opex" as keyof AnnualData, color: "text-red-600 dark:text-red-400" },
                { label: "EBITDA", key: "ebitda" as keyof AnnualData, color: "" },
              ].map(row => (
                <tr key={row.key}>
                  <td className="py-1 font-medium text-gray-600 dark:text-gray-300 pr-4">{row.label}</td>
                  {years.map(yr => {
                    const val = ((previewByYear[yr] as unknown as Record<string, unknown>)?.[row.key] ?? 0) as number;
                    const clr = row.key === "ebitda"
                      ? val >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                      : row.color;
                    return (
                      <td key={yr} className={`py-1 px-2 text-right font-mono ${clr}`}>
                        {val >= 0 ? fmt$(val) : `(${fmt$(Math.abs(val))})`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Section tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
        <button onClick={() => setSection("contracts")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${section === "contracts" ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
          Contract Pipeline ({contracts.length})
        </button>
        <button onClick={() => setSection("headcount")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${section === "headcount" ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
          Headcount ({headcount.length})
        </button>
        <button onClick={() => setSection("expenses")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${section === "expenses" ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
          Expenses ({expenses.length})
        </button>
        <button onClick={() => setSection("funding")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${section === "funding" ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
          Funding ({funding.length})
        </button>
      </div>

      {/* Contract Pipeline */}
      {section === "contracts" && (
        <div className="space-y-3">
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            {/* Sub-tab bar */}
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4">
              <div className="flex gap-1 items-center">
                {(["fixed","recurring"] as const).map(t => (
                  <button key={t} onClick={() => setContractSubTab(t)}
                    className={`px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${contractSubTab === t ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                    {t === "fixed" ? `Fixed Contracts (${contracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type)).length})` : `Recurring Revenue (${
                      contracts.filter(c => RECURRING_CONTRACT_TYPES.includes(c.type)).length +
                      contracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type) && c.recurring_after_fixed && ((c.recurring_consumable_amount || 0) > 0 || (c.recurring_licensing_amount || 0) > 0)).reduce((n, c) => n + ((c.recurring_consumable_amount || 0) > 0 ? 1 : 0) + ((c.recurring_licensing_amount || 0) > 0 ? 1 : 0), 0)
                    })`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 py-2 flex-wrap">
                <input
                  type="text"
                  placeholder="Filter by name, client, type, tag…"
                  value={contractFilter}
                  onChange={e => setContractFilter(e.target.value)}
                  className="text-xs px-2 py-1 border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:border-blue-400 w-48"
                />
                {contractFilter && (
                  <button onClick={() => setContractFilter("")} className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                )}
                {allContractTags.map(t => (
                  <button key={t} onClick={() => setSelectedTags(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${selectedTags.has(t) ? `${tagColor(t)} border-transparent` : "border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-gray-400"}`}>
                    {t}
                  </button>
                ))}
                {selectedTags.size > 0 && (
                  <button onClick={() => setSelectedTags(new Set())} className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">clear tags</button>
                )}
                {contractSort && (
                  <button onClick={() => setContractSort(null)} className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">clear sort</button>
                )}
                <div className="flex-1" />
                {contractSubTab === "fixed"
                  ? <button onClick={() => addContract("rd_contract")}
                      className="text-xs px-3 py-1.5 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 transition-colors">+ Add Contract</button>
                  : <div className="flex gap-2">
                      {(["consumable_recurring","licensing_recurring"] as const).map(t => (
                        <button key={t} onClick={() => addContract(t)}
                          className="text-xs px-2 py-1 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-orange-400 hover:text-orange-600 transition-colors">
                          + {t === "consumable_recurring" ? "Consumables" : "Licensing"}
                        </button>
                      ))}
                    </div>}
              </div>
            </div>

            {/* Fixed contracts table */}
            {contractSubTab === "fixed" && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 select-none">
                      {([["name","Name","left"],["type","Type","left"],["client","Client","left"],["start","Start","left"],["end","End","left"],["duration","Duration","right"],["value","Value","right"],["status","Status","left"]] as [string,string,string][]).map(([f,label,align]) => (
                        <th key={f} onClick={() => toggleContractSort(f)}
                          className={`text-${align} px-3 py-2 font-medium cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 whitespace-nowrap`}>
                          {label}{contractSort?.field === f ? (contractSort.dir === "asc" ? " ▲" : " ▼") : <span className="text-gray-300 dark:text-gray-600"> ↕</span>}
                        </th>
                      ))}
                      <th className="text-left px-3 py-2 font-medium">Tags</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {sortedFilteredContracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type)).map(c => {
                      const isEditing = editContract === c.id;
                      return (
                        <Fragment key={c.id}>
                        <tr className={`${isEditing ? "bg-blue-50/40 dark:bg-blue-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                          <td className="px-2 py-1.5">{isEditing ? <input type="text" className={inputCls} value={c.name} onChange={e => updateContract(c.id, "name", e.target.value)} /> : <span className="text-gray-800 dark:text-gray-200 font-medium">{c.name}</span>}</td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={c.type} onChange={e => updateContract(c.id, "type", e.target.value)}>
                                  {(["rd_contract","portfolio","maintenance","grant"] as ContractEntry["type"][]).map(t => (
                                    <option key={t} value={t}>{CONTRACT_TYPE_LABELS[t]}</option>
                                  ))}
                                </select>
                              : <span className="text-gray-600 dark:text-gray-400">{CONTRACT_TYPE_LABELS[c.type]}</span>}
                          </td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="text" className={inputCls} value={c.client} onChange={e => updateContract(c.id, "client", e.target.value)} /> : <span className="text-gray-600 dark:text-gray-400">{c.client || "—"}</span>}</td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="date" className={inputCls} value={c.start_date} onChange={e => updateFixedContract(c.id, "start_date", e.target.value)} /> : <span className="text-gray-600 dark:text-gray-400 font-mono">{c.start_date}</span>}</td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="date" className={inputCls} value={c.end_date || (c.start_date && c.duration_months ? new Date(new Date(c.start_date).getFullYear(), new Date(c.start_date).getMonth() + c.duration_months, 1).toISOString().slice(0, 10) : "")} onChange={e => updateFixedContract(c.id, "end_date", e.target.value)} /> : <span className="text-gray-600 dark:text-gray-400 font-mono">{c.start_date && c.duration_months ? new Date(new Date(c.start_date).getFullYear(), new Date(c.start_date).getMonth() + c.duration_months, 1).toISOString().slice(0, 10) : (c.end_date || "—")}</span>}</td>
                          <td className="px-2 py-1.5 text-right">{isEditing ? <input type="number" min={1} className={inputCls + " text-right w-16"} value={c.duration_months} onChange={e => updateFixedContract(c.id, "duration_months", parseInt(e.target.value) || 1)} /> : <span className="text-gray-600 dark:text-gray-400 font-mono">{c.duration_months}mo</span>}</td>
                          <td className="px-2 py-1.5 text-right">{isEditing ? <input type="number" min={0} step={1000} className={inputCls + " text-right"} value={c.total_value} onChange={e => updateContract(c.id, "total_value", parseFloat(e.target.value) || 0)} /> : <span className="text-gray-800 dark:text-gray-200 font-mono">{fmt$(c.total_value)}</span>}</td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={c.status} onChange={e => updateContract(c.id, "status", e.target.value)}>
                                  <option value="pipeline">Pipeline</option><option value="active">Active</option><option value="completed">Completed</option>
                                </select>
                              : <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${c.status === "active" ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300" : c.status === "pipeline" ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300" : "bg-gray-100 dark:bg-gray-800 text-gray-500"}`}>{c.status}</span>}
                          </td>
                          <td className="px-2 py-1.5 max-w-[200px]">
                            <div className="flex flex-wrap gap-0.5">
                              {c.recurring_after_fixed && ((c.recurring_consumable_amount || 0) > 0 || (c.recurring_licensing_amount || 0) > 0) && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">recurring</span>
                              )}
                              {(c.tags || []).map(tag => (
                                <span key={tag} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${tagColor(tag)}`}>
                                  {tag}
                                  {isEditing && <button onClick={() => updateContract(c.id, "tags", (c.tags || []).filter(t => t !== tag))} className="hover:opacity-70 ml-0.5">×</button>}
                                </span>
                              ))}
                              {isEditing && (
                                <input
                                  type="text"
                                  placeholder="add tag…"
                                  value={tagInput[c.id] || ""}
                                  onChange={e => setTagInput(prev => ({ ...prev, [c.id]: e.target.value }))}
                                  onKeyDown={e => {
                                    if ((e.key === "Enter" || e.key === ",") && tagInput[c.id]?.trim()) {
                                      e.preventDefault();
                                      const t = tagInput[c.id].trim().replace(/,$/, "");
                                      if (t && !(c.tags || []).includes(t)) updateContract(c.id, "tags", [...(c.tags || []), t]);
                                      setTagInput(prev => ({ ...prev, [c.id]: "" }));
                                    }
                                  }}
                                  className="text-xs px-1.5 py-0.5 border border-dashed border-gray-300 dark:border-gray-600 rounded bg-transparent text-gray-500 focus:outline-none focus:border-blue-400 w-20"
                                />
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <button onClick={() => setEditContract(isEditing ? null : c.id)} className="text-gray-400 hover:text-blue-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">{isEditing ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}</svg>
                              </button>
                              <button onClick={() => removeContract(c.id)} className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isEditing && (
                          <tr className="bg-blue-50/60 dark:bg-blue-950/30 border-t border-blue-100 dark:border-blue-900">
                            <td colSpan={10} className="px-4 py-2">
                              <div className="flex items-center gap-4 flex-wrap">
                                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 font-medium cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={!!c.recurring_after_fixed}
                                    onChange={e => updateContract(c.id, "recurring_after_fixed", e.target.checked)}
                                    className="rounded"
                                  />
                                  Start recurring revenue when contract ends
                                </label>
                                {c.recurring_after_fixed && (
                                  <>
                                    <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                      <span className="text-orange-500 dark:text-orange-400 font-medium">Consumables</span>/mo:
                                      <input type="number" min={0} step={100} className={inputCls + " w-24 text-right"} value={c.recurring_consumable_amount || 0} onChange={e => updateContract(c.id, "recurring_consumable_amount", parseFloat(e.target.value) || 0)} />
                                    </label>
                                    <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                      <span className="text-purple-500 dark:text-purple-400 font-medium">Licensing</span>/mo:
                                      <input type="number" min={0} step={100} className={inputCls + " w-24 text-right"} value={c.recurring_licensing_amount || 0} onChange={e => updateContract(c.id, "recurring_licensing_amount", parseFloat(e.target.value) || 0)} />
                                    </label>
                                    <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                      Years:
                                      <input type="number" min={1} max={20} step={1} className={inputCls + " w-16 text-right"} value={c.recurring_years ?? 3} onChange={e => updateContract(c.id, "recurring_years", parseInt(e.target.value) || 1)} />
                                    </label>
                                    {((c.recurring_consumable_amount || 0) > 0 || (c.recurring_licensing_amount || 0) > 0) && (
                                      <span className="text-xs text-blue-500 dark:text-blue-400">
                                        → {[
                                          (c.recurring_consumable_amount || 0) > 0 && `${fmt$(c.recurring_consumable_amount || 0)} consumables`,
                                          (c.recurring_licensing_amount  || 0) > 0 && `${fmt$(c.recurring_licensing_amount  || 0)} licensing`,
                                        ].filter(Boolean).join(" + ")}/mo for {c.recurring_years ?? 3}yr
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                    {contracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type)).length === 0 && (
                      <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400 text-xs">No fixed contracts yet — click &quot;Add Contract&quot; to begin.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recurring revenue table */}
            {contractSubTab === "recurring" && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 select-none">
                      {([["name","Name","left"],["type","Type","left"],["client","Customer/Product","left"],["start","Deploy Date","left"],["end","End Date","left"],["monthly","Monthly Amount","right"],["growth","Annual Growth","right"],["status","Status","left"]] as [string,string,string][]).map(([f,label,align]) => (
                        <th key={f} onClick={() => toggleContractSort(f)}
                          className={`text-${align} px-3 py-2 font-medium cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 whitespace-nowrap`}>
                          {label}{contractSort?.field === f ? (contractSort.dir === "asc" ? " ▲" : " ▼") : <span className="text-gray-300 dark:text-gray-600"> ↕</span>}
                        </th>
                      ))}
                      <th className="text-left px-3 py-2 font-medium">Tags</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {sortedFilteredContracts.filter(c => RECURRING_CONTRACT_TYPES.includes(c.type)).map(c => {
                      const isEditing = editContract === c.id;
                      const inc = c.annual_increase_pct ?? 0;
                      return (
                        <tr key={c.id} className={`${isEditing ? "bg-orange-50/40 dark:bg-orange-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                          <td className="px-2 py-1.5">{isEditing ? <input type="text" className={inputCls} value={c.name} onChange={e => updateContract(c.id, "name", e.target.value)} /> : <span className="text-gray-800 dark:text-gray-200 font-medium">{c.name}</span>}</td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={c.type} onChange={e => updateContract(c.id, "type", e.target.value)}>
                                  {(["consumable_recurring","licensing_recurring"] as ContractEntry["type"][]).map(t => (
                                    <option key={t} value={t}>{CONTRACT_TYPE_LABELS[t]}</option>
                                  ))}
                                </select>
                              : <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${c.type === "consumable_recurring" ? "bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300" : "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300"}`}>{c.type === "consumable_recurring" ? "Consumables" : "Licensing"}</span>}
                          </td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="text" className={inputCls} value={c.client} onChange={e => updateContract(c.id, "client", e.target.value)} /> : <span className="text-gray-600 dark:text-gray-400">{c.client || "—"}</span>}</td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="date" className={inputCls} value={c.start_date} onChange={e => updateContract(c.id, "start_date", e.target.value)} /> : <span className="text-gray-600 dark:text-gray-400 font-mono">{c.start_date}</span>}</td>
                          <td className="px-2 py-1.5">{isEditing ? <input type="date" className={inputCls} value={c.end_date || ""} onChange={e => updateContract(c.id, "end_date", e.target.value)} /> : <span className="text-gray-500 dark:text-gray-500 font-mono">{c.end_date || "—"}</span>}</td>
                          <td className="px-2 py-1.5 text-right">{isEditing ? <input type="number" min={0} step={100} className={inputCls + " text-right"} value={c.monthly_amount || 0} onChange={e => updateContract(c.id, "monthly_amount", parseFloat(e.target.value) || 0)} /> : <span className="font-mono font-medium text-orange-600 dark:text-orange-400">{fmt$(c.monthly_amount || 0)}/mo</span>}</td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={inc} onChange={e => updateContract(c.id, "annual_increase_pct", parseFloat(e.target.value) || 0)} />
                              : <span className={`font-mono ${inc > 0 ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}>{inc > 0 ? `+${Math.round(inc * 100)}%/yr` : "—"}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={c.status} onChange={e => updateContract(c.id, "status", e.target.value)}>
                                  <option value="pipeline">Pipeline</option><option value="active">Active</option><option value="completed">Completed</option>
                                </select>
                              : <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${c.status === "active" ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300" : c.status === "pipeline" ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300" : "bg-gray-100 dark:bg-gray-800 text-gray-500"}`}>{c.status}</span>}
                          </td>
                          <td className="px-2 py-1.5 max-w-[160px]">
                            <div className="flex flex-wrap gap-0.5">
                              {(c.tags || []).map(tag => (
                                <span key={tag} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${tagColor(tag)}`}>
                                  {tag}
                                  {isEditing && <button onClick={() => updateContract(c.id, "tags", (c.tags || []).filter(t => t !== tag))} className="hover:opacity-70 ml-0.5">×</button>}
                                </span>
                              ))}
                              {isEditing && (
                                <input
                                  type="text"
                                  placeholder="add tag…"
                                  value={tagInput[c.id] || ""}
                                  onChange={e => setTagInput(prev => ({ ...prev, [c.id]: e.target.value }))}
                                  onKeyDown={e => {
                                    if ((e.key === "Enter" || e.key === ",") && tagInput[c.id]?.trim()) {
                                      e.preventDefault();
                                      const t = tagInput[c.id].trim().replace(/,$/, "");
                                      if (t && !(c.tags || []).includes(t)) updateContract(c.id, "tags", [...(c.tags || []), t]);
                                      setTagInput(prev => ({ ...prev, [c.id]: "" }));
                                    }
                                  }}
                                  className="text-xs px-1.5 py-0.5 border border-dashed border-gray-300 dark:border-gray-600 rounded bg-transparent text-gray-500 focus:outline-none focus:border-blue-400 w-20"
                                />
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <button onClick={() => setEditContract(isEditing ? null : c.id)} className="text-gray-400 hover:text-blue-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">{isEditing ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}</svg>
                              </button>
                              <button onClick={() => removeContract(c.id)} className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {contracts.filter(c => RECURRING_CONTRACT_TYPES.includes(c.type)).length === 0 &&
                     contracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type) && c.recurring_after_fixed).length === 0 && (
                      <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400 text-xs">No recurring revenue yet — add consumable or licensing entries above.</td></tr>
                    )}
                    {sortedFilteredContracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type) && c.recurring_after_fixed).flatMap(c => {
                      const startDate = c.start_date ? new Date(c.start_date) : null;
                      const recurStart = startDate ? new Date(startDate.getFullYear(), startDate.getMonth() + (c.duration_months || 0), 1) : null;
                      const recurEnd = recurStart ? new Date(recurStart.getFullYear() + (c.recurring_years ?? 0), recurStart.getMonth(), 1) : null;
                      const startStr = recurStart ? recurStart.toISOString().slice(0, 7) : "—";
                      const endStr = recurEnd ? recurEnd.toISOString().slice(0, 7) : "—";
                      const rows = [];
                      const types: Array<{ key: "consumable" | "licensing"; amt: number; label: string; color: string; textColor: string }> = [
                        { key: "consumable", amt: c.recurring_consumable_amount || 0, label: "Consumables", color: "bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300", textColor: "text-orange-600 dark:text-orange-400" },
                        { key: "licensing",  amt: c.recurring_licensing_amount  || 0, label: "Licensing",   color: "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300", textColor: "text-purple-600 dark:text-purple-400" },
                      ].filter(t => t.amt > 0);
                      if (types.length === 0) return rows;
                      types.forEach((t, i) => rows.push(
                        <tr key={`post-${c.id}-${t.key}`} className="bg-gray-50/60 dark:bg-gray-800/30 opacity-80">
                          <td className="px-2 py-1.5">
                            {i === 0 && <><span className="text-gray-600 dark:text-gray-400 font-medium">{c.name}</span><span className="ml-1.5 text-xs px-1 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded">post-contract</span></>}
                          </td>
                          <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-xs font-medium ${t.color}`}>{t.label}</span></td>
                          <td className="px-2 py-1.5 text-gray-500 dark:text-gray-400">{c.client || "—"}</td>
                          <td className="px-2 py-1.5 font-mono text-gray-500 dark:text-gray-400 text-xs">{startStr}</td>
                          <td className="px-2 py-1.5 font-mono text-gray-500 dark:text-gray-400 text-xs">{endStr}</td>
                          <td className={`px-2 py-1.5 text-right font-mono font-medium ${t.textColor}`}>{fmt$(t.amt)}/mo</td>
                          <td className="px-2 py-1.5 text-right text-gray-400">—</td>
                          <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-xs font-medium ${c.status === "active" ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300" : "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"}`}>{c.status}</span></td>
                          <td className="px-2 py-1.5 text-xs text-gray-400">{c.recurring_years ?? 0}yr</td>
                        </tr>
                      ));
                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Contract Timeline</h3>
              {allContractTags.map(t => (
                <button key={t} onClick={() => setSelectedTags(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; })}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${selectedTags.has(t) ? `${tagColor(t)} border-transparent` : "border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-gray-400"}`}>
                  {t}
                </button>
              ))}
              {selectedTags.size > 0 && (
                <button onClick={() => setSelectedTags(new Set())} className="text-xs text-gray-400 hover:text-gray-600 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5">clear</button>
              )}
            </div>
            <GanttChart
              modelYears={modelYears}
              viewStart={new Date(2026, 3, 1)}
              activeTrack={sortedFilteredContracts
                .filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type) && c.start_date && c.duration_months)
                .map(c => {
                  const s = new Date(c.start_date);
                  return { startDate: s, endDate: new Date(s.getFullYear(), s.getMonth() + c.duration_months, 1), label: c.name };
                })}
              serviceTrack={sortedFilteredContracts.flatMap(c => {
                const tracks: TrackEntry[] = [];
                if (RECURRING_CONTRACT_TYPES.includes(c.type) && c.start_date) {
                  tracks.push({ startDate: new Date(c.start_date), endDate: c.end_date ? new Date(c.end_date) : new Date(modelYears[modelYears.length - 1], 11, 31), label: c.name });
                }
                if (!RECURRING_CONTRACT_TYPES.includes(c.type) && c.recurring_after_fixed && c.start_date && c.duration_months) {
                  const fixedEnd = new Date(new Date(c.start_date).getFullYear(), new Date(c.start_date).getMonth() + c.duration_months, 1);
                  if ((c.recurring_consumable_amount || 0) > 0 || (c.recurring_licensing_amount || 0) > 0) {
                    const recEnd = new Date(fixedEnd.getFullYear() + (c.recurring_years ?? 0), fixedEnd.getMonth(), 1);
                    tracks.push({ startDate: fixedEnd, endDate: recEnd, label: c.name });
                  }
                }
                return tracks;
              })}
              rows={sortedFilteredContracts.map(c => {
                const isRecurring = RECURRING_CONTRACT_TYPES.includes(c.type);
                const start = c.start_date ? new Date(c.start_date) : null;
                const fixedEnd = !isRecurring && start && c.duration_months
                  ? new Date(start.getFullYear(), start.getMonth() + c.duration_months, 1)
                  : null;
                const end = isRecurring
                  ? (c.end_date ? new Date(c.end_date) : new Date(modelYears[modelYears.length - 1], 11, 31))
                  : fixedEnd;
                const fixedColor = c.status === "active" ? "bg-green-500" : "bg-blue-400";
                const recurringColor = c.type === "consumable_recurring" ? "bg-orange-200" : c.type === "licensing_recurring" ? "bg-purple-200" : fixedColor;

                const hasPostRecurring = !isRecurring && c.recurring_after_fixed && fixedEnd &&
                  ((c.recurring_consumable_amount || 0) > 0 || (c.recurring_licensing_amount || 0) > 0);

                if (hasPostRecurring && fixedEnd && start) {
                  const recEnd = new Date(fixedEnd.getFullYear() + (c.recurring_years ?? 0), fixedEnd.getMonth(), 1);
                  const hasCons = (c.recurring_consumable_amount || 0) > 0;
                  const hasLic = (c.recurring_licensing_amount || 0) > 0;
                  const recurSegColor = hasCons && hasLic ? "bg-amber-400" : hasCons ? "bg-orange-400" : "bg-purple-400";
                  const children: GanttRow[] = [
                    {
                      id: `${c.id}-fixed`, label: "Fixed contract",
                      sublabel: `${c.duration_months}mo · ${fmt$(c.total_value || 0)}`,
                      startDate: start, endDate: fixedEnd, color: fixedColor, countable: false,
                    },
                    ...(hasCons ? [{
                      id: `${c.id}-cons`, label: "Consumables",
                      sublabel: `${fmt$(c.recurring_consumable_amount || 0)}/mo`,
                      startDate: fixedEnd, endDate: recEnd, color: "bg-orange-400", countable: false,
                    }] : []),
                    ...(hasLic ? [{
                      id: `${c.id}-lic`, label: "Licensing",
                      sublabel: `${fmt$(c.recurring_licensing_amount || 0)}/mo`,
                      startDate: fixedEnd, endDate: recEnd, color: "bg-purple-400", countable: false,
                    }] : []),
                  ];
                  return {
                    id: c.id,
                    label: c.name || "Unnamed",
                    sublabel: `${CONTRACT_TYPE_LABELS[c.type]} · ${c.duration_months}mo + ${c.recurring_years ?? 0}yr recurring`,
                    tags: c.tags || [],
                    startDate: start,
                    endDate: recEnd,
                    color: fixedColor,
                    countable: false,
                    expandable: true,
                    children,
                    segments: [
                      { startDate: start, endDate: fixedEnd, color: fixedColor },
                      { startDate: fixedEnd, endDate: recEnd, color: recurSegColor },
                    ],
                  };
                }

                return {
                  id: c.id,
                  label: c.name || "Unnamed",
                  sublabel: `${CONTRACT_TYPE_LABELS[c.type]}`,
                  tags: c.tags || [],
                  startDate: start,
                  endDate: end,
                  color: isRecurring ? recurringColor : fixedColor,
                  countable: false,
                };
              })}
            />
          </div>
        </div>
      )}

      {/* Headcount */}
      {section === "headcount" && (
        <div className="space-y-3">
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Headcount</p>
              <p className="text-lg font-bold font-mono text-gray-900 dark:text-gray-100">{headcount.length}</p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">Total Annual Payroll</p>
              <p className="text-lg font-bold font-mono text-red-600 dark:text-red-400">
                {fmt$(headcount.reduce((s, e) => s + (e.annual_salary || 0), 0))}
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
              <p className="text-xs text-gray-500 dark:text-gray-400">Monthly Loaded Cost</p>
              <p className="text-lg font-bold font-mono text-orange-600 dark:text-orange-400">{fmt$(totalMonthlyPayroll)}/mo</p>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Headcount Schedule</h3>
                <button onClick={() => setSectionView(v => ({ ...v, headcount: v.headcount === "gantt" ? "table" : "gantt" }))}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${sectionView.headcount === "gantt" ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-indigo-500 hover:border-indigo-400"}`}>
                  {sectionView.headcount === "gantt" ? "Table" : "Gantt"}
                </button>
              </div>
              <button onClick={addHeadcount}
                className="text-xs px-3 py-1.5 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                + Add Employee
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="text-left px-3 py-2 font-medium">Role</th>
                    <th className="text-left px-3 py-2 font-medium">Department</th>
                    <th className="text-left px-3 py-2 font-medium">Start</th>
                    <th className="text-left px-3 py-2 font-medium">End</th>
                    <th className="text-right px-3 py-2 font-medium">Base Salary/yr</th>
                    <th className="text-right px-3 py-2 font-medium">Raise %/yr</th>
                    <th className="text-right px-3 py-2 font-medium">Benefits</th>
                    <th className="text-right px-3 py-2 font-medium">Yr 1 Monthly</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {headcount.map(e => {
                    const isEditing = editHeadcount === e.id;
                    const isExpanded = expandedHeadcount.has(e.id);
                    const monthlyLoaded = (e.annual_salary || 0) / 12 * (1 + (e.benefits_pct || 0.25));
                    const raisePct = e.annual_raise_pct ?? 0;
                    const entryStartYear = e.start_date ? parseInt(e.start_date.slice(0, 4)) : modelYears[0];
                    return (
                      <Fragment key={e.id}>
                        <tr className={`${isEditing ? "bg-blue-50/40 dark:bg-blue-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="text" className={inputCls} value={e.role} onChange={ev => updateHeadcount(e.id, "role", ev.target.value)} />
                              : <span className="text-gray-800 dark:text-gray-200 font-medium">{e.role}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={e.department} onChange={ev => updateHeadcount(e.id, "department", ev.target.value)}>
                                  {(Object.keys(DEPT_LABELS) as HeadcountEntry["department"][]).map(d => (
                                    <option key={d} value={d}>{DEPT_LABELS[d]}</option>
                                  ))}
                                </select>
                              : <span className="text-gray-600 dark:text-gray-400">{DEPT_LABELS[e.department]}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="date" className={inputCls} value={e.start_date} onChange={ev => updateHeadcount(e.id, "start_date", ev.target.value)} />
                              : <span className="text-gray-600 dark:text-gray-400 font-mono">{e.start_date}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="date" className={inputCls} value={e.end_date} onChange={ev => updateHeadcount(e.id, "end_date", ev.target.value)} />
                              : <span className="text-gray-500 dark:text-gray-500 font-mono">{e.end_date || "—"}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} step={1000} className={inputCls + " text-right"} value={e.annual_salary} onChange={ev => updateHeadcount(e.id, "annual_salary", parseFloat(ev.target.value) || 0)} />
                              : <span className="font-mono text-gray-800 dark:text-gray-200">{fmt$(e.annual_salary)}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={raisePct} onChange={ev => updateHeadcount(e.id, "annual_raise_pct", parseFloat(ev.target.value) || 0)} />
                              : <span className={`font-mono ${raisePct > 0 ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}>
                                  {raisePct > 0 ? `+${Math.round(raisePct * 100)}%` : "—"}
                                </span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={e.benefits_pct} onChange={ev => updateHeadcount(e.id, "benefits_pct", parseFloat(ev.target.value) || 0)} />
                              : <span className="font-mono text-gray-600 dark:text-gray-400">{Math.round((e.benefits_pct || 0) * 100)}%</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <span className="font-mono font-medium text-orange-600 dark:text-orange-400">{fmt$(monthlyLoaded)}/mo</span>
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <button
                                onClick={() => setExpandedHeadcount(prev => { const n = new Set(prev); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; })}
                                className={`p-1 rounded transition-colors ${isExpanded ? "text-indigo-500" : "text-gray-400 hover:text-indigo-500"}`}
                                title="Year-by-year projection">
                                <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                              <button onClick={() => setEditHeadcount(isEditing ? null : e.id)}
                                className="text-gray-400 hover:text-blue-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  {isEditing
                                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}
                                </svg>
                              </button>
                              <button onClick={() => removeHeadcount(e.id)}
                                className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-indigo-50/40 dark:bg-indigo-950/20">
                            <td colSpan={9} className="px-4 py-3">
                              <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-2">Year-by-Year Salary — type to override, clear to revert to formula</p>
                              <div className="overflow-x-auto">
                                <table className="text-xs">
                                  <thead>
                                    <tr>
                                      {modelYears.map(yr => (
                                        <th key={yr} className="px-2 py-1 text-center font-medium text-gray-500 dark:text-gray-400 min-w-[90px]">{yr}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr>
                                      {modelYears.map(yr => {
                                        const yrs = Math.max(0, yr - entryStartYear);
                                        const computed = Math.round((e.annual_salary || 0) * Math.pow(1 + raisePct, yrs));
                                        const override = (e.salary_overrides || {})[String(yr)];
                                        const hasOverride = override !== undefined;
                                        return (
                                          <td key={yr} className="px-1 py-0.5 text-center">
                                            <div className="relative inline-block">
                                              <input
                                                type="number"
                                                step={1000}
                                                className={`w-24 text-right text-xs px-1.5 py-1 rounded border focus:outline-none focus:ring-1 focus:ring-indigo-400 ${hasOverride ? "border-indigo-400 bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 font-semibold" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400"}`}
                                                value={hasOverride ? override : computed}
                                                onChange={ev => {
                                                  const val = parseFloat(ev.target.value);
                                                  const overrides = { ...(e.salary_overrides || {}) };
                                                  if (isNaN(val)) { delete overrides[String(yr)]; }
                                                  else { overrides[String(yr)] = val; }
                                                  updateHeadcount(e.id, "salary_overrides", overrides);
                                                }}
                                                onBlur={ev => {
                                                  if (ev.target.value === "") {
                                                    const overrides = { ...(e.salary_overrides || {}) };
                                                    delete overrides[String(yr)];
                                                    updateHeadcount(e.id, "salary_overrides", overrides);
                                                  }
                                                }}
                                              />
                                              {hasOverride && (
                                                <button
                                                  onClick={() => { const o = { ...(e.salary_overrides || {}) }; delete o[String(yr)]; updateHeadcount(e.id, "salary_overrides", o); }}
                                                  className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-indigo-400 hover:bg-red-400 text-white rounded-full text-xs leading-none flex items-center justify-center"
                                                  title="Clear override">×</button>
                                              )}
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                    <tr>
                                      {modelYears.map(yr => {
                                        const yrs = Math.max(0, yr - entryStartYear);
                                        const computed = Math.round((e.annual_salary || 0) * Math.pow(1 + raisePct, yrs));
                                        const override = (e.salary_overrides || {})[String(yr)];
                                        return (
                                          <td key={yr} className="px-1 py-0.5 text-center text-gray-400 dark:text-gray-600 text-xs">
                                            {override !== undefined ? <span className="line-through">{fmt$(computed)}</span> : null}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {headcount.length === 0 && (
                    <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-xs">No employees yet — click &quot;Add Employee&quot; to begin.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {sectionView.headcount === "gantt" && (
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Headcount Timeline</h3>
              <GanttChart modelYears={modelYears} rows={headcount.map(e => {
                const start = e.start_date ? new Date(e.start_date) : null;
                const end = e.end_date ? new Date(e.end_date) : new Date(modelYears[modelYears.length - 1], 11, 31);
                const deptColors: Record<string, string> = { tech: "bg-blue-500", exec: "bg-purple-500", ga: "bg-orange-400", sales: "bg-pink-500" };
                return {
                  id: e.id,
                  label: e.role,
                  sublabel: DEPT_LABELS[e.department],
                  startDate: start,
                  endDate: end,
                  color: deptColors[e.department] || "bg-gray-400",
                  countable: e.department === "tech",
                };
              })} ratioRows={contracts.filter(c => !RECURRING_CONTRACT_TYPES.includes(c.type)).map(c => ({
                id: c.id,
                label: c.name || c.type,
                startDate: c.start_date ? new Date(c.start_date) : null,
                endDate: c.end_date ? new Date(c.end_date) : null,
                color: "bg-gray-400",
              }))} />
            </div>
          )}
        </div>
      )}

      {/* Funding */}
      {section === "funding" && (() => {
        const dilutive = funding.filter(f => DILUTIVE_TYPES.includes(f.type));
        const nondilutive = funding.filter(f => NONDILUTIVE_TYPES.includes(f.type));
        const totalDilutive = dilutive.reduce((s, f) => s + (f.amount || 0), 0);
        const totalNonDilutive = nondilutive.reduce((s, f) => s + (f.amount || (f.monthly_amount || 0)), 0);
        const shown = fundSubTab === "dilutive" ? dilutive : nondilutive;
        return (
          <div className="space-y-3">
            {/* KPI strip */}
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Dilutive</p>
                <p className="text-lg font-bold font-mono text-purple-600 dark:text-purple-400">{fmt$(totalDilutive)}</p>
              </div>
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">Dilutive Rounds</p>
                <p className="text-lg font-bold font-mono text-gray-800 dark:text-gray-200">{dilutive.length}</p>
              </div>
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">Total Non-Dilutive</p>
                <p className="text-lg font-bold font-mono text-green-600 dark:text-green-400">{fmt$(totalNonDilutive)}</p>
              </div>
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                <p className="text-xs text-gray-500 dark:text-gray-400">Non-Dilutive Items</p>
                <p className="text-lg font-bold font-mono text-gray-800 dark:text-gray-200">{nondilutive.length}</p>
              </div>
            </div>

            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
              {/* Sub-tab bar + add button */}
              <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 px-4">
                <div className="flex gap-1">
                  {(["dilutive", "nondilutive"] as const).map(t => (
                    <button key={t} onClick={() => setFundSubTab(t)}
                      className={`px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${fundSubTab === t ? "border-blue-500 text-blue-600 dark:text-blue-400" : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                      {t === "dilutive" ? `Dilutive (${dilutive.length})` : `Non-Dilutive (${nondilutive.length})`}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 py-2 items-center">
                  <button onClick={() => setSectionView(v => ({ ...v, funding: v.funding === "gantt" ? "table" : "gantt" }))}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${sectionView.funding === "gantt" ? "border-green-400 bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-green-500 hover:border-green-400"}`}>
                    {sectionView.funding === "gantt" ? "Table" : "Gantt"}
                  </button>
                  {fundSubTab === "dilutive"
                    ? (["equity","safe","convertible_note"] as FundingEntry["type"][]).map(t => (
                        <button key={t} onClick={() => addFunding(t)}
                          className="text-xs px-2 py-1 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-purple-400 hover:text-purple-600 transition-colors">
                          + {FUND_TYPE_LABELS[t]}
                        </button>
                      ))
                    : (["grant","sbir","loan"] as FundingEntry["type"][]).map(t => (
                        <button key={t} onClick={() => addFunding(t)}
                          className="text-xs px-2 py-1 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-green-400 hover:text-green-600 transition-colors">
                          + {FUND_TYPE_LABELS[t]}
                        </button>
                      ))
                  }
                </div>
              </div>

              {/* Dilutive table */}
              {fundSubTab === "dilutive" && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Close Date</th>
                        <th className="text-right px-3 py-2 font-medium">Amount</th>
                        <th className="text-right px-3 py-2 font-medium">Pre-Money Val.</th>
                        <th className="text-right px-3 py-2 font-medium">Dilution % (auto)</th>
                        <th className="text-left px-3 py-2 font-medium">Notes</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {shown.map(f => {
                        const isEditing = editFunding === f.id;
                        const computedDilution = f.pre_money_valuation > 0
                          ? f.amount / (f.pre_money_valuation + f.amount)
                          : (f.dilution_pct || 0);
                        return (
                          <tr key={f.id} className={`${isEditing ? "bg-purple-50/40 dark:bg-purple-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                            <td className="px-2 py-1.5">
                              {isEditing ? <input type="text" className={inputCls} value={f.name} onChange={ev => updateFunding(f.id, "name", ev.target.value)} />
                                : <span className="font-medium text-gray-800 dark:text-gray-200">{f.name}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing
                                ? <select className={selCls} value={f.type} onChange={ev => updateFunding(f.id, "type", ev.target.value as FundingEntry["type"])}>
                                    {DILUTIVE_TYPES.map(t => <option key={t} value={t}>{FUND_TYPE_LABELS[t]}</option>)}
                                  </select>
                                : <span className="text-purple-600 dark:text-purple-400 font-medium">{FUND_TYPE_LABELS[f.type]}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing ? <input type="date" className={inputCls} value={f.date} onChange={ev => updateFunding(f.id, "date", ev.target.value)} />
                                : <span className="font-mono text-gray-600 dark:text-gray-400">{f.date}</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {isEditing ? <input type="number" min={0} step={50000} className={inputCls + " text-right"} value={f.amount} onChange={ev => updateFunding(f.id, "amount", parseFloat(ev.target.value) || 0)} />
                                : <span className="font-mono font-medium text-purple-600 dark:text-purple-400">{fmt$(f.amount)}</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {isEditing ? <input type="number" min={0} step={100000} className={inputCls + " text-right"} value={f.pre_money_valuation} onChange={ev => updateFunding(f.id, "pre_money_valuation", parseFloat(ev.target.value) || 0)} />
                                : <span className="font-mono text-gray-600 dark:text-gray-400">{f.pre_money_valuation > 0 ? fmt$(f.pre_money_valuation) : "—"}</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {isEditing && f.pre_money_valuation <= 0
                                ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={f.dilution_pct} onChange={ev => updateFunding(f.id, "dilution_pct", parseFloat(ev.target.value) || 0)} placeholder="manual" />
                                : <span className={`font-mono ${computedDilution > 0 ? "text-orange-600 dark:text-orange-400" : "text-gray-400"}`}>
                                    {computedDilution > 0 ? `${(computedDilution * 100).toFixed(1)}%` : isEditing ? <span className="text-gray-400 text-xs">set pre-money</span> : "—"}
                                  </span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing ? <input type="text" className={inputCls} value={f.notes} onChange={ev => updateFunding(f.id, "notes", ev.target.value)} />
                                : <span className="text-gray-500 dark:text-gray-500">{f.notes || "—"}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex gap-1">
                                <button onClick={() => setEditFunding(isEditing ? null : f.id)} className="text-gray-400 hover:text-blue-500 p-1 rounded">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                    {isEditing ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}
                                  </svg>
                                </button>
                                <button onClick={() => removeFunding(f.id)} className="text-gray-400 hover:text-red-500 p-1 rounded">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {shown.length === 0 && (
                        <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-xs">No dilutive rounds yet — add a SAFE, convertible note, or equity round above.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Non-dilutive table */}
              {fundSubTab === "nondilutive" && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Type</th>
                        <th className="text-left px-3 py-2 font-medium">Disbursement</th>
                        <th className="text-left px-3 py-2 font-medium">Start / Date</th>
                        <th className="text-left px-3 py-2 font-medium">End Date</th>
                        <th className="text-right px-3 py-2 font-medium">Amount / Monthly</th>
                        <th className="text-right px-3 py-2 font-medium">Annual Increase</th>
                        <th className="text-left px-3 py-2 font-medium">Notes</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                      {shown.map(f => {
                        const isEditing = editFunding === f.id;
                        const isMonthly = f.disbursement === "monthly";
                        const inc = f.annual_increase_pct || 0;
                        return (
                          <tr key={f.id} className={`${isEditing ? "bg-green-50/40 dark:bg-green-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                            <td className="px-2 py-1.5">
                              {isEditing ? <input type="text" className={inputCls} value={f.name} onChange={ev => updateFunding(f.id, "name", ev.target.value)} />
                                : <span className="font-medium text-gray-800 dark:text-gray-200">{f.name}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing
                                ? <select className={selCls} value={f.type} onChange={ev => updateFunding(f.id, "type", ev.target.value as FundingEntry["type"])}>
                                    {NONDILUTIVE_TYPES.map(t => <option key={t} value={t}>{FUND_TYPE_LABELS[t]}</option>)}
                                  </select>
                                : <span className="text-green-700 dark:text-green-400 font-medium">{FUND_TYPE_LABELS[f.type]}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing
                                ? <select className={selCls} value={f.disbursement} onChange={ev => updateFunding(f.id, "disbursement", ev.target.value as FundingEntry["disbursement"])}>
                                    <option value="lump_sum">Lump Sum</option>
                                    <option value="monthly">Monthly</option>
                                  </select>
                                : <span className="text-gray-600 dark:text-gray-400">{isMonthly ? "Monthly" : "Lump Sum"}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing
                                ? <input type="date" className={inputCls} value={isMonthly ? f.start_date : f.date} onChange={ev => updateFunding(f.id, isMonthly ? "start_date" : "date", ev.target.value)} />
                                : <span className="font-mono text-gray-600 dark:text-gray-400">{isMonthly ? f.start_date : f.date}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing && isMonthly
                                ? <input type="date" className={inputCls} value={f.end_date} onChange={ev => updateFunding(f.id, "end_date", ev.target.value)} />
                                : <span className="font-mono text-gray-500">{isMonthly ? (f.end_date || "—") : "—"}</span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {isEditing
                                ? <input type="number" min={0} step={1000} className={inputCls + " text-right"} value={isMonthly ? f.monthly_amount : f.amount} onChange={ev => updateFunding(f.id, isMonthly ? "monthly_amount" : "amount", parseFloat(ev.target.value) || 0)} />
                                : <span className="font-mono font-medium text-green-600 dark:text-green-400">
                                    {isMonthly ? `${fmt$(f.monthly_amount)}/mo` : fmt$(f.amount)}
                                  </span>}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              {isEditing && isMonthly
                                ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={inc} onChange={ev => updateFunding(f.id, "annual_increase_pct", parseFloat(ev.target.value) || 0)} />
                                : <span className={`font-mono ${inc > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400"}`}>
                                    {inc > 0 && isMonthly ? `+${Math.round(inc * 100)}%/yr` : "—"}
                                  </span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {isEditing ? <input type="text" className={inputCls} value={f.notes} onChange={ev => updateFunding(f.id, "notes", ev.target.value)} />
                                : <span className="text-gray-500 dark:text-gray-500">{f.notes || "—"}</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex gap-1">
                                <button onClick={() => setEditFunding(isEditing ? null : f.id)} className="text-gray-400 hover:text-blue-500 p-1 rounded">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                    {isEditing ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /> : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}
                                  </svg>
                                </button>
                                <button onClick={() => removeFunding(f.id)} className="text-gray-400 hover:text-red-500 p-1 rounded">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {shown.length === 0 && (
                        <tr><td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-xs">No non-dilutive funding yet — add a grant, SBIR/STTR, or loan above.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {sectionView.funding === "gantt" && (
              <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Funding Timeline</h3>
                <GanttChart modelYears={modelYears} rows={funding.map(f => {
                  const isDilutive = DILUTIVE_TYPES.includes(f.type);
                  const isLump = isDilutive || f.disbursement === "lump_sum";
                  const date = isLump && f.date ? new Date(f.date) : (f.start_date ? new Date(f.start_date) : null);
                  const endDate = isLump ? (date ? new Date(date.getFullYear(), date.getMonth() + 1, 1) : null) : (f.end_date ? new Date(f.end_date) : new Date(modelYears[modelYears.length - 1], 11, 31));
                  const typeColors: Record<string, string> = { equity: "bg-purple-600", safe: "bg-purple-400", convertible_note: "bg-indigo-400", grant: "bg-green-500", sbir: "bg-emerald-500", loan: "bg-amber-500" };
                  return {
                    id: f.id,
                    label: f.name,
                    sublabel: FUND_TYPE_LABELS[f.type],
                    startDate: date,
                    endDate: endDate,
                    color: typeColors[f.type] || "bg-gray-400",
                    pointInTime: isLump,
                  };
                })} />
              </div>
            )}
          </div>
        );
      })()}

      {/* Expenses */}
      {section === "expenses" && (
        <div className="space-y-3">
          {/* Summary strip */}
          {(() => {
            const totalMonthly = expenses.reduce((s, e) => s + (e.monthly_amount || 0), 0);
            const byCategory: Record<string, number> = {};
            expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + (e.monthly_amount || 0); });
            return (
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total Monthly OpEx</p>
                  <p className="text-lg font-bold font-mono text-red-600 dark:text-red-400">{fmt$(totalMonthly)}/mo</p>
                </div>
                {(["office_expense","software","legal_accounting","direct_expenses"] as const).map(cat => (
                  <div key={cat} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{EXP_CATEGORY_LABELS[cat]}</p>
                    <p className="text-base font-bold font-mono text-gray-800 dark:text-gray-200">{fmt$(byCategory[cat] || 0)}/mo</p>
                  </div>
                ))}
              </div>
            );
          })()}

          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Expense Schedule</h3>
                <button onClick={() => setSectionView(v => ({ ...v, expenses: v.expenses === "gantt" ? "table" : "gantt" }))}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${sectionView.expenses === "gantt" ? "border-amber-400 bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400" : "border-gray-300 dark:border-gray-600 text-gray-400 hover:text-amber-500 hover:border-amber-400"}`}>
                  {sectionView.expenses === "gantt" ? "Table" : "Gantt"}
                </button>
              </div>
              <button onClick={addExpense}
                className="text-xs px-3 py-1.5 border border-dashed border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                + Add Line Item
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Category</th>
                    <th className="text-left px-3 py-2 font-medium">Start</th>
                    <th className="text-left px-3 py-2 font-medium">End</th>
                    <th className="text-right px-3 py-2 font-medium">Monthly Amount</th>
                    <th className="text-right px-3 py-2 font-medium">Annual Increase</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {expenses.map(e => {
                    const isEditing = editExpense === e.id;
                    const isExpanded = expandedExpenses.has(e.id);
                    const inc = e.annual_increase_pct ?? 0;
                    const entryStartYear = e.start_date ? parseInt(e.start_date.slice(0, 4)) : modelYears[0];
                    return (
                      <Fragment key={e.id}>
                        <tr className={`${isEditing ? "bg-blue-50/40 dark:bg-blue-950/20" : ""} hover:bg-gray-50 dark:hover:bg-gray-800/40`}>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="text" className={inputCls} value={e.name} onChange={ev => updateExpense(e.id, "name", ev.target.value)} />
                              : <span className="text-gray-800 dark:text-gray-200 font-medium">{e.name}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <select className={selCls} value={e.category} onChange={ev => updateExpense(e.id, "category", ev.target.value as ExpenseEntry["category"])}>
                                  {(Object.keys(EXP_CATEGORY_LABELS) as ExpenseEntry["category"][]).map(c => (
                                    <option key={c} value={c}>{EXP_CATEGORY_LABELS[c]}</option>
                                  ))}
                                </select>
                              : <span className="text-gray-600 dark:text-gray-400">{EXP_CATEGORY_LABELS[e.category]}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="date" className={inputCls} value={e.start_date} onChange={ev => updateExpense(e.id, "start_date", ev.target.value)} />
                              : <span className="text-gray-600 dark:text-gray-400 font-mono">{e.start_date}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {isEditing
                              ? <input type="date" className={inputCls} value={e.end_date} onChange={ev => updateExpense(e.id, "end_date", ev.target.value)} />
                              : <span className="text-gray-500 dark:text-gray-500 font-mono">{e.end_date || "—"}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} step={100} className={inputCls + " text-right"} value={e.monthly_amount} onChange={ev => updateExpense(e.id, "monthly_amount", parseFloat(ev.target.value) || 0)} />
                              : <span className="font-mono font-medium text-red-600 dark:text-red-400">{fmt$(e.monthly_amount)}/mo</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            {isEditing
                              ? <input type="number" min={0} max={1} step={0.01} className={inputCls + " text-right"} value={inc} onChange={ev => updateExpense(e.id, "annual_increase_pct", parseFloat(ev.target.value) || 0)} />
                              : <span className={`font-mono ${inc > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400"}`}>
                                  {inc > 0 ? `+${Math.round(inc * 100)}%/yr` : "—"}
                                </span>}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex gap-1">
                              <button
                                onClick={() => setExpandedExpenses(prev => { const n = new Set(prev); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; })}
                                className={`p-1 rounded transition-colors ${isExpanded ? "text-amber-500" : "text-gray-400 hover:text-amber-500"}`}
                                title="Year-by-year projection">
                                <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                              </button>
                              <button onClick={() => setEditExpense(isEditing ? null : e.id)}
                                className="text-gray-400 hover:text-blue-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  {isEditing
                                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                    : <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />}
                                </svg>
                              </button>
                              <button onClick={() => removeExpense(e.id)}
                                className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-amber-50/40 dark:bg-amber-950/20">
                            <td colSpan={7} className="px-4 py-3">
                              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-2">Year-by-Year Monthly Amount — type to override, clear to revert to formula</p>
                              <div className="overflow-x-auto">
                                <table className="text-xs">
                                  <thead>
                                    <tr>
                                      {modelYears.map(yr => (
                                        <th key={yr} className="px-2 py-1 text-center font-medium text-gray-500 dark:text-gray-400 min-w-[90px]">{yr}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr>
                                      {modelYears.map(yr => {
                                        const yrs = Math.max(0, yr - entryStartYear);
                                        const computed = Math.round((e.monthly_amount || 0) * Math.pow(1 + inc, yrs));
                                        const override = (e.amount_overrides || {})[String(yr)];
                                        const hasOverride = override !== undefined;
                                        return (
                                          <td key={yr} className="px-1 py-0.5 text-center">
                                            <div className="relative inline-block">
                                              <input
                                                type="number"
                                                step={100}
                                                className={`w-24 text-right text-xs px-1.5 py-1 rounded border focus:outline-none focus:ring-1 focus:ring-amber-400 ${hasOverride ? "border-amber-400 bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 font-semibold" : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400"}`}
                                                value={hasOverride ? override : computed}
                                                onChange={ev => {
                                                  const val = parseFloat(ev.target.value);
                                                  const overrides = { ...(e.amount_overrides || {}) };
                                                  if (isNaN(val)) { delete overrides[String(yr)]; }
                                                  else { overrides[String(yr)] = val; }
                                                  updateExpense(e.id, "amount_overrides", overrides);
                                                }}
                                                onBlur={ev => {
                                                  if (ev.target.value === "") {
                                                    const overrides = { ...(e.amount_overrides || {}) };
                                                    delete overrides[String(yr)];
                                                    updateExpense(e.id, "amount_overrides", overrides);
                                                  }
                                                }}
                                              />
                                              {hasOverride && (
                                                <button
                                                  onClick={() => { const o = { ...(e.amount_overrides || {}) }; delete o[String(yr)]; updateExpense(e.id, "amount_overrides", o); }}
                                                  className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-amber-400 hover:bg-red-400 text-white rounded-full text-xs leading-none flex items-center justify-center"
                                                  title="Clear override">×</button>
                                              )}
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                    <tr>
                                      {modelYears.map(yr => {
                                        const yrs = Math.max(0, yr - entryStartYear);
                                        const computed = Math.round((e.monthly_amount || 0) * Math.pow(1 + inc, yrs));
                                        const override = (e.amount_overrides || {})[String(yr)];
                                        return (
                                          <td key={yr} className="px-1 py-0.5 text-center text-gray-400 dark:text-gray-600 text-xs">
                                            {override !== undefined ? <span className="line-through">{fmt$(computed)}/mo</span> : <span className="text-gray-400">{fmt$(computed)}/mo</span>}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {expenses.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400 text-xs">No expense line items yet — click &quot;Add Line Item&quot; to begin.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {sectionView.expenses === "gantt" && (
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Expense Timeline</h3>
              <GanttChart modelYears={modelYears} rows={expenses.map(e => {
                const start = e.start_date ? new Date(e.start_date) : null;
                const end = e.end_date ? new Date(e.end_date) : new Date(modelYears[modelYears.length - 1], 11, 31);
                const catColors: Record<string, string> = { office_expense: "bg-teal-500", legal_accounting: "bg-yellow-500", software: "bg-slate-500", direct_expenses: "bg-red-400" };
                return {
                  id: e.id,
                  label: e.name,
                  sublabel: EXP_CATEGORY_LABELS[e.category],
                  startDate: start,
                  endDate: end,
                  color: catColors[e.category] || "bg-gray-400",
                };
              })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────

function HistoryTab({ model, onModelUpdate }: { model: FpaModel; onModelUpdate: (m: FpaModel) => void }) {
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [showSnapshotForm, setShowSnapshotForm] = useState(false);
  const [auditEntry, setAuditEntry] = useState<{ version_id: string; data: AuditEntry[] } | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState(model.change_summary || "");
  const [metaNotes, setMetaNotes] = useState(model.notes || "");
  const [savingMeta, setSavingMeta] = useState(false);

  async function loadData() {
    const histRes = await fetch("/api/proxy/fpa/model/history");
    if (histRes.ok) setVersions(await histRes.json());
    setLoading(false);
  }

  useEffect(() => { loadData(); }, []);

  async function handleSetDefault(versionId: string) {
    setSettingDefault(versionId);
    try {
      const r = await fetch(`/api/proxy/fpa/model/history/${versionId}/set-default`, { method: "POST" });
      if (r.ok) {
        const updated = await r.json();
        onModelUpdate(updated);
        await loadData();
      }
    } finally {
      setSettingDefault(null);
    }
  }

  async function handleSaveSnapshot() {
    setSavingSnapshot(true);
    try {
      const r = await fetch("/api/proxy/fpa/model/save-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_name: snapshotName || undefined,
          change_summary: snapshotLabel || snapshotName || "Manual snapshot",
        }),
      });
      if (r.ok) {
        setSnapshotName("");
        setSnapshotLabel("");
        setShowSnapshotForm(false);
        await loadData();
      }
    } finally {
      setSavingSnapshot(false);
    }
  }

  async function handleViewAudit(versionId: string) {
    if (auditEntry?.version_id === versionId) {
      setAuditEntry(null);
      return;
    }
    setAuditLoading(true);
    try {
      const r = await fetch(`/api/proxy/fpa/model/audit?version_id=${versionId}`);
      if (r.ok) {
        const d = await r.json();
        setAuditEntry({ version_id: versionId, data: d.audit_data || [] });
      }
    } finally {
      setAuditLoading(false);
    }
  }

  async function handleSaveMeta() {
    setSavingMeta(true);
    try {
      const r = await fetch("/api/proxy/fpa/model", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ change_summary: metaName || undefined, notes: metaNotes || undefined }),
      });
      if (r.ok) {
        const updated = await r.json();
        onModelUpdate(updated);
        setEditingMeta(false);
      }
    } finally {
      setSavingMeta(false);
    }
  }

  function fmtDateShort(iso: string) {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  if (loading) return <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      {/* Model metadata */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Model Settings</h3>
          {!editingMeta
            ? <button onClick={() => { setMetaName(model.change_summary || ""); setMetaNotes(model.notes || ""); setEditingMeta(true); }}
                className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-500 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">Edit</button>
            : <div className="flex gap-2">
                <button onClick={handleSaveMeta} disabled={savingMeta}
                  className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40 transition-colors">{savingMeta ? "Saving…" : "Save"}</button>
                <button onClick={() => setEditingMeta(false)}
                  className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Cancel</button>
              </div>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Model Name</label>
            {editingMeta
              ? <input type="text" value={metaName} onChange={e => setMetaName(e.target.value)}
                  placeholder="e.g. Base Case 2026"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400" />
              : <p className="text-sm text-gray-800 dark:text-gray-200">{model.change_summary || <span className="text-gray-400">—</span>}</p>}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            {editingMeta
              ? <AutoTextarea value={metaNotes} onChange={e => setMetaNotes(e.target.value)}
                  placeholder="Internal notes about this model"
                  rows={2}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 resize-none" />
              : <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{model.notes || <span className="text-gray-400">—</span>}</p>}
          </div>
        </div>
      </div>

      {/* Version History */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Scenario History</h3>
            <p className="text-xs text-gray-400 mt-0.5">Every saved state is listed here. Use &quot;Load Model&quot; to restore any previous version.</p>
          </div>
          <button onClick={() => setShowSnapshotForm(v => !v)}
            className="text-xs px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
            Save Current State
          </button>
        </div>

        {showSnapshotForm && (
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/40 flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">Scenario Name</label>
              <input type="text" value={snapshotName} onChange={e => setSnapshotName(e.target.value)}
                placeholder="e.g. Base Case, Series A, Downside"
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400" />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
              <input type="text" value={snapshotLabel} onChange={e => setSnapshotLabel(e.target.value)}
                placeholder="Brief description"
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400" />
            </div>
            <button onClick={handleSaveSnapshot} disabled={savingSnapshot}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-40 transition-colors">
              {savingSnapshot ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setShowSnapshotForm(false)}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
              Cancel
            </button>
          </div>
        )}

        {versions.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-400 text-sm">No versions yet — use &quot;Save Current State&quot; or run the engine from Drivers.</div>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {versions.map((v, i) => (
              <div key={v.version_id}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="relative flex-shrink-0">
                    <div className={`w-2.5 h-2.5 rounded-full mt-0.5 ${i === 0 ? "bg-blue-400" : "bg-gray-300 dark:bg-gray-600"}`} />
                    {i < versions.length - 1 && (
                      <div className="absolute top-3 left-1 w-0.5 h-6 bg-gray-200 dark:bg-gray-700" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {i === 0 && <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 rounded font-medium">Latest</span>}
                      {v.is_default && <span className="text-xs px-1.5 py-0.5 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded font-medium">Current Model</span>}
                      {v.scenario_name && <span className="text-xs px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-400 rounded font-medium">{v.scenario_name}</span>}
                      <p className="text-sm text-gray-700 dark:text-gray-300 font-medium truncate">
                        {v.change_summary || "No description"}
                      </p>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {v.version_number && <span className="font-mono font-medium text-gray-500 dark:text-gray-400 mr-1">v{v.version_number}</span>}
                      {fmtDateShort(v.created_at)} · {v.created_by || "System"}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => handleViewAudit(v.version_id)} disabled={auditLoading}
                      className="text-xs px-2.5 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-500 dark:text-gray-400 hover:border-teal-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors">
                      {auditEntry?.version_id === v.version_id ? "Hide Audit" : "Audit"}
                    </button>
                    {i !== 0 && (
                      <button onClick={() => handleSetDefault(v.version_id)} disabled={settingDefault === v.version_id}
                        className="text-xs px-2.5 py-1 border border-blue-400 text-blue-600 dark:text-blue-400 rounded hover:bg-blue-50 dark:hover:bg-blue-950 disabled:opacity-40 transition-colors">
                        {settingDefault === v.version_id ? "Loading…" : "Load Model"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Audit drill-down */}
                {auditEntry?.version_id === v.version_id && (
                  <div className="mx-4 mb-3 border border-teal-200 dark:border-teal-800 rounded-lg overflow-hidden bg-teal-50/30 dark:bg-teal-950/20">
                    <div className="px-3 py-2 border-b border-teal-100 dark:border-teal-800">
                      <p className="text-xs font-semibold text-teal-700 dark:text-teal-300 uppercase tracking-wider">Audit Log — Formula Trace</p>
                    </div>
                    <div className="p-3 space-y-2 max-h-96 overflow-y-auto">
                      {/* Group by year */}
                      {[...new Set(auditEntry.data.map(d => d.year))].sort().map(yr => (
                        <div key={yr}>
                          <button onClick={() => setExpandedYear(expandedYear === yr ? null : yr)}
                            className="flex items-center gap-2 text-xs font-semibold text-teal-700 dark:text-teal-300 mb-1">
                            <svg className={`w-3 h-3 transition-transform ${expandedYear === yr ? "" : "-rotate-90"}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                            {yr}
                          </button>
                          {expandedYear === yr && auditEntry.data.filter(d => d.year === yr).map(entry => (
                            <div key={`${entry.year}-${entry.month}`} className="ml-4 mb-2 text-xs">
                              <p className="font-medium text-gray-600 dark:text-gray-400 mb-0.5">{entry.year} {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][entry.month - 1]}</p>
                              {entry.revenue_components.map((c, ci) => (
                                <div key={ci} className="flex justify-between gap-4 py-0.5 pl-2 border-l-2 border-green-300 dark:border-green-700 mb-0.5">
                                  <span className="text-green-700 dark:text-green-400 flex-1 truncate">{c.name} <span className="text-gray-400">({c.type})</span></span>
                                  <span className="font-mono text-green-600 dark:text-green-400 flex-shrink-0">{fmt$(c.monthly_value)}</span>
                                  <span className="text-gray-400 flex-shrink-0">{c.formula}</span>
                                </div>
                              ))}
                              {entry.headcount_components.map((c, ci) => (
                                <div key={ci} className="flex justify-between gap-4 py-0.5 pl-2 border-l-2 border-orange-300 dark:border-orange-700 mb-0.5">
                                  <span className="text-orange-700 dark:text-orange-400 flex-1 truncate">{c.role} <span className="text-gray-400">({c.department})</span></span>
                                  <span className="font-mono text-orange-600 dark:text-orange-400 flex-shrink-0">{fmt$(c.monthly_cost)}/mo</span>
                                  <span className="text-gray-400 flex-shrink-0">{c.formula}</span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      ))}
                      {auditEntry.data.length === 0 && (
                        <p className="text-xs text-gray-400 text-center py-4">No audit data for this version.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Actuals types ─────────────────────────────────────────────────────────

interface Actuals {
  id: number;
  pulled_at: string;
  cash_balance: number;
  monthly_inflow: number;
  monthly_outflow: number;
  net_burn: number;
  capital_adjustment: number;
  outflow_adjustment: number;
  source: string;
}

interface Kpis {
  burn_rate_monthly: number;
  burn_rate_daily: number;
  burn_rate_hourly: number;
  run_rate_monthly: number;
  run_rate_daily: number;
  run_rate_hourly: number;
  net_burn_monthly: number;
  runway_months: number | null;
  zero_date: string | null;
  cash_balance: number;
  effective_cash: number;
  pending_liabilities_total: number;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  type: string;
  subtype: string;
  balance: number;
  excluded: boolean;
}

// ── Actuals Tab ───────────────────────────────────────────────────────────

function fmtRate(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtZeroDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function daysUntil(iso: string): number {
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function RateGroup({
  label,
  monthly,
  daily,
  hourly,
  danger,
}: {
  label: string;
  monthly: number;
  daily: number;
  hourly: number;
  danger?: boolean;
}) {
  const color = danger
    ? "text-red-600 dark:text-red-400"
    : "text-green-600 dark:text-green-400";
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
        {label}
      </p>
      <div className="grid grid-cols-3 gap-3">
        {[
          { period: "/ month", value: monthly },
          { period: "/ day", value: daily },
          { period: "/ hour", value: hourly },
        ].map(({ period, value }) => (
          <div key={period}>
            <p className={`text-xl font-bold font-mono ${color}`}>{fmtRate(value)}</p>
            <p className="text-xs text-gray-400 mt-0.5">{period}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlaidLinkButton({
  onConnected,
}: {
  onConnected: (institutionName: string | null) => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess: async (public_token, metadata) => {
      const institution = metadata.institution?.name ?? null;
      await fetch("/api/proxy/fpa/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token, institution_name: institution }),
      });
      setLinkToken(null);
      onConnected(institution);
    },
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function handleClick() {
    setFetching(true);
    try {
      const r = await fetch("/api/proxy/fpa/plaid/link-token", { method: "POST" });
      const data = await r.json();
      setLinkToken(data.link_token);
    } finally {
      setFetching(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={fetching}
      className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
    >
      {fetching ? "Preparing…" : "Connect Bank Account"}
    </button>
  );
}

function ActualsTab() {
  const [actuals, setActuals] = useState<Actuals | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [connected, setConnected] = useState(false);
  const [institutionName, setInstitutionName] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<PlaidAccount[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [capitalAdj, setCapitalAdj] = useState<string>("");
  const [outflowAdj, setOutflowAdj] = useState<string>("");
  const [savingAdj, setSavingAdj] = useState(false);
  const [savingOutflowAdj, setSavingOutflowAdj] = useState(false);

  async function loadData() {
    const [statusRes, actualsRes] = await Promise.all([
      fetch("/api/proxy/fpa/plaid/status"),
      fetch("/api/proxy/fpa/actuals"),
    ]);
    const status = await statusRes.json();
    const actualsData = await actualsRes.json();
    setConnected(status.connected);
    setInstitutionName(status.institution_name ?? null);
    if (actualsData.actuals) {
      setActuals(actualsData.actuals);
      setKpis(actualsData.kpis);
      setCapitalAdj(String(actualsData.actuals.capital_adjustment ?? 0));
      setOutflowAdj(String(actualsData.actuals.outflow_adjustment ?? 0));
    }
  }

  async function loadAccounts() {
    const r = await fetch("/api/proxy/fpa/plaid/accounts");
    if (r.ok) setAccounts(await r.json());
  }

  useEffect(() => {
    loadData().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (connected) loadAccounts();
  }, [connected]);

  async function handleSync() {
    setSyncing(true);
    try {
      const r = await fetch("/api/proxy/fpa/actuals/sync", { method: "POST" });
      if (r.ok) {
        const data = await r.json();
        setActuals(data.actuals);
        setKpis(data.kpis);
        setCapitalAdj(String(data.actuals?.capital_adjustment ?? 0));
        setOutflowAdj(String(data.actuals?.outflow_adjustment ?? 0));
      }
    } finally {
      setSyncing(false);
    }
  }

  async function toggleAccount(accountId: string, currentlyExcluded: boolean) {
    const updated = accounts.map((a) =>
      a.account_id === accountId ? { ...a, excluded: !currentlyExcluded } : a
    );
    setAccounts(updated);
    const excludedIds = updated.filter((a) => a.excluded).map((a) => a.account_id);
    await fetch("/api/proxy/fpa/plaid/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded_account_ids: excludedIds }),
    });
  }

  async function handleSetCapitalAdj() {
    const amount = parseFloat(capitalAdj);
    if (isNaN(amount)) return;
    setSavingAdj(true);
    try {
      const r = await fetch("/api/proxy/fpa/actuals/capital-adjustment", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (r.ok) {
        const data = await r.json();
        setActuals(data.actuals);
        setKpis(data.kpis);
      }
    } finally {
      setSavingAdj(false);
    }
  }

  async function handleSetOutflowAdj() {
    const amount = parseFloat(outflowAdj);
    if (isNaN(amount)) return;
    setSavingOutflowAdj(true);
    try {
      const r = await fetch("/api/proxy/fpa/actuals/outflow-adjustment", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (r.ok) {
        const data = await r.json();
        setActuals(data.actuals);
        setKpis(data.kpis);
      }
    } finally {
      setSavingOutflowAdj(false);
    }
  }

  async function handleConnected(name: string | null) {
    setConnected(true);
    setInstitutionName(name);
    await loadAccounts();
    await handleSync();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
        Loading actuals…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Status bar */}
      <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {connected
              ? `Connected${institutionName ? ` · ${institutionName}` : ""}`
              : "No bank account connected"}
          </span>
          {actuals && (
            <span className="text-xs text-gray-400">
              · Last synced{" "}
              {new Date(actuals.pulled_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {connected && (
            <>
              <button
                onClick={() => setShowAccounts((v) => !v)}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 transition-colors"
              >
                Accounts
              </button>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 transition-colors disabled:opacity-50"
              >
                {syncing ? "Syncing…" : "Sync Now"}
              </button>
            </>
          )}
          {!connected && <PlaidLinkButton onConnected={handleConnected} />}
        </div>
      </div>

      {/* Account selector */}
      {showAccounts && accounts.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            Included Accounts
          </p>
          <div className="space-y-2">
            {accounts.map((a) => (
              <label key={a.account_id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!a.excluded}
                  onChange={() => toggleAccount(a.account_id, a.excluded)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{a.name}</span>
                <span className="text-xs text-gray-400 capitalize">{a.subtype}</span>
                <span className="text-sm font-mono text-gray-600 dark:text-gray-400">
                  ${a.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Uncheck accounts to exclude them from balance and transaction calculations. Sync to apply.
          </p>
        </div>
      )}

      {/* Adjustments */}
      {actuals && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-4">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Burn Rate Adjustments</p>

          {/* Capital adjustment (inflow) */}
          <div>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">Inflow Adjustment — capital injections</p>
            <p className="text-xs text-gray-400 mb-2">Exclude one-time deposits (investor wires, loan disbursements) from inflow.</p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">$</span>
              <input type="number" min="0" step="100" value={capitalAdj} onChange={(e) => setCapitalAdj(e.target.value)}
                className="w-36 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0" />
              <button onClick={handleSetCapitalAdj} disabled={savingAdj}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50">
                {savingAdj ? "Saving…" : "Apply"}
              </button>
              {actuals.capital_adjustment > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400">${actuals.capital_adjustment.toLocaleString()} excluded</span>
              )}
            </div>
          </div>

          {/* Outflow adjustment (pass-through) */}
          <div>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">Outflow Adjustment — pass-through payments</p>
            <p className="text-xs text-gray-400 mb-2">Exclude payments made on behalf of customers (e.g. equipment purchased with customer funds).</p>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">$</span>
              <input type="number" min="0" step="100" value={outflowAdj} onChange={(e) => setOutflowAdj(e.target.value)}
                className="w-36 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0" />
              <button onClick={handleSetOutflowAdj} disabled={savingOutflowAdj}
                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50">
                {savingOutflowAdj ? "Saving…" : "Apply"}
              </button>
              {(actuals.outflow_adjustment ?? 0) > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400">${(actuals.outflow_adjustment ?? 0).toLocaleString()} excluded</span>
              )}
            </div>
          </div>
        </div>
      )}

      {!actuals && (
        <div className="flex flex-col items-center justify-center h-48 gap-4 text-gray-400 dark:text-gray-500">
          <p className="text-sm">
            {connected
              ? 'Bank connected — click "Sync Now" to pull your first actuals.'
              : "Connect your bank account to see live cash KPIs."}
          </p>
          {!connected && <PlaidLinkButton onConnected={handleConnected} />}
        </div>
      )}

      {actuals && kpis && (
        <>
          {/* Cash position */}
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Current Cash Balance</p>
            <p className="text-4xl font-bold text-gray-900 dark:text-gray-100 font-mono">
              {fmt$(kpis.cash_balance)}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              ${actuals.monthly_outflow.toLocaleString(undefined, { maximumFractionDigits: 0 })} out ·{" "}
              ${actuals.monthly_inflow.toLocaleString(undefined, { maximumFractionDigits: 0 })} in · last 30 days
            </p>
          </div>

          {/* Burn + Run rates */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <RateGroup
              label="Burn Rate (net cash out)"
              monthly={kpis.burn_rate_monthly}
              daily={kpis.burn_rate_daily}
              hourly={kpis.burn_rate_hourly}
              danger
            />
            <RateGroup
              label="Run Rate (cash in)"
              monthly={kpis.run_rate_monthly}
              daily={kpis.run_rate_daily}
              hourly={kpis.run_rate_hourly}
            />
          </div>

          {/* Runway + Zero Date */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Runway</p>
              {kpis.runway_months !== null ? (
                <>
                  <p className="text-4xl font-bold text-gray-900 dark:text-gray-100 font-mono">
                    {kpis.runway_months.toFixed(1)}
                    <span className="text-xl font-normal text-gray-500 ml-1">months</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {Math.round(kpis.runway_months * 30)} days at current net burn
                  </p>
                </>
              ) : (
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  Cash flow positive
                </p>
              )}
            </div>

            <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Zero Date</p>
              {kpis.zero_date ? (
                <>
                  <p className="text-4xl font-bold text-red-600 dark:text-red-400 font-mono">
                    {fmtZeroDate(kpis.zero_date)}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {daysUntil(kpis.zero_date)} days from today
                  </p>
                </>
              ) : (
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  No zero date
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

// ── QBO types ─────────────────────────────────────────────────────────────

interface QboPeriod {
  period_label: string;
  period_start: string; // ISO date e.g. "2026-01-01"
  period_end: string;
  revenue: number;
  expenses: number;
  net_income: number;
  pulled_at?: string;
}

interface QboStatus {
  connected: boolean;
  realm_name?: string;
  last_synced?: string;
}

interface QboCategory {
  category: string;
  amount: number;
}

interface QboTransaction {
  txn_date: string;
  txn_type: string;
  txn_id: string | null;
  account: string;
  category: string;
  name: string;
  memo: string;
  amount: number;
  is_expense: boolean;
}

// ── Plaid Actuals Breakdown ───────────────────────────────────────────────

interface PlaidSummaryItem {
  label: string;
  total: number;
  count: number;
  is_expense: boolean;
}

function PlaidActualsBreakdown({ model }: { model: FpaModel }) {
  const today = isoToday();
  const [items, setItems] = useState<PlaidSummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 30);
  const start = startDate.toISOString().slice(0, 10);
  const excluded = new Set(model.excluded_burn_categories ?? ["Equipment", "Transfers", "Credit Card"]);

  function load() {
    fetch(`/api/proxy/fpa/plaid/transactions/summary?start_date=${start}&end_date=${today}`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setItems(d))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // Refresh when user returns to this tab
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (loading) return null;
  if (!items.length) return null;

  const expenses  = items.filter(i => i.is_expense);
  const income    = items.filter(i => !i.is_expense);
  const included  = expenses.filter(i => !excluded.has(i.label));
  const totalOut  = included.reduce((s, i) => s + i.total, 0);
  const totalIn   = income.reduce((s, i) => s + i.total, 0);
  const maxAmt    = Math.max(...expenses.map(i => i.total), 1);

  const COLORS: Record<string, string> = {
    "Equipment":               "bg-purple-500",
    "Payroll":                 "bg-blue-500",
    "Payroll Tax":             "bg-blue-300",
    "Rent":                    "bg-orange-500",
    "Credit Card":             "bg-red-400",
    "Benefits":                "bg-teal-500",
    "Software & Subscriptions":"bg-indigo-400",
    "Supplies":                "bg-yellow-500",
    "Travel & Meals":          "bg-pink-400",
    "Bank Fees":               "bg-gray-400",
    "Transfers":               "bg-gray-300",
    "Other":                   "bg-gray-400",
  };

  function barColor(label: string) {
    return COLORS[label] ?? "bg-gray-400";
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Spending Breakdown · Last 30 Days</h2>
          <p className="text-xs text-gray-400 mt-0.5">Bank (Plaid) · excluded categories shown greyed out</p>
        </div>
        <div className="flex gap-4 text-xs">
          <span className="text-red-500 font-mono font-medium">Burn: {fmt$(totalOut)}</span>
          {totalIn > 0 && <span className="text-green-600 font-mono font-medium">In: {fmt$(totalIn)}</span>}
        </div>
      </div>

      <div className="space-y-2">
        {expenses.map(item => {
          const isExcluded = excluded.has(item.label);
          const pct = totalOut > 0 && !isExcluded ? Math.round((item.total / totalOut) * 100) : 0;
          return (
          <div key={item.label} className={`flex items-center gap-3 ${isExcluded ? "opacity-40" : ""}`}>
            <span className="text-xs text-gray-600 dark:text-gray-400 w-44 shrink-0 truncate" title={item.label}>
              {item.label}
              <span className="text-gray-400 ml-1">({item.count})</span>
              {isExcluded && <span className="ml-1 text-gray-400 italic">excluded</span>}
            </span>
            <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
              <div
                className={`h-full rounded ${isExcluded ? "bg-gray-300 dark:bg-gray-600" : barColor(item.label)} opacity-80`}
                style={{ width: `${(item.total / maxAmt) * 100}%` }}
              />
            </div>
            <span className={`text-xs font-mono font-medium w-20 text-right shrink-0 ${isExcluded ? "text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>
              {fmt$(item.total)}
            </span>
            <span className="text-xs text-gray-400 w-10 text-right shrink-0">
              {isExcluded ? "—" : `${pct}%`}
            </span>
          </div>
          );
        })}
        {income.map(item => (
          <div key={item.label} className="flex items-center gap-3">
            <span className="text-xs text-gray-600 dark:text-gray-400 w-44 shrink-0 truncate">
              {item.label} <span className="text-gray-400">({item.count})</span>
            </span>
            <div className="flex-1 h-4 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
              <div className="h-full rounded bg-green-400 opacity-80"
                style={{ width: `${(item.total / maxAmt) * 100}%` }} />
            </div>
            <span className="text-xs font-mono font-medium text-green-600 dark:text-green-400 w-20 text-right shrink-0">
              +{fmt$(item.total)}
            </span>
            <span className="text-xs text-gray-400 w-10 text-right shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Burn Rate Settings Panel ──────────────────────────────────────────────

const DEFAULT_MANUAL_ENTRIES: ManualBurnEntry[] = [
  { label: "Labor & Payroll", type: "employees", monthly_amount: 0, employees: [] },
  { label: "Office & Rent", type: "simple", monthly_amount: 0 },
  { label: "Software & Tools", type: "simple", monthly_amount: 0 },
  { label: "Legal & Accounting", type: "simple", monthly_amount: 0 },
  { label: "Other OpEx", type: "simple", monthly_amount: 0 },
];

function entryTotal(e: ManualBurnEntry): number {
  if (e.type === "employees") {
    return (e.employees ?? []).reduce((s, emp) =>
      s + (emp.annual_salary || 0) / 12 * (1 + (emp.benefits_pct ?? 0.25)), 0);
  }
  return e.monthly_amount || 0;
}

async function fetchFreshKpis(): Promise<{ actuals: Actuals; kpis: Kpis } | null> {
  const r = await fetch("/api/proxy/fpa/actuals");
  if (!r.ok) return null;
  return r.json();
}

function BurnRateSettings({ model, onModelUpdate, onKpisUpdate }: {
  model: FpaModel;
  onModelUpdate: (m: FpaModel) => void;
  onKpisUpdate: (actuals: Actuals, kpis: Kpis) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"auto" | "manual">(model.burn_mode ?? "auto");
  const [entries, setEntries] = useState<ManualBurnEntry[]>(
    model.manual_burn_entries?.length ? model.manual_burn_entries : DEFAULT_MANUAL_ENTRIES
  );
  const [capitalAdj, setCapitalAdj] = useState("0");
  const [outflowAdj, setOutflowAdj] = useState("0");
  const [actuals, setActuals] = useState<Actuals | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingAdj, setSavingAdj] = useState<"capital" | "outflow" | null>(null);
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);
  const [liabilities, setLiabilities] = useState<{ label: string; amount: number }[]>(
    model.pending_liabilities ?? []
  );
  const [savingLiabilities, setSavingLiabilities] = useState(false);
  const [excluded, setExcluded] = useState<string[]>(model.excluded_burn_categories ?? ["Equipment", "Transfers", "Credit Card"]);
  const [plaidCategories, setPlaidCategories] = useState<PlaidSummaryItem[]>([]);
  const [savingExcluded, setSavingExcluded] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/proxy/fpa/actuals").then(r => r.ok ? r.json() : null).then(d => {
      if (d?.actuals) {
        setActuals(d.actuals);
        setCapitalAdj(String(d.actuals.capital_adjustment ?? 0));
        setOutflowAdj(String(d.actuals.outflow_adjustment ?? 0));
      }
    });
    const today = isoToday();
    const start = new Date(today); start.setDate(start.getDate() - 30);
    fetch(`/api/proxy/fpa/plaid/transactions/summary?start_date=${start.toISOString().slice(0,10)}&end_date=${today}`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setPlaidCategories(d.filter((i: PlaidSummaryItem) => i.is_expense)));
  }, [open]);

  const manualTotal = entries.reduce((s, e) => s + entryTotal(e), 0);

  async function saveMode(newMode: "auto" | "manual") {
    setMode(newMode);
    const r = await fetch("/api/proxy/fpa/model", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ burn_mode: newMode }),
    });
    if (r.ok) {
      onModelUpdate(await r.json());
      const fresh = await fetchFreshKpis();
      if (fresh?.actuals && fresh?.kpis) onKpisUpdate(fresh.actuals, fresh.kpis);
    }
  }

  async function saveEntries() {
    setSaving(true);
    try {
      const r = await fetch("/api/proxy/fpa/model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manual_burn_entries: entries }),
      });
      if (r.ok) {
        onModelUpdate(await r.json());
        const fresh = await fetchFreshKpis();
        if (fresh?.actuals && fresh?.kpis) onKpisUpdate(fresh.actuals, fresh.kpis);
      }
    } finally { setSaving(false); }
  }

  async function saveAdj(type: "capital" | "outflow") {
    const amount = parseFloat(type === "capital" ? capitalAdj : outflowAdj);
    if (isNaN(amount)) return;
    setSavingAdj(type);
    try {
      const r = await fetch(`/api/proxy/fpa/actuals/${type === "capital" ? "capital" : "outflow"}-adjustment`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (r.ok) { const d = await r.json(); if (d.actuals) setActuals(d.actuals); }
    } finally { setSavingAdj(null); }
  }

  async function saveExcluded(updated: string[]) {
    setSavingExcluded(true);
    try {
      const r = await fetch("/api/proxy/fpa/model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded_burn_categories: updated }),
      });
      if (r.ok) {
        onModelUpdate(await r.json());
        const fresh = await fetchFreshKpis();
        if (fresh?.actuals && fresh?.kpis) onKpisUpdate(fresh.actuals, fresh.kpis);
      }
    } finally { setSavingExcluded(false); }
  }

  async function saveLiabilities(updated: { label: string; amount: number }[]) {
    setSavingLiabilities(true);
    try {
      const r = await fetch("/api/proxy/fpa/model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pending_liabilities: updated }),
      });
      if (r.ok) {
        onModelUpdate(await r.json());
        const fresh = await fetchFreshKpis();
        if (fresh?.actuals && fresh?.kpis) onKpisUpdate(fresh.actuals, fresh.kpis);
      }
    } finally { setSavingLiabilities(false); }
  }

  // Entry-level helpers
  function updateEntryLabel(i: number, label: string) {
    setEntries(prev => prev.map((e, idx) => idx === i ? { ...e, label } : e));
  }
  function updateEntryAmount(i: number, val: number) {
    setEntries(prev => prev.map((e, idx) => idx === i ? { ...e, monthly_amount: val } : e));
  }
  function toggleEntryType(i: number) {
    setEntries(prev => prev.map((e, idx) => {
      if (idx !== i) return e;
      return e.type === "employees"
        ? { ...e, type: "simple" as const }
        : { ...e, type: "employees" as const, employees: e.employees ?? [] };
    }));
    setExpandedEntry(i);
  }
  function removeEntry(i: number) {
    setEntries(prev => prev.filter((_, idx) => idx !== i));
    if (expandedEntry === i) setExpandedEntry(null);
  }
  function addSimpleEntry() {
    setEntries(prev => [...prev, { label: "", type: "simple", monthly_amount: 0 }]);
  }
  function addEmployeeEntry() {
    const idx = entries.length;
    setEntries(prev => [...prev, { label: "Labor", type: "employees", monthly_amount: 0, employees: [] }]);
    setExpandedEntry(idx);
  }

  // Employee helpers
  function addEmployee(entryIdx: number) {
    setEntries(prev => prev.map((e, i) => i !== entryIdx ? e : {
      ...e,
      employees: [...(e.employees ?? []), { name: "", annual_salary: 0, benefits_pct: 0.25 }],
    }));
  }
  function updateEmployee(entryIdx: number, empIdx: number, field: keyof ManualEmployee, val: string | number) {
    setEntries(prev => prev.map((e, i) => i !== entryIdx ? e : {
      ...e,
      employees: (e.employees ?? []).map((emp, j) => j !== empIdx ? emp : { ...emp, [field]: val }),
    }));
  }
  function removeEmployee(entryIdx: number, empIdx: number) {
    setEntries(prev => prev.map((e, i) => i !== entryIdx ? e : {
      ...e, employees: (e.employees ?? []).filter((_, j) => j !== empIdx),
    }));
  }

  const ic = "px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const bc = "px-3 py-1 text-xs rounded transition-colors disabled:opacity-50";

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
      {/* Header */}
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Burn Rate Settings</span>
          <span className={`text-xs px-2 py-0.5 rounded font-medium ${mode === "manual"
            ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
            : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"}`}>
            {mode === "manual" ? `Manual · ${fmt$(manualTotal)}/mo` : "Auto · Plaid"}
          </span>
        </div>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4 space-y-5">

          {/* Mode toggle */}
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Calculation Method</p>
            <div className="flex gap-2">
              {(["auto", "manual"] as const).map(m => (
                <button key={m} onClick={() => saveMode(m)}
                  className={`${bc} border ${mode === m ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
                  {m === "auto" ? "Auto (Plaid)" : "Manual"}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              {mode === "auto"
                ? "Burn rate pulled from Plaid transactions, minus adjustments below."
                : "Burn rate calculated from the expense categories you enter below."}
            </p>
          </div>

          {/* ── Manual entries ── */}
          {mode === "manual" && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Monthly Expenses</p>

              {entries.map((e, i) => {
                const total = entryTotal(e);
                const isExpanded = expandedEntry === i;

                return (
                  <div key={i} className="border border-gray-100 dark:border-gray-800 rounded-lg overflow-hidden">
                    {/* Entry header row */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50">
                      <input value={e.label} onChange={ev => updateEntryLabel(i, ev.target.value)}
                        placeholder="Category" className={`${ic} flex-1 min-w-0`} />

                      {e.type === "simple" ? (
                        <>
                          <span className="text-xs text-gray-400">$</span>
                          <input type="number" min={0} step={100} value={e.monthly_amount}
                            onChange={ev => updateEntryAmount(i, parseFloat(ev.target.value) || 0)}
                            className={`${ic} w-28 text-right`} />
                          <span className="text-xs text-gray-400 w-6">/mo</span>
                        </>
                      ) : (
                        <>
                          <span className="text-xs font-mono text-gray-700 dark:text-gray-300 w-28 text-right">
                            {fmt$(total)}/mo
                          </span>
                          <span className="text-xs text-gray-400 w-6" />
                        </>
                      )}

                      {/* Toggle type */}
                      <button onClick={() => toggleEntryType(i)}
                        title={e.type === "employees" ? "Switch to flat amount" : "Switch to employee list"}
                        className="text-xs text-gray-400 hover:text-blue-500 px-1.5 py-0.5 border border-gray-200 dark:border-gray-700 rounded whitespace-nowrap">
                        {e.type === "employees" ? "employees" : "# flat"}
                      </button>

                      {/* Expand/collapse for employee entries */}
                      {e.type === "employees" && (
                        <button onClick={() => setExpandedEntry(isExpanded ? null : i)}
                          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                          <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      )}

                      <button onClick={() => removeEntry(i)} className="text-gray-300 dark:text-gray-600 hover:text-red-400 text-base leading-none ml-1">×</button>
                    </div>

                    {/* Employee sub-table */}
                    {e.type === "employees" && isExpanded && (
                      <div className="px-3 py-2 space-y-1.5">
                        {(e.employees ?? []).length > 0 && (
                          <div className="grid gap-x-2 gap-y-1" style={{ gridTemplateColumns: "1fr 7rem 5rem 6rem auto" }}>
                            <span className="text-xs text-gray-400 pb-0.5">Name / Role</span>
                            <span className="text-xs text-gray-400 pb-0.5 text-right">Annual Salary</span>
                            <span className="text-xs text-gray-400 pb-0.5 text-right">Benefits</span>
                            <span className="text-xs text-gray-400 pb-0.5 text-right">Monthly Cost</span>
                            <span />

                            {(e.employees ?? []).map((emp, j) => {
                              const monthlyCost = (emp.annual_salary || 0) / 12 * (1 + (emp.benefits_pct ?? 0.25));
                              return (
                                <Fragment key={j}>
                                  <input value={emp.name} onChange={ev => updateEmployee(i, j, "name", ev.target.value)}
                                    placeholder="Name or role" className={ic} />
                                  <input type="number" min={0} step={1000} value={emp.annual_salary}
                                    onChange={ev => updateEmployee(i, j, "annual_salary", parseFloat(ev.target.value) || 0)}
                                    className={`${ic} text-right`} />
                                  <input type="number" min={0} max={1} step={0.01} value={emp.benefits_pct ?? 0.25}
                                    onChange={ev => updateEmployee(i, j, "benefits_pct", parseFloat(ev.target.value) || 0)}
                                    className={`${ic} text-right`} title="Benefits as decimal (e.g. 0.25 = 25%)" />
                                  <span className="text-xs font-mono text-gray-700 dark:text-gray-300 text-right self-center">
                                    {fmt$(monthlyCost)}/mo
                                  </span>
                                  <button onClick={() => removeEmployee(i, j)}
                                    className="text-gray-300 dark:text-gray-600 hover:text-red-400 text-base leading-none self-center">×</button>
                                </Fragment>
                              );
                            })}
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-1">
                          <button onClick={() => addEmployee(i)}
                            className={`${bc} border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400`}>
                            + Add employee
                          </button>
                          {(e.employees ?? []).length > 0 && (
                            <span className="text-xs font-mono font-medium text-gray-700 dark:text-gray-300">
                              Subtotal: {fmt$(total)}/mo
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add entry buttons + save */}
              <div className="flex items-center gap-2 pt-1">
                <button onClick={addSimpleEntry}
                  className={`${bc} border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400`}>
                  + Add expense line
                </button>
                <button onClick={addEmployeeEntry}
                  className={`${bc} border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400`}>
                  + Add employee group
                </button>
                <button onClick={saveEntries} disabled={saving}
                  className={`${bc} bg-blue-600 hover:bg-blue-700 text-white ml-auto`}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <span className="text-xs font-mono font-semibold text-gray-800 dark:text-gray-200">
                  {fmt$(manualTotal)}/mo
                </span>
              </div>
            </div>
          )}

          {/* ── Auto-mode: category toggles + inflow adj ── */}
          {mode === "auto" && (
            <div className="space-y-4">
              {/* Category inclusions */}
              {plaidCategories.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Include in Burn Rate</p>
                  <p className="text-xs text-gray-400 mb-2">Toggle off categories that aren't real operating expenses.</p>
                  <div className="space-y-1">
                    {plaidCategories.map(cat => {
                      const isExcluded = excluded.includes(cat.label);
                      return (
                        <div key={cat.label} className="flex items-center gap-3">
                          <button
                            onClick={() => {
                              const next = isExcluded
                                ? excluded.filter(e => e !== cat.label)
                                : [...excluded, cat.label];
                              setExcluded(next);
                              saveExcluded(next);
                            }}
                            className={`relative w-8 h-4 rounded-full transition-colors ${isExcluded ? "bg-gray-200 dark:bg-gray-700" : "bg-blue-500"}`}
                          >
                            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${isExcluded ? "left-0.5" : "left-4.5"}`} />
                          </button>
                          <span className={`text-xs flex-1 ${isExcluded ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}`}>
                            {cat.label}
                          </span>
                          <span className={`text-xs font-mono ${isExcluded ? "text-gray-400 line-through" : "text-gray-600 dark:text-gray-400"}`}>
                            {fmt$(cat.total)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {savingExcluded && <p className="text-xs text-gray-400 mt-1">Saving…</p>}
                </div>
              )}

              {/* Inflow adjustment */}
              {actuals && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">Inflow Adjustment</p>
                  <p className="text-xs text-gray-400 mb-2">Exclude capital injections (investor wires, loan disbursements) from inflow.</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">$</span>
                    <input type="number" min={0} step={100} value={capitalAdj} onChange={ev => setCapitalAdj(ev.target.value)}
                      className={`${ic} w-32 text-right`} placeholder="0" />
                    <button onClick={() => saveAdj("capital")} disabled={savingAdj === "capital"}
                      className={`${bc} bg-blue-600 hover:bg-blue-700 text-white`}>
                      {savingAdj === "capital" ? "…" : "Apply"}
                    </button>
                    {(actuals.capital_adjustment ?? 0) > 0 && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">{fmt$(actuals.capital_adjustment)} excluded</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Pending liabilities ── */}
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">One-Time Obligations</p>
            <p className="text-xs text-gray-400 mb-2">Amounts you owe that reduce available cash for runway calculation.</p>
            <div className="space-y-1.5 mb-2">
              {liabilities.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={l.label} onChange={ev => setLiabilities(prev => prev.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))}
                    placeholder="Description" className={`${ic} flex-1 min-w-0`} />
                  <span className="text-xs text-gray-400">$</span>
                  <input type="number" min={0} step={100} value={l.amount}
                    onChange={ev => setLiabilities(prev => prev.map((x, j) => j === i ? { ...x, amount: parseFloat(ev.target.value) || 0 } : x))}
                    className={`${ic} w-28 text-right`} />
                  <button onClick={() => { const u = liabilities.filter((_, j) => j !== i); setLiabilities(u); saveLiabilities(u); }}
                    className="text-gray-300 dark:text-gray-600 hover:text-red-400 text-base leading-none">×</button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setLiabilities(prev => [...prev, { label: "", amount: 0 }])}
                className={`${bc} border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-gray-400`}>
                + Add obligation
              </button>
              {liabilities.length > 0 && (
                <button onClick={() => saveLiabilities(liabilities)} disabled={savingLiabilities}
                  className={`${bc} bg-blue-600 hover:bg-blue-700 text-white`}>
                  {savingLiabilities ? "Saving…" : "Save"}
                </button>
              )}
              {liabilities.length > 0 && (
                <span className="text-xs font-mono text-amber-600 dark:text-amber-400 ml-auto">
                  {fmt$(liabilities.reduce((s, l) => s + (l.amount || 0), 0))} owed
                </span>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

// ── Transactions Panel ────────────────────────────────────────────────────

interface PlaidTxn {
  transaction_id: string;
  txn_date: string;
  name: string;
  amount: number;
  is_expense: boolean;
  category: string | null;
  account_name: string;
  pending: boolean;
}

interface ReconcileRow {
  plaid: PlaidTxn | null;
  qbo: QboTransaction | null;
  delta_days: number | null;
}

function TxnTable({ rows, amtKey = "amount" }: {
  rows: Array<{ txn_date: string; name?: string; memo?: string; category?: string | null; account?: string; account_name?: string; amount: number; is_expense: boolean; pending?: boolean }>;
  amtKey?: string;
}) {
  return (
    <div className="overflow-x-auto max-h-80 overflow-y-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
            <th className="pr-3 pb-1.5 font-medium">Date</th>
            <th className="pr-3 pb-1.5 font-medium">Name</th>
            <th className="pr-3 pb-1.5 font-medium">Category</th>
            <th className="pr-3 pb-1.5 font-medium">Account</th>
            <th className="pb-1.5 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i} className={`border-t border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 ${(t as PlaidTxn).pending ? "opacity-50" : ""}`}>
              <td className="pr-3 py-1.5 text-gray-500 whitespace-nowrap">{t.txn_date}{(t as PlaidTxn).pending ? " ·" : ""}</td>
              <td className="pr-3 py-1.5 text-gray-800 dark:text-gray-200 max-w-[200px] truncate" title={t.name || t.memo}>{t.name || t.memo || "—"}</td>
              <td className="pr-3 py-1.5 text-gray-500 max-w-[150px] truncate" title={t.category ?? ""}>{t.category || "—"}</td>
              <td className="pr-3 py-1.5 text-gray-400 max-w-[120px] truncate">{t.account_name || t.account || "—"}</td>
              <td className={`py-1.5 text-right font-mono font-medium whitespace-nowrap ${t.is_expense ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                {t.is_expense ? "-" : "+"}{fmt$(Math.abs(t.amount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransactionsPanel() {
  const today = isoToday();
  const curY = new Date().getFullYear();
  const [startDate, setStartDate] = useState(isoYearStart(curY));
  const [endDate, setEndDate] = useState(today);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"plaid" | "qbo" | "reconcile">("reconcile");
  const [open, setOpen] = useState(false);

  const [plaidTxns, setPlaidTxns] = useState<PlaidTxn[]>([]);
  const [qboTxns, setQboTxns] = useState<QboTransaction[]>([]);
  const [reconcile, setReconcile] = useState<{ matched: ReconcileRow[]; unmatched_qbo: QboTransaction[]; summary: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ start_date: startDate, end_date: endDate });
      if (search) p.set("search", search);
      const [pr, qr, rr] = await Promise.all([
        fetch(`/api/proxy/fpa/plaid/transactions?${p}`),
        fetch(`/api/proxy/fpa/qbo/transactions?${p}`),
        fetch(`/api/proxy/fpa/transactions/reconcile?${new URLSearchParams({ start_date: startDate, end_date: endDate })}`),
      ]);
      if (pr.ok) setPlaidTxns((await pr.json()).transactions ?? []);
      if (qr.ok) setQboTxns((await qr.json()).transactions ?? []);
      if (rr.ok) setReconcile(await rr.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { if (open) load(); }, [open, startDate, endDate, search]);

  const dateCls = "text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200";
  const tabCls = (active: boolean) => `px-3 py-1 text-xs rounded border transition-colors ${active ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`;

  const plaidOut = plaidTxns.filter(t => t.is_expense && !t.pending).reduce((s, t) => s + t.amount, 0);
  const plaidIn  = plaidTxns.filter(t => !t.is_expense && !t.pending).reduce((s, t) => s + Math.abs(t.amount), 0);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Transactions</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-gray-100 dark:border-gray-800 p-4 space-y-3">

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} className={dateCls} />
            <span className="text-xs text-gray-400">to</span>
            <input type="date" value={endDate} min={startDate} max={today} onChange={e => setEndDate(e.target.value)} className={dateCls} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              className={`${dateCls} w-36`} />
            <div className="flex gap-1 ml-auto">
              {(["reconcile", "plaid", "qbo"] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={tabCls(view === v)}>
                  {v === "reconcile" ? "Reconcile" : v === "plaid" ? "Bank (Plaid)" : "Books (QBO)"}
                </button>
              ))}
            </div>
          </div>

          {loading && <p className="text-xs text-gray-400 py-6 text-center">Loading…</p>}

          {/* Plaid view */}
          {!loading && view === "plaid" && (
            <>
              <div className="flex gap-4 text-xs text-gray-500">
                <span>{plaidTxns.length} transactions</span>
                <span className="text-red-500">Out: {fmt$(plaidOut)}</span>
                <span className="text-green-600">In: {fmt$(plaidIn)}</span>
              </div>
              {plaidTxns.length === 0
                ? <p className="text-xs text-gray-400 py-4 text-center">No Plaid transactions — sync your bank account first</p>
                : <TxnTable rows={plaidTxns} />}
            </>
          )}

          {/* QBO view */}
          {!loading && view === "qbo" && (
            <>
              <div className="flex gap-4 text-xs text-gray-500">
                <span>{qboTxns.length} transactions</span>
                <span className="text-red-500">Out: {fmt$(qboTxns.filter(t => t.is_expense).reduce((s, t) => s + t.amount, 0))}</span>
              </div>
              {qboTxns.length === 0
                ? <p className="text-xs text-gray-400 py-4 text-center">No QBO transactions for this period</p>
                : <TxnTable rows={qboTxns} />}
            </>
          )}

          {/* Reconciliation view */}
          {!loading && view === "reconcile" && reconcile && (
            <div className="space-y-3">
              {/* Summary chips */}
              <div className="flex gap-3 flex-wrap text-xs">
                <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded">
                  {reconcile.summary.matched_count} matched
                </span>
                <span className="px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded">
                  {reconcile.summary.plaid_only_count} bank only — not in books
                </span>
                <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
                  {reconcile.summary.qbo_only_count} books only — no bank entry
                </span>
              </div>

              {/* Reconciliation table */}
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-900">
                      <th className="pb-1.5 pr-2 font-medium w-4" />
                      <th className="pb-1.5 pr-3 font-medium">Date</th>
                      <th className="pb-1.5 pr-3 font-medium">Bank (Plaid)</th>
                      <th className="pb-1.5 pr-3 font-medium">Books (QBO)</th>
                      <th className="pb-1.5 pr-3 font-medium">Category</th>
                      <th className="pb-1.5 font-medium text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconcile.matched.map((row, i) => {
                      const hasMatch = !!row.qbo;
                      const t = row.plaid!;
                      return (
                        <tr key={i} className={`border-t border-gray-50 dark:border-gray-800 ${!hasMatch ? "bg-amber-50 dark:bg-amber-950/20" : ""}`}>
                          <td className="pr-2 py-1.5 text-center">
                            {hasMatch
                              ? <span className="text-green-500" title="Matched">✓</span>
                              : <span className="text-amber-500" title="Bank only — not in QBO">!</span>}
                          </td>
                          <td className="pr-3 py-1.5 text-gray-500 whitespace-nowrap">{t.txn_date}</td>
                          <td className="pr-3 py-1.5 text-gray-800 dark:text-gray-200 max-w-[160px] truncate" title={t.name}>{t.name || "—"}</td>
                          <td className="pr-3 py-1.5 text-gray-500 max-w-[160px] truncate" title={row.qbo?.name ?? ""}>
                            {row.qbo ? row.qbo.name || row.qbo.memo || "—" : <span className="text-amber-500 italic">not in QBO</span>}
                          </td>
                          <td className="pr-3 py-1.5 text-gray-400 max-w-[140px] truncate">{row.qbo?.category || t.category || "—"}</td>
                          <td className={`py-1.5 text-right font-mono font-medium whitespace-nowrap ${t.is_expense ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                            {t.is_expense ? "-" : "+"}{fmt$(Math.abs(t.amount))}
                          </td>
                        </tr>
                      );
                    })}
                    {reconcile.unmatched_qbo.map((q, i) => (
                      <tr key={`qbo-${i}`} className="border-t border-gray-50 dark:border-gray-800 bg-blue-50 dark:bg-blue-950/20">
                        <td className="pr-2 py-1.5 text-center"><span className="text-blue-400" title="QBO only — no bank transaction">≈</span></td>
                        <td className="pr-3 py-1.5 text-gray-500 whitespace-nowrap">{q.txn_date}</td>
                        <td className="pr-3 py-1.5 text-blue-400 italic">not in bank</td>
                        <td className="pr-3 py-1.5 text-gray-500 max-w-[160px] truncate">{q.name || q.memo || "—"}</td>
                        <td className="pr-3 py-1.5 text-gray-400 max-w-[140px] truncate">{q.category || "—"}</td>
                        <td className={`py-1.5 text-right font-mono font-medium whitespace-nowrap ${q.is_expense ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                          {q.is_expense ? "-" : "+"}{fmt$(Math.abs(q.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {!loading && view === "reconcile" && !reconcile && (
            <p className="text-xs text-gray-400 py-4 text-center">Sync your bank account and QBO to see reconciliation</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────

function OverviewTab({ model, onModelUpdate }: { model: FpaModel; onModelUpdate: (m: FpaModel) => void }) {
  const [plaidActuals, setPlaidActuals] = useState<{ actuals: Actuals | null; kpis: Kpis | null }>({ actuals: null, kpis: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/proxy/fpa/actuals")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPlaidActuals(d); })
      .finally(() => setLoading(false));
    const onFocus = () => fetch("/api/proxy/fpa/actuals").then(r => r.ok ? r.json() : null).then(d => { if (d) setPlaidActuals(d); });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const kpis = plaidActuals.kpis;

  if (loading) return <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="space-y-5">
      {/* Live Cash KPIs */}
      {kpis ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Cash Balance</p>
            <p className="text-2xl font-bold font-mono text-gray-900 dark:text-gray-100">{fmt$(kpis.cash_balance)}</p>
            <p className="text-xs text-gray-400 mt-1">
              {kpis.pending_liabilities_total > 0
                ? <>{fmt$(kpis.effective_cash)} available · <span className="text-amber-500">{fmt$(kpis.pending_liabilities_total)} owed</span></>
                : "Live · Axos Bank"}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Runway</p>
            <p className="text-2xl font-bold font-mono text-gray-900 dark:text-gray-100">
              {kpis.runway_months !== null ? `${kpis.runway_months.toFixed(1)} mo` : "∞"}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {kpis.runway_months !== null ? `${Math.round(kpis.runway_months * 30)} days` : kpis.net_burn_monthly <= 0 ? "Based on gross spend" : "Cash flow positive"}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Burn Rate</p>
            <p className="text-2xl font-bold font-mono text-red-600 dark:text-red-400">{fmt$(kpis.burn_rate_monthly)}<span className="text-sm font-normal text-gray-400">/mo</span></p>
            <p className="text-xs text-gray-400 mt-1">
              {kpis.net_burn_monthly > 0
                ? `Net ${fmtRate(kpis.net_burn_monthly)}/mo after inflow`
                : `Inflow exceeds spend · set capital adj`}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Zero Date</p>
            {kpis.zero_date ? (
              <>
                <p className="text-2xl font-bold font-mono text-red-600 dark:text-red-400">{fmtZeroDate(kpis.zero_date)}</p>
                <p className="text-xs text-gray-400 mt-1">{daysUntil(kpis.zero_date)} days away</p>
              </>
            ) : (
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">No zero date</p>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-700 rounded-lg px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          No bank actuals — connect your bank account in the Accounts tab.
        </div>
      )}

      {/* Plaid spending breakdown */}
      {kpis && <PlaidActualsBreakdown model={model} />}

      {/* Burn Rate Settings + Transactions side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BurnRateSettings model={model} onModelUpdate={onModelUpdate}
          onKpisUpdate={(a, k) => setPlaidActuals({ actuals: a, kpis: k })} />
        <TransactionsPanel />
      </div>
    </div>
  );
}


// ── vs Model Tab ──────────────────────────────────────────────────────────

function VsModelTab({ model }: { model: FpaModel }) {
  const [qboStatus, setQboStatus] = useState<QboStatus>({ connected: false });
  const [qboMonthly, setQboMonthly] = useState<QboPeriod[]>([]);
  const [qboWeekly, setQboWeekly] = useState<QboPeriod[]>([]);
  const [qboQuarterly, setQboQuarterly] = useState<QboPeriod[]>([]);
  const [qboYearly, setQboYearly] = useState<QboPeriod[]>([]);
  const [periodType, setPeriodType] = useState<"weekly" | "monthly" | "quarterly" | "yearly">("monthly");
  const [pageIndex, setPageIndex] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [connectingQbo, setConnectingQbo] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/proxy/fpa/qbo/status").then(r => r.ok ? r.json() : {}),
      fetch("/api/proxy/fpa/qbo/actuals?period_type=monthly").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/fpa/qbo/actuals?period_type=weekly").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/fpa/qbo/actuals?period_type=quarterly").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/fpa/qbo/actuals?period_type=yearly").then(r => r.ok ? r.json() : []),
    ]).then(([status, monthly, weekly, quarterly, yearly]) => {
      setQboStatus(status);
      setQboMonthly(monthly); setQboWeekly(weekly);
      setQboQuarterly(quarterly); setQboYearly(yearly);
    }).finally(() => setLoading(false));
  }, []);

  async function handleQboSync() {
    setSyncing(true);
    try {
      await fetch("/api/proxy/fpa/qbo/sync", { method: "POST" });
      const [monthly, weekly, quarterly, yearly, status] = await Promise.all([
        fetch("/api/proxy/fpa/qbo/actuals?period_type=monthly").then(r => r.json()),
        fetch("/api/proxy/fpa/qbo/actuals?period_type=weekly").then(r => r.json()),
        fetch("/api/proxy/fpa/qbo/actuals?period_type=quarterly").then(r => r.json()),
        fetch("/api/proxy/fpa/qbo/actuals?period_type=yearly").then(r => r.json()),
        fetch("/api/proxy/fpa/qbo/status").then(r => r.json()),
      ]);
      setQboMonthly(monthly); setQboWeekly(weekly);
      setQboQuarterly(quarterly); setQboYearly(yearly);
      setQboStatus(status);
    } finally { setSyncing(false); }
  }

  async function connectQbo() {
    setConnectingQbo(true);
    try {
      const r = await fetch("/api/proxy/fpa/qbo/auth-url");
      window.location.href = (await r.json()).auth_url;
    } catch { setConnectingQbo(false); }
  }

  const currentYear = new Date().getFullYear();
  const modelYear = model.annual_data.find(d => d.year === currentYear) ?? model.annual_data[0];
  const monthlyMap = new Map<string, MonthlyData>();
  for (const m of model.monthly_data ?? []) monthlyMap.set(`${m.year}-${m.month}`, m);

  function getModelProj(p: QboPeriod): { revenue: number; expenses: number } {
    if (!p.period_start) return { revenue: modelYear?.revenue ?? 0, expenses: modelYear?.total_opex ?? 0 };
    const start = new Date(p.period_start), end = new Date(p.period_end);
    const startY = start.getUTCFullYear(), startM = start.getUTCMonth() + 1;
    const endY = end.getUTCFullYear(), endM = end.getUTCMonth() + 1;
    if (periodType === "monthly") {
      const row = monthlyMap.get(`${startY}-${startM}`);
      return { revenue: row?.total_revenue ?? 0, expenses: row?.total_opex ?? 0 };
    }
    if (periodType === "yearly") {
      const yr = model.annual_data.find(d => d.year === startY);
      return { revenue: yr?.revenue ?? 0, expenses: yr?.total_opex ?? 0 };
    }
    let rev = 0, exp = 0, y = startY, m = startM;
    while (y < endY || (y === endY && m <= endM)) {
      const row = monthlyMap.get(`${y}-${m}`);
      if (row) {
        if (periodType === "weekly") {
          const monthStart = new Date(Date.UTC(y, m - 1, 1));
          const monthEnd = new Date(Date.UTC(y, m, 0));
          const overlapStart = start > monthStart ? start : monthStart;
          const overlapEnd = end < monthEnd ? end : monthEnd;
          const frac = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 86400000 + 1) / monthEnd.getUTCDate();
          rev += row.total_revenue * frac; exp += row.total_opex * frac;
        } else { rev += row.total_revenue; exp += row.total_opex; }
      }
      m++; if (m > 12) { m = 1; y++; }
    }
    return { revenue: Math.round(rev), expenses: Math.round(exp) };
  }

  const allPeriods = periodType === "weekly" ? qboWeekly : periodType === "quarterly" ? qboQuarterly
    : periodType === "yearly" ? qboYearly : qboMonthly;
  const PAGE_SIZE = periodType === "yearly" || periodType === "quarterly" ? 4 : periodType === "weekly" ? 4 : 6;
  const totalPages = Math.max(1, Math.ceil(allPeriods.length / PAGE_SIZE));
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pageStart = allPeriods.length - (clampedPage + 1) * PAGE_SIZE;
  const periods = allPeriods.slice(Math.max(0, pageStart), allPeriods.length - clampedPage * PAGE_SIZE);
  const chartData = periods.map(p => {
    const proj = getModelProj(p);
    return {
      period: p.period_label,
      "Revenue (Projected)": Math.round(proj.revenue),
      "Revenue (Actual)": Math.round(Math.max(0, p.revenue)),
      "Expenses (Projected)": Math.round(proj.expenses),
      "Expenses (Actual)": Math.round(Math.max(0, p.expenses)),
    };
  });

  if (loading) return <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>;

  if (!qboStatus.connected) return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm">
        Connect QuickBooks Online to compare actual revenue and expenses against your financial model.
      </p>
      <button onClick={connectQbo} disabled={connectingQbo}
        className="px-5 py-2.5 bg-[#2CA01C] hover:bg-[#248016] text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
        {connectingQbo ? "Redirecting…" : "Connect QuickBooks"}
      </button>
      <p className="text-xs text-gray-400">You'll be redirected to Intuit to authorize access.</p>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Projected vs Actual chart */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Projected vs Actual</h2>
            {qboStatus.last_synced && (
              <p className="text-xs text-gray-400 mt-0.5">Last synced {new Date(qboStatus.last_synced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
              {(["weekly", "monthly", "quarterly", "yearly"] as const).map(pt => (
                <button key={pt} onClick={() => { setPeriodType(pt); setPageIndex(0); }}
                  className={`px-3 py-1.5 capitalize transition-colors ${periodType === pt ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
                  {pt}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
              <button onClick={() => setPageIndex(p => Math.min(p + 1, totalPages - 1))} disabled={clampedPage >= totalPages - 1}
                className="px-2.5 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors">‹</button>
              <span className="px-1 text-gray-400 select-none tabular-nums">{clampedPage > 0 ? `−${clampedPage}` : "Now"}</span>
              <button onClick={() => setPageIndex(p => Math.max(p - 1, 0))} disabled={clampedPage === 0}
                className="px-2.5 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 transition-colors">›</button>
            </div>
            <button onClick={handleQboSync} disabled={syncing}
              className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 disabled:opacity-50 transition-colors">
              {syncing ? "Syncing…" : "Sync QBO"}
            </button>
          </div>
        </div>

        {chartData.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
            No data yet — click "Sync QBO" to pull your P&L.
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Revenue</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}K`} tick={{ fontSize: 10 }} width={55} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Revenue (Projected)" fill="#93c5fd" radius={[2,2,0,0]} />
                  <Bar dataKey="Revenue (Actual)" fill="#2563eb" radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Expenses</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={v => `$${(v/1000).toFixed(0)}K`} tick={{ fontSize: 10 }} width={55} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Expenses (Projected)" fill="#fca5a5" radius={[2,2,0,0]} />
                  <Bar dataKey="Expenses (Actual)" fill="#dc2626" radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-100 dark:border-gray-800">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                    <th className="text-left px-3 py-2 font-medium">Period</th>
                    <th className="text-right px-3 py-2 font-medium">Rev Projected</th>
                    <th className="text-right px-3 py-2 font-medium">Rev Actual</th>
                    <th className="text-right px-3 py-2 font-medium">Rev Δ</th>
                    <th className="text-right px-3 py-2 font-medium">Exp Projected</th>
                    <th className="text-right px-3 py-2 font-medium">Exp Actual</th>
                    <th className="text-right px-3 py-2 font-medium">Exp Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.map(cd => {
                    const revDelta = cd["Revenue (Actual)"] - cd["Revenue (Projected)"];
                    const expDelta = cd["Expenses (Actual)"] - cd["Expenses (Projected)"];
                    return (
                      <tr key={cd.period} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-1.5 font-medium text-gray-700 dark:text-gray-300">{cd.period}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-500">{fmt$(cd["Revenue (Projected)"])}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-800 dark:text-gray-200">{fmt$(cd["Revenue (Actual)"])}</td>
                        <td className={`px-3 py-1.5 text-right font-mono font-semibold ${revDelta >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                          {revDelta >= 0 ? "+" : ""}{fmt$(revDelta)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-500">{fmt$(cd["Expenses (Projected)"])}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-800 dark:text-gray-200">{fmt$(cd["Expenses (Actual)"])}</td>
                        <td className={`px-3 py-1.5 text-right font-mono font-semibold ${expDelta <= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                          {expDelta >= 0 ? "+" : ""}{fmt$(expDelta)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <SpendingBreakdown model={model} />
    </div>
  );
}

// ── Spending Breakdown ────────────────────────────────────────────────────

const PIE_COLORS = [
  "#2563eb","#7c3aed","#db2777","#ea580c","#16a34a",
  "#0891b2","#ca8a04","#9333ea","#dc2626","#059669",
  "#6366f1","#f97316",
];

type PeriodMode = "day" | "month" | "year";

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoYearStart(y: number) { return `${y}-01-01`; }
function isoYearEnd(y: number) { return `${y}-12-31`; }
function isoMonthStart(y: number, m: number) { return `${y}-${String(m).padStart(2, "0")}-01`; }
function isoMonthEnd(y: number, m: number) {
  return new Date(y, m, 0).toISOString().slice(0, 10); // last day of month
}
function fmtDateRange(start: string, end: string) {
  const s = new Date(start + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const e = new Date(end + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return start === end ? s : `${s} – ${e}`;
}

function PieTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number }> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-3 py-2 shadow text-xs">
      <p className="font-medium text-gray-800 dark:text-gray-100">{payload[0].name}</p>
      <p className="text-gray-600 dark:text-gray-400">{"$" + Math.round(Math.abs(payload[0].value)).toLocaleString()}</p>
    </div>
  );
}

function PieSection({ title, data, subtitle, loading, onCategoryClick }: {
  title: string; data: QboCategory[]; subtitle?: string; loading?: boolean;
  onCategoryClick?: (cat: string) => void;
}) {
  const total = data.reduce((s, c) => s + c.amount, 0);
  return (
    <div className="flex-1 min-w-0">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">{title}</p>
      {subtitle && <p className="text-xs text-gray-400 mb-2">{subtitle}</p>}
      {loading ? (
        <div className="flex items-center justify-center h-[220px] text-gray-400 text-xs">Loading…</div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-[220px] text-gray-400 text-xs">No data</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={data} dataKey="amount" nameKey="category"
                cx="50%" cy="50%" outerRadius={80} innerRadius={44} paddingAngle={2}
                onClick={onCategoryClick ? (d) => onCategoryClick(d.category) : undefined}
                style={{ cursor: onCategoryClick ? "pointer" : "default" }}
              >
                {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip content={<PieTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="mt-2 space-y-1">
            {data.map((c, i) => (
              <div
                key={c.category}
                className={`flex items-center justify-between text-xs rounded px-1 py-0.5 ${onCategoryClick ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800" : ""}`}
                onClick={onCategoryClick ? () => onCategoryClick(c.category) : undefined}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="truncate text-gray-600 dark:text-gray-400">{c.category}</span>
                </div>
                <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                  <span className="font-mono text-gray-800 dark:text-gray-200">{"$" + Math.round(c.amount).toLocaleString()}</span>
                  <span className="text-gray-400 w-8 text-right">{total > 0 ? Math.round(c.amount / total * 100) : 0}%</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2 font-mono">Total: {"$" + Math.round(total).toLocaleString()}</p>
        </>
      )}
    </div>
  );
}

function PeriodControls({
  mode, onMode, startDate, endDate, onDates, label,
}: {
  mode: PeriodMode;
  onMode: (m: PeriodMode) => void;
  startDate: string;
  endDate: string;
  onDates: (s: string, e: string) => void;
  label: string;
}) {
  const today = isoToday();
  const curY = new Date().getFullYear();
  const [yearSel, setYearSel] = useState(curY);
  const [monthSel, setMonthSel] = useState(new Date().getMonth() + 1);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const years = Array.from({ length: 10 }, (_, i) => curY - 4 + i);

  function applyYear(y: number) {
    setYearSel(y);
    onDates(isoYearStart(y), isoYearEnd(y) < today ? isoYearEnd(y) : today);
  }
  function applyMonth(y: number, m: number) {
    setYearSel(y); setMonthSel(m);
    const end = isoMonthEnd(y, m);
    onDates(isoMonthStart(y, m), end < today ? end : today);
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</p>
      {/* Mode buttons */}
      <div className="flex gap-1">
        {(["day","month","year"] as PeriodMode[]).map(m => (
          <button key={m} onClick={() => {
            onMode(m);
            if (m === "day") onDates(today, today);
            else if (m === "month") applyMonth(yearSel, monthSel);
            else applyYear(yearSel);
          }}
            className={`px-2 py-0.5 text-xs rounded capitalize transition-colors ${mode === m ? "bg-blue-600 text-white" : "border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
            {m}
          </button>
        ))}
      </div>
      {/* Controls per mode */}
      {mode === "day" && (
        <input type="date" max={today}
          value={startDate}
          onChange={e => onDates(e.target.value, e.target.value)}
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 w-full" />
      )}
      {mode === "month" && (
        <div className="flex gap-1 flex-wrap">
          <select value={yearSel} onChange={e => applyMonth(+e.target.value, monthSel)}
            className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <select value={monthSel} onChange={e => applyMonth(yearSel, +e.target.value)}
            className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200">
            {MONTHS.map((mn, i) => <option key={i} value={i+1}>{mn}</option>)}
          </select>
        </div>
      )}
      {mode === "year" && (
        <select value={yearSel} onChange={e => applyYear(+e.target.value)}
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 w-full">
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      )}
    </div>
  );
}

function SpendingBreakdown({ model }: { model: FpaModel }) {
  const today = isoToday();
  const curY = new Date().getFullYear();

  // ── Actual (QBO) state ──────────────────────────────────────────────────
  const [actualMode, setActualMode] = useState<PeriodMode>("year");
  const [actualStart, setActualStart] = useState(isoYearStart(curY));
  const [actualEnd, setActualEnd] = useState(today);
  const [actualCats, setActualCats] = useState<QboCategory[]>([]);
  const [actualLoading, setActualLoading] = useState(false);

  // ── Model (projected) state ─────────────────────────────────────────────
  const [modelMode, setModelMode] = useState<PeriodMode>("year");
  const [modelYear, setModelYear] = useState(curY);
  const [modelMonth, setModelMonth] = useState(new Date().getMonth() + 1);
  const [modelStart, setModelStart] = useState(isoYearStart(curY));
  const [modelEnd, setModelEnd] = useState(isoYearEnd(curY));

  // Transaction list state
  const [txnLoading, setTxnLoading] = useState(false);
  const [transactions, setTransactions] = useState<QboTransaction[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showTxns, setShowTxns] = useState(false);

  // Fetch actual categories (from transaction summary) when date range changes
  useEffect(() => {
    if (!actualStart || !actualEnd) return;
    setActualLoading(true);
    fetch(`/api/proxy/fpa/qbo/transactions/summary?start_date=${actualStart}&end_date=${actualEnd}&group_by=category`)
      .then(r => r.ok ? r.json() : { summary: [] })
      .then(d => {
        const cats: QboCategory[] = (d.summary ?? [])
          .filter((s: { label: string; total: number }) => s.total > 0)
          .map((s: { label: string; total: number }) => ({ category: s.label, amount: Math.round(s.total * 100) / 100 }));
        setActualCats(cats);
      })
      .catch(() => setActualCats([]))
      .finally(() => setActualLoading(false));
  }, [actualStart, actualEnd]);

  // Fetch transactions for selected category or full range
  function loadTransactions(cat?: string) {
    setTxnLoading(true);
    setShowTxns(true);
    const catParam = cat ? `&category=${encodeURIComponent(cat)}` : "";
    fetch(`/api/proxy/fpa/qbo/transactions?start_date=${actualStart}&end_date=${actualEnd}${catParam}`)
      .then(r => r.ok ? r.json() : { transactions: [] })
      .then(d => setTransactions(d.transactions ?? []))
      .catch(() => setTransactions([]))
      .finally(() => setTxnLoading(false));
  }

  // Compute model categories from monthly_data for the selected period
  const modelCategories = useMemo((): QboCategory[] => {
    const monthly = model.monthly_data ?? [];
    const start = new Date(modelStart + "T00:00:00");
    const end = new Date(modelEnd + "T00:00:00");
    const inRange = monthly.filter(m => {
      const mDate = new Date(m.year, m.month - 1, 1);
      const mEndDate = new Date(m.year, m.month, 0);
      return mDate <= end && mEndDate >= start;
    });
    if (inRange.length === 0) {
      // Fallback to annual model data
      const yr = model.annual_data.find(d => d.year === modelYear) ?? model.annual_data[0];
      if (!yr) return [];
      return [
        { category: "Tech Comp",       amount: Math.round(yr.tech_comp        ?? 0) },
        { category: "Exec Comp",       amount: Math.round(yr.exec_comp        ?? 0) },
        { category: "Sales Comp",      amount: Math.round(yr.sales_comp       ?? 0) },
        { category: "G&A Comp",        amount: Math.round(yr.ga_comp          ?? 0) },
        { category: "Office",          amount: Math.round(yr.office_expense   ?? 0) },
        { category: "Legal & Acctg",   amount: Math.round(yr.legal_accounting ?? 0) },
        { category: "Software",        amount: Math.round(yr.software         ?? 0) },
        { category: "Direct Expenses", amount: Math.round(yr.direct_expenses  ?? 0) },
      ].filter(c => c.amount > 0);
    }
    const fields: [string, keyof MonthlyData][] = [
      ["Tech Comp", "tech_comp"], ["Exec Comp", "exec_comp"], ["Sales Comp", "sales_comp"],
      ["G&A Comp", "ga_comp"], ["Office", "office_expense"], ["Legal & Acctg", "legal_accounting"],
      ["Software", "software"],
    ];
    return fields.map(([label, key]) => ({
      category: label,
      amount: Math.round(inRange.reduce((s, m) => s + (m[key] as number ?? 0), 0)),
    })).filter(c => c.amount > 0);
  }, [model, modelStart, modelEnd, modelYear]);

  function handleActualDates(s: string, e: string) { setActualStart(s); setActualEnd(e); }
  function handleModelDates(s: string, e: string) {
    setModelStart(s); setModelEnd(e);
    setModelYear(new Date(s + "T00:00:00").getFullYear());
    setModelMonth(new Date(s + "T00:00:00").getMonth() + 1);
  }

  const actualLabel = fmtDateRange(actualStart, actualEnd);
  const modelLabel = modelMode === "year" ? `${modelYear} Annual`
    : modelMode === "month" ? new Date(modelStart + "T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : new Date(modelStart + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <div className="flex items-baseline gap-2 mb-4">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Spending by Category</h2>
        <span className="text-xs text-gray-400">model vs. actual</span>
      </div>
      <div className="flex gap-6">
        {/* Model side */}
        <div className="flex-1 min-w-0 space-y-3">
          <PeriodControls
            mode={modelMode} onMode={setModelMode}
            startDate={modelStart} endDate={modelEnd}
            onDates={handleModelDates}
            label="Projected"
          />
          <PieSection
            title={`Model — ${modelLabel}`}
            data={modelCategories}
            subtitle={`Budget · $${Math.round(modelCategories.reduce((s,c) => s+c.amount,0)/1000)}K OpEx`}
          />
        </div>

        <div className="w-px bg-gray-100 dark:bg-gray-800 flex-shrink-0" />

        {/* Actual side */}
        <div className="flex-1 min-w-0 space-y-3">
          <PeriodControls
            mode={actualMode} onMode={setActualMode}
            startDate={actualStart} endDate={actualEnd}
            onDates={handleActualDates}
            label="Actual (QBO)"
          />
          <PieSection
            title={`Actual — ${actualLabel}`}
            data={actualCats}
            loading={actualLoading}
            subtitle={actualCats.length > 0 ? "Click a category to see transactions" : "From QuickBooks"}
            onCategoryClick={(cat) => { setSelectedCategory(cat); loadTransactions(cat); }}
          />
          <button
            onClick={() => { setSelectedCategory(null); loadTransactions(); }}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            View all transactions →
          </button>
        </div>
      </div>

      {/* Transaction list panel */}
      {showTxns && (
        <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">
              Transactions{selectedCategory ? ` — ${selectedCategory}` : ""}&nbsp;
              <span className="font-normal text-gray-400">({actualLabel})</span>
            </p>
            <button onClick={() => setShowTxns(false)} className="text-xs text-gray-400 hover:text-gray-600">close ✕</button>
          </div>
          {txnLoading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : transactions.length === 0 ? (
            <p className="text-xs text-gray-400">No transactions found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="text-left py-1 pr-3 font-medium">Date</th>
                    <th className="text-left py-1 pr-3 font-medium">Payee</th>
                    <th className="text-left py-1 pr-3 font-medium">Category</th>
                    <th className="text-left py-1 pr-3 font-medium">Memo</th>
                    <th className="text-left py-1 pr-3 font-medium">Type</th>
                    <th className="text-right py-1 font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={i} className="border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30">
                      <td className="py-1 pr-3 text-gray-500 whitespace-nowrap">{t.txn_date}</td>
                      <td className="py-1 pr-3 text-gray-700 dark:text-gray-300 max-w-[140px] truncate">{t.name || "—"}</td>
                      <td className="py-1 pr-3 text-gray-600 dark:text-gray-400 max-w-[160px] truncate">{t.category}</td>
                      <td className="py-1 pr-3 text-gray-400 max-w-[140px] truncate">{t.memo || "—"}</td>
                      <td className="py-1 pr-3 text-gray-400">{t.txn_type}</td>
                      <td className={`py-1 text-right font-mono whitespace-nowrap ${t.amount < 0 ? "text-green-600" : "text-gray-800 dark:text-gray-200"}`}>
                        {t.amount < 0 ? "-" : ""}{"$" + Math.abs(t.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="pt-2 text-xs text-gray-400">{transactions.length} transactions</td>
                    <td className="pt-2 text-right font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">
                      {"$" + transactions.reduce((s, t) => s + t.amount, 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Accounts Tab ──────────────────────────────────────────────────────────

function StatusPill({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-medium ${
      connected
        ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
        : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-gray-400"}`} />
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function AccountsTab() {
  const [plaidStatus, setPlaidStatus] = useState<{ connected: boolean; institution_name: string | null; connected_at: string | null }>({ connected: false, institution_name: null, connected_at: null });
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccount[]>([]);
  const [qboStatus, setQboStatus] = useState<QboStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<"plaid" | "qbo" | null>(null);
  const [syncing, setSyncing] = useState<"plaid" | "qbo" | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [connectingQbo, setConnectingQbo] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const [ps, qs, pa] = await Promise.all([
      fetch("/api/proxy/fpa/plaid/status").then(r => r.json()),
      fetch("/api/proxy/fpa/qbo/status").then(r => r.json()),
      fetch("/api/proxy/fpa/plaid/accounts").then(r => r.ok ? r.json() : []),
    ]);
    setPlaidStatus(ps);
    setQboStatus(qs);
    setPlaidAccounts(pa);
  }

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  async function disconnectPlaid() {
    if (!confirm("Disconnect bank account? This will stop daily syncs.")) return;
    setDisconnecting("plaid");
    await fetch("/api/proxy/fpa/plaid/disconnect", { method: "DELETE" });
    setPlaidStatus({ connected: false, institution_name: null, connected_at: null });
    setPlaidAccounts([]);
    setDisconnecting(null);
    setMsg("Bank account disconnected.");
  }

  async function disconnectQbo() {
    if (!confirm("Disconnect QuickBooks? This will stop P&L syncs.")) return;
    setDisconnecting("qbo");
    await fetch("/api/proxy/fpa/qbo/disconnect", { method: "DELETE" });
    setQboStatus({ connected: false });
    setDisconnecting(null);
    setMsg("QuickBooks disconnected.");
  }

  async function syncPlaid() {
    setSyncing("plaid");
    try {
      const r = await fetch("/api/proxy/fpa/actuals/sync", { method: "POST" });
      setMsg(r.ok ? "Bank synced successfully." : "Sync failed — check logs.");
    } finally { setSyncing(null); }
  }

  async function syncQbo() {
    setSyncing("qbo");
    try {
      const r = await fetch("/api/proxy/fpa/qbo/sync", { method: "POST" });
      setMsg(r.ok ? "QuickBooks synced successfully." : "Sync failed — check logs.");
    } finally { setSyncing(null); }
  }

  async function connectQbo() {
    setConnectingQbo(true);
    try {
      const r = await fetch("/api/proxy/fpa/qbo/auth-url");
      const data = await r.json();
      window.location.href = data.auth_url;
    } catch { setConnectingQbo(false); }
  }

  async function toggleAccount(accountId: string, currentlyExcluded: boolean) {
    const updated = plaidAccounts.map(a =>
      a.account_id === accountId ? { ...a, excluded: !currentlyExcluded } : a
    );
    setPlaidAccounts(updated);
    await fetch("/api/proxy/fpa/plaid/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded_account_ids: updated.filter(a => a.excluded).map(a => a.account_id) }),
    });
  }

  const { open: openPlaid, ready: plaidReady } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess: async (public_token, metadata) => {
      const institution = metadata.institution?.name ?? null;
      await fetch("/api/proxy/fpa/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token, institution_name: institution }),
      });
      setLinkToken(null);
      await load();
      setMsg("Bank account connected.");
    },
  });

  useEffect(() => { if (linkToken && plaidReady) openPlaid(); }, [linkToken, plaidReady, openPlaid]);

  async function connectPlaid() {
    const r = await fetch("/api/proxy/fpa/plaid/link-token", { method: "POST" });
    const data = await r.json();
    setLinkToken(data.link_token);
  }

  if (loading) return <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      {msg && (
        <div className="flex items-center justify-between bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-800 rounded-lg px-4 py-2.5">
          <p className="text-sm text-green-700 dark:text-green-400">{msg}</p>
          <button onClick={() => setMsg(null)} className="text-green-500 hover:text-green-700 text-lg leading-none">×</button>
        </div>
      )}

      {/* Bank / Plaid */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Bank Account</h2>
              <StatusPill connected={plaidStatus.connected} />
            </div>
            <p className="text-xs text-gray-400">
              {plaidStatus.connected
                ? `${plaidStatus.institution_name ?? "Connected"} · Cash balance and transactions pulled daily at 07:00 UTC`
                : "Connect your bank to enable live cash KPIs on the Overview tab."}
            </p>
            {plaidStatus.connected_at && (
              <p className="text-xs text-gray-400 mt-0.5">
                Connected {new Date(plaidStatus.connected_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            )}
          </div>
          <div className="flex gap-2 shrink-0 ml-4">
            {plaidStatus.connected ? (
              <>
                <button onClick={syncPlaid} disabled={syncing === "plaid"}
                  className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 disabled:opacity-50 transition-colors">
                  {syncing === "plaid" ? "Syncing…" : "Sync Now"}
                </button>
                <button onClick={disconnectPlaid} disabled={disconnecting === "plaid"}
                  className="px-3 py-1.5 text-xs border border-red-200 dark:border-red-800 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 disabled:opacity-50 transition-colors">
                  {disconnecting === "plaid" ? "Disconnecting…" : "Disconnect"}
                </button>
              </>
            ) : (
              <button onClick={connectPlaid}
                className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors">
                Connect Bank
              </button>
            )}
          </div>
        </div>

        {plaidAccounts.length > 0 && (
          <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Accounts — uncheck to exclude from calculations</p>
            <div className="space-y-2">
              {plaidAccounts.map(a => (
                <label key={a.account_id} className="flex items-center gap-3 cursor-pointer group">
                  <input type="checkbox" checked={!a.excluded}
                    onChange={() => toggleAccount(a.account_id, a.excluded)}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600" />
                  <span className="text-sm text-gray-700 dark:text-gray-300 flex-1 group-hover:text-gray-900 dark:group-hover:text-gray-100">{a.name}</span>
                  <span className="text-xs text-gray-400 capitalize">{a.subtype}</span>
                  <span className="text-sm font-mono text-gray-600 dark:text-gray-400 w-24 text-right">
                    ${a.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* QuickBooks */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">QuickBooks Online</h2>
              <StatusPill connected={qboStatus.connected} />
            </div>
            <p className="text-xs text-gray-400">
              {qboStatus.connected
                ? `${qboStatus.realm_name ?? "Connected"} · P&L pulled daily at 07:15 UTC`
                : "Connect QuickBooks to enable projected vs actual comparisons on the Overview tab."}
            </p>
            {qboStatus.last_synced && (
              <p className="text-xs text-gray-400 mt-0.5">
                Last synced {new Date(qboStatus.last_synced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </p>
            )}
          </div>
          <div className="flex gap-2 shrink-0 ml-4">
            {qboStatus.connected ? (
              <>
                <button onClick={syncQbo} disabled={syncing === "qbo"}
                  className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 disabled:opacity-50 transition-colors">
                  {syncing === "qbo" ? "Syncing…" : "Sync Now"}
                </button>
                <button onClick={disconnectQbo} disabled={disconnecting === "qbo"}
                  className="px-3 py-1.5 text-xs border border-red-200 dark:border-red-800 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 dark:text-red-400 disabled:opacity-50 transition-colors">
                  {disconnecting === "qbo" ? "Disconnecting…" : "Disconnect"}
                </button>
              </>
            ) : (
              <button onClick={connectQbo} disabled={connectingQbo}
                className="px-4 py-1.5 text-xs bg-[#2CA01C] hover:bg-[#248016] text-white rounded transition-colors disabled:opacity-50">
                {connectingQbo ? "Redirecting…" : "Connect QuickBooks"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type Tab = "overview" | "vsmodel" | "model" | "drivers" | "history" | "excel" | "accounts";

const ALL_TABS: Tab[] = ["overview", "vsmodel", "model", "drivers", "history", "excel", "accounts"];

function FpaPageInner() {
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(urlTab && (ALL_TABS as string[]).includes(urlTab) ? urlTab : "overview");
  const [modelSubTab, setModelSubTab] = useState<"model" | "drivers" | "history" | "excel">("model");

  useEffect(() => {
    if (urlTab && (ALL_TABS as string[]).includes(urlTab)) setTab(urlTab as Tab);
  }, [urlTab]);

  const [model, setModel] = useState<FpaModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function fetchModel() {
    const res = await fetch("/api/proxy/fpa/model");
    if (!res.ok) {
      if (res.status === 403) setError("Admin access required.");
      else setError("Failed to load model.");
      return;
    }
    const data = await res.json();
    setModel(data);
  }

  useEffect(() => {
    fetchModel().finally(() => setLoading(false));
  }, []);

  async function handleSave(updated: Partial<FpaModel>) {
    const res = await fetch("/api/proxy/fpa/model", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    if (res.ok) {
      const data = await res.json();
      setModel(data);
    }
  }

  async function handleExport() {
    setExporting(true);
    // Use new v2 export endpoint for clean generated workbook
    const res = await fetch("/api/proxy/fpa/model/export-v2");
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "FounderERP_Financial_Model.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    }
    setExporting(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 dark:text-gray-500 text-sm">
        Loading financial model…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500 dark:text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (!model) return null;

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Real Time" },
    { id: "vsmodel", label: "vs Model" },
    { id: "model", label: "Model" },
    { id: "accounts", label: "Accounts" },
  ];

  const MODEL_SUB_TABS: { id: "model" | "drivers" | "history" | "excel"; label: string }[] = [
    { id: "model", label: "Model" },
    { id: "drivers", label: "Drivers" },
    { id: "history", label: "Scenarios" },
    { id: "excel", label: "Excel" },
  ];

  return (
    <div className="max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">Current Model</span>
              <button
                onClick={() => { setTab("model"); setModelSubTab("history"); }}
                className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
              >
                Change
              </button>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100">{model.change_summary || model.version}</span>
              {model.version_number && (
                <span className="text-xs font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded">v{model.version_number}</span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-400 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {exporting ? "Exporting…" : "Export Excel"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800 overflow-x-auto">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
              tab === id
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && <OverviewTab model={model} onModelUpdate={setModel} />}
      {tab === "vsmodel" && <VsModelTab model={model} />}
      {tab === "model" && (
        <div className="space-y-5">
          {/* Model sub-tab bar */}
          <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
            {MODEL_SUB_TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setModelSubTab(id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                  modelSubTab === id
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {modelSubTab === "model" && <ModelTab model={model} />}
          {modelSubTab === "drivers" && <DriversTab model={model} onModelUpdate={setModel} />}
          {modelSubTab === "history" && <HistoryTab model={model} onModelUpdate={setModel} />}
          {modelSubTab === "excel" && <ExcelTab />}
        </div>
      )}
      {tab === "accounts" && <AccountsTab />}
    </div>
  );
}

export default function FpaPage() {
  return (
    <Suspense>
      <FpaPageInner />
    </Suspense>
  );
}
