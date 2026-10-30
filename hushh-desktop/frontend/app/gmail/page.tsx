import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyGmailPage() {
  redirect(ROUTES.GMAIL);
}
