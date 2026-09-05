// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/services/ria-service", () => ({
  CONTACT_SYNC_CONSENT_CONTRACT_VERSION: "contact_find_auto_connect_v1",
  CONTACT_SYNC_MATCH_POLICY_VERSION: "contact_directory_auto_connect_v2",
  RiaService: {
    getContactDiscoverability: mocks.getPreference,
    setContactDiscoverability: mocks.setPreference,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { ContactDiscoverabilityConsentDialog } from "@/components/connections/contact-discoverability-consent-dialog";
import { useContactDiscoverabilityConsent } from "@/lib/contacts/use-contact-discoverability-consent";

function userIdFromToken(token: string): string {
  return token.replace(/^token-/, "");
}

function preference(userId: string, enabled: boolean, ruleVersion: number) {
  const isDefault = ruleVersion === 0;
  return {
    user_id: userId,
    contact_discoverable: isDefault ? true : enabled,
    stored_contact_discoverable: enabled,
    contact_sync_consent_enabled_at: enabled ? "2026-09-04T10:00:00Z" : null,
    contact_sync_consent_rule_version: ruleVersion,
    contact_sync_consent_contract_version: enabled
      ? "contact_find_auto_connect_v1"
      : null,
    contact_sync_preference_state: isDefault
      ? "default"
      : enabled
        ? "enabled"
        : "disabled",
    contact_sync_match_policy_version: "contact_directory_auto_connect_v2",
    directory_visible: true,
    iam_schema_ready: true,
  };
}

function invalidPreference(userId: string) {
  return {
    ...preference(userId, true, 4),
    contact_discoverable: false,
    contact_sync_preference_state: "invalid",
    contact_sync_consent_contract_version: "findability_only_v0",
  };
}

function Harness({
  userId,
  onCheck,
  children,
}: {
  userId: string;
  onCheck: () => void;
  children?: ReactNode;
}) {
  const consent = useContactDiscoverabilityConsent({
    userId,
    getIdToken: async () => `token-${userId}`,
    actionLabel: "Find contacts",
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (consent.requestContactCheck()) onCheck();
        }}
      >
        Find contacts
      </button>
      <output
        data-testid="preference-state"
        data-status={consent.preference.status}
        data-enabled={String(consent.preference.enabled)}
        data-rule-version={String(consent.preference.ruleVersion)}
      />
      {children}
      <ContactDiscoverabilityConsentDialog {...consent.dialogProps} />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPreference.mockImplementation(async (token: string) =>
    preference(userIdFromToken(token), false, 0),
  );
  mocks.setPreference.mockImplementation(
    async (token: string, enabled: boolean) =>
      preference(userIdFromToken(token), enabled, 1),
  );
});

describe("useContactDiscoverabilityConsent", () => {
  it("uses the verified-directory default without consuming the first contact tap", async () => {
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "decided",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Choose your contact privacy" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["missing policy", { contact_sync_match_policy_version: undefined }],
    ["stale policy", { contact_sync_match_policy_version: "legacy_policy" }],
    ["schema unavailable", { iam_schema_ready: false }],
  ])("requires a privacy decision when directory defaults have %s", async (_label, override) => {
    mocks.getPreference.mockResolvedValue({
      ...preference("user_a", false, 0),
      ...override,
    });
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute("data-status", "undecided"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(onCheck).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Choose your contact privacy" })).toBeInTheDocument();
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it("lets a hidden directory account check its own contacts without making it discoverable", async () => {
    mocks.getPreference.mockResolvedValue({
      ...preference("user_a", false, 0),
      contact_discoverable: false,
      directory_visible: false,
    });
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute("data-status", "decided"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("preference-state")).toHaveAttribute("data-enabled", "false");
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it("accepts a stored opt-in even while directory visibility keeps it ineffective", async () => {
    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    mocks.setPreference.mockResolvedValue({
      ...preference("user_a", true, 5),
      contact_discoverable: false,
      directory_visible: false,
    });
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Allow contact matching" }));

    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute("data-status", "decided"),
    );
    expect(mocks.setPreference).toHaveBeenCalledWith("token-user_a", true);
    expect(screen.getByTestId("preference-state")).toHaveAttribute("data-enabled", "false");
    expect(screen.queryByRole("heading", { name: "Choose your contact privacy" })).not.toBeInTheDocument();
    expect(onCheck).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("records keep-private and requires a fresh contact tap", async () => {
    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep private" }),
    );

    await waitFor(() =>
      expect(mocks.setPreference).toHaveBeenCalledWith("token-user_a", false),
    );
    expect(onCheck).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Choose your contact privacy" }),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("records opt-in but never infers the contact check from that decision", async () => {
    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow contact matching" }),
    );

    await waitFor(() =>
      expect(mocks.setPreference).toHaveBeenCalledWith("token-user_a", true),
    );
    expect(onCheck).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Contact matching is on. Tap Find contacts again to check your contacts.",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it("respects a previously recorded disabled decision without prompting again", async () => {
    mocks.getPreference.mockResolvedValue(preference("user_a", false, 4));
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "decided",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Choose your contact privacy" }),
    ).not.toBeInTheDocument();
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it("requires a fresh decision when an enabled consent contract is stale", async () => {
    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "undecided",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));

    expect(onCheck).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", {
        name: "Choose your contact privacy",
      }),
    ).toBeInTheDocument();
  });

  it("fails closed when the preference read fails and offers an explicit retry", async () => {
    mocks.getPreference.mockRejectedValue(
      new Error("Privacy service offline."),
    );
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "error",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Privacy service offline.",
    );
    expect(onCheck).not.toHaveBeenCalled();

    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("button", { name: "Allow contact matching" }),
    ).toBeInTheDocument();
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("keeps the first-use dialog open when saving fails and lets the person retry", async () => {
    mocks.getPreference.mockResolvedValue(invalidPreference("user_a"));
    mocks.setPreference
      .mockRejectedValueOnce(new Error("Could not save the choice."))
      .mockImplementationOnce(async (token: string, enabled: boolean) =>
        preference(userIdFromToken(token), enabled, 1),
      );
    const onCheck = vi.fn();
    render(<Harness userId="user_a" onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    const allow = await screen.findByRole("button", {
      name: "Allow contact matching",
    });
    fireEvent.click(allow);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the choice.",
    );
    expect(onCheck).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Allow contact matching" }),
    );
    await waitFor(() => expect(mocks.setPreference).toHaveBeenCalledTimes(2));
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("clears a pending dialog and ignores its save result on account switch", async () => {
    mocks.getPreference.mockImplementation(async (token: string) => {
      const userId = userIdFromToken(token);
      return userId === "user_a"
        ? invalidPreference(userId)
        : preference(userId, false, 0);
    });
    let resolveSave: ((value: ReturnType<typeof preference>) => void) | null =
      null;
    mocks.setPreference.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onCheck = vi.fn();
    const view = render(<Harness userId="user_a" onCheck={onCheck} />);
    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "undecided",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Find contacts" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow contact matching" }),
    );

    view.rerender(<Harness userId="user_b" onCheck={onCheck} />);
    expect(
      screen.queryByRole("heading", { name: "Choose your contact privacy" }),
    ).not.toBeInTheDocument();
    resolveSave?.(preference("user_a", true, 1));

    await waitFor(() =>
      expect(screen.getByTestId("preference-state")).toHaveAttribute(
        "data-status",
        "decided",
      ),
    );
    expect(screen.getByTestId("preference-state")).toHaveAttribute(
      "data-enabled",
      "true",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
