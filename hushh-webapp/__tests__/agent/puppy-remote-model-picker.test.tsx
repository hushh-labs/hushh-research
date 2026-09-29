import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPuppyDirectModels: vi.fn(),
  getPuppyModelSelection: vi.fn(),
  setPuppyGlobalModel: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({ ApiService: api }));

import { PuppyRemoteModelPicker } from "@/components/agent/puppy-remote-model-picker";

beforeEach(() => {
  api.getPuppyDirectModels.mockResolvedValue({
    status: "available",
    defaultModel: "local/default",
    catalogVersion: "catalog-1",
    models: [{ id: "local/default" }, { id: "local/other" }],
  });
  api.getPuppyModelSelection.mockResolvedValue({ status: "applied", version: 1 });
});

describe("Puppy remote model picker", () => {
  it("keeps confirmation open after the model list closes", async () => {
    const onChatModel = vi.fn();
    render(<PuppyRemoteModelPicker
      hushhId="owner-1" deviceId="device-1" vaultOwnerToken="owner-capability"
      chatModel={null} busy={false} hasTurns={false}
      onChatModel={onChatModel} onGlobalModel={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Choose Puppy model" }));
    fireEvent.click(await screen.findByRole("button", { name: "local/other" }));
    expect(await screen.findByRole("heading", { name: "Use local/other?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await waitFor(() => expect(onChatModel).toHaveBeenCalledWith("local/other", "catalog-1"));
  });
});
