/**
 * Where a portal's public link actually points.
 *
 * Most portals render through the generic /portal/{slug|token} file browser.
 * The investor room is different: it renders the curated tile dashboard at its
 * own vanity path, and the generic page would show a bare file list instead —
 * ignoring every tile. Anything that hands out a link has to go through here,
 * or it will quietly send people to the wrong view of the same room.
 *
 * The server has the matching logic in portal.py::_room_link for emails.
 */

/** Rooms that render on a dedicated page rather than the generic portal view. */
const VANITY_PATHS: Record<string, string> = {
  investors: "/investors",
};

/**
 * Vanity rooms are served from the marketing domain, so their shareable link
 * has to name that host explicitly — the manage page runs on the platform
 * host, and window.origin would hand out the wrong URL to send an investor.
 */
const MARKETING_ORIGIN = "https://example.com";

export function portalPath(identifier: string | null | undefined): string {
  if (!identifier) return "/portal/";
  return VANITY_PATHS[identifier] ?? `/portal/${identifier}`;
}

export function portalUrl(identifier: string | null | undefined): string {
  if (identifier && VANITY_PATHS[identifier]) {
    return `${MARKETING_ORIGIN}${VANITY_PATHS[identifier]}`;
  }
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${portalPath(identifier)}`;
}
