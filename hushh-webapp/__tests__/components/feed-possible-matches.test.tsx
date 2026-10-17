import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const vaultToken = vi.hoisted(() => ({ value: "vault-token" as string | null }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => vaultToken.value }),
}));

const possible = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/services/drive-possible-matches-service", () => ({
  DrivePossibleMatchesService: possible,
}));

const shared = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/services/drive-shared-files-service", () => ({
  DriveSharedFilesService: shared,
}));

import {
  FeedSharedFilesSheet,
  POSSIBLE_MATCH_REASON,
  PossibleMatchesSection,
  possibleMatchesHeading,
} from "@/components/feed/feed-shared-files-sheet";
import type {
  PossibleMatch,
  PossibleMatchesPage,
} from "@/lib/services/drive-possible-matches-service";

const REQUEST = "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e";
const JOB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function match(position: number, patch: Partial<PossibleMatch> = {}): PossibleMatch {
  return {
    matchRef: `${JOB}:${position}`,
    name: `Weekly sync agenda ${position}.pdf`,
    modifiedTime: null,
    kind: "content",
    status: "possible",
    ...patch,
  };
}

function page(matches: PossibleMatch[], patch: Partial<PossibleMatchesPage> = {}): PossibleMatchesPage {
  return { requestId: REQUEST, canSend: true, count: matches.length, matches, ...patch };
}

function renderSection() {
  return render(
    <PossibleMatchesSection requestId={REQUEST} getVaultOwnerToken={() => vaultToken.value} />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vaultToken.value = "vault-token";
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  possible.list.mockReset();
  possible.send.mockReset();
  shared.list.mockReset();
});

describe("PossibleMatchesSection", () => {
  it("lists every possible match under one short heading with a plain reason", async () => {
    possible.list.mockResolvedValue(
      page([
        match(3),
        match(4, { kind: "corrected", name: "Neha salary slip Aug.pdf" }),
        match(5, { kind: "walk", status: "queued", name: "Team folder notes.pdf" }),
      ]),
    );
    renderSection();
    const section = await screen.findByTestId("feed-possible-matches");
    expect(possible.list).toHaveBeenCalledWith("vault-token", REQUEST);
    expect(within(section).getByText(possibleMatchesHeading(3))).toBeInTheDocument();
    expect(possibleMatchesHeading(3)).toBe("Possible matches · 3");
    const rows = within(section).getAllByTestId("possible-match-row");
    expect(rows.map((row) => row.querySelector('[data-slot="possible-match-status"]')?.textContent)).toEqual([
      "Found by content. Not sent yet.",
      "Similar spelling. Not sent yet.",
      "Queued to send.",
    ]);
    expect(POSSIBLE_MATCH_REASON).toEqual({
      content: "Found by content",
      corrected: "Similar spelling",
      synonym: "Similar word",
      walk: "In a shared folder",
    });
    // A queued file has no second Send.
    expect(within(rows[2]).queryByRole("button")).toBeNull();
    expect(within(rows[0]).getByRole("button", { name: "Send Weekly sync agenda 3.pdf" })).toBeEnabled();
  });

  it("one tap sends exactly that file and says it is queued", async () => {
    possible.list.mockResolvedValue(page([match(3), match(4)]));
    const reply = deferred<unknown>();
    possible.send.mockReturnValue(reply.promise);
    renderSection();
    const button = await screen.findByRole("button", { name: "Send Weekly sync agenda 3.pdf" });
    fireEvent.click(button);
    expect(possible.send).toHaveBeenCalledWith("vault-token", REQUEST, [`${JOB}:3`]);
    // No double send while the first is in flight.
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(possible.send).toHaveBeenCalledTimes(1);
    await act(async () => {
      reply.resolve({
        requestId: REQUEST,
        queued: 1,
        matches: [{ matchRef: `${JOB}:3`, status: "queued" }],
      });
    });
    const [first, second] = screen.getAllByTestId("possible-match-row");
    expect(first).toHaveTextContent("Queued to send.");
    expect(within(first).queryByRole("button")).toBeNull();
    expect(second).toHaveTextContent("Found by content. Not sent yet.");
    expect(screen.getByRole("status")).toHaveTextContent("Queued 1 file to send.");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Send all sends every unsent match in one call and skips queued ones", async () => {
    possible.list.mockResolvedValue(
      page([match(3), match(4, { kind: "synonym" }), match(5, { status: "queued" })]),
    );
    possible.send.mockResolvedValue({
      requestId: REQUEST,
      queued: 2,
      matches: [
        { matchRef: `${JOB}:3`, status: "queued" },
        { matchRef: `${JOB}:4`, status: "queued" },
      ],
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Send all 2 possible matches" }));
    expect(possible.send).toHaveBeenCalledTimes(1);
    expect(possible.send).toHaveBeenCalledWith("vault-token", REQUEST, [`${JOB}:3`, `${JOB}:4`]);
    await waitFor(() =>
      expect(
        screen.getAllByTestId("possible-match-row").map((row) => row.dataset.matchStatus),
      ).toEqual(["queued", "queued", "queued"]),
    );
    expect(screen.queryByRole("button", { name: /Send all/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Queued 2 files to send.");
  });

  it("offers Send all only when there is more than one file to send", async () => {
    possible.list.mockResolvedValue(page([match(3), match(4, { status: "queued" })]));
    renderSection();
    await screen.findByRole("button", { name: "Send Weekly sync agenda 3.pdf" });
    expect(screen.queryByRole("button", { name: /Send all/ })).toBeNull();
  });

  it("shows nothing when there are no possible matches", async () => {
    possible.list.mockResolvedValue(page([]));
    const view = renderSection();
    await waitFor(() => expect(possible.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("feed-possible-matches")).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays hidden when the list cannot load", async () => {
    possible.list.mockRejectedValue(new Error("offline"));
    const view = renderSection();
    await waitFor(() => expect(possible.list).toHaveBeenCalledTimes(1));
    expect(view.container).toBeEmptyDOMElement();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("puts the row back and reloads when a send fails", async () => {
    possible.list
      .mockResolvedValueOnce(page([match(3), match(4)]))
      .mockResolvedValueOnce(page([match(3), match(4)], { canSend: false }));
    possible.send.mockRejectedValue(new Error("request_changed"));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Send Weekly sync agenda 3.pdf" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Couldn't send. Try again."));
    await waitFor(() => expect(possible.list).toHaveBeenCalledTimes(2));
    // The request finished meanwhile: the list is read-only now.
    await waitFor(() => expect(screen.getByText("This request has finished.")).toBeInTheDocument());
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getAllByTestId("possible-match-row")[0]).toHaveTextContent(
      "Found by content. Not sent.",
    );
  });

  it("never loads or sends while the vault is locked", async () => {
    vaultToken.value = null;
    const view = renderSection();
    await act(async () => {});
    expect(possible.list).not.toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("is a labelled region with named controls on the Feed type scale", async () => {
    possible.list.mockResolvedValue(page([match(3), match(4)], { count: 140 }));
    renderSection();
    const region = await screen.findByRole("region", { name: "Possible matches, 140" });
    expect(within(region).getByRole("list", { name: "Possible matches" })).toBeInTheDocument();
    const status = within(region).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveClass("sr-only");
    // More than one page: the owner is told how many are shown.
    expect(within(region).getByText("Showing 2 of 140.")).toBeInTheDocument();
    const [row] = within(region).getAllByTestId("possible-match-row");
    expect(row.querySelector('[data-slot="possible-match-name"]')).toHaveClass(
      "text-[13px]",
      "leading-[1.25]",
      "max-[360px]:text-[12.5px]",
    );
    expect(row.querySelector('[data-slot="possible-match-status"]')).toHaveClass(
      "text-[11px]",
      "leading-[1.35]",
      "max-[360px]:text-[10px]",
    );
    for (const button of within(region).getAllByRole("button")) {
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveClass("text-[12px]", "font-semibold");
    }
    const heading = within(region).getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent("Possible matches · 140");
    expect(heading).toHaveClass("ui-text-section-label-compact");
  });
});

describe("FeedSharedFilesSheet with possible matches", () => {
  beforeEach(() => {
    shared.list.mockResolvedValue({
      requestId: REQUEST,
      recipientLabel: "Ankit",
      sharedCount: 1,
      files: [
        {
          fileRef: `${JOB}:1`,
          name: "Standup notes 2026-09-01.pdf",
          modifiedTime: null,
          status: "shared",
          removable: true,
          undoable: false,
        },
      ],
      nextCursor: null,
      undoSeconds: 8,
    });
  });

  it("adds the section below the files One sent", async () => {
    possible.list.mockResolvedValue(page([match(3)]));
    render(
      <FeedSharedFilesSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST}
        recipientLabel="Ankit"
        sharedCount={1}
      />,
    );
    const section = await screen.findByTestId("feed-possible-matches");
    const sharedList = screen.getByRole("list", { name: "Shared files" });
    expect(
      sharedList.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(section).getByText("Possible matches · 1")).toBeInTheDocument();
    // Possible matches are not counted as sent.
    expect(screen.getByText("One sent 1 file to Ankit")).toBeInTheDocument();
  });

  it("asks for nothing while the vault is locked", async () => {
    vaultToken.value = null;
    render(
      <FeedSharedFilesSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST}
        recipientLabel="Ankit"
        sharedCount={1}
      />,
    );
    expect(await screen.findByText("Unlock One to see these files.")).toBeInTheDocument();
    expect(possible.list).not.toHaveBeenCalled();
    expect(screen.queryByTestId("feed-possible-matches")).toBeNull();
  });
});
