import Link from "next/link";

const TOPICS = [
  {
    href: "/kb/contacts",
    title: "Contacts & Relationships",
    desc: "CRM for partners, investors, and advisors — Gmail/Calendar sync, AI follow-ups, relationship graph.",
    time: "4 min",
    color: "bg-pink-600",
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    href: "/kb/projects",
    title: "Projects",
    desc: "Commercial pipeline tracking from lead qualification to closed deal — stage workflow, contact links, task integration.",
    time: "3 min",
    color: "bg-blue-700",
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/kb/fpa",
    title: "Financial Planning & Analysis",
    desc: "Live cash position, burn rate, and P&L from Plaid and QuickBooks — FP&A dashboard for the team.",
    time: "3 min",
    color: "bg-emerald-700",
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    href: "/kb/ai-assistant",
    title: "AI Assistant & Dashboard Intelligence",
    desc: "Omnipresent AI with semantic RAG retrieval — how the dashboard chat works, task capture, daily plans, and the 3-block prompt architecture.",
    time: "5 min",
    color: "bg-purple-600",
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    href: "/kb/agent-manager",
    title: "Agent Manager",
    desc: "Configure every AI agent — model, temperature, top_p, system prompt overrides. Inspect each agent's prompt, context sources, and tools.",
    time: "4 min",
    color: "bg-slate-700",
    icon: (
      <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export default function KbHomePage() {
  const [featured, ...rest] = TOPICS;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Knowledge Base</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Documentation for the Open ERP platform.
        </p>
      </div>

      {/* Featured card */}
      <Link href={featured.href} className="block group">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-6 flex gap-5 hover:border-blue-400 hover:bg-blue-100 transition-colors">
          <div className={`${featured.color} rounded-lg p-3 self-start shrink-0`}>
            {featured.icon}
          </div>
          <div>
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Start here</span>
            <h2 className="mt-0.5 text-lg font-semibold text-gray-900 group-hover:text-blue-700">{featured.title}</h2>
            <p className="mt-1 text-sm text-gray-600">{featured.desc}</p>
            <p className="mt-2 text-xs text-gray-400">{featured.time} read</p>
          </div>
        </div>
      </Link>

      {/* Rest of topics */}
      <div className="grid grid-cols-2 gap-4">
        {rest.map(t => (
          <Link key={t.href} href={t.href} className="block group">
            <div className="rounded-lg border border-gray-200 bg-white p-4 flex gap-4 hover:border-gray-300 hover:shadow-sm transition-all h-full">
              <div className={`${t.color} rounded-md p-2 self-start shrink-0`}>
                {t.icon}
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 group-hover:text-blue-700 leading-snug">{t.title}</h3>
                <p className="mt-1 text-xs text-gray-500 leading-relaxed">{t.desc}</p>
                <p className="mt-2 text-xs text-gray-400">{t.time} read</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
