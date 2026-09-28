import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));

import {
  AGENT_RESPONSE_REPORT_REASONS,
  AgentResponseReportButton,
} from "@/components/agent/agent-response-report";
import { setAgentChatFeedback } from "@/lib/services/agent-chat-client";

// Google Play's AI-Generated Content policy: a person can report or flag an
// offensive AI answer to the developer without leaving the app.
describe("AgentResponseReportButton", () => {
  it("reports one answer with the chosen reason and closes on success", async () => {
    const onReport = vi.fn().mockResolvedValue(undefined);
    render(<AgentResponseReportButton reported={false} onReport={onReport} />);

    fireEvent.click(screen.getByRole("button", { name: "Report response" }));
    const send = screen.getByRole("button", { name: "Send report" });
    expect(send).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Offensive or hateful"));
    fireEvent.click(send);

    await waitFor(() => expect(onReport).toHaveBeenCalledWith("offensive"));
    await waitFor(() =>
      expect(screen.queryByText("Report this response")).not.toBeInTheDocument(),
    );
  });

  it("keeps the dialog open with a retry when the report fails", async () => {
    const onReport = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    render(<AgentResponseReportButton reported={false} onReport={onReport} />);

    fireEvent.click(screen.getByRole("button", { name: "Report response" }));
    fireEvent.click(screen.getByLabelText("Harmful or dangerous"));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the report",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onReport).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Report this response")).not.toBeInTheDocument(),
    );
  });

  it("cancels without reporting", () => {
    const onReport = vi.fn();
    render(<AgentResponseReportButton reported={false} onReport={onReport} />);
    fireEvent.click(screen.getByRole("button", { name: "Report response" }));
    fireEvent.click(screen.getByLabelText("Something else"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onReport).not.toHaveBeenCalled();
  });

  it("shows a reported state and never renders technical ids", () => {
    const { container } = render(
      <AgentResponseReportButton reported onReport={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Response reported" })).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/conv|msg|evt-|[0-9a-f]{8}-/i);
  });

  it("offers exactly the backend's reason enum", () => {
    expect(AGENT_RESPONSE_REPORT_REASONS.map((r) => r.value)).toEqual([
      "offensive",
      "harmful",
      "inaccurate",
      "other",
    ]);
  });
});

describe("setAgentChatFeedback report", () => {
  beforeEach(() => apiFetch.mockReset());

  it("sends the report reason with a down rating on the existing feedback route", async () => {
    apiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await setAgentChatFeedback({
      conversationId: "conv-1",
      messageId: "evt-2",
      rating: "down",
      reportReason: "inaccurate",
      vaultOwnerToken: "token",
    });
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/one/agent-chat/feedback");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      conversation_id: "conv-1",
      message_id: "evt-2",
      rating: "down",
      report_reason: "inaccurate",
    });
  });

  it("leaves a plain rating's payload unchanged", async () => {
    apiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await setAgentChatFeedback({
      conversationId: "conv-1",
      messageId: "evt-2",
      rating: "up",
      vaultOwnerToken: "token",
    });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      conversation_id: "conv-1",
      message_id: "evt-2",
      rating: "up",
    });
  });
});
