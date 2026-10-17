import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const vaultToken = vi.hoisted(() => ({ value: "vault-token" as string | null }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => vaultToken.value }),
}));

const service = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/services/drive-shared-files-service", () => ({
  DriveSharedFilesService: service,
}));

import {
  FEED_SHARED_FILES_HINT,
  FEED_SHARED_FILES_UNDO_MS,
  FeedSharedFilesSheet,
  SharedFileRow,
  sharedFilesTitle,
} from "@/components/feed/feed-shared-files-sheet";
import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { SharedFile } from "@/lib/services/drive-shared-files-service";
import type { FeedItem } from "@/lib/services/feed-service";

const REQUEST = "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e";
const SHARE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function file(position: number, patch: Partial<SharedFile> = {}): SharedFile {
  return {
    fileRef: `${SHARE}:${position}`,
    name: `Meeting notes ${position}`,
    modifiedTime: null,
    status: "shared",
    removable: true,
    undoable: false,
    ...patch,
  };
}

function swipe(element: Element, dx: number) {
  const fire = (type: string, x: number) => {
    // jsdom has no PointerEvent constructor; supply the fields React reads.
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 200 });
    Object.defineProperties(event, {
      pointerId: { value: 7 },
      pointerType: { value: "touch" },
      isPrimary: { value: true },
    });
    fireEvent(element, event);
  };
  fire("pointerdown", 200);
  fire("pointermove", 200 + dx / 2);
  fire("pointermove", 200 + dx);
  fire("pointerup", 200 + dx);
}

function surface(row: HTMLElement): HTMLElement {
  return row.querySelector('[role="button"]') as HTMLElement;
}

describe("Feed files-sent card", () => {
  function card(metadata: Record<string, unknown>): FeedItem {
    return {
      id: "41",
      source_domain: "connected_systems",
      event_type: "document_share_files_sent",
      actor_label: "Ankit",
      metadata: { request_id: REQUEST, ...metadata },
      read: false,
      created_at: "2026-10-17T14:40:00.000Z",
    };
  }

  it("reads as one short line with the live count and opens in place", () => {
    const presentation = presentFeedItem(card({ shared_count: 12, counterpart_label: "Ankit" }));
    expect(presentation.label).toBe("One sent 12 files to Ankit");
    expect(presentation.description).toBe("Tap to review");
    // Openable, so a tap opens the list; Feed swipe stays dismiss/keep.
    expect(presentation.href).toBeTruthy();
    expect(presentFeedItem(card({ shared_count: 1, counterpart_label: "Ankit" })).label).toBe(
      "One sent 1 file to Ankit",
    );
    expect(presentFeedItem(card({ shared_count: 3 })).label).toBe("One sent 3 files");
  });

  it("uses the same words in the sheet title", () => {
    expect(sharedFilesTitle(12, "Ankit")).toBe("One sent 12 files to Ankit");
    expect(sharedFilesTitle(1, null)).toBe("One sent 1 file");
  });
});

describe("SharedFileRow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("swipe left removes access and swipe right keeps", () => {
    const onRemove = vi.fn();
    const onKeep = vi.fn();
    render(
      <ul>
        <SharedFileRow file={file(1)} kept={false} onRemove={onRemove} onKeep={onKeep} />
      </ul>,
    );
    const row = surface(screen.getByTestId("shared-file-row"));

    swipe(row, -120);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();

    swipe(row, 120);
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);

    // A short drag below the commit distance does nothing.
    swipe(row, -40);
    swipe(row, 40);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("offers keyboard and screen-reader paths to the same two choices", () => {
    const onRemove = vi.fn();
    const onKeep = vi.fn();
    render(
      <ul>
        <SharedFileRow file={file(1)} kept={false} onRemove={onRemove} onKeep={onKeep} />
      </ul>,
    );
    const row = surface(screen.getByTestId("shared-file-row"));
    const hint = document.getElementById(row.getAttribute("aria-describedby") ?? "");
    expect(hint).toHaveClass("sr-only");
    expect(hint).toHaveTextContent(
      "Tap for options. Swipe left to remove access, swipe right to keep.",
    );
    expect(row).toHaveAttribute("aria-keyshortcuts", "Delete Backspace");

    fireEvent.keyDown(row, { key: "Delete" });
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Remove access?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    // Press and hold opens the same choice.
    const event = new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 });
    Object.defineProperties(event, {
      pointerId: { value: 9 },
      pointerType: { value: "touch" },
      isPrimary: { value: true },
    });
    fireEvent(row, event);
    act(() => {
      vi.advanceTimersByTime(650);
    });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Keep" }));
    expect(onKeep).toHaveBeenCalledTimes(1);
  });

  it("opens the choice on a click, as VoiceOver, TalkBack and browse mode send", () => {
    const onRemove = vi.fn();
    render(
      <ul>
        <SharedFileRow file={file(1)} kept={false} onRemove={onRemove} onKeep={vi.fn()} />
      </ul>,
    );
    const row = surface(screen.getByTestId("shared-file-row"));
    fireEvent.click(row);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Remove access?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove access" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("does not also open the choice from the click that ends a swipe", () => {
    const onKeep = vi.fn();
    render(
      <ul>
        <SharedFileRow file={file(1)} kept={false} onRemove={vi.fn()} onKeep={onKeep} />
      </ul>,
    );
    const row = surface(screen.getByTestId("shared-file-row"));
    swipe(row, 120);
    fireEvent.click(row);
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("sets the dialog title at the flow's 15px, inside its portal", () => {
    render(
      <ul>
        <SharedFileRow file={file(1)} kept={false} onRemove={vi.fn()} onKeep={vi.fn()} />
      </ul>,
    );
    fireEvent.keyDown(surface(screen.getByTestId("shared-file-row")), { key: "Enter" });
    // The base [data-slot$="title"] rule reads this token with !important.
    expect(screen.getByRole("alertdialog")).toHaveClass(
      "[--foundation-title3-size:15px]",
      "[--foundation-title3-line:20px]",
      "[--foundation-title3-weight:600]",
    );
  });

  it("keeps Undo on the row while the server can still cancel the removal", () => {
    const onUndo = vi.fn();
    const view = render(
      <ul>
        <SharedFileRow
          file={file(1, { status: "removing", removable: false, undoable: true })}
          kept={false}
          onRemove={vi.fn()}
          onKeep={vi.fn()}
          onUndo={onUndo}
        />
      </ul>,
    );
    const row = screen.getByTestId("shared-file-row");
    expect(row).toHaveTextContent("Removing access");
    fireEvent.click(within(row).getByRole("button", { name: "Undo removing access to Meeting notes 1" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    view.rerender(
      <ul>
        <SharedFileRow
          file={file(1, { status: "removing", removable: false, undoable: false })}
          kept={false}
          onRemove={vi.fn()}
          onKeep={vi.fn()}
          onUndo={onUndo}
        />
      </ul>,
    );
    expect(within(screen.getByTestId("shared-file-row")).queryByRole("button")).toBeNull();
  });

  it("has no gesture where One cannot remove access", () => {
    const onRemove = vi.fn();
    render(
      <ul>
        <SharedFileRow
          file={file(2, { status: "had_access", removable: false })}
          kept={false}
          onRemove={onRemove}
          onKeep={vi.fn()}
        />
      </ul>,
    );
    const row = screen.getByTestId("shared-file-row");
    expect(row.querySelector('[role="button"]')).toBeNull();
    expect(row).toHaveTextContent("Already had access");
    swipe(row.firstElementChild as Element, -120);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("matches the Feed row type scale", () => {
    render(
      <ul>
        <SharedFileRow file={file(1)} kept onRemove={vi.fn()} onKeep={vi.fn()} />
      </ul>,
    );
    const row = screen.getByTestId("shared-file-row");
    expect(row.querySelector('[data-slot="shared-file-name"]')).toHaveClass(
      "text-[13px]",
      "leading-[1.25]",
      "max-[360px]:text-[12.5px]",
    );
    const status = row.querySelector('[data-slot="shared-file-status"]');
    expect(status).toHaveClass("text-[11px]", "leading-[1.35]", "max-[360px]:text-[10px]");
    expect(status).toHaveTextContent("Kept");
  });
});

describe("FeedSharedFilesSheet", () => {
  beforeEach(() => {
    vaultToken.value = "vault-token";
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    service.list.mockReset();
    service.remove.mockReset();
    service.restore.mockReset();
    service.list.mockResolvedValue({
      requestId: REQUEST,
      recipientLabel: "Ankit",
      sharedCount: 3,
      files: [file(1), file(2), file(3, { status: "had_access", removable: false })],
      nextCursor: null,
      undoSeconds: 8,
    });
  });

  function renderSheet() {
    return render(
      <FeedSharedFilesSheet
        open
        onOpenChange={vi.fn()}
        requestId={REQUEST}
        recipientLabel="Ankit"
        sharedCount={2}
      />,
    );
  }

  it("lists the request's files under one plain title and hint", async () => {
    renderSheet();
    expect(await screen.findByText("Meeting notes 1")).toBeInTheDocument();
    expect(service.list).toHaveBeenCalledWith("vault-token", REQUEST);
    expect(screen.getByText("One sent 3 files to Ankit")).toBeInTheDocument();
    expect(screen.getByText(FEED_SHARED_FILES_HINT)).toBeInTheDocument();
    expect(screen.getAllByTestId("shared-file-row")).toHaveLength(3);
  });

  it("swipe left queues removal with a short Undo that restores the file", async () => {
    service.remove.mockResolvedValue({ fileRef: `${SHARE}:1`, status: "removing", undoable: true });
    service.restore.mockResolvedValue({ fileRef: `${SHARE}:1`, status: "shared", undoable: false });
    renderSheet();
    await screen.findByText("Meeting notes 1");
    const [first] = screen.getAllByTestId("shared-file-row");

    swipe(surface(first), -120);
    await waitFor(() => expect(service.remove).toHaveBeenCalledWith("vault-token", REQUEST, `${SHARE}:1`));
    await waitFor(() => expect(first).toHaveTextContent("Removing access"));
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [message, options] = toastMock.success.mock.calls[0];
    // Queued, not done: the requester keeps access until the drain runs.
    expect(message).toBe("Removing access");
    expect(options.duration).toBe(FEED_SHARED_FILES_UNDO_MS);
    expect(options.action.label).toBe("Undo");

    await act(async () => {
      options.action.onClick();
    });
    expect(service.restore).toHaveBeenCalledWith("vault-token", REQUEST, `${SHARE}:1`);
    await waitFor(() => expect(first).toHaveTextContent("Shared"));
  });

  it("swipe right keeps the file without any server change", async () => {
    renderSheet();
    await screen.findByText("Meeting notes 2");
    const second = screen.getAllByTestId("shared-file-row")[1];
    swipe(surface(second), 120);
    await waitFor(() => expect(second).toHaveTextContent("Kept"));
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("puts the row back when removal fails", async () => {
    service.remove.mockRejectedValue(new Error("offline"));
    renderSheet();
    await screen.findByText("Meeting notes 1");
    const [first] = screen.getAllByTestId("shared-file-row");
    swipe(surface(first), -120);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't remove access. Try again."),
    );
    expect(first).toHaveTextContent("Shared");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("never claims files while the vault is locked", async () => {
    vaultToken.value = null;
    renderSheet();
    expect(await screen.findByText("Unlock One to see these files.")).toBeInTheDocument();
    expect(service.list).not.toHaveBeenCalled();
  });
});
