import type { LocalActionPreparation } from "@/lib/agent/local-onboarding-actions";
import type {
  OneLocationPublicInvite,
  PublicLinkOperationReceipt,
} from "@/lib/one-location/types";

export type PublicLinkAction =
  | "location.create_public_link"
  | "location.share_public_link"
  | "location.revoke_public_link";
export type PublicLinkBinding = Record<string, unknown> & {
  owner: string;
  action: PublicLinkAction;
  activeInvite: { id: string; expiresAt: string } | null;
  durationHours?: number;
};

export async function preparePublicLink(input: {
  owner: string | null;
  action: PublicLinkAction;
  slots: Record<string, unknown>;
  choice?: string;
  durationOptions: string[];
  read(): Promise<OneLocationPublicInvite[]>;
  needsShareGesture?: boolean;
  showReviewedLink?(link: OneLocationPublicInvite): void;
}): Promise<LocalActionPreparation> {
  if (!input.owner)
    return {
      status: "blocked",
      gate: "input",
      summary: "Unlock One to use your public location links.",
    };
  const links = (await input.read()).filter(
    (link) =>
      link.ownerUserId === input.owner &&
      link.status === "active" &&
      !!link.expiresAt &&
      Date.parse(link.expiresAt) > Date.now(),
  );
  const selectedId =
    input.choice && !input.choice.startsWith("duration:")
      ? input.choice
      : undefined;
  const selected = selectedId
    ? links.find((link) => link.id === selectedId)
    : links.length === 1
      ? links[0]
      : undefined;
  if (selectedId && !selected)
    return {
      status: "blocked",
      gate: "input",
      summary:
        "The selected link changed or expired. Choose a live link again.",
      choices: links
        .slice(0, 30)
        .map((link) => ({
          id: link.id,
          label: `Link ending ${new Date(link.expiresAt!).toLocaleTimeString()}`,
        })),
    };
  if (input.action === "location.create_public_link") {
    if (links.length > 1)
      return {
        status: "blocked",
        gate: "navigation",
        route: "/one/location?view=links",
        waitForUser: true,
        summary:
          "Several public links are still active. Review them before creating or extending one.",
      };
    if (selected && !selected.publicUrl)
      return {
        status: "blocked",
        gate: "navigation",
        route: "/one/location?view=links",
        waitForUser: true,
        summary:
          "This old link cannot be extended safely. Review replacing it in Links.",
      };
    const duration = input.choice?.startsWith("duration:")
      ? input.choice.slice(9)
      : String(input.slots.duration_hours ?? "1");
    if (!input.durationOptions.includes(duration))
      return {
        status: "blocked",
        gate: "input",
        summary: "How long should this public link remain live?",
        choices: input.durationOptions.map((value) => ({
          id: `duration:${value}`,
          label: `${Number(value) * 60} minutes`,
        })),
      };
    return {
      status: "ready",
      binding: {
        owner: input.owner,
        action: input.action,
        durationHours: Number(duration),
        activeInvite: selected
          ? { id: selected.id, expiresAt: selected.expiresAt! }
          : null,
      },
      summary: `${selected ? "Extend the existing public link" : "Create a public link"} for ${Number(duration) * 60} minutes. Anyone holding the link can see your live location.${selected ? " People who already have this URL keep access during the new window." : ""}`,
    };
  }
  if (!selected)
    return links.length
      ? {
          status: "blocked",
          gate: "input",
          summary: "Which public link should I use?",
          choices: links
            .slice(0, 30)
            .map((link) => ({
              id: link.id,
              label: `Link ending ${new Date(link.expiresAt!).toLocaleTimeString()}`,
            })),
        }
      : {
          status: "blocked",
          gate: "navigation",
          route: "/one/location?view=links",
          waitForUser: true,
          summary:
            "There is no live public link. Create one on this screen before sharing or revoking it.",
        };
  if (
    input.action === "location.share_public_link" &&
    input.needsShareGesture
  ) {
    if (!selected.publicUrl)
      return {
        status: "blocked",
        gate: "navigation",
        route: "/one/location?view=links",
        waitForUser: true,
        summary: "This link is no longer available to share. Review Links.",
      };
    input.showReviewedLink?.(selected);
    return {
      status: "simulate",
      summary:
        "Links opened. Tap Share to contacts and choose WhatsApp or another app. The link has not been sent.",
    };
  }
  return {
    status: "ready",
    binding: {
      owner: input.owner,
      action: input.action,
      activeInvite: { id: selected.id, expiresAt: selected.expiresAt! },
    },
    summary:
      input.action === "location.revoke_public_link"
        ? "Revoke this public link so people holding it lose access."
        : "Open the system share sheet for this live link. Choose WhatsApp and the recipient there.",
  };
}

export function verifyPublicLinkReceipt(
  receipt: PublicLinkOperationReceipt | undefined,
  operation: string,
  invite: OneLocationPublicInvite,
  action: "create" | "revoke",
): void {
  if (
    !receipt ||
    receipt.operation_id !== operation ||
    receipt.invite_id !== invite.id ||
    receipt.status !== (action === "revoke" ? "revoked" : "active")
  )
    throw Error(
      "This public-link operation has no correlated receipt. Review Links before retrying.",
    );
}

export function findReviewedPublicLink(
  links: OneLocationPublicInvite[],
  binding: PublicLinkBinding,
  owner: string | null,
) {
  const link = links.find(
    (item) =>
      item.id === binding.activeInvite?.id && item.ownerUserId === owner,
  );
  if (
    binding.owner !== owner ||
    !link ||
    link.status !== "active" ||
    !link.publicUrl ||
    !link.expiresAt ||
    link.expiresAt !== binding.activeInvite?.expiresAt ||
    Date.parse(link.expiresAt) <= Date.now()
  )
    throw Error(
      "That live link changed or expired. Review Links before sharing it.",
    );
  return link;
}
