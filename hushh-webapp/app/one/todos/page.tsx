import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { LegacyTasksRedirect } from "./legacy-tasks-redirect";

export default function OneTodosPage() {
  if (process.env.CAPACITOR_BUILD === "true") return <LegacyTasksRedirect />;
  redirect(ROUTES.ONE_TASKS);
}
