"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { KaiPreferencesWizard } from "@/components/kai/onboarding/KaiPreferencesWizard";
import { KaiProfileService, type KaiProfileV2 } from "@/lib/services/kai-profile-service";
import { useFadeInOnReady } from "@/lib/morphy-ux/hooks/use-fade-in-on-ready";

export function KaiPreferencesSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
}) {
  const [profile, setProfile] = useState<KaiProfileV2 | null>(null);
  const [loading, setLoading] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useFadeInOnReady(contentRef, props.open && !loading && !!profile, { fromY: 10 });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!props.open) return;
      setLoading(true);
      try {
        const p = await KaiProfileService.getProfile({
          userId: props.userId,
          vaultKey: props.vaultKey,
          vaultOwnerToken: props.vaultOwnerToken,
        });
        if (!cancelled) setProfile(p);
      } catch (error) {
        console.warn("[KaiPreferencesSheet] Failed to load profile:", error);
        if (!cancelled) setProfile(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [props.open, props.userId, props.vaultKey, props.vaultOwnerToken]);

  return (
    <Sheet
      open={props.open}
      onOpenChange={(next) => {
        if (loading) return;
        props.onOpenChange(next);
      }}
    >
      <SheetContent
        side="bottom"
        className="h-[92dvh] p-0 sm:h-full sm:max-w-md"
      >
        <div className="h-full flex flex-col">
          <SheetHeader className="border-b">
            <SheetTitle>Investment preferences</SheetTitle>
            <SheetDescription>
              Update your horizon and risk settings for portfolio analysis,
              debates, and optimization.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-6">
                <HushhLoader label="Loading preferences..." />
              </div>
            ) : !profile ? (
              <div className="p-6 text-sm text-muted-foreground">
                Couldn&#39;t load preferences. Close and reopen to retry.
              </div>
            ) : (
              <div ref={contentRef} className="p-0">
                <KaiPreferencesWizard
                  mode="edit"
                  layout="sheet"
                  initialAnswers={{
                    investment_horizon: profile.preferences.investment_horizon,
                    drawdown_response: profile.preferences.drawdown_response,
                    volatility_preference: profile.preferences.volatility_preference,
                  }}
                  onComplete={async (payload) => {
                    try {
                      setLoading(true);
                      await KaiProfileService.savePreferences({
                        userId: props.userId,
                        vaultKey: props.vaultKey,
                        vaultOwnerToken: props.vaultOwnerToken,
                        updates: {
                          investment_horizon: payload.investment_horizon,
                          drawdown_response: payload.drawdown_response,
                          volatility_preference: payload.volatility_preference,
                        },
                        mode: "edit",
                        horizonAnchorChoice: payload.horizonAnchorChoice,
                      });
                      toast.success("Preferences updated");
                      props.onOpenChange(false);
                    } catch (error) {
                      console.error("[KaiPreferencesSheet] Save failed:", error);
                      toast.error("Couldn't save preferences. Please retry.");
                    } finally {
                      setLoading(false);
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
