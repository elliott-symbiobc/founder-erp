"use client";

import { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PartnerOrg, fmtDateTime } from "@/lib/learn";

interface SummaryUser {
  user_id: string; email: string; role: string; full_name: string | null;
  org_name: string | null; org_id: string | null;
  events: number; writes: number; active_days: number;
  last_seen: string; first_seen: string; avg_ms: number;
}
interface Summary {
  users: SummaryUser[];
  modules: { module: string; events: number; users: number }[];
  daily: { day: string; events: number; users: number }[];
  days: number;
}
interface Event {
  activity_id: number; email: string; full_name: string | null; role: string;
  method: string; path: string; module: string; action: string;
  status_code: number; duration_ms: number; ip: string | null;
  created_at: string; org_name: string | null;
}
interface UserDetail {
  user: { user_id: string; email: string; full_name: string | null; role: string; org_name: string | null; last_login: string | null };
  breakdown: { module: string; action: string; events: number; last_seen: string }[];
  timeline: Event[];
  learning: {
    module_id: string; title: string; track_title: string; status: string;
    video_seconds: number; quiz_score: number | null; completed_at: string | null; last_seen_at: string;
  }[];
}

function StatusPill({ code }: { code: number }) {
  const cls =
    code < 300 ? "text-emerald-600 dark:text-emerald-400" :
    code < 400 ? "text-blue-600 dark:text-blue-400" :
    code < 500 ? "text-amber-600 dark:text-amber-400" :
                 "text-red-600 dark:text-red-400";
  return <span className={`tabular-nums text-xs font-medium ${cls}`}>{code}</span>;
}

function Sparkline({ daily }: { daily: { day: string; events: number }[] }) {
  if (daily.length < 2) return null;
  const max = Math.max(...daily.map(d => d.events), 1);
  return (
    <div className="flex items-end gap-0.5 h-12">
      {daily.map(d => (
        <div
          key={d.day}
          title={`${new Date(d.day).toLocaleDateString()} — ${d.events} events`}
          className="flex-1 min-w-[2px] bg-blue-400/70 dark:bg-blue-500/60 rounded-sm"
          style={{ height: `${Math.max(4, (100 * d.events) / max)}%` }}
        />
      ))}
    </div>
  );
}

function ActivityPageInner() {
  const params = useSearchParams();
  const [days, setDays] = useState(30);
  const [orgId, setOrgId] = useState<string>("");
  const [orgs, setOrgs] = useState<PartnerOrg[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openUser = useCallback(async (userId: string) => {
    const res = await fetch(`/api/proxy/activity/users/${userId}?days=90`);
    if (res.ok) setDetail(await res.json());
  }, []);

  useEffect(() => {
    const u = params.get("user");
    if (u) openUser(u);
  }, [params, openUser]);

  useEffect(() => {
    (async () => {
      const q = new URLSearchParams({ days: String(days) });
      if (orgId) q.set("org_id", orgId);
      const [sRes, eRes] = await Promise.all([
        fetch(`/api/proxy/activity/summary?${q}`),
        fetch(`/api/proxy/activity?${q}&limit=200`),
      ]);
      if (!sRes.ok) { setError("You do not have permission to view activity."); return; }
      setSummary(await sRes.json());
      setEvents((await eRes.json()).events ?? []);
    })();
  }, [days, orgId]);

  useEffect(() => {
    fetch("/api/proxy/partners/orgs").then(r => r.ok ? r.json() : []).then(setOrgs).catch(() => {});
  }, []);

  if (error) return <div className="p-8 text-sm text-red-600 dark:text-red-400">{error}</div>;

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Activity</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Every API request made by staff and partners.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            value={orgId} onChange={e => setOrgId(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
          >
            <option value="">Everyone</option>
            {orgs.map(o => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}
          </select>
          <select
            value={days} onChange={e => setDays(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
          >
            {[1, 7, 30, 90].map(d => <option key={d} value={d}>Last {d} day{d > 1 ? "s" : ""}</option>)}
          </select>
        </div>
      </div>

      {summary && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <p className="text-xs uppercase tracking-wide text-gray-500">Active users</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {summary.users.length}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <p className="text-xs uppercase tracking-wide text-gray-500">Requests</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {summary.users.reduce((a, u) => a + u.events, 0).toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
              <p className="text-xs uppercase tracking-wide text-gray-500">Daily volume</p>
              <div className="mt-1"><Sparkline daily={summary.daily} /></div>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
            <h2 className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 dark:border-gray-700">
              By user
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/60 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-2">User</th>
                    <th className="text-left px-4 py-2">Org</th>
                    <th className="text-right px-4 py-2">Requests</th>
                    <th className="text-right px-4 py-2">Writes</th>
                    <th className="text-right px-4 py-2">Active days</th>
                    <th className="text-left px-4 py-2">Last seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {summary.users.map(u => (
                    <tr
                      key={u.user_id}
                      onClick={() => openUser(u.user_id)}
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60"
                    >
                      <td className="px-4 py-2">
                        <div className="text-gray-900 dark:text-gray-100">{u.full_name || u.email}</div>
                        <div className="text-xs text-gray-500">{u.role}</div>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">{u.org_name ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{u.events.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{u.writes.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{u.active_days}</td>
                      <td className="px-4 py-2 text-xs text-gray-500">{fmtDateTime(u.last_seen)}</td>
                    </tr>
                  ))}
                  {summary.users.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No activity in this window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Most used areas</h2>
            <div className="mt-3 space-y-1.5">
              {summary.modules.slice(0, 10).map(m => {
                const max = summary.modules[0]?.events || 1;
                return (
                  <div key={m.module} className="flex items-center gap-3 text-sm">
                    <span className="w-32 shrink-0 truncate text-gray-700 dark:text-gray-300">{m.module}</span>
                    <div className="flex-1 h-2 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(100 * m.events) / max}%` }} />
                    </div>
                    <span className="w-20 text-right tabular-nums text-xs text-gray-500">
                      {m.events.toLocaleString()} · {m.users}u
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <h2 className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100 dark:border-gray-700">
          Recent requests
        </h2>
        <div className="max-h-[28rem] overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800">
          {events.map(e => (
            <div key={e.activity_id} className="flex items-center gap-3 px-5 py-1.5 text-xs">
              <span className="w-36 shrink-0 truncate text-gray-500">{e.full_name || e.email}</span>
              <span className="w-14 shrink-0 font-mono text-gray-400">{e.method}</span>
              <span className="flex-1 truncate font-mono text-gray-700 dark:text-gray-300">{e.path}</span>
              <StatusPill code={e.status_code} />
              <span className="w-14 text-right tabular-nums text-gray-400">{e.duration_ms}ms</span>
              <span className="w-32 shrink-0 text-right text-gray-400">{fmtDateTime(e.created_at)}</span>
            </div>
          ))}
          {events.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-gray-500">No requests recorded.</p>
          )}
        </div>
      </div>

      {detail && <UserDrawer detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function UserDrawer({ detail, onClose }: { detail: UserDetail; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-2xl h-full overflow-y-auto bg-white dark:bg-gray-900 p-6 sm:p-8 space-y-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {detail.user.full_name || detail.user.email}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {detail.user.role}{detail.user.org_name ? ` · ${detail.user.org_name}` : ""} · last login{" "}
              {fmtDateTime(detail.user.last_login)}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        {detail.learning.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Learning progress</h3>
            <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
              {detail.learning.map(l => (
                <div key={l.module_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      l.status === "completed" ? "bg-emerald-500" : "bg-amber-400"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-gray-900 dark:text-gray-100">{l.title}</div>
                    <div className="text-xs text-gray-500 truncate">{l.track_title}</div>
                  </div>
                  {l.quiz_score !== null && (
                    <span className="text-xs tabular-nums text-gray-500">{l.quiz_score}%</span>
                  )}
                  <span className="text-xs text-gray-400 w-32 text-right">
                    {l.completed_at ? fmtDateTime(l.completed_at) : `${Math.round(l.video_seconds / 60)} min watched`}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Where they spend time</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {detail.breakdown.slice(0, 20).map((b, i) => (
              <span
                key={i}
                className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800 text-xs text-gray-700 dark:text-gray-300"
              >
                {b.module} · {b.action} <span className="tabular-nums text-gray-500">{b.events}</span>
              </span>
            ))}
            {detail.breakdown.length === 0 && (
              <p className="text-sm text-gray-500">No requests in the last 90 days.</p>
            )}
          </div>
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Timeline</h3>
          <div className="mt-2 max-h-96 overflow-y-auto divide-y divide-gray-50 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            {detail.timeline.map(e => (
              <div key={e.activity_id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                <span className="w-12 shrink-0 font-mono text-gray-400">{e.method}</span>
                <span className="flex-1 truncate font-mono text-gray-700 dark:text-gray-300">{e.path}</span>
                <StatusPill code={e.status_code} />
                <span className="w-32 shrink-0 text-right text-gray-400">{fmtDateTime(e.created_at)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function ActivityPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-500">Loading…</div>}>
      <ActivityPageInner />
    </Suspense>
  );
}
