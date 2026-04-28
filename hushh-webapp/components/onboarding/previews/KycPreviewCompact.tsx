"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/lib/morphy-ux/card";
import { Icon } from "@/lib/morphy-ux/ui";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import {
  KycWorkflowPkmService,
  KYC_WORKFLOW_PKM_DOMAIN,
} from "@/lib/services/kyc-pkm-write-service";
import { CircleCheck, CircleDashed, Home, Landmark, User } from "lucide-react";

type KycItemStatus = "verified" | "pending" | "not_started" | "failed";

type KycDisplayItem = {
  label: string;
  icon: typeof User;
  iconTone: string;
  status: KycItemStatus;
};

function StatusIcon({ status }: { status: KycItemStatus }) {
  if (status === "verified") {
    return <Icon icon={CircleCheck} size="lg" className="text-emerald-500" />;
  }
  return <Icon icon={CircleDashed} size="lg" className="text-muted-foreground" />;
}

function buildDisplayItems(
  artifact: ReturnType<typeof KycWorkflowPkmService.readWorkflowArtifact>["artifact"]
): KycDisplayItem[] {
  return [
    {
      label: "Identity requirement",
      icon: User,
      iconTone: "text-[var(--tone-blue)] bg-[var(--tone-blue-bg)]",
      status: artifact?.checks.identity.status ?? "not_started",
    },
    {
      label: "Address requirement",
      icon: Home,
      iconTone: "text-violet-600 bg-violet-100 dark:text-violet-300 dark:bg-violet-900/35",
      status: artifact?.checks.address.status ?? "not_started",
    },
    {
      label: "Bank requirement",
      icon: Landmark,
      iconTone: "text-[var(--tone-green)] bg-[var(--tone-green-bg)]",
      status: artifact?.checks.bank.status ?? "not_started",
    },
  ];
}

export function KycPreviewCompact() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();

  const { data: snapshot } = usePkmDomainResource({
    userId: user?.uid ?? "",
    domain: KYC_WORKFLOW_PKM_DOMAIN,
    vaultKey,
    vaultOwnerToken,
    enabled: Boolean(user?.uid && isVaultUnlocked),
  });

  const { artifact } = KycWorkflowPkmService.readWorkflowArtifact(
    snapshot?.data ?? null
  );

  const items = buildDisplayItems(artifact);
  const allVerified = items.every((item) => item.status === "verified");
  const overallLabel = allVerified ? "KYC workflow completed" : "KYC workflow in progress";
  const speedLabel = allVerified ? "SPEED: INSTANT" : "Verification pending";

  return (
    <Card
      variant="none"
      effect="glass"
      preset="hero"
      glassAccent="balanced"
      showRipple={false}
      className="h-full w-full"
    >
      <div className="morphy-theme-content relative overflow-hidden p-7">
        <div className="relative space-y-6">
          <h3 className="text-center text-xl font-extrabold tracking-tight">
            Status: {overallLabel}
          </h3>

          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between rounded-2xl border border-background/70 bg-background/50 px-3.5 py-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`grid h-10 w-10 place-items-center rounded-full ${item.iconTone}`}
                  >
                    <Icon icon={item.icon} size="md" />
                  </div>
                  <span className="text-[15px] font-semibold">{item.label}</span>
                </div>
                <StatusIcon status={item.status} />
              </div>
            ))}
          </div>

          <div className="space-y-2 text-center">
            <Badge className="rounded-full border border-[var(--brand-200)] bg-[var(--brand-50)] px-4 py-1.5 text-[11px] font-bold tracking-wide text-[var(--tone-blue)] uppercase">
              {speedLabel}
            </Badge>
            {allVerified ? (
              <p className="text-xs font-medium text-muted-foreground">
                Accelerated by 90% via automated verification
              </p>
            ) : (
              <p className="text-xs font-medium text-muted-foreground">
                Review pending requirements to keep this workflow moving
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
