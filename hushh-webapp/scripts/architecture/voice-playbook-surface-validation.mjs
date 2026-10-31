/** Validate authored route playbook fields without making semantic decisions. */
export function validateVoicePlaybook(route, value) {
  const requiredStrings = [
    "playbookId",
    "purpose",
    "screen",
    "completionBoundary",
    "outOfScopeBehavior",
  ];
  for (const field of requiredStrings) {
    if (typeof value?.[field] !== "string" || !value[field].trim()) {
      throw new Error(`Route ${route} voicePlaybook.${field} is required`);
    }
  }
  if (!/^[a-z0-9._-]{3,96}$/.test(value.playbookId)) {
    throw new Error(`Route ${route} has an invalid voicePlaybook.playbookId`);
  }
  if (!["on_entry", "ambient"].includes(value.proactivity)) {
    throw new Error(`Route ${route} has invalid voicePlaybook.proactivity`);
  }
  if (
    ![
      "stay",
      "navigate",
      "external_callback",
      "return_to_hub",
      "resolve_root",
    ].includes(value.returnPolicy)
  ) {
    throw new Error(`Route ${route} has invalid voicePlaybook.returnPolicy`);
  }
  if (
    !Array.isArray(value.happyPathActionIds) ||
    !Array.isArray(value.requiredInputs)
  ) {
    throw new Error(
      `Route ${route} playbook action/input collections must be arrays`,
    );
  }
  for (const recovery of [
    "blocked",
    "cancelled",
    "failed",
    "timeout",
    "callbackError",
    "routeMismatch",
  ]) {
    if (
      typeof value.recoveries?.[recovery] !== "string" ||
      !value.recoveries[recovery].trim()
    ) {
      throw new Error(
        `Route ${route} voicePlaybook.recoveries.${recovery} is required`,
      );
    }
  }
  if (
    value.proactivity === "on_entry" &&
    !String(value.entryCue || "").trim()
  ) {
    throw new Error(`Route ${route} proactive playbook requires an entryCue`);
  }
  if (value.proactivity === "on_entry" && !String(value.primaryActionId || "").trim()) {
    throw new Error(`Route ${route} proactive playbook requires a primaryActionId`);
  }
  return value;
}
