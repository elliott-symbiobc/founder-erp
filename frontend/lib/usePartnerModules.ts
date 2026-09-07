"use client";

import { useEffect, useState } from "react";

/** One grantable module, as the API describes it. */
export interface PartnerModule {
  /** Permission key from PERMISSION_KEYS in api/app/routers/auth.py. */
  key: string;
  label: string;
  href: string;
  group: string;
  /** Sub-pages this one grant unlocks, shown as a hint in the admin UI. */
  covers?: string | null;
}

/**
 * The modules a cohort can be granted, fetched rather than hardcoded.
 *
 * This list used to live here in TypeScript while the API kept its own map of
 * which URLs each permission opened. Nothing checked that the two agreed, and
 * they drifted. The API now owns both — the same declaration that builds this
 * list builds the guard's lookup — so the sidebar cannot offer a module the
 * guard will refuse, and a new module is one edit in one language.
 */
export function usePartnerModules() {
  const [modules, setModules] = useState<PartnerModule[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/proxy/partners/modules")
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive || !d) return;
        setModules(d.modules ?? []);
        setGroups(d.groups ?? []);
      })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  return { modules, groups, loaded };
}
