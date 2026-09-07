import React, { useId } from "react";

import { AutoTextarea } from "@/components/AutoTextarea";
interface TextAreaProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}

export default function TextArea({
  label,
  value,
  onChange,
  hint,
  required = false,
  rows = 4,
  placeholder,
  disabled = false,
}: TextAreaProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
        {required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
      <AutoTextarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-required={required}
        aria-describedby={hintId}
        className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-900 disabled:text-gray-500 dark:disabled:text-gray-400 resize-y"
      />
      {hint && <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}
