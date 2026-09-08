"use client";

import { useEffect, useState, useCallback, Suspense, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { bumpLogoCacheBust } from "@/components/LogoImage";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GoogleStatus {
  connected: boolean;
  google_email?: string;
  updated_at?: string;
}

interface GoogleSyncStatus {
  emails: number;
  meetings: number;
  last_synced?: string;
}

interface PlaidStatus {
  connected: boolean;
  institution_name?: string;
  connected_at?: string;
}

interface QboStatus {
  connected: boolean;
  realm_name?: string;
  connected_at?: string;
  last_synced?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} />
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
    </div>
  );
}

function ActionButton({
  onClick, disabled, variant = "default", children,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "primary";
  children: React.ReactNode;
}) {
  const base = "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40";
  const styles = {
    default: "border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800",
    danger: "border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950",
    primary: "bg-blue-600 text-white hover:bg-blue-700",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles[variant]}`}>
      {children}
    </button>
  );
}

// ── Google card ────────────────────────────────────────────────────────────────

function GoogleCard({ flash }: { flash?: string }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [syncStatus, setSyncStatus] = useState<GoogleSyncStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [msg, setMsg] = useState<string | null>(flash ?? null);

  const load = useCallback(async () => {
    const [s, ss] = await Promise.all([
      fetch("/api/proxy/contacts/google/status").then(r => r.ok ? r.json() : null),
      fetch("/api/proxy/contacts/google/sync-status").then(r => r.ok ? r.json() : null),
    ]);
    setStatus(s);
    setSyncStatus(ss);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy("connect");
    const r = await fetch("/api/proxy/contacts/google/auth");
    if (r.ok) {
      const { auth_url } = await r.json();
      window.location.href = auth_url;
    } else {
      setMsg("Failed to get Google auth URL.");
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    await fetch("/api/proxy/contacts/google/disconnect", { method: "DELETE" });
    setMsg("Google account disconnected.");
    setBusy(null);
    load();
  }

  async function sync() {
    setBusy("sync");
    setMsg(null);
    const r = await fetch("/api/proxy/contacts/google/sync", { method: "POST" });
    if (r.ok) {
      setMsg("Sync complete.");
      load();
    } else {
      setMsg("Sync failed.");
    }
    setBusy(null);
  }

  const connected = status?.connected ?? false;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* Google logo */}
          <div className="w-9 h-9 rounded-lg border border-gray-100 dark:border-gray-800 flex items-center justify-center bg-white dark:bg-gray-800 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Google</span>
              <StatusDot connected={connected} />
              <span className="text-xs text-gray-400">{connected ? "Connected" : "Not connected"}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Gmail · Calendar · Drive</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {connected ? (
            <>
              <ActionButton onClick={sync} disabled={busy !== null} variant="default">
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </ActionButton>
              <ActionButton onClick={disconnect} disabled={busy !== null} variant="danger">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </ActionButton>
            </>
          ) : (
            <ActionButton onClick={connect} disabled={busy !== null} variant="primary">
              {busy === "connect" ? "Redirecting…" : "Connect Google"}
            </ActionButton>
          )}
        </div>
      </div>

      {/* Detail row */}
      {status !== null && (
        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Account</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{status.google_email ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Last token refresh</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{fmt(status.updated_at)}</p>
          </div>
          {syncStatus && (
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Synced</p>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {syncStatus.emails} emails · {syncStatus.meetings} meetings
              </p>
            </div>
          )}
        </div>
      )}

      {/* Scope note */}
      {connected && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          If Drive file picker shows a scope error, disconnect and reconnect to grant the updated permissions.
        </p>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.toLowerCase().includes("fail") || msg.toLowerCase().includes("error") ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ── Plaid card ─────────────────────────────────────────────────────────────────


function StripeCard() {
  const [status, setStatus] = useState<any>(null);
  const [key, setKey] = useState("");
  const [whsec, setWhsec] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/proxy/stripe/status", { cache: "no-store" });
    if (r.ok) setStatus(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (path: string, body: any, what: string) => {
    setBusy(what); setMsg("");
    try {
      const r = await fetch(`/api/proxy/stripe/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail ?? `failed (${r.status})`);
      setMsg(d.account_name ? `Connected to ${d.account_name}.` : "Saved.");
      setKey(""); setWhsec("");
      await load();
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    finally { setBusy(""); }
  };

  const disconnect = async () => {
    if (!confirm("Forget the stored Stripe key? Invoices already sent stay in Stripe.")) return;
    setBusy("disconnect");
    await fetch("/api/proxy/stripe/connect", { method: "DELETE" });
    setMsg("Disconnected."); setBusy(""); load();
  };

  const connected = Boolean(status?.connected);
  const input = "w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 " +
                "bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 font-mono " +
                "focus:outline-none focus:ring-2 focus:ring-blue-500/30";

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <SectionHeader title="Stripe"
        description="Delivery and collection for invoices. The platform stays the system of record; Stripe emails a payable invoice and reports payment back." />

      <div className="flex items-center gap-2 mb-3">
        <StatusDot connected={connected} />
        <span className="text-xs text-gray-600 dark:text-gray-300">
          {connected
            ? `${status.account_name ?? status.account_id ?? "Connected"}${status.livemode ? " · live" : " · test mode"}`
            : "Not connected"}
        </span>
        {connected && status.fingerprint && (
          // The key itself is never returned; this is how you tell which one
          // is stored without the server ever handing it back.
          <span className="text-[10px] text-gray-400 font-mono">key …{status.fingerprint}</span>
        )}
        {connected && (
          <ActionButton onClick={disconnect} disabled={busy === "disconnect"} variant="danger">
            Disconnect
          </ActionButton>
        )}
      </div>

      {!connected && (
        <div className="flex gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)}
                 placeholder="sk_live_… or sk_test_…" className={input} />
          <ActionButton onClick={() => post("connect", { secret_key: key }, "connect")}
                        disabled={!key.trim() || busy === "connect"} variant="primary">
            {busy === "connect" ? "Checking…" : "Connect"}
          </ActionButton>
        </div>
      )}

      {connected && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <StatusDot connected={Boolean(status.webhook_configured)} />
            <span className="text-xs text-gray-600 dark:text-gray-300">
              {status.webhook_configured
                ? "Webhook signing secret stored"
                : "No webhook secret — payments will not come back on their own"}
            </span>
          </div>
          <p className="text-[10px] text-gray-400 font-mono break-all">
            Point the Stripe webhook at {status.webhook_url}
          </p>
          <div className="flex gap-2">
            <input value={whsec} onChange={(e) => setWhsec(e.target.value)}
                   placeholder="whsec_…" className={input} />
            <ActionButton onClick={() => post("webhook-secret", { webhook_secret: whsec }, "whsec")}
                          disabled={!whsec.trim() || busy === "whsec"}>
              {busy === "whsec" ? "Saving…" : "Save secret"}
            </ActionButton>
          </div>
        </div>
      )}

      {msg && <p className="mt-3 text-xs text-gray-500">{msg}</p>}
    </div>
  );
}

function PlaidCard() {
  const [status, setStatus] = useState<PlaidStatus | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/proxy/fpa/plaid/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  const { open: openPlaid, ready: plaidReady } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess: async (publicToken) => {
      await fetch("/api/proxy/fpa/plaid/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token: publicToken, institution_name: "Bank" }),
      });
      setMsg("Bank connected.");
      setBusy(null);
      setLinkToken(null);
      load();
    },
    onExit: () => { setBusy(null); setLinkToken(null); },
  });

  useEffect(() => {
    if (linkToken && plaidReady) openPlaid();
  }, [linkToken, plaidReady, openPlaid]);

  async function connect() {
    setBusy("connect");
    setMsg(null);
    const r = await fetch("/api/proxy/fpa/plaid/link-token", { method: "POST" });
    if (r.ok) {
      const data = await r.json();
      setLinkToken(data.link_token);
    } else {
      setMsg("Failed to initiate Plaid connection.");
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    await fetch("/api/proxy/fpa/plaid/disconnect", { method: "DELETE" });
    setMsg("Bank disconnected.");
    setBusy(null);
    load();
  }

  async function sync() {
    setBusy("sync");
    setMsg(null);
    const r = await fetch("/api/proxy/fpa/actuals/sync", { method: "POST" });
    setMsg(r.ok ? "Sync complete." : "Sync failed.");
    setBusy(null);
  }

  const connected = status?.connected ?? false;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg border border-gray-100 dark:border-gray-800 flex items-center justify-center bg-[#404040] shrink-0">
            <svg className="w-5 h-5 text-white" viewBox="0 0 32 32" fill="currentColor">
              <path d="M16 4C9.373 4 4 9.373 4 16s5.373 12 12 12 12-5.373 12-12S22.627 4 16 4zm0 21a9 9 0 110-18 9 9 0 010 18z"/>
              <circle cx="16" cy="16" r="4"/>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Plaid</span>
              <StatusDot connected={connected} />
              <span className="text-xs text-gray-400">{connected ? "Connected" : "Not connected"}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Bank account · Cash tracking</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {connected ? (
            <>
              <ActionButton onClick={sync} disabled={busy !== null}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </ActionButton>
              <ActionButton onClick={connect} disabled={busy !== null}>
                Reconnect
              </ActionButton>
              <ActionButton onClick={disconnect} disabled={busy !== null} variant="danger">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </ActionButton>
            </>
          ) : (
            <ActionButton onClick={connect} disabled={busy !== null} variant="primary">
              {busy === "connect" ? "Opening…" : "Connect Bank"}
            </ActionButton>
          )}
        </div>
      </div>

      {status !== null && connected && (
        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Institution</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{status.institution_name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Connected</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{fmt(status.connected_at)}</p>
          </div>
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.toLowerCase().includes("fail") ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ── QuickBooks card ────────────────────────────────────────────────────────────

function QuickBooksCard({ flash }: { flash?: string }) {
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | "sync" | null>(null);
  const [msg, setMsg] = useState<string | null>(flash ?? null);

  const load = useCallback(async () => {
    const r = await fetch("/api/proxy/fpa/qbo/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy("connect");
    setMsg(null);
    const r = await fetch("/api/proxy/fpa/qbo/auth-url");
    if (r.ok) {
      const { auth_url } = await r.json();
      window.location.href = auth_url;
    } else {
      setMsg("Failed to get QuickBooks auth URL.");
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    await fetch("/api/proxy/fpa/qbo/disconnect", { method: "DELETE" });
    setMsg("QuickBooks disconnected.");
    setBusy(null);
    load();
  }

  async function sync() {
    setBusy("sync");
    setMsg(null);
    const r = await fetch("/api/proxy/fpa/qbo/sync", { method: "POST" });
    setMsg(r.ok ? "Sync complete." : "Sync failed — check QBO connection.");
    setBusy(null);
  }

  const connected = status?.connected ?? false;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg border border-gray-100 dark:border-gray-800 flex items-center justify-center bg-[#404040] shrink-0">
            <span className="text-white text-xs font-bold">QB</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">QuickBooks Online</span>
              <StatusDot connected={connected} />
              <span className="text-xs text-gray-400">{connected ? "Connected" : "Not connected"}</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">P&L · Transactions · Categories</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {connected ? (
            <>
              <ActionButton onClick={sync} disabled={busy !== null}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </ActionButton>
              <ActionButton onClick={connect} disabled={busy !== null}>
                Reconnect
              </ActionButton>
              <ActionButton onClick={disconnect} disabled={busy !== null} variant="danger">
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </ActionButton>
            </>
          ) : (
            <ActionButton onClick={connect} disabled={busy !== null} variant="primary">
              {busy === "connect" ? "Redirecting…" : "Connect QuickBooks"}
            </ActionButton>
          )}
        </div>
      </div>

      {status !== null && connected && (
        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Company</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{status.realm_name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Connected</p>
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{fmt(status.connected_at)}</p>
          </div>
          {status.last_synced && (
            <div>
              <p className="text-xs text-gray-400 mb-0.5">Last synced</p>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{fmt(status.last_synced)}</p>
            </div>
          )}
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.toLowerCase().includes("fail") || msg.toLowerCase().includes("error") ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ── API Usage card ─────────────────────────────────────────────────────────────

interface UsageService {
  service: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_audio_seconds: number;
  total_cost_usd: string;
  last_called_at: string | null;
}

interface UsageOperation {
  service: string;
  operation: string;
  model: string | null;
  call_count: number;
  total_cost_usd: string;
}

interface KeyStatus {
  anthropic: boolean;
  deepgram: boolean;
  semantic_scholar: boolean;
  atcc: boolean;
}

const SERVICE_META: Record<string, { label: string; description: string; billing: string; color: string }> = {
  anthropic:        { label: "Anthropic Claude",   description: "AI agents — extraction, regulatory, compound discovery, SOP, composition, summaries", billing: "per token",        color: "bg-orange-500" },
  deepgram:         { label: "Deepgram",           description: "Live audio transcription in Lab Notebook",                                            billing: "per audio minute", color: "bg-purple-500" },
};

const KEY_META: { key: keyof KeyStatus; label: string; description: string; billing: string }[] = [
  { key: "anthropic",       label: "Anthropic Claude",    description: "AI agents",                 billing: "per token" },
  { key: "deepgram",        label: "Deepgram",            description: "Audio transcription",       billing: "per audio min" },
  { key: "semantic_scholar",label: "Semantic Scholar",    description: "Literature search",         billing: "free" },
  { key: "atcc",            label: "ATCC",                description: "Strain / genome metadata",  billing: "subscription" },
];

// Other read-only APIs (always connected, no key needed)
const STATIC_APIS = [
  { label: "PubMed / NCBI",  description: "Literature mining",         billing: "free" },
  { label: "FDA GRAS / eCFR",description: "US regulatory data",        billing: "free" },
  { label: "EFSA",           description: "EU regulatory data",        billing: "free" },
  { label: "ChEBI",          description: "Chemical entity ontology",  billing: "free" },
  { label: "LOTUS / COCONUT",description: "Natural compound databases",billing: "free" },
  { label: "FooDB",          description: "Food compound database",    billing: "free" },
];

function fmtUsd(val: string | number) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function fmtAudioMins(secs: number) {
  return `${(secs / 60).toFixed(1)} min`;
}

function ApiUsageCard() {
  const [period, setPeriod] = useState(30);
  const [usage, setUsage] = useState<{ by_service: UsageService[]; by_operation: UsageOperation[]; all_time_cost_usd: number } | null>(null);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    const [u, k] = await Promise.all([
      fetch(`/api/proxy/dev/api-usage?period=${p}`).then(r => r.ok ? r.json() : null),
      fetch("/api/proxy/dev/api-key-status").then(r => r.ok ? r.json() : null),
    ]);
    setUsage(u);
    setKeys(k);
    setLoading(false);
  }, []);

  useEffect(() => { load(period); }, [load, period]);

  const totalPeriod = usage?.by_service.reduce((s, r) => s + parseFloat(r.total_cost_usd), 0) ?? 0;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">API usage &amp; costs</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Live spend across all metered APIs</p>
        </div>
        <select
          value={period}
          onChange={e => setPeriod(Number(e.target.value))}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </select>
      </div>

      {/* Spend summary row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <p className="text-xs text-gray-400 mb-1">This period</p>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loading ? "—" : fmtUsd(totalPeriod)}</p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
          <p className="text-xs text-gray-400 mb-1">All time</p>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">{loading ? "—" : fmtUsd(usage?.all_time_cost_usd ?? 0)}</p>
        </div>
      </div>

      {/* Per-service metered spend */}
      {!loading && usage && usage.by_service.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">By service</p>
          <div className="space-y-2">
            {usage.by_service.map(row => {
              const meta = SERVICE_META[row.service];
              return (
                <div key={row.service} className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${meta?.color ?? "bg-gray-400"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-800 dark:text-gray-200">{meta?.label ?? row.service}</span>
                      <span className="text-xs font-semibold text-gray-900 dark:text-gray-100 shrink-0">{fmtUsd(row.total_cost_usd)}</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {row.call_count} calls
                      {row.total_input_tokens > 0 && ` · ${fmtTokens(row.total_input_tokens)} in / ${fmtTokens(row.total_output_tokens)} out tokens`}
                      {row.total_audio_seconds > 0 && ` · ${fmtAudioMins(row.total_audio_seconds)}`}
                      {row.last_called_at && ` · last ${new Date(row.last_called_at).toLocaleDateString()}`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-operation breakdown */}
      {!loading && usage && usage.by_operation.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">By operation</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-800">
                <th className="text-left pb-1 font-medium">Operation</th>
                <th className="text-left pb-1 font-medium">Model</th>
                <th className="text-right pb-1 font-medium">Calls</th>
                <th className="text-right pb-1 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
              {usage.by_operation.map((row, i) => (
                <tr key={i} className="text-gray-700 dark:text-gray-300">
                  <td className="py-1 capitalize">{row.operation.replace(/_/g, " ")}</td>
                  <td className="py-1 text-gray-400 font-mono text-xs truncate max-w-[120px]">{row.model ?? "—"}</td>
                  <td className="py-1 text-right">{row.call_count}</td>
                  <td className="py-1 text-right font-medium">{fmtUsd(row.total_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && usage && usage.by_service.length === 0 && (
        <p className="text-xs text-gray-400 text-center py-2">No API calls logged yet in this period.</p>
      )}

      {/* API key status */}
      <div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Connected APIs</p>
        <div className="space-y-1">
          {KEY_META.map(({ key, label, description, billing }) => (
            <div key={key} className="flex items-center gap-3 py-1">
              <StatusDot connected={keys?.[key] ?? false} />
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1">{label}</span>
              <span className="text-xs text-gray-400">{description}</span>
              <span className="text-xs text-gray-400 ml-4 shrink-0">{billing}</span>
            </div>
          ))}
          {STATIC_APIS.map(({ label, description, billing }) => (
            <div key={label} className="flex items-center gap-3 py-1">
              <StatusDot connected={true} />
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1">{label}</span>
              <span className="text-xs text-gray-400">{description}</span>
              <span className="text-xs text-gray-400 ml-4 shrink-0">{billing}</span>
            </div>
          ))}
          {/* OAuth connections (always show as status-only) */}
          {[
            { label: "Google (OAuth)", description: "Gmail · Calendar · Drive", billing: "free" },
            { label: "Plaid",          description: "Bank connectivity",          billing: "subscription" },
            { label: "QuickBooks",     description: "P&L · Transactions",         billing: "subscription" },
          ].map(({ label, description, billing }) => (
            <div key={label} className="flex items-center gap-3 py-1">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-400 shrink-0" />
              <span className="text-xs text-gray-700 dark:text-gray-300 flex-1">{label}</span>
              <span className="text-xs text-gray-400">{description}</span>
              <span className="text-xs text-gray-400 ml-4 shrink-0">{billing}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page inner (needs useSearchParams) ────────────────────────────────────────

// ── Branding card ─────────────────────────────────────────────────────────────

function BrandingCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [logoKey, setLogoKey] = useState(Date.now());

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setStatus(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/logo", { method: "POST", body: fd });
      if (r.ok) {
        bumpLogoCacheBust();
        setLogoKey(Date.now());
        setStatus({ ok: true, msg: "Logo updated." });
      } else {
        const d = await r.json().catch(() => ({}));
        setStatus({ ok: false, msg: d?.detail ?? "Upload failed." });
      }
    } catch {
      setStatus({ ok: false, msg: "Upload failed." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleReset() {
    setUploading(true);
    setStatus(null);
    try {
      await fetch("/api/logo", { method: "DELETE" });
      bumpLogoCacheBust();
      setLogoKey(Date.now());
      setStatus({ ok: true, msg: "Logo reset to default." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Branding"
        description="Upload your company logo. Shown in the sidebar, login page, and client portals. PNG, JPEG, or SVG, max 5 MB."
      />
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 space-y-4">
        {/* Preview */}
        <div className="flex items-center gap-4">
          <div className="w-40 h-16 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex items-center justify-center p-3">
            <img
              key={logoKey}
              src={`/api/logo?v=${logoKey}`}
              alt="Current logo"
              className="max-h-full max-w-full object-contain"
              onError={(e) => { const i = e.currentTarget; if (!i.src.includes("logo.svg")) i.src = "/logo.svg"; }}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium"
              >
                {uploading ? "Uploading…" : "Upload logo"}
              </button>
              <button
                onClick={handleReset}
                disabled={uploading}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
              >
                Reset
              </button>
            </div>
            <p className="text-xs text-gray-400">PNG, JPEG, SVG or WebP · max 5 MB</p>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={handleUpload}
        />

        {status && (
          <p className={`text-xs ${status.ok ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
            {status.msg}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Notification Preferences card ─────────────────────────────────────────────

function NotificationPreferencesCard() {
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/proxy/notifications/preferences")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNotifyEmail(d.notify_email ?? false); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await fetch("/api/proxy/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notify_email: notifyEmail }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="notifications" className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notification delivery</h3>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Get notified by email when a task or project is assigned to you. In-app notifications are always enabled.
          </p>

          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-xs font-medium text-gray-800 dark:text-gray-200">Email notifications</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Send an email to your account address on new assignments</p>
            </div>
            <button
              onClick={() => setNotifyEmail(v => !v)}
              aria-pressed={notifyEmail}
              className={`relative w-10 h-5 rounded-full transition-colors ${notifyEmail ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${notifyEmail ? "left-5" : "left-0.5"}`} />
            </button>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 font-medium transition-colors"
            >
              {saving ? "Saving…" : "Save preferences"}
            </button>
            {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsInner() {
  const searchParams = useSearchParams();
  const googleConnected = searchParams.get("google_connected") === "1";
  const googleError = searchParams.get("google_error");
  const qboConnected = searchParams.get("qbo") === "connected";

  // Determine if current user is admin
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/proxy/users/me")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.role === "admin") setIsAdmin(true); })
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-2xl mx-auto space-y-8">

      {/* Your integrations */}
      <div>
        <SectionHeader
          title="Your integrations"
          description="Personal connections tied to your account. Each user manages their own."
        />
        <div className="space-y-3">
          <GoogleCard
            flash={
              googleConnected ? "Google account connected successfully." :
              googleError ? `Google connection failed: ${googleError.replace(/_/g, " ")}` :
              undefined
            }
          />
        </div>
      </div>

      {/* Notification preferences */}
      <div>
        <SectionHeader
          title="Notifications"
          description="Choose how you want to be notified when tasks or projects are assigned to you."
        />
        <NotificationPreferencesCard />
      </div>

      {/* Platform integrations — admin only */}
      {isAdmin && (
        <div>
          <SectionHeader
            title="Platform integrations"
            description="Shared connections used by the entire platform. Admin only."
          />
          <div className="space-y-3">
            <StripeCard />
            <PlaidCard />
            <QuickBooksCard flash={qboConnected ? "QuickBooks connected successfully." : undefined} />
          </div>
        </div>
      )}

      {/* API usage & costs — admin only */}
      {isAdmin && (
        <div>
          <SectionHeader
            title="API usage &amp; costs"
            description="Metered API spend and connection status for all platform integrations. Admin only."
          />
          <ApiUsageCard />
        </div>
      )}

      {/* Branding — admin only */}
      {isAdmin && <BrandingCard />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
