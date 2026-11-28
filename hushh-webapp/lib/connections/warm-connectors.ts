import { seedConnectorCatalogSnapshot } from "@/components/agent/connectors-panel";
import { warmCustomConnectorsSnapshot } from "@/components/agent/custom-connectors-settings";
import { rememberConnectorPlacement } from "@/components/agent/use-connector-placement";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { seedCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { ownerRequiresByocIsolation } from "@/lib/one/byoc-isolation";
import { primeConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { ExternalConnectorService } from "@/lib/services/external-connector-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

const warmedOwnerKeys = new Set<string>();

/**
 * Opportunistically warms placement, catalog, Calendar, Mail, and saved custom
 * connectors in parallel when the owner interacts with the Profile menu, so
 * opening Connectors paints settled sections on Frame 0 without shifting rows.
 * Strictly fenced to the validated owner + vault epoch and never dispatches
 * shared-hub reads for BYOC owners.
 */
export function warmConnectorsForOwner(input: {
  firebaseUid: string | null;
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  idTokenProvider: (() => Promise<string>) | null;
}): void {
  const { firebaseUid, ownerId, vaultKey, vaultOwnerToken, idTokenProvider } = input;
  if (!firebaseUid || !ownerId || !vaultKey || !vaultOwnerToken) return;
  const principal = snapshotValidatedAuthSessionPrincipal();
  if (!principal || principal.firebaseUid !== firebaseUid || principal.ownerId !== ownerId) return;
  const epoch = snapshotVaultSessionEpoch();
  const key = `${firebaseUid}:${ownerId}:${principal.generation}:${epoch}`;
  if (warmedOwnerKeys.has(key)) return;
  if (warmedOwnerKeys.size >= 8) {
    const oldest = warmedOwnerKeys.values().next().value;
    if (oldest !== undefined) warmedOwnerKeys.delete(oldest);
  }
  warmedOwnerKeys.add(key);

  const isCurrent = () => {
    const current = snapshotValidatedAuthSessionPrincipal();
    return Boolean(
      current &&
        current.firebaseUid === firebaseUid &&
        current.ownerId === ownerId &&
        current.generation === principal.generation &&
        isValidatedAuthSessionOwnerCurrent(current) &&
        isVaultSessionEpochCurrent(epoch),
    );
  };

  void (async () => {
    try {
      const privateAgent = await ownerRequiresByocIsolation();
      if (!isCurrent()) return;
      const placement = privateAgent ? "private" : "shared";
      rememberConnectorPlacement(firebaseUid, ownerId, placement);
      if (placement !== "shared") return;

      const tasks: Promise<unknown>[] = [
        ExternalConnectorService.overview(vaultOwnerToken)
          .then((overview) => {
            if (isCurrent()) seedConnectorCatalogSnapshot(ownerId, true, { overview });
          })
          .catch(() => undefined),
        warmCustomConnectorsSnapshot({ userId: ownerId, vaultKey, vaultOwnerToken }),
      ];

      if (idTokenProvider) {
        tasks.push(
          idTokenProvider()
            .then(async (idToken) => {
              if (!idToken || !isCurrent()) return;
              await Promise.all([
                GoogleCalendarService.status(idToken, ownerId)
                  .then((status) => {
                    if (isCurrent()) seedCalendarConnectionStatus(ownerId, status);
                  })
                  .catch(() => undefined),
                GmailReceiptsService.getStatus({ idToken, userId: ownerId })
                  .then((status) => {
                    if (isCurrent()) {
                      primeConnectorStatus({
                        userId: ownerId,
                        status,
                        source: "status",
                        idTokenProvider,
                      });
                    }
                  })
                  .catch(() => undefined),
              ]);
            })
            .catch(() => undefined),
        );
      }

      await Promise.all(tasks);
    } catch {
      warmedOwnerKeys.delete(key);
    }
  })();
}
