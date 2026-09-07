"use client";

/**
 * Shared inline-edit primitives for the inventory tables.
 *
 * Used by Inventory > Chemicals / Enzymes and System Design > Enzymes so the
 * click-to-edit behaviour and select styling stay identical across them.
 */
import { useEffect, useRef, useState } from "react";

export function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/** Native select restyled: no OS chrome, own chevron, focus ring. */
export function Select({ value, onChange, children, className = "", title }: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div className={`relative inline-flex ${className}`}>
      <select
        value={value}
        title={title}
        onChange={e => onChange(e.target.value)}
        className="appearance-none w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-8 py-1.5 text-sm text-gray-700 dark:text-gray-200 cursor-pointer transition-colors hover:border-gray-300 dark:hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
      >
        {children}
      </select>
      <ChevronIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
    </div>
  );
}

/**
 * Click-to-edit cell. Commits on Enter or blur, reverts on Escape.
 * Selects commit immediately on change.
 */
export function EditableCell({ value, onSave, type = "text", options, placeholder = "—", className = "", inputWidth = "w-full", render }: {
  value: string | number | null;
  onSave: (v: string | null) => Promise<void>;
  type?: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
  className?: string;
  inputWidth?: string;
  render?: (v: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = value == null ? "" : String(value);

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  async function commit(next: string) {
    if (next === current) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(next.trim() === "" ? null : next.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (type === "select") {
    return (
      <Select
        value={current}
        onChange={v => { void onSave(v === "" ? null : v); }}
        className={className}
      >
        {options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        step={type === "number" ? "any" : undefined}
        value={draft}
        disabled={saving}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); void commit(draft); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
        className={`${inputWidth} rounded border border-blue-400 bg-white dark:bg-gray-800 px-1.5 py-0.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => { setDraft(current); setEditing(true); }}
      title="Click to edit"
      className={`text-left w-full rounded px-1 -mx-1 py-0.5 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:ring-1 hover:ring-blue-200 dark:hover:ring-blue-800 transition-colors ${className}`}
    >
      {current ? (render ? render(current) : current) : <span className="text-gray-300 dark:text-gray-600">{placeholder}</span>}
    </button>
  );
}
