import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

/** Existing bookmarks resolve to the Calendar agent without retaining a profile UI. */
export default function IntegrationsPage() {
  redirect(ROUTES.CALENDAR);
}
