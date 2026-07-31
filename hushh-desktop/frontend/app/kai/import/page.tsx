import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiImportPage() {
  redirect(ROUTES.KAI_IMPORT);
}
