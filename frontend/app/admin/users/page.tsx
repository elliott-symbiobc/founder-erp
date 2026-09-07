"use client";

import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Fragment, useEffect, useState, useCallback } from "react";
import { usePartnerModules } from "@/lib/usePartnerModules";

// ── Types ──────────────────────────────────────────────────────────────────────

interface User {
  user_id: string;
  email: string;
  full_name: string | null;
  name: string | null;
  title: string | null;
  role: string;
  user_type: string;
  is_active: boolean;
  last_login: string | null;
  created_at: string | null;
  org_id: string | null;
  org_name: string | null;
  permissions: Record<string, boolean>;            // raw overrides
  org_permissions: Record<string, boolean>;        // grants from the cohort
  effective_permissions: Record<string, boolean>;  // role ← org ← overrides
}

/** A cohort. Not a module of its own — just how a group of partner accounts
 *  is provisioned and granted access together. */
interface Org {
  org_id: string;
  name: string;
  institution: string | null;
  is_active: boolean;
  permissions: Record<string, boolean>;
  member_count?: number;
  pending_invites?: number;
}

/** Someone invited but not yet signed up. They have no `users` row at all,
 *  which is exactly why they belong in this list — otherwise the people you
 *  just provisioned are invisible everywhere. */
interface Invite {
  invite_id: string;
  email: string;
  full_name: string | null;
  status: string;
  token: string;
  org_id: string;
  org_name: string;
  expires_at: string;
  created_at: string;
  last_sent_at: string | null;
  send_count: number;
  last_send_error: string | null;
}

// ── Permission definitions (must mirror auth.py PERMISSION_KEYS / ROLE_DEFAULTS) ──

interface PermissionDef {
  key: string;
  label: string;
  description: string;
  group: string;
  roleDefaults: { admin: boolean; user: boolean; viewer: boolean; partner: boolean };
}

// Partners default to nothing: a partner account's access comes from its
// cohort's grants, not from the role. Learning is the one exception, so every
// partner account can always reach the Learning Center.
const PERMISSIONS: PermissionDef[] = [
  // ── Core ──
  { key: "contacts",      label: "Contacts & CRM",         description: "Contacts, advisors, clients, relationship graph",      group: "Core",    roleDefaults: { admin: true,  user: true,  viewer: false, partner: false } },
  { key: "projects",      label: "Projects",               description: "Project board and task management",                    group: "Core",    roleDefaults: { admin: true,  user: true,  viewer: true,  partner: false } },
  // ── Finance ──
  { key: "view_fpa",      label: "View FP&A",              description: "Access financial dashboard, actuals, and cash tracking", group: "Finance", roleDefaults: { admin: true, user: false, viewer: false, partner: false } },
  { key: "edit_fpa",      label: "Edit FP&A",              description: "Upload Excel model, connect Plaid and QuickBooks",   group: "Finance", roleDefaults: { admin: true,  user: false, viewer: false, partner: false } },
  { key: "invoices",      label: "Receivables",            description: "Create, view and manage invoices",                   group: "Finance", roleDefaults: { admin: true,  user: true,  viewer: false, partner: false } },
  // ── Workspace ──
  { key: "notes",         label: "Meeting notes",          description: "Meeting notes with recording and AI analysis",       group: "Workspace", roleDefaults: { admin: true, user: true, viewer: false, partner: false } },
  { key: "learn",         label: "Learning Center",        description: "Access learning tracks, modules and progress",       group: "Workspace", roleDefaults: { admin: true, user: true, viewer: true,  partner: true  } },
  // ── Admin ──
  { key: "manage_users",  label: "Manage users",           description: "Access admin panel, create/edit/delete users",       group: "Admin",   roleDefaults: { admin: true,  user: false, viewer: false, partner: false } },
  { key: "manage_partners", label: "Manage cohorts",       description: "Create cohorts, invite partners, author course content", group: "Admin", roleDefaults: { admin: true, user: false, viewer: false, partner: false } },
  { key: "view_activity", label: "View activity log",      description: "See the activity log for other users",               group: "Admin",   roleDefaults: { admin: true,  user: false, viewer: false, partner: false } },
  { key: "dev_mode",      label: "Developer mode",         description: "Enable dev panel and experimental debug features",   group: "Admin",   roleDefaults: { admin: true,  user: true,  viewer: false, partner: false } },
];


const GROUPS = ["Core", "Finance", "Workspace", "Admin"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function RoleBadge({ role }: { role: string }) {
  const cls =
    role === "admin"     ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" :
    role === "user" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" :
    role === "partner"  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" :
                           "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>{role}</span>;
}

const USER_TYPE_LABELS: Record<string, { label: string; cls: string }> = {
  employee:   { label: "Employee",   cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
  advisor:    { label: "Advisor",    cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
  partner:    { label: "Partner",    cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" },
  contractor: { label: "Contractor", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  other:      { label: "Other",      cls: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};
function UserTypeBadge({ type }: { type: string }) {
  const m = USER_TYPE_LABELS[type] ?? USER_TYPE_LABELS.other;
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${m.cls}`}>{m.label}</span>;
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        checked ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`}
        style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
      />
    </button>
  );
}

function PermissionIndicator({ value, isOverride }: { value: boolean; isOverride: boolean }) {
  if (value) {
    return <span className={`text-xs font-medium ${isOverride ? "text-blue-600 dark:text-blue-400" : "text-green-600 dark:text-green-400"}`}>{isOverride ? "✓ on" : "✓"}</span>;
  }
  return <span className={`text-xs ${isOverride ? "text-red-500 dark:text-red-400 font-medium" : "text-gray-300 dark:text-gray-600"}`}>{isOverride ? "✗ off" : "✗"}</span>;
}

// ── Edit modal ─────────────────────────────────────────────────────────────────

function EditUserModal({
  user,
  orgs,
  onClose,
  onSaved,
}: {
  user: User;
  orgs: Org[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    full_name: user.full_name || user.name || "",
    title: user.title || "",
    role: user.role,
    user_type: user.user_type || "employee",
    is_active: user.is_active,
    org_id: user.org_id || "",
  });
  // Track per-key overrides: undefined = use role default, true/false = explicit override
  const [overrides, setOverrides] = useState<Record<string, boolean | undefined>>(() => {
    const init: Record<string, boolean | undefined> = {};
    for (const p of PERMISSIONS) {
      init[p.key] = user.permissions?.[p.key] !== undefined ? user.permissions[p.key] : undefined;
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"profile" | "permissions" | "password">("profile");
  const [newPassword, setNewPassword] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [resettingPw, setResettingPw] = useState(false);

  // The cohort a partner would sit in once this form is saved — their grants
  // come from here, so the toggles must reflect the org picked right now, not
  // the one they had when the modal opened.
  const selectedOrg = orgs.find(o => o.org_id === form.org_id) ?? null;
  const orgGrants: Record<string, boolean> =
    form.role === "partner" && selectedOrg?.is_active ? (selectedOrg.permissions ?? {}) : {};

  // role default ← cohort grant ← per-user override, mirroring
  // effective_permissions() in auth.py.
  function baseFor(key: string): boolean {
    const p = PERMISSIONS.find(p => p.key === key);
    const roleDefault = p ? p.roleDefaults[form.role as keyof typeof p.roleDefaults] ?? false : false;
    return key in orgGrants ? !!orgGrants[key] : roleDefault;
  }

  function effectiveFor(key: string): boolean {
    if (overrides[key] !== undefined) return overrides[key]!;
    return baseFor(key);
  }

  function toggleOverride(key: string) {
    const current = overrides[key];
    const base = baseFor(key);
    if (current === undefined) {
      // No override → set to opposite of the inherited value
      setOverrides(o => ({ ...o, [key]: !base }));
    } else if (current !== base) {
      // Override differs from what's inherited → drop it and go back to inheriting
      setOverrides(o => ({ ...o, [key]: undefined }));
    } else {
      // Override matches what's inherited → flip it
      setOverrides(o => ({ ...o, [key]: !current }));
    }
  }

  // When role changes, recalculate which overrides are still meaningful
  function handleRoleChange(newRole: string) {
    setForm(f => ({
      ...f,
      role: newRole,
      // Keep the two in step: the partner role and the partner user type
      // describe the same thing, and staff are never partners.
      user_type: newRole === "partner" ? "partner"
        : f.user_type === "partner" ? "employee"
        : f.user_type,
      org_id: newRole === "partner" ? f.org_id : "",
    }));
    // Keep overrides that differ from the new role's defaults
    setOverrides(prev => {
      const next: Record<string, boolean | undefined> = {};
      for (const p of PERMISSIONS) {
        const roleDefault = p.roleDefaults[newRole as keyof typeof p.roleDefaults] ?? false;
        if (prev[p.key] !== undefined && prev[p.key] !== roleDefault) {
          next[p.key] = prev[p.key];
        } else {
          next[p.key] = undefined;
        }
      }
      return next;
    });
  }

  async function save() {
    setSaving(true);
    // Only send actual override values (not undefined)
    const permPayload: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) permPayload[k] = v;
    }
    await fetch(`/api/proxy/users/${user.user_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // org_id is sent as "" to clear it, which the API maps to NULL.
      body: JSON.stringify({ ...form, user_type: form.user_type, org_id: form.org_id, permissions: permPayload }),
    });
    setSaving(false);
    onSaved();
    onClose();
  }

  async function resetPassword() {
    if (!newPassword || newPassword.length < 8) { setPwMsg("Min 8 characters."); return; }
    setResettingPw(true);
    const r = await fetch(`/api/proxy/users/${user.user_id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: newPassword }),
    });
    setPwMsg(r.ok ? "Password updated." : "Failed to update password.");
    setResettingPw(false);
    setNewPassword("");
  }

  const hasOverrides = Object.values(overrides).some(v => v !== undefined);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {user.full_name || user.name || user.email}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">{user.email}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 dark:border-gray-800 px-5 shrink-0">
          {(["profile", "permissions", "password"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? "border-blue-600 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {t}
              {t === "permissions" && hasOverrides && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 text-[10px] font-bold">
                  {Object.values(overrides).filter(v => v !== undefined).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {tab === "profile" && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Full name</label>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={form.full_name}
                  onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Title</label>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-2">Base role</label>
                <div className="flex flex-wrap gap-3">
                  {(["admin", "user", "viewer", "partner"] as const).map(r => (
                    <label key={r} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`role_${user.user_id}`}
                        value={r}
                        checked={form.role === r}
                        onChange={() => handleRoleChange(r)}
                        className="accent-blue-600"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300 capitalize">{r}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  {form.role === "admin" ? "Full platform access by default." :
                   form.role === "user" ? "Lab features enabled, FP&A and user management disabled by default." :
                   form.role === "partner" ? "External partner account. Access comes from the cohort below." :
                   "Read-only access to analyses. All write features disabled by default."}
                </p>
              </div>

              {form.role === "partner" && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Cohort</label>
                  <select
                    value={form.org_id}
                    onChange={e => setForm(f => ({ ...f, org_id: e.target.value }))}
                    className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none"
                  >
                    <option value="">— none —</option>
                    {orgs.map(o => (
                      <option key={o.org_id} value={o.org_id}>
                        {o.name}{o.is_active ? "" : " (inactive)"}
                      </option>
                    ))}
                  </select>
                  <p className={`text-xs mt-1.5 ${form.org_id ? "text-gray-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {form.org_id
                      ? "Modules granted to this cohort appear below as the inherited value."
                      : "Without a cohort this account inherits nothing and can only reach the Learning Center."}
                  </p>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">User Type</label>
                <select value={form.user_type} onChange={e => setForm(f => ({ ...f, user_type: e.target.value }))}
                  className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 focus:outline-none">
                  <option value="employee">Employee</option>
                  <option value="advisor">Advisor</option>
                  <option value="partner">Partner</option>
                  <option value="contractor">Contractor</option>
                  <option value="partner">Partner</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <Toggle checked={form.is_active} onChange={v => setForm(f => ({ ...f, is_active: v }))} />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {form.is_active ? "Active — can log in" : "Deactivated — cannot log in"}
                </span>
              </div>
            </div>
          )}

          {tab === "permissions" && (
            <div className="space-y-5">
              <p className="text-xs text-gray-500">
                Overrides apply on top of the base role. Blue = override active. Leaving a toggle at its role default removes the override.
              </p>
              {GROUPS.map(group => {
                const groupPerms = PERMISSIONS.filter(p => p.group === group);
                return (
                  <div key={group}>
                    <p className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">{group}</p>
                    <div className="space-y-2">
                      {groupPerms.map(p => {
                        const eff = effectiveFor(p.key);
                        const inherited = baseFor(p.key);
                        const fromOrg = p.key in orgGrants;
                        const isOverride = overrides[p.key] !== undefined;
                        return (
                          <div key={p.key} className={`flex items-center justify-between py-2 px-3 rounded-lg ${isOverride ? "bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/40" : "bg-gray-50 dark:bg-gray-800/50"}`}>
                            <div className="flex-1 min-w-0 mr-3">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-800 dark:text-gray-200 font-medium">{p.label}</span>
                                {isOverride && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-semibold">OVERRIDE</span>
                                )}
                              </div>
                              <p className="text-xs text-gray-400 mt-0.5 truncate">{p.description}</p>
                              {isOverride && (
                                <p className="text-[11px] text-gray-400 mt-0.5">
                                  {fromOrg ? "Cohort grant" : "Role default"}: {inherited ? "enabled" : "disabled"}
                                  {" · "}
                                  <button
                                    onClick={() => setOverrides(o => ({ ...o, [p.key]: undefined }))}
                                    className="text-blue-500 hover:underline"
                                  >
                                    remove override
                                  </button>
                                </p>
                              )}
                            </div>
                            <Toggle
                              checked={eff}
                              onChange={() => toggleOverride(p.key)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === "password" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Set a new password for this user. They will use it on next login.</p>
              <div>
                <label className="text-xs text-gray-500 block mb-1">New password</label>
                <input
                  type="password"
                  className="w-full px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters"
                />
              </div>
              {pwMsg && (
                <p className={`text-xs ${pwMsg.includes("updated") ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>{pwMsg}</p>
              )}
              <button
                onClick={resetPassword}
                disabled={resettingPw || !newPassword}
                className="px-4 py-1.5 text-sm bg-amber-500 hover:bg-amber-600 text-white rounded-lg transition-colors disabled:opacity-50 font-medium"
              >
                {resettingPw ? "Updating…" : "Update password"}
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-5 py-4 border-t border-gray-100 dark:border-gray-800 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          {(tab === "profile" || tab === "permissions") && (
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 font-medium"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Delete confirm modal ───────────────────────────────────────────────────────

function DeleteConfirm({ user, onClose, onDeleted }: { user: User; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    setError(null);
    const res = await fetch(`/api/proxy/users/${user.user_id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.detail || `Failed to delete user (${res.status}).`);
      return;
    }
    onDeleted();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-sm shadow-2xl">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Delete user?</h3>
        <p className="text-sm text-gray-500 mb-1">
          <span className="font-medium text-gray-700 dark:text-gray-300">{user.full_name || user.email}</span> will be permanently removed.
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-5">This cannot be undone. All their data associations remain but the account is deleted.</p>
        {error && <p className="text-xs text-red-600 dark:text-red-400 mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button onClick={confirm} disabled={deleting} className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium disabled:opacity-50">
            {deleting ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── User row ───────────────────────────────────────────────────────────────────

function UserRow({ user, onEdit, onDelete }: { user: User; onEdit: () => void; onDelete: () => void }) {
  const overrideCount = Object.keys(user.permissions || {}).length;
  const displayName = user.full_name || user.name;
  return (
    <tr className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50/60 dark:hover:bg-gray-800/40 transition-colors group">
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-3">
          <Avatar name={displayName || user.email} size={8} />
          <div className="min-w-0">
            <div className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate">{displayName || <span className="text-gray-400 italic">No name</span>}</div>
            <div className="text-xs text-gray-400 truncate">{user.email}</div>
            {user.title && <div className="text-xs text-gray-400 truncate">{user.title}</div>}
          </div>
        </div>
      </td>
      <td className="py-3 pr-3">
        <div className="flex flex-wrap gap-1.5">
          <RoleBadge role={user.role} />
          <UserTypeBadge type={user.user_type || "employee"} />
          {user.org_name && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {user.org_name}
            </span>
          )}
          {user.role === "partner" && !user.org_id && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title="Inherits no modules">
              no cohort
            </span>
          )}
        </div>
      </td>
      <td className="py-3 pr-3">
        {overrideCount > 0 ? (
          <span className="text-xs px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium border border-blue-100 dark:border-blue-900/50">
            {overrideCount} override{overrideCount > 1 ? "s" : ""}
          </span>
        ) : (
          <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
        )}
      </td>
      <td className="py-3 pr-3">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${user.is_active ? "text-green-700 dark:text-green-400" : "text-gray-400 dark:text-gray-500"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} />
          {user.is_active ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="py-3 pr-3 text-xs text-gray-400 tabular-nums">{fmt(user.last_login)}</td>
      <td className="py-3 pr-5">
        <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="px-2.5 py-1 text-xs font-medium text-gray-500 dark:text-gray-500 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md hover:border-red-300 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Invite row ─────────────────────────────────────────────────────────────────

/** An invited person, rendered in the same table as real accounts. They have
 *  no account yet, so the actions are about the invitation, not the user. */
function InviteRow({ invite, onChanged }: { invite: Invite; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const expired = new Date(invite.expires_at) < new Date();

  async function resend() {
    setBusy(true);
    await fetch(`/api/proxy/partners/invites/${invite.invite_id}/send`, { method: "POST" });
    setBusy(false);
    onChanged();
  }

  async function revoke() {
    setBusy(true);
    await fetch(`/api/proxy/partners/invites/${invite.invite_id}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/invite/${invite.token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <tr className="border-t border-gray-100 dark:border-gray-800 bg-amber-50/30 dark:bg-amber-900/5 hover:bg-amber-50/60 dark:hover:bg-amber-900/10 transition-colors group">
      <td className="py-3 pl-5 pr-3">
        <div className="flex items-center gap-3">
          <Avatar name={invite.full_name || invite.email} size={8} />
          <div className="min-w-0">
            <div className="font-medium text-gray-900 dark:text-gray-100 text-sm truncate">
              {invite.full_name || <span className="text-gray-400 italic">Not signed up yet</span>}
            </div>
            <div className="text-xs text-gray-400 truncate">{invite.email}</div>
          </div>
        </div>
      </td>
      <td className="py-3 pr-3">
        <div className="flex flex-wrap gap-1.5">
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">partner</span>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">{invite.org_name}</span>
        </div>
      </td>
      <td className="py-3 pr-3"><span className="text-xs text-gray-300 dark:text-gray-600">—</span></td>
      <td className="py-3 pr-3">
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${expired ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${expired ? "bg-red-500" : "bg-amber-500"}`} />
          {expired ? "Invite expired" : "Invited"}
        </span>
      </td>
      <td className="py-3 pr-3 text-xs text-gray-400 tabular-nums">
        {invite.last_send_error
          ? <span className="text-red-500" title={invite.last_send_error}>Email failed</span>
          : invite.send_count > 0 ? `Sent ${fmt(invite.last_sent_at)}` : "Not emailed"}
      </td>
      <td className="py-3 pr-5">
        <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={copyLink} className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md hover:border-blue-400 hover:text-blue-600">
            {copied ? "Copied" : "Copy link"}
          </button>
          <button onClick={resend} disabled={busy} className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md hover:border-blue-400 hover:text-blue-600 disabled:opacity-50">
            Resend
          </button>
          <button onClick={revoke} disabled={busy} className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md hover:border-red-300 hover:text-red-500 disabled:opacity-50">
            Revoke
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Access ─────────────────────────────────────────────────────────────────────

/** Role defaults and cohort grants in one place, because they are two tiers of
 *  the same cascade: role default → cohort grant → per-user override. Showing
 *  them as separate panels implied they were separate systems, which is what
 *  made partner access feel bolted on.
 *
 *  Roles are read-only — they are defined in auth.py and apply platform-wide.
 *  Cohorts are editable, and grant from the partner-facing module list.
 */
function AccessPanel({ orgs, onChanged }: { orgs: Org[]; onChanged: () => void }) {
  const ROLES = ["admin", "user", "viewer", "partner"] as const;
  // Served by the API, which derives the access guard from the same list, so a
  // module can never be offered here and refused there.
  const { modules: partnerModules, groups: moduleGroups } = usePartnerModules();
  const [sel, setSel] = useState<string>("admin");
  const [emails, setEmails] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOrg, setNewOrg] = useState({ name: "", institution: "" });
  const [addingOrg, setAddingOrg] = useState(false);

  const org = orgs.find(o => o.org_id === sel) ?? null;
  const isRole = (ROLES as readonly string[]).includes(sel);

  async function toggleGrant(key: string) {
    if (!org) return;
    const next = { ...(org.permissions ?? {}), [key]: !org.permissions?.[key] };
    await fetch(`/api/proxy/partners/orgs/${org.org_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: next }),
    });
    onChanged();
  }

  async function createOrg() {
    if (!newOrg.name.trim()) return;
    setBusy(true);
    const res = await fetch("/api/proxy/partners/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newOrg.name.trim(), institution: newOrg.institution.trim() || null }),
    });
    setBusy(false);
    if (res.ok) { setNewOrg({ name: "", institution: "" }); setAddingOrg(false); onChanged(); }
    else setNotice("Could not create that cohort.");
  }

  async function sendInvites() {
    if (!org) return;
    const list = emails.split(/[\s,;]+/).map(e => e.trim()).filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/proxy/partners/orgs/${org.org_id}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: list, send_email: sendEmail }),
      });
      const data = await res.json();
      setEmails("");
      const parts: string[] = [`${data.created?.length ?? 0} invited`];
      if (sendEmail) parts.push(`${data.sent ?? 0} emailed`);
      if (data.failed_to_send?.length) {
        parts.push(`${data.failed_to_send.length} could not be emailed — the invitations are still valid, copy their links from the table above.`);
      }
      if (data.rejected?.length) {
        parts.push(`${data.rejected.length} rejected: ` +
          data.rejected.map((r: { email: string; reason: string }) => `${r.email} (${r.reason})`).join(", "));
      }
      setNotice(parts.join(" · "));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const chip = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
      active
        ? "border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20"
        : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-300"
    }`;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Access</h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Resolved as role default → cohort grant → per-user override, last one winning.
          Roles apply platform-wide; cohort grants apply to every partner in that cohort.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ROLES.map(r => (
          <button key={r} onClick={() => setSel(r)} className={`${chip(sel === r)} capitalize`}>{r}</button>
        ))}
        {orgs.length > 0 && <span className="mx-1 h-4 w-px bg-gray-200 dark:bg-gray-700" />}
        {orgs.map(o => (
          <button key={o.org_id} onClick={() => setSel(o.org_id)} className={chip(sel === o.org_id)}>
            {o.name}{!o.is_active && <span className="ml-1 text-gray-400">(inactive)</span>}
          </button>
        ))}
        <button
          onClick={() => setAddingOrg(v => !v)}
          className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:text-blue-600 hover:border-blue-400"
        >
          + Cohort
        </button>
      </div>

      {addingOrg && (
        <div className="flex flex-wrap gap-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3">
          <input
            value={newOrg.name}
            onChange={e => setNewOrg(v => ({ ...v, name: e.target.value }))}
            placeholder="Cohort name"
            className="flex-1 min-w-[10rem] px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
          />
          <input
            value={newOrg.institution}
            onChange={e => setNewOrg(v => ({ ...v, institution: e.target.value }))}
            placeholder="Institution"
            className="flex-1 min-w-[10rem] px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900"
          />
          <button onClick={createOrg} disabled={busy || !newOrg.name.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50">
            Create
          </button>
        </div>
      )}

      {/* Role defaults — read-only, they come from the API's ROLE_DEFAULTS */}
      {isRole && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {GROUPS.map(group => {
                const rows = PERMISSIONS.filter(p => p.group === group);
                if (!rows.length) return null;
                return (
                  <Fragment key={group}>
                    <tr>
                      <td colSpan={2} className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{group}</td>
                    </tr>
                    {rows.map(p => (
                      <tr key={p.key} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="py-1.5 pr-4 text-gray-700 dark:text-gray-300">
                          <div className="font-medium">{p.label}</div>
                          <div className="text-gray-400">{p.description}</div>
                        </td>
                        <td className="py-1.5 w-16 text-center">
                          <PermissionIndicator value={p.roleDefaults[sel as keyof typeof p.roleDefaults]} isOverride={false} />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-3">
            {sel === "partner"
              ? "Partners inherit nothing by role. Their modules come from the cohort they belong to."
              : "Role defaults are platform-wide. Adjust one person under Edit in the table above."}
          </p>
        </div>
      )}

      {/* Cohort grants — editable */}
      {org && (
        <div className="space-y-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
              Modules granted to {org.name}
            </p>
            <div className="space-y-3">
              {moduleGroups.map(group => {
                const mods = partnerModules.filter(m => m.group === group);
                if (!mods.length) return null;
                return (
                  <div key={group}>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{group}</p>
                    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                      {mods.map(m => (
                        <label key={m.key} className="flex items-start gap-2.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-blue-600"
                            checked={m.key === "learn" ? true : !!org.permissions?.[m.key]}
                            disabled={m.key === "learn"}
                            onChange={() => toggleGrant(m.key)}
                          />
                          <span className="min-w-0">
                            <span className="block text-gray-800 dark:text-gray-200">{m.label}</span>
                            {m.key === "learn"
                              ? <span className="block text-xs text-gray-400">Always on for partner accounts</span>
                              : m.covers && <span className="block text-xs text-gray-400 truncate">{m.covers}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">Invite to {org.name}</p>
            <textarea
              value={emails}
              onChange={e => setEmails(e.target.value)}
              rows={2}
              placeholder="Email addresses, separated by commas, spaces or new lines"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
            <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
                <input type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} className="accent-blue-600" />
                Email the invitation
              </label>
              <button onClick={sendInvites} disabled={busy || !emails.trim()}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                {busy ? "Inviting…" : "Send invites"}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && <p className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">{notice}</p>}
    </div>
  );
}

// ── Add user modal ─────────────────────────────────────────────────────────────

/** Creating an account with a password set by the admin. Partners normally
 *  arrive by invitation instead, so this lives behind a button rather than
 *  taking up the page. */
function AddUserModal({ orgs, onClose, onCreated }: { orgs: Org[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ email: "", full_name: "", title: "", role: "viewer", password: "", org_id: "" });
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    setSaving(true);
    setMsg("");
    const res = await fetch("/api/proxy/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) { onCreated(); onClose(); return; }
    const err = await res.json().catch(() => ({}));
    setMsg(err.detail || "Failed to create user.");
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add user</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(["email", "full_name", "title", "password"] as const).map(f => (
              <div key={f}>
                <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
                  {f === "full_name" ? "Full name" : f === "password" ? "Temporary password" : f.charAt(0).toUpperCase() + f.slice(1)}
                </label>
                <input
                  type={f === "password" ? "password" : "text"}
                  className="w-full px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={form[f]}
                  onChange={e => setForm(v => ({ ...v, [f]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 block mb-2">Base role</label>
            <div className="flex flex-wrap gap-4">
              {(["admin", "user", "viewer", "partner"] as const).map(r => (
                <label key={r} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="add_role"
                    value={r}
                    checked={form.role === r}
                    onChange={() => setForm(v => ({ ...v, role: r, org_id: r === "partner" ? v.org_id : "" }))}
                    className="accent-blue-600"
                  />
                  <span className="capitalize text-gray-700 dark:text-gray-300">{r}</span>
                </label>
              ))}
            </div>
          </div>

          {form.role === "partner" && (
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Cohort</label>
              <select
                value={form.org_id}
                onChange={e => setForm(v => ({ ...v, org_id: e.target.value }))}
                className="w-full px-3 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                <option value="">— pick a cohort —</option>
                {orgs.map(o => <option key={o.org_id} value={o.org_id}>{o.name}</option>)}
              </select>
              <p className="text-xs text-gray-400 mt-1.5">
                Setting a password here skips the invitation. To let them choose their own,
                use Send invites under Access.
              </p>
            </div>
          )}

          <p className="text-xs text-gray-400">Permission overrides can be set after creating the user.</p>
          {msg && <p className="text-sm text-red-600 dark:text-red-400">{msg}</p>}
        </div>

        <div className="flex justify-between items-center px-5 py-4 border-t border-gray-100 dark:border-gray-800 shrink-0">
          <button onClick={onClose} className="px-4 py-1.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={saving || !form.email || !form.password}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create user"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [deleteUser, setDeleteUser] = useState<User | null>(null);
  const [adding, setAdding] = useState(false);

  // Accounts, cohorts and outstanding invitations are one picture: someone you
  // invited yesterday has no `users` row yet, and leaving them out is what made
  // provisioned people look like they had vanished.
  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [u, o, i] = await Promise.all([
      fetch("/api/proxy/users").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/partners/orgs").then(r => r.ok ? r.json() : []),
      fetch("/api/proxy/partners/invites").then(r => r.ok ? r.json() : []),
    ]);
    setUsers(u); setOrgs(o); setInvites(i);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) return (
    <div className="flex items-center justify-center h-48 text-gray-400 text-sm">Loading…</div>
  );

  const activeUsers = users.filter(u => u.is_active);
  const inactiveUsers = users.filter(u => !u.is_active);
  const pendingInvites = invites.filter(i => i.status === "pending");

  return (
    <div className="max-w-5xl space-y-6">

      {/* Users table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Users</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {activeUsers.length} active · {inactiveUsers.length} inactive
              {pendingInvites.length > 0 && ` · ${pendingInvites.length} invited`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Integrations
            </Link>
            <button
              onClick={() => setAdding(true)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors"
            >
              Add user
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-800/60">
                <th className="text-left pl-5 pr-3 py-2.5 font-medium tracking-wide">User</th>
                <th className="text-left pr-3 py-2.5 font-medium tracking-wide">Role</th>
                <th className="text-left pr-3 py-2.5 font-medium tracking-wide">Overrides</th>
                <th className="text-left pr-3 py-2.5 font-medium tracking-wide">Status</th>
                <th className="text-left pr-3 py-2.5 font-medium tracking-wide">Last login</th>
                <th className="py-2.5 pr-5" />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <UserRow
                  key={u.user_id}
                  user={u}
                  onEdit={() => setEditUser(u)}
                  onDelete={() => setDeleteUser(u)}
                />
              ))}
              {pendingInvites.map(i => (
                <InviteRow key={i.invite_id} invite={i} onChanged={fetchAll} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role defaults and cohort grants — two tiers of one cascade */}
      <AccessPanel orgs={orgs} onChanged={fetchAll} />

      {adding && (
        <AddUserModal orgs={orgs} onClose={() => setAdding(false)} onCreated={fetchAll} />
      )}

      {editUser && (
        <EditUserModal
          user={editUser}
          orgs={orgs}
          onClose={() => setEditUser(null)}
          onSaved={fetchAll}
        />
      )}

      {deleteUser && (
        <DeleteConfirm
          user={deleteUser}
          onClose={() => setDeleteUser(null)}
          onDeleted={fetchAll}
        />
      )}
    </div>
  );
}
