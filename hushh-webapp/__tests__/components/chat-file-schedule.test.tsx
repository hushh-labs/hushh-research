import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatFileScheduleCard } from "@/components/scheduled-tasks/chat-file-schedule-card";
import { readFileScheduleProposal } from "@/lib/agent/file-schedule-proposal";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { FILE_ORGANIZATION_TEMPLATE, PodScheduledTasksClient } from "@/lib/services/pod-scheduled-tasks";

const mocks = vi.hoisted(() => ({ hosting: "pod", settings: vi.fn(), list: vi.fn(), entry: vi.fn() }));
vi.mock("@/lib/files/service", () => ({ FilesService: mocks }));
vi.mock("@/lib/files/use-files-connection", () => ({ withUnlockedFilesConnection: (_credentials: unknown,
  run: (hosting: string) => Promise<unknown>) => run(mocks.hosting) }));

const file = { id: "f".repeat(32), name: "Minutes.txt", kind: "file", state: "ready", revision: 3 };
const taskId = `schedule_${"a".repeat(32)}`;
const credentials = { userId: "owner", vaultKey: "test-key", vaultOwnerToken: "test-token" };
const scheduledAt = Math.floor((Date.now() + 3_600_000) / 60_000) * 60_000;

describe("private Files schedule review in Chat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    publishValidatedAuthSessionOwner("owner");
    mocks.hosting = "pod";
    mocks.settings.mockReset().mockResolvedValue({ revision: 2, analysis: true, backgroundAvailable: true, excluded: [] });
    mocks.list.mockReset().mockResolvedValue({ entries: [file], cursor: "" });
    mocks.entry.mockReset().mockResolvedValue(file);
    vi.spyOn(PodScheduledTasksClient.prototype, "status").mockResolvedValue({
      available: true, code: null, authorization_limit_at: Math.floor(Date.now() / 1000) + 172800,
      templates: [FILE_ORGANIZATION_TEMPLATE], tasks: [],
    });
  });

  async function openReview() {
    render(<ChatFileScheduleCard proposal={{ runAt: scheduledAt }} credentials={credentials} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    fireEvent.click(await screen.findByRole("button", { name: file.name }));
    const confirm = await screen.findByRole("button", { name: "Confirm schedule" });
    await waitFor(() => expect(confirm).toBeEnabled());
    return confirm;
  }

  it("stages an exact file, retries one immutable request, then links only a Pod-confirmed schedule", async () => {
    const organize = vi.spyOn(PodScheduledTasksClient.prototype, "organizeFile")
      .mockRejectedValueOnce(new Error("SCHEDULE_RESPONSE_UNCONFIRMED"))
      .mockResolvedValueOnce({ id: taskId, title: "Organize Minutes.txt", state: "scheduled", revision: 2,
        capability: FILE_ORGANIZATION_TEMPLATE, repeat: "once", timezone: "UTC", next_run_at: scheduledAt / 1000,
        authorization_expires_at: scheduledAt / 1000 + 86400, last_run: null });
    const confirm = await openReview();
    expect(organize).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(await screen.findByRole("link", { name: "Check Tasks" })).toHaveAttribute("href", "/one/tasks?scheduled=1");
    expect(screen.getByLabelText("Run at")).toBeDisabled();
    expect(screen.queryByText("File organization scheduled")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
    expect(await screen.findByRole("link", { name: "View in Tasks" })).toHaveAttribute("href", `/one/tasks?scheduled=${taskId}`);
    expect(organize.mock.calls[0]?.slice(0, 3)).toEqual(organize.mock.calls[1]?.slice(0, 3));
    expect(organize.mock.calls[0]?.[4]).toBe(organize.mock.calls[1]?.[4]);
    expect(organize.mock.calls[0]?.[0]).toMatchObject({ id: file.id, revision: 3, analysisRevision: 2 });
    expect(organize.mock.calls[0]?.[1]).toBe(scheduledAt / 1000);
  });

  it("requires a new file review if the selected revision changed", async () => {
    const organize = vi.spyOn(PodScheduledTasksClient.prototype, "organizeFile");
    mocks.entry.mockResolvedValueOnce({ ...file, revision: 4 });
    fireEvent.click(await openReview());
    expect(await screen.findByRole("alert")).toHaveTextContent("selected file or its permission changed");
    expect(organize).not.toHaveBeenCalled();
  });

  it("does not list Shared files or offer confirmation", async () => {
    mocks.hosting = "shared";
    render(<ChatFileScheduleCard proposal={{ runAt: null }} credentials={credentials} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("qualified private Pod");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm schedule" })).not.toBeInTheDocument();
  });

  it("accepts only the typed tool result and never accepts a model-selected file", () => {
    const offer = { status: "proposal_ready", type: "files.schedule_organization", run_at: "2030-01-02T09:30:00+00:00", file_id: "untrusted" };
    expect(readFileScheduleProposal("propose_file_schedule", JSON.stringify(offer))).toEqual({ runAt: Date.parse(offer.run_at) });
    expect(readFileScheduleProposal("organize_file", offer)).toBeNull();
    expect(readFileScheduleProposal("propose_file_schedule", { ...offer, run_at: "2030-01-02T09:30:00" })).toBeNull();
  });
});
