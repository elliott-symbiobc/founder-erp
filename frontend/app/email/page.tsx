"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Types ──────────────────────────────────────────────────────────────────

interface EmailMessage {
  id: string;
  thread_id: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  label_ids: string[];
  is_read: boolean;
}

interface EmailDetail extends EmailMessage {
  cc: string;
  plain_body: string;
  html_body: string;
}

interface ComposeData {
  to?: string;
  to_name?: string;
  subject?: string;
  body?: string;
  contact_id?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/^"?([^"<]+?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: raw, email: raw };
}

function fmtDate(raw: string): string {
  if (!raw) return "";
  try {
    const d = new Date(raw);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const diffDays = (now.getTime() - d.getTime()) / 86400000;
    if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return raw.slice(0, 10);
  }
}

function avatarInitial(from: string): string {
  const { name } = parseFrom(from);
  return name.charAt(0).toUpperCase() || "?";
}

function avatarColor(from: string): string {
  const colors = [
    "bg-blue-500", "bg-purple-500", "bg-green-500", "bg-orange-500",
    "bg-pink-500", "bg-teal-500", "bg-indigo-500", "bg-rose-500",
  ];
  let hash = 0;
  for (let i = 0; i < from.length; i++) hash = from.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ── Compose Modal ──────────────────────────────────────────────────────────

function ComposeModal({
  initial,
  onClose,
  onSent,
}: {
  initial?: ComposeData;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [to, setTo] = useState(initial?.to ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [cc, setCc] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      setError("To, subject, and body are required.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/proxy/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          to_name: initial?.to_name,
          subject: subject.trim(),
          body: body.trim(),
          cc: cc ? cc.split(",").map((v) => v.trim()).filter(Boolean) : [],
          contact_id: initial?.contact_id ?? null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || "Send failed");
      }
      onSent?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="pointer-events-auto w-[540px] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800 dark:bg-gray-950 rounded-t-2xl">
          <span className="text-sm font-medium text-white">New Message</span>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Fields */}
        <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To"
            className="px-4 py-2.5 text-sm bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none"
          />
          <input
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="Cc"
            className="px-4 py-2.5 text-sm bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none"
          />
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="px-4 py-2.5 text-sm bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none font-medium"
          />
        </div>

        {/* Body */}
        <AutoTextarea
          autoGrow={false}  /* compose pane is flex-1 inside a flex-col */
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Compose email…"
          rows={10}
          className="flex-1 px-4 py-3 text-sm bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none resize-none"
        />

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800">
          {error && <p className="text-xs text-red-500 flex-1 mr-4">{error}</p>}
          {!error && <span />}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              Discard
            </button>
            <button
              onClick={send}
              disabled={sending}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Message Detail Panel ───────────────────────────────────────────────────

function MessageDetail({
  messageId,
  onClose,
  onReply,
}: {
  messageId: string;
  onClose: () => void;
  onReply: (data: ComposeData) => void;
}) {
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHtml, setShowHtml] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    fetch(`/api/proxy/email/message/${messageId}`)
      .then((r) => r.json())
      .then((d) => {
        setDetail(d);
        // Mark as read
        fetch(`/api/proxy/email/mark-read/${messageId}`, { method: "POST" }).catch(() => {});
      })
      .finally(() => setLoading(false));
  }, [messageId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading message…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Failed to load message.
      </div>
    );
  }

  const { name: fromName, email: fromEmail } = parseFrom(detail.from);

  function handleReply() {
    onReply({
      to: fromEmail,
      to_name: fromName,
      subject: detail!.subject.startsWith("Re:") ? detail!.subject : `Re: ${detail!.subject}`,
    });
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Detail header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="flex gap-2">
          {detail.html_body && (
            <button
              onClick={() => setShowHtml((v) => !v)}
              className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              {showHtml ? "Plain text" : "Rich view"}
            </button>
          )}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${detail.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Open in Gmail ↗
          </a>
        </div>
      </div>

      {/* Subject */}
      <div className="px-6 pt-5 pb-3 flex-shrink-0">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 leading-snug">
          {detail.subject}
        </h2>
      </div>

      {/* Sender row */}
      <div className="px-6 pb-4 flex items-start gap-3 flex-shrink-0">
        <div
          className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-white text-sm font-semibold ${avatarColor(detail.from)}`}
        >
          {avatarInitial(detail.from)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{fromName}</span>
            <span className="text-xs text-gray-400">&lt;{fromEmail}&gt;</span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            To: {detail.to}
            {detail.cc && <span className="ml-2">Cc: {detail.cc}</span>}
          </div>
          <div className="text-xs text-gray-400">{detail.date}</div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {showHtml && detail.html_body ? (
          <iframe
            ref={iframeRef}
            srcDoc={detail.html_body}
            sandbox="allow-same-origin"
            className="w-full min-h-[400px] border-0 rounded-lg bg-white"
            onLoad={() => {
              if (iframeRef.current?.contentDocument) {
                const h = iframeRef.current.contentDocument.body?.scrollHeight;
                if (h) iframeRef.current.style.height = `${h + 32}px`;
              }
            }}
          />
        ) : (
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans leading-relaxed">
            {detail.plain_body || detail.snippet}
          </pre>
        )}
      </div>

      {/* Reply bar */}
      <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex-shrink-0">
        <button
          onClick={handleReply}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
          Reply
        </button>
      </div>
    </div>
  );
}

// ── Message Row ────────────────────────────────────────────────────────────

function MessageRow({
  msg,
  selected,
  onClick,
}: {
  msg: EmailMessage;
  selected: boolean;
  onClick: () => void;
}) {
  const { name } = parseFrom(msg.from);
  const unread = !msg.is_read;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors border-b border-gray-100 dark:border-gray-800 ${
        selected ? "bg-blue-50 dark:bg-blue-950/40 border-l-2 border-l-blue-500" : ""
      }`}
    >
      <div
        className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-semibold mt-0.5 ${avatarColor(msg.from)}`}
      >
        {avatarInitial(msg.from)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm truncate ${unread ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"}`}>
            {name}
          </span>
          <span className="text-xs text-gray-400 flex-shrink-0">{fmtDate(msg.date)}</span>
        </div>
        <p className={`text-sm truncate mt-0.5 ${unread ? "font-medium text-gray-800 dark:text-gray-200" : "text-gray-600 dark:text-gray-400"}`}>
          {msg.subject}
        </p>
        <p className="text-xs text-gray-400 truncate mt-0.5 leading-snug">{msg.snippet}</p>
      </div>
      {unread && (
        <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-2" />
      )}
    </button>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

function EmailPageInner() {
  const searchParams = useSearchParams();
  const [folder, setFolder] = useState<"inbox" | "sent">("inbox");
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("message"));
  const [compose, setCompose] = useState<ComposeData | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Check Gmail connection status
  useEffect(() => {
    fetch("/api/proxy/email/status")
      .then((r) => r.json())
      .then((d) => setConnected(d.connected))
      .catch(() => setConnected(false));
  }, []);

  const loadMessages = useCallback(
    async (pageToken?: string) => {
      if (pageToken) setLoadingMore(true);
      else setLoadingList(true);
      try {
        const params = new URLSearchParams({ max_results: "25" });
        if (pageToken) params.set("page_token", pageToken);
        const endpoint = folder === "inbox" ? "inbox" : "sent";
        const res = await fetch(`/api/proxy/email/${endpoint}?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        if (pageToken) {
          setMessages((prev) => [...prev, ...(data.messages || [])]);
        } else {
          setMessages(data.messages || []);
          setSelectedId(null);
        }
        setNextPageToken(data.next_page_token ?? null);
      } finally {
        setLoadingList(false);
        setLoadingMore(false);
      }
    },
    [folder]
  );

  useEffect(() => {
    if (connected) loadMessages();
  }, [connected, loadMessages]);

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        Checking Gmail connection…
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Gmail not connected</p>
          <p className="text-xs text-gray-400 mt-1">Connect your Gmail account via Settings to use the Email module.</p>
        </div>
        <a
          href="/settings"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Go to Settings
        </a>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 -m-4 md:-m-6 overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="w-52 flex-shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 pt-4">
        {/* Compose */}
        <div className="px-3 mb-4">
          <button
            onClick={() => setCompose({})}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-2xl shadow-sm transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Compose
          </button>
        </div>

        {/* Folders */}
        <nav className="flex flex-col gap-0.5 px-2">
          {(["inbox", "sent"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFolder(f)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors capitalize ${
                folder === f
                  ? "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-medium"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {f === "inbox" ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H6.911a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
              {f}
            </button>
          ))}
        </nav>
      </aside>

      {/* ── Message list ── */}
      <div className="w-80 flex-shrink-0 flex flex-col border-r border-gray-200 dark:border-gray-800 overflow-hidden">
        {/* List header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 capitalize">{folder}</h3>
          <button
            onClick={() => loadMessages()}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center py-16 text-gray-400 text-sm">
              Loading…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <svg className="w-8 h-8 mb-2 opacity-40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
              <p className="text-sm">No messages</p>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <MessageRow
                  key={msg.id}
                  msg={msg}
                  selected={selectedId === msg.id}
                  onClick={() => setSelectedId(msg.id)}
                />
              ))}
              {nextPageToken && (
                <div className="p-4 text-center">
                  <button
                    onClick={() => loadMessages(nextPageToken)}
                    disabled={loadingMore}
                    className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Detail panel ── */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-white dark:bg-gray-900">
        {selectedId ? (
          <MessageDetail
            messageId={selectedId}
            onClose={() => setSelectedId(null)}
            onReply={(data) => setCompose(data)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
            <svg className="w-12 h-12 opacity-20" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
            <p className="text-sm">Select a message to read it</p>
          </div>
        )}
      </div>

      {/* ── Compose overlay ── */}
      {compose !== null && (
        <ComposeModal
          initial={compose}
          onClose={() => setCompose(null)}
          onSent={() => {
            if (folder === "sent") loadMessages();
          }}
        />
      )}
    </div>
  );
}

export default function EmailPage() {
  return (
    <Suspense>
      <EmailPageInner />
    </Suspense>
  );
}