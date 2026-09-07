"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { LearnModule, QuizQuestion, toEmbedUrl, fmtDuration } from "@/lib/learn";

interface QuizReview { correct_index: number; explanation: string | null }

/* ── Video player ────────────────────────────────────────────────────────────
 * A plain <iframe> tells us nothing about whether anyone pressed play, so for
 * YouTube we load its IFrame API and report the real playback position. Vimeo
 * and anything else fall back to counting seconds the page is open and visible,
 * which is a weaker signal but still distinguishes "watched" from "opened".
 */

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  }
}
interface YTPlayer { getCurrentTime(): number; destroy(): void }

function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  return new Promise(resolve => {
    const existing = document.getElementById("yt-iframe-api");
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    if (!existing) {
      const s = document.createElement("script");
      s.id = "yt-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(s);
    }
  });
}

function VideoPlayer({
  embedUrl,
  onSecond,
}: {
  embedUrl: string;
  onSecond: (seconds: number) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const isYouTube = embedUrl.includes("youtube.com/embed/");

  useEffect(() => {
    if (!isYouTube || !holder.current) return;
    let player: YTPlayer | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    loadYouTubeApi().then(() => {
      if (cancelled || !holder.current || !window.YT) return;
      const videoId = embedUrl.split("/embed/")[1]?.split("?")[0];
      player = new window.YT.Player(holder.current, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            timer = setInterval(() => {
              try {
                const t = player?.getCurrentTime?.();
                if (typeof t === "number" && t > 0) onSecond(Math.floor(t));
              } catch { /* player torn down mid-tick */ }
            }, 5000);
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      try { player?.destroy(); } catch { /* already gone */ }
    };
  }, [embedUrl, isYouTube, onSecond]);

  // Fallback: count visible seconds on the page.
  useEffect(() => {
    if (isYouTube) return;
    let elapsed = 0;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        elapsed += 5;
        onSecond(elapsed);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [isYouTube, onSecond]);

  return (
    <div className="aspect-video w-full rounded-xl overflow-hidden bg-black">
      {isYouTube ? (
        <div ref={holder} className="h-full w-full" />
      ) : (
        <iframe
          src={embedUrl}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
          title="Module video"
        />
      )}
    </div>
  );
}

/* ── Quiz ──────────────────────────────────────────────────────────────────── */

function Quiz({
  questions,
  review,
  answers,
  setAnswers,
}: {
  questions: QuizQuestion[];
  review: QuizReview[] | null;
  answers: number[];
  setAnswers: (a: number[]) => void;
}) {
  return (
    <div className="space-y-5">
      {questions.map((q, qi) => (
        <div key={qi}>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {qi + 1}. {q.question}
          </p>
          <div className="mt-2 space-y-1.5">
            {q.options.map((opt, oi) => {
              const chosen = answers[qi] === oi;
              const correct = review?.[qi]?.correct_index === oi;
              const wrongPick = !!review && chosen && !correct;
              return (
                <label
                  key={oi}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer transition ${
                    correct && review
                      ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20"
                      : wrongPick
                      ? "border-red-400 bg-red-50 dark:bg-red-900/20"
                      : chosen
                      ? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
                      : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                  }`}
                >
                  <input
                    type="radio"
                    name={`q${qi}`}
                    checked={chosen}
                    disabled={!!review}
                    onChange={() => {
                      const next = [...answers];
                      next[qi] = oi;
                      setAnswers(next);
                    }}
                  />
                  <span className="text-gray-800 dark:text-gray-200">{opt}</span>
                </label>
              );
            })}
          </div>
          {review?.[qi]?.explanation && (
            <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">
              {review[qi].explanation}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function ModulePage({ params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = use(params);
  const [mod, setMod] = useState<LearnModule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [review, setReview] = useState<QuizReview[] | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [acked, setAcked] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Highest second reported by the player, flushed on a timer rather than on
  // every tick so a long video is a handful of writes, not hundreds.
  const watched = useRef(0);
  const flushed = useRef(0);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/proxy/learn/modules/${moduleId}`);
      if (!res.ok) {
        setError(res.status === 403 ? "This module has not been assigned to you." : "Module not found.");
        return;
      }
      const data: LearnModule = await res.json();
      setMod(data);
      setAnswers(new Array(data.quiz?.length ?? 0).fill(-1));
      setCompleted(data.progress?.status === "completed");
      setAcked(!!data.progress?.acknowledged_at);
      watched.current = data.progress?.video_seconds ?? 0;
      flushed.current = watched.current;
    })();
  }, [moduleId]);

  const onSecond = useCallback((s: number) => {
    if (s > watched.current) watched.current = s;
  }, []);

  // Flush watch position periodically and once more on unmount, so closing the
  // tab mid-video does not lose the position.
  useEffect(() => {
    const flush = () => {
      if (watched.current <= flushed.current) return;
      flushed.current = watched.current;
      fetch(`/api/proxy/learn/modules/${moduleId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_seconds: watched.current }),
      }).catch(() => { /* best effort */ });
    };
    const timer = setInterval(flush, 20000);
    return () => { clearInterval(timer); flush(); };
  }, [moduleId]);

  async function submit(opts: { completed?: boolean; acknowledged?: boolean }) {
    if (!mod) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { video_seconds: watched.current };
      if (opts.acknowledged) body.acknowledged = true;
      if (opts.completed) body.completed = true;
      if ((mod.quiz?.length ?? 0) > 0 && answers.every(a => a >= 0)) body.quiz_answers = answers;

      const res = await fetch(`/api/proxy/learn/modules/${moduleId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail ?? "Could not save progress"); return; }
      if (data.quiz_review) { setReview(data.quiz_review); setScore(data.quiz_score); }
      if (data.acknowledged_at) setAcked(true);
      if (data.status === "completed") setCompleted(true);
      setError(null);
    } finally {
      setSaving(false);
    }
  }

  if (error && !mod) return <div className="p-8 text-sm text-red-600 dark:text-red-400">{error}</div>;
  if (!mod) return <div className="p-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;

  const embed = toEmbedUrl(mod.video_url);
  const quiz = mod.quiz ?? [];
  const quizAnswered = quiz.length > 0 && answers.every(a => a >= 0);
  const ackBlocked = mod.requires_ack && !acked;

  return (
    <div className="p-6 sm:p-8 max-w-3xl mx-auto space-y-6">
      <Link
        href={`/learn/${mod.track_id}`}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        ← {mod.track_title ?? "Back to track"}
      </Link>

      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{mod.title}</h1>
        <div className="mt-1 flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
          {mod.duration_min && <span>{fmtDuration(mod.duration_min)}</span>}
          {completed && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              Completed
            </span>
          )}
        </div>
        {mod.summary && (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{mod.summary}</p>
        )}
      </div>

      {embed && <VideoPlayer embedUrl={embed} onSecond={onSecond} />}

      {mod.body_md && (
        <article className="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200">
          <ReactMarkdown>{mod.body_md}</ReactMarkdown>
        </article>
      )}

      {(mod.resources?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Resources
          </h2>
          <ul className="mt-3 space-y-1.5">
            {mod.resources!.map((r, i) => (
              <li key={i}>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {r.label || r.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {quiz.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Knowledge check
            </h2>
            {score !== null && (
              <span
                className={`text-sm font-semibold ${
                  score >= 80 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {score}%
              </span>
            )}
          </div>
          <div className="mt-4">
            <Quiz questions={quiz} review={review} answers={answers} setAnswers={setAnswers} />
          </div>
          {!review && (
            <button
              onClick={() => submit({})}
              disabled={!quizAnswered || saving}
              className="mt-4 px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium disabled:opacity-40"
            >
              Check answers
            </button>
          )}
        </div>
      )}

      {mod.requires_ack && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-5">
          <label className="flex items-start gap-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acked}
              disabled={acked || saving}
              onChange={() => submit({ acknowledged: true })}
            />
            <span className="text-amber-900 dark:text-amber-200">
              {mod.ack_text || "I have read and understood this module."}
            </span>
          </label>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={() => submit({ completed: true })}
          disabled={completed || saving || ackBlocked}
          className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-40"
        >
          {completed ? "Completed" : saving ? "Saving…" : "Mark complete"}
        </button>
        {ackBlocked && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Acknowledge above to finish this module.
          </span>
        )}
      </div>
    </div>
  );
}
