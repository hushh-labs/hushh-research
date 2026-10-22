/**
 * Whether an Azure setup record says the subscription is a free trial.
 *
 * The hub reads the subscription's own policies during Connect Azure and adds
 * one `subscription_offer` entry to the setup record's `stages`
 * (`azure_subscription_offer.py`). It carries facts only (`quotaId`,
 * `spendingLimit`, `freeTrial`); the sentence a person reads lives here.
 * Microsoft disables a free trial after 30 days unless it is upgraded, and the
 * agent in it stops with it.
 */

export const SUBSCRIPTION_OFFER_STAGE = "subscription_offer";

export const AZURE_FREE_TRIAL_NOTICE =
  "This is a free trial subscription. Microsoft stops it after 30 days unless you upgrade, and your agent stops with it.";

/** The free-trial line for a setup record, or null when it names no free trial. */
export function azureFreeTrialNotice(
  stages: ReadonlyArray<{ stage: string }> | null | undefined,
): string | null {
  const offer = (stages ?? []).find((entry) => entry.stage === SUBSCRIPTION_OFFER_STAGE) as
    | { freeTrial?: unknown }
    | undefined;
  return offer?.freeTrial === true ? AZURE_FREE_TRIAL_NOTICE : null;
}
