"use client";

import CalendarView from "@/components/CalendarView";

/**
 * The calendar's own route. It previously existed only as a panel on the
 * dashboard, which is why MODULE_PATHS already pointed at /calendar for a page
 * that was never there.
 */
export default function CalendarPage() {
  return (
    <div className="max-w-5xl mx-auto">
      <CalendarView />
    </div>
  );
}
