"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Track, fmtDuration } from "@/lib/learn";

interface OnboardingStatus {
  required: boolean;
  complete: boolean;
  total: number;
  completed: number;
  next: { module_id: string; title: string; track_title: string } | null;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${pct === 100 ? "bg-emerald-500" : "bg-blue-500"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function TrackCard({ track }: { track: Track }) {
  const pct = track.pct ?? 0;
  const done = pct === 100;
  return (
    <Link
      href={`/learn/${track.track_id}`}
      className="group flex flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {track.kind === "onboarding" && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Required
              </span>
            )}
            {done && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                Complete
              </span>
            )}
          </div>
          <h3 className="mt-1.5 font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400">
            {track.title}
          </h3>
        </div>
      </div>

      {track.summary && (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">{track.summary}</p>
      )}

      <div className="mt-auto pt-4 space-y-2">
        <ProgressBar pct={pct} />
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>
            {track.completed_count ?? 0} of {track.module_count ?? 0} modules
          </span>
          <span>{fmtDuration(track.total_minutes)}</span>
        </div>
      </div>
    </Link>
  );
}

export default function LearnPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [tRes, oRes] = await Promise.all([
          fetch("/api/proxy/learn/tracks"),
          fetch("/api/proxy/learn/onboarding"),
        ]);
        if (!tRes.ok) throw new Error("You do not have access to the Learning Center.");
        setTracks(await tRes.json());
        if (oRes.ok) setOnboarding(await oRes.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return <div className="p-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  }
  if (error) {
    return <div className="p-8 text-sm text-red-600 dark:text-red-400">{error}</div>;
  }

  const onboardingTracks = tracks.filter(t => t.kind === "onboarding");
  const courseTracks = tracks.filter(t => t.kind !== "onboarding");

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Learning Center</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Your onboarding steps and course modules.
        </p>
      </div>

      {/* Onboarding is the one thing we actively push people toward, so it gets
          a banner rather than sitting in the grid with everything else. */}
      {onboarding?.required && !onboarding.complete && onboarding.next && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Finish your onboarding
              </p>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                {onboarding.completed} of {onboarding.total} steps done. Up next:{" "}
                <span className="font-medium">{onboarding.next.title}</span>
              </p>
            </div>
            <Link
              href={`/learn/module/${onboarding.next.module_id}`}
              className="shrink-0 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium"
            >
              Continue
            </Link>
          </div>
        </div>
      )}

      {onboarding?.required && onboarding.complete && (
        <div className="rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 px-5 py-3 text-sm text-emerald-800 dark:text-emerald-300">
          Onboarding complete — all {onboarding.total} steps finished.
        </div>
      )}

      {tracks.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No modules have been assigned to you yet. Your program coordinator will add them.
          </p>
        </div>
      )}

      {onboardingTracks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Onboarding
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {onboardingTracks.map(t => <TrackCard key={t.track_id} track={t} />)}
          </div>
        </section>
      )}

      {courseTracks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Courses
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {courseTracks.map(t => <TrackCard key={t.track_id} track={t} />)}
          </div>
        </section>
      )}
    </div>
  );
}
