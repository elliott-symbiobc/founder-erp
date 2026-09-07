"use client";

/**
 * Who can get into a data room.
 *
 * Two lists that feed each other: the allowlist of emails cleared to register,
 * and the queue of requests from people who aren't on it. Approving a request
 * moves that address onto the allowlist and emails them a link.
 */

import { useCallback, useEffect, useState } from "react";

interface AllowedEmail {
  allow_id: string;
  email: string;
  name: string | null;
  firm: string | null;
  created_at: string;
  is_registered: boolean;
  viewer_active: boolean | null;
}

interface AccessRequest {
  request_id: string;
  email: string;
  name: string | null;
  firm: string | null;
  note: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at: string | null;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function RoomAccessList({ portalId }: { portalId: string }) {
  const base = `/api/proxy/portals/room/${portalId}`;

  const [allowed, setAllowed]   = useState<AllowedEmail[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState<string | null>(null);

  const [showAdd, setShowAdd]   = useState(false);
  const [draft, setDraft]       = useState("");
  const [result, setResult]     = useState<{ added: string[]; skipped: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, r] = await Promise.all([
      fetch(`${base}/allowed-emails`).then(x => (x.ok ? x.json() : [])),
      fetch(`${base}/access-requests`).then(x => (x.ok ? x.json() : [])),
    ]);
    setAllowed(a);
    setRequests(r);
    setLoading(false);
  }, [base]);

  useEffect(() => { load(); }, [load]);

  async function addEmails(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    const r = await fetch(`${base}/allowed-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: draft }),
    });
    if (r.ok) {
      setResult(await r.json());
      setDraft("");
      await load();
    }
    setBusy(null);
  }

  async function removeEmail(id: string) {
    setBusy(id);
    await fetch(`${base}/allowed-emails/${id}`, { method: "DELETE" });
    await load();
    setBusy(null);
  }

  async function decide(id: string, status: "approved" | "denied") {
    setBusy(id);
    await fetch(`${base}/access-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
    setBusy(null);
  }

  const pending = requests.filter(r => r.status === "pending");
  const decided = requests.filter(r => r.status !== "pending");

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <p className="text-sm text-gray-400">Loading access list…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* Pending requests first — this is the list that needs a decision */}
      {pending.length > 0 && (
        <div className="bg-amber-50/60 dark:bg-amber-950/20 rounded-xl border border-amber-200 dark:border-amber-900/50">
          <div className="px-4 py-3 border-b border-amber-100 dark:border-amber-900/40">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 uppercase tracking-wider">
              Pending requests — {pending.length}
            </p>
          </div>
          <div className="divide-y divide-amber-100 dark:divide-amber-900/40">
            {pending.map(r => (
              <div key={r.request_id} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {r.name || r.email}
                    {r.firm && <span className="font-normal text-gray-500 dark:text-gray-400"> · {r.firm}</span>}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{r.email}</p>
                  {r.note && (
                    <p className="text-xs text-gray-600 dark:text-gray-300 mt-1.5 leading-relaxed">{r.note}</p>
                  )}
                  <p className="text-[11px] text-gray-400 mt-1">Requested {fmtDate(r.created_at)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => decide(r.request_id, "approved")}
                    disabled={busy === r.request_id}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 font-medium"
                  >
                    {busy === r.request_id ? "…" : "Approve"}
                  </button>
                  <button
                    onClick={() => decide(r.request_id, "denied")}
                    disabled={busy === r.request_id}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:text-red-600 disabled:opacity-40"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="px-4 py-2.5 text-[11px] text-amber-700 dark:text-amber-400 border-t border-amber-100 dark:border-amber-900/40">
            Approving adds the address to the list below and emails them a link to set a password.
          </p>
        </div>
      )}

      {/* Allowlist */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <div>
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Access list — {allowed.length}
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Anyone here can open the link, enter their email and set a password.
            </p>
          </div>
          <button
            onClick={() => { setShowAdd(v => !v); setResult(null); }}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
          >
            {showAdd ? "Cancel" : "+ Add emails"}
          </button>
        </div>

        {showAdd && (
          <form onSubmit={addEmails} className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30 space-y-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={4}
              autoFocus
              placeholder={'Paste addresses — one per line or comma separated.\nJane Doe <jane@fund.com>\nsam@vc.com'}
              className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none font-mono"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-gray-400">
                Adding an address does not email anyone — send them the link yourself.
              </p>
              <button
                type="submit"
                disabled={busy === "add" || !draft.trim()}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium shrink-0"
              >
                {busy === "add" ? "Adding…" : "Add to list"}
              </button>
            </div>
            {result && (
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                Added {result.added.length}
                {result.skipped.length > 0 && ` · skipped ${result.skipped.length} (already listed or unparseable)`}
              </p>
            )}
          </form>
        )}

        {allowed.length === 0 ? (
          <p className="px-4 py-6 text-xs text-gray-400 text-center">
            Nobody is on the list yet, so nobody can get in.
          </p>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {allowed.map(a => (
              <div key={a.allow_id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {a.name || a.email}
                    {a.firm && <span className="text-gray-500 dark:text-gray-400"> · {a.firm}</span>}
                  </p>
                  {a.name && <p className="text-[11px] text-gray-400 truncate">{a.email}</p>}
                </div>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                    a.is_registered
                      ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {a.is_registered ? "Registered" : "Not yet registered"}
                </span>
                <button
                  onClick={() => removeEmail(a.allow_id)}
                  disabled={busy === a.allow_id}
                  className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-40 shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Decided requests, for the record */}
      {decided.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          <p className="px-4 py-3 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-100 dark:border-gray-800">
            Decided requests — {decided.length}
          </p>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {decided.map(r => (
              <div key={r.request_id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{r.name || r.email}</p>
                  <p className="text-[11px] text-gray-400 truncate">{r.email}</p>
                </div>
                <span
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                    r.status === "approved"
                      ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {r.status === "approved" ? "Approved" : "Denied"}
                </span>
                <span className="text-[11px] text-gray-400 shrink-0">
                  {r.decided_at ? fmtDate(r.decided_at) : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
