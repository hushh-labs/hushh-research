import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentConnectAccessCard } from "@/components/agent/agent-connect-access-card";

describe("AgentConnectAccessCard", () => {
  it("renders the title, every bullet, and wires the CTA and dismiss actions", () => {
    const onConnect = vi.fn();
    const onDismiss = vi.fn();

    render(
      <AgentConnectAccessCard
        title="Read your inbox"
        bullets={[
          "Reads your email for what needs a reply",
          "Surfaces meetings from your invites",
          "Never shares or sells your data",
          "Never acts without your yes",
        ]}
        ctaLabel="Connect Gmail & continue"
        onConnect={onConnect}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId("agent-connect-access-card")).toBeTruthy();
    expect(screen.getByText("Read your inbox")).toBeTruthy();
    expect(screen.getByText("Reads your email for what needs a reply")).toBeTruthy();
    expect(screen.getByText("Surfaces meetings from your invites")).toBeTruthy();
    expect(screen.getByText("Never shares or sells your data")).toBeTruthy();
    expect(screen.getByText("Never acts without your yes")).toBeTruthy();

    fireEvent.click(screen.getByTestId("agent-connect-access-cta"));
    expect(onConnect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("agent-connect-access-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a busy CTA label and disables both actions while connecting", () => {
    const onConnect = vi.fn();
    const onDismiss = vi.fn();

    render(
      <AgentConnectAccessCard
        title="Read your inbox"
        bullets={["Reads your email for what needs a reply"]}
        ctaLabel="Connect Gmail & continue"
        busy
        onConnect={onConnect}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId("agent-connect-access-cta")).toBeDisabled();
    expect(screen.getByTestId("agent-connect-access-dismiss")).toBeDisabled();
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });
});
