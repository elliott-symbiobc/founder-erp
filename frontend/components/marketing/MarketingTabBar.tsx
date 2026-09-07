"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Pitch Decks was a separate store of the same thing Assets now holds, so it
// is gone; decks are assets with the investor-deck role. Key Language reads on
// the Assets page too; its full editor stays at /marketing/key-language for
// Google Doc sync, categories and history.
const TABS = [
  { href: "/marketing/assets",       label: "Assets"       },
  { href: "/marketing/campaigns",    label: "Campaigns"    },
  { href: "/marketing/website",      label: "Website"      },
];

export default function MarketingTabBar() {
  const pathname = usePathname();

  return (
    <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 shrink-0">
      <div className="flex gap-0">
        {TABS.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-blue-600 text-blue-700 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
