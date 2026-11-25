import type { AgentMessage } from "@/components/agent/agent-chat-workspace";
import { agentActivityIconForTool, connectorBrandForTool, isRoutineReadinessTool, type AgentVisibleStreamEvent } from "@/components/agent/agent-turn-stream-panel";
import { parseAgentActivityExperience } from "@/lib/agent/agui-structured-experiences";
import { parseChatTimestamp } from "@/lib/agent/chat-time-separators";
import { foldSubmittedRequestReceipts } from "@/lib/agent/consent-continuation";
import { parseStoredTextAttachments } from "@/lib/agent/large-text-attachment";
import { wireOutcomeForSentLabel } from "@/lib/consent/open-granted-person-information";
import { parseRestoredTurnActivity, type AgentChatMessage as StoredAgentChatMessage } from "@/lib/services/agent-chat-client";

function formatNow(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

/** The label and the moment for a message created now, taken together. */
// Safety-net for legacy DB rows written before Task 8 metadata was added.
// Those rows carry no metadata and their content is the raw recipient/duration
// seed "I selected: recipientUserId=…; … do not guess — and proceed."
// Matching them prevents the ugly id-dump from ever rendering as a user bubble.
// The shorter acknowledgement seeds ("Yes, go ahead.", "No, do not proceed.",
// "I changed my mind — cancel that, take no action.") are already human-readable
// and must NOT be reclassified — the pattern is intentionally narrow.
const LEGACY_SELECTION_SEED = /^I selected:.*do not guess/s;

export function storedMessageToAgentMessage(
  message: StoredAgentChatMessage,
  seenExperienceIds: Set<string> = new Set(),
): AgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const createdAt = restoredMessageTime(message.created_at);
  // A selection message must never re-render its raw `I selected:` seed on
  // reload: prefer the persisted display label and render it as a chip. The
  // backend (Task 3) guarantees metadata.display for new selection messages;
  // legacy rows without metadata are detected via LEGACY_SELECTION_SEED below.
  // The follow-up turn after an answer is sent as the server's fixed label
  // ("Consent approved"). It is a status chip, never the person's words, even
  // when the server did not mark it (it refused the continuation, or a retry
  // sent the label as a plain turn): the chip then names the request above it.
  const isConsentOutcomeLabel =
    message.role === "user" && wireOutcomeForSentLabel(message.content.trim()) !== null;
  const isSelection = message.metadata?.kind === "selection" || isConsentOutcomeLabel;
  // Detect legacy rows: user message with raw seed content and no usable metadata.
  const isLegacySelectionSeed =
    !isSelection &&
    message.role === "user" &&
    LEGACY_SELECTION_SEED.test(message.content);

  const displayText =
    isConsentOutcomeLabel
      ? message.content.trim()
      : isSelection && message.metadata?.display
      ? message.metadata.display
      : isLegacySelectionSeed
        ? "Your selection"
        : message.content;
  const descriptor = message.metadata?.structuredExperience;
  const restoredExperience =
    descriptor && typeof descriptor.activityType === "string"
      ? parseAgentActivityExperience(descriptor.activityType, descriptor.content)
      : null;
  const orderedExperiences = message.metadata?.structuredExperiences?.flatMap((entry, index) => {
    if (!entry || typeof entry.activityType !== "string") return [];
    const experience = parseAgentActivityExperience(entry.activityType, entry.content);
    return experience ? [{
      id: (typeof entry.id === "string" ? entry.id.trim() : "") ||
        `${message.id}:structured-experience:${index}`,
      experience,
    }] : [];
  });
  const candidates = orderedExperiences?.length ? orderedExperiences : restoredExperience
    ? [
        {
          id:
            (typeof message.metadata?.structuredExperienceId === "string"
              ? message.metadata.structuredExperienceId.trim()
              : "") ||
            `${message.id}:structured-experience`,
          experience: restoredExperience,
        },
      ]
    : [];
  const connectorRead =
    message.role === "assistant" ? message.metadata?.connectorRead : null;
  const structuredExperiences = [
    ...candidates,
    ...(connectorRead
      ? [
          {
            id: `${message.id}:connector-read`,
            experience: connectorRead,
          },
        ]
      : []),
  ].filter(entry => {
    if (seenExperienceIds.has(entry.id)) return false;
    seenExperienceIds.add(entry.id);
    return true;
  });
  // The same Activity rows the owner saw live, rebuilt from app-owned labels.
  const streamEvents: AgentVisibleStreamEvent[] = message.role === "assistant"
    ? parseRestoredTurnActivity(message.metadata?.turnActivity).map((step) => {
      // The same product mark the live row carried, from the same rule.
      const brand = connectorBrandForTool(step.toolName, step.provider) ?? step.provider;
      return {
        id: step.id,
        label: step.label,
        message: step.message,
        status: step.status,
        ...(step.tag ? { tag: step.tag } : {}),
        ...(brand ? { brand } : {}),
        icon: agentActivityIconForTool(step.toolName),
        ...(step.connectorId ? { connectorId: step.connectorId } : {}),
        ...(isRoutineReadinessTool(step.toolName) ? { routine: true as const } : {}),
        createdAtMs: createdAt?.getTime() ?? 0,
      };
    })
    : [];
  // Do not resurrect a duplicate through the legacy descriptor, or leave an
  // empty thinking bubble. Prose and all distinct cards retain source order.
  if (candidates.length && !structuredExperiences.length && !displayText.trim()) return null;
  // Pasted text restores as the chip it was sent as, never as expanded text.
  const attachments = message.role === "user"
    ? parseStoredTextAttachments(message.metadata?.attachments)
    : [];
  return {
    id: message.id,
    role: message.role,
    text: displayText,
    ...(attachments.length ? { attachments } : {}),
    structuredExperience: connectorRead,
    timestamp:
      createdAt && !Number.isNaN(createdAt.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }).format(createdAt)
        : formatNow(),
    ...(createdAt && !Number.isNaN(createdAt.getTime())
      ? { sentAtMs: createdAt.getTime() }
      : {}),
    status: message.status === "error" ? "error" : "done",
    ...(isSelection || isLegacySelectionSeed
      ? { kind: "selection" as const }
      : {}),
    ...(structuredExperiences.length ? { structuredExperiences } : {}),
    ...(streamEvents.length ? { streamEvents } : {}),
    ...(message.metadata?.consentBundleId ? { consentBundleId: message.metadata.consentBundleId } : {}),
    ...(message.metadata?.consentAccessEnded ? { consentAccessEnded: true } : {}),
    ...(message.metadata?.consentAccess ? { consentAccess: message.metadata.consentAccess } : {}),
    ...(message.role === "user" && message.metadata?.queuedInput === "joined"
      ? { queuedPlacement: "joined" as const }
      : {}),
  };
}

/**
 * History timestamps are ADK event times in epoch seconds; ISO strings are
 * accepted too. Reading seconds as milliseconds dated every restored turn to
 * January 1970, which rendered as a wrong clock time after returning to a chat.
 */
export function restoredMessageTime(value: unknown): Date | null {
  return parseChatTimestamp(value);
}

export const RESTORED_CONNECTOR_STEP_LABEL = "Connected tool";

/** Replace restored opaque connector rows with the owner's names; unchanged rows keep identity. */
export function labelRestoredConnectorSteps<T extends { streamEvents?: AgentVisibleStreamEvent[] }>(
  messages: T[],
  names: ReadonlyMap<string, string>,
): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!message.streamEvents?.some((event) => event.connectorId &&
      event.label === RESTORED_CONNECTOR_STEP_LABEL && names.get(event.connectorId)?.trim())) return message;
    changed = true;
    return {
      ...message,
      streamEvents: message.streamEvents.map((event) => {
        const name = event.connectorId ? names.get(event.connectorId)?.trim() : undefined;
        return name && event.label === RESTORED_CONNECTOR_STEP_LABEL ? { ...event, label: name } : event;
      }),
    };
  });
  return changed ? next : messages;
}

export function storedMessagesToAgentMessages(messages: StoredAgentChatMessage[]): AgentMessage[] {
  const seenExperienceIds = new Set<string>();
  // A sent request comes back as a draft plus its Send receipt; fold them so
  // the card restores in place as sent, never as "Not sent yet".
  return foldSubmittedRequestReceipts(messages
    .map(message => storedMessageToAgentMessage(message, seenExperienceIds))
    .filter((message): message is AgentMessage => Boolean(message)));
}
