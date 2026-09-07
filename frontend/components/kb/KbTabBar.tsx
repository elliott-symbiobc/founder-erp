"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function KbTabBar() {
  const pathname = usePathname();
  const isLiterature = pathname.startsWith("/kb/literature");

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 shrink-0">
      <div className="flex gap-0">
        <Link
          href="/kb"
          className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            !isLiterature
              ? "border-blue-600 text-blue-700 dark:text-blue-400"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          System Documentation
        </Link>
        <Link
          href="/kb/literature"
          className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
            isLiterature
              ? "border-blue-600 text-blue-700 dark:text-blue-400"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Literature Library
        </Link>
      </div>
    </div>
  );
}
