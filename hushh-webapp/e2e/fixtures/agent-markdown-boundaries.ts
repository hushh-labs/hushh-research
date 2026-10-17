/**
 * The one Next.js boundary the chat answer renderer reaches: in-app links
 * route through `useRouter().push`. The fixture records the push instead of
 * navigating, so a spec can prove a same-origin link stayed in the app.
 */
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
function puppyLink() {
  return { state: document.body.dataset.puppyConnected === "true" ? "live" : "unlinked", device: null, activeCount: 0, checkedAt: 0 };
}
export const usePuppyLink = puppyLink;
export async function refreshPuppyLink() { return puppyLink(); }
// This fixture exercises the local bridge; selecting remote custody must fail.
export function useAuth(): never { throw new Error("Remote owner authentication is outside the local typography fixture."); }
export function useVault(): never { throw new Error("Remote vault access is outside the local typography fixture."); }
export { PUPPY_TURN_DEADLINE_MS, PUPPY_INFERENCE_DEADLINE_MS } from "../../lib/services/puppy-pod-stream";
export const ApiService = new Proxy({}, {
  get(): never { throw new Error("Remote API access is outside the local typography fixture."); },
});
export async function fetchPuppyStatus() {
  return { connected: document.body.dataset.puppyConnected === "true", reason: "not_configured" };
}
export const PUPPY_ONE_INSTALL_URL = "https://github.com/hushh-labs/hussh-one-hermes";
export function PuppyModelPicker() { return null; }
export function PuppyMachineSheet() { return null; }
export const PUPPY_TYPOGRAPHY_ANSWER = "Your local answer.\n\nA second paragraph with **emphasis**.\n\n- First item\n- Second item";
export class HttpAgent {
  abortRun() {}
  async runAgent(_params: unknown, handlers: { onTextMessageContentEvent: (value: { event: { delta: string } }) => void }) {
    handlers.onTextMessageContentEvent({ event: { delta: PUPPY_TYPOGRAPHY_ANSWER } });
  }
}
