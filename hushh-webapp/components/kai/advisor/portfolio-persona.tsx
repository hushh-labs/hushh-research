"use client";

import { useEffect, useState } from "react";
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
} from "@/lib/services/kai-profile-service";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import styles from "./advisor-review.module.css";

export function PortfolioPersona({
  context,
}: {
  context: FinanceShareContext;
}) {
  const [preferences, setPreferences] = useState<KaiPreferences | null>(null);
  const [open, setOpen] = useState(false);
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
  return (
    <section className={styles.card} aria-label="Investing persona">
      <div className={styles.row}>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="ui-text-section-label">Investing persona</h2>
            <FinancePersonaBadge preferences={preferences} />
          </div>
          <p className="ui-text-helper-text">
            Starting profile · Your investing preferences
          </p>
        </div>
        <ShellActionSurface variant="pill" onClick={() => setOpen(true)}>
          {hasAnswers ? "Retake questions" : "Build your persona"}
        </ShellActionSurface>
      </div>
      <Sheet
        modal
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>Let’s build your financial persona</SheetTitle>
            <SheetDescription>
              Update the preferences One uses in your portfolio review.
            </SheetDescription>
          </SheetHeader>
          {open ? (
            <div className="px-4 pb-6">
              <FinancePersonaForm
                initial={hasAnswers ? preferences : undefined}
                onSavingChange={setSaving}
                onDone={() => setOpen(false)}
                onSave={async (updates) => {
                  requireFinanceSession(context);
                  const profile = await KaiProfileService.savePreferences({
                    ...context,
                    mode: "edit",
                    updates,
                    beforeEffect: async () => requireFinanceSession(context),
                  });
                  requireFinanceSession(context);
                  setPreferences(profile.preferences);
                }}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
