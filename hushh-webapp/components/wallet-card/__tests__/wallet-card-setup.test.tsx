import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { WalletCardSetup } from "@/components/wallet-card/wallet-card-setup";
import {
  EMPTY_WALLET_CARD_DRAFT,
  type WalletCardDraft,
  type WalletCardValidationErrors,
} from "@/components/wallet-card/wallet-card-fields";

function renderSetup({
  initialDraft,
  errors = {},
  isEditingExisting = false,
}: {
  initialDraft?: Partial<WalletCardDraft>;
  errors?: WalletCardValidationErrors;
  isEditingExisting?: boolean;
} = {}) {
  const onChangeSpy = vi.fn();
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  function Harness() {
    const [draft, setDraft] = useState<WalletCardDraft>({
      ...EMPTY_WALLET_CARD_DRAFT,
      fullName: "Ankit Kumar Singh",
      email: "ankit@example.com",
      ...initialDraft,
    });

    return (
      <WalletCardSetup
        draft={draft}
        errors={errors}
        avatarUrl="https://example.com/avatar.jpg"
        saving={false}
        isEditingExisting={isEditingExisting}
        onChange={(key, value) => {
          onChangeSpy(key, value);
          setDraft((current) => ({ ...current, [key]: value }));
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );
  }

  render(<Harness />);

  return { onCancel, onChangeSpy, onSubmit };
}

describe("WalletCardSetup", () => {
  it("removes repeated setup copy and renders one continuous shared-information form", () => {
    renderSetup();

    expect(
      screen.getByRole("heading", { name: "Shared information" }),
    ).toBeVisible();
    expect(screen.queryByText("Shared by default")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Only this information will be shared."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Choose what people can see"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Continue to preview")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create profile" }),
    ).toBeVisible();
  });

  it("renders an editable LinkedIn input immediately when LinkedIn is primary", () => {
    const { onChangeSpy } = renderSetup({
      initialDraft: { preferredContact: "linkedin" },
      errors: {
        preferredContact:
          "Add a linkedin or pick a different preferred contact.",
      },
    });

    const input = screen.getByLabelText("LinkedIn profile");

    expect(input).toBeVisible();
    expect(input).not.toHaveAttribute("readonly");
    expect(input).toHaveAttribute("type", "url");
    expect(input).toHaveAttribute("inputmode", "url");
    expect(input).toHaveAttribute("autocomplete", "url");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");

    fireEvent.change(input, { target: { value: "h" } });

    expect(onChangeSpy).toHaveBeenCalledWith("linkedin", "h");
    expect(input).toHaveValue("h");
  });

  it("keeps LinkedIn value while switching contact methods", () => {
    renderSetup({ initialDraft: { preferredContact: "linkedin" } });

    const linkedinInput = screen.getByLabelText("LinkedIn profile");
    fireEvent.change(linkedinInput, {
      target: { value: "https://www.linkedin.com/in/ankit" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Email" }));
    fireEvent.click(screen.getByRole("tab", { name: "LinkedIn" }));

    expect(screen.getByLabelText("LinkedIn profile")).toHaveValue(
      "https://www.linkedin.com/in/ankit",
    );
  });

  it("renders one editable Public link input when Link is primary", () => {
    const { onChangeSpy } = renderSetup({
      initialDraft: { preferredContact: "website" },
    });

    const input = screen.getByLabelText("Public link");

    expect(input).toBeVisible();
    expect(input).toHaveAttribute("type", "url");

    fireEvent.change(input, { target: { value: "https://one.hushh.ai" } });
    expect(onChangeSpy).toHaveBeenCalledWith("website", "https://one.hushh.ai");

    fireEvent.click(screen.getByRole("button", { name: /More details/i }));
    expect(screen.getAllByLabelText("Public link")).toHaveLength(1);
  });

  it("keeps non-primary contact fields in More details and excludes the selected primary field", () => {
    renderSetup({
      initialDraft: {
        preferredContact: "linkedin",
        phone: "+91 99999 90000",
        website: "https://hushh.ai",
      },
    });

    expect(screen.getByRole("button", { name: /3 added/i })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /More details/i }));

    expect(screen.getByLabelText("Email")).toBeVisible();
    expect(screen.getByLabelText("Phone")).toBeVisible();
    expect(screen.getByLabelText("Public link")).toBeVisible();
    expect(screen.getAllByLabelText("LinkedIn profile")).toHaveLength(1);
  });

  it("opens More details when an optional field has an error", () => {
    renderSetup({
      errors: { portfolio: "Use a full https:// link." },
    });

    expect(screen.getByLabelText("Portfolio")).toBeVisible();
    expect(screen.getByText("Use a full https:// link.")).toBeVisible();
  });

  it("uses the edit completion label for an existing Wallet Profile", () => {
    renderSetup({ isEditingExisting: true });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create profile" }),
    ).not.toBeInTheDocument();
  });
});
