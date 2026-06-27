import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiPage() {
  redirect(ROUTES.KAI_HOME);
}
