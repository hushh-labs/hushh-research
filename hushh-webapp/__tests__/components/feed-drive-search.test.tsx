import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedDriveSearch } from "@/components/feed/feed-drive-search";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const m = vi.hoisted(() => ({ ready: true, valid: true, search: vi.fn(), open: vi.fn(), session: "owner:1" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
const capture = () => ({ vaultOwnerToken: "owner-token", isCurrent: () => m.valid && !document.hidden });
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({ useFinanceShareContext: () => ({ ready: m.ready, session: m.session, capture }) }));
vi.mock("@/lib/services/feed-file-search-service", () => ({ FeedFileSearchService: { search: m.search, open: m.open } }));
const match = { requestId: "11111111-1111-4111-8111-111111111111", fileRef: "bulk:22222222-2222-4222-8222-222222222222:1", audience: "requester", name: "Passport.pdf", status: "shared", openUrl: "https://drive.google.com/file/d/passport-file/view", recordedAt: "2026-11-20T07:00:00Z" };
const criteria = { query: "passport" }, count = vi.fn();

describe("private Feed filename results", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => { m.ready=true; m.valid=true; m.session="owner:1"; m.search.mockReset(); m.open.mockReset(); count.mockReset(); });
  it("continues an empty candidate page, opens the exact file after a fresh read, and Back keeps search", async () => {
    m.search.mockImplementation(async (_token, audience, _criteria, cursor) => audience === "requester"
      ? cursor ? { files: [match], nextCursor: null } : { files: [], nextCursor: "opaque" }
      : { files: [], nextCursor: null });
    m.open.mockResolvedValue(match);
    render(<FeedDriveSearch criteria={criteria} onCount={count} />);
    fireEvent.click(await screen.findByRole("button", { name: "More files" }));
    fireEvent.click(await screen.findByText("Passport.pdf"));
    expect(await screen.findByRole("link", { name: "Open file" })).toHaveAttribute("href", match.openUrl);
    expect(m.open).toHaveBeenCalledWith("owner-token", { audience: "requester", requestId: match.requestId, fileRef: match.fileRef });
    expect(screen.getByRole("link", { name: "View request" })).toHaveAttribute("href", expect.stringContaining("requestView=sent"));
    act(() => { expect(unwindBackLayer("/one/feed")).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Passport.pdf")).toBeVisible();
  });
  it("does not reuse an old file link after access is removed", async () => {
    m.search.mockImplementation(async (_token, audience) => ({ files: audience === "requester" ? [match] : [], nextCursor: null }));
    m.open.mockRejectedValue(new Error("No longer permitted"));
    render(<FeedDriveSearch criteria={criteria} onCount={count} />);
    fireEvent.click(await screen.findByText("Passport.pdf"));
    expect(await screen.findByText("File unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open file" })).not.toBeInTheDocument();
  });
  it("drops an in-flight private result when the vault locks and does not loop when count rerenders", async () => {
    let finish!: (value: unknown) => void;
    m.search.mockImplementation((_token, audience) => audience === "owner" ? Promise.resolve({ files: [], nextCursor: null }) : new Promise(resolve => { finish=resolve; }));
    const view = render(<FeedDriveSearch criteria={{ query: "passport" }} onCount={count} />);
    await waitFor(() => expect(m.search).toHaveBeenCalledTimes(2));
    view.rerender(<FeedDriveSearch criteria={{ query: "passport" }} onCount={count} />);
    expect(m.search).toHaveBeenCalledTimes(2);
    m.ready=false; m.valid=false;
    view.rerender(<FeedDriveSearch criteria={criteria} onCount={count} />);
    await act(async () => finish({ files: [match], nextCursor: null }));
    expect(screen.queryByText("Passport.pdf")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock to search files" })).toBeVisible();
  });
  it("retries the failed continuation with the same cursor", async () => {
    let failed = false;
    m.search.mockImplementation(async (_token, audience, _criteria, cursor) => {
      if (audience === "owner") return { files: [], nextCursor: null };
      if (!cursor) return { files: [], nextCursor: "same-snapshot" };
      if (!failed) { failed = true; throw new Error("Temporary failure"); }
      return { files: [match], nextCursor: null };
    });
    render(<FeedDriveSearch criteria={criteria} onCount={count} />);
    fireEvent.click(await screen.findByRole("button", { name: "More files" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry files" }));
    expect(await screen.findByText("Passport.pdf")).toBeVisible();
    expect(m.search.mock.calls.filter(call => call[1] === "requester").map(call => call[3])).toEqual([null, "same-snapshot", "same-snapshot"]);
  });
  it("restarts a private search and its selected file after returning from the background", async () => {
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    m.search.mockImplementation(async (_token, audience) => ({ files: audience === "requester" ? [match] : [], nextCursor: null }));
    let finish!: (value: unknown) => void;
    m.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(match);
    render(<FeedDriveSearch criteria={criteria} onCount={count} />);
    fireEvent.click(await screen.findByText("Passport.pdf"));
    await waitFor(() => expect(m.open).toHaveBeenCalledTimes(1));
    visibility.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => finish(match));
    expect(screen.queryByRole("link", { name: "Open file" })).not.toBeInTheDocument();
    visibility.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: "Open file" })).toHaveAttribute("href", match.openUrl);
    expect(m.open).toHaveBeenCalledTimes(2);
    expect(m.search).toHaveBeenCalledTimes(4);
  });

});
