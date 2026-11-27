import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validNativeWorkspace, type NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";

const native = vi.hoisted(() => ({ enabled: false, content: null as unknown, actions: new Map() }));
const push = vi.fn();
const navigateToAgentChat = vi.hoisted(() => vi.fn());
const createHandoff = vi.hoisted(() => vi.fn());
let connected = false;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/one/email",
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "user-1",
    user: { uid: "user-1", email: "owner@example.com", getIdToken: vi.fn() },
    loading: false,
  }),
}));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat,
}));

vi.mock("@/lib/agent/one-conversation-session", () => ({
  useOneConversationSession: (selector: (state: { createHandoff: typeof createHandoff }) => unknown) =>
    selector({ createHandoff }),
}));

vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    loadingStatus: false,
    presentation: { isConnected: connected },
  }),
}));

vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => native.enabled }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true }) }));
vi.mock("@/lib/capacitor/use-native-workspace", () => ({
  useNativeWorkspacePresentation: () => ({ owner: {}, status: { phase: "native", reason: "active", held: true }, retireForWeb: vi.fn() }),
  useNativeWorkspace: (value: { content: unknown; actions: Map<string, () => unknown> }) => { native.content = value.content; native.actions = value.actions; return "native"; },
}));

import { EmailAgentPageClient } from "@/app/one/email/email-agent-page-client";

describe("EmailAgentPageClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.enabled = false; native.content = null;
  });
  it("offers the canonical Gmail workspace when Gmail is disconnected", () => {
    connected = false;
    render(<EmailAgentPageClient />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Mail" }));

    expect(push).toHaveBeenCalledWith("/one/gmail");
    expect(screen.getByRole("heading", { name: "Connect Mail" })).toBeTruthy();
  });

  it("opens an empty One composer without starting an unrequested mail turn", () => {
    connected = true;
    render(<EmailAgentPageClient />);

    expect(screen.getByText("Mail connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask One about Mail" }));

    expect(navigateToAgentChat).toHaveBeenCalledWith();
    expect(createHandoff).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps the native Mail action connected to the existing empty-composer/navigation behavior (connected=%s)", async active => {
    native.enabled = true; connected = active;
    render(<EmailAgentPageClient />);
    const content = native.content as NativeWorkspaceProjection;
    const projection: NativeWorkspaceProjection = { documentId: "document", ownerEpoch: "owner", ownerGeneration: 1, revision: 1,
      updateSequence: 1, privacyGeneration: 0, isolationGeneration: 0, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111",
      frame: { x: 0, y: 100, width: 390, height: 500, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1 }, ...content };
    expect(validNativeWorkspace(projection)).toBe(true);
    const action = content.sections.find(section => section.id === "email-action")!.rows[0]!;
    await act(async () => { native.actions.get(action.id)!(); });
    if (active) expect(navigateToAgentChat).toHaveBeenCalledWith();
    else expect(push).toHaveBeenCalledWith("/one/gmail");
    expect(createHandoff).not.toHaveBeenCalled();
  });

});
