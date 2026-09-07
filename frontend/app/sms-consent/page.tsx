"use client";

import { useEffect, useState } from "react";

export default function SmsConsentPage() {
  const [backHref, setBackHref] = useState("/login");
  const [backLabel, setBackLabel] = useState("← Back to Sign In");

  useEffect(() => {
    // If arrived from the dashboard, go back there; otherwise back to login
    if (document.referrer.includes("/dashboard") || document.referrer.includes("/sms")) {
      setBackHref("/dashboard");
      setBackLabel("← Back to Dashboard");
    }
  }, []);

  return (
    <>
      {/* Print styles — hide UI chrome, full-width form */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .print-container { max-width: 100% !important; padding: 0 !important; }
          .print-card { box-shadow: none !important; border: none !important; }
        }
      `}</style>

      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 px-4 py-10 print-container">
        <div className="max-w-2xl mx-auto">

          {/* Toolbar */}
          <div className="no-print flex items-center justify-between mb-6">
            <a href={backHref} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
              {backLabel}
            </a>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download / Print PDF
            </button>
          </div>

          {/* Form card */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-8 print-card">

            {/* Header */}
            <div className="text-center border-b border-gray-200 dark:border-gray-700 pb-6 mb-6">
              <p className="text-xs font-semibold tracking-widest text-indigo-600 dark:text-indigo-400 uppercase mb-1">Open ERP Bioculinary LLC</p>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">SMS / Text Message Consent Form</h1>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">TCPA Compliance — Prior Express Written Consent</p>
            </div>

            {/* Introduction */}
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-6">
              By signing this form, you consent to receive automated text messages (SMS) from Open ERP Bioculinary LLC
              at the mobile telephone number provided below. Please read the following disclosures carefully before signing.
            </p>

            {/* Disclosure blocks */}
            <div className="space-y-4 mb-8">

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">What you will receive</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Daily task digest messages sent each morning summarizing your open and overdue tasks assigned within the
                  Open ERP Platform. You may also receive conversational responses when you reply to these messages to
                  manage tasks, ask questions, or get status updates.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Message frequency</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Approximately 1 automated message per day, plus additional messages in response to your replies.
                  Message frequency may vary.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Costs</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Message and data rates may apply. Open ERP Bioculinary LLC does not charge for SMS messages,
                  but your mobile carrier may charge for incoming or outgoing text messages.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">How to opt out</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  You may opt out of receiving SMS messages at any time by replying <strong>STOP</strong> to any
                  message. After opting out you will receive one confirmation message and no further messages will
                  be sent. You may re-enroll at any time by contacting your platform administrator.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Help</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Reply <strong>HELP</strong> to any message for assistance, or contact Open ERP Bioculinary LLC at{" "}
                  <span className="font-medium">elliott@example.com</span>.
                </p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-1">
                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Consent is not a condition of employment</p>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Consent to receive SMS messages is not required as a condition of employment or continued employment
                  with Open ERP Bioculinary LLC.
                </p>
              </div>

            </div>

            {/* Fill-in fields */}
            <div className="space-y-5 mb-8">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Recipient Information</h2>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Full Name</label>
                  <div className="border-b-2 border-gray-300 dark:border-gray-600 h-7" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Title / Role</label>
                  <div className="border-b-2 border-gray-300 dark:border-gray-600 h-7" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Mobile Phone Number (to receive SMS)</label>
                <div className="border-b-2 border-gray-300 dark:border-gray-600 h-7" />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Email Address</label>
                <div className="border-b-2 border-gray-300 dark:border-gray-600 h-7" />
              </div>
            </div>

            {/* Consent statement */}
            <div className="bg-indigo-50 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 mb-8">
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                By signing below, I acknowledge that I have read and understand the above disclosures. I expressly
                consent to receive automated text messages from Open ERP Bioculinary LLC at the mobile number provided.
                I understand that consent is not required as a condition of employment and that I may opt out at any
                time by replying <strong>STOP</strong>.
              </p>
            </div>

            {/* Signature block */}
            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Signature</label>
                <div className="border-b-2 border-gray-800 dark:border-gray-300 h-10" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Date</label>
                <div className="border-b-2 border-gray-800 dark:border-gray-300 h-10" />
              </div>
            </div>

            {/* Footer */}
            <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-700 text-center">
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                Open ERP Bioculinary LLC · St. Louis, MO · elliott@example.com · erp.example.com
              </p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                This form satisfies TCPA prior express written consent requirements (47 U.S.C. § 227).
              </p>
            </div>

          </div>
        </div>
      </div>
    </>
  );
}
