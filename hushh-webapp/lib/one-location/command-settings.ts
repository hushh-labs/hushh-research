import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import type { AutoApproveScope } from "@/lib/one-location/types";

/** Validate authored values and resolve an exact resource; never classify speech. */
export function prepareAutoApprovalCommand(input: {
  owner: string | null | undefined;
  slots: Record<string, unknown>;
  ruleVersion: number;
  circles: ReadonlyArray<{ id: string; name: string }>;
  chosenCircleId?: string;
}): LocalActionPreparation {
  const { slots, owner } = input;
  if (!owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Sign in and unlock to change this setting.",
    };
  if (slots.enabled !== "on" && slots.enabled !== "off")
    return {
      status: "blocked",
      gate: "input",
      summary: "Should automatic approval be on or off?",
    };
  let scope: AutoApproveScope | null = null;
  if (slots.enabled === "on") {
    if (slots.scope === "all_contacts") scope = { kind: "all_contacts" };
    else if (slots.scope === "circle") {
      const name = String(slots.circle || "")
        .trim()
        .toLocaleLowerCase();
      const matches = input.circles.filter((circle) =>
        input.chosenCircleId
          ? circle.id === input.chosenCircleId
          : circle.name.trim().toLocaleLowerCase() === name,
      );
      if (matches.length !== 1)
        return {
          status: "blocked",
          gate: "input",
          summary: matches.length
            ? "Choose the circle you mean."
            : "Which circle can be auto-approved?",
          choices: (matches.length ? matches : input.circles).map((circle) => ({
            id: circle.id,
            label: circle.name,
          })),
        };
      scope = { kind: "circle", circleId: matches[0]!.id };
    } else
      return {
        status: "blocked",
        gate: "input",
        summary:
          "Allow automatic approval for all contacts, or for a particular circle?",
      };
  }
  const circleName =
    scope?.kind === "circle"
      ? input.circles.find((circle) => circle.id === scope.circleId)?.name
      : null;
  return {
    status: "ready",
    binding: {
      owner,
      enabled: slots.enabled === "on",
      scope,
      ruleVersion: input.ruleVersion,
    },
    summary:
      slots.enabled === "off"
        ? "Turn automatic approval off. Each new request will need your answer."
        : `Automatically approve new Location requests from ${circleName || "all contacts"}. Waiting requests still need your answer.`,
  };
}
