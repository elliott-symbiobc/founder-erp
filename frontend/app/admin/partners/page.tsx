import { redirect } from "next/navigation";

/**
 * The Partners module is gone. It was three unrelated things wearing one name:
 * cohort access and member accounts (now in Users, beside every other account),
 * and cohort progress and course content (now in Learning, with the curriculum
 * they describe). A cohort is a grouping of accounts, not a product area.
 *
 * Kept as a redirect so bookmarks and the invitation trail still land somewhere.
 */
export default function PartnersAdminPage() {
  redirect("/admin/users");
}
