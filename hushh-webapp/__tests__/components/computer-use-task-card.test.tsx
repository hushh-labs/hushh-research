import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseTaskCard } from "@/components/computer-use/computer-use-task-card";
import { type ComputerUseBinding, type ComputerUseSnapshot, type ComputerUseTransport } from "@/lib/computer-use/contracts";
import { ComputerUseTaskController } from "@/lib/computer-use/task-controller";
import { createDirectComputerUseTransport, parseComputerUseSnapshot } from "@/lib/computer-use/direct-transport";
import { computerUsePoint, createComputerUseCanvas, fitComputerUseViewport } from "@/lib/computer-use/preview-canvas";
import { ComputerUsePreview } from "@/components/computer-use/computer-use-preview";
import { ComputerUseClient } from "@/lib/services/computer-use-client";
import { ComputerUseOwnerBridge } from "@/components/computer-use/computer-use-owner-bridge";
import { ComputerUseActiveTasks } from "@/components/computer-use/computer-use-active-tasks";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { PodScheduledTasksClient } from "@/lib/services/pod-scheduled-tasks";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const api = vi.hoisted(() => ({ getComputerUseAdmission: vi.fn(), ownerPodRequest: vi.fn(), apiFetch: vi.fn(), owner: "owner" }));
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

it("keeps an accepted input's exact review reachable without repeating the input", async () => {
  const api = transport();
  const controller = new ComputerUseTaskController(binding, api);
  const owner = snapshot({ controlOwner: "owner", controlEpoch: 2 });
  const review = { id: "disclosure", purpose: "disclose" as const, origins: [], destination: "https://example.com/sign-in", details: [] };
  vi.mocked(api.read).mockResolvedValue(owner);
  await controller.refresh();
  vi.mocked(api.input).mockResolvedValue({ ...owner, inputPending: true, revision: 2 });
  vi.mocked(api.read).mockResolvedValue({ ...owner, inputPending: true, revision: 3, review });
  const input = controller.input({ operation: "type", x: 1, y: 1, text: "synthetic-private-input", clear_before_typing: false });
  const queued = controller.input({ operation: "click", x: 30, y: 40, button: "left" });
  const rejected = expect(queued).rejects.toThrow("BROWSER_REVIEW_PENDING");
  await waitFor(() => expect(controller.getSnapshot().snapshot?.review?.id).toBe("disclosure"));
  await rejected;
  await expect(controller.input({ operation: "click", x: 30, y: 40, button: "left" })).rejects.toThrow("BROWSER_OWNER_CONTROL_REQUIRED");
  expect(controller.getSnapshot().pending).toBe(false);
  vi.mocked(api.review).mockResolvedValue({ ...owner, inputPending: true, revision: 4 });
  await controller.review("disclosure");
  vi.mocked(api.read).mockResolvedValue({ ...owner, inputPending: false, nextSequence: 2, revision: 5 });
  await input;
  expect(api.input).toHaveBeenCalledOnce();
  expect(api.review).toHaveBeenCalledWith(binding, "disclosure", expect.any(AbortSignal));
  expect(controller.getSnapshot().snapshot?.nextSequence).toBe(2);
  controller.dispose();
});

it("reconciles Stop once when a pending resize advanced the control epoch", async () => {
  const api = transport();
  const controller = new ComputerUseTaskController(binding, api);
  vi.mocked(api.read).mockResolvedValueOnce(snapshot({ controlOwner: "owner", controlEpoch: 2, revision: 2 }));
  await controller.refresh();
  vi.mocked(api.control).mockRejectedValueOnce(new Error("BROWSER_CONTROL_CHANGED"))
    .mockResolvedValueOnce(snapshot({ phase: "cancelled", controlOwner: "stopped", controlEpoch: 4, revision: 4 }));
  vi.mocked(api.read).mockResolvedValueOnce(snapshot({ controlOwner: "owner", controlEpoch: 3, revision: 3 }));
  await controller.control("cancel");
  expect(vi.mocked(api.control).mock.calls.map(call => call[2])).toEqual([2, 3]);
  expect(controller.getSnapshot().snapshot?.phase).toBe("cancelled");
  controller.dispose();
});

it("keeps Stop reachable on a collapsed active Browser card", async () => {
  const api = transport();
  vi.mocked(api.control).mockResolvedValue(snapshot({ phase: "cancelled", controlOwner: "stopped", controlEpoch: 2, revision: 2 }));
  const view = render(<ComputerUseTaskCard binding={binding} transport={api} />);
  const stop = await screen.findByRole("button", { name: "Stop" });
  expect(screen.getByRole("button", { name: "View browser" })).toBeEnabled();
  fireEvent.click(stop);
  await waitFor(() => expect(api.control).toHaveBeenCalledWith(binding, "cancel", 1, expect.any(AbortSignal)));
  view.unmount();
});
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeEach(() => {
  publishValidatedAuthSessionOwner("owner");
  api.owner = "owner";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ clearRect: vi.fn(), drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D);
  api.getComputerUseAdmission.mockReset().mockResolvedValue(null);
  api.ownerPodRequest.mockReset();
  api.apiFetch.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private browser control", () => {
  it("confirms only metadata at the hub and retries a lost pod reply with the same owner receipt", async () => {
    const id = "dir_" + "a".repeat(32);
    const receipt = "synthetic-owner-receipt-" + "x".repeat(32);
    const wireBinding = { owner_id: "owner", pod_id: "pod", incarnation: "incarnation",
      task_id: "task", environment: "development", expires_at: Math.floor(Date.now() / 1000) + 600 };
    const coordination = { binding: wireBinding, purpose: "model_process", commitment: "a".repeat(64),
      pod_key_id: "pod-key", environment: "dev", epoch: 1, service_uid: "service",
      extra_private_value: "never-upload-this" };
    const wire = { binding: wireBinding, phase: "needs_owner", control_owner: "agent",
      control_epoch: 1, next_sequence: 1, revision: 1, capability: { available: true },
      review: { review_id: id, purpose: "model_process", coordination,
        terms: { task_goal: "private synthetic goal", model: "synthetic-model", fields: [], values: {} } } };
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod", environment: "development" });
    let lost = true;
    api.ownerPodRequest.mockImplementation((path: string) => {
      if (path === "browser/capability") return Promise.resolve(Response.json({
        available: true, owner_id: "owner", pod_id: "pod", incarnation: "incarnation", environment: "development",
      }));
      if (path.endsWith("/review") && lost) {
        lost = false;
        return Promise.reject(new Error("synthetic lost pod reply"));
      }
      return Promise.resolve(Response.json(wire));
    });
    api.apiFetch.mockResolvedValue(Response.json({ status: "confirmed", directive_id: id, receipt }));
    const client = new ComputerUseClient("owner", () => "synthetic-vault-bearer");
    const signal = new AbortController().signal;
    await client.capability(signal);
    await expect(client.transport().review(binding, id, signal)).rejects.toThrow("lost pod reply");
    await client.transport().review(binding, id, signal);
    expect(api.apiFetch).toHaveBeenCalledOnce();
    const [path, request] = api.apiFetch.mock.calls[0];
    expect(path).toBe("/api/one/pod/browser-approval/confirm");
    expect(request.headers.Authorization).toBe("Bearer synthetic-vault-bearer");
    expect(request.body).not.toMatch(/private synthetic|never-upload-this|task_goal/);
    const podReviews = api.ownerPodRequest.mock.calls.filter(([path]) => path.endsWith("/review"));
    expect(podReviews).toHaveLength(2);
    expect(podReviews.map(([, init]) => JSON.parse(init.body))).toEqual([
      { review_id: id, receipt }, { review_id: id, receipt },
    ]);
    expect(JSON.stringify(api.ownerPodRequest.mock.calls)).not.toContain("synthetic-vault-bearer");
    coordination.binding = { ...wireBinding, incarnation: "another" };
    await expect(client.transport().review(binding, id, signal)).rejects.toThrow("BROWSER_REVIEW_CHANGED");
    expect(api.apiFetch).toHaveBeenCalledOnce();
  });

  it("refuses late review confirmation across sign-out and same-owner reauthentication", async () => {
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod", environment: "development" });
    api.ownerPodRequest.mockResolvedValue(Response.json({
      available: true, owner_id: "owner", pod_id: "pod", incarnation: "incarnation", environment: "development",
    }));
    const client = new ComputerUseClient("owner", () => "synthetic-vault-bearer");
    const signal = new AbortController().signal;
    await client.capability(signal);
    let finish!: (response: Response) => void;
    api.ownerPodRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const attempt = client.transport().review(binding, "dir_" + "a".repeat(32), signal);
    const refused = expect(attempt).rejects.toThrow("BROWSER_OWNER_CHANGED");
    publishValidatedAuthSessionOwner(null);
    publishValidatedAuthSessionOwner("owner");
    finish(Response.json({}));
    await refused;
    expect(api.apiFetch).not.toHaveBeenCalled();
    expect(api.ownerPodRequest.mock.lastCall?.[5]()).toBe(false);
  });

  it("offers discovery retry after an attempted task without submitting another goal", async () => {
    const discover = vi.spyOn(ComputerUseClient.prototype, "tasks")
      .mockRejectedValueOnce(new Error("BROWSER_TASK_DISCOVERY_UNAVAILABLE"))
      .mockResolvedValueOnce([]);
    const start = vi.spyOn(ComputerUseClient.prototype, "start");
    render(<ComputerUseActiveTasks ownerId="owner" refreshKey={1} route="/one" />);
    expect(await screen.findByRole("status")).toHaveTextContent("hasn’t been restarted");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(start).not.toHaveBeenCalled();
  });

  it("does not show unusable Browser controls on an ordinary Shared chat visit", async () => {
    const discover = vi.spyOn(ComputerUseClient.prototype, "tasks")
      .mockRejectedValue(new Error("BROWSER_CLOUD_GATE_UNAVAILABLE"));
    const view = render(<ComputerUseActiveTasks ownerId="owner" refreshKey={0} route="/one" />);
    await waitFor(() => expect(discover).toHaveBeenCalledOnce());
    expect(view.container).toBeEmptyDOMElement();
  });
  it.each(["completed", "unavailable"] as const)("rediscovers a %s owner outcome without restarting or uploading the task", async (phase) => {
    vi.spyOn(ComputerUseClient.prototype, "tasks").mockResolvedValue([{ binding, phase, current: true }]);
    const direct = transport();
    vi.mocked(direct.read).mockResolvedValue(snapshot({ phase, controlOwner: "stopped", code: phase === "unavailable" ? "BROWSER_MODEL_RATE_LIMITED" : undefined, summary: "Found the requested public result. <script>example</script>" }));
    vi.spyOn(ComputerUseClient.prototype, "transport").mockReturnValue(direct);
    const start = vi.spyOn(ComputerUseClient.prototype, "start");
    const view = render(<ComputerUseActiveTasks ownerId="owner" refreshKey={1} route="/one" />);
    expect(await screen.findByText(phase === "completed" ? "Found the requested public result. <script>example</script>" : "Your AI is busy. Try this task again later.")).toBeVisible();
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "View browser" })).toBeDisabled();
    expect(start).not.toHaveBeenCalled();
    expect(api.apiFetch).not.toHaveBeenCalled();
  });
  it("Back closes preview before leaving chat without stopping the owner's task", async () => {
    const api = transport();
    const view = render(<ComputerUseTaskCard binding={binding} transport={api} route="/" />);
    fireEvent.click(await screen.findByRole("button", { name: "View browser" }));
    expect(screen.getByLabelText("Browser preview")).toBeTruthy();
    act(() => { expect(unwindBackLayer("/")).toBe(true); });
    expect(screen.queryByLabelText("Browser preview")).toBeNull();
    expect(api.control).not.toHaveBeenCalled();
    view.unmount();
    expect(unwindBackLayer("/")).toBe(false);
  });

  it("keeps only schedule metadata and refuses a changed owner's late result", async () => {
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod" });
    const row = { id: "schedule_" + "a".repeat(32), title: "Organize test", capability: "agent_files.organize_file.v1",
      revision: 2, state: "scheduled", repeat: "once", timezone: "UTC", next_run_at: 2000,
      authorization_expires_at: 3000, last_run: null, terms: { private: "must-not-enter-view" } };
    api.ownerPodRequest.mockResolvedValue(Response.json({ available: true, code: null, authorization_limit_at: 1000000, templates: [row.capability], tasks: [row] }));
    const client = new PodScheduledTasksClient("owner");
    expect(JSON.stringify(await client.status())).not.toContain("must-not-enter-view");
    api.ownerPodRequest.mockImplementation(async () => { api.owner = "other"; return Response.json(row); });
    await expect(client.organizeFile({ id: "b".repeat(32), name: "test" }, 2000, "request-id")).rejects.toThrow("SCHEDULE_RESPONSE_REFUSED");
  });

  it("bounds a stalled scheduler response without retrying the installation or request", async () => {
    vi.useFakeTimers();
    try {
      api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod" });
      api.ownerPodRequest.mockImplementation(() => new Promise(() => undefined));
      const client = new PodScheduledTasksClient("owner");
      const result = expect(client.status()).rejects.toThrow("SCHEDULE_RESPONSE_UNCONFIRMED");
      await vi.advanceTimersByTimeAsync(45_000);
      await result;
      expect(api.ownerPodRequest).toHaveBeenCalledOnce();
      expect(api.ownerPodRequest.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("rediscovers current tasks but never admits recovered work from an old incarnation", async () => {
    api.getComputerUseAdmission.mockResolvedValue({ ownerId: "owner", podId: "pod", environment: "development" });
    const wireBinding = { owner_id: "owner", pod_id: "pod", incarnation: "previous", task_id: "browser_" + "a".repeat(32), environment: "development" };
    let phase = "outcome_uncertain";
    api.ownerPodRequest.mockImplementation((path: string) => Promise.resolve(Response.json(path === "browser/capability"
      ? { available: false, code: "BROWSER_DISABLED", owner_id: "owner", pod_id: "pod", incarnation: "current", environment: "development" }
      : [{ binding: wireBinding, phase }])));
    const client = new ComputerUseClient("owner");
    expect(await client.tasks(new AbortController().signal)).toMatchObject([{ current: false, phase: "outcome_uncertain" }]);
    phase = "running";
    await expect(client.tasks(new AbortController().signal)).rejects.toThrow("BROWSER_TASK_RESPONSE_REFUSED");
    wireBinding.owner_id = "another";
    phase = "outcome_uncertain";
    await expect(client.tasks(new AbortController().signal)).rejects.toThrow("BROWSER_TASK_RESPONSE_REFUSED");
  });

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
    await controller.refresh();
    expect(controller.getSnapshot().snapshot).toMatchObject({ controlEpoch: 2, nextSequence: 2, revision: 3 });
    expect(controller.acceptsFrame({ binding, controlEpoch: 2, sequence: 1, width: 1280, height: 720, png })).toBe(true);
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

  it("refuses changed geometry without a new control epoch", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    vi.mocked(api.read).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      viewport: { width: 1280, height: 720 } }));
    await controller.refresh();
    vi.mocked(api.read).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      revision: 3, viewport: { width: 390, height: 700 } }));
    await expect(controller.refresh()).rejects.toThrow("BROWSER_TASK_UNAVAILABLE");
    await expect(controller.input({ operation: "click", x: 10, y: 20 }))
      .rejects.toThrow("BROWSER_OWNER_CONTROL_REQUIRED");
    expect(api.input).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("fences old coordinates and frames until a viewport change is acknowledged", async () => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    vi.mocked(api.read).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      viewport: { width: 1280, height: 720 } }));
    await controller.refresh();
    let finish!: (value: ComputerUseSnapshot) => void;
    vi.mocked(api.input).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const resize = controller.input({ operation: "resize", width: 390, height: 700 });
    expect(controller.acceptsFrame({ binding, controlEpoch: 2, sequence: 0, width: 1280, height: 720, png })).toBe(false);
    await expect(controller.input({ operation: "click", x: 10, y: 10 })).rejects.toThrow("OWNER_CONTROL_REQUIRED");
    finish(snapshot({ controlOwner: "owner", controlEpoch: 3, nextSequence: 2, revision: 2,
      viewport: { width: 390, height: 700 } }));
    await resize;
    expect(controller.acceptsFrame({ binding, controlEpoch: 2, sequence: 1, width: 390, height: 700, png })).toBe(false);
    expect(controller.acceptsFrame({ binding, controlEpoch: 3, sequence: 1, width: 1280, height: 720, png })).toBe(false);
    expect(controller.acceptsFrame({ binding, controlEpoch: 3, sequence: 1, width: 390, height: 700, png })).toBe(true);
    expect(api.input).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it.each(["mouse", "touch"])("waits for a painted current frame before mapping scaled %s input", async (pointerType) => {
    const api = transport();
    const controller = new ComputerUseTaskController(binding, api);
    vi.mocked(api.read).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      viewport: { width: 390, height: 700 } }));
    await controller.refresh();
    let decode!: (image: ImageBitmap) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise((resolve) => { decode = resolve; })));
    const view = render(<ComputerUsePreview controller={controller} />);
    const canvas = view.container.querySelector("canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, right: 205, bottom: 370, width: 195, height: 350 } as DOMRect);
    const click = () => {
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 107.5, clientY: 195 });
        Object.defineProperty(event, "pointerType", { value: pointerType });
        fireEvent(canvas, event);
      }
    };
    click();
    expect(api.input).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next field" })).toBeDisabled();
    const receive = vi.mocked(api.watchFrames).mock.calls[0][2];
    receive({ binding, controlEpoch: 2, sequence: 0, width: 390, height: 700, png });
    expect(screen.getByRole("button", { name: "Next field" })).toBeDisabled();
    await act(async () => { decode({ width: 390, height: 700, close: vi.fn() } as unknown as ImageBitmap); });
    expect(screen.getByRole("button", { name: "Next field" })).toBeEnabled();
    vi.mocked(api.input).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      nextSequence: 2, revision: 2, viewport: { width: 390, height: 700 } }));
    click();
    await waitFor(() => expect(api.input).toHaveBeenCalledWith(binding, {
      operation: "click", x: 195, y: 350, sequence: 1, control_epoch: 2,
    }, expect.any(AbortSignal)));
    expect(computerUsePoint(canvas, 107.5, 195)).toEqual({ x: 195, y: 350 });
    expect(computerUsePoint(canvas, 9, 20)).toBeNull();
    expect(fitComputerUseViewport(834, 1194)).toEqual({ width: 834, height: 1080 });
    expect(fitComputerUseViewport(200, 150)).toEqual({ width: 320, height: 240 });
    await waitFor(() => expect(controller.getSnapshot().pending).toBe(false));
    vi.mocked(api.read).mockRejectedValueOnce(new Error("synthetic offline"));
    await act(async () => { await expect(controller.refresh()).rejects.toThrow(); });
    vi.mocked(api.read).mockResolvedValue(snapshot({ controlOwner: "owner", controlEpoch: 2,
      nextSequence: 2, revision: 2, viewport: { width: 390, height: 700 } }));
    await act(async () => { await controller.refresh(); });
    expect(screen.getByRole("button", { name: "Next field" })).toBeDisabled();
    view.unmount(); controller.dispose();
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
    expect(parseComputerUseSnapshot({ ...wire, phase: "completed", summary: "A private task result." }, binding).summary).toBe("A private task result.");
    expect(() => parseComputerUseSnapshot({ ...wire, summary: "x".repeat(2001) }, binding)).toThrow();
    expect(parseComputerUseSnapshot({ ...wire, phase: "completed", summary: "🌍".repeat(2000) }, binding).summary).toBe("🌍".repeat(2000));
    expect(() => parseComputerUseSnapshot({ ...wire, summary: "🌍".repeat(2001) }, binding)).toThrow();
    expect(() => parseComputerUseSnapshot({ ...wire, capability: { available: "true" } }, binding)).toThrow();
    expect(() => parseComputerUseSnapshot({ ...wire, binding: { ...wire.binding, pod_id: "other" } }, binding)).toThrow();
    expect(parseComputerUseSnapshot({ ...wire, capability: { available: true, public_research_only: true } }, binding).publicResearchOnly).toBe(true);
    expect(() => parseComputerUseSnapshot({ ...wire, capability: { available: true, public_research_only: "true" } }, binding)).toThrow();
  });

  it("renders only exact selected scalar details and never exposes stored sign-in values", () => {
    const wire = {
      binding: { owner_id: "owner", pod_id: "pod", incarnation: "incarnation", task_id: "task", environment: "development" },
      phase: "needs_owner", capability: { available: true }, control_owner: "agent", control_epoch: 1, next_sequence: 1, revision: 1,
      review: { review_id: "review", purpose: "model_process", terms: {
        model: "Gemini", task_goal: "Prepare a synthetic form", result_storage: "owner_encrypted_log", origins: ["https://example.com"], fields: [{ domain: "profile", path: "name" }],
        values: { "attr.profile.name": { profile: { name: "Synthetic Owner", unrelated: "not selected" } } },
      } },
    };
    expect(parseComputerUseSnapshot(wire, binding).review?.details).toEqual([{ label: "profile · name", value: "Synthetic Owner" }]);
    expect(parseComputerUseSnapshot(wire, binding).review?.resultStorage).toBe("owner_encrypted_log");
    expect(() => parseComputerUseSnapshot({ ...wire, review: { ...wire.review, terms: { ...wire.review.terms, result_storage: "hub_plaintext" } } }, binding)).toThrow();
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

  it("keeps the exact entered page in reviewed instructions and retry identity", async () => {
    vi.spyOn(ComputerUseClient.prototype, "capability").mockResolvedValue({ available: true, code: "ready" });
    const start = vi.spyOn(ComputerUseClient.prototype, "start")
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(snapshot());
    render(<ComputerUseOwnerBridge ownerId="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    const site = await screen.findByLabelText("Website");
    fireEvent.change(site, { target: { value: "https://example.com/first?q=synthetic" } });
    fireEvent.change(screen.getByLabelText("What should One do?"), { target: { value: "Summarize this page" } });
    fireEvent.click(screen.getByRole("button", { name: "Start browser task" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start browser task" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start browser task" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start browser task" })).toBeEnabled());
    fireEvent.change(site, { target: { value: "https://example.com/second" } });
    fireEvent.click(screen.getByRole("button", { name: "Start browser task" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start.mock.calls[0][0].goal).toBe("Summarize this page\n\nStart at: https://example.com/first?q=synthetic");
    expect(start.mock.calls[1][0].requestId).toBe(start.mock.calls[0][0].requestId);
    expect(start.mock.calls[2][0].goal).toBe("Summarize this page\n\nStart at: https://example.com/second");
    expect(start.mock.calls[0][0].allowedOrigins).toEqual(["https://example.com"]);
    expect(start.mock.calls[2][0].requestId).not.toBe(start.mock.calls[0][0].requestId);
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


it("waits for an early first frame but refuses other preview errors", async () => {
  const stop = new AbortController();
  const request = vi.fn().mockResolvedValueOnce(Response.json({ detail: { code: "BROWSER_FRAME_NOT_READY" } }, { status: 409 }))
    .mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10]), { headers: {
      "Content-Type": "image/png", "X-Browser-Pod-Incarnation": binding.incarnation,
      "X-Browser-Task-Id": binding.taskId, "X-Browser-Pod-Id": binding.podId,
      "X-Browser-Control-Epoch": "1", "X-Browser-Sequence": "0", "X-Browser-Revision": "1",
      "X-Browser-Width": "1280", "X-Browser-Height": "720",
    }}));
  const receive = vi.fn(() => stop.abort());
  await createDirectComputerUseTransport(request).watchFrames(binding, stop.signal, receive);
  expect(request).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledOnce();
  await expect(createDirectComputerUseTransport(async () => Response.json({ detail: { code: "BROWSER_OWNER_REFUSED" } }, {status: 409}))
    .watchFrames(binding, new AbortController().signal, vi.fn())).rejects.toThrow("FRAME_REFUSED");
});
