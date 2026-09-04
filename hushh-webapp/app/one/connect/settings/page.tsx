import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function ConnectSettingsPage() {
  redirect(ROUTES.PROFILE_PREFERENCES_GEMINI);
}
