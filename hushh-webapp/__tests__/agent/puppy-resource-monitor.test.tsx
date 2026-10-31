import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PuppyResourceMonitor } from "@/components/agent/puppy-resource-monitor";
import type { PuppyResources } from "@/lib/services/puppy-one-service";

/**
 * What the reader sees, not what the component renders internally.
 *
 * The three origin states are the ones worth defending: "on this machine",
 * "local turn with the gate off", and "answers leave this machine" are three
 * different promises, and collapsing any two of them would make this surface
 * claim something the runtime is not doing.
 *
 * The monitor is now the SHEET BODY: it is handed a reading and renders it,
 * and it takes no reading of its own. Who reads the machine, and when, is
 * `PuppyMachineSheet`'s contract and is tested next door.
 */

function show(payload: PuppyResources | null) {
  return render(<PuppyResourceMonitor payload={payload} />);
}

describe("PuppyResourceMonitor", () => {
  it("says the answer is generated here only when the gate is on too", () => {
    show({
      configured: true,
      reachable: true,
      agent: {
        model: "google/gemma-4-26b-a4b-qat",
        on_device: true,
        on_device_gate: true,
      },
    });
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    expect(
      screen.getByText("google/gemma-4-26b-a4b-qat"),
    ).toBeInTheDocument();
  });

  it("says auxiliary work may leave when the model is local but the gate is off", () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: false },
    });
    expect(
      screen.getByText("This turn is local; auxiliary work may leave"),
    ).toBeInTheDocument();
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
  });

  it("does not claim the gate is on when the gate was not reported", () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true },
    });
    expect(
      screen.getByText("This turn is local; auxiliary work may leave"),
    ).toBeInTheDocument();
  });

  it("says answers leave the machine for a non-local provider", () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "gpt-5", provider: "openai", on_device: false },
    });
    expect(screen.getByText("Answers leave this machine")).toBeInTheDocument();
  });

  it("makes no origin claim at all when on_device was not reported", () => {
    show({ configured: true, reachable: true, agent: { model: "m" } });
    expect(screen.getByText("m")).toBeInTheDocument();
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Answers leave this machine"),
    ).not.toBeInTheDocument();
  });

  it("shows a desktop's absent battery as 'No battery', never as 0%", () => {
    show({
      configured: true,
      reachable: true,
      machine: { ram_used_pct: 41.2, battery: { present: false } },
    });
    expect(screen.getByText("No battery")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("warns in words as well as colour when the disk is nearly full", () => {
    show({
      configured: true,
      reachable: true,
      machine: { disk_free_gb: 54.7, disk_used_pct: 94.1 },
    });
    expect(screen.getByText("Nearly full")).toBeInTheDocument();
    expect(screen.getByText("54.7 GB free")).toBeInTheDocument();
    expect(screen.getByText("94% used")).toBeInTheDocument();
  });

  it("warns only when the battery is low AND discharging", () => {
    const charging = show({
      configured: true,
      reachable: true,
      machine: {
        battery: { present: true, percent: 12, charging: true, on_ac: true },
      },
    });
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.queryByText("Running down")).not.toBeInTheDocument();
    charging.unmount();

    show({
      configured: true,
      reachable: true,
      machine: {
        battery: { present: true, percent: 12, charging: false, on_ac: false },
      },
    });
    expect(screen.getByText("Running down")).toBeInTheDocument();
  });

  it("reads the next job as a relative time off the gateway's own clock", () => {
    show({
      configured: true,
      reachable: true,
      generated_at: Date.parse("2026-09-02T14:02:51-07:00"),
      jobs: {
        enabled: 11,
        disabled: 2,
        next: { at: "2026-09-02T14:16:51-07:00", name: "Self-Healing Doctor" },
        last_24h: { completed: 150, failed: 3 },
      },
    });
    expect(screen.getByText("11 scheduled")).toBeInTheDocument();
    expect(screen.getByText("· 2 off")).toBeInTheDocument();
    expect(screen.getByText(/Self-Healing Doctor/)).toBeInTheDocument();
    expect(screen.getByText("in 14 min")).toBeInTheDocument();
    expect(screen.getByText(/150 completed/)).toBeInTheDocument();
    expect(screen.getByText(/3 failed/)).toBeInTheDocument();
  });

  it("falls back to the browser's read time when the gateway stamped none", () => {
    // The relative time still has to be honest about its base: with neither a
    // gateway clock nor a read time it says nothing rather than counting from
    // the epoch, which would print "in 2903472 h".
    const stamped = show({
      configured: true,
      reachable: true,
      jobs: { next: { at: "2026-09-02T14:16:51-07:00", name: "Doctor" } },
    });
    expect(screen.getByText(/Next: Doctor/)).toBeInTheDocument();
    expect(screen.queryByText("in 14 min")).not.toBeInTheDocument();
    stamped.unmount();

    render(
      <PuppyResourceMonitor
        readAt={Date.parse("2026-09-02T14:02:51-07:00")}
        payload={{
          configured: true,
          reachable: true,
          jobs: {
            next: { at: "2026-09-02T14:16:51-07:00", name: "Doctor" },
          },
        }}
      />,
    );
    expect(screen.getByText("in 14 min")).toBeInTheDocument();
  });

  it("gives a healthy link one small line, not a banner", () => {
    show({
      configured: true,
      reachable: true,
      link: {
        connected: true,
        session: "ok",
        account_email: "owner@example.com",
        environment: "uat",
      },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(
      screen.getByText("Signed in to Hussh One · owner@example.com · uat"),
    ).toBeInTheDocument();
  });

  it("never renders an account email the payload did not carry", () => {
    show({
      configured: true,
      reachable: true,
      link: { connected: true, session: "ok", environment: "uat" },
      agent: { model: "m" },
    });
    expect(screen.getByText("m")).toBeInTheDocument();
    expect(screen.getByText("Signed in to Hussh One · uat")).toBeInTheDocument();
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it("says nothing about a machine that was never linked", () => {
    show({
      configured: true,
      reachable: true,
      link: { connected: false, session: "not_connected" },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    expect(screen.queryByText(/Hussh One/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
  });

  it("leaves a broken link to the surface, and does not repeat it in here", () => {
    // The banner is inline, outside this sheet, and it is said ONCE. A second
    // copy behind a tap is how a reader learns to stop reading either.
    show({
      configured: true,
      reachable: true,
      link: { session: "expired", remedy: "/hussh-one reconnect" },
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(
      screen.queryByText(/signed out of Hussh One/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("/hussh-one reconnect")).not.toBeInTheDocument();
    // The local readings are still true, which is exactly the trap the inline
    // banner exists for: the machine looks healthy while One cannot see it.
    expect(screen.getByText("On this machine")).toBeInTheDocument();
  });

  it("renders with the link section absent, and with it empty", () => {
    const absent = show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
    absent.unmount();

    // An empty section carries no session, so it makes no claim either way.
    show({
      configured: true,
      reachable: true,
      link: {},
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    expect(
      screen.queryByText("Link state could not be checked"),
    ).not.toBeInTheDocument();
  });

  it("renders only the sections the machine could answer", () => {
    show({
      configured: true,
      reachable: true,
      agent: { model: "m", on_device: true, on_device_gate: true },
    });
    expect(screen.getByText("On this machine")).toBeInTheDocument();
    // No models, machine or jobs probe answered, so none of those headings
    // exist. An empty "0 GB free" would be a reading nobody took.
    expect(screen.queryByText("Model memory")).not.toBeInTheDocument();
    expect(screen.queryByText("Headroom")).not.toBeInTheDocument();
    expect(screen.queryByText("Scheduled work")).not.toBeInTheDocument();
  });

  it("renders not-configured and unreachable as calm states, not errors", () => {
    const notConfigured = show({
      configured: false,
      reason: "not_configured",
      message: "Set HERMES_API_SERVER_KEY to read the machine.",
    });
    expect(
      screen.getByText("Set HERMES_API_SERVER_KEY to read the machine."),
    ).toBeInTheDocument();
    notConfigured.unmount();

    const unreachable = show({ configured: true, reachable: false });
    expect(
      screen.getByText("Puppy One is not answering on this machine."),
    ).toBeInTheDocument();
    unreachable.unmount();

    // Opened before the first reading landed. Still calm, still no numbers.
    show(null);
    expect(screen.getByText("Reading this machine…")).toBeInTheDocument();
  });
});
