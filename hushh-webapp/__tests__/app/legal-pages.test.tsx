import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PrivacyPolicyPage from "@/app/privacy/page";
import TermsOfUsePage from "@/app/terms/page";
import { buildProfileLegalStackEntries } from "@/components/profile/profile-legal-section";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import {
  LEGAL_DOCUMENTS,
  type LegalDocument,
} from "@/lib/legal/legal-documents";
import {
  ROUTES,
  isOnboardingAdmissionExemptRoute,
  isPublicRoute,
} from "@/lib/navigation/routes";

const REPO = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");

const plainText = (doc: LegalDocument) =>
  doc.sections
    .flatMap((section) => [
      section.title,
      ...section.blocks.flatMap((block) => {
        if (block.kind === "h") return [block.text];
        const lines = block.kind === "p" ? [block.text] : block.items;
        return lines.flat().map((part) =>
          typeof part === "string" ? part : part.text,
        );
      }),
    ])
    .join("\n");

// /privacy and /terms are the URLs given to the Google OAuth consent screen and
// the store listings, and the documents a person agrees to at sign-in. They
// must render signed out, and sign-in and Profile must reach them.
describe("Privacy Policy and Terms of Use pages", () => {
  it("are public and never held behind sign-in or setup", () => {
    expect(ROUTES.PRIVACY).toBe("/privacy");
    expect(ROUTES.TERMS).toBe("/terms");
    for (const route of [ROUTES.PRIVACY, ROUTES.TERMS]) {
      expect(isPublicRoute(route)).toBe(true);
      expect(isOnboardingAdmissionExemptRoute(route)).toBe(true);
    }
  });

  it("render the versioned, dated documents", () => {
    for (const [Page, doc] of [
      [PrivacyPolicyPage, LEGAL_DOCUMENTS.privacy],
      [TermsOfUsePage, LEGAL_DOCUMENTS.terms],
    ] as const) {
      const { unmount } = render(<Page />);
      expect(
        screen.getByRole("heading", { level: 1, name: doc.title }),
      ).toBeTruthy();
      expect(
        screen.getAllByText(
          `Effective ${doc.lastUpdatedLabel} · Version ${doc.version}`,
        ).length,
      ).toBeGreaterThan(0);
      expect(doc.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      unmount();
    }
  });

  it("carries Google's Limited Use disclosure for restricted Gmail and Drive scopes", () => {
    render(<PrivacyPolicyPage />);
    const section = screen
      .getByRole("heading", {
        name: "Google API Services User Data Policy: Limited Use",
      })
      .closest("section") as HTMLElement;
    const policyLink = within(section).getByRole("link", {
      name: "Google API Services User Data Policy",
    });
    expect(policyLink.getAttribute("href")).toBe(
      "https://developers.google.com/terms/api-services-user-data-policy",
    );
    expect(section.textContent).toContain(
      "including the Limited Use requirements",
    );
    expect(section.textContent).toContain(
      "develop, improve, or train generalized AI or machine learning models",
    );
    expect(section.textContent).toContain("only after obtaining your explicit prior consent");
    expect(plainText(LEGAL_DOCUMENTS.privacy)).toContain(
      "Information received from Google APIs will be transferred as part of such a transaction only after obtaining your explicit prior consent.",
    );
  });

  it("identifies the canonical application and retained addresses without promising all processing is offline", () => {
    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(plainText(doc)).toContain("one.hussh.si");
      expect(plainText(doc)).toContain("one.hussh.ai");
      expect(plainText(doc)).toContain("one.hushh.ai");
    }
    const privacy = plainText(LEGAL_DOCUMENTS.privacy);
    expect(privacy).toContain("This indexing step loads its model files locally");
    expect(privacy).toContain("relevant passages may still be sent to your selected AI service");
  });

  it("describe One as a private agent, with Kai as one feature among many", () => {
    const privacyIds = LEGAL_DOCUMENTS.privacy.sections.map((s) => s.id);
    for (const id of [
      "vault-and-chats",
      "ai-models",
      "kai",
      "location",
      "google-services",
      "your-connectors",
      "banks-plaid",
      "sharing-with-people",
      "retention-and-deletion",
      "us-state-privacy",
      "children",
      "international",
    ]) {
      expect(privacyIds).toContain(id);
    }
    const termsIds = LEGAL_DOCUMENTS.terms.sections.map((s) => s.id);
    expect(termsIds).toContain("emergency-alerts");
    expect(termsIds).toContain("not-professional-advice");

    for (const doc of Object.values(LEGAL_DOCUMENTS)) {
      expect(doc.title).not.toMatch(/Kai/);
      expect(doc.summary).toContain("private agent");
      // Kai is named only as the investing feature, never as the product.
      expect(plainText(doc)).not.toMatch(/Agent Kai|Kai app|Kai\u2019s (Privacy|Terms)/);
    }
    expect(() => read("lib/legal/kai-legal-content.ts")).toThrow();
  });

  // The policy once offered bring-your-own-key for providers the app had not
  // shipped. A provider the in-app catalog marks coming_soon is not a choice a
  // person can make, so the policy must not describe it as one.
  it("names only model providers a person can actually choose", () => {
    const privacy = plainText(LEGAL_DOCUMENTS.privacy);
    const available = RUNTIME_PROVIDER_CATALOG.filter(
      (p) => p.availability === "available",
    );
    expect(available.map((p) => p.id)).toContain("gemini");
    expect(privacy).toContain("Gemini");
    // Azure OpenAI is the model inside a person's own Azure subscription (the
    // owner-cloud home), not the bring-your-own-key OpenAI provider. It may be
    // named only in that conditional sentence; any other mention still fails.
    const azureHome =
      "If you run your private agent in your own Microsoft Azure subscription, it can answer you with an Azure OpenAI model deployed in that subscription.";
    expect(privacy).toContain(azureHome);
    const outsideAzureHome = privacy.replace(azureHome, "");
    expect(outsideAzureHome).not.toContain("Azure OpenAI");
    for (const provider of RUNTIME_PROVIDER_CATALOG) {
      if (provider.availability === "available") continue;
      expect(outsideAzureHome).not.toContain(provider.name);
    }
  });

  it("discloses the separate Azure/Bing research opt-in and Bing privacy boundary", () => {
    const privacy = LEGAL_DOCUMENTS.privacy;
    const text = plainText(privacy);
    expect(privacy.version).toBe("2.12");
    expect(privacy.lastUpdated).toBe("2026-10-24");
    expect(text).toContain("Hussh selects Microsoft Azure AI or Google Gemini as the primary processor");
    expect(text).toContain("before any output");
    expect(text).toContain("No model-settings toggle or personal pilot approval is required or created");
    expect(text).toContain("Current file access, owner consent, payment requirements and sharing permissions still apply");
    expect(text).toContain("an earlier Google research setting does not authorize Microsoft research");
    expect(text).toContain("GPT-5-mini on Microsoft Azure AI receives your name");
    expect(text).toContain("GPT-5 mini also plans follow-up searches from received public profile labels and source URLs");
    expect(text).toContain("Bing web search receives search terms that may include your name");
    expect(text).toContain("outside Azure's compliance and data residency boundary");
    expect(text).toContain("You review every suggested detail before it is saved");
    expect(LEGAL_DOCUMENTS.terms.version).toBe("2.4");
    expect(LEGAL_DOCUMENTS.terms.lastUpdated).toBe("2026-10-16");
    render(<TermsOfUsePage />);
    expect(screen.getByRole("link", { name: "Microsoft Privacy Statement" })).toHaveAttribute(
      "href", "https://privacy.microsoft.com/en-us/privacystatement",
    );
  });

  it("discloses private Azure scope and revocation separately from public research", () => {
    const privacy = plainText(LEGAL_DOCUMENTS.privacy);
    expect(privacy).toContain("No model-settings toggle or personal pilot approval is required or created");
    expect(privacy).toContain("relevant conversation history and memories");
    expect(privacy).toContain("request purposes and relevant document text");
    expect(privacy).toContain("Current file access, owner consent, payment requirements and sharing permissions still apply");
    expect(privacy).toContain("Native Google Search, public research, voice and your own-key settings have separate provider behavior");
  });

  it("does not promise automatic expiry for manually created backups", () => {
    const privacy = plainText(LEGAL_DOCUMENTS.privacy);
    expect(privacy).toContain("Manually created backups may remain until an authorized operator deletes them.");
    expect(privacy).not.toContain("Database backups, which expire on their own schedule.");
  });

  it("are reachable from sign-in as plain links, never an in-app popup", () => {
    const auth = read("components/onboarding/AuthStep.tsx");
    expect(auth).toContain("href={ROUTES.TERMS}");
    expect(auth).toContain("href={ROUTES.PRIVACY}");
    // The inline sign-in sheet is gone; the pages are the only presentation.
    expect(existsSync(path.join(REPO, "components/onboarding/AuthLegalDialog.tsx"))).toBe(false);
  });

  it("never re-prompt a signed-in person to accept them", () => {
    // Acceptance is the sign-in agreement, recorded silently at sign-in. There
    // is no app-wide acceptance dialog mounted over signed-in screens.
    expect(
      existsSync(path.join(REPO, "components/onboarding/LegalAcceptanceGate.tsx")),
    ).toBe(false);
    expect(read("app/providers.tsx")).not.toContain("LegalAcceptanceGate");
    const auth = read("components/onboarding/AuthStep.tsx");
    expect(auth).toContain("LegalAcceptanceService.recordSignInAcceptance(");
  });

  // Profile reads them in place in its Legal section; it never leaves the
  // pane for the public page (founder, 2026-10-02).
  it("are read in place from Profile, never by leaving for the public page", () => {
    const updateView = vi.fn();
    const [section] = buildProfileLegalStackEntries({ detail: null, updateView });
    const { unmount } = render(section.content);
    for (const detail of ["privacy", "terms"] as const) {
      fireEvent.click(screen.getByRole("button", { name: LEGAL_DOCUMENTS[detail].title }));
      expect(updateView).toHaveBeenLastCalledWith({ panel: "legal", detail }, "push");
    }
    expect(updateView).toHaveBeenCalledTimes(2);
    unmount();

    const reader = buildProfileLegalStackEntries({ detail: "privacy", updateView }).at(-1)!;
    render(reader.content);
    fireEvent.click(screen.getByRole("button", { name: LEGAL_DOCUMENTS.terms.title }));
    expect(updateView).toHaveBeenLastCalledWith({ panel: "legal", detail: "terms" }, "replace");
    const profile = read("components/profile/profile-workspace-page.tsx");
    expect(profile).not.toContain("router.push(ROUTES.PRIVACY)");
    expect(profile).not.toContain("router.push(ROUTES.TERMS)");
  });
});
