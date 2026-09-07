/** Shared types and helpers for the Learning Center and its admin screens. */

export interface Track {
  track_id: string;
  title: string;
  slug: string;
  summary: string | null;
  kind: "onboarding" | "course";
  cover_url: string | null;
  sort_order: number;
  is_published: boolean;
  module_count?: number;
  completed_count?: number;
  total_minutes?: number;
  org_count?: number;
  pct?: number;
  modules?: LearnModule[];
}

export interface LearnModule {
  module_id: string;
  track_id: string;
  title: string;
  summary: string | null;
  body_md?: string | null;
  video_url: string | null;
  duration_min: number | null;
  resources?: { label: string; url: string }[];
  quiz?: QuizQuestion[];
  has_quiz?: boolean;
  requires_ack: boolean;
  ack_text?: string | null;
  sort_order: number;
  is_published: boolean;
  // Present on the learner's view of a track
  status?: "in_progress" | "completed" | null;
  video_seconds?: number | null;
  completed_at?: string | null;
  track_title?: string;
  track_kind?: string;
  progress?: Progress | null;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answer_index?: number;
  explanation?: string;
}

export interface Progress {
  status: "in_progress" | "completed";
  video_seconds: number;
  quiz_score: number | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  last_seen_at: string | null;
}

export interface PartnerOrg {
  org_id: string;
  name: string;
  slug: string;
  institution: string | null;
  description: string | null;
  contact_name: string | null;
  contact_email: string | null;
  email_domains: string[];
  permissions: Record<string, boolean>;
  is_active: boolean;
  created_at: string;
  member_count?: number;
  pending_invites?: number;
  track_count?: number;
  tracks?: Track[];
}

/**
 * Turn any YouTube or Vimeo URL into its embed form.
 *
 * Content authors paste whatever the address bar gave them — a watch link, a
 * youtu.be short link, a Vimeo page — so normalising here keeps that mess out
 * of the database and out of every component that renders a video.
 */
export function toEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = raw.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    }
    if (host.endsWith("youtube.com")) {
      if (u.pathname.startsWith("/embed/")) return url;
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;
      if (u.pathname.startsWith("/shorts/")) {
        return `https://www.youtube.com/embed/${u.pathname.split("/")[2]}`;
      }
    }
    if (host.endsWith("vimeo.com")) {
      if (host.startsWith("player.")) return url;
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    return url; // Anything else — assume it is already embeddable.
  } catch {
    return null;
  }
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function fmtDuration(mins: number | null | undefined): string {
  if (!mins) return "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The grantable module list moved to the API (app/core/partner_modules.py) and
 * is read through usePartnerModules() in lib/usePartnerModules.ts.
 *
 * It lived here as a hardcoded array while the API separately decided which
 * URLs each permission opened. The two were maintained by hand, nothing checked
 * that they matched, and they drifted — /reports stayed reachable by anyone
 * holding `analyses` although no cohort could be granted Reports at all. One
 * declaration now produces both.
 */
export type { PartnerModule } from "./usePartnerModules";
