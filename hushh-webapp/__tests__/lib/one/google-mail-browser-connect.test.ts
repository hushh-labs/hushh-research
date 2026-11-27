// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://uat.one.hussh.ai/one/gmail"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { connectGoogleConnector } from "@/lib/one/google-native-connect";

const { request, prepare } = vi.hoisted(() => ({ request: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { ownerPodRequest: request, apiFetch: prepare } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: "owner" }) } }));

const id = "1234567890-abcdefghijk.apps.googleusercontent.com";
const opts = { platform: "web", vaultOwnerCapability: "fixture" };
const requestCode = vi.fn();
let callback: (response: { code?: string; error?: string }) => void;

beforeEach(() => {
  vi.resetAllMocks();
  publishValidatedAuthSessionPrincipal({ firebaseUid: "owner", ownerId: "owner", accountGeneration: 0 });
  vi.stubGlobal("google", { accounts: { oauth2: { initCodeClient: (options: { callback: typeof callback }) => {
    callback = options.callback;
    return { requestCode };
  } } } });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  request.mockImplementation(async (_route, init) => Response.json(init.method === "GET"
    ? { connectorId: "gmail", browserClientId: id, status: "absent" }
    : { status: "connected" }));
  prepare.mockResolvedValue(Response.json({ status: "ready", transition: { id: "gct_" + "a".repeat(32), nonce: "b".repeat(43) } }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function popup() {
  await vi.waitFor(() => expect(document.querySelector("dialog[open] button")).toBeTruthy());
  document.querySelector<HTMLButtonElement>("dialog button")!.click();
  expect(requestCode).toHaveBeenCalledOnce();
}

it("opens Google from a click and sends the code and mailbox intent only to the owner connector", async () => {
  const pending = connectGoogleConnector("gmail", { ...opts, mailAccount: { mode: "add" } });
  await popup();
  callback({ code: "example-code" });
  expect(await pending).toMatchObject({ ok: true });
  const [route, init] = request.mock.calls[1];
  expect(route).toBe("connectors/gmail");
  expect(JSON.parse(init.body)).toMatchObject({ clientProfile: "hussh_web", clientId: id, code: "example-code",
    redirectUri: "https://uat.one.hussh.ai", codeVerifier: null, mailAccount: { mode: "add" } });
  expect(JSON.stringify(prepare.mock.calls)).not.toContain("example-code");
});

it.each(["cancel", "lock"])("discards the result on %s", async (action) => {
  const pending = connectGoogleConnector("gmail", opts);
  await popup();
  if (action === "lock") advanceVaultSessionEpoch();
  callback(action === "cancel" ? { error: "access_denied" } : { code: "late" });
  expect((await pending).ok).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it("reuses existing access before showing a consent prompt", async () => {
  request.mockResolvedValue(Response.json({ connectorId: "gmail", browserClientId: id,
    status: "connected", capabilities: { read: true, manage: true } }));
  expect(await connectGoogleConnector("gmail", opts)).toMatchObject({ ok: true });
  expect(prepare).not.toHaveBeenCalled();
  expect(requestCode).not.toHaveBeenCalled();
});
