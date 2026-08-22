"use client";

import { toast } from "sonner";

import {
  buildCircleJoinUrl,
  resolveCircleJoinOrigin,
} from "@/lib/one-location/circle-join-url";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { OneLocationService } from "@/lib/one-location/service";
import {
  buildCircleInviteShareText,
  circleShareLabel,
  shareNamedCircleCode,
} from "@/lib/one-location/share-circle-code";
import { copyToClipboard } from "@/lib/utils/clipboard";
import type {
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnections,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
} from "@/lib/one-location/types";

/**
 * The Circle callbacks, for a screen that is not the Location agent.
 *
 * Every one of these is a call to `OneLocationService` carrying the vault owner
 * token and nothing else -- no saved place, no geolocation permission, no
 * device record. That is the fact this whole file rests on, and it is why
 * Circle management never needed to live inside the Location agent: the
 * dependency people assumed existed is a naming coincidence.
 *
 * `OneLocationService` keeps its name because the endpoints are still mounted
 * under `/api/one/location/*`; moving those is issue #5458's fourth acceptance
 * criterion and its own change. Renaming the client while the routes stay put
 * would be a large mechanical diff that asserts nothing.
 */

export type ConnectCircleActions = ReturnType<typeof createConnectCircleActions>;

export function createConnectCircleActions({
  vaultOwnerToken,
}: {
  vaultOwnerToken: string;
}) {
  /** One shape for every failure: the service's own words when they are safe to
   *  show, a plain sentence when they are not. */
  async function guard<T>(fallback: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new Error(oneLocationErrorMessage(error, fallback));
    }
  }

  return {
    createCircle: (name: string, kind: OneLocationCircleKind) =>
      guard("Could not create the Circle.", async () => {
        const circle = await OneLocationService.createNamedCircle({
          vaultOwnerToken,
          name,
          kind,
        });
        toast.success(`${circle.name} created.`);
        return circle;
      }),

    resolveCode: (code: string): Promise<OneLocationCircleInvitePreview> =>
      guard("Could not check that code.", () =>
        OneLocationService.resolveNamedCircleCode({ vaultOwnerToken, code }),
      ),

    joinCircle: (code: string): Promise<OneLocationCircleDetail> =>
      guard("Could not join that Circle.", async () => {
        const result = await OneLocationService.joinNamedCircle({
          vaultOwnerToken,
          code,
        });
        // `joined: false` means they were already a member. Saying "joined"
        // again would be a small lie about what just happened.
        toast.success(
          result.joined
            ? `You're in ${result.circle.name}.`
            : `You're already in ${result.circle.name}.`,
        );
        return result.circle;
      }),

    loadCircle: (circleId: string): Promise<OneLocationCircleDetail> =>
      guard("Could not open that Circle.", () =>
        OneLocationService.getCircle({ vaultOwnerToken, circleId }),
      ),

    renameCircle: (circleId: string, name: string) =>
      guard("Could not rename the Circle.", async () => {
        const circle = await OneLocationService.updateNamedCircle({
          vaultOwnerToken,
          circleId,
          name,
        });
        toast.success("Circle renamed.");
        return circle;
      }),

    generateCode: (circleId: string, rotate?: boolean) =>
      guard("Could not create an invite code.", () =>
        OneLocationService.createNamedCircleInviteCode({
          vaultOwnerToken,
          circleId,
          rotate,
        }),
      ),

    loadEligibleConnections: (
      circleId: string,
    ): Promise<OneLocationCircleEligibleConnections> =>
      guard("Could not load your connections.", () =>
        OneLocationService.listNamedCircleEligibleConnections({
          vaultOwnerToken,
          circleId,
        }),
      ),

    inviteConnections: (circleId: string, inviteeUserIds: string[]) =>
      guard("Could not add those people.", async () => {
        const added = await OneLocationService.createNamedCircleMemberInvites({
          vaultOwnerToken,
          circleId,
          inviteeUserIds,
        });
        toast.success(
          inviteeUserIds.length === 1
            ? "Added to the Circle."
            : `${inviteeUserIds.length} people added.`,
        );
        return added;
      }),

    cancelMemberInvite: (inviteId: string) =>
      guard("Could not cancel that invitation.", () =>
        OneLocationService.cancelNamedCircleMemberInvite({
          vaultOwnerToken,
          inviteId,
        }),
      ),

    removeMember: (circleId: string, memberUserId: string) =>
      guard("Could not remove that member.", async () => {
        await OneLocationService.removeNamedCircleMember({
          vaultOwnerToken,
          circleId,
          memberUserId,
        });
        toast.success("Removed from the Circle.");
      }),

    leaveCircle: (circleId: string) =>
      guard("Could not leave the Circle.", async () => {
        await OneLocationService.leaveNamedCircle({ vaultOwnerToken, circleId });
        toast.success("You left the Circle.");
      }),

    copyCode: async (code: string) => {
      if (await copyToClipboard(code)) {
        toast.success("Circle code copied.");
        return;
      }
      toast.error("Could not copy the Circle code.");
    },

    shareCode: async (circle: OneLocationCircleDetail, code: string) => {
      try {
        // Not window.location.origin: inside the installed iOS/Android build
        // that is a Capacitor scheme, and the link it produced was dead.
        const joinOrigin = resolveCircleJoinOrigin();
        const joinUrl = joinOrigin
          ? buildCircleJoinUrl(joinOrigin, code)
          : undefined;
        const delivery = await shareNamedCircleCode({
          title: `Join ${circle.name} on One`,
          // The link lives in `url` only. Repeating it inline made share
          // targets that append `url` to `text` deliver it twice.
          text: buildCircleInviteShareText({
            circleLabel: circleShareLabel(circle.name),
            code,
            hasJoinLink: Boolean(joinUrl),
          }),
          dialogTitle: "Share Circle code",
          url: joinUrl,
        });
        if (delivery === "copied") toast.success("Circle code copied.");
      } catch {
        toast.error("Could not share the Circle code.");
      }
    },

    deleteCircle: (circleId: string) =>
      guard("Could not delete the Circle.", async () => {
        await OneLocationService.deleteNamedCircle({
          vaultOwnerToken,
          circleId,
        });
        toast.success("Circle deleted.");
      }),
  };
}
