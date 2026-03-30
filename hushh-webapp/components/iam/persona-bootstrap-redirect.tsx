"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BriefcaseBusiness, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/button";
import { getRouteScope, routePersonaForScope } from "@/lib/navigation/route-scope";
import { ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import type { Persona } from "@/lib/services/ria-service";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { useVault } from "@/lib/vault/vault-context";

function routeForPersona(params: {
  persona: Persona;
  lastKaiPath: string;
  lastRiaPath: string;
  riaEntryRoute: string;
}) {
  return params.persona === "ria"
    ? params.lastRiaPath || params.riaEntryRoute
    : params.lastKaiPath || ROUTES.KAI_HOME;
}

export function PersonaBootstrapRedirect() {
  const { user, isAuthenticated } = useAuth();
  const { isVaultUnlocked } = useVault();
  const {
    personaState,
    activePersona,
    loading,
    refreshing,
    riaCapability,
    riaEntryRoute,
    switchPersona,
  } = usePersonaState();
  const pathname = usePathname();
  const router = useRouter();
  const lastKaiPath = useKaiSession((state) => state.lastKaiPath);
  const lastRiaPath = useKaiSession((state) => state.lastRiaPath);
  const [resolving, setResolving] = useState<"route" | "persona" | null>(null);

  const routeScope = getRouteScope(pathname);
  const routePersona = routePersonaForScope(routeScope);
  const mismatch = useMemo(() => {
    if (!isAuthenticated || !user || loading || refreshing || !personaState || !isVaultUnlocked) {
      return null;
    }
    if (!routePersona || routePersona === activePersona) {
      return null;
    }

    return {
      routePersona,
      activePersona,
      primaryTarget: activePersona,
      scopedRouteLabel: routePersona === "ria" ? "RIA workspace" : "Kai workspace",
      activePersonaLabel: activePersona === "ria" ? "RIA workspace" : "Investor workspace",
    };
  }, [activePersona, isAuthenticated, isVaultUnlocked, loading, personaState, refreshing, routePersona, user]);

  const handleSwitchToActivePersona = useCallback(async () => {
    if (!mismatch) return;
    setResolving("route");
    try {
      router.replace(
        routeForPersona({
          persona: mismatch.primaryTarget,
          lastKaiPath,
          lastRiaPath,
          riaEntryRoute,
        })
      );
    } finally {
      setResolving(null);
    }
  }, [lastKaiPath, lastRiaPath, mismatch, riaEntryRoute, router]);

  const handleStayOnScopedRoute = useCallback(async () => {
    if (!mismatch) return;
    const targetPersona = mismatch.routePersona;

    setResolving("persona");
    try {
      if (targetPersona === "ria" && riaCapability !== "switch") {
        router.replace(riaEntryRoute);
        return;
      }

      await switchPersona(targetPersona);
      router.replace(pathname);
    } catch (error) {
      console.error("[PersonaBootstrapRedirect] Failed to resolve route mismatch:", error);
      toast.error("We couldn't switch roles right now. Please retry.");
    } finally {
      setResolving(null);
    }
  }, [mismatch, pathname, riaCapability, riaEntryRoute, router, switchPersona]);

  if (!mismatch) {
    return null;
  }

  const targetNeedsSetup = mismatch.routePersona === "ria" && riaCapability !== "switch";
  const PromptIcon = mismatch.routePersona === "ria" ? BriefcaseBusiness : UserRound;
  const primaryLabel =
    resolving === "route"
      ? `Opening ${mismatch.activePersonaLabel}...`
      : `Switch to ${mismatch.activePersonaLabel}`;
  const secondaryLabel = targetNeedsSetup
    ? "Set up RIA"
    : resolving === "persona"
      ? `Staying in ${mismatch.scopedRouteLabel}...`
      : `Stay in ${mismatch.scopedRouteLabel}`;

  return (
    <AlertDialog open>
      <AlertDialogContent className="max-w-md rounded-[28px] border border-border/70 bg-background/96 p-0 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.4)]">
        <AlertDialogHeader className="space-y-4 px-6 pt-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-[20px] border border-primary/15 bg-primary/10 text-primary">
            <PromptIcon className="h-5 w-5" />
          </div>
          <div className="space-y-2">
            <AlertDialogTitle className="text-left text-xl font-semibold tracking-tight text-foreground">
              Your active role and current route are out of sync
            </AlertDialogTitle>
            <AlertDialogDescription className="text-left text-sm leading-6 text-muted-foreground">
              You are currently in {activePersona === "ria" ? "RIA" : "Investor"} mode, but this
              page belongs to the {mismatch.routePersona === "ria" ? "RIA" : "Investor"} shell.
              We can move you back to the correct workspace, or you can stay here and switch roles
              explicitly.
            </AlertDialogDescription>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter className="grid gap-2 px-6 pb-6 sm:grid-cols-2 sm:gap-3">
          <Button
            variant="none"
            effect="fade"
            onClick={() => void handleSwitchToActivePersona()}
            disabled={resolving !== null}
            className="w-full"
          >
            {resolving === "route" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {primaryLabel}
          </Button>
          <Button
            variant="blue-gradient"
            effect="fill"
            onClick={() => void handleStayOnScopedRoute()}
            disabled={resolving !== null}
            className="w-full"
          >
            {resolving === "persona" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {secondaryLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
