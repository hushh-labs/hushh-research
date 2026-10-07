import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

/** Existing bookmarks resolve to the dedicated Referrals dashboard instead of
 * the retired nested Profile panel. */
export default function ProfileReferralsPage() {
  redirect(ROUTES.ONE_REFERRALS);
}
