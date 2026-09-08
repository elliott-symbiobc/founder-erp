"use client";

import { useState, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";

const STEPS = ["Welcome", "Logo", "Colors", "Integrations", "Tour"];

const INTEGRATIONS = [
  {
    key: "anthropic_api_key",
    label: "Anthropic (Claude AI)",
    description: "Powers AI features: notebook summaries, SOP generation, contact insights.",
    optional: false,
    howTo: [
      "Go to console.anthropic.com and sign in or create an account.",
      "Click your profile icon → API Keys.",
      "Click Create Key, give it a name (e.g. \"Collective ERP\"), and copy it.",
      "Paste it below.",
    ],
    link: "https://console.anthropic.com",
    linkLabel: "Open Anthropic Console",
  },
  {
    key: "granola_api_key",
    label: "Granola (Meeting Notes)",
    description: "Syncs AI meeting notes and transcripts into the Notes module.",
    optional: true,
    howTo: [
      "Open the Granola desktop app and sign in.",
      "Go to Settings → Integrations → API.",
      "Generate a new API key and copy it.",
      "Paste it below.",
    ],
    link: "https://granola.so",
    linkLabel: "Open Granola",
  },
  {
    key: "google",
    label: "Google (Gmail & Calendar)",
    description: "Syncs your Gmail contacts and events into the Contacts and Calendar modules.",
    optional: true,
    multi: true,
    fields: [
      { key: "google_client_id", label: "Client ID" },
      { key: "google_client_secret", label: "Client Secret" },
    ],
    howTo: [
      "Go to console.cloud.google.com and create a new project.",
      "Enable the Gmail API and Google Calendar API from the API Library.",
      "Go to Credentials → Create Credentials → OAuth 2.0 Client ID.",
      "Set the application type to \"Web application\".",
      "Add your frontend URL as an authorised redirect URI (e.g. https://your-app.up.railway.app/api/auth/callback/google).",
      "Copy the Client ID and Client Secret and paste them below.",
    ],
    link: "https://console.cloud.google.com",
    linkLabel: "Open Google Cloud Console",
  },
  {
    key: "plaid",
    label: "Plaid (Bank Accounts)",
    description: "Connects your bank accounts to the FP&A dashboard for real-time cash position.",
    optional: true,
    multi: true,
    fields: [
      { key: "plaid_client_id", label: "Client ID" },
      { key: "plaid_secret", label: "Secret" },
    ],
    howTo: [
      "Go to dashboard.plaid.com and create a free account.",
      "Navigate to Team Settings → Keys.",
      "Copy your Sandbox Client ID and Sandbox Secret to test first.",
      "Paste them below.",
    ],
    link: "https://dashboard.plaid.com",
    linkLabel: "Open Plaid Dashboard",
  },
  {
    key: "qbo",
    label: "QuickBooks Online",
    description: "Pulls your P&L and transaction data into the FP&A module.",
    optional: true,
    multi: true,
    fields: [
      { key: "qbo_client_id", label: "Client ID" },
      { key: "qbo_client_secret", label: "Client Secret" },
    ],
    howTo: [
      "Go to developer.intuit.com and sign in.",
      "Create a new app and select the Accounting scope.",
      "Copy the Client ID and Client Secret from the Keys & OAuth section.",
      "Paste them below.",
    ],
    link: "https://developer.intuit.com",
    linkLabel: "Open Intuit Developer",
  },
];

const TOUR_STEPS = [
  { title: "Dashboard", description: "Your at-a-glance view of tasks, recent activity, and key metrics across the business.", href: "/" },
  { title: "Contacts & CRM", description: "Your full contact database, synced from Gmail. Manage deals, track relationships, and log interactions.", href: "/contacts" },
  { title: "Projects", description: "Track client engagements from kickoff to delivery with milestones, tasks, and Gantt view.", href: "/projects" },
  { title: "Notebook", description: "Rich-text notes with voice transcription and AI summaries. Your team's shared memory.", href: "/notebook" },
  { title: "FP&A", description: "Connect your bank accounts and QuickBooks for real-time cash position and burn rate.", href: "/fpa" },
  { title: "Invoices", description: "Create and send invoices, track payment status, and build a reusable product catalog.", href: "/invoices" },
  { title: "Admin", description: "Manage team members, roles, permissions, and system settings from here.", href: "/admin/users" },
];

export default function SetupPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Logo step
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Colors step
  const [primaryColor, setPrimaryColor] = useState("#e5e5e5");
  const [darkColor, setDarkColor] = useState("#1b1a1a");

  // Integrations step
  const [intValues, setIntValues] = useState<Record<string, string>>({});
  const [expandedInt, setExpandedInt] = useState<string | null>("anthropic_api_key");

  // Tour step
  const [tourStep, setTourStep] = useState(0);

  const role = (session?.user as { role?: string })?.role;

  useEffect(() => {
    if (session && role !== "admin") router.replace("/");
  }, [session, role, router]);

  async function saveSettings(patch: Record<string, string>) {
    await fetch("/api/proxy/settings/platform", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  async function handleLogoUpload() {
    if (!logoFile) return;
    const fd = new FormData();
    fd.append("file", logoFile);
    await fetch("/api/proxy/settings/logo", { method: "POST", body: fd });
  }

  async function nextStep() {
    setSaving(true);
    try {
      if (step === 1 && logoFile) await handleLogoUpload();
      if (step === 2) await saveSettings({ primary_color: primaryColor, dark_color: darkColor });
      if (step === 3) {
        const toSave: Record<string, string> = {};
        for (const [k, v] of Object.entries(intValues)) {
          if (v.trim()) toSave[k] = v.trim();
        }
        if (Object.keys(toSave).length) await saveSettings(toSave);
      }
    } finally {
      setSaving(false);
    }
    setStep(s => s + 1);
  }

  async function finish() {
    await saveSettings({ onboarding_complete: "true" });
    router.replace("/");
  }

  if (!session) return null;

  return (
    <div className="min-h-screen bg-[#1b1a1a] flex flex-col items-center justify-center p-6">
      {/* Progress bar */}
      <div className="w-full max-w-2xl mb-8">
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors
                ${i < step ? "bg-[#e5e5e5] text-black" : i === step ? "bg-[#e5e5e5] text-black" : "bg-white/10 text-white/40"}`}>
                {i < step ? "✓" : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 transition-colors ${i < step ? "bg-[#e5e5e5]" : "bg-white/10"}`} />
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-between mt-2">
          {STEPS.map((s, i) => (
            <span key={s} className={`text-xs ${i === step ? "text-[#e5e5e5]" : "text-white/30"}`}>{s}</span>
          ))}
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-2xl bg-white/5 border border-white/10 rounded-2xl p-8">

        {/* Step 0: Welcome */}
        {step === 0 && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-[#e5e5e5] flex items-center justify-center mx-auto">
              <span className="text-3xl font-black text-black">C</span>
            </div>
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">Welcome to Collective ERP</h1>
              <p className="text-white/60 text-lg">Let&apos;s get your platform set up. This will only take a few minutes.</p>
            </div>
            <div className="grid grid-cols-2 gap-4 text-left">
              {[
                ["🎨", "Brand it", "Upload your logo and set your colors"],
                ["🔌", "Connect it", "Hook up your tools and services"],
                ["🗺️", "Learn it", "Take a quick tour of the platform"],
                ["🚀", "Launch it", "Start running your business operations"],
              ].map(([icon, title, desc]) => (
                <div key={title as string} className="bg-white/5 rounded-xl p-4">
                  <div className="text-2xl mb-2">{icon}</div>
                  <div className="text-white font-semibold text-sm">{title}</div>
                  <div className="text-white/50 text-xs mt-1">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 1: Logo */}
        {step === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Your Logo</h2>
              <p className="text-white/50">Upload your own logo or keep the Collective default.</p>
            </div>
            <div className="flex flex-col items-center gap-6">
              <div className="w-64 h-24 bg-white/10 rounded-xl flex items-center justify-center overflow-hidden border-2 border-white/20">
                {logoPreview
                  ? <img src={logoPreview} alt="Logo preview" className="max-h-20 max-w-56 object-contain" />
                  : <img src="/logo.svg" alt="Default logo" className="max-h-20 max-w-56 object-contain invert" />
                }
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="px-4 py-2 bg-[#e5e5e5] text-black font-semibold rounded-lg text-sm hover:bg-[#d4d4d4] transition-colors"
                >
                  Upload Logo
                </button>
                {logoPreview && (
                  <button
                    onClick={() => { setLogoPreview(null); setLogoFile(null); }}
                    className="px-4 py-2 bg-white/10 text-white rounded-lg text-sm hover:bg-white/20 transition-colors"
                  >
                    Reset to Default
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setLogoFile(f);
                    setLogoPreview(URL.createObjectURL(f));
                  }
                }}
              />
              <p className="text-white/30 text-xs">PNG, JPG, SVG or WebP — max 5 MB. Recommended: wide format (4:1 ratio).</p>
            </div>
          </div>
        )}

        {/* Step 2: Colors */}
        {step === 2 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Brand Colors</h2>
              <p className="text-white/50">Set your accent color and dark background. Keep the Collective defaults or pick your own.</p>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-3">
                <label className="text-white font-medium text-sm">Primary Accent</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={primaryColor}
                    onChange={e => setPrimaryColor(e.target.value)}
                    className="w-12 h-12 rounded-lg cursor-pointer border-0 bg-transparent"
                  />
                  <input
                    type="text"
                    value={primaryColor}
                    onChange={e => setPrimaryColor(e.target.value)}
                    className="flex-1 bg-white/10 text-white px-3 py-2 rounded-lg text-sm font-mono border border-white/10 focus:outline-none focus:border-[#e5e5e5]"
                  />
                </div>
                <div className="h-10 rounded-lg transition-colors" style={{ backgroundColor: primaryColor }} />
              </div>
              <div className="space-y-3">
                <label className="text-white font-medium text-sm">Dark Background</label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={darkColor}
                    onChange={e => setDarkColor(e.target.value)}
                    className="w-12 h-12 rounded-lg cursor-pointer border-0 bg-transparent"
                  />
                  <input
                    type="text"
                    value={darkColor}
                    onChange={e => setDarkColor(e.target.value)}
                    className="flex-1 bg-white/10 text-white px-3 py-2 rounded-lg text-sm font-mono border border-white/10 focus:outline-none focus:border-[#e5e5e5]"
                  />
                </div>
                <div className="h-10 rounded-lg border border-white/10 transition-colors" style={{ backgroundColor: darkColor }} />
              </div>
            </div>
            <button
              onClick={() => { setPrimaryColor("#e5e5e5"); setDarkColor("#1b1a1a"); }}
              className="text-white/40 text-sm hover:text-white/70 transition-colors underline"
            >
              Reset to Collective defaults
            </button>
            {/* Preview */}
            <div className="rounded-xl overflow-hidden border border-white/10">
              <div className="px-4 py-3 text-sm font-semibold" style={{ backgroundColor: darkColor, color: primaryColor }}>
                Preview — Sidebar
              </div>
              <div className="px-4 py-3 bg-white/5 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center" style={{ backgroundColor: primaryColor, color: darkColor }}>C</div>
                <span className="text-white text-sm">Navigation item</span>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Integrations */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Connect Your Tools</h2>
              <p className="text-white/50">Set up integrations now or skip and do it later from Settings. Required ones are marked.</p>
            </div>
            <div className="bg-[#e5e5e5]/5 border border-[#e5e5e5]/20 rounded-xl p-4 space-y-2">
              <p className="text-[#e5e5e5] text-sm font-semibold">What is an API key?</p>
              <p className="text-white/60 text-sm">An API key is a unique password that lets Collective ERP talk to another service on your behalf — without you needing to share your actual login credentials. Think of it like a valet key: it gives limited, controlled access to a specific service.</p>
              <p className="text-white/60 text-sm">You generate the key inside that service&apos;s developer settings, then paste it here. It stays encrypted in your database and is never shared with anyone. You can revoke it from the original service at any time.</p>
            </div>
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
              {INTEGRATIONS.map(int => {
                const isExpanded = expandedInt === int.key;
                const hasValue = int.multi
                  ? int.fields?.every(f => intValues[f.key])
                  : intValues[int.key];
                return (
                  <div key={int.key} className={`rounded-xl border transition-colors ${isExpanded ? "border-[#e5e5e5]/40 bg-white/5" : "border-white/10 bg-white/[0.02]"}`}>
                    <button
                      className="w-full flex items-center justify-between px-4 py-3 text-left"
                      onClick={() => setExpandedInt(isExpanded ? null : int.key)}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${hasValue ? "bg-[#e5e5e5]" : int.optional ? "bg-white/20" : "bg-yellow-400"}`} />
                        <span className="text-white font-medium text-sm">{int.label}</span>
                        {!int.optional && <span className="text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full">Recommended</span>}
                        {int.optional && <span className="text-xs text-white/30 bg-white/5 px-2 py-0.5 rounded-full">Optional</span>}
                      </div>
                      <svg className={`w-4 h-4 text-white/40 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-4">
                        <p className="text-white/50 text-sm">{int.description}</p>
                        {/* How-to */}
                        <div className="bg-black/20 rounded-lg p-3 space-y-2">
                          <p className="text-white/70 text-xs font-semibold uppercase tracking-wider">How to get your API key</p>
                          {int.howTo.map((step, i) => (
                            <div key={i} className="flex gap-2 text-xs text-white/50">
                              <span className="text-[#e5e5e5] font-bold shrink-0">{i + 1}.</span>
                              <span>{step}</span>
                            </div>
                          ))}
                          <a href={int.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-[#e5e5e5] hover:underline mt-1">
                            {int.linkLabel} →
                          </a>
                        </div>
                        {/* Input fields */}
                        {int.multi ? (
                          <div className="space-y-2">
                            {int.fields?.map(f => (
                              <div key={f.key}>
                                <label className="text-white/50 text-xs mb-1 block">{f.label}</label>
                                <input
                                  type="password"
                                  placeholder={`Paste your ${f.label}`}
                                  value={intValues[f.key] || ""}
                                  onChange={e => setIntValues(v => ({ ...v, [f.key]: e.target.value }))}
                                  className="w-full bg-black/30 text-white px-3 py-2 rounded-lg text-sm border border-white/10 focus:outline-none focus:border-[#e5e5e5] font-mono"
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <input
                            type="password"
                            placeholder="Paste your API key here"
                            value={intValues[int.key] || ""}
                            onChange={e => setIntValues(v => ({ ...v, [int.key]: e.target.value }))}
                            className="w-full bg-black/30 text-white px-3 py-2 rounded-lg text-sm border border-white/10 focus:outline-none focus:border-[#e5e5e5] font-mono"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 4: Tour */}
        {step === 4 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">Quick Tour</h2>
              <p className="text-white/50">Here&apos;s a map of your platform. Click any section to jump to it.</p>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {TOUR_STEPS.map((t, i) => (
                <div
                  key={t.href}
                  className={`flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all
                    ${tourStep === i ? "border-[#e5e5e5]/60 bg-[#e5e5e5]/5" : "border-white/10 bg-white/[0.02] hover:border-white/20"}`}
                  onClick={() => setTourStep(i)}
                >
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors
                    ${tourStep === i ? "bg-[#e5e5e5] text-black" : "bg-white/10 text-white/40"}`}>
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <div className="text-white font-semibold text-sm">{t.title}</div>
                    <div className="text-white/50 text-xs mt-0.5">{t.description}</div>
                  </div>
                  <a
                    href={t.href}
                    onClick={e => e.stopPropagation()}
                    className="text-xs text-[#e5e5e5] hover:underline shrink-0 mt-0.5"
                  >
                    Open →
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between items-center mt-8 pt-6 border-t border-white/10">
          <button
            onClick={() => step > 0 ? setStep(s => s - 1) : null}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${step === 0 ? "invisible" : "text-white/50 hover:text-white"}`}
          >
            ← Back
          </button>
          <div className="flex gap-3">
            {step === 3 && (
              <button
                onClick={() => setStep(s => s + 1)}
                className="px-4 py-2 text-white/50 hover:text-white text-sm transition-colors"
              >
                Skip for now
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={nextStep}
                disabled={saving}
                className="px-6 py-2 bg-[#e5e5e5] text-black font-semibold rounded-lg text-sm hover:bg-[#d4d4d4] transition-colors disabled:opacity-50"
              >
                {saving ? "Saving…" : "Continue →"}
              </button>
            ) : (
              <button
                onClick={finish}
                disabled={saving}
                className="px-6 py-2 bg-[#e5e5e5] text-black font-semibold rounded-lg text-sm hover:bg-[#d4d4d4] transition-colors disabled:opacity-50"
              >
                {saving ? "Finishing…" : "Launch Platform →"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
