"use client";

import { useCallback, useEffect, useState } from "react";
import { Track, LearnModule, QuizQuestion, toEmbedUrl, PartnerOrg, fmtDate } from "@/lib/learn";

const input =
  "w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm";

export default function LearningAdminPage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/proxy/learn/admin/tracks");
    if (!res.ok) { setError("You do not have permission to edit course content."); return; }
    const data: Track[] = await res.json();
    setTracks(data);
    // Close the editor if the track it was showing has been deleted. Reading
    // `selected` from the setter keeps `load` free of it, so the effect below
    // does not re-fire every time the selection changes.
    setSelected(cur => (cur && !data.some(t => t.track_id === cur) ? null : cur));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function newTrack(kind: "onboarding" | "course") {
    const res = await fetch("/api/proxy/learn/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: kind === "onboarding" ? "New onboarding track" : "New course",
        kind,
      }),
    });
    const t = await res.json();
    await load();
    setSelected(t.track_id);
  }

  if (error) return <div className="p-8 text-sm text-red-600 dark:text-red-400">{error}</div>;

  return (
    <div className="p-6 sm:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Course Content</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Onboarding flows and class modules, who they are assigned to, and how far
            each cohort has got. Accounts and access live in Users.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => newTrack("onboarding")}
            className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            New onboarding
          </button>
          <button
            onClick={() => newTrack("course")}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
          >
            New course
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tracks.map(t => (
          <button
            key={t.track_id}
            onClick={() => setSelected(t.track_id)}
            className="text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:border-blue-400 transition"
          >
            <div className="flex items-center gap-2">
              {t.kind === "onboarding" && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  Onboarding
                </span>
              )}
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                  t.is_published
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                }`}
              >
                {t.is_published ? "Published" : "Draft"}
              </span>
            </div>
            <h3 className="mt-2 font-semibold text-gray-900 dark:text-gray-100">{t.title}</h3>
            {t.summary && <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">{t.summary}</p>}
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t.module_count ?? 0} modules · assigned to {t.org_count ?? 0} cohorts
            </p>
          </button>
        ))}
        {tracks.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-500 dark:text-gray-400">
            No tracks yet.
          </div>
        )}
      </div>

      <CohortCurriculum tracks={tracks} onChanged={load} />

      {selected && <TrackEditor trackId={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

// ── Cohort curriculum & progress ───────────────────────────────────────────────

interface CohortProgress {
  modules: { module_id: string; title: string; track_title: string }[];
  members: {
    user_id: string; email: string; full_name: string | null;
    completed: number; total: number; pct: number;
    progress: Record<string, { status: string; completed_at: string | null }>;
  }[];
}

/** Which tracks a cohort studies, and how far its members have got. This is
 *  curriculum, so it sits with the course content rather than in an admin
 *  module of its own — the cohort's *access* is managed in Users. */
function CohortCurriculum({ tracks, onChanged }: { tracks: Track[]; onChanged: () => void }) {
  const [orgs, setOrgs] = useState<PartnerOrg[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [progress, setProgress] = useState<CohortProgress | null>(null);

  const loadOrgs = useCallback(async () => {
    const res = await fetch("/api/proxy/partners/orgs");
    if (!res.ok) return;
    const data: PartnerOrg[] = await res.json();
    setOrgs(data);
    setSelected(cur => cur || data[0]?.org_id || "");
  }, []);

  useEffect(() => { loadOrgs(); }, [loadOrgs]);

  const loadOrg = useCallback(async () => {
    if (!selected) { setProgress(null); return; }
    const [o, p] = await Promise.all([
      fetch(`/api/proxy/partners/orgs/${selected}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/proxy/partners/orgs/${selected}/progress`).then(r => r.ok ? r.json() : null),
    ]);
    // Keep the assigned-track checkboxes in step with the fuller record the
    // detail endpoint returns; the list endpoint does not carry `tracks`.
    if (o) setOrgs(prev => prev.map(x => (x.org_id === o.org_id ? { ...x, ...o } : x)));
    setProgress(p);
  }, [selected]);

  useEffect(() => { loadOrg(); }, [loadOrg]);

  const org = orgs.find(o => o.org_id === selected) ?? null;
  const assigned = new Set((org?.tracks ?? []).map(t => t.track_id));

  async function toggleTrack(trackId: string) {
    if (!org) return;
    const next = assigned.has(trackId)
      ? [...assigned].filter(id => id !== trackId)
      : [...assigned, trackId];
    await fetch(`/api/proxy/partners/orgs/${org.org_id}/tracks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track_ids: next }),
    });
    await loadOrg();
    onChanged();
  }

  if (!orgs.length) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Cohorts</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Assign tracks to a cohort and see how far its members have got.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {orgs.map(o => (
          <button
            key={o.org_id}
            onClick={() => setSelected(o.org_id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              selected === o.org_id
                ? "border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300"
            }`}
          >
            {o.name}
          </button>
        ))}
      </div>

      {org && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">
            Tracks assigned to {org.name}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {tracks.map(t => (
              <label key={t.track_id} className="flex items-center gap-2.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900">
                <input type="checkbox" className="accent-blue-600" checked={assigned.has(t.track_id)} onChange={() => toggleTrack(t.track_id)} />
                <span className="min-w-0 truncate text-gray-800 dark:text-gray-200">{t.title}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {progress && progress.modules.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-xs text-gray-500">
              <tr>
                <th className="text-left px-3 py-2 sticky left-0 bg-gray-50 dark:bg-gray-800">Member</th>
                <th className="px-3 py-2">%</th>
                {progress.modules.map(m => (
                  <th key={m.module_id} className="px-2 py-2 text-left font-normal max-w-[120px]">
                    <div className="truncate" title={`${m.track_title} — ${m.title}`}>{m.title}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {progress.members.map(mem => (
                <tr key={mem.user_id}>
                  <td className="px-3 py-2 sticky left-0 bg-white dark:bg-gray-800">
                    <div className="text-gray-900 dark:text-gray-100">{mem.full_name || mem.email}</div>
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums font-medium">{mem.pct}%</td>
                  {progress.modules.map(m => {
                    const p = mem.progress[m.module_id];
                    return (
                      <td key={m.module_id} className="px-2 py-2 text-center">
                        <span
                          title={p?.completed_at ? `Completed ${fmtDate(p.completed_at)}` : p?.status ?? "Not started"}
                          className={`inline-block h-3 w-3 rounded-sm ${
                            p?.status === "completed" ? "bg-emerald-500" : p ? "bg-amber-400" : "bg-gray-200 dark:bg-gray-700"
                          }`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {progress.members.length === 0 && (
                <tr><td colSpan={2 + progress.modules.length} className="px-3 py-6 text-center text-gray-500">
                  No members have joined yet.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Track editor ───────────────────────────────────────────────────────────── */

function TrackEditor({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const [track, setTrack] = useState<Track | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/proxy/learn/admin/tracks/${trackId}`);
    setTrack(await res.json());
  }, [trackId]);

  useEffect(() => { load(); }, [load]);

  async function patchTrack(body: Record<string, unknown>) {
    await fetch(`/api/proxy/learn/tracks/${trackId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    load();
  }

  async function addModule() {
    const res = await fetch("/api/proxy/learn/modules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_id: trackId,
        title: "Untitled module",
        sort_order: (track?.modules?.length ?? 0),
      }),
    });
    const m = await res.json();
    await load();
    setEditing(m.module_id);
  }

  if (!track) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-3xl h-full overflow-y-auto bg-white dark:bg-gray-900 p-6 sm:p-8 space-y-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Edit track</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="space-y-3">
          <input
            className={input}
            defaultValue={track.title}
            onBlur={e => e.target.value !== track.title && patchTrack({ title: e.target.value })}
          />
          <textarea
            className={input}
            rows={2}
            placeholder="Short summary shown on the card"
            defaultValue={track.summary ?? ""}
            onBlur={e => e.target.value !== (track.summary ?? "") && patchTrack({ summary: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={track.is_published}
                onChange={() => patchTrack({ is_published: !track.is_published })}
              />
              <span className="text-gray-800 dark:text-gray-200">Published</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={track.kind === "onboarding"}
                onChange={() => patchTrack({ kind: track.kind === "onboarding" ? "course" : "onboarding" })}
              />
              <span className="text-gray-800 dark:text-gray-200">Required onboarding</span>
            </label>
            <button
              onClick={async () => {
                if (!confirm("Delete this track and all of its modules?")) return;
                await fetch(`/api/proxy/learn/tracks/${trackId}`, { method: "DELETE" });
                onClose();
              }}
              className="ml-auto text-xs text-red-600 hover:underline"
            >
              Delete track
            </button>
          </div>
          {!track.is_published && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Draft tracks stay hidden from partners even when assigned to a cohort.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Modules
            </h3>
            <button onClick={addModule} className="text-xs text-blue-600 hover:underline">
              + Add module
            </button>
          </div>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
            {(track.modules ?? []).map((m, i) => (
              <div key={m.module_id}>
                <button
                  onClick={() => setEditing(editing === m.module_id ? null : m.module_id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span className="text-xs text-gray-400 tabular-nums w-5">{i + 1}</span>
                  <span className="flex-1 text-sm text-gray-900 dark:text-gray-100 truncate">{m.title}</span>
                  {!m.is_published && <span className="text-[10px] uppercase text-gray-400">Draft</span>}
                  {m.video_url && <span className="text-xs text-gray-400">▶</span>}
                  <span className="text-xs text-gray-400">{editing === m.module_id ? "▲" : "▼"}</span>
                </button>
                {editing === m.module_id && (
                  <ModuleEditor mod={m} onChanged={load} onDeleted={() => { setEditing(null); load(); }} />
                )}
              </div>
            ))}
            {(track.modules ?? []).length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-gray-500">No modules yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Module editor ──────────────────────────────────────────────────────────── */

function ModuleEditor({
  mod, onChanged, onDeleted,
}: {
  mod: LearnModule; onChanged: () => void; onDeleted: () => void;
}) {
  const [quiz, setQuiz] = useState<QuizQuestion[]>(mod.quiz ?? []);
  const [resources, setResources] = useState<{ label: string; url: string }[]>(mod.resources ?? []);
  const [saved, setSaved] = useState(false);

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/proxy/learn/modules/${mod.module_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onChanged();
  }

  const embed = toEmbedUrl(mod.video_url);

  return (
    <div className="px-3 pb-4 pt-1 space-y-4 bg-gray-50 dark:bg-gray-800/60">
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={input} defaultValue={mod.title}
          onBlur={e => e.target.value !== mod.title && patch({ title: e.target.value })} />
        <input className={input} type="number" placeholder="Duration (minutes)"
          defaultValue={mod.duration_min ?? ""}
          onBlur={e => patch({ duration_min: e.target.value ? Number(e.target.value) : null })} />
      </div>

      <input className={input} placeholder="Summary" defaultValue={mod.summary ?? ""}
        onBlur={e => e.target.value !== (mod.summary ?? "") && patch({ summary: e.target.value })} />

      <div>
        <input className={input} placeholder="YouTube or Vimeo URL" defaultValue={mod.video_url ?? ""}
          onBlur={e => e.target.value !== (mod.video_url ?? "") && patch({ video_url: e.target.value })} />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {embed ? `Embeds as ${embed}` : "Paste any watch link — it is normalised automatically."}
        </p>
      </div>

      <textarea className={`${input} font-mono`} rows={6} placeholder="Module body (markdown)"
        defaultValue={mod.body_md ?? ""}
        onBlur={e => e.target.value !== (mod.body_md ?? "") && patch({ body_md: e.target.value })} />

      {/* Resources */}
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Resources</span>
          <button onClick={() => setResources([...resources, { label: "", url: "" }])}
            className="text-xs text-blue-600 hover:underline">+ Add</button>
        </div>
        <div className="mt-2 space-y-2">
          {resources.map((r, i) => (
            <div key={i} className="flex gap-2">
              <input className={input} placeholder="Label" value={r.label}
                onChange={e => setResources(resources.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
              <input className={input} placeholder="https://…" value={r.url}
                onChange={e => setResources(resources.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} />
              <button onClick={() => { const next = resources.filter((_, j) => j !== i); setResources(next); patch({ resources: next }); }}
                className="text-red-600 text-sm px-2">×</button>
            </div>
          ))}
          {resources.length > 0 && (
            <button onClick={() => patch({ resources })} className="text-xs text-blue-600 hover:underline">
              Save resources
            </button>
          )}
        </div>
      </div>

      {/* Quiz */}
      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Knowledge check</span>
          <button
            onClick={() => setQuiz([...quiz, { question: "", options: ["", ""], answer_index: 0, explanation: "" }])}
            className="text-xs text-blue-600 hover:underline"
          >
            + Add question
          </button>
        </div>
        <div className="mt-2 space-y-3">
          {quiz.map((q, qi) => (
            <div key={qi} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2 bg-white dark:bg-gray-900">
              <div className="flex gap-2">
                <input className={input} placeholder="Question" value={q.question}
                  onChange={e => setQuiz(quiz.map((x, j) => j === qi ? { ...x, question: e.target.value } : x))} />
                <button onClick={() => { const next = quiz.filter((_, j) => j !== qi); setQuiz(next); patch({ quiz: next }); }}
                  className="text-red-600 text-sm px-2">×</button>
              </div>
              {q.options.map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <input type="radio" name={`ans-${mod.module_id}-${qi}`} checked={q.answer_index === oi}
                    onChange={() => setQuiz(quiz.map((x, j) => j === qi ? { ...x, answer_index: oi } : x))} />
                  <input className={input} placeholder={`Option ${oi + 1}`} value={opt}
                    onChange={e => setQuiz(quiz.map((x, j) =>
                      j === qi ? { ...x, options: x.options.map((o, k) => k === oi ? e.target.value : o) } : x
                    ))} />
                </div>
              ))}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setQuiz(quiz.map((x, j) => j === qi ? { ...x, options: [...x.options, ""] } : x))}
                  className="text-xs text-blue-600 hover:underline"
                >
                  + Option
                </button>
              </div>
              <input className={input} placeholder="Explanation shown after answering" value={q.explanation ?? ""}
                onChange={e => setQuiz(quiz.map((x, j) => j === qi ? { ...x, explanation: e.target.value } : x))} />
            </div>
          ))}
          {quiz.length > 0 && (
            <button onClick={() => patch({ quiz })} className="text-xs text-blue-600 hover:underline">
              Save quiz
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          The selected radio marks the correct answer. Answer keys are stripped before the module reaches a partner.
        </p>
      </div>

      {/* Flags */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mod.is_published} onChange={() => patch({ is_published: !mod.is_published })} />
          <span className="text-gray-800 dark:text-gray-200">Published</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mod.requires_ack} onChange={() => patch({ requires_ack: !mod.requires_ack })} />
          <span className="text-gray-800 dark:text-gray-200">Require a signed acknowledgement</span>
        </label>
        {mod.requires_ack && (
          <input className={input} placeholder="I have read and agree to…" defaultValue={mod.ack_text ?? ""}
            onBlur={e => e.target.value !== (mod.ack_text ?? "") && patch({ ack_text: e.target.value })} />
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            if (!confirm("Delete this module?")) return;
            await fetch(`/api/proxy/learn/modules/${mod.module_id}`, { method: "DELETE" });
            onDeleted();
          }}
          className="text-xs text-red-600 hover:underline"
        >
          Delete module
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved</span>}
      </div>
    </div>
  );
}
