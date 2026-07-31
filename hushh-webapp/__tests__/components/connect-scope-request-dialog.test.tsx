import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectScopeRequestDialog } from "@/components/connect/connect-scope-request-dialog";
import {
  ConnectionsService,
  type RequestableScopeCatalog,
} from "@/lib/services/connections-service";

function sampleCatalog(): RequestableScopeCatalog {
  return {
    bundles: [],
    scopes: [
      {
        scope: "email",
        label: "Email",
        description: "Your email address",
        icon_name: null,
        color_hex: null,
        sensitivity: "low",
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectScopeRequestDialog catalog loading", () => {
  // Regression for the infinite "Loading data options…" spinner: the load
  // effect used to list `loading` (and the inline `getIdToken` closure) in its
  // dependency array, so `setLoading(true)` re-ran the effect, its cleanup
  // cancelled the in-flight fetch, and `loading` was never cleared. The dialog
  // stayed on the spinner forever even with a perfectly healthy backend. Note
  // `getIdToken` is a fresh closure on every render here, exactly as the real
  // caller passes it.
  it("clears the spinner and renders scopes once the catalog loads", async () => {
    const spy = vi
      .spyOn(ConnectionsService, "listRequestableScopes")
      .mockResolvedValue(sampleCatalog());

    render(
      <ConnectScopeRequestDialog
        open
        onOpenChange={() => {}}
        personName="Akshat Kumar"
        getIdToken={() => Promise.resolve("test-token")}
        onConfirm={() => {}}
      />,
    );

    expect(await screen.findByText("Email")).toBeInTheDocument();
    expect(screen.queryByText(/Loading data options/i)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a recoverable error without retry-storming on failure", async () => {
    const spy = vi
      .spyOn(ConnectionsService, "listRequestableScopes")
      .mockRejectedValue(new Error("catalog unavailable"));

    render(
      <ConnectScopeRequestDialog
        open
        onOpenChange={() => {}}
        personName="Akshat Kumar"
        getIdToken={() => Promise.resolve("test-token")}
        onConfirm={() => {}}
      />,
    );

    expect(
      await screen.findByText(/You can still connect without requesting data/i),
    ).toBeInTheDocument();
    // A single failed attempt must not loop.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
