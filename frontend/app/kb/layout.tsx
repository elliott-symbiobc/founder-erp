'use client'

import Link from "next/link";
import { useState, useEffect } from "react";
import { useDevMode } from "@/components/DevModeContext";

const TOPICS = [
];

export default function KbLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { devMode } = useDevMode();

  useEffect(() => {
    const stored = localStorage.getItem('kb-sidebar-collapsed');
    if (stored === 'true') setCollapsed(true);
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('kb-sidebar-collapsed', String(next));
  }

  return (
    <div className="flex flex-col h-full -m-6 overflow-hidden">
      {/* Body: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <aside
          className={`shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex flex-col h-full overflow-hidden transition-all duration-200 ease-in-out ${
            collapsed ? "w-10 min-w-10" : "w-56 min-w-56"
          }`}
        >
          {collapsed ? (
            /* Collapsed strip — expand chevron centered */
            <button
              onClick={toggle}
              className="flex items-center justify-center w-full h-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title="Expand sidebar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            /* Expanded sidebar */
            <>
              <div className="px-4 py-4 border-b border-gray-200 dark:border-gray-700">
                <Link href="/kb" className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide hover:text-gray-800 dark:hover:text-gray-200">
                  Knowledge Base
                </Link>
              </div>
              <nav className="px-2 py-3 space-y-0.5 flex-1 overflow-y-auto">
                {TOPICS.map(t => (
                  <Link
                    key={t.href}
                    href={t.href}
                    className="block px-3 py-2 rounded text-sm text-gray-600 dark:text-gray-400 hover:bg-white dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 hover:shadow-sm transition-all leading-snug"
                  >
                    {t.label}
                  </Link>
                ))}
                {devMode && (
                  <>
                    <div className="pt-3 pb-1 px-3">
                      <span className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Developer</span>
                    </div>
                    <Link
                      href="/kb/dev"
                      className="block px-3 py-2 rounded text-sm text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950 hover:shadow-sm transition-all leading-snug font-medium"
                    >
                      Developer Reference
                    </Link>
                  </>
                )}
              </nav>
              {/* Collapse button at bottom */}
              <button
                onClick={toggle}
                className="flex items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
                <span>Collapse</span>
              </button>
            </>
          )}
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
