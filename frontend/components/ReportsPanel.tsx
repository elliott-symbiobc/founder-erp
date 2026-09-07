"use client";

import { useEffect, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell,
} from "recharts";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface TaskOverview {
  period_days: number;
  totals: { total: number; done: number; open: number; overdue: number };
  by_priority: { priority: string; total: number; done: number; overdue: number }[];
  by_kanban: { kanban_status: string; count: number }[];
  by_category: { category: string; total: number; done: number }[];
  weekly_done: { week: string; tasks_done: number }[];
}

interface TeamMember {
  user_id: string; name: string; email: string; role: string;
  total: number; done: number; open: number; overdue: number; completion_pct: number;
}

interface CrmData {
  pipeline: { total_deals: number; total_pipeline: number; weighted_pipeline: number };
  deals_by_stage: { stage: string; count: number; total_revenue: number; avg_probability: number; weighted_revenue: number }[];
  projects_by_stage: { section: string; stage: string; count: number; total_revenue: number }[];
  project_tasks: { name: string; section: string; stage: string; open_tasks: number; overdue_tasks: number }[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444"];

const PRIORITY_COLOR: Record<string, string> = {
  high: "#ef4444", medium: "#f59e0b", low: "#22c55e", none: "#9ca3af",
};

const KANBAN_LABEL: Record<string, string> = {
  todo: "To Do", in_progress: "In Progress", review: "Review", done: "Done",
};

const SECTION_COLOR: Record<string, string> = {
  client: "#3b82f6", partnership: "#8b5cf6", other: "#9ca3af",
};

function fmt$(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: "red" | "green" | "yellow";
}) {
  const valColor =
    accent === "red" ? "text-red-500" :
    accent === "green" ? "text-green-500" :
    accent === "yellow" ? "text-yellow-500" :
    "text-gray-900 dark:text-gray-100";
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-semibold leading-tight ${valColor}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{children}</h2>;
}

function CompletionBar({ pct, color = "#3b82f6" }: { pct: number; color?: string }) {
  return (
    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-2 overflow-hidden">
      <div className="h-full rounded" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
    </div>
  );
}

function TasksTab({ data }: { data: TaskOverview }) {
  const { totals, by_priority, by_kanban, by_category, weekly_done } = data;
  const completionPct = totals.total > 0 ? Math.round(100 * totals.done / totals.total) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Tasks" value={totals.total} />
        <StatCard label="Completed" value={totals.done} sub={`${completionPct}% completion`} accent="green" />
        <StatCard label="Open" value={totals.open} />
        <StatCard label="Overdue" value={totals.overdue} accent={totals.overdue > 0 ? "red" : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {by_priority.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <SectionHeader>By Priority</SectionHeader>
            <div className="mt-4 space-y-3">
              {by_priority.map(p => {
                const pct = p.total > 0 ? Math.round(100 * p.done / p.total) : 0;
                return (
                  <div key={p.priority}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium capitalize" style={{ color: PRIORITY_COLOR[p.priority] }}>
                        {p.priority === "none" ? "No priority" : p.priority}
                      </span>
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        {p.overdue > 0 && <span className="text-red-500">{p.overdue} overdue</span>}
                        <span>{p.done}/{p.total}</span>
                        <span className="w-8 text-right text-gray-600 dark:text-gray-300">{pct}%</span>
                      </div>
                    </div>
                    <CompletionBar pct={pct} color={PRIORITY_COLOR[p.priority]} />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {by_category.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <SectionHeader>By Type</SectionHeader>
            <ResponsiveContainer width="100%" height={200} className="mt-3">
              <BarChart data={by_category} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="category" tick={{ fontSize: 11 }} width={78} />
                <Tooltip />
                <Bar dataKey="done" name="Done" stackId="a" fill="#10b981" />
                <Bar dataKey="total" name="Total" stackId="b" fill="#e5e7eb" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {by_kanban.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <SectionHeader>Open Tasks by Stage</SectionHeader>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {by_kanban.map((k, i) => (
              <div key={k.kanban_status} className="rounded-lg p-3 text-center"
                style={{ backgroundColor: `${COLORS[i]}18`, border: `1px solid ${COLORS[i]}44` }}>
                <p className="text-xs font-medium" style={{ color: COLORS[i] }}>
                  {KANBAN_LABEL[k.kanban_status] ?? k.kanban_status}
                </p>
                <p className="text-2xl font-bold mt-1" style={{ color: COLORS[i] }}>{k.count}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {weekly_done.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <SectionHeader>Weekly Tasks Completed</SectionHeader>
          <ResponsiveContainer width="100%" height={200} className="mt-3">
            <BarChart data={weekly_done} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip labelFormatter={d => `Week of ${d}`} />
              <Bar dataKey="tasks_done" name="Completed" fill="#10b981" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function CrmTab({ data }: { data: CrmData }) {
  const { pipeline, deals_by_stage, projects_by_stage, project_tasks } = data;
  const clientProjects = projects_by_stage.filter(p => p.section === "client");
  const partnerProjects = projects_by_stage.filter(p => p.section === "partnership");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Active Deals" value={pipeline.total_deals} />
        <StatCard label="Total Pipeline" value={fmt$(pipeline.total_pipeline)} sub="sum of expected revenue" />
        <StatCard label="Weighted Pipeline" value={fmt$(pipeline.weighted_pipeline)} sub="probability-adjusted" />
      </div>

      {deals_by_stage.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <SectionHeader>CRM Deals by Stage</SectionHeader>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-left pb-2 font-medium">Stage</th>
                  <th className="text-right pb-2 font-medium">Deals</th>
                  <th className="text-right pb-2 font-medium">Pipeline</th>
                  <th className="text-right pb-2 font-medium">Avg Prob.</th>
                  <th className="text-right pb-2 font-medium">Weighted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {deals_by_stage.map((s, i) => (
                  <tr key={s.stage}>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span className="font-medium text-gray-800 dark:text-gray-200">{s.stage}</span>
                      </span>
                    </td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{s.count}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmt$(s.total_revenue)}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{s.avg_probability.toFixed(0)}%</td>
                    <td className="py-2 text-right font-medium text-gray-800 dark:text-gray-200">{fmt$(s.weighted_revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[
          { label: "Client Projects", rows: clientProjects, color: SECTION_COLOR.client },
          { label: "Partnership Projects", rows: partnerProjects, color: SECTION_COLOR.partnership },
        ].map(({ label, rows, color }) =>
          rows.length > 0 ? (
            <div key={label} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <SectionHeader>{label}</SectionHeader>
              <div className="mt-3 space-y-2">
                {rows.map(r => (
                  <div key={`${r.section}-${r.stage}`} className="flex items-center gap-3">
                    <span className="text-xs text-gray-600 dark:text-gray-400 w-28 truncate">{r.stage}</span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-2 overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${Math.min(r.count * 20, 100)}%`, backgroundColor: color }} />
                    </div>
                    <span className="text-xs text-gray-500 w-6 text-right">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null
        )}
      </div>

      {project_tasks.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <SectionHeader>Open Tasks by Project</SectionHeader>
          <div className="mt-4 space-y-2">
            {project_tasks.map(p => (
              <div key={p.name} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded capitalize"
                      style={{ backgroundColor: `${SECTION_COLOR[p.section] ?? "#9ca3af"}22`, color: SECTION_COLOR[p.section] ?? "#9ca3af" }}>
                      {p.section}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">{p.stage}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{p.open_tasks}</span>
                  {p.overdue_tasks > 0 && <span className="ml-2 text-xs text-red-500">{p.overdue_tasks} overdue</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamTab({ members }: { members: TeamMember[] }) {
  const totalOpen = members.reduce((s, m) => s + (m.open ?? 0), 0);
  const totalOverdue = members.reduce((s, m) => s + (m.overdue ?? 0), 0);
  const avgCompletion = members.length > 0
    ? Math.round(members.reduce((s, m) => s + Number(m.completion_pct), 0) / members.length)
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Team Open Tasks" value={totalOpen} />
        <StatCard label="Team Overdue" value={totalOverdue} accent={totalOverdue > 0 ? "red" : undefined} />
        <StatCard label="Avg Completion Rate" value={`${avgCompletion}%`} accent="green" />
      </div>

      {members.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <SectionHeader>Task Completion Rate per Employee</SectionHeader>
          <ResponsiveContainer width="100%" height={Math.max(180, members.length * 44)} className="mt-3">
            <BarChart data={members} layout="vertical" margin={{ top: 0, right: 60, bottom: 0, left: 120 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={116} />
              <Tooltip formatter={(v: number) => [`${v}%`, "Completion"]} />
              <Bar dataKey="completion_pct" name="Completion %" radius={[0, 3, 3, 0]}>
                {members.map((m) => (
                  <Cell key={m.user_id}
                    fill={Number(m.completion_pct) >= 75 ? "#10b981" : Number(m.completion_pct) >= 50 ? "#f59e0b" : "#ef4444"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <SectionHeader>Employee Task Breakdown</SectionHeader>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left pb-2 font-medium">Employee</th>
                <th className="text-right pb-2 font-medium">Total</th>
                <th className="text-right pb-2 font-medium">Done</th>
                <th className="text-right pb-2 font-medium">Open</th>
                <th className="text-right pb-2 font-medium">Overdue</th>
                <th className="text-right pb-2 font-medium">Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {members.map(m => (
                <tr key={m.user_id}>
                  <td className="py-2">
                    <p className="font-medium text-gray-800 dark:text-gray-200">{m.name}</p>
                    <p className="text-xs text-gray-400 capitalize">{m.role}</p>
                  </td>
                  <td className="py-2 text-right text-gray-600 dark:text-gray-400">{m.total}</td>
                  <td className="py-2 text-right text-green-600">{m.done}</td>
                  <td className="py-2 text-right text-gray-600 dark:text-gray-400">{m.open}</td>
                  <td className={`py-2 text-right ${m.overdue > 0 ? "text-red-500 font-medium" : "text-gray-400"}`}>{m.overdue}</td>
                  <td className="py-2 text-right">
                    <span className={`font-semibold ${
                      Number(m.completion_pct) >= 75 ? "text-green-500" :
                      Number(m.completion_pct) >= 50 ? "text-yellow-500" : "text-red-500"
                    }`}>{m.completion_pct}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── KPI types ──────────────────────────────────────────────────────────────

interface KpiData {
  as_of: string;
  week_start: string;
  sales: {
    source_url: string;
    outreach_by_week: { week: string; unique_contacts: number; calls_meetings: number; direct_emails: number }[];
    outreach_this_week: { unique_contacts: number; calls_meetings: number; direct_emails: number };
    new_leads_this_week: { id: string; title: string; stage: string; priority: string | null }[];
    pipeline_stages: { stage: string; count: number; pipeline_value: number; avg_value: number; deal_ids: string[]; deal_titles: string[] }[];
    total_pipeline: number;
    avg_deal_size: number;
    avg_sales_cycle_days: number | null;
    warm_intros: { total: number; committed: number; warm_total: number; warm_committed: number };
    conversion_by_segment: { segment: string; total: number; won: number; active: number; conversion_pct: number; deal_ids: string[]; deal_titles: string[] }[];
    tea_reports: { filename: string }[];
  };
  operations: {
    source_url: string;
    active_deployments: { id: string; name: string; stage: string }[];
    avg_contract_to_deployment_days: number | null;
    open_equipment_milestones: { id: string; title: string; status: string; project_name: string; project_id: string }[];
  };
  financial: {
    source_url: string;
    current_month_burn: number;
    net_burn: number;
    cash_balance: number;
    burn_mode: string;
    projected_annual_revenue: number;
    runway_months: number | null;
    ytd_revenue: number;
    ytd_opex: number;
  };
  capital: {
    source_url: string;
    committed_capital: number;
    open_round_committed: number;
    total_raised: number;
    investor_status: { status: string; count: number; ids: string[]; names: string[] }[];
    term_sheets_outstanding: number;
    term_sheet_names: string[];
    investor_meetings_this_week: number;
  };
}

// ── KPI helpers ─────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent, sourceUrl, sourceLabel, drill,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "red" | "green" | "yellow" | "blue";
  sourceUrl?: string;
  sourceLabel?: string;
  drill?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const valColor =
    accent === "red" ? "text-red-500" :
    accent === "green" ? "text-green-500" :
    accent === "yellow" ? "text-yellow-500" :
    accent === "blue" ? "text-blue-500" :
    "text-gray-900 dark:text-gray-100";
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className={`text-2xl font-semibold leading-tight ${valColor}`}>{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          {drill && (
            <button onClick={() => setOpen(o => !o)}
              className="text-xs text-blue-500 hover:text-blue-700 underline">
              {open ? "hide" : "details"}
            </button>
          )}
          {sourceUrl && (
            <Link href={sourceUrl}
              className="text-xs text-gray-400 hover:text-blue-500 transition-colors"
              title={`View in ${sourceLabel ?? "source"}`}>
              ↗
            </Link>
          )}
        </div>
      </div>
      {open && drill && (
        <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
          {drill}
        </div>
      )}
    </div>
  );
}

function KpiSection({ title, sourceUrl, sourceLabel, children }: {
  title: string; sourceUrl?: string; sourceLabel?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h3>
        {sourceUrl && (
          <Link href={sourceUrl}
            className="text-xs text-gray-400 hover:text-blue-500 transition-colors flex items-center gap-0.5">
            {sourceLabel ?? "View data"} ↗
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function DrillList({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-xs text-gray-400">No records.</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((item, i) => (
        <li key={i} className="text-xs text-gray-600 dark:text-gray-400">• {item}</li>
      ))}
    </ul>
  );
}

// ── KPI Tab components ───────────────────────────────────────────────────────

function KpiInternalTab({ data }: { data: KpiData }) {
  const { sales, operations, financial, capital } = data;

  const STAGE_ORDER = ["New", "Qualified", "Initial Testing", "Proposition", "Won", "Inactive", "No Response"];
  const orderedStages = [...sales.pipeline_stages].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  );

  return (
    <div className="space-y-8">
      {/* ── Sales & Pipeline ── */}
      <KpiSection title="Sales & Pipeline" sourceUrl={sales.source_url} sourceLabel="CRM">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KpiCard
            label="Unique Contacts Reached (this week)"
            value={sales.outreach_this_week.unique_contacts}
            sub={`${sales.outreach_this_week.calls_meetings} calls/meetings · ${sales.outreach_this_week.direct_emails} direct emails`}
            accent="blue"
            sourceUrl="/contacts"
            sourceLabel="Contacts"
          />
          <KpiCard
            label="Discovery Calls / Meetings (this week)"
            value={sales.outreach_this_week.calls_meetings}
            sourceUrl="/contacts"
            sourceLabel="Contacts"
          />
          <KpiCard
            label="New Leads This Week"
            value={sales.new_leads_this_week.length}
            accent={sales.new_leads_this_week.length > 0 ? "green" : undefined}
            sourceUrl="/crm?tab=pipeline"
            sourceLabel="CRM Pipeline"
            drill={<DrillList items={sales.new_leads_this_week.map(d => `${d.title}${d.stage && d.stage !== "New" ? ` — ${d.stage}` : ""}${d.priority ? ` · ${d.priority}` : ""}`)} />}
          />
          <KpiCard
            label="TEA Reports Generated"
            value={sales.tea_reports.length}
            sourceUrl="/reports"
            sourceLabel="Reports"
            drill={<DrillList items={sales.tea_reports.map(r => r.filename)} />}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          <KpiCard
            label="Total Pipeline Value"
            value={fmt$(sales.total_pipeline)}
            sourceUrl={sales.source_url}
            sourceLabel="CRM"
          />
          <KpiCard
            label="Average Deal Size"
            value={sales.avg_deal_size > 0 ? fmt$(sales.avg_deal_size) : "—"}
            sourceUrl={sales.source_url}
            sourceLabel="CRM"
          />
          <KpiCard
            label="Avg Sales Cycle (days)"
            value={sales.avg_sales_cycle_days != null ? `${sales.avg_sales_cycle_days}d` : "—"}
            sub="Won deals only"
            sourceUrl={sales.source_url}
            sourceLabel="CRM"
          />
        </div>

        {/* Pipeline stage funnel */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <SectionHeader>Pipeline Stage Conversions</SectionHeader>
            <Link href={sales.source_url} className="text-xs text-gray-400 hover:text-blue-500">CRM ↗</Link>
          </div>
          <div className="space-y-2">
            {orderedStages.map((s, i) => {
              const maxCount = Math.max(...orderedStages.map(x => x.count), 1);
              return (
                <div key={s.stage} className="group">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-28 truncate">{s.stage}</span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-3 overflow-hidden">
                      <div className="h-full rounded transition-all"
                        style={{ width: `${Math.min((s.count / maxCount) * 100, 100)}%`, backgroundColor: COLORS[i % COLORS.length] }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 w-6 text-right">{s.count}</span>
                    <span className="text-xs text-gray-400 w-20 text-right">{fmt$(s.pipeline_value)}</span>
                    <Link href={sales.source_url}
                      className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1"
                      title={s.deal_titles?.join(", ")}>↗</Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <KpiCard
            label="Warm Intros (total)"
            value={sales.warm_intros.warm_total}
            sub={`${sales.warm_intros.warm_committed} committed`}
            accent="green"
            sourceUrl="/funding"
            sourceLabel="Funding"
          />
          <KpiCard
            label="Investors (all types)"
            value={sales.warm_intros.total}
            sub={`${sales.warm_intros.committed} committed`}
            sourceUrl="/funding"
            sourceLabel="Funding"
          />
        </div>

        {/* Market segment conversion */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <SectionHeader>Conversion Rate by Market Segment</SectionHeader>
            <Link href={sales.source_url} className="text-xs text-gray-400 hover:text-blue-500">CRM ↗</Link>
          </div>
          <div className="space-y-3">
            {sales.conversion_by_segment.map(seg => (
              <div key={seg.segment}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{seg.segment}</span>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span>{seg.won} won / {seg.total} total</span>
                    <span className="w-8 text-right text-gray-600 dark:text-gray-300 font-medium">{seg.conversion_pct}%</span>
                  </div>
                </div>
                <CompletionBar pct={seg.conversion_pct} color="#3b82f6" />
                {seg.deal_titles?.length > 0 && (
                  <p className="text-xs text-gray-400 mt-1 truncate" title={seg.deal_titles.join(", ")}>
                    {seg.deal_titles.slice(0, 3).join(", ")}{seg.deal_titles.length > 3 ? ` +${seg.deal_titles.length - 3}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">Segments matched by keyword in deal title/description.</p>
        </div>

        {/* Weekly outreach chart */}
        {sales.outreach_by_week.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mt-4">
            <div className="flex items-center justify-between mb-2">
              <SectionHeader>Unique Contacts Reached per Week</SectionHeader>
              <Link href="/contacts" className="text-xs text-gray-400 hover:text-blue-500">Contacts ↗</Link>
            </div>
            <ResponsiveContainer width="100%" height={180} className="mt-2">
              <BarChart data={sales.outreach_by_week} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="week" tick={{ fontSize: 10 }} tickFormatter={d => d.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip labelFormatter={d => `Week of ${d}`} />
                <Bar dataKey="direct_emails" name="Direct Emails" stackId="a" fill="#3b82f6" />
                <Bar dataKey="calls_meetings" name="Calls/Meetings" stackId="a" fill="#10b981" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </KpiSection>

      {/* ── Operations ── */}
      <KpiSection title="Operations" sourceUrl={operations.source_url} sourceLabel="Projects">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          <KpiCard
            label="Active Deployments"
            value={operations.active_deployments.length}
            accent={operations.active_deployments.length > 0 ? "green" : undefined}
            sourceUrl={operations.source_url}
            sourceLabel="Projects"
            drill={<DrillList items={operations.active_deployments.map(d => `${d.name} — ${d.stage}`)} />}
          />
          <KpiCard
            label="Avg Contract → Deployment"
            value={operations.avg_contract_to_deployment_days != null
              ? `${operations.avg_contract_to_deployment_days}d` : "—"}
            sub="Pilot/Production with start date"
            sourceUrl={operations.source_url}
            sourceLabel="Projects"
          />
          <KpiCard
            label="Open Equipment Milestones"
            value={operations.open_equipment_milestones.length}
            accent={operations.open_equipment_milestones.length > 0 ? "yellow" : undefined}
            sourceUrl={operations.source_url}
            sourceLabel="Projects"
            drill={<DrillList items={operations.open_equipment_milestones.map(m => `${m.project_name}: ${m.title} (${m.status})`)} />}
          />
        </div>
      </KpiSection>

      {/* ── Financial ── */}
      <KpiSection title="Financial" sourceUrl={financial.source_url} sourceLabel="FP&A">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard
            label="Monthly Burn Rate"
            value={fmt$(financial.current_month_burn)}
            sub={`${financial.burn_mode === "manual" ? "Manual entries" : financial.burn_mode === "reconciled" ? "Reconciled (Plaid)" : "Auto"} · net ${fmt$(financial.net_burn)}/mo`}
            accent="red"
            sourceUrl={financial.source_url}
            sourceLabel="FP&A"
          />
          <KpiCard
            label="Runway"
            value={financial.runway_months != null ? `${financial.runway_months} mo` : "—"}
            sub={financial.cash_balance > 0 ? `${fmt$(financial.cash_balance)} cash on hand` : "Based on actuals"}
            accent={financial.runway_months != null && financial.runway_months <= 3 ? "red" : "green"}
            sourceUrl={financial.source_url}
            sourceLabel="FP&A"
          />
          <KpiCard
            label="Projected Annual Revenue"
            value={fmt$(financial.projected_annual_revenue)}
            sub="Current year FPA projection"
            sourceUrl={financial.source_url}
            sourceLabel="FP&A"
          />
          <KpiCard
            label="YTD Revenue vs Opex"
            value={fmt$(financial.ytd_revenue)}
            sub={`vs ${fmt$(financial.ytd_opex)} opex`}
            accent={financial.ytd_revenue >= financial.ytd_opex ? "green" : "yellow"}
            sourceUrl={financial.source_url}
            sourceLabel="FP&A"
          />
        </div>
      </KpiSection>

      {/* ── Capital ── */}
      <KpiSection title="Capital" sourceUrl={capital.source_url} sourceLabel="Funding">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KpiCard
            label="Capital Committed (closed rounds)"
            value={fmt$(capital.committed_capital)}
            accent="green"
            sourceUrl={capital.source_url}
            sourceLabel="Funding"
          />
          <KpiCard
            label="Open Round Committed"
            value={fmt$(capital.open_round_committed)}
            sourceUrl={capital.source_url}
            sourceLabel="Funding"
          />
          <KpiCard
            label="Term Sheets Outstanding"
            value={capital.term_sheets_outstanding}
            accent={capital.term_sheets_outstanding > 0 ? "yellow" : undefined}
            sourceUrl={capital.source_url}
            sourceLabel="Funding"
            drill={<DrillList items={capital.term_sheet_names} />}
          />
          <KpiCard
            label="Investor Meetings (this week)"
            value={capital.investor_meetings_this_week}
            sourceUrl="/contacts"
            sourceLabel="Contacts"
          />
        </div>

        {capital.investor_status.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-3">
              <SectionHeader>Investor Pipeline Status</SectionHeader>
              <Link href={capital.source_url} className="text-xs text-gray-400 hover:text-blue-500">Funding ↗</Link>
            </div>
            <div className="space-y-2">
              {capital.investor_status.map((s, i) => (
                <div key={s.status} className="group">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400 w-36 truncate">{s.status}</span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-2 overflow-hidden">
                      <div className="h-full rounded"
                        style={{ width: `${Math.min(s.count * 10, 100)}%`, backgroundColor: COLORS[i % COLORS.length] }} />
                    </div>
                    <span className="text-xs font-semibold w-6 text-right" style={{ color: COLORS[i % COLORS.length] }}>{s.count}</span>
                    <Link href={capital.source_url}
                      className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      title={s.names?.join(", ")}>↗</Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </KpiSection>
    </div>
  );
}

function KpisTab({ data }: { data: KpiData }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <span className="text-xs text-gray-400">As of {data.as_of}</span>
      </div>
      <KpiInternalTab data={data} />
    </div>
  );
}

// ── Main exported panel ────────────────────────────────────────────────────

export default function ReportsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<"kpis" | "tasks" | "crm" | "team">("kpis");
  const [taskData, setTaskData] = useState<TaskOverview | null>(null);
  const [crmData, setCrmData] = useState<CrmData | null>(null);
  const [teamData, setTeamData] = useState<TeamMember[] | null>(null);
  const [kpiData, setKpiData] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [kpiLoading, setKpiLoading] = useState(false);

  useEffect(() => {
    setKpiLoading(true);
    fetch("/api/proxy/reports/kpis")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setKpiData(d); })
      .finally(() => setKpiLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/proxy/reports/tasks/overview?days=${days}`)
        .then(r => r.ok ? r.json() : null).then(d => { if (d) setTaskData(d); }),
      fetch("/api/proxy/reports/crm")
        .then(r => r.ok ? r.json() : null).then(d => { if (d) setCrmData(d); }),
    ]).finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/proxy/reports/tasks/team")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.members) setTeamData(d.members); });
  }, [isAdmin]);

  const tabs = [
    { key: "kpis" as const, label: "KPIs" },
    { key: "tasks" as const, label: "My Tasks" },
    { key: "crm" as const, label: "CRM & Projects" },
    ...(isAdmin ? [{ key: "team" as const, label: "Team" }] : []),
  ];

  const showDaysPicker = tab !== "kpis";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg w-fit">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === t.key
                  ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
        {showDaysPicker && (
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        )}
      </div>

      {tab === "kpis" && (
        kpiLoading
          ? <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Loading KPIs…
            </div>
          : kpiData
            ? <KpisTab data={kpiData} />
            : <p className="text-sm text-gray-400 py-12 text-center">KPI data unavailable.</p>
      )}

      {loading && tab !== "kpis" && (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
          Loading…
        </div>
      )}

      {!loading && tab === "tasks" && (
        taskData ? <TasksTab data={taskData} /> : <p className="text-sm text-gray-400 py-12 text-center">No task data yet.</p>
      )}
      {!loading && tab === "crm" && (
        crmData ? <CrmTab data={crmData} /> : <p className="text-sm text-gray-400 py-12 text-center">No CRM data yet.</p>
      )}
      {!loading && tab === "team" && isAdmin && (
        teamData ? <TeamTab members={teamData} /> : <p className="text-sm text-gray-400 py-12 text-center">Loading team data…</p>
      )}
    </div>
  );
}
