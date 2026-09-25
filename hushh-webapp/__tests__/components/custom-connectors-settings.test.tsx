import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";
import { loadCustomConnectorConfigurations, saveCustomConnectorConfiguration } from "@/lib/connections/custom-connector-configuration";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

vi.mock("@/lib/connections/custom-connector-configuration", () => ({ loadCustomConnectorConfigurations: vi.fn(), saveCustomConnectorConfiguration: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, size: _s, variant: _v, effect: _e, ...props }: any) => <button {...props}>{children}</button> }));
const access = { userId: "synthetic-owner", vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-owner-token" };
beforeEach(() => {
  vi.resetAllMocks();
  publishValidatedAuthSessionOwner(access.userId);
  vi.mocked(loadCustomConnectorConfigurations).mockResolvedValue([]);
  vi.mocked(saveCustomConnectorConfiguration).mockImplementation(async (_access, record) => record);
});

it("saves through the vault with explicit confirmation and no connected claim", async () => {
  render(<CustomConnectorsSettings access={access} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add connector" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic server" } });
  fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "https://example.com/mcp" } });
  fireEvent.change(screen.getByLabelText("Authorization header (optional)"), { target: { value: "Bearer synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connector" }));
  await screen.findByText("Saved · connection not verified");
  expect(saveCustomConnectorConfiguration).toHaveBeenCalledOnce();
  expect(vi.mocked(saveCustomConnectorConfiguration).mock.calls[0][2]).toMatchObject({ confirmedByUser: true });
  expect(document.body.textContent).not.toContain("Bearer synthetic");
});

it("does not enable adding when the vault catalog cannot be read", async () => {
  vi.mocked(loadCustomConnectorConfigurations).mockRejectedValue(new Error("synthetic failure"));
  render(<CustomConnectorsSettings access={access} />);
  await screen.findByText(/Could not load saved connectors/);
  expect(screen.getByRole("button", { name: "Add connector" })).toBeDisabled();
});
