"use client";

import { useEffect, useState } from "react";
import { DetailedPersonaForm } from "@/components/kai/onboarding/detailed-persona-form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  FinancePersonaBadge,
  FinancePersonaForm,
} from "@/components/kai/onboarding/finance-persona-form";
import {
  KaiProfileService,
  type KaiPreferences,
  type KaiPreferencesUpdate,
} from "@/lib/services/kai-profile-service";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import styles from "./advisor-review.module.css";

export function PortfolioPersona({
  context,
  onSaved,
}: {
  context: FinanceShareContext;
  onSaved?: () => void;
}) {
  const [preferences, setPreferences] = useState<KaiPreferences | null>(null);
  const [profileUnavailable, setProfileUnavailable] = useState(false);
  const [mode, setMode] = useState<"starter" | "detailed" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    if (context.isCurrent())
      void KaiProfileService.getProfile(context)
        .then((profile) => {
          if (active && context.isCurrent()) {
            setPreferences(profile.preferences);
            setProfileUnavailable(false);
          }
        })
        .catch(() => {
          if (active && context.isCurrent()) setProfileUnavailable(true);
        });
    return () => {
      active = false;
    };
  }, [context]);

  if (!context.isCurrent()) return null;
  if (!preferences) return (
    <p role="status" className="ui-text-helper-text">
      {profileUnavailable ? "Investing persona unavailable." : "Loading your investing persona…"}
    </p>
  );
  const hasAnswers = Boolean(
    preferences.investment_horizon ||
    preferences.drawdown_response ||
    preferences.volatility_preference ||
    preferences.loss_capacity,
  );
  const detailed = preferences.detailed_assessment_v1 != null;
  const save = async (updates: KaiPreferencesUpdate) => {
    requireFinanceSession(context);
    const profile = await KaiProfileService.savePreferences({
      ...context,
      mode: "edit",
      updates,
      beforeEffect: async () => requireFinanceSession(context),
    });
    requireFinanceSession(context);
    setPreferences(profile.preferences);
    onSaved?.();
  };
  return (
    <section className={styles.personaSummary} aria-label="Investing persona">
      <div className={styles.row}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="ui-text-section-label">Investing persona</h3>
            <FinancePersonaBadge preferences={preferences} />
          </div>
          <p className="ui-text-helper-text">
            {detailed
              ? "Detailed profile · Hushh assessment"
              : "Starting profile · Your investing preferences"}
          </p>
        </div>
        <button type="button" className={styles.quietAction} onClick={() => setMode(detailed ? "detailed" : "starter")}>
          Edit persona
        </button>
      </div>
      <Sheet
        modal
        open={mode !== null}
        onOpenChange={(value) => {
          if (!value && !saving) setMode(null);
        }}
      >
        <SheetContent
          side="bottom"
          className={`${styles.reviewSheet} max-h-[92dvh] overflow-y-auto`}
          data-app-type-context="overlay"
        >
          <SheetHeader>
            <SheetTitle>
              {mode === "detailed"
                ? "Refine your persona"
                : "Let’s build your financial persona"}
            </SheetTitle>
            <SheetDescription className="ui-text-row-description">
              {mode === "detailed"
                ? "Hushh assessment · 13 questions about risk comfort, cash needs and timing."
                : "Update the preferences One uses in your portfolio review."}
            </SheetDescription>
          </SheetHeader>
          {mode ? (
            <div className="mx-auto w-full max-w-3xl px-4 pb-6">
              {mode === "starter" ? (
                <button type="button" className={styles.quietAction} disabled={saving} onClick={() => setMode("detailed")}>
                  Open detailed assessment
                </button>
              ) : null}
              {mode === "detailed" ? (
                <DetailedPersonaForm
                  initial={preferences}
                  onSavingChange={setSaving}
                  onDone={() => setMode(null)}
                  onSave={(answers) =>
                    save({ detailed_assessment_v1: answers })
                  }
                />
              ) : (
                <FinancePersonaForm
                  initial={hasAnswers ? preferences : undefined}
                  onSavingChange={setSaving}
                  onDone={() => setMode(null)}
                  onSave={save}
                />
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
