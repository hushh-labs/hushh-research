"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { useVault } from "@/lib/vault/vault-context";
import { peekMemoryView, type MemoryView } from "@/lib/pkm/memory-refresh";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CacheService } from "@/lib/services/cache-service";
export function LivingMemoryDocument() {
  const router = useRouter();
  const { user } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [view, setView] = useState<{
    userId: string;
    epoch: number;
    view: MemoryView;
  } | null>(null);
  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked) {
      setView(null);
      return;
    }
    const uid = user.uid;
    const epoch = snapshotVaultSessionEpoch();
    const update = () =>
      setView({ userId: uid, epoch, view: peekMemoryView(uid) });
    update();
    const stop = CacheService.getInstance().subscribe(update);
    const timer = window.setInterval(update, 1000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [user?.uid, isVaultUnlocked, vaultOwnerToken]);
  if (!user?.uid || !isVaultUnlocked) return null;
  const current =
    view?.userId === user.uid && view.epoch === snapshotVaultSessionEpoch()
      ? view.view
      : null;
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title="Saved and Add"
          description="Open saved memories, sharing and prices."
          voiceControlId="profile_memory_workspace"
          voiceActionId="route.one_pkm"
          chevron
          onClick={() => router.push(ROUTES.PKM)}
        />
      </SettingsGroup>
      <details className="min-w-0 rounded-lg border p-4">
        <summary>
          Living memory · {current?.status.replaceAll("_", " ") ?? "stale"}
        </summary>
        <p className="my-2 text-sm text-muted-foreground">
          Updates while your app is open and unlocked. Closed-app updates require
          a separately approved always-on runtime. Withheld and unavailable
          sources are listed in the document.
        </p>
        {current?.document ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
            {current.document.markdown}
          </pre>
        ) : (
          <p>Waiting for encrypted source readback.</p>
        )}
      </details>
    </>
  );
}
