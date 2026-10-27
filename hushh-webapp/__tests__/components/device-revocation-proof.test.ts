import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), cancelOperation: vi.fn(), status: vi.fn(), send: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), recaptcha: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/lib/services/phone-recovery-service", () => ({ PhoneRecoveryService: { prepareRevocation: mocks.prepare, revocationStatus: mocks.status, cancelRevocation: mocks.cancelOperation } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: {
  startPhoneDeletionVerification: mocks.send, confirmPhoneDeletionVerification: mocks.confirm,
  cancelPhoneDeletionVerification: mocks.cancel,
} }));
vi.mock("@/lib/firebase/config", () => ({ prepareRecaptchaVerifier: mocks.recaptcha, resetRecaptcha: vi.fn() }));
import { DeviceRevocationProofSession } from "@/components/profile/device-revocation-proof";
import type { User } from "firebase/auth";
const user = { uid: "synthetic-owner" } as User;
const operation = "27b517dc-d694-44e3-a9be-ed8ae0484de2";
const prepared = (transport = "sms") => ({ operation_id: operation, expires_at: "2099-01-01T00:00:00Z", phone_hint: "••00", proof_wait_ms: 0, transport });
beforeEach(() => {
  mocks.cancelOperation.mockResolvedValue({operation_id: operation, state: "not_started"});
  mocks.status.mockResolvedValue({operation_id: operation, state: "not_started"});
  mocks.prepare.mockResolvedValue(prepared()); mocks.send.mockResolvedValue({ verificationId: "challenge" });
  mocks.confirm.mockResolvedValue("isolated-proof"); mocks.cancel.mockResolvedValue(undefined); mocks.recaptcha.mockResolvedValue({});
});
afterEach(() => vi.resetAllMocks());
it("prepares each device before new SMS and requires full code before producing an explicit operation proof", async () => {
  const session = new DeviceRevocationProofSession(user, "device-one", () => true, async () => "+16505550100", vi.fn());
  await session.send();
  expect(mocks.send).not.toHaveBeenCalled();
  await session.prepare();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(await session.proof("12345")).toBeNull();
  await session.send();
  expect(mocks.prepare).toHaveBeenCalledWith(user, "device-one", expect.any(Function), undefined);
  expect(mocks.send).toHaveBeenCalledWith("+16505550100", expect.anything(), expect.objectContaining({ expectedUserId: user.uid, signal: expect.any(AbortSignal) }));
  expect(await session.proof("123456")).toEqual({ operation_id: operation, confirmed: true, phone_id_token: "isolated-proof" });
  session.dispose();
});
it("uses only the configured own-account challenge when the server selected it", async () => {
  mocks.prepare.mockResolvedValue(prepared("configured_test"));
  const session = new DeviceRevocationProofSession(user, "device-one", () => true, vi.fn(), vi.fn(), operation);
  await session.prepare(); await session.send();
  expect(mocks.send).not.toHaveBeenCalled();
  expect(await session.proof("654321")).toEqual({ operation_id: operation, confirmed: true, test_code: "654321" });
  expect(mocks.confirm).not.toHaveBeenCalled();
  session.dispose();
});
it.each(["cancel", "owner-change"])("discards a late SMS result after %s and cannot reuse its proof for another device", async boundary => {
  let current = true;
  let finish!: (result: { verificationId: string }) => void;
  mocks.send.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const publish = vi.fn();
  const first = new DeviceRevocationProofSession(user, "device-one", () => current, async () => "+16505550100", publish);
  await first.prepare(); const pending = first.send();
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  const signal = mocks.send.mock.calls[0][2].signal as AbortSignal;
  if (boundary === "cancel") first.dispose(); else current = false;
  const count = publish.mock.calls.length;
  finish({ verificationId: "late-challenge" }); await pending;
  expect(publish).toHaveBeenCalledTimes(count);
  expect(await first.proof("123456")).toBeNull();
  first.dispose(); expect(signal.aborted).toBe(true);
  const second = new DeviceRevocationProofSession(user, "device-two", () => true, vi.fn(), vi.fn());
  await second.prepare();
  expect(await second.proof("123456")).toBeNull();
  expect(mocks.confirm).not.toHaveBeenCalled(); second.dispose();
});

it("cancels the bounded server freshness wait before any provider request", async () => {
  mocks.prepare.mockResolvedValue({...prepared(), proof_wait_ms: 1000});
  const session = new DeviceRevocationProofSession(user, "device-one", () => true, vi.fn(), vi.fn());
  await session.prepare(); const pending = session.send();
  await session.cancel(); await pending;
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.cancelOperation).toHaveBeenCalledWith(user, operation, expect.any(Function));
});
it("never cancels another same-owner verification when a second device is reviewed", async () => {
  const other = "805990b2-20a4-4f22-a554-ec1cd9ea3629";
  mocks.prepare.mockResolvedValueOnce(prepared()).mockResolvedValueOnce({...prepared(), operation_id: other});
  const first = new DeviceRevocationProofSession(user, "device-one", () => true, async () => "+16505550100", vi.fn());
  const second = new DeviceRevocationProofSession(user, "device-two", () => true, vi.fn(), vi.fn());
  await first.prepare(); await first.send(); await second.prepare();
  expect(mocks.cancelOperation).not.toHaveBeenCalled();
  await second.cancel();
  expect(mocks.cancelOperation).toHaveBeenCalledWith(user, other, expect.any(Function));
  expect(await first.proof("123456")).toEqual({operation_id: operation, confirmed: true, phone_id_token: "isolated-proof"});
  expect(mocks.cancelOperation).toHaveBeenCalledOnce(); first.dispose();
});
