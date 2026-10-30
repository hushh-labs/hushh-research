import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyPkmPage() {
  redirect(ROUTES.PKM);
}
