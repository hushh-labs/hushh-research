import {
  canonicalActionBinding,
  type LocalActionPreparation,
  type LocalActionResources,
  type LocalActionContinuation,
} from "@/lib/agent/local-onboarding-actions";
import { pendingAudienceBinding } from "./command-continuation";
import type { ConnectionPrerequisite } from "./command-connection";
import type { CommandPerson } from "./command-preparation";
import { resolveSpokenNames, splitSpokenNames } from "./resolve-spoken-names";

type Choice = {
  people: Record<string, string>;
  circleId?: string;
  duration?: string;
  recipientIds?: string[];
};
const encode = (value: Choice) => `location-audience:${JSON.stringify(value)}`;
function decode(value?: string): Choice {
  if (value?.startsWith("location-audience:")) {
    try {
      const item = JSON.parse(value.slice("location-audience:".length));
      if (
        item &&
        typeof item.people === "object" &&
        item.people &&
        !Array.isArray(item.people) &&
        Object.keys(item.people).length <= 50 &&
        Object.values(item.people).every((id) => typeof id === "string")
      )
        return item;
    } catch {
      /* A malformed choice cannot select an identity. */
    }
  }
  return { people: {} };
}

/** Semantic interpretation supplies slots/references. This preparer refreshes
 * concrete records and keeps the whole audience through every choice. */
export async function prepareLocationAudience(input: {
  continuation?: LocalActionContinuation;
  owner: string | null;
  kind: "share" | "ask";
  slots: Record<string, unknown>;
  choice?: string;
  resources?: LocalActionResources;
  selecting?: boolean;
  selectedIds: string[];
  people: CommandPerson[];
  durations: readonly string[];
  extra: Record<string, unknown>;
  connectionPrerequisite?: ConnectionPrerequisite;
  circles(): Promise<Array<{ id: string; name: string }>>;
  members(id: string): Promise<Array<{ userId: string }>>;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to choose the audience.",
    };
  if (input.continuation) {
    const original = input.continuation.originalBinding;
    const pending = pendingAudienceBinding(original, input.continuation);
    const ids = pending.recipientIds as string[];
    const expected = pending.people as CommandPerson[];
    const people = ids.map((id) =>
      input.people.find((person) => person.id === id),
    );
    const review = (summary: string): LocalActionPreparation => ({
      status: "blocked",
      gate: "navigation",
      waitForUser: true,
      route:
        input.kind === "share"
          ? "/one/location?action=share"
          : "/one/location?action=ask",
      summary,
    });
    if (
      original.owner !== input.owner ||
      !input.durations.includes(String(original.duration)) ||
      people.some(
        (person) =>
          !person ||
          !expected.some(
            (prior) =>
              prior.id === person.id &&
              (input.kind !== "share" ||
                (person.ready && prior.keyId === person.keyId)),
          ),
      )
    )
      return review(
        "A remaining person's Location eligibility or duration changed. Review the unfinished audience.",
      );
    for (const circleId of new Set(
      Object.values(
        pending.sourceCircleByRecipient as Record<string, string | null>,
      ).filter((id): id is string => !!id),
    )) {
      if (!(await input.circles()).some((circle) => circle.id === circleId))
        return review(
          "A source circle is unavailable. Review the remaining audience.",
        );
      const members = await input.members(circleId);
      if (
        ids.some(
          (id) =>
            (pending.sourceCircleByRecipient as Record<string, string>)[id] ===
              circleId && !members.some((person) => person.userId === id),
        )
      )
        return review(
          "Circle membership changed. Nobody else will be substituted into this task.",
        );
    }
    const replacements = Array.isArray(input.extra.replacements)
      ? input.extra.replacements.filter((grant) =>
          ids.includes(grant.recipientUserId),
        )
      : [];
    if (
      input.kind === "share" &&
      canonicalActionBinding(replacements) !==
        canonicalActionBinding(pending.replacements)
    )
      return review(
        "An existing share changed. Review the remaining replacements before starting another task.",
      );
    return {
      status: "ready",
      binding: original,
      summary: `${input.kind === "share" ? "Share live location with" : "Ask for location from"} ${people.map((person) => person!.name).join(", ")}. Duration: ${original.duration === "until_stopped" ? "until stopped" : `${original.duration} hours`}. ${input.continuation.completedUnitIndices.length} earlier operations are already complete.`,
    };
  }
  const choice = decode(input.choice);
  const chosen: CommandPerson[] = [];
  const circleAudience = new Set<string>();
  const circleRef = input.resources?.circle;
  const personRefs = input.resources?.person || [];
  let circleId =
    circleRef?.length === 1 && circleRef[0]?.kind === "circle"
      ? circleRef[0].id
      : choice.circleId;
  const circleName = String(input.slots.circle || "").trim();
  if (circleId || circleName) {
    const circles = await input.circles();
    const matches = circles.filter((circle) =>
      circleId
        ? circle.id === circleId
        : circle.name.trim().toLocaleLowerCase() ===
          circleName.toLocaleLowerCase(),
    );
    if (matches.length !== 1)
      return {
        status: "blocked",
        gate: "input",
        summary: "Which circle should this include?",
        choices: (matches.length ? matches : circles).map((circle) => ({
          id: encode({ ...choice, circleId: circle.id }),
          label: circle.name,
        })),
      };
    circleId = matches[0]!.id;
    const members = (await input.members(circleId)).filter(
      (person) => person.userId !== input.owner,
    );
    for (const member of members) {
      const eligible = input.people.find(
        (person) => person.id === member.userId,
      );
      if (!eligible && input.connectionPrerequisite)
        return input.connectionPrerequisite({
          personId: member.userId,
          choiceForPerson: () => encode({ ...choice, circleId }),
        });
      if (!eligible)
        return {
          status: "blocked",
          gate: "input",
          summary:
            "A circle member is not currently eligible for this action. Review the whole audience; nobody has been omitted or contacted.",
        };
      chosen.push(eligible);
      circleAudience.add(eligible.id);
    }
  }
  if (personRefs.length) {
    for (const value of personRefs) {
      const person =
        value.kind === "person" &&
        input.people.find((person) => person.id === value.id);
      if (!person && value.kind === "person" && input.connectionPrerequisite)
        return input.connectionPrerequisite({
          personId: value.id,
          choiceForPerson: () => encode({ ...choice, circleId }),
        });
      if (!person)
        return {
          status: "blocked",
          gate: "input",
          summary:
            "A chosen person is no longer eligible. Review the audience before continuing.",
        };
      chosen.push(person);
    }
  } else if (input.slots.person) {
    const names = splitSpokenNames(String(input.slots.person));
    if (names.length > 50)
      return {
        status: "blocked",
        gate: "input",
        summary: "Choose up to 50 named people in one request.",
      };
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      const exact = choice.people[String(index)];
      const matches = exact
        ? input.people.filter((person) => person.id === exact)
        : input.people.filter(
            (person) =>
              person.name.trim().toLocaleLowerCase() ===
              name.trim().toLocaleLowerCase(),
          );
      if (exact && !matches.length) {
        if (input.connectionPrerequisite)
          return input.connectionPrerequisite({
            personId: exact,
            name,
            choiceForPerson: (id) =>
              encode({
                ...choice,
                circleId,
                people: { ...choice.people, [index]: id },
              }),
          });
        return {
          status: "blocked",
          gate: "input",
          summary:
            "A person you chose is no longer available. Choose the audience again; nobody has been substituted.",
        };
      }
      const result = matches.length
        ? { resolved: matches, unresolved: [] }
        : resolveSpokenNames(input.people, name, (person) => person.name);
      const candidates = result.resolved.length
        ? result.resolved
        : result.unresolved.flatMap((value) =>
            value.kind === "ambiguous" ? value.matches : [],
          );
      if (!candidates.length && input.connectionPrerequisite)
        return input.connectionPrerequisite({
          name,
          choiceForPerson: (id) =>
            encode({
              ...choice,
              circleId,
              people: { ...choice.people, [index]: id },
            }),
        });
      if (candidates.length !== 1)
        return {
          status: "blocked",
          gate: "input",
          summary: candidates.length
            ? `Which ${name} do you mean?`
            : `${name} is not currently eligible. Connect with them or review their setup before continuing.`,
          choices: candidates.map((person) => ({
            id: encode({
              ...choice,
              circleId,
              people: { ...choice.people, [index]: person.id },
            }),
            label: person.name,
            detail: person.detail,
          })),
        };
      chosen.push(candidates[0]!);
    }
  } else if (!circleId) {
    const ids =
      input.choice && !input.choice.startsWith("location-audience:")
        ? [input.choice]
        : choice.recipientIds || input.selectedIds;
    for (const id of ids) {
      const person = input.people.find((person) => person.id === id);
      if (!person)
        return {
          status: "blocked",
          gate: "input",
          summary:
            "The selected audience changed. Choose who should be included.",
        };
      chosen.push(person);
    }
  }
  const people = [
    ...new Map(chosen.map((person) => [person.id, person])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  if (!people.length)
    return {
      status: "blocked",
      gate: "input",
      summary: "Who should be included?",
      choices: input.people
        .slice(0, 30)
        .map((person) => ({
          id: person.id,
          label: person.name,
          detail: person.detail,
        })),
    };
  if (
    input.kind === "share" &&
    !input.selecting &&
    people.some((person) => !person.ready)
  )
    return {
      status: "blocked",
      gate: "input",
      summary: `${people
        .filter((person) => !person.ready)
        .map((person) => person.name)
        .join(
          ", ",
        )} still needs to complete Location setup. Nobody has been left out.`,
    };
  choice.recipientIds = people.map((person) => person.id);
  const duration = choice.duration || String(input.slots.duration_hours || "");
  if (!input.selecting && !input.durations.includes(duration))
    return {
      status: "blocked",
      gate: "input",
      summary: "For how long?",
      choices: input.durations.map((value) => ({
        id: encode({ ...choice, circleId, duration: value }),
        label:
          value === "until_stopped"
            ? "Until I stop"
            : `${Number(value) * 60} minutes`,
      })),
    };
  return {
    status: "ready",
    binding: {
      ...input.extra,
      owner: input.owner,
      recipientIds: people.map((person) => person.id),
      people,
      duration,
      sourceCircleByRecipient: circleId
        ? Object.fromEntries(
            people.map((person) => [
              person.id,
              circleAudience.has(person.id) ? circleId : null,
            ]),
          )
        : input.extra.sourceCircleByRecipient || {},
    },
    summary: `${input.selecting ? "Select" : input.kind === "share" ? "Share live location with" : "Ask for location from"} ${people.map((person) => person.name).join(", ")}.${input.selecting ? "" : ` Duration: ${duration === "until_stopped" ? "until stopped" : `${duration} hours`}.`}`,
  };
}

export function resolvePreparedAudience<
  T extends { userId: string; keyId?: string | null },
>(
  binding: Record<string, unknown>,
  pool: readonly T[],
  owner: string | null,
  options: { requireEncryptionKey: boolean } = { requireEncryptionKey: true },
): T[] {
  if (
    !owner ||
    binding.owner !== owner ||
    !Array.isArray(binding.recipientIds) ||
    !Array.isArray(binding.people)
  )
    throw new Error("The reviewed audience is unavailable. Review it again.");
  const selected = binding.recipientIds.map((id) =>
    pool.find((person) => person.userId === id),
  );
  if (
    !selected.length ||
    selected.some((person) => !person) ||
    new Set(binding.recipientIds).size !== selected.length
  )
    throw new Error("The reviewed audience changed. Nobody has been omitted.");
  const expected = binding.people as CommandPerson[];
  if (
    selected.some(
      (person) =>
        !expected.some(
          (value) =>
            value.id === person!.userId &&
            (!options.requireEncryptionKey ||
              (value.keyId || null) === (person!.keyId || null)),
        ),
    )
  )
    throw new Error(
      "A recipient's Location setup changed. Review the audience again.",
    );
  return selected as T[];
}
