import type { NativeDrawerRow, NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { ProfileFinancePreferencesModel } from "./use-profile-finance-preferences";

/** Complete finite wizard presentation; choice validation, anchor semantics and
 * persistence remain with the same controller used by the web wizard. */
export function projectNativeFinancePreferences(model: ProfileFinancePreferencesModel) {
  const wizard = model.wizard;
  const rows = new Map<string, () => void | Promise<void>>();
  const ready = model.available && !!model.profile && !model.loading;
  const content: NativeDrawerRow[] = [];
  if (!ready) {
    content.push({ id: "finance-status", label: model.loading ? "Loading preferences…" : "Preferences unavailable", enabled: true, readOnly: true });
    if (!model.loading) { content.push({ id: "finance-retry", label: "Try again", enabled: model.available }); rows.set("finance-retry", model.retry); }
  } else {
    content.push({ id: "finance-step", label: `Step ${wizard.step + 1} of ${wizard.total}`, enabled: true, readOnly: true });
    content.push({ id: "finance-question", label: wizard.activeQuestion.prompt, enabled: !wizard.isSubmitting,
      options: wizard.activeQuestion.options.map(option => ({ id: `finance-choice-${option.value}`, label: option.label, selected: wizard.activeValue === option.value })) });
    for (const option of wizard.activeQuestion.options) rows.set(`finance-choice-${option.value}`, () => { wizard.handleSelect(option.value); });
    content.push({ id: "finance-continue", label: wizard.isSubmitting ? "Saving…" : wizard.primaryLabel,
      enabled: wizard.canContinue && !wizard.isSubmitting, pending: wizard.isSubmitting });
    rows.set("finance-continue", wizard.handlePrimary);
  }
  if (model.error || model.notice) content.push({ id: "finance-outcome", label: model.error ?? model.notice!, enabled: true, readOnly: true });
  const pages: NativeProfilePage[] = [{ id: "finance-preferences", title: "Finance preferences", sections: [{ id: "finance-preferences-fields", rows: content }] }];
  if (ready && wizard.horizonDialogOpen) {
    pages.push({ id: "finance-anchor", title: "Update horizon anchor?", sections: [{ id: "finance-anchor-fields", rows: [
      { id: "finance-anchor-explanation", label: "Should this change apply starting now, or keep the original start date for reports?", enabled: true, readOnly: true },
      { id: "finance-anchor-choice", label: "Start date", enabled: !wizard.isSubmitting, options: [
        { id: "finance-anchor-now", label: "Apply from now", selected: wizard.horizonAnchorChoice === "from_now" },
        { id: "finance-anchor-original", label: "Keep original start date", selected: wizard.horizonAnchorChoice === "keep_original" },
      ] },
      { id: "finance-anchor-apply", label: "Apply", enabled: !wizard.isSubmitting },
      { id: "finance-anchor-cancel", label: "Cancel", enabled: !wizard.isSubmitting },
    ] }] });
    rows.set("finance-anchor-now", () => wizard.setHorizonAnchorChoice("from_now"));
    rows.set("finance-anchor-original", () => wizard.setHorizonAnchorChoice("keep_original"));
    rows.set("finance-anchor-apply", wizard.applyHorizon);
    rows.set("finance-anchor-cancel", wizard.cancelHorizon);
  }
  return { pages, rows, back: wizard.handleBack, busy: wizard.isSubmitting };
}
