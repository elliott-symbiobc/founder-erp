'use client'

import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import Link from 'next/link'

const VW = 1000
const VH = 840
const NW = 140
const NH = 44

const lc = (lane: number) => (lane - 1) * 200 + 100

const LANE_DEFS = [
  { label: 'Inputs',             bg: '#EFF6FF', header: '#1D4ED8', border: '#93C5FD' },
  { label: 'Data Processing',    bg: '#F0F9FF', header: '#0369A1', border: '#7DD3FC' },
  { label: 'Intelligence Layer', bg: '#FAF5FF', header: '#7C3AED', border: '#C4B5FD' },
  { label: 'Human Review',       bg: '#FFFBEB', header: '#B45309', border: '#FCD34D' },
  { label: 'Outputs',            bg: '#F0FDF4', header: '#15803D', border: '#86EFAC' },
]

interface NodeDef {
  id: string
  lines: string[]
  lane: number
  y: number
  tooltip: string
  detail: string
  kb?: string
  kbLabel?: string
}

interface EdgeDef {
  id: string
  source: string
  target: string
  dashed?: boolean
}

interface Transform { x: number; y: number; scale: number }

const NODES: NodeDef[] = [
  // Lane 1 — Inputs
  {
    id: 'waste-stream', lines: ['Partner', 'Waste Stream'], lane: 1, y: 105,
    tooltip: 'Substrate composition entered by Elliott — triggers clustering and TEA automatically.',
    detail: 'Elliott adds new substrates via the Substrates page, entering composition data such as cellulose, hemicellulose, lignin, and tannin load. The system immediately builds a 12-dimensional feature vector and triggers TEA screening and ML compatibility scoring within minutes.',
  },
  {
    id: 'literature', lines: ['Published', 'Literature'], lane: 1, y: 250,
    tooltip: 'Weekly sweep via OpenAlex and Semantic Scholar finds new Aspergillus SSF papers.',
    detail: 'Every Monday at 02:00, the literature agent queries OpenAlex and Semantic Scholar for papers published in the past 7 days. Papers with accessible full text are sent to Claude for structured data extraction. This is how the model learns from published science without manual data entry.',
    kb: '/kb/agent-layer', kbLabel: 'Literature Agent',
  },
  {
    id: 'genome', lines: ['Genome', 'Sequences'], lane: 1, y: 395,
    tooltip: 'NCBI and JGI genome downloads feed the CAZyme annotation pipeline.',
    detail: 'Genome sequences are downloaded from NCBI or JGI and processed by the dbCAN2 annotation pipeline. The resulting CAZyme family counts form 12 of the 25 ML model features. Adding a new strain with an NCBI accession triggers automatic genome download and annotation.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'ext-db', lines: ['External', 'Databases'], lane: 1, y: 540,
    tooltip: 'BRENDA enzyme kinetics, ChEBI compound chemistry, LOTUS natural products.',
    detail: 'External databases provide reference data for two agent modules. The Compound Discovery Engine cross-references LOTUS (natural products observed in related fungi) and ChEBI (compound chemistry and market value). The Regulatory Agent queries the EU Novel Food Catalogue and eCFR for approval status.',
    kb: '/kb/compound-discovery', kbLabel: 'Compound Discovery',
  },

  // Lane 2 — Data Processing
  {
    id: 'clustering', lines: ['Substrate', 'Clustering'], lane: 2, y: 105,
    tooltip: 'PCA + Ward hierarchical clustering assigns substrates to one of six biochemical classes.',
    detail: 'Substrate composition vectors are projected into principal component space and clustered using Ward hierarchical clustering. The resulting cluster ID is added as a categorical feature to the ML model, capturing substrate-class-level effects not explained by individual composition features alone.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'cazyme', lines: ['CAZyme', 'Annotation'], lane: 2, y: 250,
    tooltip: 'dbCAN2 annotates carbohydrate-active enzyme families from genome sequences.',
    detail: 'The dbCAN2 pipeline annotates all carbohydrate-active enzyme genes in an Aspergillus genome. Family counts (GH13, GH10/11, AA9, CE1, and others) are extracted as strain feature vectors — the primary biological signal the model uses to predict fermentation performance.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'lit-extract', lines: ['Literature', 'Extraction'], lane: 2, y: 395,
    tooltip: 'Claude API reads full paper text and extracts strain × substrate × titer triples as structured JSON.',
    detail: 'Claude reads paper text up to 8,000 characters and returns structured JSON: strain name, substrate, enzyme titer, titer unit, fermentation conditions, and an evidence quote — the exact sentence the data was extracted from. The evidence quote is the primary quality check in the review queue.',
    kb: '/kb/agent-layer', kbLabel: 'Literature Agent',
  },
  {
    id: 'fuzzy', lines: ['Fuzzy Entity', 'Matching'], lane: 2, y: 540,
    tooltip: 'rapidfuzz resolves raw strain and substrate names from papers to canonical registry entries.',
    detail: 'Strain and substrate names in the literature are inconsistent — the same strain appears under multiple aliases across different papers. The fuzzy matcher uses rapidfuzz string similarity to resolve aliases to canonical registry entries. Matches below 80% confidence are flagged for human review.',
    kb: '/kb/agent-layer', kbLabel: 'Literature Agent',
  },

  // Lane 3 — Intelligence Layer
  {
    id: 'tea', lines: ['TEA Module'], lane: 3, y: 90,
    tooltip: 'BioSTEAM simulates a minimal biorefinery and computes MPSP, NPV, and GO/HOLD/REDIRECT for each candidate output.',
    detail: 'The TEA module uses BioSTEAM to simulate process economics at pilot scale (10 kg/hr feedstock). It computes Minimum Product Selling Price (MPSP) — the floor price for 15% IRR — and compares it to current market prices. The GO/HOLD/REDIRECT recommendation determines whether fermentation work is commercially justified.',
    kb: '/kb/tea-module', kbLabel: 'TEA Module',
  },
  {
    id: 'ml', lines: ['ML Compatibility', 'Scoring'], lane: 3, y: 215,
    tooltip: 'XGBoost predicts enzyme titer for every strain × substrate pair with SHAP explanations and conformal uncertainty intervals.',
    detail: 'The ML model uses 25 features to predict a compatibility score (0–1) for every strain × substrate pair. In Phase 0 (fewer than 30 runs), a linear scoring matrix is used. At 30+ runs, XGBoost takes over with SHAP explanations and MAPIE 90% conformal prediction intervals.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'compound-engine', lines: ['Compound Discovery', 'Engine'], lane: 3, y: 340,
    tooltip: 'Scans strain enzyme profiles against LOTUS and ChEBI to surface high-value compounds not yet in the target list.',
    detail: 'The compound discovery engine runs in three modes: Enzymatic Potential (genome-based mapping), Dark Chemistry (high-value minor substrate fractions), and Literature Gaps (white-space routes with no published Aspergillus precedent). Opportunities with confidence above 0.55 appear in the review queue.',
    kb: '/kb/compound-discovery', kbLabel: 'Compound Discovery',
  },
  {
    id: 'reg-agent', lines: ['Regulatory', 'Agent'], lane: 3, y: 465,
    tooltip: 'Checks FDA GRAS, eCFR, and EU Novel Food Catalogue. Adjusts NPV for regulatory timeline and compliance cost.',
    detail: 'The regulatory agent determines the applicable approval pathway and computes a regulatory-adjusted NPV by discounting base NPV for the approval timeline and subtracting compliance cost. CRISPR-edited organisms trigger additional flags. EU Novel Food authorisation can reduce adjusted NPV by 50% or more.',
    kb: '/kb/regulatory', kbLabel: 'Regulatory Agent',
  },
  {
    id: 'rnd', lines: ['R&D Estimator'], lane: 3, y: 590,
    tooltip: 'Four-phase Monte Carlo model estimating time-to-revenue and capital requirements with P10/P50/P90 ranges.',
    detail: 'The R&D estimator runs 10,000 Monte Carlo scenarios across four phases: Proof of Concept, Titer Optimisation, Process Development, and Regulatory & Market Entry. Phase 2 duration adjusts based on ML model maturity — a more trained model recommends better experiments and shortens optimisation timelines.',
    kb: '/kb/rnd-estimator', kbLabel: 'R&D Estimator',
  },
  {
    id: 'edit-prioritizer', lines: ['Edit', 'Prioritizer'], lane: 3, y: 715,
    tooltip: 'SHAP-guided CRISPR target prioritisation: maps limiting features to edit types, designs sgRNAs, estimates delta-titer.',
    detail: 'After the ML model scores a strain × substrate pair, the Edit Prioritizer identifies features with negative SHAP contributions (limiting factors). Each limiter is mapped to a concrete genetic edit — knockout, overexpression, upregulation, partial deletion, or promoter swap — with a priority score of |SHAP value| × feasibility. Where genome files are available, candidate sgRNA sequences and HDR arms are computed using Biopython.',
    kb: '/kb/genome-editing', kbLabel: 'Genome Edit Design',
  },

  // Lane 4 — Human Review
  {
    id: 'tea-review', lines: ['TEA Review'], lane: 4, y: 105,
    tooltip: 'Elliott reviews GO/HOLD/REDIRECT recommendations before committing fermentation resources.',
    detail: 'Elliott reviews TEA outputs for each candidate substrate and output combination. A GO decision triggers strain scoring and experiment selection; HOLD means viable but not priority; REDIRECT means no commercial case at current market prices. This is the primary resource allocation gate.',
    kb: '/kb/tea-module', kbLabel: 'TEA Module',
  },
  {
    id: 'queue-review', lines: ['Queue Review'], lane: 4, y: 250,
    tooltip: 'Elliott or Omar reviews extracted literature data points before they enter the training set.',
    detail: 'Every paper extraction lands in the queue as pending. Reviewers verify the evidence quote against the source, check strain and substrate match confidence, confirm titer units, and flag issues such as preprint source or single replicates. Approved items enter the training set immediately.',
    kb: '/kb/agent-layer', kbLabel: 'Literature Agent',
  },
  {
    id: 'compound-review', lines: ['Compound Opp.', 'Review'], lane: 4, y: 395,
    tooltip: 'Elliott approves or rejects discovered compound targets, triggering regulatory pre-screen.',
    detail: 'Compound opportunities appear in the review queue after the discovery engine runs. Elliott checks the discovery mode, the Claude rationale, and the novelty flag and confidence score. Approval triggers automatic TEA screening and regulatory pre-screen; the compound enters the substrate report if it passes.',
    kb: '/kb/compound-discovery', kbLabel: 'Compound Discovery',
  },
  {
    id: 'exp-select', lines: ['Experiment', 'Selection'], lane: 4, y: 540,
    tooltip: 'Active learning acquisition function ranks untested pairs by expected information gain × TEA viability.',
    detail: 'The dashboard Recommended Experiments list uses an Expected Improvement acquisition function balancing predicted score, model uncertainty, and TEA commercial viability. High-uncertainty, high-potential pairs are ranked first because running them teaches the model the most per experiment.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },

  // Lane 5 — Outputs
  {
    id: 'run', lines: ['Fermentation', 'Run (Omar)'], lane: 5, y: 90,
    tooltip: 'Omar executes the selected experiment and logs titer, biomass yield, and conditions.',
    detail: 'Omar executes the recommended fermentation and logs: enzyme titer (U/mL), fermentation type (SSF or SmF), temperature, pH, duration, and notes. The run enters the training set immediately and TEA figures for that substrate update to use measured titers after the next nightly retrain.',
    kb: '/kb/logging-runs', kbLabel: 'Logging Runs',
  },
  {
    id: 'tea-report', lines: ['TEA Report', '(DOCX)'], lane: 5, y: 215,
    tooltip: 'Partner-ready DOCX with MPSP, market comparison, sensitivity analysis, and GO/HOLD/REDIRECT.',
    detail: 'The TEA Report is a partner-ready Word document including MPSP, market price comparison, NPV, GO/HOLD/REDIRECT recommendation, and sensitivity analysis across titer, yield, substrate cost, and operating days. Elliott generates one per substrate per partner engagement.',
    kb: '/kb/tea-module', kbLabel: 'TEA Module',
  },
  {
    id: 'comm-report', lines: ['Commercialization', 'Report (DOCX)'], lane: 5, y: 340,
    tooltip: 'Full DOCX combining TEA economics, regulatory pathway, and R&D timeline with capital requirements.',
    detail: 'The Commercialization Report is the full commercial intelligence package: TEA economics, regulatory-adjusted NPV and pathway recommendation, and R&D timeline with P10/P50/P90 capital requirements. This is the document used for partner and investor conversations.',
    kb: '/kb/tea-module', kbLabel: 'TEA Module',
  },
  {
    id: 'species-obs', lines: ['Species-Level', 'Observations'], lane: 5, y: 395,
    tooltip: 'Species-level or unmatched literature data — routed here instead of the training set.',
    detail: 'When a queue item is approved but the strain is only identified at species level, is unmatched, or lacks CAZyme annotation, it is routed to the species_level_observations table. These records calibrate TEA titer defaults for that enzyme class and organism. They do not count toward the 30-run XGBoost threshold. Species-level observations can be upgraded to training runs from the Model Health page once the strain is registered and annotated.',
    kb: '/kb/data-quality', kbLabel: 'Data Quality',
  },
  {
    id: 'retrain', lines: ['Model', 'Retraining'], lane: 5, y: 520,
    tooltip: 'Nightly cron retrains XGBoost on all approved fermentation data. Triggers at 30+ strain-specific rows.',
    detail: 'Every night at 03:00, if the training set has 30 or more approved strain-specific rows, XGBoost retrains on all data — lab runs and approved literature extractions. TEA figures update to use measured titers. The model version number increments after each successful retrain.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'active-loop', lines: ['Active Learning', 'Loop'], lane: 5, y: 645,
    tooltip: 'Expected Improvement acquisition function selects the next experiment to maximize information gain.',
    detail: 'After each retrain, the active learning module recomputes Expected Improvement scores for all untested strain × substrate pairs. EI balances predicted score, model uncertainty, and TEA viability. The top 5 pairs appear on the dashboard as Recommended Experiments for the next lab cycle.',
    kb: '/kb/ml-pipeline', kbLabel: 'ML Pipeline',
  },
  {
    id: 'sop-gen', lines: ['SOP Generator', '(DOCX)'], lane: 5, y: 775,
    tooltip: 'Claude API generates a complete CRISPR SOP from the edit package — protoplast prep, RNP assembly, transformation, and PCR verification.',
    detail: 'When triggered from the Genome Edits page, the SOP Generator calls Claude claude-opus-4-6 with the full edit package (sgRNA sequences, HDR arms, edit types, strain and substrate context). Claude returns a structured JSON protocol which python-docx formats into a Word document covering 10 sections: reagent prep, sgRNA synthesis, Cas9 preparation, protoplast preparation, RNP assembly, transformation, selection, PCR verification, off-target assessment, and documentation.',
    kb: '/kb/genome-editing', kbLabel: 'Genome Edit Design',
  },
]

const EDGES: EdgeDef[] = [
  { id: 'e1',  source: 'waste-stream',    target: 'clustering' },
  { id: 'e2',  source: 'clustering',      target: 'tea' },
  { id: 'e3',  source: 'clustering',      target: 'ml' },
  { id: 'e4',  source: 'cazyme',          target: 'ml' },
  { id: 'e5',  source: 'lit-extract',     target: 'fuzzy' },
  { id: 'e6',  source: 'fuzzy',           target: 'queue-review' },
  { id: 'e7',  source: 'queue-review',    target: 'retrain' },
  { id: 'e8',  source: 'genome',          target: 'cazyme' },
  { id: 'e9',  source: 'ext-db',          target: 'compound-engine' },
  { id: 'e10', source: 'ext-db',          target: 'reg-agent' },
  { id: 'e11', source: 'tea',             target: 'tea-review' },
  { id: 'e12', source: 'ml',              target: 'exp-select' },
  { id: 'e13', source: 'compound-engine', target: 'compound-review' },
  { id: 'e14', source: 'compound-review', target: 'reg-agent' },
  { id: 'e15', source: 'reg-agent',       target: 'tea-review' },
  { id: 'e16', source: 'rnd',             target: 'comm-report' },
  { id: 'e17', source: 'tea-review',      target: 'tea-report' },
  { id: 'e18', source: 'tea-review',      target: 'comm-report' },
  { id: 'e19', source: 'exp-select',      target: 'run' },
  { id: 'e20', source: 'run',             target: 'retrain' },
  { id: 'e21', source: 'retrain',         target: 'active-loop' },
  { id: 'e22', source: 'active-loop',     target: 'exp-select', dashed: true },
  { id: 'e23', source: 'tea',             target: 'rnd' },
  { id: 'e24', source: 'literature',      target: 'lit-extract' },
  { id: 'e25', source: 'ml',              target: 'edit-prioritizer' },
  { id: 'e26', source: 'edit-prioritizer', target: 'sop-gen' },
  { id: 'e27', source: 'queue-review',    target: 'species-obs', dashed: true },
]

// y-offsets to separate edges that share the same node connection point
const E_OFF: Record<string, { s?: number; t?: number }> = {
  e2:  { s: -4 },
  e3:  { s: 4, t: -4 },
  e4:  { t:  4 },
  e9:  { s: -4 },
  e10: { s:  4 },
  e11: { t: -4 },
  e15: { t:  4 },
  e17: { s: -4 },
  e18: { s:  4 },
}

function getPath(e: EdgeDef, nm: Map<string, NodeDef>): string {
  const s = nm.get(e.source)!
  const t = nm.get(e.target)!
  const scx = lc(s.lane)
  const tcx = lc(t.lane)

  // Feedback loop: active-loop → exp-select (right→left, curves below both nodes)
  if (e.id === 'e22') {
    const loopY = Math.max(s.y, t.y) + 56
    return `M ${scx - NW / 2} ${s.y} C ${scx - NW / 2} ${loopY} ${tcx + NW / 2} ${loopY} ${tcx + NW / 2} ${t.y}`
  }

  // Backward lane: compound-review (L4) → reg-agent (L3)
  if (e.id === 'e14') {
    const sx = scx - NW / 2
    const tx = tcx + NW / 2
    const mid = (sx + tx) / 2
    return `M ${sx} ${s.y} C ${mid} ${s.y} ${mid} ${t.y} ${tx} ${t.y}`
  }

  // Same lane, routed on left side: tea → rnd (both lane 3, large y gap)
  if (e.id === 'e23') {
    const side = scx - NW / 2 - 36
    return `M ${scx - NW / 2} ${s.y} C ${side} ${s.y} ${side} ${t.y} ${tcx - NW / 2} ${t.y}`
  }

  // Same lane, routed on left side: run → retrain (both lane 5, large y gap)
  if (e.id === 'e20') {
    const side = scx - NW / 2 - 28
    return `M ${scx - NW / 2} ${s.y} C ${side} ${s.y} ${side} ${t.y} ${tcx - NW / 2} ${t.y}`
  }

  // Same lane, vertical: lit-extract → fuzzy, retrain → active-loop
  if (e.id === 'e5' || e.id === 'e21') {
    const x = scx
    const sy = s.y + NH / 2
    const ty = t.y - NH / 2
    const mid = (sy + ty) / 2
    return `M ${x} ${sy} C ${x} ${mid} ${x} ${mid} ${x} ${ty}`
  }

  // Same lane, left-side: ml → edit-prioritizer (both lane 3)
  if (e.id === 'e25') {
    const side = scx - NW / 2 - 36
    return `M ${scx - NW / 2} ${s.y} C ${side} ${s.y} ${side} ${t.y} ${tcx - NW / 2} ${t.y}`
  }

  // Default: exit right of source, enter left of target (cubic bezier)
  const off = E_OFF[e.id] ?? {}
  const sOff = off.s ?? 0
  const tOff = off.t ?? 0
  const sx = scx + NW / 2
  const sy = s.y + sOff
  const tx = tcx - NW / 2
  const ty = t.y + tOff
  const mid = (sx + tx) / 2
  return `M ${sx} ${sy} C ${mid} ${sy} ${mid} ${ty} ${tx} ${ty}`
}

export default function SystemFlowchart() {
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 })
  const [isDragging, setIsDragging] = useState(false)

  const canvasRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const hasDraggedRef = useRef(false)
  const dragRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 })

  const nm = useMemo(() => new Map(NODES.map(n => [n.id, n])), [])
  const active = hovered ?? selected

  const { cn, ce } = useMemo<{ cn: Set<string> | null; ce: Set<string> | null }>(() => {
    if (!active) return { cn: null, ce: null }
    const cn = new Set<string>([active])
    const ce = new Set<string>()
    for (const e of EDGES) {
      if (e.source === active) { cn.add(e.target); ce.add(e.id) }
      if (e.target === active) { cn.add(e.source); ce.add(e.id) }
    }
    return { cn, ce }
  }, [active])

  const paths = useMemo(() => EDGES.map(e => ({ ...e, d: getPath(e, nm) })), [nm])
  const selNode = selected ? nm.get(selected) : null

  const fitView = useCallback(() => {
    if (!canvasRef.current) return
    const { width, height } = canvasRef.current.getBoundingClientRect()
    if (width < 10 || height < 10) return
    const scale = Math.min(width / VW, height / VH) * 0.95
    setTransform({
      x: (width - VW * scale) / 2,
      y: (height - VH * scale) / 2,
      scale,
    })
  }, [])

  useEffect(() => {
    const id = setTimeout(fitView, 60)
    return () => clearTimeout(id)
  }, [fitView])

  function zoomBy(factor: number) {
    if (!canvasRef.current) {
      setTransform(t => ({ ...t, scale: Math.min(Math.max(t.scale * factor, 0.06), 8) }))
      return
    }
    const { width, height } = canvasRef.current.getBoundingClientRect()
    const cx = width / 2
    const cy = height / 2
    setTransform(t => {
      const newScale = Math.min(Math.max(t.scale * factor, 0.06), 8)
      const ratio = newScale / t.scale
      return { x: cx - (cx - t.x) * ratio, y: cy - (cy - t.y) * ratio, scale: newScale }
    })
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    if (!canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setTransform(t => {
      const newScale = Math.min(Math.max(t.scale * factor, 0.06), 8)
      const ratio = newScale / t.scale
      return { x: mx - (mx - t.x) * ratio, y: my - (my - t.y) * ratio, scale: newScale }
    })
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    draggingRef.current = true
    hasDraggedRef.current = false
    setTransform(t => {
      dragRef.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }
      return t
    })
    setIsDragging(true)
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!draggingRef.current) return
    const dx = e.clientX - dragRef.current.x
    const dy = e.clientY - dragRef.current.y
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasDraggedRef.current = true
    setTransform(t => ({ ...t, x: dragRef.current.tx + dx, y: dragRef.current.ty + dy }))
  }

  function handleMouseUp() {
    draggingRef.current = false
    setIsDragging(false)
  }

  function handleNodeClick(id: string) {
    if (hasDraggedRef.current) return
    setSelected(s => (s === id ? null : id))
  }

  const scalePercent = Math.round(transform.scale * 100)

  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 shadow-sm bg-white dark:bg-gray-900 flex flex-col h-full">
      {/* Zoom toolbar */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm px-1.5 py-1">
        <button
          onClick={() => zoomBy(1 / 1.25)}
          className="w-6 h-6 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-base font-medium leading-none"
        >−</button>
        <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-center tabular-nums">{scalePercent}%</span>
        <button
          onClick={() => zoomBy(1.25)}
          className="w-6 h-6 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-base font-medium leading-none"
        >+</button>
        <div className="w-px h-4 bg-gray-200 dark:bg-gray-600 mx-0.5" />
        <button
          onClick={fitView}
          className="px-2 h-6 flex items-center text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded font-medium"
        >Fit</button>
      </div>

      {/* Reset selection button */}
      {active && (
        <button
          onClick={() => { setSelected(null); setHovered(null) }}
          className="absolute top-2 right-2 z-10 px-3 py-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm"
        >
          Reset
        </button>
      )}

      {/* Pan/zoom canvas */}
      <div
        ref={canvasRef}
        className="flex-1 overflow-hidden"
        style={{ cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg
          width="100%"
          height="100%"
          style={{ display: 'block' }}
        >
          <defs>
            <marker id="sf-ah-gray" markerWidth="9" markerHeight="8" refX="8" refY="4"
              orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0 0 L9 4 L0 8 Z" fill="#9CA3AF" />
            </marker>
            <marker id="sf-ah-blue" markerWidth="9" markerHeight="8" refX="8" refY="4"
              orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0 0 L9 4 L0 8 Z" fill="#3B82F6" />
            </marker>
          </defs>

          <g transform={`translate(${transform.x.toFixed(2)},${transform.y.toFixed(2)}) scale(${transform.scale.toFixed(4)})`}>
            {/* Lane backgrounds */}
            {LANE_DEFS.map((ld, i) => (
              <rect key={i} x={i * 200} y={0} width={200} height={VH} fill={ld.bg} />
            ))}

            {/* Lane dividers */}
            {[1, 2, 3, 4].map(i => (
              <line key={i} x1={i * 200} y1={0} x2={i * 200} y2={VH}
                stroke="#D1D5DB" strokeWidth="1" />
            ))}

            {/* Header underline */}
            <line x1={0} y1={44} x2={VW} y2={44} stroke="#D1D5DB" strokeWidth="1" />

            {/* Lane labels */}
            {LANE_DEFS.map((ld, i) => (
              <text key={i} x={i * 200 + 100} y={28} textAnchor="middle"
                fill={ld.header} fontSize="12.5" fontWeight="700"
                fontFamily="Arial, sans-serif">
                {ld.label}
              </text>
            ))}

            {/* Edges (drawn before nodes so nodes sit on top) */}
            {paths.map(edge => {
              const isH = ce?.has(edge.id) ?? false
              const isF = active !== null && !isH
              return (
                <path
                  key={edge.id}
                  d={edge.d}
                  fill="none"
                  stroke={isH ? '#3B82F6' : '#9CA3AF'}
                  strokeWidth={isH ? 2.5 : 1.5}
                  strokeDasharray={edge.dashed ? '6 4' : undefined}
                  opacity={isF ? 0.1 : 1}
                  markerEnd={isH ? 'url(#sf-ah-blue)' : 'url(#sf-ah-gray)'}
                />
              )
            })}

            {/* Nodes */}
            {NODES.map(node => {
              const cx = lc(node.lane)
              const cy = node.y
              const x = cx - NW / 2
              const y = cy - NH / 2
              const isH = cn?.has(node.id) ?? false
              const isF = active !== null && !isH
              const isSel = selected === node.id
              const ld = LANE_DEFS[node.lane - 1]
              const highlight = isH || isSel

              return (
                <g
                  key={node.id}
                  style={{ cursor: 'pointer' }}
                  opacity={isF ? 0.18 : 1}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => handleNodeClick(node.id)}
                >
                  <rect
                    x={x} y={y} width={NW} height={NH} rx={6}
                    fill={highlight ? '#FFFFFF' : ld.bg}
                    stroke={highlight ? '#3B82F6' : ld.border}
                    strokeWidth={highlight ? 2 : 1}
                    style={highlight ? { filter: 'drop-shadow(0 2px 8px rgba(59,130,246,0.28))' } : undefined}
                  />
                  {node.lines.length === 1 ? (
                    <text
                      x={cx} y={cy}
                      textAnchor="middle" dominantBaseline="central"
                      fontSize="11" fontFamily="Arial, sans-serif" fill="#374151"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {node.lines[0]}
                    </text>
                  ) : (
                    <text
                      textAnchor="middle" fontSize="11" fontFamily="Arial, sans-serif"
                      fill="#374151" style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      <tspan x={cx} y={cy - 7}>{node.lines[0]}</tspan>
                      <tspan x={cx} y={cy + 7}>{node.lines[1]}</tspan>
                    </text>
                  )}
                </g>
              )
            })}

            {/* Tooltip (renders above everything) */}
            {hovered && (() => {
              const node = nm.get(hovered)
              if (!node) return null
              const cx = lc(node.lane)
              const cy = node.y
              const tw = 214
              const th = 88
              let tx = cx - tw / 2
              tx = Math.max(3, Math.min(tx, VW - tw - 3))
              const aboveY = cy - NH / 2 - th - 9
              const finalY = aboveY < 48 ? cy + NH / 2 + 9 : aboveY
              return (
                <foreignObject x={tx} y={finalY} width={tw} height={th}>
                  <div
                    style={{
                      background: '#111827',
                      color: '#F3F4F6',
                      padding: '8px 11px',
                      borderRadius: '7px',
                      fontSize: '10.5px',
                      lineHeight: '1.5',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
                      pointerEvents: 'none',
                    }}
                  >
                    {node.tooltip}
                  </div>
                </foreignObject>
              )
            })()}
          </g>
        </svg>
      </div>

      {/* Detail panel — shown when a node is selected */}
      {selNode && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-snug">
              {selNode.lines.join(' ')}
            </h3>
            <button
              onClick={() => setSelected(null)}
              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm leading-none mt-0.5"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 leading-relaxed">{selNode.detail}</p>
          {selNode.kb && (
            <Link
              href={selNode.kb}
              className="inline-flex items-center mt-3 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              Learn more: {selNode.kbLabel} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
