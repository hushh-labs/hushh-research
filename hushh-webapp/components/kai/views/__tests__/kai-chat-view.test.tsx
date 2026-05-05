/**
 * Unit tests for KaiChatView — Issue #595
 *
 * Mocks: kai-service, useVault, auth-service, next/navigation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { KaiChatView } from "@/components/kai/views/kai-chat-view";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "fake-vault-token" }),
}));

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: { uid: "test-user-123" } }),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetInitialChatState = vi.fn();
const mockChat = vi.fn();
const mockSetKaiVaultOwnerToken = vi.fn();

vi.mock("@/lib/services/kai-service", () => ({
  setKaiVaultOwnerToken: (...args: any[]) => mockSetKaiVaultOwnerToken(...args),
  getInitialChatState: (...args: any[]) => mockGetInitialChatState(...args),
  chat: (...args: any[]) => mockChat(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const newUserInitialState = {
  isNewUser: true,
  hasPortfolio: false,
  hasFinancialData: false,
  welcomeType: "new",
  totalAttributes: 0,
  availableDomains: [],
};

const returningUserInitialState = {
  isNewUser: false,
  hasPortfolio: true,
  hasFinancialData: true,
  welcomeType: "returning",
  totalAttributes: 5,
  availableDomains: ["financial", "risk"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KaiChatView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetKaiVaultOwnerToken.mockImplementation(() => {});
  });

  it("renders the new-user welcome message and import-prompt card", async () => {
    mockGetInitialChatState.mockResolvedValueOnce(newUserInitialState);

    render(<KaiChatView />);

    await waitFor(() => {
      expect(
        screen.getByText(/Hi, I'm Kai/i)
      ).toBeDefined();
    });

    // Import prompt card should appear
    expect(screen.getByText(/Import your portfolio/i)).toBeDefined();
  });

  it("renders returning user welcome message without import card", async () => {
    mockGetInitialChatState.mockResolvedValueOnce(returningUserInitialState);

    render(<KaiChatView />);

    await waitFor(() => {
      expect(screen.getByText(/Welcome back\. Ask me anything/i)).toBeDefined();
    });

    // No import card for returning user with portfolio
    expect(screen.queryByText(/Import your portfolio/i)).toBeNull();
  });

  it("sends a message and appends user + kai bubbles", async () => {
    mockGetInitialChatState.mockResolvedValueOnce(returningUserInitialState);
    mockChat.mockResolvedValueOnce({
      response: "AAPL looks bullish based on your risk profile.",
      conversationId: "conv-abc",
      componentType: null,
      componentData: null,
      learnedAttributes: [],
      tokensUsed: 120,
      timestamp: new Date().toISOString(),
    });

    render(<KaiChatView />);

    await waitFor(() => screen.getByText(/Welcome back/i));

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Should I buy AAPL?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // User bubble appears immediately
    await waitFor(() =>
      expect(screen.getByText("Should I buy AAPL?")).toBeDefined()
    );

    // Kai response appears after promise resolves
    await waitFor(() =>
      expect(
        screen.getByText("AAPL looks bullish based on your risk profile.")
      ).toBeDefined()
    );
  });

  it("shows error and restores input when chat() throws", async () => {
    mockGetInitialChatState.mockResolvedValueOnce(returningUserInitialState);
    mockChat.mockRejectedValueOnce(new Error("Backend unreachable"));

    render(<KaiChatView />);

    await waitFor(() => screen.getByText(/Welcome back/i));

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "analyze TSLA" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(screen.getByText(/Backend unreachable/i)).toBeDefined()
    );

    // Input should be restored with the failed message
    expect((textarea as HTMLTextAreaElement).value).toBe("analyze TSLA");
  });

  it("renders analysis_summary card and routes to /kai/analysis on click", async () => {
    mockGetInitialChatState.mockResolvedValueOnce(returningUserInitialState);
    mockChat.mockResolvedValueOnce({
      response: "Here's my AAPL analysis.",
      conversationId: "conv-xyz",
      componentType: "analysis_summary",
      componentData: { ticker: "AAPL", decision: "BUY", confidence: 0.82 },
      learnedAttributes: [],
      tokensUsed: 200,
      timestamp: new Date().toISOString(),
    });

    render(<KaiChatView />);

    await waitFor(() => screen.getByText(/Welcome back/i));

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "analyze AAPL" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Wait for analysis card to appear
    await waitFor(() => expect(screen.getByText("AAPL")).toBeDefined());
    expect(screen.getByText(/BUY · 82% confidence/i)).toBeDefined();

    // Click "Open analysis" button
    const openBtn = screen.getByText(/Open analysis/i);
    fireEvent.click(openBtn);

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("ticker=AAPL")
    );
  });
});
