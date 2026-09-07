"use client";

/**
 * ExtractionDevPanel — Full pipeline transparency for the literature extraction queue.
 *
 * Shows (and lets you edit) every parameter, prompt, and decision used when
 * a paper is processed through the extraction pipeline:
 *   Article text  →  Chunker  →  Claude API (prompt + model)
 *   →  JSON parse  →  Titer validation  →  Dedup  →  Fuzzy match  →  staging_queue
 *
 * Active only in dev mode.  Renders as a fixed right-side panel (560px).
 */

import React, { useEffect, useRef, useState, useCallback } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentConfig {
  agent_id: string;
  display_name: string;
  model: string | null;
  max_tokens: number | null;
  temperature: number | null;
  top_p: number | null;
  top_k: number | null;
  base_prompt: string | null;
  override: string | null;
  effective_prompt: string | null;
  override_active: boolean;
}

interface TraceStep {
  label: string;
  elapsed_ms: number;
  data?: Record<string, unknown>;
}

interface ExtractionTrace {
  trace_id: string;
  pipeline: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  inputs: Record<string, unknown> | null;
  steps: TraceStep[];
  outputs: Record<string, unknown> | null;
  error_message: string | null;
}

type Tab = "pipeline" | "prompt" | "config" | "trace";

interface Props {
  paperId: string | null;
  paperTitle: string | null;
  open: boolean;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] font-mono text-amber-400 mb-0.5">{label}</p>
      {children}
    </div>
  );
}

function MonoVal({ value }: { value: unknown }) {
  return (
    <span className="text-[11px] font-mono text-green-400">
      {value === null || value === undefined ? (
        <span className="text-gray-500">null</span>
      ) : (
        String(value)
      )}
    </span>
  );
}

function StepBadge({ step }: { step: TraceStep }) {
  const isWarning = step.label.startsWith("WARNING");
  const [open, setOpen] = useState(false);
  return (
    <div className="font-mono text-xs bg-gray-900 rounded border border-gray-700">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start justify-between gap-2 px-3 py-1.5 text-left"
      >
        <span className={isWarning ? "text-amber-400" : "text-green-400"}>
          {step.label}
        </span>
        <span className="text-gray-500 shrink-0 text-[10px]">{step.elapsed_ms}ms</span>
      </button>
      {open && step.data && Object.keys(step.data).length > 0 && (
        <pre className="text-[10px] text-gray-400 px-3 pb-2 overflow-x-auto">
          {JSON.stringify(step.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ExtractionDevPanel({ paperId, paperTitle, open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("pipeline");

  // Agent config state
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgError, setCfgError] = useState("");
  const [cfgSuccess, setCfgSuccess] = useState("");

  // Editable config fields (mirror of cfg, pre-populated on load)
  const [editModel, setEditModel] = useState("");
  const [editMaxTokens, setEditMaxTokens] = useState("");
  const [editTemp, setEditTemp] = useState("");
  const [editTopP, setEditTopP] = useState("");

  // Prompt editing
  const [promptEdit, setPromptEdit] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptSuccess, setPromptSuccess] = useState("");

  // Trace
  const [trace, setTrace] = useState<ExtractionTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load config whenever panel opens
  useEffect(() => {
    if (!open) return;
    setCfgLoading(true);
    setCfgError("");
    fetch("/api/proxy/agent-manager/agents/paper_extraction/effective-prompt")
      .then((r) => r.json())
      .then((data: AgentConfig) => {
        setCfg(data);
        setEditModel(data.model ?? "claude-sonnet-4-6");
        setEditMaxTokens(String(data.max_tokens ?? 8192));
        setEditTemp(data.temperature != null ? String(data.temperature) : "");
        setEditTopP(data.top_p != null ? String(data.top_p) : "");
        // Show current effective prompt in editor
        setPromptEdit(data.effective_prompt ?? "");
        setPromptDirty(false);
      })
      .catch(() => setCfgError("Failed to load agent config"))
      .finally(() => setCfgLoading(false));
  }, [open]);

  // Load trace when tab switches to trace or paper changes
  useEffect(() => {
    if (!open || tab !== "trace" || !paperId) return;
    setTraceLoading(true);
    fetch(`/api/proxy/dev/traces?pipeline=extraction&limit=5`)
      .then((r) => r.json())
      .then((list: ExtractionTrace[]) => {
        // Find trace for this paper_id
        const match =
          list.find((t) => {
            const inp = t.inputs as Record<string, unknown> | null;
            return inp?.paper_id === paperId || inp?.doi === paperId;
          }) ?? list[0] ?? null;
        setTrace(match);
      })
      .catch(() => setTrace(null))
      .finally(() => setTraceLoading(false));
  }, [open, tab, paperId]);

  // Save config fields (model, max_tokens, temp, top_p)
  const saveConfig = useCallback(async () => {
    setCfgSaving(true);
    setCfgError("");
    setCfgSuccess("");
    try {
      const body: Record<string, unknown> = {
        model: editModel || null,
        max_tokens: editMaxTokens ? parseInt(editMaxTokens, 10) : null,
        temperature: editTemp ? parseFloat(editTemp) : null,
        top_p: editTopP ? parseFloat(editTopP) : null,
      };
      const res = await fetch("/api/proxy/agent-manager/agents/paper_extraction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      setCfgSuccess("Saved");
      setTimeout(() => setCfgSuccess(""), 2000);
      // Reload config
      const updated = await fetch(
        "/api/proxy/agent-manager/agents/paper_extraction/effective-prompt"
      ).then((r) => r.json());
      setCfg(updated);
    } catch (e) {
      setCfgError(String(e));
    } finally {
      setCfgSaving(false);
    }
  }, [editModel, editMaxTokens, editTemp, editTopP]);

  // Save prompt override
  const savePrompt = useCallback(async () => {
    setPromptSaving(true);
    setPromptSuccess("");
    try {
      const res = await fetch("/api/proxy/agent-manager/agents/paper_extraction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt_override: promptEdit }),
      });
      if (!res.ok) throw new Error(await res.text());
      setPromptDirty(false);
      setPromptSuccess("Override saved — next extraction will use this prompt");
      setTimeout(() => setPromptSuccess(""), 4000);
      const updated = await fetch(
        "/api/proxy/agent-manager/agents/paper_extraction/effective-prompt"
      ).then((r) => r.json());
      setCfg(updated);
    } catch (e) {
      setCfgError(String(e));
    } finally {
      setPromptSaving(false);
    }
  }, [promptEdit]);

  // Reset prompt to base
  const resetPrompt = useCallback(async () => {
    if (!confirm("Remove prompt override? The coded default prompt will be used.")) return;
    try {
      await fetch("/api/proxy/agent-manager/agents/paper_extraction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt_override: null }),
      });
      const updated = await fetch(
        "/api/proxy/agent-manager/agents/paper_extraction/effective-prompt"
      ).then((r) => r.json());
      setCfg(updated);
      setPromptEdit(updated.base_prompt ?? "");
      setPromptDirty(false);
      setPromptSuccess("Reset to base prompt");
      setTimeout(() => setPromptSuccess(""), 3000);
    } catch (e) {
      setCfgError(String(e));
    }
  }, []);

  if (!open) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: "pipeline", label: "Pipeline" },
    { id: "prompt", label: cfg?.override_active ? "Prompt ●" : "Prompt" },
    { id: "config", label: "Config" },
    { id: "trace", label: "Trace" },
  ];

  return (
    <div className="fixed inset-y-0 right-0 w-[560px] z-50 flex flex-col bg-gray-950 border-l border-gray-700 shadow-2xl text-gray-100 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-900 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono font-semibold text-amber-400 shrink-0">
            ⚙ EXTRACTION PIPELINE
          </span>
          {paperTitle && (
            <span className="text-[10px] font-mono text-gray-400 truncate">
              {paperTitle}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-gray-400 hover:text-gray-200 text-lg leading-none px-1"
        >
          ×
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 bg-gray-900 shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              tab === t.id
                ? "text-amber-400 border-b-2 border-amber-400"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Pipeline Tab ── */}
        {tab === "pipeline" && (
          <div className="p-4 space-y-3">
            <p className="text-[10px] text-gray-400">
              Full flow for every paper processed through the extraction pipeline.
            </p>

            {cfgLoading && <p className="text-[10px] text-gray-500">Loading…</p>}

            {/* Flow steps */}
            {[
              {
                step: "1",
                label: "Article Ingested",
                color: "border-blue-700",
                accent: "text-blue-400",
                detail: paperTitle
                  ? `"${paperTitle.slice(0, 80)}${paperTitle.length > 80 ? "…" : ""}"`
                  : "No paper selected",
                sub: "PDF parsed or abstract fetched → full_text stored in papers table",
              },
              {
                step: "2",
                label: "Text Chunked",
                color: "border-purple-700",
                accent: "text-purple-400",
                detail: `chunk_size = 25,000 chars  |  split at \\n\\n paragraph boundaries`,
                sub: "Non-overlapping chunks — same data point cannot be extracted twice",
              },
              {
                step: "3",
                label: "Claude API Call  (per chunk)",
                color: "border-amber-700",
                accent: "text-amber-400",
                detail: cfg
                  ? `model: ${cfg.model ?? "claude-sonnet-4-6"}  |  max_tokens: ${cfg.max_tokens ?? 8192}${cfg.temperature != null ? `  |  temp: ${cfg.temperature}` : ""}`
                  : "model: claude-sonnet-4-6  |  max_tokens: 8192",
                sub: cfg?.override_active
                  ? "⚠ Prompt override is active — see Prompt tab"
                  : "Using default extraction prompt — see Prompt tab",
              },
              {
                step: "4",
                label: "JSON Parse + Titer Validation",
                color: "border-yellow-700",
                accent: "text-yellow-400",
                detail: "Strips markdown fences, parses array.  Hard-rejects titer_value not found in evidence_quote (within 25%).",
                sub: "confidence penalty applied for citation issues via citation_validator.py",
              },
              {
                step: "5",
                label: "Deduplication (across chunks)",
                color: "border-green-700",
                accent: "text-green-400",
                detail: "Key: (data_type, enzyme_class, strain_name[:30], substrate[:30], fermentation_type, moisture_pct)",
                sub: "Prefers record WITH titer_value when two records share a key",
              },
              {
                step: "6",
                label: "Fuzzy Matching",
                color: "border-teal-700",
                accent: "text-teal-400",
                detail: "EntityMatcher loads all strains + substrates from DB at runtime (no hardcoding)",
                sub: "Tiers: exact → DB accession synonym → rapidfuzz token_sort_ratio ≥ 80 → species-level fallback",
              },
              {
                step: "7",
                label: "Staged to Queue",
                color: "border-gray-600",
                accent: "text-gray-300",
                detail: "INSERT INTO staging_queue with review_status = 'pending'",
                sub: "Approve → fermentation_runs (training set)  or  species_level_observations (prior library)\nscreening_comparison / protocol → approved_in_place (reference data)",
              },
            ].map(({ step, label, color, accent, detail, sub }) => (
              <div
                key={step}
                className={`rounded border ${color} bg-gray-900 px-3 py-2.5`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono font-bold ${accent} shrink-0`}>
                    [{step}]
                  </span>
                  <span className={`text-xs font-semibold ${accent}`}>{label}</span>
                </div>
                <p className="text-[11px] text-gray-300 mt-1 font-mono">{detail}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>
              </div>
            ))}

            {/* Routing decision table */}
            <div>
              <p className="text-[10px] font-mono text-amber-400 mb-1">Approval Routing Logic</p>
              <table className="w-full text-[10px] font-mono border-collapse">
                <thead>
                  <tr className="text-gray-400">
                    <th className="text-left pb-1 pr-3">Condition</th>
                    <th className="text-left pb-1">Destination</th>
                  </tr>
                </thead>
                <tbody className="space-y-1">
                  {[
                    ["data_type = screening_comparison OR protocol", "approved_in_place (reference)"],
                    ["no titer_value", "BLOCKED"],
                    ["strain_specificity = species_level", "species_level_observations"],
                    ["strain unmatched", "species_level_observations"],
                    ["substrate unmatched", "species_level_observations"],
                    ["cazyme_count > 0  OR  has genome source", "fermentation_runs (ML training)"],
                    ["else", "species_level_observations"],
                  ].map(([cond, dest]) => (
                    <tr key={cond} className="border-t border-gray-800">
                      <td className="py-1 pr-3 text-gray-300">{cond}</td>
                      <td className={`py-1 ${dest.includes("BLOCKED") ? "text-red-400" : dest.includes("training") ? "text-green-400" : "text-blue-400"}`}>
                        {dest}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Prompt Tab ── */}
        {tab === "prompt" && (
          <div className="p-4 space-y-3 h-full flex flex-col">
            {cfgLoading && <p className="text-[10px] text-gray-500">Loading…</p>}

            {cfg && (
              <>
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {cfg.override_active ? (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-amber-900 text-amber-300 font-mono font-semibold">
                      ● OVERRIDE ACTIVE
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 font-mono">
                      BASE PROMPT (no override)
                    </span>
                  )}
                  <span className="text-[10px] text-gray-500 font-mono">
                    {promptEdit.length} chars
                  </span>
                  {promptDirty && (
                    <span className="text-[10px] text-amber-400 font-mono">unsaved changes</span>
                  )}
                </div>

                <p className="text-[10px] text-gray-400 shrink-0">
                  This is the system prompt sent to Claude for every paper extraction.
                  Edits here save as an override — the base prompt is preserved and
                  can be restored with Reset.
                </p>

                <AutoTextarea
                  autoGrow={false}  /* prompt editor, flex-1 min-h-[300px] */
                  value={promptEdit}
                  onChange={(e) => {
                    setPromptEdit(e.target.value);
                    setPromptDirty(true);
                  }}
                  className="flex-1 min-h-[300px] font-mono text-[11px] bg-gray-900 border border-gray-600 rounded p-2 text-gray-200 focus:outline-none focus:border-amber-500 resize-none w-full"
                  spellCheck={false}
                />

                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    onClick={savePrompt}
                    disabled={promptSaving || !promptDirty}
                    className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded text-white font-medium"
                  >
                    {promptSaving ? "Saving…" : "Save Override"}
                  </button>
                  {cfg.override_active && (
                    <button
                      onClick={resetPrompt}
                      className="px-3 py-1.5 text-xs border border-gray-600 hover:border-gray-400 rounded text-gray-300 font-medium"
                    >
                      Reset to base
                    </button>
                  )}
                  {promptSuccess && (
                    <span className="text-[11px] text-green-400">{promptSuccess}</span>
                  )}
                  {cfgError && (
                    <span className="text-[11px] text-red-400">{cfgError}</span>
                  )}
                </div>

                {/* Show diff indicator if override is active */}
                {cfg.override_active && cfg.base_prompt && (
                  <details className="shrink-0">
                    <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
                      View base prompt (read-only)
                    </summary>
                    <pre className="mt-2 text-[10px] font-mono bg-gray-900 border border-gray-700 rounded p-2 overflow-x-auto max-h-48 text-gray-400 whitespace-pre-wrap">
                      {cfg.base_prompt}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Config Tab ── */}
        {tab === "config" && (
          <div className="p-4 space-y-4">
            {cfgLoading && <p className="text-[10px] text-gray-500">Loading…</p>}

            {cfg && (
              <>
                <p className="text-[10px] text-gray-400">
                  Model and sampling parameters for the Paper Data Extractor agent.
                  Changes take effect on the next extraction run.
                </p>

                <Field label="model">
                  <select
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
                    className="w-full font-mono text-[11px] bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500"
                  >
                    {MODELS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </Field>

                <Field label="max_tokens">
                  <input
                    type="number"
                    value={editMaxTokens}
                    onChange={(e) => setEditMaxTokens(e.target.value)}
                    className="w-full font-mono text-[11px] bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500"
                    placeholder="8192"
                    min={256}
                    max={200000}
                  />
                </Field>

                <Field label="temperature  (null = API default)">
                  <input
                    type="number"
                    value={editTemp}
                    onChange={(e) => setEditTemp(e.target.value)}
                    className="w-full font-mono text-[11px] bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500"
                    placeholder="null (API default)"
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </Field>

                <Field label="top_p  (null = API default)">
                  <input
                    type="number"
                    value={editTopP}
                    onChange={(e) => setEditTopP(e.target.value)}
                    className="w-full font-mono text-[11px] bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500"
                    placeholder="null (API default)"
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </Field>

                <div className="flex items-center gap-2">
                  <button
                    onClick={saveConfig}
                    disabled={cfgSaving}
                    className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded text-white font-medium"
                  >
                    {cfgSaving ? "Saving…" : "Save Config"}
                  </button>
                  {cfgSuccess && (
                    <span className="text-[11px] text-green-400">{cfgSuccess}</span>
                  )}
                  {cfgError && (
                    <span className="text-[11px] text-red-400">{cfgError}</span>
                  )}
                </div>

                {/* Full config dump */}
                <details>
                  <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
                    Full current config (JSON)
                  </summary>
                  <pre className="mt-2 text-[10px] font-mono bg-gray-900 border border-gray-700 rounded p-2 overflow-x-auto text-gray-400">
                    {JSON.stringify(
                      {
                        agent_id: cfg.agent_id,
                        display_name: cfg.display_name,
                        model: cfg.model,
                        max_tokens: cfg.max_tokens,
                        temperature: cfg.temperature,
                        top_p: cfg.top_p,
                        top_k: cfg.top_k,
                        override_active: cfg.override_active,
                        prompt_chars: cfg.effective_prompt?.length ?? 0,
                      },
                      null,
                      2
                    )}
                  </pre>
                </details>

                {/* Extraction rules (from pipeline logic) */}
                <div>
                  <p className="text-[10px] font-mono text-amber-400 mb-1">
                    Post-extraction Validation (hardcoded, not prompt-controlled)
                  </p>
                  {[
                    "Titer value must appear numerically in evidence_quote (within 25% tolerance) — otherwise nulled",
                    "Dedup key = (data_type, enzyme_class, strain[:30], substrate[:30], fermentation_type, moisture_pct)",
                    "Prefers record with real titer over null-titer duplicate across chunks",
                    "fermentation_run requires explicit numeric titer in text (not figures/graphs)",
                  ].map((rule, i) => (
                    <div
                      key={i}
                      className="text-[10px] font-mono text-gray-400 bg-gray-900 border border-gray-700 rounded px-2 py-1 mb-1"
                    >
                      <span className="text-gray-600">{i + 1}. </span>
                      {rule}
                    </div>
                  ))}
                </div>

                {/* Fuzzy matching config */}
                <div>
                  <p className="text-[10px] font-mono text-amber-400 mb-1">
                    Fuzzy Matching Config  (fuzzy_matcher.py)
                  </p>
                  {[
                    ["FUZZY_THRESHOLD", "80.0 / 100", "Minimum token_sort_ratio to accept a match"],
                    ["Strain source", "DB: strains table (name, ncbi_accession, atcc_catalog_number, lab_stock_id)", "Loaded live at match time — no hardcoding"],
                    ["Substrate source", "DB: substrates table (name)", "All substrate rows loaded live"],
                    ["Species-level detection", "strain_specificity = 'species_level' in DB", "Routes to biological prior library, not ML training set"],
                  ].map(([key, val, note]) => (
                    <div
                      key={String(key)}
                      className="font-mono text-[10px] bg-gray-900 rounded px-2 py-1 border border-gray-700 mb-1"
                    >
                      <span className="text-yellow-400">{key}</span>
                      <span className="text-gray-400"> = </span>
                      <span className="text-green-400">{val}</span>
                      {note && <div className="text-gray-500 mt-0.5">{note}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Trace Tab ── */}
        {tab === "trace" && (
          <div className="p-4 space-y-3">
            {traceLoading && <p className="text-[10px] text-gray-500">Loading trace…</p>}
            {!traceLoading && !trace && (
              <p className="text-[10px] text-gray-500 italic">
                No extraction trace found.{" "}
                {paperId
                  ? "Trigger re-extraction via the queue page to generate a trace."
                  : "Select a paper in the queue to see its trace."}
              </p>
            )}
            {trace && (
              <>
                <div className="font-mono text-[10px] space-y-1 bg-gray-900 rounded p-3 border border-gray-700">
                  <div>
                    <span className="text-gray-400">trace_id: </span>
                    <span className="text-blue-400">{trace.trace_id}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">status: </span>
                    <span
                      className={
                        trace.status === "success"
                          ? "text-green-400"
                          : trace.status === "error"
                          ? "text-red-400"
                          : "text-amber-400"
                      }
                    >
                      {trace.status}
                    </span>
                  </div>
                  {trace.duration_ms != null && (
                    <div>
                      <span className="text-gray-400">duration: </span>
                      <span>{trace.duration_ms}ms</span>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-400">started: </span>
                    <span>{new Date(trace.started_at).toLocaleString()}</span>
                  </div>
                </div>

                {/* Inputs */}
                {trace.inputs && (
                  <details open>
                    <summary className="text-[10px] font-mono text-amber-400 cursor-pointer">
                      Inputs (what was passed to Claude)
                    </summary>
                    <div className="mt-1 space-y-1">
                      {Object.entries(trace.inputs).map(([k, v]) => (
                        <div
                          key={k}
                          className="font-mono text-[10px] bg-gray-900 rounded px-2 py-1 border border-gray-700"
                        >
                          <span className="text-yellow-400">{k}</span>
                          <span className="text-gray-400">: </span>
                          {k === "prompt_preview" ? (
                            <span className="text-gray-300 whitespace-pre-wrap break-words">
                              {String(v)}
                            </span>
                          ) : (
                            <MonoVal value={v} />
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Steps */}
                {trace.steps.length > 0 && (
                  <div>
                    <p className="text-[10px] font-mono text-amber-400 mb-1">
                      Execution Steps
                    </p>
                    <div className="space-y-1">
                      {trace.steps.map((s, i) => (
                        <StepBadge key={i} step={s} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Outputs */}
                {trace.outputs && (
                  <details>
                    <summary className="text-[10px] font-mono text-amber-400 cursor-pointer">
                      Outputs ({(trace.outputs as Record<string, unknown>).record_count ?? "?"} records)
                    </summary>
                    <pre className="mt-1 text-[10px] font-mono bg-gray-900 rounded p-2 border border-gray-700 overflow-x-auto max-h-64 text-gray-400">
                      {JSON.stringify(trace.outputs, null, 2)}
                    </pre>
                  </details>
                )}

                {/* Error */}
                {trace.error_message && (
                  <div className="rounded border border-red-700 bg-red-950 px-3 py-2">
                    <p className="text-[10px] font-semibold text-red-400 mb-1">Error</p>
                    <pre className="text-[10px] font-mono text-red-300 whitespace-pre-wrap">
                      {trace.error_message}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
