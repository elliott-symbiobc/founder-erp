"use client";

import MarketingTabBar from "@/components/marketing/MarketingTabBar";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <MarketingTabBar />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
