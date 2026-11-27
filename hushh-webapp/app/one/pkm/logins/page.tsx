import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";

/** Old bookmarks lead to the single canonical Secrets area in Memory. */
export default function LegacyWebsiteLoginsPage() { redirect(ROUTES.PKM); }
