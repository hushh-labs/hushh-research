"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { toast } from "sonner";

import { SettingsDetailPanel } from "@/components/app-ui/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DOCUMENT_FLOW_DIALOG_TYPE,
  DOCUMENT_FLOW_SURFACE_TYPE,
} from "@/lib/consent/document-request-flow";
import {
  DriveSharedFilesService,
  type SharedFile,
  type SharedFileStatus,
} from "@/lib/services/drive-shared-files-service";
import { useVault } from "@/lib/vault/vault-context";

export const FEED_SHARED_FILES_HINT = "Swipe left to remove access. Swipe right to keep.";
/** The client Undo is shorter than the server's wait before a removal can run. */
export const FEED_SHARED_FILES_UNDO_MS = 5_000;

const SWIPE_LIMIT_PX = 132;
const SWIPE_COMMIT_PX = 84;
const SWIPE_AXIS_LOCK_PX = 10;
const HOLD_TO_CONFIRM_MS = 600;

/**
 * The Feed row and Profile type scale (feed-row.tsx; Your account's 13/12
 * scale): 13px titles, 11px secondary lines, 12px actions. The detail panel's
 * own title and description use the header scale every request dialog shares.
 */
const ROW_TITLE_CLASS = "block truncate text-[13px] leading-[1.25] max-[360px]:text-[12.5px]";
const ROW_META_CLASS =
  "mt-px block text-[11px] leading-[1.35] text-[color:var(--app-secondary-label)] max-[360px]:text-[10px]";
const NOTE_CLASS = "px-1 py-3 text-[11px] leading-[1.35] text-[color:var(--app-secondary-label)]";
const ACTION_CLASS =
  "rounded-full px-3 py-1.5 text-[12px] font-semibold leading-[1.2] text-[color:var(--app-accent)] hover:bg-[color:var(--app-accent-tint)] disabled:opacity-50";

/** "One sent 12 files to Ankit" — the Feed card and the sheet use one line. */
export function sharedFilesTitle(count: number, recipientLabel: string | null): string {
  const files = `${count} ${count === 1 ? "file" : "files"}`;
  return recipientLabel ? `One sent ${files} to ${recipientLabel}` : `One sent ${files}`;
}

function statusLine(status: SharedFileStatus, kept: boolean): string {
  switch (status) {
    case "removing":
      return "Removing access";
    case "removed":
      return "Access removed";
    case "had_access":
      return "Already had access";
    case "needs_attention":
      return "Couldn't remove access";
    default:
      return kept ? "Kept" : "Shared";
  }
}

function keptStorageKey(requestId: string): string {
  return `one.feed.shared-files.kept.${requestId}`;
}

/** Keep changes nothing on the server; remembering it is a per-device convenience. */
function readKept(requestId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(keptStorageKey(requestId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((ref) => typeof ref === "string") : []);
  } catch {
    return new Set();
  }
}

function writeKept(requestId: string, kept: Set<string>): void {
  try {
    window.localStorage.setItem(keptStorageKey(requestId), JSON.stringify([...kept].slice(-500)));
  } catch {
    // Storage can be unavailable; Keep still shows for this visit.
  }
}

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  axis: "pending" | "horizontal" | "vertical";
  held: boolean;
};

export function SharedFileRow({
  file,
  kept,
  onRemove,
  onKeep,
  onUndo,
}: {
  file: SharedFile;
  kept: boolean;
  onRemove: (file: SharedFile) => void;
  onKeep: (file: SharedFile) => void;
  /** Shown on the row for as long as the server can still cancel the removal. */
  onUndo?: (file: SharedFile) => void;
}) {
  const actionable = file.removable && file.status === "shared";
  const undoable = Boolean(onUndo) && file.status === "removing" && file.undoable;
  const [confirmOpen, setConfirmOpen] = useState(false);
  // A committed swipe, scroll or hold is not also a tap.
  const suppressClickRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const keepRef = useRef<HTMLDivElement | null>(null);
  const removeRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintId = useId();

  useEffect(() => () => {
    if (holdRef.current !== null) clearTimeout(holdRef.current);
  }, []);

  const clearHold = () => {
    if (holdRef.current !== null) clearTimeout(holdRef.current);
    holdRef.current = null;
  };

  // Swipe left = remove access, swipe right = keep.
  const paint = (offset: number) => {
    if (surfaceRef.current) surfaceRef.current.style.transform = `translate3d(${offset}px,0,0)`;
    if (removeRef.current)
      removeRef.current.style.opacity = String(Math.max(0, Math.min(1, -offset / SWIPE_COMMIT_PX)));
    if (keepRef.current)
      keepRef.current.style.opacity = String(Math.max(0, Math.min(1, offset / SWIPE_COMMIT_PX)));
  };

  const reset = () => {
    clearHold();
    gestureRef.current = null;
    if (surfaceRef.current) surfaceRef.current.style.transition = "";
    paint(0);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClickRef.current = false;
    if (!actionable || event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The native iOS edge gesture owns the first 28px of the viewport.
    if (event.pointerType === "touch" && event.clientX <= 28) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      axis: "pending",
      held: false,
    };
    clearHold();
    holdRef.current = setTimeout(() => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.axis !== "pending") return;
      gesture.held = true;
      setConfirmOpen(true);
    }, HOLD_TO_CONFIRM_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.held) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (gesture.axis === "pending") {
      if (Math.hypot(deltaX, deltaY) < SWIPE_AXIS_LOCK_PX) return;
      clearHold();
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      if (gesture.axis === "vertical") return;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Implicit touch capture still carries the gesture on WebKit.
      }
      event.currentTarget.style.transition = "none";
    }
    if (gesture.axis !== "horizontal") return;
    gesture.dx = Math.max(-SWIPE_LIMIT_PX, Math.min(SWIPE_LIMIT_PX, deltaX));
    paint(gesture.dx);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const { axis, dx, held } = gesture;
    reset();
    suppressClickRef.current = held || axis !== "pending";
    if (suppressClickRef.current) {
      // Clear after this pointer's own click, if the browser sends one.
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    if (held || axis !== "horizontal") return;
    if (dx <= -SWIPE_COMMIT_PX) onRemove(file);
    else if (dx >= SWIPE_COMMIT_PX) onKeep(file);
  };

  return (
    <li
      data-testid="shared-file-row"
      data-file-status={file.status}
      data-no-route-swipe
      className="relative isolate overflow-hidden after:pointer-events-none after:absolute after:bottom-0 after:left-3 after:right-0 after:h-px after:bg-[color:var(--app-separator)] after:content-[''] last:after:hidden"
    >
      {actionable ? (
        <>
          <div
            ref={keepRef}
            data-slot="shared-file-swipe-keep"
            aria-hidden="true"
            style={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-start gap-2 bg-[color:var(--app-accent-tint)] px-[18px] text-[12px] font-semibold text-[color:var(--app-accent)]"
          >
            Keep
          </div>
          <div
            ref={removeRef}
            data-slot="shared-file-swipe-remove"
            aria-hidden="true"
            style={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 bg-[color:var(--app-destructive-tint)] px-[18px] text-[12px] font-semibold text-[color:var(--app-destructive)]"
          >
            Remove access
          </div>
        </>
      ) : null}
      <div
        ref={surfaceRef}
        role={actionable ? "button" : undefined}
        tabIndex={actionable ? 0 : -1}
        aria-label={actionable ? `${file.name}. ${statusLine(file.status, kept)}` : undefined}
        aria-describedby={actionable ? hintId : undefined}
        aria-keyshortcuts={actionable ? "Delete Backspace" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onClick={() => {
          // A click, or a screen reader's activation, opens the same choice.
          if (!actionable) return;
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setConfirmOpen(true);
        }}
        onKeyDown={(event) => {
          if (!actionable) return;
          if (event.key === "Delete" || event.key === "Backspace" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setConfirmOpen(true);
          }
        }}
        onContextMenu={(event) => {
          if (!actionable) return;
          event.preventDefault();
          setConfirmOpen(true);
        }}
        style={{ transform: "translate3d(0px,0,0)" }}
        className={`relative z-[1] flex min-h-[52px] w-full items-center gap-2 bg-[color:var(--app-card-surface-default-solid)] px-3 py-2 text-left text-[color:var(--app-label)] outline-none transition-transform duration-300 ease-[cubic-bezier(.2,.9,.2,1)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--app-accent)] motion-reduce:transition-none max-[360px]:px-[9px] ${actionable ? "touch-pan-y cursor-grab" : ""}`}
      >
        <span className="min-w-0 flex-1">
          <span data-slot="shared-file-name" className={ROW_TITLE_CLASS}>
            {file.name}
          </span>
          <span data-slot="shared-file-status" className={ROW_META_CLASS}>
            {statusLine(file.status, kept)}
          </span>
        </span>
        {undoable ? (
          <button
            type="button"
            data-slot="shared-file-undo"
            aria-label={`Undo removing access to ${file.name}`}
            className={`shrink-0 ${ACTION_CLASS}`}
            onClick={() => onUndo?.(file)}
          >
            Undo
          </button>
        ) : null}
      </div>
      {actionable ? (
        <span id={hintId} className="sr-only">
          Tap for options. Swipe left to remove access, swipe right to keep.
        </span>
      ) : null}
      {actionable ? (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent size="sm" className={DOCUMENT_FLOW_DIALOG_TYPE}>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-[15px] leading-[1.2]">Remove access?</AlertDialogTitle>
              <AlertDialogDescription className="text-[11px] leading-[1.35]">{file.name}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="text-[12px]" onClick={() => onKeep(file)}>
                Keep
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                className="text-[12px]"
                onClick={() => onRemove(file)}
              >
                Remove access
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </li>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "locked" }
  | { kind: "error" }
  | { kind: "ready"; files: SharedFile[]; nextCursor: string | null };

export function FeedSharedFilesSheet({
  open,
  onOpenChange,
  requestId,
  recipientLabel,
  sharedCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string | null;
  recipientLabel: string | null;
  sharedCount: number;
}) {
  const { getVaultOwnerToken: readVaultToken } = useVault();
  // Read the current token at call time; its function identity is not a
  // reason to reload the list.
  const vaultTokenRef = useRef(readVaultToken);
  vaultTokenRef.current = readVaultToken;
  const getVaultOwnerToken = useCallback(() => vaultTokenRef.current(), []);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [count, setCount] = useState(sharedCount);
  const [label, setLabel] = useState(recipientLabel);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const loadEpoch = useRef(0);

  const patchFile = useCallback((ref: string, patch: Partial<SharedFile>) => {
    setState((current) =>
      current.kind === "ready"
        ? {
            ...current,
            files: current.files.map((item) => (item.fileRef === ref ? { ...item, ...patch } : item)),
          }
        : current,
    );
  }, []);

  const load = useCallback(async () => {
    if (!requestId) return;
    const epoch = ++loadEpoch.current;
    const token = getVaultOwnerToken();
    if (!token) {
      setState({ kind: "locked" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const page = await DriveSharedFilesService.list(token, requestId);
      if (epoch !== loadEpoch.current) return;
      setCount(page.sharedCount);
      if (page.recipientLabel) setLabel(page.recipientLabel);
      setState({ kind: "ready", files: page.files, nextCursor: page.nextCursor });
    } catch {
      if (epoch === loadEpoch.current) setState({ kind: "error" });
    }
  }, [getVaultOwnerToken, requestId]);

  useEffect(() => {
    if (!open || !requestId) return;
    setCount(sharedCount);
    setLabel(recipientLabel);
    setKept(readKept(requestId));
    void load();
  }, [open, requestId, sharedCount, recipientLabel, load]);

  const loadMore = async () => {
    if (state.kind !== "ready" || !state.nextCursor || !requestId) return;
    const token = getVaultOwnerToken();
    if (!token) return;
    setLoadingMore(true);
    try {
      const page = await DriveSharedFilesService.list(token, requestId, state.nextCursor);
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", files: [...current.files, ...page.files], nextCursor: page.nextCursor }
          : current,
      );
    } catch {
      toast.error("Couldn't load more files. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  const keep = (file: SharedFile) => {
    if (!requestId) return;
    setKept((current) => {
      const next = new Set(current);
      next.add(file.fileRef);
      writeKept(requestId, next);
      return next;
    });
  };

  const undo = async (file: SharedFile) => {
    const token = getVaultOwnerToken();
    if (!token || !requestId) return;
    try {
      const change = await DriveSharedFilesService.restore(token, requestId, file.fileRef);
      patchFile(file.fileRef, { status: change.status, removable: true, undoable: false });
    } catch {
      patchFile(file.fileRef, { undoable: false });
      toast.error("Couldn't undo. Access is being removed.");
    }
  };

  const remove = async (file: SharedFile) => {
    const token = getVaultOwnerToken();
    if (!token || !requestId) {
      toast.error("Unlock One to remove access.");
      return;
    }
    patchFile(file.fileRef, { status: "removing", removable: false });
    try {
      const change = await DriveSharedFilesService.remove(token, requestId, file.fileRef);
      patchFile(file.fileRef, { status: change.status, undoable: change.undoable });
      // Queued only: the requester keeps access until the drain runs.
      toast.success("Removing access", {
        duration: FEED_SHARED_FILES_UNDO_MS,
        ...(change.undoable
          ? { action: { label: "Undo", onClick: () => void undo(file) } }
          : {}),
      });
    } catch {
      patchFile(file.fileRef, { status: file.status, removable: file.removable });
      toast.error("Couldn't remove access. Try again.");
    }
  };

  return (
    <SettingsDetailPanel
      open={open}
      onOpenChange={onOpenChange}
      mobilePresentation="sheet"
      surfaceClassName={DOCUMENT_FLOW_SURFACE_TYPE}
      title={sharedFilesTitle(count, label)}
      description={FEED_SHARED_FILES_HINT}
      headerTextOverflow="wrap"
    >
      <div data-testid="feed-shared-files" className="pb-2">
        {state.kind === "loading" ? (
          <p role="status" className={NOTE_CLASS}>
            Loading files
          </p>
        ) : state.kind === "locked" ? (
          <p role="status" className={NOTE_CLASS}>
            Unlock One to see these files.
          </p>
        ) : state.kind === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-3">
            <p className={NOTE_CLASS}>Couldn&apos;t load files.</p>
            <button type="button" className={ACTION_CLASS} onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : state.files.length === 0 ? (
          <p role="status" className={NOTE_CLASS}>
            No files yet.
          </p>
        ) : (
          <>
            <ul
              aria-label="Shared files"
              className="overflow-hidden rounded-[16px] border border-[color:var(--app-card-border-standard)]"
            >
              {state.files.map((file) => (
                <SharedFileRow
                  key={file.fileRef}
                  file={file}
                  kept={kept.has(file.fileRef)}
                  onRemove={(item) => void remove(item)}
                  onKeep={keep}
                  onUndo={(item) => void undo(item)}
                />
              ))}
            </ul>
            {state.nextCursor ? (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  className={ACTION_CLASS}
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "Loading" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </SettingsDetailPanel>
  );
}
