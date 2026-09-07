import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

/**
 * The dashboard's contents moved into Tasks: suggestions became the Inbox
 * column, and the calendar moved to the sidebar. This stays as a redirect
 * rather than a deleted route so old links and bookmarks still land somewhere.
 *
 * Where "somewhere" is depends on the account. Tasks needs the `projects`
 * permission, which partner accounts are never granted, so sending them here
 * landed every partner on a "Could not load tasks (403)" screen the moment
 * they signed in. Learning is the one module every partner account has, so
 * that is their landing page.
 */
export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  const role = (session?.user as { role?: string } | undefined)?.role;
  // "student" is the pre-rename role name and still appears in sessions
  // issued before migration 159.
  const isPartner = role === "partner" || role === "student";
  redirect(isPartner ? "/learn" : "/tasks");
}
