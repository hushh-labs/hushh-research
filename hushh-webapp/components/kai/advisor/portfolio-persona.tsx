"use client";

import { useRef, useState } from "react";
import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { DetailedPersonaForm } from "@/components/kai/onboarding/detailed-persona-form";
import { FinancePersonaBadge } from "@/components/kai/onboarding/finance-persona-form";
import { KaiProfileService, type KaiPreferences } from "@/lib/services/kai-profile-service";
import {
  requireFinanceSession,
  type FinanceShareContext,
} from "@/lib/services/finance-sharing-service";
import styles from "./advisor-review.module.css";

export function PortfolioPersona({
  context,
  preferences,
  onSaved,
}: {
  context: FinanceShareContext;
  preferences: KaiPreferences;
  onSaved: (preferences: KaiPreferences) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <div className={styles.row}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-text-helper-text">Investing persona</span>
        <FinancePersonaBadge preferences={preferences} />
      </div>
      <button ref={trigger} type="button" className={styles.quietAction} onClick={() => setOpen(true)}>
        Refine persona
      </button>
      <AdaptiveDetailSurface
        open={open}
        onOpenChange={(next) => { if (!saving) setOpen(next); }}
        title="Refine your persona"
        description="13 questions about risk, cash needs and timing."
        mobilePresentation="sheet"
        showMobileCloseButton
        desktopMaxWidthClassName="sm:!max-w-[34rem]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        {open ? (
          <DetailedPersonaForm
            initial={preferences}
            onSavingChange={setSaving}
            onDone={() => setOpen(false)}
            onSave={async (answers) => {
              requireFinanceSession(context);
              const profile = await KaiProfileService.savePreferences({
                ...context,
                mode: "edit",
                updates: { detailed_assessment_v1: answers },
                beforeEffect: async () => requireFinanceSession(context),
              });
              requireFinanceSession(context);
              onSaved(profile.preferences);
              return profile.preferences;
            }}
          />
        ) : null}
      </AdaptiveDetailSurface>
    </div>
  );
}
