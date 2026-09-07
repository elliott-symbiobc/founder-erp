"use client";

import Link from "next/link";
import { useEffect, useState, useCallback, useRef } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ──────────────────────────────────────────────────────────────────

interface Advisor {
  advisor_id: string;
  contact_id: string;
  name: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  avatar_url: string | null;
  tags: string[];
  equity_percent: number | null;
  faa_sign_date: string | null;
  piia_due_date: string | null;
  piia_issued: boolean;
  piia_issue_date: string | null;
  piu_cliff_months: number | null;
  piu_vest_date: string | null;
  vesting_schedule: string | null;
  fast_performance_level: string | null;
  expected_hours_per_month: number | null;
  expected_meetings: string | null;
  expected_responsiveness: string | null;
  duties: string | null;
  faa_document_url: string | null;
  piia_document_url: string | null;
  notes: string | null;
  last_update_sent_at: string | null;
  last_open_at: string | null;
  last_open_count: number | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function isOverdue(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return new Date(dateStr + "T00:00:00") < new Date();
}

function vestingProgress(advisor: Advisor): { percent: number; label: string } | null {
  if (!advisor.faa_sign_date) return null;
  const start = new Date(advisor.faa_sign_date + "T00:00:00");
  const cliff = new Date(start);
  cliff.setMonth(cliff.getMonth() + (advisor.piu_cliff_months ?? 6));
  const vestEnd = advisor.piu_vest_date ? new Date(advisor.piu_vest_date + "T00:00:00") : null;
  const now = new Date();

  if (!vestEnd) {
    // No vest date set — show time since FAA relative to a 2-year vest
    const twoYear = new Date(start);
    twoYear.setFullYear(twoYear.getFullYear() + 2);
    const total = twoYear.getTime() - start.getTime();
    const elapsed = Math.min(now.getTime() - start.getTime(), total);
    const pct = Math.round((elapsed / total) * 100);
    const pastCliff = now >= cliff;
    return {
      percent: Math.max(0, pct),
      label: pastCliff ? `${pct}% vested (est.)` : `Cliff: ${fmt(cliff.toISOString().split("T")[0])}`,
    };
  }

  const total = vestEnd.getTime() - start.getTime();
  const elapsed = Math.min(now.getTime() - start.getTime(), total);
  const pct = Math.round((elapsed / total) * 100);
  const done = now >= vestEnd;
  return {
    percent: Math.max(0, Math.min(100, pct)),
    label: done ? "Fully vested" : `${pct}% vested · ends ${fmt(advisor.piu_vest_date)}`,
  };
}

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

function gdriveName(url: string | null): string {
  if (!url) return "";
  if (url.includes("drive.google.com") || url.includes("docs.google.com")) return "Google Drive";
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return "Document";
  }
}

// ── Drive file picker ─────────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  modifiedTime: string;
}

function DriveIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === "application/pdf") {
    return (
      <svg className="w-4 h-4 text-red-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM8 17.5v-1.5h8v1.5H8zm0-3v-1.5h8V14.5H8zm0-3V10h5v1.5H8z"/>
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM8 13h8v1.5H8V13zm0 3h8v1.5H8V16zm0-6h5v1.5H8V10z"/>
    </svg>
  );
}

function DriveFilePicker({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Search with debounce
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/proxy/advisors/drive/files?q=${encodeURIComponent(query)}`);
        if (res.status === 400) {
          setError("Google account not connected. Connect Gmail in Settings first.");
          setFiles([]);
        } else if (res.status === 403) {
          setError("Drive access not yet authorized. Reconnect your Google account to add Drive permission.");
          setFiles([]);
        } else if (!res.ok) {
          setError("Failed to fetch Drive files.");
          setFiles([]);
        } else {
          setFiles(await res.json());
        }
      } catch {
        setError("Network error fetching Drive files.");
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [query, open]);

  function openPicker() {
    setOpen(true);
    setQuery("");
    setFiles([]);
    setError(null);
  }

  function select(file: DriveFile) {
    onChange(file.webViewLink);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "https://drive.google.com/…"}
          className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        />
        <button
          type="button"
          onClick={openPicker}
          title="Browse Google Drive"
          className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-700 transition-colors text-xs"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 87.3 78" fill="currentColor">
            <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L28 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066DA"/>
            <path d="M43.65 25L29.35 0c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5C.4 49.9 0 51.45 0 53h28z" fill="#00AC47"/>
            <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57.5c.8-1.4 1.2-2.95 1.2-4.5H59.3l5.9 11.5z" fill="#EA4335"/>
            <path d="M43.65 25L57.95 0H29.35z" fill="#00832D"/>
            <path d="M59.3 53H87.3c0-1.55-.4-3.1-1.2-4.5L72.15 24.15l-12.5 21.7z" fill="#2684FC"/>
            <path d="M43.65 47.5L28 53l-14.15 23.8c1.35.8 2.9 1.2 4.45 1.2h50.7c1.55 0 3.1-.4 4.45-1.2z" fill="#FFBA00"/>
          </svg>
          Browse
        </button>
      </div>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100 dark:border-gray-800">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Drive…"
              className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-400"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {loading && (
              <div className="px-4 py-3 text-xs text-gray-400">Searching…</div>
            )}
            {error && (
              <div className="px-4 py-3 text-xs text-amber-600">{error}</div>
            )}
            {!loading && !error && files.length === 0 && (
              <div className="px-4 py-3 text-xs text-gray-400">
                {query ? "No matching files." : "Type to search, or browse recent files above."}
              </div>
            )}
            {!loading && files.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => select(f)}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-left transition-colors"
              >
                <DriveIcon mimeType={f.mimeType} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{f.name}</p>
                  <p className="text-xs text-gray-400">{new Date(f.modifiedTime).toLocaleDateString()}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ── Edit modal ────────────────────────────────────────────────────────────────

const PERF_LEVELS = ["Strategic", "Standard", "Advisory"];

function EditModal({
  advisor,
  onClose,
  onSaved,
}: {
  advisor: Advisor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    equity_percent: advisor.equity_percent ?? "",
    faa_sign_date: advisor.faa_sign_date ?? "",
    piia_due_date: advisor.piia_due_date ?? "",
    piia_issued: advisor.piia_issued,
    piia_issue_date: advisor.piia_issue_date ?? "",
    piu_cliff_months: advisor.piu_cliff_months ?? 6,
    piu_vest_date: advisor.piu_vest_date ?? "",
    vesting_schedule: advisor.vesting_schedule ?? "",
    fast_performance_level: advisor.fast_performance_level ?? "",
    expected_hours_per_month: advisor.expected_hours_per_month ?? "",
    expected_meetings: advisor.expected_meetings ?? "",
    expected_responsiveness: advisor.expected_responsiveness ?? "",
    duties: advisor.duties ?? "",
    faa_document_url: advisor.faa_document_url ?? "",
    piia_document_url: advisor.piia_document_url ?? "",
    notes: advisor.notes ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form)) {
      if (v === "" || v === null) {
        payload[k] = null;
      } else {
        payload[k] = v;
      }
    }
    await fetch(`/api/proxy/advisors/${advisor.advisor_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">{advisor.name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Equity */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Equity</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Equity %</label>
                <input
                  type="number" step="0.01" min="0" max="100"
                  value={form.equity_percent}
                  onChange={(e) => setForm({ ...form, equity_percent: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Vesting Schedule</label>
                <input
                  type="text"
                  value={form.vesting_schedule}
                  onChange={(e) => setForm({ ...form, vesting_schedule: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder="e.g. 2-year vesting"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Cliff (months)</label>
                <input
                  type="number" min="0"
                  value={form.piu_cliff_months}
                  onChange={(e) => setForm({ ...form, piu_cliff_months: Number(e.target.value) })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Vest End Date</label>
                <input
                  type="date"
                  value={form.piu_vest_date}
                  onChange={(e) => setForm({ ...form, piu_vest_date: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
          </section>

          {/* Agreements */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Agreements</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">FAA Signed Date</label>
                <input
                  type="date"
                  value={form.faa_sign_date}
                  onChange={(e) => setForm({ ...form, faa_sign_date: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">FAA Document</label>
                <DriveFilePicker
                  value={form.faa_document_url}
                  onChange={(url) => setForm({ ...form, faa_document_url: url })}
                  placeholder="https://drive.google.com/…"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">PIIA Due Date</label>
                <input
                  type="date"
                  value={form.piia_due_date}
                  onChange={(e) => setForm({ ...form, piia_due_date: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">PIIA Document</label>
                <DriveFilePicker
                  value={form.piia_document_url}
                  onChange={(url) => setForm({ ...form, piia_document_url: url })}
                  placeholder="https://drive.google.com/…"
                />
              </div>
              <div className="col-span-2 flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.piia_issued}
                    onChange={(e) => setForm({ ...form, piia_issued: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">PIIA Issued</span>
                </label>
                {form.piia_issued && (
                  <div className="flex-1">
                    <input
                      type="date"
                      value={form.piia_issue_date}
                      onChange={(e) => setForm({ ...form, piia_issue_date: e.target.value })}
                      className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    />
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Engagement */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Engagement</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Performance Level</label>
                <select
                  value={form.fast_performance_level}
                  onChange={(e) => setForm({ ...form, fast_performance_level: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  <option value="">— Select —</option>
                  {PERF_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Expected Hours / Month</label>
                <input
                  type="number" min="0" step="0.5"
                  value={form.expected_hours_per_month}
                  onChange={(e) => setForm({ ...form, expected_hours_per_month: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Expected Meetings</label>
                <input
                  type="text"
                  value={form.expected_meetings}
                  onChange={(e) => setForm({ ...form, expected_meetings: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder="e.g. Monthly strategy sessions"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Expected Responsiveness</label>
                <input
                  type="text"
                  value={form.expected_responsiveness}
                  onChange={(e) => setForm({ ...form, expected_responsiveness: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder="e.g. 48-hour response"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Duties / Responsibilities</label>
                <AutoTextarea
                  rows={2}
                  value={form.duties}
                  onChange={(e) => setForm({ ...form, duties: e.target.value })}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
                />
              </div>
            </div>
          </section>

          {/* Notes */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Notes</h3>
            <AutoTextarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
              placeholder="Internal notes…"
            />
          </section>
        </div>

        <div className="flex justify-end gap-2 p-5 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Doc link button ────────────────────────────────────────────────────────────

function DocLink({ url, label }: { url: string | null; label: string }) {
  if (!url) return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-400 italic">{label}: none</span>
  );
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors font-medium"
    >
      <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 2a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5zM8 13h8v1.5H8V13zm0 3h8v1.5H8V16zm0-6h5v1.5H8V10z"/>
      </svg>
      {label}
      <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
}

// ── Send Update Modal ─────────────────────────────────────────────────────────

interface SendResult {
  advisor_id: string;
  email: string;
  status: "sent" | "saved" | "error";
  detail?: string;
}

type ModalTab = "compose" | "preview";

function SendUpdateModal({
  advisors,
  onClose,
  onSent,
}: {
  advisors: Advisor[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [tab, setTab] = useState<ModalTab>("compose");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [previewAdvisorId, setPreviewAdvisorId] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(advisors.filter((a) => a.email).map((a) => a.advisor_id))
  );
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [resultsLabel, setResultsLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const eligible = advisors.filter((a) => a.email);
  const allSelected = eligible.every((a) => selected.has(a.advisor_id));

  // Default preview advisor to first selected
  const previewAdvisor =
    eligible.find((a) => a.advisor_id === previewAdvisorId) ??
    eligible.find((a) => selected.has(a.advisor_id)) ??
    eligible[0];

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(eligible.map((a) => a.advisor_id)));
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function previewBody() {
    if (!previewAdvisor) return body;
    return body.replace("{name}", previewAdvisor.name.split(" ")[0]);
  }

  async function submit(endpoint: "/advisors/send-update" | "/advisors/save-drafts") {
    if (!subject.trim() || !body.trim()) { setError("Subject and body are required."); return; }
    if (selected.size === 0) { setError("Select at least one advisor."); return; }
    const ccList = ccInput.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.includes("@"));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/proxy${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), body: body.trim(), advisor_ids: Array.from(selected), cc: ccList.length ? ccList : undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail ?? "Request failed.");
        return;
      }
      const data = await res.json();
      setResults(data.results);
      setResultsLabel(endpoint === "/advisors/send-update" ? "sent" : "saved as draft");
      if (endpoint === "/advisors/send-update") onSent();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const successCount = results?.filter((r) => r.status !== "error").length ?? 0;
  const failCount = results?.filter((r) => r.status === "error").length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-0 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-gray-100">Advisor Update Email</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Use <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{"{name}"}</code> for personalized first name
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        {!results && (
          <div className="flex gap-1 px-5 pt-3 pb-0 flex-shrink-0">
            {(["compose", "preview"] as ModalTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm rounded-t-lg font-medium capitalize transition-colors ${
                  tab === t
                    ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {results ? (
            /* ── Results ── */
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {successCount} {resultsLabel}
                {failCount > 0 && <span className="text-red-600 dark:text-red-400">, {failCount} failed</span>}
              </p>
              {results.map((r) => (
                <div key={r.advisor_id} className={`flex items-center gap-2 text-sm ${r.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
                  {r.status === "error" ? (
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                  ) : (
                    <svg className="w-4 h-4 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
                  )}
                  <span>{r.email}</span>
                  {r.detail && <span className="text-xs opacity-75">— {r.detail}</span>}
                </div>
              ))}
            </div>
          ) : tab === "compose" ? (
            /* ── Compose tab ── */
            <>
              {/* Recipients */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Recipients</h3>
                  <button type="button" onClick={toggleAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {eligible.map((a) => (
                    <label key={a.advisor_id} className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.has(a.advisor_id)}
                        onChange={() => toggle(a.advisor_id)}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600"
                      />
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {a.avatar_url ? (
                          <img src={a.avatar_url} alt={a.name} className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0">
                            <span className="text-purple-700 dark:text-purple-300 font-semibold text-xs">{initials(a.name)}</span>
                          </div>
                        )}
                        <span className="text-sm text-gray-800 dark:text-gray-200 truncate">{a.name}</span>
                        <span className="text-xs text-gray-400 truncate">{a.email}</span>
                      </div>
                      {a.last_update_sent_at && (
                        <span className="text-xs text-gray-400 flex-shrink-0">
                          {new Date(a.last_update_sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </label>
                  ))}
                  {eligible.length === 0 && (
                    <p className="text-sm text-gray-400">No advisors have email addresses on file.</p>
                  )}
                </div>
                {advisors.length > eligible.length && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5">
                    {advisors.length - eligible.length} advisor{advisors.length - eligible.length > 1 ? "s" : ""} skipped — no email on file.
                  </p>
                )}
              </section>

              {/* Compose fields */}
              <section className="space-y-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">CC</label>
                  <input
                    type="text"
                    value={ccInput}
                    onChange={(e) => setCcInput(e.target.value)}
                    placeholder="email@example.com, another@example.com"
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Open ERP — Advisor Update, May 2026"
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Body</label>
                  <AutoTextarea
                    rows={9}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder={"Hi {name},\n\nHere's a quick update on Open ERP…\n\nBest,\nElliott"}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none font-mono"
                  />
                </div>
              </section>

              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            </>
          ) : (
            /* ── Preview tab ── */
            <div className="space-y-3">
              {eligible.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Preview as:</span>
                  <select
                    value={previewAdvisor?.advisor_id ?? ""}
                    onChange={(e) => setPreviewAdvisorId(e.target.value)}
                    className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {eligible.map((a) => (
                      <option key={a.advisor_id} value={a.advisor_id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              )}
              {previewAdvisor ? (
                <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                  <div className="bg-gray-50 dark:bg-gray-800 px-4 py-3 space-y-1 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-12">To</span>
                      <span className="text-gray-800 dark:text-gray-200">{previewAdvisor.name} &lt;{previewAdvisor.email}&gt;</span>
                    </div>
                    {ccInput.trim() && (
                      <div className="flex gap-2 text-xs">
                        <span className="text-gray-400 w-12">CC</span>
                        <span className="text-gray-800 dark:text-gray-200">{ccInput}</span>
                      </div>
                    )}
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-12">Subject</span>
                      <span className="text-gray-800 dark:text-gray-200 font-medium">{subject || <em className="opacity-50">no subject</em>}</span>
                    </div>
                  </div>
                  <div className="px-4 py-4 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed min-h-[180px]">
                    {previewBody() || <span className="text-gray-400 italic">No body yet — go to Compose to write your email.</span>}
                  </div>
                  <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
                    <p className="text-xs text-gray-400">A tracking pixel will be embedded to record opens (not shown in preview).</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-400">No eligible recipients selected.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <>
              <button
                onClick={() => submit("/advisors/save-drafts")}
                disabled={busy || selected.size === 0}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 font-medium flex items-center gap-2"
              >
                {busy ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg>
                )}
                Save Drafts
              </button>
              <button
                onClick={() => submit("/advisors/send-update")}
                disabled={busy || selected.size === 0}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 font-medium flex items-center gap-2"
              >
                {busy ? (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                )}
                Send to {selected.size}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Advisor card ──────────────────────────────────────────────────────────────

function AdvisorCard({ advisor, onEdit, onChanged }: { advisor: Advisor; onEdit: () => void; onChanged: () => void }) {
  const progress = vestingProgress(advisor);
  const piiaOverdue = !advisor.piia_issued && isOverdue(advisor.piia_due_date);
  const piiaColor = advisor.piia_issued
    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
    : piiaOverdue
    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400";

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="p-4 flex items-start gap-3">
        {advisor.avatar_url ? (
          <img src={advisor.avatar_url} alt={advisor.name}
            className="w-12 h-12 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center flex-shrink-0">
            <span className="text-purple-700 dark:text-purple-300 font-semibold text-sm">
              {initials(advisor.name)}
            </span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <Link href={`/contacts/${advisor.contact_id}`}
                className="font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                {advisor.name}
              </Link>
              {advisor.title && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{advisor.title}</p>
              )}
              {advisor.organization && (
                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{advisor.organization}</p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {advisor.equity_percent != null && (
                <span className="text-sm font-bold text-purple-700 dark:text-purple-300">
                  {advisor.equity_percent}%
                </span>
              )}
              <button
                onClick={onEdit}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors p-1"
                title="Edit advisor info"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Vesting progress */}
      {progress && (
        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">{progress.label}</span>
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{progress.percent}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                progress.percent >= 100 ? "bg-green-500" : "bg-purple-500"
              }`}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* Agreement status */}
      <div className="px-4 pb-3 flex flex-wrap gap-2">
        {/* FAA */}
        {advisor.faa_sign_date ? (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            FAA signed {fmt(advisor.faa_sign_date)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            FAA not signed
          </span>
        )}

        {/* PIIA */}
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${piiaColor}`}>
          {advisor.piia_issued ? (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              PIIA issued {fmt(advisor.piia_issue_date)}
            </>
          ) : piiaOverdue ? (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              PIIA overdue (due {fmt(advisor.piia_due_date)})
            </>
          ) : (
            <>PIIA due {fmt(advisor.piia_due_date)}</>
          )}
        </span>
      </div>

      {/* Docs */}
      <div className="px-4 pb-3 flex flex-wrap gap-2">
        <DocLink url={advisor.faa_document_url} label="FAA" />
        <DocLink url={advisor.piia_document_url} label="PIIA" />
      </div>

      {/* Engagement */}
      {(advisor.fast_performance_level || advisor.expected_hours_per_month || advisor.duties) && (
        <div className="px-4 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1.5">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {advisor.fast_performance_level && (
              <span className="text-xs text-gray-500">
                <span className="font-medium text-gray-700 dark:text-gray-300">{advisor.fast_performance_level}</span> level
              </span>
            )}
            {advisor.expected_hours_per_month && (
              <span className="text-xs text-gray-500">
                <span className="font-medium text-gray-700 dark:text-gray-300">{advisor.expected_hours_per_month}h</span>/mo
              </span>
            )}
            {advisor.expected_meetings && (
              <span className="text-xs text-gray-500">{advisor.expected_meetings}</span>
            )}
            {advisor.expected_responsiveness && (
              <span className="text-xs text-gray-500">{advisor.expected_responsiveness}</span>
            )}
          </div>
          {advisor.duties && (
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{advisor.duties}</p>
          )}
        </div>
      )}

      {/* Notes */}
      {advisor.notes && (
        <div className="px-4 pb-4">
          <p className="text-xs text-gray-400 dark:text-gray-500 italic">{advisor.notes}</p>
        </div>
      )}

      {/* Last update sent + open status */}
      {advisor.last_update_sent_at && (
        <div className="px-4 pb-3 border-t border-gray-100 dark:border-gray-800 pt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Update sent{" "}
            {new Date(advisor.last_update_sent_at).toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </p>
          {advisor.last_open_at ? (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 flex-shrink-0">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
              Opened{advisor.last_open_count && advisor.last_open_count > 1 ? ` ×${advisor.last_open_count}` : ""}
            </span>
          ) : (
            <span className="text-xs text-gray-400 flex-shrink-0">Not opened</span>
          )}
        </div>
      )}

    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdvisorsPage() {
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [loading, setLoading] = useState(true);
  const [editAdvisor, setEditAdvisor] = useState<Advisor | null>(null);
  const [showSendUpdate, setShowSendUpdate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const advisorRes = await fetch("/api/proxy/advisors");
      if (advisorRes.ok) setAdvisors(await advisorRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Stats
  const totalEquity = advisors.reduce((s, a) => s + (a.equity_percent ?? 0), 0);
  const piiaOutstanding = advisors.filter((a) => !a.piia_issued).length;
  const piiaOverdue = advisors.filter((a) => !a.piia_issued && isOverdue(a.piia_due_date)).length;
  const docsLinked = advisors.filter((a) => a.faa_document_url || a.piia_document_url).length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Header row */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Advisors</h1>
          <button
            onClick={() => setShowSendUpdate(true)}
            disabled={advisors.length === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Send Update
          </button>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Total Advisors</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{advisors.length}</p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Equity Committed</p>
            <p className="text-2xl font-bold text-purple-700 dark:text-purple-400">{totalEquity.toFixed(2)}%</p>
          </div>
          <div className={`rounded-xl border p-4 ${piiaOverdue > 0
            ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
            : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800"}`}>
            <p className="text-xs text-gray-500 mb-1">PIIAs Outstanding</p>
            <p className={`text-2xl font-bold ${piiaOverdue > 0
              ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-gray-100"}`}>
              {piiaOutstanding}
              {piiaOverdue > 0 && <span className="text-sm ml-1 font-medium">({piiaOverdue} overdue)</span>}
            </p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-1">Docs Linked</p>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{docsLinked}
              <span className="text-sm font-normal text-gray-400 ml-1">/ {advisors.length}</span>
            </p>
          </div>
        </div>

        {/* Cards */}
        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading advisors…</div>
        ) : advisors.length === 0 ? (
          <div className="text-center py-16 text-gray-400">No advisors found.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {advisors.map((a) => (
              <AdvisorCard key={a.advisor_id} advisor={a} onEdit={() => setEditAdvisor(a)} onChanged={load} />
            ))}
          </div>
        )}
      </div>

      {editAdvisor && (
        <EditModal
          advisor={editAdvisor}
          onClose={() => setEditAdvisor(null)}
          onSaved={load}
        />
      )}

      {showSendUpdate && (
        <SendUpdateModal
          advisors={advisors}
          onClose={() => setShowSendUpdate(false)}
          onSent={load}
        />
      )}
    </div>
  );
}
