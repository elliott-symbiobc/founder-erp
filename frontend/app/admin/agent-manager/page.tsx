"use client";

import { useEffect, useState, useCallback } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ────────────────────────────────────────────────────────────────────

interface Agent {
  agent_id: string;
  display_name: string;
  description: string;
  module: string;
  pages: string[];
  file: string;
  wired: boolean;
  // static metadata
  context_sources: string[];
  tools: string[];
  default_system_prompt: string;
  // effective values
  model: string;
  max_tokens: number;
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  system_prompt_override: string | null;
  notes: string | null;
  // defaults
  default_model: string;
  default_max_tokens: number;
  default_temperature: number | null;
  default_top_p: number | null;
  default_top_k: number | null;
  has_override: boolean;
  updated_at: string | null;
}

interface Job {
  job_name: string;
  task: string;
  description: string;
  module: string;
  enabled: boolean;
  cron_hour: string;
  cron_minute: string;
  cron_day_of_week: string;
  schedule_display: string;
  default_cron_hour: string;
  default_cron_minute: string;
  default_cron_day_of_week: string;
  notes: string | null;
  has_override: boolean;
  updated_at: string | null;
}

interface UsageRow {
  id: number;
  service: string;
  operation: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: number | null;
  cost_usd: number | null;
  created_at: string;
}

interface UsageSummary {
  totals: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    cost_24h: number;
    cost_7d: number;
    cost_30d: number;
  };
  by_operation: {
    operation: string;
    model: string;
    calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
  }[];
}

type Tab = "agents" | "jobs" | "prompts" | "usage";
type DetailTab = "prompt" | "context" | "tools";

interface PipelinePrompt {
  agent_module: string;
  prompt_key: string;
  description: string;
  variables: string[];
  default_text: string;
  override_text: string | null;
  is_overridden: boolean;
  override_description: string | null;
  updated_at: string | null;
  created_by: string | null;
  last_rendered_text: string | null;
  last_rendered_at: string | null;
}

// ── Model options ─────────────────────────────────────────────────────────────

const MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-sonnet-4-20250514",
  "claude-opus-4-6",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toFixed(4);
}

function fmtBig$(n: number | null): string {
  if (n == null) return "—";
  if (n < 0.01) return "$" + n.toFixed(5);
  return "$" + n.toFixed(3);
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtDt(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function moduleColor(mod: string): string {
  const map: Record<string, string> = {
    Planner: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800",
    Dashboard: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800",
    Literature: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
    Notes: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800",
    Notebook: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800",
    Tasks: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800",
    Protocols: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800",
    Substrates: "bg-lime-50 text-lime-700 border-lime-200 dark:bg-lime-950/40 dark:text-lime-300 dark:border-lime-800",
    Compounds: "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-800",
    Contacts: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800",
    "ML Model": "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    "FP&A": "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800",
    Regulatory: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800",
  };
  return map[mod] ?? "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700";
}

// ── Agent Details Panel ───────────────────────────────────────────────────────

function AgentDetails({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<DetailTab>("prompt");

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-3">
        {(["prompt", "context", "tools"] as DetailTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors capitalize ${
              tab === t
                ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
          >
            {t === "prompt" ? "System Prompt" : t === "context" ? `Context (${agent.context_sources.length})` : `Tools (${agent.tools.length})`}
          </button>
        ))}
      </div>

      {tab === "prompt" && (
        <div>
          {agent.system_prompt_override && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Active Override</span>
                <span className="text-[10px] text-amber-500 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-800">prepended to base prompt</span>
              </div>
              <pre className="text-[11px] font-mono text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
                {agent.system_prompt_override}
              </pre>
            </div>
          )}
          <div>
            {agent.system_prompt_override && (
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Base Prompt (code default)</span>
              </div>
            )}
            <pre className="text-[11px] font-mono text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg p-3 whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
              {agent.default_system_prompt || "Prompt defined in agent file — see " + agent.file}
            </pre>
          </div>
        </div>
      )}

      {tab === "context" && (
        <div>
          {agent.context_sources.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-gray-600 italic">No context sources documented.</p>
          ) : (
            <ul className="space-y-1.5">
              {agent.context_sources.map((src, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-0.5 flex-shrink-0 w-4 h-4 rounded bg-blue-100 dark:bg-blue-950/40 flex items-center justify-center">
                    <svg className="w-2.5 h-2.5 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M3 4a1 1 0 000 2h14a1 1 0 100-2H3zm0 4a1 1 0 000 2h14a1 1 0 100-2H3zm0 4a1 1 0 000 2h8a1 1 0 100-2H3z" />
                    </svg>
                  </span>
                  <span className="text-xs text-gray-700 dark:text-gray-300">{src}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "tools" && (
        <div>
          {agent.tools.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
              </svg>
              No tools — pure prompt/response (JSON output)
            </div>
          ) : (
            <ul className="space-y-1.5">
              {agent.tools.map((tool, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="flex-shrink-0 w-4 h-4 rounded bg-green-100 dark:bg-green-950/40 flex items-center justify-center">
                    <svg className="w-2.5 h-2.5 text-green-600" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
                    </svg>
                  </span>
                  <span className="text-xs font-mono text-green-700 dark:text-green-400">{tool}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Agent Edit Modal ──────────────────────────────────────────────────────────

function AgentEditModal({
  agent,
  onSave,
  onReset,
  onClose,
}: {
  agent: Agent;
  onSave: (patch: Partial<Agent>) => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
}) {
  const [model, setModel] = useState(agent.model);
  const [maxTokens, setMaxTokens] = useState(String(agent.max_tokens));
  const [temperature, setTemperature] = useState(
    agent.temperature != null ? String(agent.temperature) : ""
  );
  const [topP, setTopP] = useState(agent.top_p != null ? String(agent.top_p) : "");
  const [topK, setTopK] = useState(agent.top_k != null ? String(agent.top_k) : "");
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt_override ?? "");
  const [notes, setNotes] = useState(agent.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const isModified =
    model !== agent.default_model ||
    maxTokens !== String(agent.default_max_tokens) ||
    systemPrompt !== "" ||
    notes !== (agent.notes ?? "");

  async function save() {
    setBusy(true);
    try {
      await onSave({
        model,
        max_tokens: parseInt(maxTokens, 10) || agent.default_max_tokens,
        temperature: temperature ? parseFloat(temperature) : null,
        top_p: topP ? parseFloat(topP) : null,
        top_k: topK ? parseInt(topK, 10) : null,
        system_prompt_override: systemPrompt.trim() || null,
        notes: notes.trim() || null,
      } as Partial<Agent>);
      onClose();
    } finally { setBusy(false); }
  }

  async function handleReset() {
    setBusy(true);
    try { await onReset(); onClose(); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{agent.display_name}</h3>
              <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${moduleColor(agent.module)}`}>{agent.module}</span>
              {agent.wired ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800">
                  <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>
                  Live
                </span>
              ) : (
                <span className="inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-500 border border-gray-200 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700">
                  Read-only
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{agent.description}</p>
            <p className="text-[11px] text-gray-400 dark:text-gray-600 mt-0.5 font-mono">{agent.file}</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
          {!agent.wired && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                <strong>Read-only mode</strong> — this agent doesn't yet read overrides at runtime. Changes are saved but won't take effect until the agent is wired.
              </p>
            </div>
          )}

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Model
              <span className="ml-2 text-gray-400 font-normal">default: {agent.default_model}</span>
            </label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 font-mono transition-all"
            >
              {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {/* Max tokens */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Max Tokens <span className="text-gray-400 font-normal">default: {agent.default_max_tokens}</span>
            </label>
            <input
              type="number"
              value={maxTokens}
              onChange={e => setMaxTokens(e.target.value)}
              min={64}
              max={32000}
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 font-mono transition-all"
            />
          </div>

          {/* Sampling params — 3-column grid */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              Sampling Parameters
              <span className="ml-2 text-gray-400 font-normal">temperature, top_p, top_k — leave blank to use model defaults</span>
            </label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                  Temperature <span className="text-gray-400">(0–1)</span>
                </label>
                <input
                  type="number"
                  value={temperature}
                  onChange={e => setTemperature(e.target.value)}
                  step={0.05}
                  min={0}
                  max={1}
                  placeholder="default"
                  className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 font-mono transition-all"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                  Top P <span className="text-gray-400">(0–1)</span>
                </label>
                <input
                  type="number"
                  value={topP}
                  onChange={e => setTopP(e.target.value)}
                  step={0.05}
                  min={0}
                  max={1}
                  placeholder="default"
                  className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 font-mono transition-all"
                />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">
                  Top K <span className="text-gray-400">(integer)</span>
                </label>
                <input
                  type="number"
                  value={topK}
                  onChange={e => setTopK(e.target.value)}
                  step={1}
                  min={1}
                  max={500}
                  placeholder="default"
                  className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 font-mono transition-all"
                />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Only set one of temperature or top_p — Anthropic recommends not using both simultaneously.
            </p>
          </div>

          {/* System prompt override */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
              System Prompt Override
              <span className="ml-2 text-gray-400 font-normal">prepended to the agent's base prompt</span>
            </label>
            <AutoTextarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              rows={6}
              placeholder="Enter additional instructions or overrides for this agent's system prompt…"
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 font-mono leading-relaxed resize-none transition-all"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Admin Notes</label>
            <AutoTextarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="Internal notes about this override…"
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none transition-all"
            />
          </div>

          {agent.updated_at && (
            <p className="text-[11px] text-gray-400 dark:text-gray-600">Last saved: {fmtDt(agent.updated_at)}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          {agent.has_override ? (
            confirmReset ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600 dark:text-red-400">Reset to code defaults?</span>
                <button onClick={handleReset} disabled={busy} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors">Yes, reset</button>
                <button onClick={() => setConfirmReset(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmReset(true)} className="text-xs text-red-500 hover:text-red-700 hover:underline transition-colors">
                Reset to defaults
              </button>
            )
          ) : <div />}
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Cancel</button>
            <button onClick={save} disabled={busy} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2">
              {busy && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Save Override
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Job Edit Modal ────────────────────────────────────────────────────────────

function JobEditModal({
  job,
  onSave,
  onClose,
}: {
  job: Job;
  onSave: (patch: Partial<Job>) => Promise<void>;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(job.enabled);
  const [hour, setHour] = useState(job.cron_hour);
  const [minute, setMinute] = useState(job.cron_minute);
  const [dow, setDow] = useState(job.cron_day_of_week);
  const [notes, setNotes] = useState(job.notes ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await onSave({ enabled, cron_hour: hour, cron_minute: minute, cron_day_of_week: dow, notes: notes.trim() || null } as Partial<Job>);
      onClose();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg overflow-hidden">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{job.job_name}</h3>
              <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${moduleColor(job.module)}`}>{job.module}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{job.description}</p>
            <p className="text-[11px] text-gray-400 dark:text-gray-600 mt-0.5 font-mono">{job.task}</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/60 rounded-lg border border-gray-200 dark:border-gray-700">
            <div>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Job Enabled</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Disable to skip scheduled runs (does not stop in-progress tasks)</p>
            </div>
            <button
              onClick={() => setEnabled(e => !e)}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors ${enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>

          <div className="bg-gray-50 dark:bg-gray-800/40 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
              Default schedule: {job.default_cron_hour === "*" ? "every hour" : `${job.default_cron_hour.padStart(2, "0")}:${job.default_cron_minute.padStart(2, "0")} UTC`}
              {job.default_cron_day_of_week !== "*" ? ` on day ${job.default_cron_day_of_week}` : ", daily"}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Hour (UTC, * = every)</label>
                <input value={hour} onChange={e => setHour(e.target.value)} placeholder="*"
                  className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Minute</label>
                <input value={minute} onChange={e => setMinute(e.target.value)} placeholder="0"
                  className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 font-mono" />
              </div>
              <div>
                <label className="block text-[11px] text-gray-500 dark:text-gray-400 mb-1">Day of week (* = all)</label>
                <input value={dow} onChange={e => setDow(e.target.value)} placeholder="*"
                  className="w-full text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 font-mono" />
              </div>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">1=Mon, 2=Tue … 7=Sun. Schedule changes require worker restart to take effect.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">Admin Notes</label>
            <AutoTextarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Internal notes…"
              className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 placeholder-gray-400 resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">Cancel</button>
          <button onClick={save} disabled={busy} className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2">
            {busy && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentManagerPage() {
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [tab, setTab] = useState<Tab>((searchParams?.get("tab") as Tab) ?? "agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [usage, setUsage] = useState<{ total: number; rows: UsageRow[] } | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [prompts, setPrompts] = useState<PipelinePrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [editPrompt, setEditPrompt] = useState<PipelinePrompt | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptDescDraft, setPromptDescDraft] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptRenderedExpanded, setPromptRenderedExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<{ job: string; task_id: string } | null>(null);
  const [moduleFilter, setModuleFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    const r = await fetch("/api/proxy/agent-manager/agents");
    if (r.ok) setAgents(await r.json());
  }, []);

  const loadJobs = useCallback(async () => {
    const r = await fetch("/api/proxy/agent-manager/jobs");
    if (r.ok) setJobs(await r.json());
  }, []);

  const loadUsage = useCallback(async () => {
    const [r1, r2] = await Promise.all([
      fetch("/api/proxy/agent-manager/usage?limit=50"),
      fetch("/api/proxy/agent-manager/usage/summary"),
    ]);
    if (r1.ok) setUsage(await r1.json());
    if (r2.ok) setUsageSummary(await r2.json());
  }, []);

  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      const r = await fetch("/api/proxy/dev/prompts");
      if (r.ok) {
        const d = await r.json();
        setPrompts(d.prompts ?? []);
      }
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadAgents(), loadJobs()]).finally(() => setLoading(false));
  }, [loadAgents, loadJobs]);

  useEffect(() => {
    if (tab === "usage") loadUsage();
    if (tab === "prompts") loadPrompts();
  }, [tab, loadUsage, loadPrompts]);

  function openPromptEdit(p: PipelinePrompt) {
    setEditPrompt(p);
    setPromptDraft(p.override_text ?? p.default_text);
    setPromptDescDraft(p.override_description ?? "");
    setPromptError(null);
  }

  async function savePromptOverride() {
    if (!editPrompt) return;
    setPromptSaving(true);
    setPromptError(null);
    try {
      const res = await fetch(
        `/api/proxy/dev/prompts/${editPrompt.agent_module}/${editPrompt.prompt_key}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt_text: promptDraft, description: promptDescDraft }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setPromptError(d.detail ?? "Save failed");
        return;
      }
      setEditPrompt(null);
      await loadPrompts();
    } finally {
      setPromptSaving(false);
    }
  }

  async function deletePromptOverride(p: PipelinePrompt) {
    await fetch(`/api/proxy/dev/prompts/${p.agent_module}/${p.prompt_key}`, { method: "DELETE" });
    await loadPrompts();
  }

  async function saveAgent(agent_id: string, patch: Partial<Agent>) {
    await fetch(`/api/proxy/agent-manager/agents/${agent_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadAgents();
  }

  async function resetAgent(agent_id: string) {
    await fetch(`/api/proxy/agent-manager/agents/${agent_id}/override`, { method: "DELETE" });
    await loadAgents();
  }

  async function saveJob(job_name: string, patch: Partial<Job>) {
    await fetch(`/api/proxy/agent-manager/jobs/${job_name}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadJobs();
  }

  async function triggerJob(job_name: string) {
    setTriggering(job_name);
    try {
      const r = await fetch(`/api/proxy/agent-manager/jobs/${job_name}/trigger`, { method: "POST" });
      if (r.ok) {
        const d = await r.json();
        setTriggerResult({ job: job_name, task_id: d.task_id });
        setTimeout(() => setTriggerResult(null), 5000);
      }
    } finally { setTriggering(null); }
  }

  const modules = Array.from(new Set(agents.map(a => a.module))).sort();

  const shownAgents = agents.filter(a => {
    if (moduleFilter && a.module !== moduleFilter) return false;
    if (search && !a.display_name.toLowerCase().includes(search.toLowerCase()) &&
        !a.description.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const jobModules = Array.from(new Set(jobs.map(j => j.module))).sort();
  const [jobModuleFilter, setJobModuleFilter] = useState("");
  const shownJobs = jobs.filter(j => !jobModuleFilter || j.module === jobModuleFilter);

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Agent Manager</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Inspect and override AI agent configurations, manage scheduled jobs, and track API usage.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-gray-400">{agents.filter(a => a.has_override).length} overrides active</span>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{jobs.filter(j => !j.enabled).length} jobs disabled</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1 w-fit">
        {(["agents", "jobs", "prompts", "usage"] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${
              tab === t
                ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            }`}>
            {t === "agents" ? `Agents (${agents.length})`
             : t === "jobs" ? `Scheduled Jobs (${jobs.length})`
             : t === "prompts" ? `Pipeline Prompts${prompts.filter(p => p.is_overridden).length ? ` (${prompts.filter(p => p.is_overridden).length} overridden)` : ""}`
             : "Usage & Cost"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : tab === "agents" ? (
        /* ── Agents Tab ── */
        <div className="space-y-3">
          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0015.803 15.803z" />
              </svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents…"
                className="pl-8 pr-3 py-2 text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 placeholder-gray-400 w-48" />
            </div>
            <select value={moduleFilter} onChange={e => setModuleFilter(e.target.value)}
              className="text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none text-gray-700 dark:text-gray-300">
              <option value="">All modules</option>
              {modules.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-xs text-gray-400 ml-1">{shownAgents.length} agents</span>
          </div>

          {/* Agent cards grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {shownAgents.map(agent => {
              const isExpanded = expandedAgent === agent.agent_id;
              return (
                <div key={agent.agent_id}
                  className={`bg-white dark:bg-gray-900 rounded-xl border transition-all ${
                    agent.has_override
                      ? "border-blue-200 dark:border-blue-800"
                      : "border-gray-200 dark:border-gray-700"
                  } ${isExpanded ? "shadow-md shadow-gray-200/60 dark:shadow-black/20" : "hover:shadow-md hover:shadow-gray-200/60 dark:hover:shadow-black/20"}`}>
                  <div className="p-4">
                    {/* Top row */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{agent.display_name}</span>
                          <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${moduleColor(agent.module)}`}>{agent.module}</span>
                          {agent.wired && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">
                              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" /></svg>Live
                            </span>
                          )}
                          {agent.has_override && (
                            <span className="inline-flex text-[10px] font-semibold text-blue-600 dark:text-blue-400">• overridden</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{agent.description}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => setExpandedAgent(isExpanded ? null : agent.agent_id)}
                          className={`flex items-center gap-1 px-2.5 py-1.5 text-xs border rounded-lg transition-all font-medium ${
                            isExpanded
                              ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 border-gray-900 dark:border-gray-100"
                              : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500"
                          }`}
                          title={isExpanded ? "Hide details" : "Show prompt, context & tools"}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          {isExpanded ? "Hide" : "Inspect"}
                        </button>
                        <button onClick={() => setEditAgent(agent)}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 border border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-700 rounded-lg transition-all font-medium">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                          </svg>
                          Edit
                        </button>
                      </div>
                    </div>

                    {/* Config row */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2.5 pt-2.5 border-t border-gray-100 dark:border-gray-800">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400">Model</span>
                        <span className={`text-[11px] font-mono font-semibold ${agent.model !== agent.default_model ? "text-blue-600 dark:text-blue-400" : "text-gray-600 dark:text-gray-400"}`}>
                          {agent.model.replace("claude-", "").replace("-20250514", "").replace("-20251001", "")}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-gray-400">Max tokens</span>
                        <span className={`text-[11px] font-mono font-semibold ${agent.max_tokens !== agent.default_max_tokens ? "text-blue-600 dark:text-blue-400" : "text-gray-600 dark:text-gray-400"}`}>
                          {agent.max_tokens.toLocaleString()}
                        </span>
                      </div>
                      {agent.temperature != null && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-gray-400">temp</span>
                          <span className="text-[11px] font-mono font-semibold text-blue-600 dark:text-blue-400">{agent.temperature}</span>
                        </div>
                      )}
                      {agent.top_p != null && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-gray-400">top_p</span>
                          <span className="text-[11px] font-mono font-semibold text-blue-600 dark:text-blue-400">{agent.top_p}</span>
                        </div>
                      )}
                      {agent.top_k != null && (
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] text-gray-400">top_k</span>
                          <span className="text-[11px] font-mono font-semibold text-blue-600 dark:text-blue-400">{agent.top_k}</span>
                        </div>
                      )}
                      {agent.system_prompt_override && (
                        <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 rounded-md border border-amber-200 dark:border-amber-800">
                          prompt override
                        </span>
                      )}
                      <div className="flex items-center gap-1.5 ml-auto">
                        {agent.tools.length > 0 && (
                          <span className="text-[10px] font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 px-1.5 py-0.5 rounded-md border border-green-200 dark:border-green-800">
                            {agent.tools.length} tool{agent.tools.length > 1 ? "s" : ""}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-300 dark:text-gray-700 font-mono">{agent.file.split("/").pop()}</span>
                      </div>
                    </div>

                    {/* Expandable details */}
                    {isExpanded && <AgentDetails agent={agent} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : tab === "jobs" ? (
        /* ── Jobs Tab ── */
        <div className="space-y-3">
          {triggerResult && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span><strong>{triggerResult.job}</strong> queued — task ID: <span className="font-mono text-xs">{triggerResult.task_id}</span></span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <select value={jobModuleFilter} onChange={e => setJobModuleFilter(e.target.value)}
              className="text-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none text-gray-700 dark:text-gray-300">
              <option value="">All modules</option>
              {jobModules.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <span className="text-xs text-gray-400">{shownJobs.length} jobs</span>
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="grid px-4 py-2.5 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700 text-[11px] font-semibold text-gray-400 uppercase tracking-wider"
              style={{ gridTemplateColumns: "1fr 120px 200px 100px 100px" }}>
              <span>Job</span>
              <span>Module</span>
              <span>Schedule</span>
              <span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            {shownJobs.map(job => (
              <div key={job.job_name}
                className="grid px-4 py-3 items-center border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50/50 dark:hover:bg-gray-800/20 transition-colors"
                style={{ gridTemplateColumns: "1fr 120px 200px 100px 100px" }}>
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{job.job_name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs mt-0.5">{job.description}</p>
                  {job.has_override && <span className="text-[10px] text-blue-500 dark:text-blue-400">• overridden</span>}
                </div>
                <div>
                  <span className={`inline-flex text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${moduleColor(job.module)}`}>{job.module}</span>
                </div>
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 font-medium">{job.schedule_display}</p>
                  <p className="text-[11px] text-gray-400 font-mono">{job.cron_minute} {job.cron_hour} * * {job.cron_day_of_week}</p>
                </div>
                <div>
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded ${
                    job.enabled
                      ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
                      : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${job.enabled ? "bg-green-500" : "bg-gray-400"}`} />
                    {job.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <button onClick={() => triggerJob(job.job_name)} disabled={triggering === job.job_name}
                    className="p-1.5 text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 rounded-lg transition-all"
                    title="Trigger now">
                    {triggering === job.job_name
                      ? <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
                      : <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" /></svg>
                    }
                  </button>
                  <button onClick={() => setEditJob(job)}
                    className="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg transition-all"
                    title="Edit schedule">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : tab === "prompts" ? (
        /* ── Pipeline Prompts Tab ── */
        <div className="space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            These prompts are used internally by data pipeline agents (composition research, TEA, etc.).
            Overrides are applied globally — they affect all substrates.
          </p>
          {promptsLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : prompts.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex items-center justify-center py-16">
              <p className="text-sm text-gray-400">No pipeline prompts registered yet.</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {prompts.map((p, i) => (
                <div key={`${p.agent_module}/${p.prompt_key}`}
                  className={`px-4 py-4 ${i < prompts.length - 1 ? "border-b border-gray-100 dark:border-gray-800" : ""}`}>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{p.prompt_key}</span>
                        {p.is_overridden && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                            overridden
                          </span>
                        )}
                        {p.variables.length > 0 && (
                          <span className="text-[10px] text-gray-400 font-mono">{`{${p.variables.join("}, {")}}`}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 font-mono">{p.agent_module}</p>
                      {p.description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{p.description}</p>}
                      {p.is_overridden && p.updated_at && (
                        <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                          Overridden {fmtDt(p.updated_at)}{p.created_by ? ` by ${p.created_by}` : ""}
                          {p.override_description ? ` — ${p.override_description}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {p.is_overridden && (
                        <button onClick={() => deletePromptOverride(p)}
                          className="px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors border border-red-200 dark:border-red-800">
                          Reset to default
                        </button>
                      )}
                      <button onClick={() => openPromptEdit(p)}
                        className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors">
                        {p.is_overridden ? "Edit override" : "Add override"}
                      </button>
                    </div>
                  </div>
                  {/* Active template preview */}
                  <div className="mb-2">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                      {p.is_overridden ? "Override template" : "Default template"}
                    </p>
                    <pre className={`text-[11px] font-mono whitespace-pre-wrap rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed ${
                      p.is_overridden
                        ? "bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200"
                        : "bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
                    }`}>
                      {(p.override_text ?? p.default_text).slice(0, 600)}{(p.override_text ?? p.default_text).length > 600 ? "\n…" : ""}
                    </pre>
                  </div>
                  {/* Last rendered call */}
                  {p.last_rendered_text ? (
                    <div>
                      <button
                        onClick={() => {
                          const key = `${p.agent_module}/${p.prompt_key}`;
                          setPromptRenderedExpanded(prev => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            return next;
                          });
                        }}
                        className="flex items-center gap-1.5 text-[10px] font-semibold text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        Last sent to Claude
                        {p.last_rendered_at && <span className="font-normal text-gray-400 ml-1">— {fmtDt(p.last_rendered_at)}</span>}
                        <span className="ml-1 text-gray-400">{promptRenderedExpanded.has(`${p.agent_module}/${p.prompt_key}`) ? "▲" : "▼"}</span>
                      </button>
                      {promptRenderedExpanded.has(`${p.agent_module}/${p.prompt_key}`) && (
                        <pre className="text-[11px] font-mono whitespace-pre-wrap rounded-lg p-3 max-h-64 overflow-y-auto leading-relaxed bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-green-900 dark:text-green-200">
                          {p.last_rendered_text}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <p className="text-[10px] text-gray-400 italic">No pipeline run yet this session — run a composition analysis to see the rendered prompt.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── Usage Tab ── */
        <div className="space-y-4">
          {!usageSummary ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Last 24h", val: usageSummary.totals.cost_24h },
                  { label: "Last 7 days", val: usageSummary.totals.cost_7d },
                  { label: "Last 30 days", val: usageSummary.totals.cost_30d },
                  { label: "All time", val: usageSummary.totals.total_cost_usd },
                ].map(({ label, val }) => (
                  <div key={label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1">{fmtBig$(val)}</p>
                  </div>
                ))}
              </div>

              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Cost by Operation</h3>
                </div>
                <div className="grid px-4 py-2 bg-gray-50/50 dark:bg-gray-800/30 border-b border-gray-100 dark:border-gray-800 text-[11px] font-semibold text-gray-400 uppercase tracking-wider"
                  style={{ gridTemplateColumns: "1fr 160px 80px 100px 100px 100px" }}>
                  <span>Operation</span><span>Model</span><span>Calls</span><span>Input tok</span><span>Output tok</span><span className="text-right">Cost</span>
                </div>
                {usageSummary.by_operation.map((row, i) => (
                  <div key={i} className="grid px-4 py-2.5 items-center border-b border-gray-100 dark:border-gray-800 last:border-0 text-sm hover:bg-gray-50/30 dark:hover:bg-gray-800/20"
                    style={{ gridTemplateColumns: "1fr 160px 80px 100px 100px 100px" }}>
                    <span className="text-gray-800 dark:text-gray-200 font-medium truncate">{row.operation}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                      {(row.model ?? "").replace("claude-", "").replace("-20250514", "").replace("-20251001", "")}
                    </span>
                    <span className="text-gray-600 dark:text-gray-400">{fmtNum(row.calls)}</span>
                    <span className="text-gray-500 dark:text-gray-400 text-xs">{fmtNum(row.total_input_tokens)}</span>
                    <span className="text-gray-500 dark:text-gray-400 text-xs">{fmtNum(row.total_output_tokens)}</span>
                    <span className="text-right font-semibold text-gray-800 dark:text-gray-200">{fmtBig$(row.total_cost_usd)}</span>
                  </div>
                ))}
              </div>

              {usage && (
                <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Recent Calls</h3>
                    <span className="text-xs text-gray-400">{usage.total.toLocaleString()} total</span>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
                          {["Time", "Operation", "Model", "In", "Out", "Cost"].map(h => (
                            <th key={h} className="px-4 py-2 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {usage.rows.map(row => (
                          <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50/30 dark:hover:bg-gray-800/20">
                            <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDt(row.created_at)}</td>
                            <td className="px-4 py-2 text-gray-700 dark:text-gray-300 max-w-[200px] truncate">{row.operation}</td>
                            <td className="px-4 py-2 text-xs font-mono text-gray-500 whitespace-nowrap">
                              {(row.model ?? "").replace("claude-", "").replace("-20250514", "").replace("-20251001", "")}
                            </td>
                            <td className="px-4 py-2 text-xs text-gray-500">{fmtNum(row.input_tokens)}</td>
                            <td className="px-4 py-2 text-xs text-gray-500">{fmtNum(row.output_tokens)}</td>
                            <td className="px-4 py-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{fmt$(row.cost_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Edit modals */}
      {editAgent && (
        <AgentEditModal
          agent={editAgent}
          onSave={async (patch) => saveAgent(editAgent.agent_id, patch)}
          onReset={async () => resetAgent(editAgent.agent_id)}
          onClose={() => { setEditAgent(null); }}
        />
      )}
      {editJob && (
        <JobEditModal
          job={editJob}
          onSave={async (patch) => saveJob(editJob.job_name, patch)}
          onClose={() => setEditJob(null)}
        />
      )}

      {/* Prompt edit modal */}
      {editPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setEditPrompt(null)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{editPrompt.prompt_key}</h3>
                  {editPrompt.is_overridden && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-800">
                      override active
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 font-mono">{editPrompt.agent_module}</p>
                {editPrompt.variables.length > 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Variables: <span className="font-mono text-blue-600 dark:text-blue-400">{`{${editPrompt.variables.join("}, {")}}`}</span>
                  </p>
                )}
              </div>
              <button onClick={() => setEditPrompt(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {promptError && (
                <div className="flex items-center gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-300">
                  {promptError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                  Prompt text
                  <span className="ml-2 font-normal text-gray-400">use {`{variable_name}`} placeholders</span>
                </label>
                <AutoTextarea
                  value={promptDraft}
                  onChange={e => setPromptDraft(e.target.value)}
                  spellCheck={false}
                  rows={18}
                  className="w-full font-mono text-xs bg-gray-950 text-green-300 border border-gray-700 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-blue-500/30 resize-y"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                  Description / change note <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input
                  value={promptDescDraft}
                  onChange={e => setPromptDescDraft(e.target.value)}
                  placeholder="Why did you change this prompt?"
                  className="w-full text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                />
              </div>
              {!editPrompt.is_overridden && (
                <div className="text-xs text-gray-400 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
                  Currently using <strong>default prompt</strong>. Saving will create a global override for all runs.
                </div>
              )}
            </div>
            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 dark:border-gray-800">
              <button onClick={() => setEditPrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(promptDraft)}`}
                  download={`${editPrompt.prompt_key}.txt`}
                  className="px-3 py-2 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  Export
                </a>
                <button onClick={savePromptOverride} disabled={promptSaving || !promptDraft.trim()}
                  className="px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors">
                  {promptSaving ? "Saving…" : "Save override"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
