import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { connectPersonReviewHref } from "@/lib/navigation/connect-routes";
import {
  ConnectionsService,
  ConnectionsServiceRequestError,
  type ConnectionPersonContext,
  type DirectoryPerson,
  type DirectoryPage,
} from "@/lib/services/connections-service";
import { readAllCommandPeople } from "./command-preparation";

export type ConnectionPrerequisiteInput = {
  personId?: string;
  name?: string;
  choiceForPerson(id: string): string;
};
export type ConnectionPrerequisite = (
  input: ConnectionPrerequisiteInput,
) => Promise<LocalActionPreparation>;

/** Read/propose only. Connect's authored review owns every request and scope. */
export async function prepareLocationConnection(
  input: ConnectionPrerequisiteInput & {
    context(id: string): Promise<ConnectionPersonContext>;
    search(name: string, page: number): Promise<DirectoryPage>;
  },
): Promise<LocalActionPreparation> {
  let id = input.personId;
  if (!id) {
    if (!input.name?.trim())
      return {
        status: "blocked",
        gate: "input",
        summary: "Choose who you want to connect with.",
      };
    const people = await readAllCommandPeople((page) =>
      input.search(input.name!, page),
    );
    const exact = people.filter(
      (person) =>
        person.displayName?.trim().toLocaleLowerCase() ===
        input.name!.trim().toLocaleLowerCase(),
    );
    const candidates: DirectoryPerson[] = exact.length ? exact : people;
    if (candidates.length !== 1)
      return {
        status: "blocked",
        gate: "input",
        summary: candidates.length
          ? `Which ${input.name} do you mean?`
          : `${input.name} is not available in Connect. Choose someone else.`,
        choices: candidates
          .slice(0, 50)
          .map((person) => ({
            id: input.choiceForPerson(person.userId),
            label: person.displayName || "Person",
            detail: person.maskedEmail || person.maskedPhone || undefined,
          })),
      };
    id = candidates[0]!.userId;
  }
  let result: ConnectionPersonContext;
  try {
    result = await input.context(id);
  } catch (error) {
    if (
      error instanceof ConnectionsServiceRequestError &&
      [403, 404].includes(error.status)
    ) {
      return {
        status: "blocked",
        gate: "input",
        summary:
          "This person is no longer available in Connect. Choose someone else.",
      };
    }
    throw error;
  }
  const resolvedChoiceId = input.choiceForPerson(id);
  const name = result.person.displayName || "This person";
  if (result.person.relationship === "connected")
    return {
      status: "blocked",
      gate: "navigation",
      waitForUser: true,
      resolvedChoiceId,
      route: connectPersonReviewHref(id),
      summary: `${name} is connected but not currently eligible for this Location action. Review their connection and Location setup, then Continue to check again.`,
    };
  const incoming =
    result.person.relationship === "pending_incoming" &&
    result.request?.direction === "incoming" &&
    result.request.status === "pending";
  const route = incoming
    ? buildConsentCenterHref("pending", { requestId: result.request!.id })
    : connectPersonReviewHref(id);
  return {
    status: "blocked",
    gate: "navigation",
    waitForUser: true,
    route,
    resolvedChoiceId,
    summary:
      result.person.relationship === "pending_outgoing"
        ? `A connection request to ${name} is still pending. Wait for acceptance, then Continue. Nothing will be added or shared yet.`
        : incoming
          ? `${name} has asked to connect. Review that request, then Continue; Location eligibility will be checked again.`
          : `Connect with ${name} first. Review the connection and any scopes in Connect, then Continue after acceptance. Nothing will be added or shared yet.`,
  };
}

export function locationConnectionPrerequisite(
  idToken: () => Promise<string>,
): ConnectionPrerequisite {
  return async (input) => {
    const token = await idToken();
    return prepareLocationConnection({
      ...input,
      context: (id) =>
        ConnectionsService.getPersonContext({
          idToken: token,
          counterpartUserId: id,
        }),
      search: (name, page) =>
        ConnectionsService.searchDirectory({
          idToken: token,
          query: name,
          page,
          limit: 50,
        }),
    });
  };
}
