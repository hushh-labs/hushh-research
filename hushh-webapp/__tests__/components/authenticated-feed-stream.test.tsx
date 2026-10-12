import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { user: { uid: "owner" }, loading: true, sessionVerificationRequired: false },
  useStream: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => state.auth }));
vi.mock("@/lib/feed/use-document-feed-stream", () => ({ useDocumentFeedStream: state.useStream }));
import { AuthenticatedFeedStream } from "@/components/feed/authenticated-feed-stream";

it("keeps the stream app-owned and gates it while authentication needs verification", () => {
  const view = render(<AuthenticatedFeedStream />);
  expect(state.useStream).toHaveBeenLastCalledWith(null);
  state.auth.loading = false;
  view.rerender(<AuthenticatedFeedStream />);
  expect(state.useStream).toHaveBeenLastCalledWith(state.auth.user);
  state.auth.sessionVerificationRequired = true;
  view.rerender(<AuthenticatedFeedStream />);
  expect(state.useStream).toHaveBeenLastCalledWith(null);
});
