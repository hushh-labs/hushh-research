"use client";

import { useEffect, useState } from "react";
import { DetailedPersonaForm } from "@/components/kai/onboarding/detailed-persona-form";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
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
  const [mode, setMode] = useState<"starter" | "detailed" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    if (context.isCurrent())
      void KaiProfileService.getProfile(context).then((profile) => {
        if (active && context.isCurrent()) setPreferences(profile.preferences);
      });
    return () => {
      active = false;
    };
  }, [context]);

  if (!preferences || !context.isCurrent()) return null;
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
    <section className={styles.card} aria-label="Investing persona">
      <div className={styles.row}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="ui-text-section-label">Investing persona</h2>
            <FinancePersonaBadge preferences={preferences} />
          </div>
          <p className="ui-text-helper-text">
            {detailed
              ? "Detailed profile · Hushh assessment"
              : "Starting profile · Your investing preferences"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!detailed ? (
            <ShellActionSurface
              variant="pill"
              onClick={() => setMode("starter")}
            >
              {hasAnswers ? "Retake questions" : "Build your persona"}
            </ShellActionSurface>
          ) : null}
          <ShellActionSurface
            variant="pill"
            onClick={() => setMode("detailed")}
          >
            {detailed ? "Retake assessment" : "Refine your persona"}
          </ShellActionSurface>
        </div>
      </div>
      <Sheet
        modal
        open={mode !== null}
        onOpenChange={(value) => {
          if (!value && !saving) setMode(null);
        }}
      >
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              {mode === "detailed"
                ? "Refine your persona"
                : "Let’s build your financial persona"}
            </SheetTitle>
            <SheetDescription>
              {mode === "detailed"
                ? "Hushh assessment · 13 questions about risk comfort, cash needs and timing."
                : "Update the preferences One uses in your portfolio review."}
            </SheetDescription>
          </SheetHeader>
          {mode ? (
            <div className="mx-auto w-full max-w-3xl px-4 pb-6">
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
