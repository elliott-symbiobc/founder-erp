"use client";

import { useEffect, useState, useCallback, useRef } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
// ── Constants ──────────────────────────────────────────────────────────────────

const HOUR_H = 56; // px per hour in time grid
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Types ──────────────────────────────────────────────────────────────────────

type ViewMode = "day" | "week" | "month";

interface CalEvent {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  all_day: boolean;
  timezone: string;
  attendees: { email: string; name: string }[];
  color_id?: string;
}

interface EventForm {
  title: string;
  description: string;
  start_date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  all_day: boolean;
  timezone: string;
  attendee_emails: string;
}

interface PositionedEvent {
  ev: CalEvent;
  col: number;
  totalCols: number;
}

const BLANK_FORM: EventForm = {
  title: "",
  description: "",
  start_date: "",
  start_time: "09:00",
  end_date: "",
  end_time: "10:00",
  all_day: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  attendee_emails: "",
};

// ── Colors ─────────────────────────────────────────────────────────────────────

// Google Calendar colorId → hex (official GCal palette)
const GCAL_COLORS: Record<string, string> = {
  "1":  "#7986CB", // Lavender
  "2":  "#33B679", // Sage
  "3":  "#8E24AA", // Grape
  "4":  "#E67C73", // Flamingo
  "5":  "#F6BF26", // Banana
  "6":  "#F4511E", // Tangerine
  "7":  "#039BE5", // Peacock
  "8":  "#616161", // Graphite
  "9":  "#3F51B5", // Blueberry
  "10": "#0B8043", // Basil
  "11": "#D50000", // Tomato
};
const DEFAULT_GCAL_COLOR = "#4285F4"; // Google Calendar default blue

function gcalColor(colorId?: string): string {
  return (colorId && GCAL_COLORS[colorId]) || DEFAULT_GCAL_COLOR;
}

function pillStyle(colorId?: string): React.CSSProperties {
  const c = gcalColor(colorId);
  return { backgroundColor: c + "22", color: c, borderColor: c + "99" };
}

function blockStyle(colorId?: string): React.CSSProperties {
  return { backgroundColor: gcalColor(colorId) };
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekStart(d: Date): Date {
  const r = new Date(d);
  r.setDate(d.getDate() - d.getDay());
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function localIso(date: string, time: string) {
  return `${date}T${time}:00`;
}

function fmtTime(iso: string): string {
  if (!iso?.includes("T")) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function evDate(ev: CalEvent) { return ev.start?.slice(0, 10) ?? ""; }

function inBanner(ev: CalEvent): boolean {
  if (ev.all_day) return true;
  return !!ev.start && !!ev.end && ev.start.slice(0, 10) !== ev.end.slice(0, 10);
}

function minsFromMidnight(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate(); }
function firstDayOfMonth(y: number, m: number) { return new Date(y, m, 1).getDay(); }

function viewTitle(view: ViewMode, anchor: Date): string {
  if (view === "month") return anchor.toLocaleString("default", { month: "long", year: "numeric" });
  if (view === "day") return anchor.toLocaleString("default", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const ws = weekStart(anchor);
  const we = addDays(ws, 6);
  if (ws.getMonth() === we.getMonth())
    return `${ws.toLocaleString("default", { month: "short" })} ${ws.getDate()}–${we.getDate()}, ${ws.getFullYear()}`;
  if (ws.getFullYear() === we.getFullYear())
    return `${ws.toLocaleString("default", { month: "short" })} ${ws.getDate()} – ${we.toLocaleString("default", { month: "short" })} ${we.getDate()}, ${ws.getFullYear()}`;
  return `${ws.toLocaleString("default", { month: "short", day: "numeric", year: "numeric" })} – ${we.toLocaleString("default", { month: "short", day: "numeric", year: "numeric" })}`;
}

// ── Overlap layout ─────────────────────────────────────────────────────────────

function layoutTimed(dayEvents: CalEvent[]): PositionedEvent[] {
  const timed = dayEvents.filter(ev => !inBanner(ev) && ev.start?.includes("T"));
  const sorted = [...timed].sort((a, b) => a.start.localeCompare(b.start));
  const laneEnd: string[] = [];
  const placed: { ev: CalEvent; col: number }[] = [];

  for (const ev of sorted) {
    let col = 0;
    while (col < laneEnd.length && laneEnd[col] > ev.start) col++;
    laneEnd[col] = ev.end;
    placed.push({ ev, col });
  }

  return placed.map(({ ev, col }) => {
    let maxCol = col;
    for (const o of placed) {
      if (o.ev.id !== ev.id && o.ev.start < ev.end && o.ev.end > ev.start)
        maxCol = Math.max(maxCol, o.col);
    }
    return { ev, col, totalCols: maxCol + 1 };
  });
}

// ── API ────────────────────────────────────────────────────────────────────────

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api/proxy/${path}`, opts);
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(t || `HTTP ${res.status}`); }
  if (res.status === 204) return null;
  return res.json();
}

// ── EventModal ─────────────────────────────────────────────────────────────────

function EventModal({ form, setForm, editing, saving, deleting, onClose, onSave, onDelete }: {
  form: EventForm; setForm: (f: EventForm) => void;
  editing: CalEvent | null; saving: boolean; deleting: boolean;
  onClose: () => void; onSave: () => void; onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} onClick={e => { if (e.target === ref.current) onClose(); }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{editing ? "Edit Event" : "New Event"}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Title</label>
            <input autoFocus type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              placeholder="Event title" className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.all_day} onChange={e => setForm({ ...form, all_day: e.target.checked })} className="rounded" />
            <span className="text-xs text-gray-600 dark:text-gray-400">All day</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Start date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">End date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          {!form.all_day && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Start time</label>
                <input type="time" value={form.start_time} onChange={e => setForm({ ...form, start_time: e.target.value })}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">End time</label>
                <input type="time" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description</label>
            <AutoTextarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              rows={2} placeholder="Optional description"
              className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Attendees <span className="font-normal text-gray-400">(comma-separated emails)</span>
            </label>
            <input type="text" value={form.attendee_emails} onChange={e => setForm({ ...form, attendee_emails: e.target.value })}
              placeholder="alice@example.com, bob@example.com"
              className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <div>
            {editing && (
              <button onClick={onDelete} disabled={deleting || saving}
                className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-50">
                {deleting ? "Deleting…" : "Delete event"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">Cancel</button>
            <button onClick={onSave} disabled={saving || !form.title.trim() || !form.start_date}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : editing ? "Save changes" : "Create event"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EventPill (month) ──────────────────────────────────────────────────────────

function EventPill({ ev, onClick }: { ev: CalEvent; onClick: () => void }) {
  const time = ev.all_day ? "" : fmtTime(ev.start);
  return (
    <button onClick={e => { e.stopPropagation(); onClick(); }} title={ev.title}
      className="w-full text-left text-xs px-1.5 py-0.5 rounded border truncate leading-tight hover:opacity-80 transition-opacity"
      style={pillStyle(ev.color_id)}>
      {time && <span className="mr-1 opacity-60">{time}</span>}
      {ev.title}
    </button>
  );
}

// ── EventBlock (week/day time grid) ───────────────────────────────────────────

function EventBlock({ p, onClick }: { p: PositionedEvent; onClick: () => void }) {
  const { ev, col, totalCols } = p;
  const startM = minsFromMidnight(ev.start);
  const endM   = minsFromMidnight(ev.end);
  const top    = (startM / 60) * HOUR_H;
  const height = Math.max(((endM - startM) / 60) * HOUR_H, 22);
  const short  = height < 40;

  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      title={`${ev.title}\n${fmtTime(ev.start)}–${fmtTime(ev.end)}`}
      style={{
        position: "absolute",
        top, height,
        left: `calc(${(col / totalCols) * 100}% + ${col > 0 ? 2 : 0}px)`,
        width: `calc(${100 / totalCols}% - 3px)`,
        ...blockStyle(ev.color_id),
      }}
      className="text-white rounded overflow-hidden text-left px-1.5 hover:brightness-110 transition-all shadow-sm"
    >
      <span className={`block font-medium leading-tight truncate ${short ? "text-[10px]" : "text-xs"}`}>{ev.title}</span>
      {!short && <span className="block text-[10px] opacity-80 truncate">{fmtTime(ev.start)}–{fmtTime(ev.end)}</span>}
    </button>
  );
}

// ── TimeGrid (week + day share this) ──────────────────────────────────────────

function TimeGrid({ days, events, todayStr, onClickSlot, onClickEvent, scrollRef }: {
  days: string[];
  events: CalEvent[];
  todayStr: string;
  onClickSlot: (date: string, hour: number) => void;
  onClickEvent: (ev: CalEvent) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [nowMins, setNowMins] = useState(() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); });
  useEffect(() => {
    const id = setInterval(() => { const n = new Date(); setNowMins(n.getHours() * 60 + n.getMinutes()); }, 30000);
    return () => clearInterval(id);
  }, []);

  const byDate: Record<string, CalEvent[]> = {};
  for (const ev of events) { const d = evDate(ev); if (!byDate[d]) byDate[d] = []; byDate[d].push(ev); }

  const TW = 48; // time-axis width px

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* All-day banner */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0" style={{ paddingLeft: TW }}>
        {days.map(d => {
          const bannerEvs = (byDate[d] ?? []).filter(inBanner);
          return (
            <div key={d} className="flex-1 min-w-0 border-l border-gray-100 dark:border-gray-800 px-0.5 py-0.5 min-h-[26px]">
              {bannerEvs.map(ev => (
                <button key={ev.id} onClick={() => onClickEvent(ev)}
                  className="w-full text-left text-[10px] px-1 py-0.5 mb-0.5 rounded truncate border hover:opacity-80 transition-opacity"
                  style={pillStyle(ev.color_id)}>
                  {ev.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* Scrollable grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="flex relative" style={{ height: 24 * HOUR_H }}>
          {/* Time labels */}
          <div className="shrink-0 relative select-none" style={{ width: TW }}>
            {HOURS.map(h => (
              <div key={h} style={{ position: "absolute", top: h * HOUR_H - 8, right: 6 }}
                className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
                {h > 0 ? fmtHour(h) : ""}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map(d => {
            const isToday = d === todayStr;
            const positioned = layoutTimed(byDate[d] ?? []);
            return (
              <div key={d} onClick={() => onClickSlot(d, 9)}
                className="flex-1 min-w-0 border-l border-gray-100 dark:border-gray-800 relative cursor-pointer hover:bg-blue-50/10 dark:hover:bg-blue-950/10 transition-colors">
                {/* Hour lines */}
                {HOURS.map(h => (
                  <div key={h} style={{ position: "absolute", top: h * HOUR_H, left: 0, right: 0 }}
                    className="border-t border-gray-100 dark:border-gray-800" />
                ))}
                {/* Half-hour lines */}
                {HOURS.map(h => (
                  <div key={`${h}h`} style={{ position: "absolute", top: h * HOUR_H + HOUR_H / 2, left: 0, right: 0 }}
                    className="border-t border-gray-50 dark:border-gray-800/50" />
                ))}
                {/* Now indicator */}
                {isToday && (
                  <div style={{ position: "absolute", top: (nowMins / 60) * HOUR_H, left: 0, right: 0, zIndex: 10 }}
                    className="flex items-center pointer-events-none">
                    <div className="w-2 h-2 rounded-full bg-red-500 -ml-1 shrink-0" />
                    <div className="flex-1 border-t border-red-500" />
                  </div>
                )}
                {/* Event blocks */}
                <div className="absolute inset-0" onClick={e => e.stopPropagation()}>
                  {positioned.map(p => <EventBlock key={p.ev.id} p={p} onClick={() => onClickEvent(p.ev)} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── MonthView ──────────────────────────────────────────────────────────────────

function MonthView({ anchor, events, todayStr, loading, onClickDay, onClickEvent }: {
  anchor: Date; events: CalEvent[]; todayStr: string; loading: boolean;
  onClickDay: (d: string) => void; onClickEvent: (ev: CalEvent) => void;
}) {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const numDays = daysInMonth(y, m), firstDay = firstDayOfMonth(y, m);

  const byDate: Record<string, CalEvent[]> = {};
  for (const ev of events) { const d = evDate(ev); if (!byDate[d]) byDate[d] = []; byDate[d].push(ev); }
  for (const d of Object.keys(byDate)) byDate[d].sort((a, b) => a.start.localeCompare(b.start));

  const cells: { day: number | null; ds: string }[] = [];
  for (let i = 0; i < firstDay; i++) cells.push({ day: null, ds: "" });
  for (let d = 1; d <= numDays; d++) {
    cells.push({ day: d, ds: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, ds: "" });

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${loading ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-7 shrink-0 mb-1">
        {DAY_NAMES.map(d => <div key={d} className="text-center text-xs font-semibold text-gray-400 dark:text-gray-500 py-1">{d}</div>)}
      </div>
      <div className="flex-1 grid grid-cols-7 gap-px bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
        {cells.map((cell, i) => {
          const isToday = cell.ds === todayStr;
          const isPast = cell.ds && cell.ds < todayStr;
          const dayEvs = cell.ds ? (byDate[cell.ds] ?? []) : [];
          return (
            <div key={i} onClick={() => cell.day && onClickDay(cell.ds)}
              className={`bg-white dark:bg-gray-900 p-1.5 flex flex-col gap-0.5 min-h-0 ${cell.day ? "cursor-pointer hover:bg-blue-50/30 dark:hover:bg-blue-950/20 transition-colors" : ""} ${isPast ? "opacity-60" : ""}`}>
              {cell.day && (
                <div className="flex items-center justify-center mb-0.5 shrink-0">
                  <span className={`text-xs font-medium w-5 h-5 flex items-center justify-center rounded-full ${isToday ? "bg-blue-600 text-white" : "text-gray-700 dark:text-gray-300"}`}>
                    {cell.day}
                  </span>
                </div>
              )}
              <div className="space-y-0.5 overflow-hidden">
                {dayEvs.slice(0, 3).map(ev => <EventPill key={ev.id} ev={ev} onClick={() => onClickEvent(ev)} />)}
                {dayEvs.length > 3 && <p className="text-xs text-gray-400 dark:text-gray-500 px-1">+{dayEvs.length - 3} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── WeekView ───────────────────────────────────────────────────────────────────

function WeekView({ anchor, events, todayStr, onClickSlot, onClickEvent, scrollRef }: {
  anchor: Date; events: CalEvent[]; todayStr: string;
  onClickSlot: (d: string, h: number) => void; onClickEvent: (ev: CalEvent) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ws = weekStart(anchor);
  const days = Array.from({ length: 7 }, (_, i) => isoDate(addDays(ws, i)));
  const TW = 48;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Day headers */}
      <div className="flex shrink-0 border-b border-gray-200 dark:border-gray-700" style={{ paddingLeft: TW }}>
        {days.map((ds, i) => {
          const d = addDays(ws, i);
          const isToday = ds === todayStr;
          return (
            <div key={ds} className="flex-1 text-center py-2 border-l border-gray-100 dark:border-gray-800">
              <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase">{DAY_NAMES[d.getDay()]}</div>
              <div className="flex items-center justify-center mt-0.5">
                <span className={`text-sm font-semibold w-7 h-7 flex items-center justify-center rounded-full ${isToday ? "bg-blue-600 text-white" : "text-gray-800 dark:text-gray-200"}`}>
                  {d.getDate()}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <TimeGrid days={days} events={events} todayStr={todayStr}
        onClickSlot={onClickSlot} onClickEvent={onClickEvent} scrollRef={scrollRef} />
    </div>
  );
}

// ── DayView ────────────────────────────────────────────────────────────────────

function DayView({ anchor, events, todayStr, onClickSlot, onClickEvent, scrollRef }: {
  anchor: Date; events: CalEvent[]; todayStr: string;
  onClickSlot: (d: string, h: number) => void; onClickEvent: (ev: CalEvent) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ds = isoDate(anchor);
  const isToday = ds === todayStr;
  const TW = 48;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex shrink-0 border-b border-gray-200 dark:border-gray-700" style={{ paddingLeft: TW }}>
        <div className="flex-1 text-center py-2 border-l border-gray-100 dark:border-gray-800">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase">{DAY_NAMES_LONG[anchor.getDay()]}</div>
          <div className="flex items-center justify-center mt-0.5">
            <span className={`text-sm font-semibold w-7 h-7 flex items-center justify-center rounded-full ${isToday ? "bg-blue-600 text-white" : "text-gray-800 dark:text-gray-200"}`}>
              {anchor.getDate()}
            </span>
          </div>
        </div>
      </div>
      <TimeGrid days={[ds]} events={events} todayStr={todayStr}
        onClickSlot={onClickSlot} onClickEvent={onClickEvent} scrollRef={scrollRef} />
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CalendarView() {
  const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
  const todayStr = isoDate(todayDate);

  const [view, setView] = useState<ViewMode>("day");
  const [anchor, setAnchor] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [form, setForm] = useState<EventForm>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to current time when switching to time-grid views
  useEffect(() => {
    if (view !== "month") {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = Math.max(0, new Date().getHours() - 1) * HOUR_H;
        }
      });
    }
  }, [view]);

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async (v: ViewMode, a: Date) => {
    setLoading(true); setError(null);
    try {
      let start: Date, end: Date;
      if (v === "month") {
        const y = a.getFullYear(), m = a.getMonth();
        start = new Date(y, m - 1, 25); end = new Date(y, m + 1, 10);
      } else if (v === "week") {
        const ws = weekStart(a); start = addDays(ws, -1); end = addDays(ws, 8);
      } else {
        start = new Date(a); start.setHours(0, 0, 0, 0);
        end = new Date(a); end.setHours(23, 59, 59, 999);
      }
      const data = await apiFetch(`calendar/events?time_min=${start.toISOString()}&time_max=${end.toISOString()}&max_results=500`);
      setEvents(data?.events ?? []); setNotConnected(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("google_not_connected") || msg.includes("Google account not connected")) setNotConnected(true);
      else setError(msg);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchEvents(view, anchor); }, [view, anchor, fetchEvents]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  function nav(dir: -1 | 1) {
    setAnchor(prev => {
      const d = new Date(prev);
      if (view === "month") d.setMonth(d.getMonth() + dir);
      else if (view === "week") d.setDate(d.getDate() + 7 * dir);
      else d.setDate(d.getDate() + dir);
      return d;
    });
  }

  function goToday() { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function openCreate(dateStr?: string, hour?: number) {
    const d = dateStr || isoDate(todayDate);
    const sh = String(hour ?? 9).padStart(2, "0");
    const eh = String((hour ?? 9) + 1).padStart(2, "0");
    setEditing(null);
    setForm({ ...BLANK_FORM, start_date: d, end_date: d, start_time: `${sh}:00`, end_time: `${eh}:00` });
    setModalOpen(true);
  }

  function openEdit(ev: CalEvent) {
    setEditing(ev);
    setForm({
      title: ev.title, description: ev.description || "",
      start_date: ev.start?.slice(0, 10) ?? "",
      start_time: ev.all_day ? "09:00" : (ev.start?.slice(11, 16) ?? "09:00"),
      end_date: ev.end?.slice(0, 10) ?? (ev.start?.slice(0, 10) ?? ""),
      end_time: ev.all_day ? "10:00" : (ev.end?.slice(11, 16) ?? "10:00"),
      all_day: ev.all_day, timezone: ev.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      attendee_emails: ev.attendees.map(a => a.email).join(", "),
    });
    setModalOpen(true);
  }

  function closeModal() { setModalOpen(false); setEditing(null); setForm(BLANK_FORM); }

  async function handleSave() {
    if (!form.title.trim() || !form.start_date) return;
    setSaving(true);
    try {
      const emails = form.attendee_emails.split(",").map(s => s.trim()).filter(Boolean);
      const startIso = form.all_day ? form.start_date : localIso(form.start_date, form.start_time);
      const endIso   = form.all_day ? form.end_date   : localIso(form.end_date,   form.end_time);
      const payload  = { title: form.title, description: form.description, start: startIso, end: endIso, all_day: form.all_day, timezone: form.timezone, attendee_emails: emails };
      if (editing) {
        await apiFetch(`calendar/events/${editing.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      } else {
        await apiFetch("calendar/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      closeModal(); fetchEvents(view, anchor);
    } catch (err: unknown) { alert("Failed to save: " + (err instanceof Error ? err.message : String(err))); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!editing || !confirm(`Delete "${editing.title}"?`)) return;
    setDeleting(true);
    try {
      await apiFetch(`calendar/events/${editing.id}`, { method: "DELETE" });
      closeModal(); fetchEvents(view, anchor);
    } catch (err: unknown) { alert("Failed to delete: " + (err instanceof Error ? err.message : String(err))); }
    finally { setDeleting(false); }
  }

  // ── Not connected ──────────────────────────────────────────────────────────

  if (notConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-[500px] gap-4">
        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
          <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Google Calendar not connected</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Connect your Google account in Contacts to use the calendar.</p>
        </div>
        <a href="/contacts" className="px-4 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors">
          Go to Contacts → Connect Google
        </a>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[600px] gap-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          <button onClick={() => nav(-1)} className="p-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
          </button>
          <h2 className="text-xs font-semibold text-gray-900 dark:text-gray-100 text-center w-40 truncate">{viewTitle(view, anchor)}</h2>
          <button onClick={() => nav(1)} className="p-1 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          </button>
          <button onClick={goToday} className="ml-1 px-2 py-0.5 text-[10px] font-medium rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">Today</button>
          {loading && <svg className="w-3 h-3 animate-spin text-gray-400 ml-1" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
        </div>
        <div className="flex items-center gap-1.5">
          {/* View switcher */}
          <div className="flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden text-[10px] font-medium">
            {(["day", "week", "month"] as ViewMode[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-2 py-1 capitalize transition-colors ${view === v ? "bg-blue-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => openCreate()}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            New event
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 shrink-0">{error}</div>
      )}

      {/* Views */}
      {view === "month" && <MonthView anchor={anchor} events={events} todayStr={todayStr} loading={loading} onClickDay={openCreate} onClickEvent={openEdit} />}
      {view === "week"  && <WeekView  anchor={anchor} events={events} todayStr={todayStr} onClickSlot={openCreate} onClickEvent={openEdit} scrollRef={scrollRef} />}
      {view === "day"   && <DayView   anchor={anchor} events={events} todayStr={todayStr} onClickSlot={openCreate} onClickEvent={openEdit} scrollRef={scrollRef} />}

      {modalOpen && <EventModal form={form} setForm={setForm} editing={editing} saving={saving} deleting={deleting} onClose={closeModal} onSave={handleSave} onDelete={handleDelete} />}
    </div>
  );
}