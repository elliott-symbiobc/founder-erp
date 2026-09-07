"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Track, LearnModule, fmtDuration } from "@/lib/learn";

function ModuleRow({ mod, index }: { mod: LearnModule; index: number }) {
  const done = mod.status === "completed";
  const started = mod.status === "in_progress";
  return (
    <Link
      href={`/learn/module/${mod.module_id}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
    >
      <div
        className={`shrink-0 h-7 w-7 rounded-full grid place-items-center text-xs font-semibold ${
          done
            ? "bg-emerald-500 text-white"
            : started
            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
            : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
        }`}
      >
        {done ? "✓" : index + 1}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{mod.title}</div>
        {mod.summary && (
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{mod.summary}</div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
        {mod.has_quiz && <span className="hidden sm:inline">Quiz</span>}
        {mod.requires_ack && <span className="hidden sm:inline">Sign-off</span>}
        {mod.video_url && <span aria-hidden>▶</span>}
        <span className="tabular-nums">{fmtDuration(mod.duration_min)}</span>
      </div>
    </Link>
  );
}

export default function TrackPage({ params }: { params: Promise<{ trackId: string }> }) {
  const { trackId } = use(params);
  const [track, setTrack] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/proxy/learn/tracks/${trackId}`);
      if (!res.ok) {
        setError(res.status === 403 ? "This track has not been assigned to you." : "Track not found.");
        return;
      }
      setTrack(await res.json());
    })();
  }, [trackId]);

  if (error) return <div className="p-8 text-sm text-red-600 dark:text-red-400">{error}</div>;
  if (!track) return <div className="p-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;

  const modules = track.modules ?? [];
  const done = modules.filter(m => m.status === "completed").length;
  const pct = modules.length ? Math.round((100 * done) / modules.length) : 0;
  const next = modules.find(m => m.status !== "completed");

  return (
    <div className="p-6 sm:p-8 max-w-4xl mx-auto space-y-6">
      <Link href="/learn" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
        ← Learning Center
      </Link>

      <div>
        <div className="flex items-center gap-2">
          {track.kind === "onboarding" && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              Required
            </span>
          )}
        </div>
        <h1 className="mt-1.5 text-2xl font-semibold text-gray-900 dark:text-gray-100">{track.title}</h1>
        {track.summary && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{track.summary}</p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {done} of {modules.length} complete
          </span>
          <span className="text-gray-500 dark:text-gray-400">{pct}%</span>
        </div>
        <div className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {next && (
          <Link
            href={`/learn/module/${next.module_id}`}
            className="mt-4 inline-block px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            {done === 0 ? "Start" : "Continue"} — {next.title}
          </Link>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden">
        {modules.length === 0 ? (
          <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
            No modules published in this track yet.
          </div>
        ) : (
          modules.map((m, i) => <ModuleRow key={m.module_id} mod={m} index={i} />)
        )}
      </div>
    </div>
  );
}
