"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";

export interface Channel {
  channel_id: string;
  name: string | null;
  channel_type: string;
  other_member_names: string[];
  last_message: string | null;
  last_message_at: string | null;
  unread_count: number;
}

interface Message {
  message_id: string;
  channel_id: string;
  sender_id: string | null;
  sender_name: string | null;
  sender_display_name: string | null;
  body: string;
  is_announcement: boolean;
  portal_token: string | null;
  created_at: string;
}

interface TeamUser {
  user_id: string;
  name: string | null;
  email: string;
}

export function InboxCard({ unread, onClick }: { unread: number; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md hover:shadow-gray-200/60 dark:hover:shadow-black/20 hover:-translate-y-0.5 transition-all text-left group">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Inbox</span>
        <span className={`transition-colors ${unread > 0 ? "text-blue-500" : "text-gray-300 dark:text-gray-600 group-hover:text-blue-400"}`}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        </span>
      </div>
      <p className="text-3xl font-bold text-gray-900 dark:text-gray-100 leading-none mb-1">{unread}</p>
      <p className={`text-xs font-medium ${unread > 0 ? "text-blue-500" : "text-green-600 dark:text-green-400"}`}>
        {unread > 0 ? `unread message${unread === 1 ? "" : "s"}` : "all read"}
      </p>
    </button>
  );
}

export default function MessagingDrawer({ open, onClose, onUnreadChange }: {
  open: boolean;
  onClose: () => void;
  onUnreadChange: () => void;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [msgText, setMsgText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newMode, setNewMode] = useState<"dm" | "group">("dm");
  const [userSearch, setUserSearch] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<TeamUser[]>([]);
  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    loadChannels();
    fetch("/api/proxy/messaging/users")
      .then(r => r.ok ? r.json() : [])
      .then(setTeamUsers)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (activeChannel && open) {
      loadMessages(activeChannel.channel_id);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => loadMessages(activeChannel.channel_id), 5000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeChannel?.channel_id, open]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadChannels() {
    const res = await fetch("/api/proxy/messaging/channels").catch(() => null);
    if (res?.ok) setChannels(await res.json());
  }

  async function loadMessages(channelId: string) {
    setLoadingMsgs(true);
    const res = await fetch(`/api/proxy/messaging/channels/${channelId}/messages`).catch(() => null);
    if (res?.ok) setMessages(await res.json());
    setLoadingMsgs(false);
    fetch(`/api/proxy/messaging/channels/${channelId}/read`, { method: "PATCH" }).catch(() => {});
    onUnreadChange();
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!msgText.trim() || !activeChannel || sending) return;
    setSending(true);
    const body = msgText.trim();
    setMsgText("");
    try {
      const res = await fetch(`/api/proxy/messaging/channels/${activeChannel.channel_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        const msg = await res.json();
        setMessages(prev => [...prev, msg]);
      }
    } finally { setSending(false); }
  }

  async function startDM(u: TeamUser) {
    setCreating(true);
    try {
      const res = await fetch("/api/proxy/messaging/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_type: "direct", member_ids: [u.user_id] }),
      });
      if (res.ok) {
        const ch = await res.json();
        await loadChannels();
        setActiveChannel(ch);
        setShowNew(false);
        setUserSearch("");
        setSelectedUsers([]);
      }
    } finally { setCreating(false); }
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!groupName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/proxy/messaging/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: groupName.trim(),
          channel_type: "group",
          member_ids: selectedUsers.map(u => u.user_id),
        }),
      });
      if (res.ok) {
        const ch = await res.json();
        await loadChannels();
        setActiveChannel(ch);
        setShowNew(false);
        setGroupName("");
        setSelectedUsers([]);
        setUserSearch("");
      }
    } finally { setCreating(false); }
  }

  async function deleteChannel(ch: Channel) {
    const label = ch.channel_type === "direct" ? "conversation" : "group";
    if (!confirm(`Delete this ${label}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/proxy/messaging/channels/${ch.channel_id}`, { method: "DELETE" });
      if (res.ok) {
        setActiveChannel(null);
        setMessages([]);
        await loadChannels();
      }
    } finally { setDeleting(false); }
  }

  function toggleUser(u: TeamUser) {
    setSelectedUsers(prev =>
      prev.some(x => x.user_id === u.user_id)
        ? prev.filter(x => x.user_id !== u.user_id)
        : [...prev, u]
    );
  }

  function channelDisplayName(ch: Channel) {
    if (ch.name) return ch.name;
    if (ch.channel_type === "direct" && ch.other_member_names?.length)
      return ch.other_member_names[0];
    return "Unnamed channel";
  }

  function fmtTime(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  const filteredUsers = teamUsers.filter(u =>
    !userSearch ||
    (u.name ?? "").toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div className="w-[680px] max-w-full bg-white dark:bg-gray-900 shadow-2xl flex flex-col border-l border-gray-200 dark:border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Messages</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Channel sidebar */}
          <div className="w-52 border-r border-gray-200 dark:border-gray-800 flex flex-col flex-shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 dark:border-gray-800">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Conversations</span>
              <button onClick={() => { setShowNew(s => !s); setUserSearch(""); setSelectedUsers([]); setGroupName(""); setNewMode("dm"); }}
                className="w-5 h-5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 flex items-center justify-center" title="New conversation">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
            </div>

            {showNew && (
              <div className="border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/40">
                <div className="flex border-b border-gray-100 dark:border-gray-800">
                  {(["dm", "group"] as const).map(mode => (
                    <button key={mode} onClick={() => { setNewMode(mode); setUserSearch(""); setSelectedUsers([]); }}
                      className={`flex-1 text-[10px] py-1.5 font-semibold transition-colors ${newMode === mode ? "text-blue-600 border-b-2 border-blue-600 -mb-px" : "text-gray-400 hover:text-gray-600"}`}>
                      {mode === "dm" ? "Direct" : "Group"}
                    </button>
                  ))}
                </div>

                <div className="p-2">
                  {newMode === "group" && (
                    <input value={groupName} onChange={e => setGroupName(e.target.value)}
                      placeholder="Group name"
                      className="w-full text-[11px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-400 text-gray-800 dark:text-gray-200 mb-1.5"
                    />
                  )}
                  <input autoFocus value={userSearch} onChange={e => setUserSearch(e.target.value)}
                    placeholder="Search team members…"
                    className="w-full text-[11px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-blue-400 text-gray-800 dark:text-gray-200"
                  />

                  {newMode === "group" && selectedUsers.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {selectedUsers.map(u => (
                        <span key={u.user_id} className="flex items-center gap-1 text-[10px] bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                          {u.name || u.email}
                          <button onClick={() => toggleUser(u)} className="text-blue-400 hover:text-blue-600">✕</button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-1.5 max-h-36 overflow-y-auto space-y-0.5">
                    {filteredUsers.length === 0 ? (
                      <p className="text-[10px] text-gray-400 text-center py-2">No users found</p>
                    ) : filteredUsers.map(u => {
                      const isSelected = selectedUsers.some(x => x.user_id === u.user_id);
                      return (
                        <button key={u.user_id}
                          onClick={() => newMode === "dm" ? startDM(u) : toggleUser(u)}
                          disabled={creating}
                          className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 transition-colors ${isSelected ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-white dark:hover:bg-gray-700"}`}>
                          <Avatar name={u.name || u.email} size={5} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium text-gray-800 dark:text-gray-200 truncate">{u.name || u.email}</p>
                            {u.name && <p className="text-[9px] text-gray-400 truncate">{u.email}</p>}
                          </div>
                          {newMode === "group" && isSelected && (
                            <svg className="w-3 h-3 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {newMode === "group" && (
                    <button onClick={createGroup} disabled={!groupName.trim() || selectedUsers.length === 0 || creating}
                      className="w-full mt-2 text-[10px] py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded font-medium transition-colors">
                      {creating ? "Creating…" : `Create group${selectedUsers.length > 0 ? ` (${selectedUsers.length})` : ""}`}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {channels.length === 0 ? (
                <p className="text-[10px] text-gray-400 px-3 py-4 text-center">No conversations yet.<br/>Click + to start one.</p>
              ) : (
                channels.map(ch => (
                  <div key={ch.channel_id}
                    className={`group relative border-b border-gray-50 dark:border-gray-800/50 ${activeChannel?.channel_id === ch.channel_id ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-gray-50 dark:hover:bg-gray-800/60"}`}>
                    <button onClick={() => { setActiveChannel(ch); setShowNew(false); }}
                      className="w-full text-left px-3 py-2.5 pr-7 transition-colors">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-medium text-gray-800 dark:text-gray-200 truncate">
                          {ch.channel_type === "direct" ? "@ " : ""}{channelDisplayName(ch)}
                        </span>
                        {ch.unread_count > 0 && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white flex-shrink-0">{ch.unread_count}</span>
                        )}
                      </div>
                      {ch.last_message && (
                        <p className="text-[10px] text-gray-400 truncate mt-0.5">{ch.last_message}</p>
                      )}
                    </button>
                    <button
                      onClick={() => deleteChannel(ch)}
                      disabled={deleting}
                      title="Delete"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-300 hover:text-red-400 transition-all disabled:opacity-40"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Message thread */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {!activeChannel ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                <svg className="w-10 h-10 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                </svg>
                <p className="text-sm font-medium text-gray-400">Select a conversation</p>
                <button onClick={() => setShowNew(true)} className="text-xs text-blue-500 hover:text-blue-700 transition-colors">
                  or start a new one →
                </button>
              </div>
            ) : (
              <>
                <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                  <span className="text-xs text-gray-400">{activeChannel.channel_type === "direct" ? "@" : "#"}</span>
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">{channelDisplayName(activeChannel)}</span>
                  {activeChannel.channel_type === "announcement" && <span className="text-[9px] text-amber-500 font-bold uppercase tracking-wide">Announcement</span>}
                  <button
                    onClick={() => deleteChannel(activeChannel)}
                    disabled={deleting}
                    title={activeChannel.channel_type === "direct" ? "Delete conversation" : "Delete group"}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-300 hover:text-red-400 dark:hover:text-red-400 transition-colors disabled:opacity-40 flex-shrink-0"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                  {loadingMsgs && messages.length === 0 ? (
                    <div className="flex justify-center py-6">
                      <svg className="w-5 h-5 animate-spin text-gray-300" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10">
                      <p className="text-sm text-gray-400">No messages yet</p>
                      <p className="text-xs text-gray-300 mt-1">Send the first message below</p>
                    </div>
                  ) : (
                    messages.map(msg => (
                      <div key={msg.message_id} className={`flex gap-2.5 ${msg.is_announcement ? "bg-amber-50/60 dark:bg-amber-950/10 rounded-lg px-3 py-2 border border-amber-100 dark:border-amber-900/40" : ""}`}>
                        <Avatar name={msg.sender_display_name || msg.sender_name} size={7} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                              {msg.sender_display_name || msg.sender_name || "Unknown"}
                            </span>
                            {msg.portal_token && <span className="text-[9px] text-amber-600 dark:text-amber-400 font-medium">Portal</span>}
                            {msg.is_announcement && <span className="text-[9px] text-amber-600 dark:text-amber-400 font-bold uppercase tracking-wide">Announcement</span>}
                            <span className="text-[10px] text-gray-400">{fmtTime(msg.created_at)}</span>
                          </div>
                          <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed mt-0.5 whitespace-pre-wrap">{msg.body}</p>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <form onSubmit={sendMessage} className="px-4 py-3 border-t border-gray-100 dark:border-gray-800">
                  <div className="flex gap-2">
                    <input value={msgText} onChange={e => setMsgText(e.target.value)}
                      placeholder={`Message ${channelDisplayName(activeChannel)}…`}
                      className="flex-1 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                    />
                    <button type="submit" disabled={!msgText.trim() || sending}
                      className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
                      {sending ? "…" : "Send"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
