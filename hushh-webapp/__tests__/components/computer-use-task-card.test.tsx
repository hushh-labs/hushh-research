import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseTaskCard } from "@/components/computer-use/computer-use-task-card";
import { type ComputerUseBinding, type ComputerUseSnapshot, type ComputerUseTransport } from "@/lib/computer-use/contracts";
import { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { parseComputerUseSnapshot } from "@/lib/computer-use/direct-transport";
import { createComputerUseCanvas } from "@/lib/computer-use/preview-canvas";
import { ComputerUseClient } from "@/lib/services/computer-use-client";
import { ComputerUseOwnerBridge } from "@/components/computer-use/computer-use-owner-bridge";

const api = vi.hoisted(() => ({ getComputerUseAdmission: vi.fn(), ownerPodRequest: vi.fn(), owner: "owner" }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: api }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getCurrentUser: () => ({ uid: api.owner }) } }));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: (promise: Promise<unknown>) => promise, error: vi.fn(), info: vi.fn() },
}));

const binding: ComputerUseBinding = {
  ownerId: "owner", podId: "pod", incarnation: "incarnation", taskId: "task", environment: "development",
};
const snapshot = (patch: Partial<ComputerUseSnapshot> = {}): ComputerUseSnapshot => ({
  binding, phase: "running", capability: "ready", controlOwner: "agent",
  controlEpoch: 1, nextSequence: 1, revision: 1, ...patch,
});
function transport(): ComputerUseTransport {
  return {
    read: vi.fn().mockResolvedValue(snapshot()),
    control: vi.fn().mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2, revision: 2 })),
    input: vi.fn().mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2, nextSequence: 2, revision: 3 })),
    review: vi.fn().mockResolvedValue(snapshot()),
    session: vi.fn().mockResolvedValue({ state: "remembered" }),
    watchFrames: vi.fn((_binding, signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    })),
  };
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeEach(() => {
  api.owner = "owner";
  api.getComputerUseAdmission.mockReset().mockResolvedValue(null);
  api.ownerPodRequest.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private browser control", () => {
  it("requires the takeover acknowledgement and refuses changed-owner responses", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    await controller.refresh();
    let acknowledge!: (state: ComputerUseSnapshot) => void;
    vi.mocked(api.control).mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const takeover = controller.control("takeover");
    await expect(controller.input({ operation: "click", x: 1, y: 1 })).rejects.toThrow("BROWSER_OWNER_CONTROL_REQUIRED");
    expect(api.input).not.toHaveBeenCalled();
    acknowledge(snapshot({ binding: { ...binding, ownerId: "another" }, controlOwner: "owner", controlEpoch: 2, revision: 2 }));
    await expect(takeover).rejects.toThrow("BROWSER_TASK_UNAVAILABLE");
    expect(controller.getSnapshot().verified).toBe(false);
    controller.dispose();
  });

  it("admits owner input only for the current epoch and refuses status rollback", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    await controller.refresh();
    await controller.control("takeover");
    await controller.input({ operation: "click", x: 10, y: 20 });
    expect(api.input).toHaveBeenCalledWith(binding, {
      operation: "click", x: 10, y: 20, sequence: 1, control_epoch: 2,
    }, expect.any(AbortSignal));
    vi.mocked(api.read).mockResolvedValue(snapshot());
    await expect(controller.refresh()).rejects.toThrow("BROWSER_TASK_UNAVAILABLE");
    expect(controller.acceptsFrame({ binding, controlEpoch: 2, sequence: 1, width: 1280, height: 720, png })).toBe(false);
    controller.dispose();
  });

  it("bounds a lost response and requires a fresh status before more input", async () => {
    vi.useFakeTimers();
    try {
      const api = transport();
      const controller = new ComputerUseTaskController(binding, api);
      await controller.refresh();
      vi.mocked(api.control).mockImplementation(() => new Promise(() => undefined));
      const result = expect(controller.control("takeover")).rejects.toThrow("BROWSER_TASK_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(45_000);
      await result;
      expect(controller.getSnapshot()).toMatchObject({ pending: false, verified: false });
      await expect(controller.control("resume")).rejects.toThrow("BROWSER_CONTROL_REFUSED");
      controller.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("confirms only the review that the owner saw and can stop before browser allocation", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    const review = { id: "review-one", purpose: "model_process" as const, model: "Gemini", origins: ["https://example.com"], details: [] };
    vi.mocked(api.read).mockResolvedValue(snapshot({ phase: "needs_owner", review }));
    await controller.refresh();
    vi.mocked(api.read).mockResolvedValue(snapshot({ phase: "needs_owner", revision: 2, review: { ...review, id: "review-two" } }));
    await controller.refresh();
    await expect(controller.review("review-one")).rejects.toThrow("BROWSER_REVIEW_REFUSED");
    expect(api.review).not.toHaveBeenCalled();
    vi.mocked(api.review).mockResolvedValue(snapshot({ revision: 3 }));
    await controller.review("review-two");
    expect(api.review).toHaveBeenCalledWith(binding, "review-two", expect.any(AbortSignal));
    vi.mocked(api.control).mockResolvedValue(snapshot({ phase: "cancelled", controlOwner: "stopped", revision: 4 }));
    await controller.control("cancel");
    expect(controller.getSnapshot().snapshot?.phase).toBe("cancelled");
    controller.dispose();
  });

  it("keeps remembered-session review separate from applying state and rejects an unapproved site", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    const owner = snapshot({ controlOwner: "owner", controlEpoch: 2, rememberedSessionsAvailable: true,
      approvedOrigins: ["https://example.com"] });
    vi.mocked(api.read).mockResolvedValue(owner);
    await controller.refresh();
    await expect(controller.session("remember", "https://other.example", "Synthetic")).rejects.toThrow("BROWSER_SESSION_REFUSED");
    expect(api.session).not.toHaveBeenCalled();
    const review = { id: "session-review", purpose: "session_remember" as const, origins: ["https://example.com"], details: [] };
    vi.mocked(api.session).mockResolvedValue({ state: "review_required" });
    vi.mocked(api.read).mockResolvedValue({ ...owner, revision: 2, review });
    await expect(controller.session("remember", "https://example.com", "Synthetic")).resolves.toEqual({ state: "review_required" });
    expect(api.session).toHaveBeenCalledOnce();
    vi.mocked(api.review).mockResolvedValue({ ...owner, revision: 3 });
    await controller.review("session-review");
    expect(api.session).toHaveBeenCalledOnce();
    vi.mocked(api.session).mockResolvedValue({ state: "remembered" });
    vi.mocked(api.read).mockResolvedValue({ ...owner, revision: 4 });
    await expect(controller.session("remember", "https://example.com", "Synthetic")).resolves.toEqual({ state: "remembered" });
    expect(api.session).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("serializes manual input without dropping typing or replaying an old sequence", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    await controller.refresh();
    await controller.control("takeover");
    let finish!: (value: ComputerUseSnapshot) => void;
    vi.mocked(api.input).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.input).mockResolvedValueOnce(snapshot({ controlOwner: "owner", controlEpoch: 2, nextSequence: 3, revision: 4 }));
    const first = controller.input({ operation: "type", x: 2, y: 3, text: "a", clear_before_typing: false });
    const second = controller.input({ operation: "type", x: 2, y: 3, text: "b", clear_before_typing: false });
    expect(api.input).toHaveBeenCalledOnce();
    finish(snapshot({ controlOwner: "owner", controlEpoch: 2, nextSequence: 2, revision: 3 }));
    await Promise.all([first, second]);
    expect(api.input).toHaveBeenNthCalledWith(2, binding, {
      operation: "type", x: 2, y: 3, text: "b", clear_before_typing: false, sequence: 2, control_epoch: 2,
    }, expect.any(AbortSignal));
    controller.dispose();
  });

  it("cancellation preempts slow input and clears queued private text", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    await controller.refresh();
    await controller.control("takeover");
    vi.mocked(api.input).mockImplementation((_binding, _action, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const first = expect(controller.input({ operation: "type", x: 2, y: 3, text: "synthetic", clear_before_typing: false })).rejects.toThrow();
    const second = expect(controller.input({ operation: "type", x: 2, y: 3, text: "queued", clear_before_typing: false })).rejects.toThrow();
    vi.mocked(api.control).mockResolvedValue(snapshot({ phase: "cancelled", controlOwner: "stopped", controlEpoch: 3, revision: 4 }));
    await controller.control("cancel");
    await Promise.all([first, second]);
    expect(api.input).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().snapshot?.phase).toBe("cancelled");
    controller.dispose();
  });

  it("refuses mismatched frames and clears a late decode after the preview closes", async () => {
    const controller = new ComputerUseTaskController(binding, transport());
    await controller.refresh();
    const frame = { binding, controlEpoch: 1, sequence: 0, width: 1280, height: 720, png };
    expect(controller.acceptsFrame(frame)).toBe(true);
    expect(controller.acceptsFrame({ ...frame, binding: { ...binding, incarnation: "replaced" } })).toBe(false);
    expect(controller.acceptsFrame({ ...frame, controlEpoch: 2 })).toBe(false);
    expect(controller.acceptsFrame({ ...frame, png: new Uint8Array(8) })).toBe(false);
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    let finish!: (image: ImageBitmap) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const renderer = createComputerUseCanvas(canvas, (candidate) => controller.acceptsFrame(candidate));
    const paint = renderer.paint(frame);
    renderer.close();
    const image = { width: 1280, height: 720, close: vi.fn() };
    finish(image as unknown as ImageBitmap);
    await paint;
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.clearRect).toHaveBeenCalled();
    expect(image.close).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("leaves an unqualified browser unavailable and never requests private frames", async () => {
    const api = transport();
    vi.mocked(api.read).mockResolvedValue(snapshot({ phase: "unavailable", capability: "unavailable", controlOwner: "stopped" }));
    render(<ComputerUseTaskCard binding={binding} transport={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "View browser" })).toBeDisabled());
    expect(screen.getByText("Browser unavailable on this private agent.")).toBeInTheDocument();
    expect(api.watchFrames).not.toHaveBeenCalled();
  });

  it("closing the preview stops observation without silently handing control back", async () => {
    const api = transport();
    const context = { clearRect: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    render(<ComputerUseTaskCard binding={binding} transport={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "View browser" }));
    await waitFor(() => expect(api.watchFrames).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await screen.findByRole("button", { name: "Resume agent" });
    const signal = vi.mocked(api.watchFrames).mock.calls.at(-1)?.[1];
    act(() => fireEvent.click(screen.getByRole("button", { name: "Close browser preview" })));
    expect(signal?.aborted).toBe(true);
    expect(api.control).toHaveBeenCalledOnce();
    expect(api.control).toHaveBeenCalledWith(binding, "takeover", 1, expect.any(AbortSignal));
  });

  it("rejects malformed wire authority instead of displaying a ready browser", () => {
    const wire = {
      binding: { owner_id: "owner", pod_id: "pod", incarnation: "incarnation", task_id: "task", environment: "development" },
      phase: "running", capability: { available: true }, control_owner: "agent", control_epoch: 1, next_sequence: 1, revision: 1,
    };
    expect(parseComputerUseSnapshot(wire, binding)).toEqual(snapshot());
    expect(() => parseComputerUseSnapshot({ ...wire, capability: { available: "true" } }, binding)).toThrow();
    expect(() => parseComputerUseSnapshot({ ...wire, binding: { ...wire.binding, pod_id: "other" } }, binding)).toThrow();
  });

  it("renders only exact selected scalar details and never exposes stored sign-in values", () => {
    const wire = {
      binding: { owner_id: "owner", pod_id: "pod", incarnation: "incarnation", task_id: "task", environment: "development" },
      phase: "needs_owner", capability: { available: true }, control_owner: "agent", control_epoch: 1, next_sequence: 1, revision: 1,
      review: { review_id: "review", purpose: "model_process", terms: {
        model: "Gemini", task_goal: "Prepare a synthetic form", origins: ["https://example.com"], fields: [{ domain: "profile", path: "name" }],
        values: { "attr.profile.name": { profile: { name: "Synthetic Owner", unrelated: "not selected" } } },
      } },
    };
    expect(parseComputerUseSnapshot(wire, binding).review?.details).toEqual([{ label: "profile · name", value: "Synthetic Owner" }]);
    expect(() => parseComputerUseSnapshot({ ...wire, review: { ...wire.review,
      terms: { ...wire.review.terms, values: { "attr.profile.name": { profile: { name: { nested: "not scalar" } } } } } } }, binding)).toThrow();
    const remembered = parseComputerUseSnapshot({ ...wire, review: { review_id: "session", purpose: "session_remember",
      terms: { origins: ["https://example.com"], state: { cookies: [{ value: "must not reach the view" }] } } } }, binding);
    expect(remembered.review).toEqual({ id: "session", purpose: "session_remember", origins: ["https://example.com"], details: [] });
  });

  it("never wakes a pod or starts a task merely by mounting One", async () => {
    render(<ComputerUseOwnerBridge ownerId="owner" />);
    expect(api.getComputerUseAdmission).not.toHaveBeenCalled();
    expect(api.ownerPodRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(await screen.findByText("Browser isn’t available on this private agent yet.")).toBeInTheDocument();
    expect(api.getComputerUseAdmission).toHaveBeenCalledOnce();
    expect(api.ownerPodRequest).not.toHaveBeenCalled();
  });

  it("requires a real dev capability and keeps a changed owner off the admitted pod", async () => {
    const client = new ComputerUseClient("owner");
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod", environment: "dev" });
    api.ownerPodRequest.mockResolvedValue(new Response(JSON.stringify({ available: "true" }), { status: 200 }));
    expect(await client.capability(new AbortController().signal)).toMatchObject({ available: false });
    await expect(client.start({ requestId: "synthetic", goal: "Public research", allowedOrigins: ["https://example.com"] }, new AbortController().signal)).rejects.toThrow("BROWSER_CLOUD_GATE_UNAVAILABLE");
    api.owner = "other";
    await expect(client.capability(new AbortController().signal)).rejects.toThrow("BROWSER_OWNER_UNAVAILABLE");
    expect(api.ownerPodRequest).toHaveBeenCalledOnce();
  });
});
