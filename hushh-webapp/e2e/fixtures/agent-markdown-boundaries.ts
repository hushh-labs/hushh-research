/**
 * The one Next.js boundary the chat answer renderer reaches: in-app links
 * route through `useRouter().push`. The fixture records the push instead of
 * navigating, so a spec can prove a same-origin link stayed in the app.
 */
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const user = { uid: "fixture-puppy-owner" };
publishValidatedAuthSessionOwner(user.uid);
export function useAuth() { return { user }; }
export const AuthService = { getCurrentUser: () => user };
export const ApiService = {
  getPersonalAgentStatus: async () => ({
    hostingMode: "byoc", hushhId: "fixture-puppy-pod", deploymentTarget: "user_gcp",
  }),
};

export function useRouter() {
  return {
    push(href: string) {
      document.body.dataset.routerPush = href;
    },
  };
}

export function AgentStructuredExperienceView() {
  throw new Error("Structured experiences are outside the chat typography/activity fixture.");
}

// Synthetic device/transport boundaries; the Puppy surface and transcript are real.
export function usePathname() { return "/"; }
export function useSearchParams() { return new URLSearchParams(); }
export function usePuppyLink() {
  return { state: document.body.dataset.puppyConnected === "true" ? "live" : "unlinked", device: null, activeCount: 0, checkedAt: 0 };
}
export async function fetchPuppyStatus() {
  return { connected: document.body.dataset.puppyConnected === "true", reason: "not_configured" };
}
export const PUPPY_ONE_INSTALL_URL = "https://github.com/hushh-labs/hussh-one-hermes";
export function PuppyModelPicker() { return null; }
export function PuppyMachineSheet() { return null; }
export function PrivatePuppyInferencePanel() {
  throw new Error("Remote pod inference is outside the localhost chat typography fixture.");
}
export const PUPPY_TYPOGRAPHY_ANSWER = "Your local answer.\n\nA second paragraph with **emphasis**.\n\n- First item\n- Second item";
export class HttpAgent {
  abortRun() {}
  async runAgent(_params: unknown, handlers: { onTextMessageContentEvent: (value: { event: { delta: string } }) => void }) {
    handlers.onTextMessageContentEvent({ event: { delta: PUPPY_TYPOGRAPHY_ANSWER } });
  }
}
