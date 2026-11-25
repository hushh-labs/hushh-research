import { notFound } from "next/navigation";
import { GoalsWorkspace } from "@/components/goals/goals-workspace";
import { areGoalsAvailable } from "@/lib/goals/availability";

export default function GoalsPage() {
  if (!areGoalsAvailable()) notFound();
  return <GoalsWorkspace />;
}
