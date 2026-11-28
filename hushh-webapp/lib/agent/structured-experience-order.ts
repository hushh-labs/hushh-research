import type { AgentStructuredExperience } from "./agui-structured-experiences";
import { connectorReadNeedsConnection } from "./connector-read-receipt";

type StructuredExperienceItem = { id: string; experience: AgentStructuredExperience };

export function chatStructuredExperienceItems(message: {
  structuredExperiences?: StructuredExperienceItem[];
  structuredExperience?: AgentStructuredExperience | null;
}): StructuredExperienceItem[] {
  if (message.structuredExperiences?.length) return message.structuredExperiences;
  return message.structuredExperience
    ? [{ id: "legacy-structured-experience", experience: message.structuredExperience }]
    : [];
}

export function latestMailQuickActionId(items: readonly StructuredExperienceItem[]): string | undefined {
  return items.findLast(({ experience }) =>
    experience.type === "one.connector_read.v1" && experience.connector === "mail" &&
    experience.status === "ok" && Boolean(experience.liveSources?.length))?.id;
}

export function latestConnectorActionId(items: readonly StructuredExperienceItem[]): string | undefined {
  return items.findLast(({ experience }) =>
    experience.type === "one.workspace_connector_setup.v1" ||
    (experience.type === "one.connector_read.v1" && connectorReadNeedsConnection(experience.status))
  )?.id;
}

/**
 * One secure card per person in a turn. One may both list and show what a
 * person shared; the reader sees that person's card once, where it last
 * arrived.
 */
export function onePerPersonSharedCard<T extends { id: string; experience: AgentStructuredExperience }>(items: T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.experience.type !== "one.shared_with_me_card.v1") {
      kept.unshift(item);
      continue;
    }
    const cards = item.experience.cards.filter((card) => !seen.has(card.person.personRef));
    cards.forEach((card) => seen.add(card.person.personRef));
    if (!cards.length) continue;
    kept.unshift(cards.length === item.experience.cards.length
      ? item : { ...item, experience: { ...item.experience, cards } });
  }
  return kept;
}
