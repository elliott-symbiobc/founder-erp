"use client";

import { useEffect, useRef, useState } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  extracted_tasks?: { task_id: string; title: string; urgency: string }[];
  extracted_followups?: { type: string; id: string; title: string; contact_name?: string; due_date?: string }[];
  suggest_replan?: boolean;
  loading?: boolean;
}

const QUICK_PROMPTS = [
  "What should I focus on first today?",
  "How's my pipeline looking?",
  "What's overdue right now?",
  "Summarize my business health",
];

export default function SuperkojiPanel({
  onTasksCreated = () => {},
  onSuggestReplan = () => {},
}: {
  onTasksCreated?: () => void;
  onSuggestReplan?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && messages.length === 0) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
      setMessages([{
        role: "assistant",
        content: `${greeting}. I have your live business data ready. You can give me a brain dump, ask about priorities, or ask anything about your pipeline, tasks, or financials.`,
      }]);
    }
  }, [open, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text?: string) {
    const userText = (text ?? input).trim();
    if (!userText || loading) return;
    setInput("");
    const userMsg: ChatMsg = { role: "user", content: userText };
    const loadingMsg: ChatMsg = { role: "assistant", content: "", loading: true };
    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setLoading(true);
    try {
      const history = [...messages.filter(m => !m.loading), userMsg].map(m => ({
        role: m.role, content: m.content,
      }));
      const res = await fetch("/api/proxy/planner/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (res.ok) {
        const data = await res.json();
        const assistantMsg: ChatMsg = {
          role: "assistant",
          content: data.reply,
          extracted_tasks: data.extracted_tasks?.length > 0 ? data.extracted_tasks : undefined,
          extracted_followups: data.extracted_followups?.length > 0 ? data.extracted_followups : undefined,
          suggest_replan: data.suggest_replan,
        };
        setMessages(prev => [...prev.filter(m => !m.loading), assistantMsg]);
        if (data.extracted_tasks?.length > 0) onTasksCreated();
        if (data.suggest_replan) onSuggestReplan();
      } else {
        setMessages(prev => [...prev.filter(m => !m.loading), {
          role: "assistant", content: "Sorry, I ran into an issue. Try again in a moment.",
        }]);
      }
    } catch {
      setMessages(prev => [...prev.filter(m => !m.loading), {
        role: "assistant", content: "Network error. Please try again.",
      }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Collapsed pill
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all group"
        title="Open Superkoji"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/superkoji.png" alt="Superkoji" className="w-10 h-10 object-contain" />
        <span className="text-sm font-light text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors">Superkoji</span>
      </button>
    );
  }

  // Expanded overlay panel — drops down from the header
  return (
    <div className="absolute left-0 top-full mt-1 z-50 w-[500px] bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-2xl">
      {/* Panel header */}
      <button
        onClick={() => setOpen(false)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/superkoji.png" alt="Superkoji" className="w-10 h-10 object-contain flex-shrink-0" />
          <div className="text-left">
            <p className="text-sm font-light text-gray-900 dark:text-gray-100">Superkoji</p>
            <p className="text-xs font-light text-gray-400 dark:text-gray-500">Brain dump, priorities, business Q&A</p>
          </div>
        </div>
        <svg className="w-4 h-4 text-gray-400 rotate-180" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Messages */}
      <div className="border-t border-gray-100 dark:border-gray-800 px-4 py-3 space-y-3 max-h-72 overflow-y-auto">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/superkoji.png" alt="" className="w-6 h-6 object-contain flex-shrink-0 mt-0.5" />
            )}
            <div className={`max-w-[80%] ${msg.role === "user" ? "order-last" : ""}`}>
              {msg.loading ? (
                <div className="flex items-center gap-1.5 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-tl-sm">
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              ) : (
                <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-tl-sm"
                }`}>
                  {msg.content}
                </div>
              )}
              {msg.extracted_tasks && msg.extracted_tasks.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 px-1">Added to tasks:</p>
                  {msg.extracted_tasks.map(t => (
                    <div key={t.task_id} className="flex items-center gap-1.5 px-2 py-1 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg">
                      <svg className="w-3 h-3 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-xs text-green-700 dark:text-green-400">{t.title}</span>
                      <span className={`ml-auto text-[10px] font-medium ${t.urgency === "high" ? "text-red-500" : t.urgency === "medium" ? "text-amber-500" : "text-gray-400"}`}>
                        {t.urgency}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {msg.extracted_followups && msg.extracted_followups.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400 px-1">Follow-up reminders added:</p>
                  {msg.extracted_followups.map(f => (
                    <div key={f.id} className="flex items-center gap-1.5 px-2 py-1 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
                      <svg className="w-3 h-3 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                      </svg>
                      <span className="text-xs text-blue-700 dark:text-blue-400 flex-1 min-w-0 truncate">{f.title}</span>
                      {f.contact_name && <span className="text-[10px] text-blue-500 flex-shrink-0">{f.contact_name}</span>}
                    </div>
                  ))}
                </div>
              )}
              {msg.suggest_replan && (
                <div className="mt-1.5 px-1">
                  <p className="text-xs text-blue-600 dark:text-blue-400 cursor-pointer hover:underline" onClick={onSuggestReplan}>
                    → Regenerate today's plan with new tasks
                  </p>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Quick prompts */}
      {messages.length <= 1 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {QUICK_PROMPTS.map(p => (
            <button key={p} onClick={() => send(p)}
              className="text-xs px-2.5 py-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600 transition-colors">
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t border-gray-100 dark:border-gray-800 px-3 py-2 flex items-end gap-2">
        <AutoTextarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Brain dump, ask about priorities, or any business question…"
          rows={1}
          className="flex-1 text-sm bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400 max-h-32 transition-all"
          style={{ minHeight: "40px" }}
        />
        <button
          onClick={() => send()}
          disabled={!input.trim() || loading}
          className="w-9 h-9 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
          aria-label="Send"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.269 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
