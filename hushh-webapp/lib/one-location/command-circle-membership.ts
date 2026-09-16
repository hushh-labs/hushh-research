import type {
  LocalActionPreparation,
  LocalActionResources,
  LocalActionContinuation,
} from "@/lib/agent/local-onboarding-actions";
import { readAllCommandPeople } from "./command-preparation";
import { resolveSpokenNames, splitSpokenNames } from "./resolve-spoken-names";
import type {
  OneLocationCircleOverview,
  OneLocationCircleEligibleConnectionsPage,
  OneLocationCircleMemberPage,
} from "./types";
import type { ConnectionPrerequisite } from "./command-connection";

type Person = {
  userId: string;
  displayName: string;
  member?: boolean;
  connectedFromContacts?: boolean;
};
type Choice = { circleId?: string; people: Record<string, string> };
export type CircleMembershipBinding = {
  owner: string;
  circleId: string;
  circleName: string;
  people: Person[];
  sourceReceipt: LocalActionResources[string] | null;
};
export type CircleMembershipResult = {
  added: string[];
  skipped: string[];
  skippedReasons: Record<string, string>;
  invited: string[];
};
export type CircleMembershipPorts = {
  circles(): Promise<Array<{ id: string; name: string }>>;
  overview(id: string): Promise<OneLocationCircleOverview>;
  eligible(
    id: string,
    page: number,
  ): Promise<OneLocationCircleEligibleConnectionsPage>;
  members(id: string, page: number): Promise<OneLocationCircleMemberPage>;
  connectionPrerequisite?: ConnectionPrerequisite;
};

function decodeChoice(value?: string): Choice {
  if (!value?.startsWith("circle-membership:")) return { people: {} };
  try {
    const choice = JSON.parse(
      value.slice("circle-membership:".length),
    ) as Choice;
    if (
      choice &&
      typeof choice.people === "object" &&
      !Array.isArray(choice.people) &&
      Object.keys(choice.people).length <= 50 &&
      Object.values(choice.people).every((id) => typeof id === "string")
    )
      return choice;
  } catch {
    /* A stale choice is not a resource. */
  }
  return { people: {} };
}
const encodeChoice = (choice: Choice) =>
  `circle-membership:${JSON.stringify(choice)}`;

export async function prepareCircleMembership(input: {
  continuation?: LocalActionContinuation;
  owner: string | null;
  slots: Record<string, unknown>;
  choice?: string;
  resources?: LocalActionResources;
  ports: CircleMembershipPorts;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to read your circles.",
    };
  if (input.continuation) {
    const original = input.continuation
      .originalBinding as CircleMembershipBinding;
    if (
      input.continuation.kind !== "membership" ||
      original.owner !== input.owner ||
      !Array.isArray(original.people)
    )
      throw Error(
        "The original membership selection changed. Review the circle.",
      );
    const circle = await input.ports.overview(original.circleId);
    const review = (summary: string): LocalActionPreparation => ({
      status: "blocked",
      gate: "navigation",
      waitForUser: true,
      route: `/one/location?${new URLSearchParams({ action: "circle-detail", circleId: original.circleId })}`,
      summary,
    });
    if (
      circle.id !== original.circleId ||
      !circle.viewerCapabilities?.canInviteMembers ||
      circle.systemKind === "trusted"
    )
      return review(
        "You can no longer add people to this circle. Review its membership.",
      );
    let capacity = Infinity;
    const eligible = await readAllCommandPeople(async (page) => {
      const result = await input.ports.eligible(original.circleId, page);
      capacity = Math.min(capacity, result.remainingCapacity);
      return { ...result, items: result.eligibleConnections };
    });
    const members = await readAllCommandPeople((page) =>
      input.ports.members(original.circleId, page),
    );
    const additions = original.people.filter((person) => !person.member);
    const pending = input.continuation.pendingUnitIndices.flatMap((index) =>
      additions.slice(index * 20, index * 20 + 20),
    );
    if (
      pending.some(
        (person) =>
          !eligible.some((candidate) => candidate.userId === person.userId) &&
          !members.some((member) => member.userId === person.userId),
      )
    )
      return review(
        "A remaining person is no longer eligible. Review this circle; nobody else will be substituted.",
      );
    if (
      pending.filter(
        (person) => !members.some((member) => member.userId === person.userId),
      ).length > capacity
    )
      return review(
        "This circle no longer has space for everyone remaining. Review its capacity.",
      );
    return {
      status: "ready",
      binding: input.continuation.originalBinding,
      summary: `Continue adding ${pending.map((person) => person.displayName).join(", ")} to ${circle.name}. Earlier completed batches will not be repeated.`,
    };
  }
  const choice = decodeChoice(input.choice);
  const source = input.resources?.circle;
  let circleId =
    source?.length === 1 && source[0]?.kind === "circle"
      ? source[0].id
      : choice.circleId;
  if (!circleId) {
    const circles = await input.ports.circles();
    const name = String(input.slots.circle || "")
      .trim()
      .toLocaleLowerCase();
    const matches = name
      ? circles.filter(
          (circle) => circle.name.trim().toLocaleLowerCase() === name,
        )
      : circles;
    if (matches.length !== 1)
      return {
        status: "blocked",
        gate: "input",
        summary:
          name && !matches.length
            ? "That circle was not found. Choose an existing circle or ask to create it."
            : "Which circle do you mean?",
        choices: (matches.length ? matches : circles).map((circle) => ({
          id: encodeChoice({ ...choice, circleId: circle.id }),
          label: circle.name,
        })),
      };
    circleId = matches[0]!.id;
  }
  const circle = await input.ports.overview(circleId);
  if (
    circle.id !== circleId ||
    !circle.viewerCapabilities?.canInviteMembers ||
    circle.systemKind === "trusted"
  )
    return {
      status: "blocked",
      gate: "navigation",
      route: "/one/location?view=people",
      summary:
        "You cannot add members to this circle. Review its current membership.",
    };
  let capacity = Infinity;
  const eligible = await readAllCommandPeople(async (page) => {
    const result = await input.ports.eligible(circleId, page);
    capacity = Math.min(capacity, result.remainingCapacity);
    return { ...result, items: result.eligibleConnections };
  });
  const members = await readAllCommandPeople((page) =>
    input.ports.members(circleId, page),
  );
  const pool: Person[] = [
    ...eligible,
    ...members.map((person) => ({ ...person, member: true })),
  ];
  let people: Person[] = [];
  const audience = input.slots.audience || "named";
  if (audience === "all_connections" || audience === "all_contacts") {
    people = eligible.filter(
      (person) =>
        audience === "all_connections" || person.connectedFromContacts === true,
    );
  } else if (audience === "named") {
    const referencedPeople = input.resources?.person;
    if (referencedPeople?.length) {
      const identities = [
        ...new Set(
          referencedPeople
            .filter((person) => person.kind === "person")
            .map((person) => person.id),
        ),
      ];
      people = identities
        .map((id) => pool.find((person) => person.userId === id))
        .filter((person): person is Person => Boolean(person));
      if (people.length !== referencedPeople.length) {
        const missing = identities.find(
          (id) => !pool.some((person) => person.userId === id),
        );
        if (missing && input.ports.connectionPrerequisite)
          return input.ports.connectionPrerequisite({
            personId: missing,
            choiceForPerson: () => encodeChoice({ ...choice, circleId }),
          });
        return {
          status: "blocked",
          gate: "input",
          summary:
            "An earlier person is no longer eligible for this circle. Review the audience; nobody has been added.",
        };
      }
    } else {
      const names = splitSpokenNames(String(input.slots.person || ""));
      if (!names.length)
        return {
          status: "blocked",
          gate: "input",
          summary: "Who should be added to this circle?",
        };
      if (names.length > 50)
        return {
          status: "blocked",
          gate: "input",
          summary: "Choose up to 50 named people in one request.",
        };
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        const chosen = choice.people[String(index)];
        const matches = chosen
          ? pool.filter((person) => person.userId === chosen)
          : pool.filter(
              (person) =>
                person.displayName.trim().toLocaleLowerCase() ===
                name.trim().toLocaleLowerCase(),
            );
        // The existing owner resolver matches record names after the semantic
        // action has been selected; it never chooses what an utterance means.
        const resolved =
          chosen || matches.length
            ? matches
            : resolveSpokenNames(pool, name, (person) => person.displayName);
        const candidates = Array.isArray(resolved)
          ? resolved
          : resolved.resolved.length
            ? resolved.resolved
            : resolved.unresolved.flatMap((item) =>
                item.kind === "ambiguous" ? item.matches : [],
              );
        if (!candidates.length && input.ports.connectionPrerequisite)
          return input.ports.connectionPrerequisite({
            personId: chosen,
            name,
            choiceForPerson: (id) =>
              encodeChoice({
                circleId,
                people: { ...choice.people, [index]: id },
              }),
          });
        if (candidates.length !== 1)
          return {
            status: "blocked",
            gate: "input",
            summary: candidates.length
              ? `Which ${name} do you mean? Nobody has been added yet.`
              : `${name} is not an eligible connection or current member. Connect with them before adding them. Nobody has been added yet.`,
            choices: candidates.map((person) => ({
              id: encodeChoice({
                circleId,
                people: { ...choice.people, [index]: person.userId },
              }),
              label: person.displayName,
            })),
          };
        people.push(candidates[0]!);
      }
    }
  } else
    return {
      status: "blocked",
      gate: "input",
      summary:
        "Choose named people, all eligible connections, or connected contacts.",
    };
  people = [
    ...new Map(people.map((person) => [person.userId, person])).values(),
  ].sort((a, b) => a.userId.localeCompare(b.userId));
  if (!people.length)
    return {
      status: "blocked",
      gate: "input",
      summary: "No eligible people match that audience. Nobody has been added.",
    };
  const additions = people.filter((person) => !person.member);
  if (additions.length > capacity)
    return {
      status: "blocked",
      gate: "input",
      summary: `${circle.name} has room for ${capacity} more people; your selection needs ${additions.length}. Choose a smaller audience.`,
    };
  const binding: CircleMembershipBinding = {
    owner: input.owner,
    circleId,
    circleName: circle.name,
    sourceReceipt: source || null,
    people: people.map((person) => ({
      userId: person.userId,
      displayName: person.displayName,
      member: !!person.member,
    })),
  };
  return {
    status: "ready",
    binding,
    summary: `Add ${additions.map((person) => person.displayName).join(", ") || "no new members"} to ${circle.name}.${people.length > additions.length ? ` ${people.length - additions.length} already in this circle.` : ""}`,
  };
}

export async function executeCircleMembership(input: {
  binding: CircleMembershipBinding;
  operationId?: string;
  signal?: AbortSignal;
  continuation?: LocalActionContinuation;
  add(ids: string[], batchIndex: number): Promise<CircleMembershipResult>;
}) {
  const result = {
    added: [] as string[],
    skipped: [] as string[],
    skippedReasons: {} as Record<string, string>,
    invited: [] as string[],
    unknown: [] as string[],
    notAttempted: [] as string[],
    completedEarlier: [] as string[],
  };
  const pending = input.binding.people
    .filter((person) => !person.member)
    .map((person) => person.userId);
  for (const person of input.binding.people.filter((person) => person.member)) {
    result.skipped.push(person.userId);
    result.skippedReasons[person.userId] = "already_member";
  }
  for (let offset = 0; offset < pending.length; offset += 20) {
    if (input.continuation?.completedUnitIndices.includes(offset / 20)) {
      result.completedEarlier.push(...pending.slice(offset, offset + 20));
      continue;
    }
    if (input.signal?.aborted) {
      result.notAttempted.push(...pending.slice(offset));
      break;
    }
    const batch = pending.slice(offset, offset + 20);
    try {
      const observed = await input.add(batch, offset / 20);
      const actual = [
        ...observed.added,
        ...observed.skipped,
        ...observed.invited,
      ];
      if (
        new Set(actual).size !== actual.length ||
        actual.some((id) => !batch.includes(id))
      )
        throw new Error("Invalid membership outcome.");
      result.added.push(...observed.added);
      result.skipped.push(...observed.skipped);
      result.invited.push(...observed.invited);
      Object.assign(result.skippedReasons, observed.skippedReasons);
      const missing = batch.filter((id) => !actual.includes(id));
      if (missing.length) {
        result.unknown.push(...missing);
        result.notAttempted.push(...pending.slice(offset + 20));
        break;
      }
    } catch {
      // A response may be lost after commit. Stop; neither retry nor claim
      // definite failure. Resume must consult the owning operation receipt.
      result.unknown.push(...batch);
      result.notAttempted.push(...pending.slice(offset + 20));
      break;
    }
  }
  return result;
}
