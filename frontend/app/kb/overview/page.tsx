'use client'

import { useState, useEffect } from "react";
import { H1, H2, H3, P, Lead, Ul, Ol, Li, Tip, Concept, SimpleTable } from "../_components";
import SystemFlowchart from "@/components/kb/SystemFlowchart";

export default function OverviewPage() {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  return (
    <article>
      <H1>How the System Works</H1>
      <Lead>
        Open ERP is a computational biology platform that helps you decide which Aspergillus strain
        to ferment on which waste-stream substrate — before committing lab resources. It replaces
        gut instinct and literature guessing with a continuously-learning prediction model backed
        by real fermentation data.
      </Lead>

      <H2>System Data Flow</H2>
      {fullscreen ? (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex-1 overflow-hidden">
            <SystemFlowchart key="fs" />
          </div>
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-4 right-4 z-[60] px-3 py-1.5 bg-white border border-gray-300 rounded-md text-xs font-medium text-gray-600 hover:bg-gray-50 shadow-sm"
          >
            ✕ Exit Fullscreen
          </button>
        </div>
      ) : (
        <div className="relative h-[600px]">
          <SystemFlowchart key="normal" />
          <button
            onClick={() => setFullscreen(true)}
            className="absolute bottom-3 right-3 z-20 px-2.5 py-1 bg-white/90 backdrop-blur-sm border border-gray-200 rounded text-xs text-gray-500 hover:text-gray-700 hover:border-gray-300 shadow-sm"
            title="Fullscreen"
          >
            ⤢
          </button>
        </div>
      )}
      <P><em>Click any node to learn more. Hover to see connections. Scroll to zoom, drag to pan.</em></P>

      <H2>The Problem It Solves</H2>
      <P>
        Industrial enzyme fermentation with Aspergillus strains on agri-waste substrates involves
        hundreds of possible strain × substrate combinations. Each fermentation run takes 5–10 days
        and costs real money. Running the wrong combination first means weeks of lost time. The
        system exists to rank combinations by predicted commercial viability before any flask is
        inoculated.
      </P>
      <P>
        More specifically, the system answers three questions in sequence:
      </P>
      <Ol>
        <Li><strong>Is the output commercially viable?</strong> — Techno-economic analysis (TEA) screens every candidate output before fermentation work begins. If the market won't support the MPSP, no fermentation resources are spent.</Li>
        <Li><strong>Which strain performs best on this substrate?</strong> — The ML model scores every known strain against the substrate using CAZyme profiles and substrate composition. The top-ranked pairs become experiment candidates.</Li>
        <Li><strong>What should we run next?</strong> — Active learning selects the experiment with the highest expected information gain weighted by commercial viability. Every run you log makes the next recommendation better.</Li>
      </Ol>

      <H2>Architecture</H2>
      <div className="bg-gray-900 text-green-400 font-mono text-xs rounded-lg p-5 mb-6 leading-relaxed overflow-x-auto">
        <pre>{`
  ┌──────────────────────────────────────────────────────────────────┐
  │                        OPEN ERP PLATFORM                           │
  │                                                                  │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌─────────┐  │
  │  │  ML Pipeline │  │ Agent Layer  │  │   TEA    │  │  ELN /  │  │
  │  │              │  │              │  │  Module  │  │  Notes  │  │
  │  │ • XGBoost    │◄─│ • Literature │  │          │  │         │  │
  │  │ • SHAP       │  │   sweep      │  │ •BioSTEAM│  │ •Notebk │  │
  │  │ • MAPIE CI   │  │ • Compound   │  │ •DCF     │  │ •Deepgm │  │
  │  │ • Active     │  │   discovery  │  │ •Sensitiv│  │ •Claude │  │
  │  │   learning   │  │ • Regulatory │  │          │  │  analysis│  │
  │  └──────┬───────┘  └──────┬───────┘  └────┬─────┘  └────┬────┘  │
  │         │                 │               │              │       │
  │         └─────────────────▼───────────────┴──────────────┘       │
  │                         PostgreSQL 16 + pgvector                 │
  │         (strains, substrates, runs, contacts, queue,             │
  │          protocols, fpa, projects, tasks, notebooks)             │
  │                                                                  │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
  │  │  Contacts│  │ Projects │  │   FP&A   │  │  Next.js Frontend│ │
  │  │   CRM    │  │ Pipeline │  │Plaid+QBO │  │  (23 API routers)│ │
  │  │Gmail+Cal │  │  Stages  │  │          │  │  56 routes · KB  │ │
  │  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘ │
  └──────────────────────────────────────────────────────────────────┘
`}</pre>
      </div>

      <H2>Data Flow: Substrate to Recommendation</H2>
      <P>Here is what happens from the moment a new substrate is entered to the moment an experiment is recommended:</P>
      <Ol>
        <Li><strong>Substrate entry.</strong> Elliott adds a new substrate via the Analyses page. The form first asks for a name and partner, then automatically researches the composition by querying USDA FoodData Central and, as a fallback, asking Claude to synthesise published literature values. Each returned value comes with a confidence level (high / medium / low) and a citation. Elliott reviews each field and accepts, edits, or skips it before submitting. Manual entry remains available for substrates not in any database.</Li>
        <Li><strong>TEA screening.</strong> Within minutes, BioSTEAM simulates process economics for each candidate output (enzymes, extracts, fractions). For each output, it computes MPSP, NPV, and a GO/HOLD/REDIRECT recommendation. Outputs that don't pass TEA are deprioritised — the ML model still runs but the TEA weight pulls them down in rankings.</Li>
        <Li><strong>Strain scoring.</strong> Every annotated strain in the registry is scored against the substrate using the ML model. The model combines substrate composition with each strain's CAZyme profile to produce a compatibility score (0–1) and a 90% confidence interval.</Li>
        <Li><strong>Experiment recommendation.</strong> The active learning module ranks all unrun strain × substrate pairs by expected improvement — a combination of predicted score, model uncertainty, and TEA commercial viability. The top 5 appear on the dashboard.</Li>
        <Li><strong>Run logging.</strong> Omar runs the top-ranked experiment and logs the result — enzyme titer, temperature, run duration, any notes. The data enters the training set.</Li>
        <Li><strong>Model retrain.</strong> Every night at 03:00, if the training set has ≥30 rows, XGBoost retrains on all approved data. The next day's recommendations are based on the updated model.</Li>
      </Ol>

      <Concept>
        The system is designed as a closed loop. Each fermentation run reduces model uncertainty,
        which improves the next recommendation, which makes the next run more likely to succeed.
        Over time the model becomes a precise map of which strain works on which substrate class.
      </Concept>

      <H2>Who Does What</H2>

      <H3>Elliott (Scientific Lead)</H3>
      <Ul>
        <Li>Add new substrates and enter composition data as partners are onboarded</Li>
        <Li>Review the literature queue weekly — approve or reject extracted data points before they enter the model</Li>
        <Li>Approve compound discovery opportunities for TEA screening</Li>
        <Li>Generate and distribute TEA partner reports (DOCX)</Li>
        <Li>Review genome edit candidates and trigger SOP generation for wet-lab execution</Li>
        <Li>Monitor model health — review validation metrics and calibration suggestions after each retrain</Li>
      </Ul>

      <H3>Omar (Lab Lead)</H3>
      <Ul>
        <Li>Execute recommended fermentation runs — SSF, SmF, and other types as directed</Li>
        <Li>Log all completed runs within a day: enzyme titer, conditions, and notes</Li>
        <Li>Confirm strain and substrate matches in the review queue when flagged for manual review</Li>
        <Li>Flag runs that deviated from standard protocol using the off-target flag</Li>
      </Ul>

      <H3>System (Automated)</H3>
      <Ul>
        <Li>Run weekly literature sweep every Monday at 02:00 (OpenAlex + Semantic Scholar)</Li>
        <Li>Retrain XGBoost nightly at 03:00 when ≥30 approved strain-specific training rows are present</Li>
        <Li>Run TEA screening within minutes of a new substrate being entered</Li>
        <Li>Score all annotated strains against new substrates immediately on entry</Li>
        <Li>Research substrate composition automatically on new substrate entry (USDA FoodData Central + Claude fallback)</Li>
        <Li>Download genomes from NCBI, run dbCAN CAZyme annotation, and write feature vectors when a strain accession is queued — via a host-level daemon that polls every 2 minutes</Li>
      </Ul>

      <H2>Two Types of Literature Data</H2>
      <P>
        When a queue item is approved, the system routes it to one of two places depending on
        whether the strain is identified to the specific strain level or only to species level.
      </P>
      <SimpleTable
        headers={["Type", "Where it goes", "How it is used"]}
        rows={[
          ["Strain-specific run", "fermentation_runs → ML training set", "Direct model input. Counts toward the 30-run threshold for XGBoost activation. The model learns which CAZyme features drive performance on this substrate."],
          ["Species-level observation", "species_level_observations → Biological prior library", "Used to calibrate TEA titer defaults for that enzyme class. Does not advance the model toward XGBoost. Can be upgraded to a training run later once the strain is registered and annotated."],
        ]}
      />
      <P>
        Routing is automatic and shown as an indicator on each queue card before you approve.
        A queue item is routed to the biological prior library if the paper identifies the organism
        only at species level (e.g. "A. niger" with no strain code), if the fuzzy matcher cannot
        find a confident registry match, or if the matched strain has not yet been genome-annotated.
      </P>
      <Tip>
        Species-level data is not wasted. It updates the TEA titer defaults for that enzyme
        class, improving commercial accuracy for all substrates where no measured lab data exists yet.
      </Tip>

      <H2>How the System Improves Over Time</H2>
      <P>
        The ML model starts in Phase 0 — a transparent linear scoring matrix based on expert
        priors. It is simple by design: below 30 fermentation runs, there is not enough data to
        justify a complex model, and a linear model is more honest about what it doesn't know.
      </P>
      <P>
        Once 30 runs are logged, XGBoost takes over. The model improves in two ways:
      </P>
      <Ul>
        <Li><strong>More data.</strong> Each new run adds a real observation to the training set. The model learns which features (CAZyme families, substrate composition, genetic variants) are actually predictive in your specific system.</Li>
        <Li><strong>Literature data.</strong> The weekly agent sweep extracts fermentation data from published papers. Each approved queue item adds a training row without requiring a lab run. This is effectively free data that bootstraps the model faster.</Li>
      </Ul>
      <Tip>
        The fastest way to accelerate the model is to log runs in the combinations the dashboard
        recommends — these are specifically chosen to reduce uncertainty in the parts of the feature
        space the model knows least about.
      </Tip>

      <H2>Archive vs. Delete</H2>
      <P>
        Both substrates and enzymes support two removal actions with different consequences:
      </P>
      <SimpleTable
        headers={["Action", "Data retained?", "Name reusable?", "Restorable?", "When to use"]}
        rows={[
          ["Archive", "Yes — all TEA results, runs, and predictions kept", "No — name still reserved", "Yes", "Substrate or enzyme is no longer active but you want to keep the history. Excluded from analysis, scoring, and model training while archived."],
          ["Delete permanently", "No — all dependent data removed", "Yes — name freed immediately", "No", "Incorrect entry, duplicate, or data you never want again. The name becomes available for a new substrate."],
        ]}
      />
      <P>
        The ⋯ menu on each substrate row in the Analyses page shows both options. Archive is amber;
        Delete permanently is red with a confirmation prompt that lists what will be removed.
      </P>
    </article>
  );
}
