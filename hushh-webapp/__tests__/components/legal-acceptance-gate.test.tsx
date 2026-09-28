// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiJsonMock, authState, pathnameState, nativePlatform } = vi.hoisted(() => ({
  apiJsonMock: vi.fn(),
  authState: {
    current: {
      user: null as { uid: string; getIdToken: () => Promise<string> } | null,
      loading: false,
    },
  },
  pathnameState: { current: "/one" },
  nativePlatform: { current: false },
}));

vi.mock("next/navigation", () => ({ usePathname: () => pathnameState.current }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => authState.current }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform.current },
}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: apiJsonMock }));
vi.mock("@/components/onboarding/AuthLegalDialog", () => ({
  AuthLegalDialog: () => null,
}));

import { LegalAcceptanceGate } from "@/components/onboarding/LegalAcceptanceGate";
import {
  currentLegalDocumentVersions,
  LegalAcceptanceService,
  resolveLegalAcceptanceRequirement,
  type LegalAcceptanceRecord,
} from "@/lib/services/legal-acceptance-service";

function accepted(overrides: Partial<LegalAcceptanceRecord> = {}): LegalAcceptanceRecord[] {
  return currentLegalDocumentVersions().map((document) => ({
    ...document,
    accepted_at: "2026-09-01T00:00:00Z",
    surface: "web",
    ...overrides,
  }));
}

function user(uid: string) {
  return { uid, getIdToken: vi.fn().mockResolvedValue(`token-${uid}`) };
}

describe("resolveLegalAcceptanceRequirement", () => {
  it("asks first, accepts the served versions, and re-asks when a version changes", () => {
    expect(resolveLegalAcceptanceRequirement({ acceptances: [] })).toBe("first_acceptance");
    expect(resolveLegalAcceptanceRequirement({ acceptances: accepted() })).toBe("none");
    expect(
      resolveLegalAcceptanceRequirement({
        acceptances: accepted({ document_version: "an older version" }),
      }),
    ).toBe("updated");
    expect(
      resolveLegalAcceptanceRequirement({
        acceptances: accepted().filter((record) => record.document_id === "terms"),
      }),
    ).toBe("first_acceptance");
  });
});

describe("LegalAcceptanceGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathnameState.current = "/one";
    nativePlatform.current = false;
  });

  it("re-prompts on an older stored version and records the served versions on Agree", async () => {
    authState.current = { user: user("user-old"), loading: false };
    apiJsonMock.mockImplementation(async (_path: string, init: RequestInit) =>
      init.method === "GET"
        ? { acceptances: accepted({ effective_date: "January 2020" }) }
        : { acceptances: accepted() },
    );

    render(<LegalAcceptanceGate />);
    expect(await screen.findByText("We updated our Terms and Privacy Policy")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Agree" }));
    await waitFor(() =>
      expect(screen.queryByText("We updated our Terms and Privacy Policy")).toBeNull(),
    );
    const post = apiJsonMock.mock.calls.find(([, init]) => init.method === "POST");
    expect(post?.[0]).toBe("/api/account/legal-acceptance");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      documents: currentLegalDocumentVersions(),
      surface: "web",
    });
    expect(post?.[1].headers).toMatchObject({ Authorization: "Bearer token-user-old" });
  });

  it("does not prompt after sign-in recorded the agreement first", async () => {
    const order: string[] = [];
    let stored: LegalAcceptanceRecord[] = [];
    apiJsonMock.mockImplementation(async (_path: string, init: RequestInit) => {
      order.push(String(init.method));
      if (init.method === "POST") stored = accepted({ surface: "native" });
      return { acceptances: stored };
    });
    nativePlatform.current = true;
    const signedIn = user("user-new");
    void LegalAcceptanceService.recordSignInAcceptance(signedIn, true);
    authState.current = { user: signedIn, loading: false };

    render(<LegalAcceptanceGate />);
    await waitFor(() => expect(order).toEqual(["POST", "GET"]));
    expect(screen.queryByRole("dialog")).toBeNull();
    const post = apiJsonMock.mock.calls.find(([, init]) => init.method === "POST");
    expect(JSON.parse(String(post?.[1].body)).surface).toBe("native");
  });

  it("does not record agreement for automated reviewer authentication", async () => {
    const signedIn = user("synthetic-reviewer");
    await LegalAcceptanceService.recordSignInAcceptance(signedIn, false);
    await LegalAcceptanceService.waitForSignInRecord(signedIn.uid);
    expect(apiJsonMock).not.toHaveBeenCalled();
    expect(signedIn.getIdToken).not.toHaveBeenCalled();
  });

  it("never blocks the app when the record cannot be read", async () => {
    authState.current = { user: user("user-offline"), loading: false };
    apiJsonMock.mockRejectedValue(new Error("offline"));

    render(<LegalAcceptanceGate />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays silent on public routes", async () => {
    authState.current = { user: user("user-public"), loading: false };
    pathnameState.current = "/delete-account";
    apiJsonMock.mockResolvedValue({ acceptances: [] });

    render(<LegalAcceptanceGate />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiJsonMock).not.toHaveBeenCalled();
  });
});
