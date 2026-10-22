/** Answer-owned payout mode and accounts; hosted returns grant no authority. */
import { ApiService } from "./api-service";
import { parseCommerceHostedSession, type CommerceHostedSession } from "./scope-commerce-return";
import { validateCommerceHostedUrl } from "./scope-commerce-browser";

export type AnswerPayoutAccountStatus = {
  stripeMode: "test" | "live";
  account: { ready: boolean; canManageBank: boolean } | null;
};

async function read(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("Could not verify answer payout setup. Please retry.");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payout response");
  return value as Record<string, unknown>;
}

async function link(token: string, action: "onboarding" | "dashboard", attemptId?: string) {
  if (!token) throw new Error("Sign in to manage payouts.");
  return read(await ApiService.apiFetch(`/api/one/answer-requests/payout-account/${action}`, {
    method: "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(attemptId ? { "Content-Type": "application/json" } : {}) },
    ...(attemptId ? { body: JSON.stringify({ attempt_id: attemptId }) } : {}),
  }));
}

export class AnswerPayoutService {
  static async account(token: string): Promise<AnswerPayoutAccountStatus> {
    if (!token) throw new Error("Sign in to manage payouts.");
    const value = await read(await ApiService.apiFetch("/api/one/answer-requests/payout-account", {
      cache: "no-store", headers: { Authorization: `Bearer ${token}` },
    }));
    if (value.stripeMode !== "test" && value.stripeMode !== "live") throw new Error("Invalid payout mode");
    if (value.account === null) return { stripeMode: value.stripeMode, account: null };
    if (!value.account || typeof value.account !== "object" || Array.isArray(value.account)) throw new Error("Invalid payout response");
    const account = value.account as Record<string, unknown>;
    if (typeof account.ready !== "boolean" || (account.canManageBank !== undefined && typeof account.canManageBank !== "boolean")) throw new Error("Invalid payout response");
    return { stripeMode: value.stripeMode, account: { ready: account.ready, canManageBank: account.canManageBank === true } };
  }

  static async link(token: string, action: "onboarding" | "dashboard"): Promise<string> {
    const value = await link(token, action);
    return validateCommerceHostedUrl(String(value.url || ""), action === "dashboard" ? "management" : "onboarding");
  }

  static async onboarding(token: string, attemptId: string): Promise<CommerceHostedSession> {
    const value = await link(token, "onboarding", attemptId);
    if (value.attempt_id !== attemptId) throw new Error("Invalid payout return binding");
    const session = parseCommerceHostedSession(value, attemptId, "answers");
    validateCommerceHostedUrl(session.url, "onboarding");
    return session;
  }
}
