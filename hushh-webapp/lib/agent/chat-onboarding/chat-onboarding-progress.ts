/**
 * Where chat-onboarding progress lives, and the tip-of-the-day rule.
 *
 * Progress is the per-person setup record (`vault_keys.one_chat_onboarding`,
 * read and written through `PreVaultUserStateService`), the same durable,
 * cross-device store that already holds setup completion, the nav tour and
 * declined capabilities. It is not PKM: memory holds what is true about a
 * person, not what a flow has finished (`contracts/pkm/internal-path-keys`).
 * It is not browser storage: it must survive reloads and other devices. It
 * carries question ids and dates only, never an answer value.
 */
import type { OneChatOnboardingState } from "@/lib/services/pre-vault-user-state-service";
import {
  CHAT_ONBOARDING_QUESTIONS,
  type ChatOnboardingQuestionStatus,
} from "@/lib/agent/chat-onboarding/chat-onboarding-script";
import type { ChatOnboardingProgress } from "@/lib/agent/chat-onboarding/chat-onboarding-machine";
import { ALL_WELCOME_PROMPTS } from "@/lib/agent/agent-welcome-prompts";

export function progressToWire(progress: ChatOnboardingProgress): OneChatOnboardingState {
  return {
    version: 1,
    status: progress.status,
    answered: CHAT_ONBOARDING_QUESTIONS.filter((id) => progress.questions[id] === "answered"),
    skipped: CHAT_ONBOARDING_QUESTIONS.filter((id) => progress.questions[id] === "skipped"),
    completedOn: progress.completedOn,
    tipDismissedOn: progress.tipDismissedOn,
  };
}

export function progressFromWire(state: OneChatOnboardingState): ChatOnboardingProgress {
  const statusOf = (id: (typeof CHAT_ONBOARDING_QUESTIONS)[number]): ChatOnboardingQuestionStatus =>
    state.answered.includes(id) ? "answered" : state.skipped.includes(id) ? "skipped" : "pending";
  return {
    version: 1,
    status: state.status,
    questions: { name: statusOf("name"), focus: statusOf("focus"), tone: statusOf("tone") },
    completedOn: state.completedOn,
    tipDismissedOn: state.tipDismissedOn,
  };
}

/** The person's local calendar date, so "a tip a day" follows their day. */
export function localCalendarDate(now: Date = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Tips run for the first few days after onboarding finishes, one per day. */
export const CHAT_ONBOARDING_TIP_DAYS = 3;

/**
 * Tips reuse the curated starters only: each is backed by a One chat tool that
 * works end to end (see `agent-welcome-prompts.ts`), so a tip can never point
 * at a capability that does not exist.
 */
export function pickDailyTip(
  progress: OneChatOnboardingState | null,
  today: string,
  exclude: readonly string[] = [],
): string | null {
  if (!progress || progress.status !== "completed" || !progress.completedOn) return null;
  if (progress.tipDismissedOn === today) return null;
  const day = daysBetween(progress.completedOn, today);
  if (day === null || day < 1 || day > CHAT_ONBOARDING_TIP_DAYS) return null;
  const candidates = ALL_WELCOME_PROMPTS.filter((prompt) => !exclude.includes(prompt));
  const pool = candidates.length ? candidates : ALL_WELCOME_PROMPTS;
  return pool[(day - 1) % pool.length] ?? null;
}
