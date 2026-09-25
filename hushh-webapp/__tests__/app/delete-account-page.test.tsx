import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DeleteAccountPage from "@/app/delete-account/page";
import { CONTACTS_PRIVACY_DISCLOSURE } from "@/components/one-location/onboarding/one-location-onboarding-flow";
import {
  ROUTES,
  isOnboardingAdmissionExemptRoute,
  isPublicRoute,
} from "@/lib/navigation/routes";

const REPO = path.resolve(__dirname, "../..");

describe("Public account deletion page (Google Play Delete account URL)", () => {
  it("is reachable without signing in or finishing setup", () => {
    expect(ROUTES.DELETE_ACCOUNT).toBe("/delete-account");
    expect(isPublicRoute(ROUTES.DELETE_ACCOUNT)).toBe(true);
    expect(isOnboardingAdmissionExemptRoute(ROUTES.DELETE_ACCOUNT)).toBe(true);
  });

  it("gives in-app steps and a verified request path, and deletes nothing itself", () => {
    const { container } = render(<DeleteAccountPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Delete your account" }),
    ).toBeTruthy();
    expect(screen.getByText(/Tap Delete account/)).toBeTruthy();

    const request = screen.getByRole("link", { name: "support@hushh.ai" });
    expect(request.getAttribute("href")).toBe(
      "mailto:support@hushh.ai?subject=Delete%20my%20Hussh%20One%20account",
    );
    expect(screen.getByText(/we confirm the request came from the account owner/)).toBeTruthy();
    expect(screen.getByText(/never ask for your password, your vault passphrase/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What we may keep" })).toBeTruthy();

    // No self-service deletion without authentication.
    expect(container.querySelector("form, input, button")).toBeNull();
  });
});

describe("Android contacts disclosure", () => {
  it("shows the same privacy statement natively as in onboarding", () => {
    const strings = readFileSync(
      path.join(REPO, "android/app/src/main/res/values/strings.xml"),
      "utf8",
    );
    const message = strings.match(
      /<string name="contacts_disclosure_message">([\s\S]*?)<\/string>/,
    )?.[1];
    expect(message?.replace(/\\'/g, "'")).toContain(CONTACTS_PRIVACY_DISCLOSURE);

    const plugin = readFileSync(
      path.join(
        REPO,
        "android/app/src/main/java/com/hussh/app/plugins/HushhContacts/HushhContactsPlugin.kt",
      ),
      "utf8",
    );
    // Every READ_CONTACTS request goes through the disclosure gate.
    const directRequests = plugin.match(/requestPermissionForAlias\("contacts"/g) ?? [];
    const gate = plugin.slice(plugin.indexOf("private fun requestContactsWithDisclosure"));
    expect(directRequests.length).toBe(
      (gate.match(/requestPermissionForAlias\("contacts"/g) ?? []).length,
    );
  });
});
