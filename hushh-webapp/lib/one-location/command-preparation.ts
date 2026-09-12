import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";

export type CommandPerson = {
  id: string;
  name: string;
  detail?: string;
  keyId?: string | null;
  ready: boolean;
};

/** Exact record binding after semantic interpretation; never a sentence router. */
export function prepareCommandPeople(input: {
  owner: string | null;
  people: CommandPerson[];
  person?: unknown;
  chosenResourceId?: string;
  selectedIds: string[];
  requiresReady?: boolean;
  extra?: Record<string, unknown>;
}): LocalActionPreparation {
  const name = String(input.person ?? "").trim();
  const matches = input.chosenResourceId
    ? input.people.filter((person) => person.id === input.chosenResourceId)
    : name
      ? input.people.filter(
          (person) =>
            person.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      : input.people.filter((person) => input.selectedIds.includes(person.id));
  if (
    !matches.length ||
    (name && !input.chosenResourceId && matches.length !== 1)
  ) {
    return {
      status: "blocked",
      gate: "input",
      summary: "Choose the person for this Location action.",
      choices: (matches.length ? matches : input.people)
        .slice(0, 30)
        .map((person) => ({
          id: person.id,
          label: person.name,
          detail: person.detail,
        })),
    };
  }
  if (
    !name &&
    !input.chosenResourceId &&
    matches.length !== input.selectedIds.length
  ) {
    return {
      status: "blocked",
      gate: "navigation",
      route: "/one/location",
      summary: "The selected people changed. Review the selection in Location.",
    };
  }
  if (input.requiresReady && matches.some((person) => !person.ready)) {
    return {
      status: "blocked",
      gate: "navigation",
      route: "/one/location?action=share",
      summary:
        "Someone selected still needs to complete Location setup. Review their status.",
    };
  }
  const people = [...matches].sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: "ready",
    binding: {
      owner: input.owner,
      recipientIds: people.map((person) => person.id),
      people,
      ...input.extra,
    },
    summary: `Confirm this Location action for ${people.map((person) => person.name).join(", ")}.`,
  };
}
