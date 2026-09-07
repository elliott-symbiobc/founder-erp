"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useDevMode } from "@/components/DevModeContext";
import { useRouter } from "next/navigation";

// ─── types ───────────────────────────────────────────────────────────────────

interface TraceRow {
  trace_id: string;
  run_id: string;
  entity_id: string | null;
  entity_type: string | null;
  pipeline: string;
  function_name: string | null;
  module_path?: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  triggered_by: string | null;
}

interface TraceDetail extends TraceRow {
  steps: Array<{ label: string; elapsed_ms: number; data: Record<string, unknown> }>;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  assumptions: unknown[] | null;
  error_traceback: string | null;
}

interface FnDoc {
  name: string;
  signature: string;
  docstring: string;
  async: boolean;
}

interface ModuleDoc {
  module: string;
  display_name: string;
  functions: FnDoc[];
  error?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  return `${Math.round(diff / 3600000)}h ago`;
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "success" ? "bg-green-500" :
    status === "error"   ? "bg-red-500" :
    status === "running" ? "bg-amber-400 animate-pulse" :
    "bg-gray-400";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />;
}

function JSONViewer({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false);
  const str = JSON.stringify(data, null, 2);
  if (!str || str === "{}" || str === "null" || str === "[]") return null;
  return (
    <div className="mt-1">
      <button onClick={() => setOpen(o => !o)} className="text-[10px] text-blue-500 hover:text-blue-700">
        {open ? "▾ hide" : "▸ data"}
      </button>
      {open && (
        <pre className="mt-1 text-[10px] font-mono bg-gray-900 text-green-300 rounded p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">
          {str}
        </pre>
      )}
    </div>
  );
}

// ─── Source modal ─────────────────────────────────────────────────────────────

function SourceModal({ modulePath, fn, onClose }: { modulePath: string; fn?: string; onClose: () => void }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = fn
      ? `/api/proxy/dev/source/${modulePath}?fn=${encodeURIComponent(fn)}`
      : `/api/proxy/dev/source/${modulePath}`;
    fetch(url)
      .then(r => r.json())
      .then(d => setSource(d.source || "No source available"))
      .catch(e => setError(String(e)));
  }, [modulePath, fn]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <div>
            <span className="font-mono text-xs text-gray-500">{modulePath}</span>
            {fn && <span className="ml-2 font-mono text-sm font-semibold text-green-600">{fn}</span>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg font-bold">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {error && <p className="text-red-500 text-sm">{error}</p>}
          {!source && !error && <p className="text-gray-400 text-sm">Loading…</p>}
          {source && (
            <pre className="text-[11px] font-mono text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
              {source}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Activity tab ─────────────────────────────────────────────────────────────

function ActivityTab() {
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [selected, setSelected] = useState<TraceDetail | null>(null);
  const [sourceModal, setSourceModal] = useState<{ module: string; fn?: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTraces = useCallback(() => {
    fetch("/api/proxy/dev/traces?limit=60")
      .then(r => r.json())
      .then(d => setTraces(d.traces || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchTraces();
    pollRef.current = setInterval(fetchTraces, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchTraces]);

  const fetchDetail = useCallback((traceId: string) => {
    fetch(`/api/proxy/dev/traces/detail/${traceId}`)
      .then(r => r.json())
      .then(d => setSelected(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    if (selected.status !== "running") return;
    detailPollRef.current = setInterval(() => fetchDetail(selected.trace_id), 1500);
    return () => { if (detailPollRef.current) clearInterval(detailPollRef.current); };
  }, [selected?.trace_id, selected?.status, fetchDetail]);

  function selectTrace(t: TraceRow) {
    if (detailPollRef.current) clearInterval(detailPollRef.current);
    setSelected(null);
    fetchDetail(t.trace_id);
  }

  return (
    <div className="flex gap-4 h-full min-h-[600px]">
      {/* Trace list */}
      <div className="w-80 shrink-0 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
        <div className="sticky top-0 bg-gray-50 dark:bg-gray-800 px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Live Traces</span>
          <span className="text-[10px] text-gray-400">auto-refresh 3s</span>
        </div>
        {traces.length === 0 && (
          <p className="px-4 py-6 text-sm text-gray-400 italic">No traces yet. Trigger an action to see it here.</p>
        )}
        {traces.map(t => (
          <button
            key={t.trace_id}
            onClick={() => selectTrace(t)}
            className={`w-full text-left px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selected?.trace_id === t.trace_id ? "bg-blue-50 dark:bg-blue-900/30" : ""}`}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <StatusDot status={t.status} />
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{t.pipeline}</span>
              <span className="ml-auto text-[10px] text-gray-400 shrink-0">{relativeTime(t.started_at)}</span>
            </div>
            <div className="text-[10px] text-gray-500 truncate pl-4">
              {t.entity_type && <span className="text-gray-400">{t.entity_type}: </span>}
              {t.entity_id?.slice(0, 12) || "—"}
            </div>
            {t.function_name && (
              <div className="text-[10px] font-mono text-blue-500 truncate pl-4">{t.function_name.split(".").pop()}</div>
            )}
            {t.duration_ms != null && (
              <div className="text-[10px] text-gray-400 pl-4">{t.duration_ms}ms</div>
            )}
          </button>
        ))}
      </div>

      {/* Detail panel */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="flex items-center justify-center h-full text-sm text-gray-400">
            Select a trace to inspect it
          </div>
        )}
        {selected && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center gap-3 flex-wrap">
              <StatusDot status={selected.status} />
              <span className="font-semibold text-gray-900 dark:text-gray-100">{selected.pipeline}</span>
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                selected.status === "success" ? "bg-green-100 text-green-700" :
                selected.status === "error" ? "bg-red-100 text-red-700" :
                selected.status === "running" ? "bg-amber-100 text-amber-700" :
                "bg-gray-100 text-gray-600"
              }`}>{selected.status}</span>
              {selected.duration_ms != null && <span className="text-xs text-gray-500">{selected.duration_ms}ms</span>}
            </div>

            {/* Meta */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                ["Entity", `${selected.entity_type ?? "—"}: ${selected.entity_id ?? "—"}`],
                ["Triggered by", selected.triggered_by ?? "—"],
                ["Started", new Date(selected.started_at).toLocaleString()],
                ["Trace ID", selected.trace_id.slice(0, 12) + "…"],
              ].map(([k, v]) => (
                <div key={k} className="bg-gray-50 dark:bg-gray-800 rounded px-3 py-2">
                  <div className="text-gray-400 uppercase tracking-wide text-[10px] mb-0.5">{k}</div>
                  <div className="font-mono text-gray-700 dark:text-gray-300 truncate">{v}</div>
                </div>
              ))}
            </div>

            {/* Function + source button */}
            {selected.function_name && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-green-600 dark:text-green-400">{selected.function_name}</span>
                {selected.module_path && (
                  <button
                    onClick={() => setSourceModal({ module: selected.module_path!, fn: selected.function_name?.split(".").pop() })}
                    className="text-[10px] px-2 py-0.5 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
                  >
                    View source
                  </button>
                )}
              </div>
            )}

            {/* Inputs */}
            {selected.inputs && Object.keys(selected.inputs).length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Inputs</div>
                <pre className="text-[11px] font-mono bg-gray-900 text-green-300 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-32">
                  {JSON.stringify(selected.inputs, null, 2)}
                </pre>
              </div>
            )}

            {/* Steps timeline */}
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Steps {selected.status === "running" && <span className="text-amber-500 font-normal">(live)</span>}
              </div>
              {(!selected.steps || selected.steps.length === 0) ? (
                <p className="text-xs text-gray-400 italic">
                  {selected.status === "running" ? "Waiting for first step…" : "No steps recorded."}
                </p>
              ) : (
                <div className="relative pl-4 border-l-2 border-gray-200 dark:border-gray-700 space-y-3">
                  {selected.steps.map((step, i) => (
                    <div key={i} className="relative">
                      <div className="absolute -left-[21px] w-3 h-3 rounded-full bg-blue-400 border-2 border-white dark:border-gray-900" />
                      <div className="text-xs font-medium text-gray-800 dark:text-gray-200">{step.label}</div>
                      <div className="text-[10px] text-gray-400">+{step.elapsed_ms}ms</div>
                      <JSONViewer data={step.data} />
                    </div>
                  ))}
                  {selected.status === "running" && (
                    <div className="relative">
                      <div className="absolute -left-[21px] w-3 h-3 rounded-full bg-amber-400 animate-pulse border-2 border-white dark:border-gray-900" />
                      <div className="text-xs text-amber-500 italic">Running…</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Outputs */}
            {selected.outputs && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Outputs</div>
                <pre className="text-[11px] font-mono bg-gray-900 text-green-300 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-48">
                  {JSON.stringify(selected.outputs, null, 2)}
                </pre>
              </div>
            )}

            {/* Error */}
            {selected.error_message && (
              <div className="rounded border border-red-200 bg-red-50 dark:bg-red-950 px-4 py-3">
                <div className="text-xs font-semibold text-red-700 mb-1">Error</div>
                <div className="text-xs text-red-600 font-mono">{selected.error_message}</div>
                {selected.error_traceback && (
                  <details className="mt-2">
                    <summary className="text-[10px] text-red-400 cursor-pointer">Full traceback</summary>
                    <pre className="mt-1 text-[10px] text-red-500 whitespace-pre-wrap">{selected.error_traceback}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {sourceModal && (
        <SourceModal
          modulePath={sourceModal.module}
          fn={sourceModal.fn}
          onClose={() => setSourceModal(null)}
        />
      )}
    </div>
  );
}

// ─── Module Docs tab ──────────────────────────────────────────────────────────

function ModuleDocsTab() {
  const [docs, setDocs] = useState<ModuleDoc[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceModal, setSourceModal] = useState<{ module: string; fn?: string } | null>(null);

  useEffect(() => {
    fetch("/api/proxy/dev/docs")
      .then(r => r.json())
      .then(d => {
        setDocs(d.modules);
        if (d.modules?.length > 0) setSelected(d.modules[0].module);
      })
      .catch(() => {});
  }, []);

  const activeModule = docs?.find(m => m.module === selected);

  if (!docs) return <p className="text-sm text-gray-400">Loading module docs…</p>;

  return (
    <div className="flex gap-4 min-h-[600px]">
      {/* Module list */}
      <div className="w-52 shrink-0 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
        {docs.map(mod => (
          <button
            key={mod.module}
            onClick={() => setSelected(mod.module)}
            className={`w-full text-left px-3 py-2 text-xs font-medium border-b border-gray-100 dark:border-gray-800 transition-colors ${
              selected === mod.module
                ? "bg-amber-50 text-amber-800 border-l-2 border-l-amber-400"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            {mod.display_name}
            {mod.error && <span className="ml-1 text-red-400 text-[10px]">!</span>}
            <div className="text-[10px] text-gray-400 font-normal truncate">{mod.module.split(".").slice(-1)[0]}</div>
          </button>
        ))}
      </div>

      {/* Function list */}
      <div className="flex-1 overflow-y-auto">
        {activeModule?.error ? (
          <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Import error: {activeModule.error}
          </div>
        ) : activeModule ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-mono text-gray-400">{activeModule.module}</p>
              <button
                onClick={() => setSourceModal({ module: activeModule.module })}
                className="text-[10px] px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-50"
              >
                View full source
              </button>
            </div>
            {activeModule.functions.length === 0 && (
              <p className="text-sm text-gray-400 italic">No public functions.</p>
            )}
            {activeModule.functions.map(fn => (
              <div key={fn.name} className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="font-mono text-xs leading-snug">
                    {fn.async && <span className="text-purple-600">async </span>}
                    <span className="font-semibold text-green-700 dark:text-green-400">{fn.name}</span>
                    <span className="text-gray-500">{fn.signature}</span>
                  </div>
                  <button
                    onClick={() => setSourceModal({ module: activeModule.module, fn: fn.name })}
                    className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-blue-200 text-blue-500 hover:bg-blue-50"
                  >
                    Source
                  </button>
                </div>
                {fn.docstring && (
                  <p className="text-[11px] text-gray-500 font-sans whitespace-pre-wrap leading-relaxed">
                    {fn.docstring}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {sourceModal && (
        <SourceModal
          modulePath={sourceModal.module}
          fn={sourceModal.fn}
          onClose={() => setSourceModal(null)}
        />
      )}
    </div>
  );
}

// ─── Assumptions tab ──────────────────────────────────────────────────────────

function AssumptionsTab() {
  const [assumptions, setAssumptions] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    fetch("/api/proxy/dev/assumptions")
      .then(r => r.json())
      .then(d => setAssumptions(d.assumptions))
      .catch(() => {});
  }, []);

  if (!assumptions) return <p className="text-sm text-gray-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Hard-coded constants and default values in the computation pipeline.
        Changes require a code deploy.
      </p>
      {Object.entries(assumptions).map(([key, val]) => (
        <div key={key} className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
          <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800">
            <span className="text-xs font-mono font-semibold text-amber-700 dark:text-amber-400">{key}</span>
          </div>
          <pre className="px-4 py-3 text-[11px] font-mono text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap max-h-80">
            {JSON.stringify(val, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ─── API Usage tab ────────────────────────────────────────────────────────────

function ApiUsageTab() {
  const [data, setData] = useState<{
    period_days: number;
    all_time_cost_usd: number;
    by_service: Array<{ service: string; call_count: number; total_cost_usd: number; total_input_tokens: number; total_output_tokens: number }>;
    by_operation: Array<{ service: string; operation: string; model: string; call_count: number; total_cost_usd: number }>;
  } | null>(null);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    fetch("/api/proxy/dev/api-usage?period=30").then(r => r.json()).then(setData).catch(() => {});
    fetch("/api/proxy/dev/api-key-status").then(r => r.json()).then(setKeyStatus).catch(() => {});
  }, []);

  if (!data) return <p className="text-sm text-gray-400">Loading…</p>;

  const maxCost = Math.max(...data.by_operation.map(o => o.total_cost_usd), 0.001);

  return (
    <div className="space-y-6">
      {/* Key status */}
      {keyStatus && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(keyStatus).map(([svc, ok]) => (
            <span key={svc} className={`text-xs px-2.5 py-1 rounded font-medium ${ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
              {ok ? "✓" : "✗"} {svc}
            </span>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          ["All-time cost", `$${data.all_time_cost_usd.toFixed(4)}`],
          ["Period", `${data.period_days} days`],
          ["Services", `${data.by_service.length}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-0.5">{value}</div>
          </div>
        ))}
      </div>

      {/* By service */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">By Service (30 days)</h3>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-800">
              {["Service", "Calls", "Input tokens", "Output tokens", "Cost"].map(h => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-gray-400">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {data.by_service.map(s => (
              <tr key={s.service} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                <td className="px-3 py-2 font-medium">{s.service}</td>
                <td className="px-3 py-2 text-gray-600">{s.call_count.toLocaleString()}</td>
                <td className="px-3 py-2 text-gray-600">{(s.total_input_tokens / 1000).toFixed(1)}k</td>
                <td className="px-3 py-2 text-gray-600">{(s.total_output_tokens / 1000).toFixed(1)}k</td>
                <td className="px-3 py-2 font-semibold text-gray-900 dark:text-gray-100">${Number(s.total_cost_usd).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* By operation bar chart */}
      {data.by_operation.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Cost by Operation</h3>
          <div className="space-y-1.5">
            {data.by_operation.slice(0, 20).map((op, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <div className="w-48 truncate text-gray-600 font-mono shrink-0">{op.operation || op.service}</div>
                <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-3 overflow-hidden">
                  <div
                    className="h-full bg-amber-400 rounded"
                    style={{ width: `${(Number(op.total_cost_usd) / maxCost) * 100}%` }}
                  />
                </div>
                <div className="w-16 text-right text-gray-500">${Number(op.total_cost_usd).toFixed(4)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = "activity" | "docs" | "assumptions" | "usage";

export default function KbDevPage() {
  const { devMode } = useDevMode();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("activity");

  useEffect(() => {
    if (!devMode) router.replace("/kb/overview");
  }, [devMode, router]);

  if (!devMode) return null;

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "activity", label: "Live Activity" },
    { id: "docs",     label: "Module Docs" },
    { id: "assumptions", label: "Assumptions" },
    { id: "usage",    label: "API Usage" },
  ];

  return (
    <article className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono font-semibold text-amber-500 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
            DEV MODE
          </span>
          <span className="text-xs text-gray-400">Developer Reference — live codebase introspection</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Developer Reference</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Live execution traces, source code inspection, module docs, and API usage — all routers and agents covered.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? "border-amber-500 text-amber-700 dark:text-amber-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === "activity"    && <ActivityTab />}
        {tab === "docs"        && <ModuleDocsTab />}
        {tab === "assumptions" && <AssumptionsTab />}
        {tab === "usage"       && <ApiUsageTab />}
      </div>
    </article>
  );
}