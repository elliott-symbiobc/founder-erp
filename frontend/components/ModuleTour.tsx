"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";

interface TourStep {
  title: string;
  description: string;
  icon: string;
}

interface ModuleTourData {
  moduleTitle: string;
  tagline: string;
  steps: TourStep[];
}

const TOURS: Record<string, ModuleTourData> = {
  dashboard: {
    moduleTitle: "Dashboard",
    tagline: "Your business at a glance.",
    steps: [
      { icon: "📊", title: "Key Metrics", description: "The top cards show your most important numbers — open tasks, active projects, upcoming reminders, and recent contacts. They update in real time." },
      { icon: "✅", title: "Your Tasks", description: "Tasks assigned to you appear here in priority order. Click any task to open it, update its status, or leave a comment." },
      { icon: "🔔", title: "Reminders", description: "Follow-up reminders from your CRM and contacts surface here so nothing falls through the cracks." },
      { icon: "📈", title: "Activity Feed", description: "See what your team has been working on — new contacts added, projects updated, notes created. A live pulse of your business." },
    ],
  },
  contacts: {
    moduleTitle: "Contacts",
    tagline: "Your unified contact database.",
    steps: [
      { icon: "👥", title: "Contact Database", description: "Every person your business has a relationship with lives here — clients, leads, advisors, partners. Click any contact to see their full profile." },
      { icon: "🔍", title: "Search & Filter", description: "Use the search bar to find anyone instantly. Filter by tags, organization, or relationship type to segment your contacts." },
      { icon: "➕", title: "Add Contacts", description: "Click 'New Contact' to add someone manually, or connect Gmail in Settings to have your contacts synced automatically." },
      { icon: "🕸️", title: "Relationship Graph", description: "The graph view shows how your contacts are connected to each other — who introduced who, shared organizations, and mutual relationships." },
      { icon: "🔔", title: "Reminders", description: "Set follow-up reminders on any contact so you never forget to reach out. They'll surface on your Dashboard." },
    ],
  },
  crm: {
    moduleTitle: "CRM",
    tagline: "Track your deals and pipeline.",
    steps: [
      { icon: "🏆", title: "Deal Pipeline", description: "Visualize all your active deals by stage — Lead, Qualified, Proposal, Negotiation, Closed. Drag deals between stages to update them." },
      { icon: "💰", title: "Deal Value", description: "Each deal card shows its value and expected close date. The pipeline total shows your weighted revenue forecast." },
      { icon: "📝", title: "Deal Notes", description: "Log calls, meetings, and interactions directly on each deal. All activity is timestamped and visible to your team." },
      { icon: "📬", title: "Follow-ups", description: "Set follow-up dates and tasks on deals so they never go cold. Overdue follow-ups are flagged in red." },
    ],
  },
  projects: {
    moduleTitle: "Projects",
    tagline: "Manage client engagements end-to-end.",
    steps: [
      { icon: "📁", title: "Project List", description: "All your active and completed projects in one place. Filter by status, type, or owner. Click any project to open its full workspace." },
      { icon: "🎯", title: "Milestones & Tasks", description: "Each project has milestones and tasks. Assign tasks to team members, set due dates, and track completion." },
      { icon: "📅", title: "Gantt View", description: "Switch to Gantt view to see your project timeline visually. Drag to reschedule milestones and spot bottlenecks instantly." },
      { icon: "📎", title: "Documents & Files", description: "Attach files, share links, and keep all project documents in one place. Share them with clients via their Portal." },
      { icon: "🚪", title: "Client Portals", description: "Each project can have a client portal — a private room where clients can see updates, download files, and communicate without email chains." },
    ],
  },
  notebook: {
    moduleTitle: "Notebook",
    tagline: "Your team's shared memory.",
    steps: [
      { icon: "📝", title: "Rich Notes", description: "Create rich-text notes with headings, bullet points, tables, and embedded tasks. Notes are searchable and shareable across your team." },
      { icon: "🎙️", title: "Voice Recording", description: "Click the microphone icon to record a voice note. It transcribes automatically and you can ask AI to summarize the key points." },
      { icon: "🤖", title: "AI Assistance", description: "Highlight any text and click the AI button to get a summary, action items, or a rewrite. Requires an Anthropic API key in Settings." },
      { icon: "📌", title: "Pin & Organise", description: "Pin important notes to the top. Tag notes to organise them by project, client, or topic." },
    ],
  },
  fpa: {
    moduleTitle: "FP&A",
    tagline: "Your financial command centre.",
    steps: [
      { icon: "💵", title: "Cash Position", description: "See your current bank balance, recent inflows and outflows, and projected cash runway — all updated automatically from your connected accounts." },
      { icon: "🏦", title: "Connect Accounts", description: "Click 'Connect Bank' to link your accounts via Plaid. Connect QuickBooks to pull in your P&L automatically. Set up both in Settings." },
      { icon: "🔥", title: "Burn Rate", description: "Your monthly burn rate is calculated from actual transaction data. The runway indicator shows how many months of runway you have left at current spend." },
      { icon: "📊", title: "P&L View", description: "See revenue, cost of goods, gross margin, and operating expenses broken down by month. Data comes from QuickBooks when connected." },
    ],
  },
  invoices: {
    moduleTitle: "Invoices",
    tagline: "Create, send, and track invoices.",
    steps: [
      { icon: "🧾", title: "Create Invoice", description: "Click 'New Invoice' to create an invoice. Add line items, set payment terms, and send it directly to your client." },
      { icon: "📦", title: "Product Catalog", description: "Save your products and services in the catalog so you can add them to invoices with one click. No retyping the same items every time." },
      { icon: "📬", title: "Payment Status", description: "Each invoice shows its status — Draft, Sent, Paid, or Overdue. Overdue invoices are highlighted so you know what to follow up on." },
      { icon: "📎", title: "Attach to Projects", description: "Link invoices to projects so you have a complete financial picture of each client engagement in one place." },
    ],
  },
  protocols: {
    moduleTitle: "Protocols",
    tagline: "Your standard operating procedures library.",
    steps: [
      { icon: "📋", title: "SOP Library", description: "Store all your standard operating procedures, checklists, and processes here. Every team member can find the right way to do things." },
      { icon: "✏️", title: "Create & Edit", description: "Click 'New Protocol' to write a new SOP. Use the rich editor to add steps, images, warnings, and notes." },
      { icon: "🤖", title: "AI Generation", description: "Describe a process in plain English and let AI draft the SOP for you. Review and edit before publishing. Requires an Anthropic API key." },
      { icon: "🔗", title: "Link to Projects", description: "Attach protocols to projects and tasks so team members always have the right procedures at hand." },
    ],
  },
  notes: {
    moduleTitle: "Meeting Notes",
    tagline: "AI-powered meeting intelligence.",
    steps: [
      { icon: "🎙️", title: "Record Meetings", description: "Start a recording before your meeting. Granola transcribes everything automatically and syncs it here when connected." },
      { icon: "🤖", title: "AI Summary", description: "After each meeting, AI extracts the key decisions, action items, and follow-ups so you don't have to re-read the full transcript." },
      { icon: "✅", title: "Action Items", description: "Action items identified by AI are listed separately and can be turned into tasks with one click." },
      { icon: "📁", title: "Organised by Contact", description: "Notes are linked to the contacts and projects they relate to, so you always have context when revisiting a relationship." },
    ],
  },
  calendar: {
    moduleTitle: "Calendar",
    tagline: "Your schedule, unified.",
    steps: [
      { icon: "📅", title: "Unified Calendar", description: "See all your events, task due dates, and project milestones in one calendar view. Connect Google Calendar in Settings to sync your events." },
      { icon: "🔄", title: "Google Sync", description: "When Google Calendar is connected, events sync both ways. Create events here and they appear in Google, and vice versa." },
      { icon: "🎯", title: "Task Due Dates", description: "Tasks with due dates appear on the calendar so you can see your workload alongside your meetings." },
    ],
  },
  tasks: {
    moduleTitle: "Tasks",
    tagline: "Everything you need to do, in one place.",
    steps: [
      { icon: "✅", title: "Task List", description: "All tasks assigned to you, across every project and module, collected here. Sorted by priority and due date." },
      { icon: "➕", title: "Quick Add", description: "Press the 'New Task' button or use the keyboard shortcut to add a task in seconds. Assign it to a project or leave it standalone." },
      { icon: "🏷️", title: "Priority & Status", description: "Set priority (low, medium, high, urgent) and status (to do, in progress, done) on every task. Filter to focus on what matters now." },
      { icon: "👤", title: "Assign & Notify", description: "Assign tasks to any team member. They'll be notified and it'll appear on their dashboard immediately." },
    ],
  },
  marketing: {
    moduleTitle: "Marketing",
    tagline: "Your brand asset library.",
    steps: [
      { icon: "🎨", title: "Asset Library", description: "Store all your brand files here — logos, pitch decks, one-pagers, photos, and key messaging. One place for everything your team needs." },
      { icon: "📤", title: "Upload & Organise", description: "Upload files and organise them into folders by campaign, product, or content type." },
      { icon: "🔗", title: "Share Links", description: "Generate shareable links for any asset to send to partners, press, or clients without digging through email." },
    ],
  },
  funding: {
    moduleTitle: "Funding",
    tagline: "Track your capital raises.",
    steps: [
      { icon: "💼", title: "Funding Rounds", description: "Log each funding round — seed, Series A, SAFE notes, grants. Track target amount, amount raised, and close date." },
      { icon: "🤝", title: "Investor Commitments", description: "Record individual investor commitments and their status — interested, committed, wired. See your round filling up in real time." },
      { icon: "📊", title: "Cap Table", description: "The cap table updates automatically as rounds close. See ownership percentages, share classes, and dilution across all rounds." },
    ],
  },
  consumables: {
    moduleTitle: "Inventory",
    tagline: "Track your stock and supplies.",
    steps: [
      { icon: "📦", title: "Stock Levels", description: "See current stock levels for all your consumables, materials, and equipment. Items below reorder threshold are highlighted." },
      { icon: "➕", title: "Add Items", description: "Add new inventory items with quantity, unit, reorder point, and supplier information." },
      { icon: "📉", title: "Usage Tracking", description: "Log usage against projects or tasks to see where your supplies are going and when to reorder." },
    ],
  },
  "admin/users": {
    moduleTitle: "User Management",
    tagline: "Control who has access to what.",
    steps: [
      { icon: "👤", title: "Team Members", description: "See all users in your platform — their role, last active time, and current permission set." },
      { icon: "🔑", title: "Roles", description: "Assign roles: Admin (full access), User (standard access), or Viewer (read-only). Roles set the baseline permission level." },
      { icon: "⚙️", title: "Custom Permissions", description: "Override individual permissions for any user — give a Viewer access to FP&A, or restrict a User from Invoices, without changing their role." },
      { icon: "➕", title: "Invite Users", description: "Click 'New User' to add a team member. Set their role and permissions at the time of creation." },
    ],
  },
};

interface ModuleTourProps {
  moduleKey: string;
  forceOpen?: boolean;
  onClose?: () => void;
}

// Standalone info button — rendered in the Shell header next to the module title
export function ModuleTourInfoButton({ moduleKey, onClick }: { moduleKey: string; onClick: () => void }) {
  if (!TOURS[moduleKey]) return null;
  return (
    <button
      onClick={onClick}
      title="Module guide"
      className="w-5 h-5 rounded-full border border-current text-gray-400 dark:text-gray-500 hover:text-[#e5e5e5] hover:border-[#e5e5e5] transition-colors flex items-center justify-center text-xs font-bold leading-none"
    >
      i
    </button>
  );
}

export default function ModuleTour({ moduleKey, forceOpen, onClose }: ModuleTourProps) {
  const { data: session } = useSession();
  const userId = (session?.user as { id?: string })?.id ?? "guest";
  const storageKey = `tour_seen_${moduleKey}_${userId}`;

  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const tour = TOURS[moduleKey];

  useEffect(() => {
    if (!tour) return;
    const seen = localStorage.getItem(storageKey);
    if (!seen) {
      const t = setTimeout(() => setVisible(true), 600);
      return () => clearTimeout(t);
    }
  }, [storageKey, tour]);

  useEffect(() => {
    if (forceOpen) { setStep(0); setVisible(true); }
  }, [forceOpen]);

  const dismiss = useCallback(() => {
    localStorage.setItem(storageKey, "true");
    setVisible(false);
    setStep(0);
    onClose?.();
  }, [storageKey, onClose]);

  const reopen = useCallback(() => {
    setStep(0);
    setVisible(true);
  }, []);

  if (!tour) return null;

  const currentStep = tour.steps[step];
  const isLast = step === tour.steps.length - 1;

  return (
    <>
      {/* Floating help button */}
      {!visible && (
        <button
          onClick={reopen}
          title={`${tour.moduleTitle} tour`}
          className="fixed bottom-6 right-6 z-40 w-9 h-9 rounded-full bg-[#e5e5e5] text-black font-bold text-sm shadow-lg hover:bg-[#d4d4d4] transition-colors flex items-center justify-center"
        >
          ?
        </button>
      )}

      {/* Backdrop */}
      {visible && (
        <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
          <div className="pointer-events-auto w-80 bg-[#1b1a1a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="bg-[#e5e5e5] px-5 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-black text-xs font-semibold uppercase tracking-wider">Module Guide</p>
                  <h3 className="text-black font-bold text-lg leading-tight">{tour.moduleTitle}</h3>
                  <p className="text-black/60 text-xs mt-0.5">{tour.tagline}</p>
                </div>
                <button onClick={dismiss} className="text-black/40 hover:text-black text-xl leading-none mt-0.5">×</button>
              </div>
              {/* Step dots */}
              <div className="flex gap-1.5 mt-3">
                {tour.steps.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setStep(i)}
                    className={`h-1.5 rounded-full transition-all ${i === step ? "bg-black w-4" : "bg-black/30 w-1.5"}`}
                  />
                ))}
              </div>
            </div>

            {/* Step content */}
            <div className="px-5 py-4 space-y-2 min-h-[100px]">
              <div className="flex items-start gap-3">
                <span className="text-2xl shrink-0">{currentStep.icon}</span>
                <div>
                  <p className="text-white font-semibold text-sm">{currentStep.title}</p>
                  <p className="text-white/60 text-sm mt-1 leading-relaxed">{currentStep.description}</p>
                </div>
              </div>
            </div>

            {/* Navigation */}
            <div className="px-5 pb-4 flex items-center justify-between">
              <button
                onClick={() => setStep(s => s - 1)}
                className={`text-white/40 text-sm hover:text-white transition-colors ${step === 0 ? "invisible" : ""}`}
              >
                ← Prev
              </button>
              <span className="text-white/20 text-xs">{step + 1} / {tour.steps.length}</span>
              {isLast ? (
                <button
                  onClick={dismiss}
                  className="text-sm px-3 py-1.5 bg-[#e5e5e5] text-black font-semibold rounded-lg hover:bg-[#d4d4d4] transition-colors"
                >
                  Got it ✓
                </button>
              ) : (
                <button
                  onClick={() => setStep(s => s + 1)}
                  className="text-white text-sm hover:text-[#e5e5e5] transition-colors"
                >
                  Next →
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
