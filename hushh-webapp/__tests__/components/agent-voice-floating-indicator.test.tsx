import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent/agent-voice-state", () => ({
  useAgentVoiceState: (selector: (s: { active: boolean; status: string; level: number; message: string }) => unknown) =>
    selector({ active: false, status: "idle", level: 0, message: "" }),
  getAgentVoiceStatusLabel: () => "Idle",
}));

import { AgentVoiceFloatingIndicator } from "@/components/agent/agent-voice-floating-indicator";

describe("AgentVoiceFloatingIndicator", () => {
  it("renders nothing when voice is inactive", () => {
    const { container } = render(<AgentVoiceFloatingIndicator />);
    expect(container.firstChild).toBeNull();
  });
});
