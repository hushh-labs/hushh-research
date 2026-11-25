import { resolveAppEnvironment } from "@/lib/app-env";

export function areGoalsAvailable(): boolean {
  return resolveAppEnvironment() !== "uat";
}
