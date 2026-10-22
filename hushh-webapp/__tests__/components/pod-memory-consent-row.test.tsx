/**
 * The one control that lets an owner allow their pod's provider Memory Bank to
 * process anything.
 *
 * WHY THESE TESTS EXIST. The pod refuses every provider write with
 * `skipped_no_consent` until an `agent_memory_provider_consent` is recorded. That
 * gate landed on 2026-09-10, and nothing in the app ever granted it, so provider
 * memory was silently off for every person with no way to turn it on. Both skip
 * branches were also silent in the log, so the symptom was the ABSENCE of a
 * failure line. This row is the way on, and these tests pin the two properties
 * that make it honest: it shows the pod's word rather than a local guess, and a
 * failed write changes nothing on screen.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiService } from "@/lib/services/api-service";
import { PodMemoryConsentRow } from "@/components/agent/pod-memory-consent-row";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPodMemoryStatus: vi.fn(),
    setPodMemoryProviderConsent: vi.fn(),
  },
}));

const status = vi.mocked(ApiService.getPodMemoryStatus);
const decide = vi.mocked(ApiService.setPodMemoryProviderConsent);

function podSays(consent: "absent" | "granted" | "revoked", bank = true) {
  return { hushhId: "ha1_x", provider: { consent, bank } };
}

describe("PodMemoryConsentRow", () => {
  beforeEach(() => {
    status.mockReset();
    decide.mockReset();
  });

  it("renders nothing without an agent id", () => {
    const { container } = render(<PodMemoryConsentRow hushhId={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(status).not.toHaveBeenCalled();
  });

  it("shows the POD's word for the current state, never a local guess", async () => {
    status.mockResolvedValue(podSays("absent"));
    render(<PodMemoryConsentRow hushhId="ha1_x" />);

    await waitFor(() => expect(screen.getByTestId("pod-memory-consent")).toHaveAttribute("data-consent", "absent"));
    expect(screen.getByText("Provider memory: off")).toBeInTheDocument();
    expect(screen.getByTestId("pod-memory-consent-toggle")).toHaveTextContent("Allow");
    expect(status).toHaveBeenCalledWith("ha1_x");
  });

  it("granting posts the decision, then RE-READS the pod before showing on", async () => {
    status.mockResolvedValueOnce(podSays("absent")).mockResolvedValueOnce(podSays("granted"));
    decide.mockResolvedValue({ hushhId: "ha1_x" });
    render(<PodMemoryConsentRow hushhId="ha1_x" />);
    await waitFor(() => expect(screen.getByText("Provider memory: off")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("pod-memory-consent-toggle"));

    await waitFor(() => expect(screen.getByText("Provider memory: on")).toBeInTheDocument());
    expect(decide).toHaveBeenCalledWith("ha1_x", true);
    // Two reads: the initial one and the confirmation after the write. The state
    // came from the second read, not from assuming the POST landed.
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("pod-memory-consent-toggle")).toHaveTextContent("Turn off");
  });

  it("a failed write changes nothing and says so", async () => {
    status.mockResolvedValue(podSays("absent"));
    decide.mockRejectedValue(new Error("memory provider consent failed: HTTP 503"));
    render(<PodMemoryConsentRow hushhId="ha1_x" />);
    await waitFor(() => expect(screen.getByText("Provider memory: off")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("pod-memory-consent-toggle"));

    await waitFor(() => expect(screen.getByTestId("pod-memory-consent-error")).toBeInTheDocument());
    expect(screen.getByText("Provider memory: off")).toBeInTheDocument();
    expect(screen.getByTestId("pod-memory-consent")).toHaveAttribute("data-consent", "absent");
  });

  it("revoking posts false", async () => {
    status.mockResolvedValueOnce(podSays("granted")).mockResolvedValueOnce(podSays("revoked"));
    decide.mockResolvedValue({ hushhId: "ha1_x" });
    render(<PodMemoryConsentRow hushhId="ha1_x" />);
    await waitFor(() => expect(screen.getByText("Provider memory: on")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("pod-memory-consent-toggle"));

    await waitFor(() => expect(screen.getByText("Provider memory: off")).toBeInTheDocument());
    expect(decide).toHaveBeenCalledWith("ha1_x", false);
  });

  it("a pod with no provider bank cannot be granted, and says why", async () => {
    status.mockResolvedValue(podSays("absent", false));
    render(<PodMemoryConsentRow hushhId="ha1_x" />);

    await waitFor(() => expect(screen.getByText("no provider bank on this pod")).toBeInTheDocument());
    expect(screen.getByTestId("pod-memory-consent-toggle")).toBeDisabled();
  });
});
