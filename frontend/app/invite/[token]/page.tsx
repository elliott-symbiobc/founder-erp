"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface InvitePreview {
  email: string;
  full_name: string | null;
  org_name: string;
  institution: string | null;
  expires_at: string;
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();

  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/proxy/partners/invites/token/${token}`);
      const data = await res.json();
      if (!res.ok) { setLoadError(data.detail ?? "This invitation is not valid."); return; }
      setInvite(data);
      setFullName(data.full_name ?? "");
    })();
  }, [token]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) { setError("Password must be at least 10 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/proxy/partners/invites/token/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, full_name: fullName.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail ?? "Could not create your account."); return; }
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } finally {
      setSubmitting(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen grid place-items-center bg-gray-50 dark:bg-gray-900 p-6">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 shadow-sm">
        {children}
      </div>
    </div>
  );

  if (loadError) {
    return shell(
      <>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Invitation unavailable</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{loadError}</p>
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
          Ask your program coordinator to send a new invitation.
        </p>
      </>
    );
  }

  if (!invite) return shell(<p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>);

  if (done) {
    return shell(
      <>
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Account created</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Taking you to the sign-in page…
        </p>
      </>
    );
  }

  return shell(
    <>
      <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Join {invite.org_name}
      </h1>
      {invite.institution && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{invite.institution}</p>
      )}
      <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
        Set a password for <span className="font-medium text-gray-900 dark:text-gray-100">{invite.email}</span>.
      </p>

      <form onSubmit={accept} className="mt-6 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Full name</label>
          <input
            value={fullName}
            onChange={e => setFullName(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">At least 10 characters.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white py-2.5 text-sm font-medium disabled:opacity-50"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </>
  );
}
