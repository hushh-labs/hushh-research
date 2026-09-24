"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Capacitor } from "@capacitor/core";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  XIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { HushhAuth } from "@/lib/capacitor";
import {
  NATIVE_CONNECTOR_RETURN_EVENT,
  NATIVE_DRIVE_PICKER_RETURN_EVENT,
  type NativeConnectorReturn,
  type NativeDrivePickerReturn,
} from "@/lib/navigation/use-deep-link-return";
import { ROUTES } from "@/lib/navigation/routes";
import { useGmailConnectorStatus } from "@/lib/profile/gmail-connector-store";
import { useCalendarConnectionStatus } from "@/lib/calendar/use-calendar-connection-status";
import { usePkmDomainResource } from "@/lib/pkm/pkm-domain-resource";
import { vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
import {
  createGmailOAuthPopupAttempt,
  openGmailOAuthPopup,
  navigateGmailOAuthPopup,
  isGmailOAuthPopupSettlement,
  readGmailOAuthPopupSettlementFallback,
  clearGmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";
import {
  openDriveOAuthPopup,
  navigateDriveOAuthPopup,
  waitForDrivePopup,
  waitForOAuthPopup,
} from "@/lib/profile/drive-oauth-popup";
import {
  ExternalConnectorService,
  type ConnectorOverview,
  type DriveDocument,
  type PendingNativeDrivePicker,
} from "@/lib/services/external-connector-service";
import {
  GoogleDrivePickerService,
  type PickedDriveFile,
} from "@/lib/services/google-drive-picker-service";
import { GmailReceiptsService } from "@/lib/services/gmail-receipts-service";
import type { DriveChatRecoveryReason } from "@/lib/agent/drive-oauth-chat-recovery";
import { TrustedDocumentRules } from "@/components/consent/trusted-document-rules";

type Props = {
  open: boolean;
  onBack: () => void;
  onClose?: () => void;
  /** Reports whether account-backed connector management is currently ready. */
  onAvailableChange?: (available: boolean) => void;
  onCatalogStateChange?: (state: "loading" | "loaded" | "unavailable-valid") => void;
  surface?: "drawer" | "settings";
  initialConnector?: "google_drive" | "gmail" | null;
  onExternalModalChange?: (open: boolean) => void;
  onPrepareRecovery?: (input: {
    attemptId: string;
    reason: DriveChatRecoveryReason;
  }) => Promise<"ready" | "busy" | "unavailable">;
  onClearRecovery?: () => Promise<void>;
};
const touch = "min-h-11 min-w-11 whitespace-normal";
const labels: Record<string, string> = {
  not_connected: "Not connected",
  revoked: "Not connected",
  connected: "Connected",
  verifying: "Authorized · choose files to verify",
  needs_reauth: "Reconnect needed",
  error: "Connection unavailable",
  queued: "Waiting to process",
  fetching: "Reading",
  parsing: "Processing",
  indexing: "Indexing",
  ready: "Ready",
  stale: "Update needed",
  unsupported: "Unsupported format",
  failed_retryable: "Retry needed",
};

type ConnectorListEntry = {
  id: string;
  name: string;
  detail?: string;
  connected: boolean;
  onOpen?: () => void;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  trailingText?: string;
};

function ConnectorGlyph({ id }: { id: string }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm" aria-hidden="true">
      {id === "gmail" ? (
        // The existing product asset keeps Gmail recognizable at list scale.
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/icons/agents/gmail.svg" alt="" className="size-6" />
      ) : id === "google_drive" ? (
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          <path fill="#00875A" d="M8.1 2h5.2l-7 12.1H1.1z" />
          <path fill="#0066DA" d="M6.3 14.1h14.1l-2.6 4.5H3.7z" />
          <path fill="#FFBA00" d="M13.3 2 22 16.3l-2.6 4.5L8.1 2z" />
        </svg>
      ) : id === "calendar" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/icons/agents/calendar.svg" alt="" className="size-6" />
      ) : (
        <span className="text-sm font-semibold">{id === "plaid" ? "P" : "•"}</span>
      )}
    </span>
  );
}

function ConnectorRow({ entry }: { entry: ConnectorListEntry }) {
  const detailId = useId();
  return (
    <li className="flex min-h-14 min-w-0 items-center gap-3 border-b border-foreground/10 px-4 last:border-b-0">
      <ConnectorGlyph id={entry.id} />
      {entry.onOpen ? (
        <button
          type="button"
          aria-label={entry.name}
          aria-describedby={entry.detail ? detailId : undefined}
          onClick={entry.onOpen}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry.name}</span>
            {entry.detail ? <span id={detailId} className="block truncate text-xs text-muted-foreground">{entry.detail}</span> : null}
          </span>
          {entry.connected && !entry.action ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        </button>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.name}</span>
          {entry.detail ? <span className="block truncate text-xs text-muted-foreground">{entry.detail}</span> : null}
        </span>
      )}
      {entry.action ? (
        <button
          type="button"
          className="min-h-11 shrink-0 px-1 text-sm font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={entry.action.label}
          disabled={entry.action.disabled}
          onClick={entry.action.onClick}
        >
          {entry.action.label.startsWith("Connect ") ? "Connect" : "Manage"}
        </button>
      ) : entry.trailingText ? (
        <span className="shrink-0 text-xs text-muted-foreground">{entry.trailingText}</span>
      ) : null}
    </li>
  );
}

type PendingDriveSelection =
  | {
      kind: "web";
      sessionId: string;
      expiresAt: number;
      files: PickedDriveFile[];
    }
  | {
      kind: "native";
      attemptId: string;
      expiresAt: number;
      files: PickedDriveFile[];
    };

function selectedNativePickerFiles(
  pending: PendingNativeDrivePicker,
): PickedDriveFile[] | null {
  if (!Array.isArray(pending.files) || pending.files.length === 0) return null;
  const files = pending.files.map((file) => ({
    id: String(file?.documentId || ""),
    name: String(file?.name || ""),
  }));
  if (
    files.some(
      (file) =>
        !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) ||
        !file.name.trim() ||
        file.name.length > 1_024,
    ) ||
    new Set(files.map((file) => file.id)).size !== files.length
  ) {
    return null;
  }
  return files;
}

export function ConnectorsPanel(props: Props) {
  const { user } = useAuth();
  // Discard all local state on account switch or lock; don't display the prior
  // owner's account labels, pending selection or status on the new session.
  const { vaultOwnerToken } = useVault();
  return (
    <OwnerConnectorsPanel
      key={`${user?.uid ?? "signed-out"}:${Boolean(vaultOwnerToken)}`}
      {...props}
    />
  );
}

function OwnerConnectorsPanel({
  open,
  onBack,
  onClose = onBack,
  surface = "drawer",
  initialConnector = null,
  onAvailableChange,
  onCatalogStateChange,
  onExternalModalChange,
  onPrepareRecovery,
  onClearRecovery,
}: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const { vaultOwnerToken, vaultKey } = useVault();
  const [overview, setOverview] = useState<ConnectorOverview | null>(null);
  const [documents, setDocuments] = useState<DriveDocument[]>([]);
  const [allowBackground, setAllowBackground] = useState(false);
  const [liveBackground, setLiveBackground] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [driveMessage, setDriveMessage] = useState("");
  const [mailMessage, setMailMessage] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [pending, setPending] = useState<PendingDriveSelection | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [activeConnector, setActiveConnector] = useState<string | null>(initialConnector);
  const [search, setSearch] = useState("");
  const previousActiveConnector = useRef<string | null>(null);
  const appliedInitialConnector = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const currentToken = useRef(vaultOwnerToken);
  useLayoutEffect(() => {
    currentToken.current = vaultOwnerToken;
  }, [vaultOwnerToken]);
  const driveLock = useRef(false);
  // Native browser returns and Vault Owner token renewal can overlap the
  // existing Drive mutation. Keep only opaque attempt metadata in memory and
  // drain it after that mutation releases the single-flight lock.
  const queuedNativeReconcile = useRef<{
    expectedAttemptId?: string;
  } | null>(null);
  const drainNativeReconcile = useRef<() => void>(() => undefined);
  // Picker candidates are deliberately reconciled separately from connection
  // credentials. A native picker return is not permission to add a document.
  const queuedNativePickerReconcile = useRef<{
    expectedAttemptId?: string;
  } | null>(null);
  const drainNativePickerReconcile = useRef<() => void>(() => undefined);
  const mailLock = useRef(false);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<HTMLElement>(null);
  // A native app-url return and the browser bridge promise can both arrive for
  // one Picker attempt. Keep a synchronous record so the second reconciliation
  // cannot replace the reviewed selection or reset its explicit processing
  // choice before React commits the first state update.
  const pendingSelection = useRef<PendingDriveSelection | null>(null);
  const restorePickerFocus = useRef(false);
  const overviewRead = useRef(0);
  const documentRead = useRef(0);
  const previousOpen = useRef(open);
  const mailToken = useCallback(
    () => user?.getIdToken() ?? Promise.resolve(""),
    [user],
  );
  const updatePendingSelection = useCallback(
    (next: PendingDriveSelection | null) => {
      pendingSelection.current = next;
      setPending(next);
    },
    [],
  );
  const gmail = useGmailConnectorStatus({
    userId: user?.uid,
    enabled: open,
    idTokenProvider: user ? mailToken : null,
    routeHref: ROUTES.HOME,
  });
  const calendar = useCalendarConnectionStatus({
    userId: user?.uid ?? null,
    idTokenProvider: user ? mailToken : null,
    enabled: open && Boolean(vaultOwnerToken),
  });
  const financial = usePkmDomainResource({
    userId: user?.uid ?? "",
    domain: "financial",
    vaultKey,
    vaultOwnerToken,
    enabled: open && Boolean(vaultKey && vaultOwnerToken),
  });
  const plaidConnections = vaultKey && vaultOwnerToken && financial.data
    ? Object.values(vaultConnections(financial.data.data))
    : [];
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const token = currentToken.current;
    if (!token) {
      onCatalogStateChange?.("unavailable-valid");
      return false;
    }
    const request = ++overviewRead.current;
    setStatusChecked(false);
    setLoading(true);
    onCatalogStateChange?.("loading");
    try {
      const result = await ExternalConnectorService.overview(token);
      if (
        signal?.aborted ||
        currentToken.current !== token ||
        request !== overviewRead.current
      )
        return false;
      setOverview(result);
      setStatusChecked(true);
      onCatalogStateChange?.("loaded");
      return true;
    } catch {
      if (
        !signal?.aborted &&
        currentToken.current === token &&
        request === overviewRead.current
      )
        setDriveMessage(
          "Could not check Drive. Retry before starting another connection.",
        );
      if (!signal?.aborted && currentToken.current === token && request === overviewRead.current) {
        onCatalogStateChange?.("unavailable-valid");
      }
      return false;
    } finally {
      if (
        !signal?.aborted &&
        currentToken.current === token &&
        request === overviewRead.current
      )
        setLoading(false);
    }
  }, [onCatalogStateChange]);
  const refreshDocuments = useCallback(async (signal: AbortSignal) => {
    const token = currentToken.current;
    if (!token) return;
    const request = ++documentRead.current;
    const next = await ExternalConnectorService.documents(token);
    if (
      !signal.aborted &&
      currentToken.current === token &&
      request === documentRead.current
    )
      setDocuments(next);
  }, []);
  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    return () => {
      lifetime.abort();
      onExternalModalChange?.(false);
    };
  }, [onExternalModalChange]);
  useEffect(() => {
    if (!initialConnector) {
      appliedInitialConnector.current = null;
      return;
    }
    if (!open || appliedInitialConnector.current === initialConnector) return;
    appliedInitialConnector.current = initialConnector;
    setActiveConnector(initialConnector);
  }, [initialConnector, open]);
  useEffect(() => {
    if (vaultOwnerToken) void refresh(controller.current?.signal);
    else onCatalogStateChange?.("unavailable-valid");
  }, [vaultOwnerToken, refresh, onCatalogStateChange]);
  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    overviewRead.current++;
    documentRead.current++;
    if (!open) {
      setActiveConnector(null);
      setSearch("");
      setConfirm(null);
    }
    if (open && vaultOwnerToken) void refresh(controller.current?.signal);
  }, [open, vaultOwnerToken, refresh]);
  useLayoutEffect(() => {
    const previous = previousActiveConnector.current;
    previousActiveConnector.current = activeConnector;
    if (!open || previous === activeConnector) return;
    // Picker review owns focus when a native return restores a pending choice.
    if (activeConnector === "google_drive" && pendingSelection.current) return;
    const frame = requestAnimationFrame(() => {
      if (activeConnector) detailBackRef.current?.focus();
      else searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConnector, open]);
  const drive = overview?.connectors.find(
    (item) => item.connectorId === "google_drive",
  );
  useEffect(() => {
    if (!open || !vaultOwnerToken || drive?.profile !== "live" || drive.status !== "connected") {
      setLiveBackground(null);
      return;
    }
    let active = true;
    void ExternalConnectorService.liveBackground(vaultOwnerToken)
      .then((enabled) => { if (active) setLiveBackground(enabled); })
      .catch(() => { if (active) setLiveBackground(null); });
    return () => { active = false; };
  }, [open, vaultOwnerToken, drive?.profile, drive?.status]);
  const hasDriveGrant = Boolean(
    drive && !["not_connected", "revoked"].includes(drive.status),
  );
  useEffect(() => {
    onAvailableChange?.(
      Boolean(
        vaultOwnerToken &&
        (overview?.features.connections_panel_v2 === true || hasDriveGrant),
      ),
    );
  }, [
    vaultOwnerToken,
    overview?.features.connections_panel_v2,
    hasDriveGrant,
    onAvailableChange,
  ]);
  useEffect(() => {
    const signal = controller.current?.signal;
    if (open && hasDriveGrant && signal)
      void refreshDocuments(signal).catch(() => {
        if (!signal.aborted)
          setDriveMessage("Could not load selected files. Try again.");
      });
  }, [open, hasDriveGrant, refreshDocuments]);
  useEffect(() => {
    if (!pending) return;
    setConfirm(null);
    setActiveConnector("google_drive");
    setAllowBackground(false);
    const timer = window.setTimeout(
      () => {
        restorePickerFocus.current = true;
        updatePendingSelection(null);
        setDriveMessage("Selection expired. Choose files again.");
      },
      Math.max(0, pending.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pending, updatePendingSelection]);
  useEffect(() => {
    if (driveBusy || !restorePickerFocus.current) return;
    restorePickerFocus.current = false;
    const frame = requestAnimationFrame(() => {
      (
        pendingRef.current?.querySelector<HTMLButtonElement>("button") ??
        chooseRef.current
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [driveBusy, pending]);

  const runDrive = useCallback(
    async (
      action: (token: string, signal: AbortSignal) => Promise<void>,
      options: { clearMessage?: boolean } = {},
    ) => {
      const token = vaultOwnerToken;
      const signal = controller.current?.signal;
      if (!token || !signal || signal.aborted || driveLock.current) return;
      // Retire reads taken before this operation. Late GETs cannot resurrect
      // removed documents or a connection which has just been disconnected.
      overviewRead.current++;
      documentRead.current++;
      driveLock.current = true;
      setDriveBusy(true);
      if (options.clearMessage !== false) setDriveMessage("");
      try {
        await action(token, signal);
      } catch {
        if (!signal.aborted)
          setDriveMessage(
            "Drive could not finish this action. Check the connection and try again.",
          );
      } finally {
        driveLock.current = false;
        if (queuedNativeReconcile.current)
          queueMicrotask(() => drainNativeReconcile.current());
        if (queuedNativePickerReconcile.current)
          queueMicrotask(() => drainNativePickerReconcile.current());
        if (!signal.aborted) {
          setDriveBusy(false);
          setLoading(false);
        }
      }
    },
    [vaultOwnerToken],
  );

  const finalizeNativeDrive = useCallback(
    async (
      token: string,
      signal: AbortSignal,
      expectedAttemptId?: string,
    ): Promise<boolean> => {
      const isEffectCurrent = () =>
        !signal.aborted && currentToken.current === token;
      const pending = await ExternalConnectorService.pendingNative({
        vaultOwnerToken: token,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return false;
      if (
        !pending ||
        (expectedAttemptId && pending.attemptId !== expectedAttemptId)
      ) {
        // A recovery poll itself is a Drive operation and retires any older
        // overview read. Restore the authoritative connection status even
        // when there was no staged credential to finalize.
        await refresh(signal);
        return false;
      }
      await ExternalConnectorService.finalizeNative({
        vaultOwnerToken: token,
        attemptId: pending.attemptId,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return false;
      return await refresh(signal);
    },
    [refresh],
  );

  const drainQueuedNativeReconcile = useCallback(() => {
    if (
      !open ||
      !vaultOwnerToken ||
      !Capacitor.isNativePlatform() ||
      driveLock.current
    )
      return;
    const queued = queuedNativeReconcile.current;
    if (!queued) return;
    queuedNativeReconcile.current = null;
    void runDrive(
      async (token, signal) => {
        const finalized = await finalizeNativeDrive(
          token,
          signal,
          queued.expectedAttemptId,
        );
        if (finalized && !signal.aborted)
          setDriveMessage(
            "Drive connected. Ask One to find a file.",
          );
      },
      { clearMessage: false },
    );
  }, [finalizeNativeDrive, open, runDrive, vaultOwnerToken]);

  useLayoutEffect(() => {
    drainNativeReconcile.current = drainQueuedNativeReconcile;
    return () => {
      drainNativeReconcile.current = () => undefined;
    };
  }, [drainQueuedNativeReconcile]);

  const queueNativeReconcile = useCallback(
    (expectedAttemptId?: string) => {
      const queued = queuedNativeReconcile.current;
      // A completed callback is more specific than startup recovery. Never
      // replace a callback attempt with a generic poll while it is queued.
      if (!queued || expectedAttemptId)
        queuedNativeReconcile.current = { expectedAttemptId };
      drainQueuedNativeReconcile();
    },
    [drainQueuedNativeReconcile],
  );

  const reconcileNativePicker = useCallback(
    async (
      token: string,
      signal: AbortSignal,
      expectedAttemptId?: string,
    ): Promise<boolean> => {
      const isEffectCurrent = () =>
        !signal.aborted && currentToken.current === token;
      const staged = await ExternalConnectorService.pendingNativePicker({
        vaultOwnerToken: token,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return false;
      if (
        !staged ||
        (expectedAttemptId && staged.attemptId !== expectedAttemptId)
      ) {
        return false;
      }
      const expiresAt = Date.parse(staged.expiresAt);
      const files = selectedNativePickerFiles(staged);
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        !files
      ) {
        // Do not use malformed candidates, even for display. The server keeps
        // its short-lived staged selection until its own expiry; no document
        // is selected or persisted from this path.
        setDriveMessage("Drive could not verify the selected files. Choose them again.");
        return false;
      }
      const existing = pendingSelection.current;
      if (
        existing?.kind === "native" &&
        existing.attemptId === staged.attemptId
      ) {
        // A duplicate native return may briefly disable the review button.
        // Restore it after the single-flight reconciliation releases.
        restorePickerFocus.current = true;
        return true;
      }
      restorePickerFocus.current = true;
      updatePendingSelection({
        kind: "native",
        attemptId: staged.attemptId,
        expiresAt,
        files,
      });
      return true;
    },
    [updatePendingSelection],
  );

  const drainQueuedNativePickerReconcile = useCallback(() => {
    if (
      !open ||
      !vaultOwnerToken ||
      !Capacitor.isNativePlatform() ||
      driveLock.current ||
      pending?.kind === "web"
    ) {
      return;
    }
    const queued = queuedNativePickerReconcile.current;
    if (!queued) return;
    queuedNativePickerReconcile.current = null;
    void runDrive(
      async (token, signal) => {
        const recovered = await reconcileNativePicker(
          token,
          signal,
          queued.expectedAttemptId,
        );
        if (recovered && !signal.aborted)
          setDriveMessage(
            "Review the selected files, then add them to your One file list.",
          );
      },
      { clearMessage: false },
    );
  }, [open, pending?.kind, reconcileNativePicker, runDrive, vaultOwnerToken]);

  useLayoutEffect(() => {
    drainNativePickerReconcile.current = drainQueuedNativePickerReconcile;
    return () => {
      drainNativePickerReconcile.current = () => undefined;
    };
  }, [drainQueuedNativePickerReconcile]);

  const queueNativePickerReconcile = useCallback(
    (expectedAttemptId?: string) => {
      const queued = queuedNativePickerReconcile.current;
      // A callback is scoped to one opaque attempt; startup recovery is not.
      // Retain that specificity if the Vault Owner token renews mid-return.
      if (!queued || expectedAttemptId)
        queuedNativePickerReconcile.current = { expectedAttemptId };
      drainQueuedNativePickerReconcile();
    },
    [drainQueuedNativePickerReconcile],
  );

  const startDrive = (profile: "selected" | "live" = "live") => {
    if (!vaultOwnerToken || driveLock.current) return;
    if (Capacitor.isNativePlatform()) {
      void runDrive(async (token, signal) => {
        const isEffectCurrent = () =>
          !signal.aborted && currentToken.current === token;
        if (!user?.uid) throw new Error("native_owner_unavailable");
        const start = await ExternalConnectorService.startOAuthConnect({
          vaultOwnerToken: token,
          connectorId: "google_drive",
          redirectUri: ExternalConnectorService.nativeDriveOAuthCallbackUri(),
          flow: "native",
          profile,
          isEffectCurrent,
        });
        const expiresAt = Date.parse(start.expiresAt);
        if (
          !isEffectCurrent() ||
          !start.attemptId ||
          start.connectorId !== "google_drive" ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        ) {
          throw new Error("invalid_start");
        }
        // Chat supplies a recovery writer for its in-flight draft. Settings
        // has no conversation draft, so there is nothing to capsule there.
        const readiness = onPrepareRecovery
          ? await onPrepareRecovery({
              attemptId: start.attemptId,
              reason: "native_oauth",
            })
          : "ready";
        if (readiness !== "ready") {
          setDriveMessage(readiness === "busy"
            ? "Finish the current chat action before connecting Drive."
            : "Your draft could not be saved safely. Try again.");
          return;
        }
        let returned = false;
        let result: Awaited<ReturnType<typeof HushhAuth.connectDrive>>;
        try {
          result = await HushhAuth.connectDrive({
            authorizeUrl: start.authorizeUrl,
            attemptId: start.attemptId,
            expiresAt,
            expectedUserId: user.uid,
          });
          returned = true;
        } finally {
          // A killed WebView never runs this cleanup; its encrypted one-use
          // capsule is then available after the owner's next vault unlock.
          if (returned && isEffectCurrent()) await onClearRecovery?.();
        }
        if (!isEffectCurrent()) return;
        if (result.attemptId !== start.attemptId) {
          // A stale custom-scheme return must not terminate a newer native
          // operation. The exact current attempt remains recoverable through
          // the owner-only pending endpoint after this lock releases.
          queueNativeReconcile(start.attemptId);
          setDriveMessage("Drive could not finish connecting. Try again.");
          return;
        }
        if (result.outcome !== "ready") {
          // Older Android browsers can deliver their Custom Tabs return just
          // after RESULT_CANCELED. Reconcile the exact attempt after the
          // native operation releases its lock before treating it as terminal.
          queueNativeReconcile(start.attemptId);
          await refresh(signal);
          if (!signal.aborted) {
            setDriveMessage(
              result.outcome === "cancelled"
                ? "Drive connection was cancelled. Your chat and draft stay here."
                : "Drive could not finish connecting. Try again.",
            );
          }
          return;
        }
        const finalized = await finalizeNativeDrive(
          token,
          signal,
          start.attemptId,
        );
        if (!signal.aborted) {
          setDriveMessage(
            finalized
              ? profile === "live"
                ? "Live Drive access connected. Ask One to find files."
                : "Drive connected. Ask One to find a file."
              : "Drive authorization is still settling. Reopen Connectors to check it.",
          );
        }
      });
      return;
    }
    const popup = openDriveOAuthPopup();
    if (!popup) {
      void runDrive(async (token, signal) => {
        const start = await ExternalConnectorService.startOAuthConnect({
          vaultOwnerToken: token,
          connectorId: "google_drive",
          redirectUri: `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`,
          flow: "web",
          profile,
        });
        if (signal.aborted || !start.attemptId || start.connectorId !== "google_drive") return;
        const authorizeUrl = new URL(start.authorizeUrl);
        if (
          authorizeUrl.protocol !== "https:" ||
          authorizeUrl.hostname !== "accounts.google.com" ||
          authorizeUrl.pathname !== "/o/oauth2/v2/auth"
        ) throw new Error("invalid_drive_authorize_url");
        const readiness = onPrepareRecovery
          ? await onPrepareRecovery({
              attemptId: start.attemptId,
              reason: "web_full_page",
            })
          : "ready";
        if (readiness !== "ready") {
          setDriveMessage(readiness === "busy"
            ? "Finish the current chat action or allow popups before connecting Drive."
            : "Your draft could not be saved safely. Allow popups or try again.");
          return;
        }
        if (signal.aborted) {
          await onClearRecovery?.();
          return;
        }
        try {
          window.location.assign(authorizeUrl.href);
        } catch {
          await onClearRecovery?.();
          throw new Error("drive_navigation_failed");
        }
      });
      return;
    }
    void runDrive(async (token, signal) => {
      const close = () => popup.close();
      signal.addEventListener("abort", close, { once: true });
      try {
        const start = await ExternalConnectorService.startOAuthConnect({
          vaultOwnerToken: token,
          connectorId: "google_drive",
          redirectUri: `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`,
          flow: "web",
          profile,
        });
        if (signal.aborted) return;
        if (!start.attemptId || start.connectorId !== "google_drive")
          throw new Error("invalid_start");
        const attempt = {
          connectorId: "google_drive" as const,
          attemptId: start.attemptId,
          expiresAt: Date.parse(start.expiresAt),
        };
        navigateDriveOAuthPopup(popup, attempt, start.authorizeUrl);
        await waitForDrivePopup(popup, attempt, signal);
        if (!signal.aborted && (await refresh(signal)))
          setDriveMessage(
            profile === "live"
              ? "Live Drive connection checked. Ask One to find files."
              : "Connection checked. Ask One to find a file.",
          );
      } finally {
        signal.removeEventListener("abort", close);
        popup.close();
      }
    });
  };
  useEffect(() => {
    if (!open || !vaultOwnerToken || !Capacitor.isNativePlatform()) return;
    const handleReturn = (event: Event) => {
      const result = (event as CustomEvent<NativeConnectorReturn>).detail;
      if (!result) return;
      if (result.outcome === "ready") queueNativeReconcile(result.attemptId);
      else if (result.outcome === "cancelled")
        setDriveMessage(
          "Drive connection was cancelled. Your chat and draft stay here.",
        );
      else setDriveMessage("Drive could not finish connecting. Try again.");
    };
    window.addEventListener(NATIVE_CONNECTOR_RETURN_EVENT, handleReturn);
    queueNativeReconcile();
    return () =>
      window.removeEventListener(NATIVE_CONNECTOR_RETURN_EVENT, handleReturn);
  }, [open, queueNativeReconcile, vaultOwnerToken]);

  useEffect(() => {
    if (!open || !vaultOwnerToken || !Capacitor.isNativePlatform()) return;
    const handlePickerReturn = (event: Event) => {
      const result = (event as CustomEvent<NativeDrivePickerReturn>).detail;
      if (!result) return;
      // The opaque event has no file identifiers. The server-side pending
      // record is the only source for candidates, and confirming it remains a
      // separate owner action.
      queueNativePickerReconcile(result.attemptId);
      if (result.outcome === "cancelled")
        setDriveMessage(
          "Choosing Drive files was cancelled. Your chat and draft stay here.",
        );
      else if (result.outcome === "failed")
        setDriveMessage("Drive could not finish choosing files. Try again.");
    };
    window.addEventListener(
      NATIVE_DRIVE_PICKER_RETURN_EVENT,
      handlePickerReturn,
    );
    // Covers an app restart or a return which arrived before the panel
    // mounted. Only opaque candidates are fetched after the vault unlock.
    queueNativePickerReconcile();
    return () =>
      window.removeEventListener(
        NATIVE_DRIVE_PICKER_RETURN_EVENT,
        handlePickerReturn,
      );
  }, [open, queueNativePickerReconcile, vaultOwnerToken]);
  const chooseFiles = () => {
    if (Capacitor.isNativePlatform()) {
      void runDrive(async (token, signal) => {
        const isEffectCurrent = () =>
          !signal.aborted && currentToken.current === token;
        if (!user?.uid) throw new Error("native_owner_unavailable");
        const start = await ExternalConnectorService.startNativePicker({
          vaultOwnerToken: token,
          redirectUri: ExternalConnectorService.nativeDrivePickerCallbackUri(),
          isEffectCurrent,
        });
        const expiresAt = Date.parse(start.expiresAt);
        if (
          !isEffectCurrent() ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(start.attemptId) ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        ) {
          throw new Error("invalid_picker_start");
        }
        const readiness = onPrepareRecovery
          ? await onPrepareRecovery({
              attemptId: start.attemptId,
              reason: "native_picker",
            })
          : "ready";
        if (readiness !== "ready") {
          setDriveMessage(readiness === "busy"
            ? "Finish the current chat action before choosing Drive files."
            : "Your draft could not be saved safely. Try again.");
          return;
        }
        let returned = false;
        let result: Awaited<ReturnType<typeof HushhAuth.pickDriveFiles>>;
        try {
          result = await HushhAuth.pickDriveFiles({
            authorizeUrl: start.authorizeUrl,
            attemptId: start.attemptId,
            expiresAt,
            expectedUserId: user.uid,
          });
          returned = true;
        } finally {
          if (returned && isEffectCurrent()) await onClearRecovery?.();
        }
        if (!isEffectCurrent()) return;
        if (result.attemptId !== start.attemptId) {
          // A stale custom-scheme result never gets to select documents. Query
          // only the exact active attempt after the browser bridge releases.
          queueNativePickerReconcile(start.attemptId);
          setDriveMessage("Drive could not finish choosing files. Try again.");
          return;
        }
        // Custom Tabs can surface RESULT_CANCELED just before the opaque
        // picker-return intent. Reconcile the attempt either way; candidates
        // still require the explicit Add selected files tap below.
        queueNativePickerReconcile(start.attemptId);
        if (result.outcome !== "ready") {
          await refresh(signal);
          if (!signal.aborted)
            setDriveMessage(
              result.outcome === "cancelled"
                ? "Choosing Drive files was cancelled. Your chat and draft stay here."
                : "Drive could not finish choosing files. Try again.",
            );
        }
      });
      return;
    }
    void runDrive(async (token, signal) => {
      const session = await ExternalConnectorService.pickerSession(
        token,
        window.location.origin,
      );
      if (signal.aborted) {
        session.accessToken = "";
        return;
      }
      onExternalModalChange?.(true);
      try {
        const files = await GoogleDrivePickerService.choose(session, signal);
        if (!signal.aborted && files.length)
          updatePendingSelection({
            kind: "web",
            sessionId: session.sessionId,
            expiresAt: Date.parse(session.expiresAt),
            files,
          });
      } finally {
        session.accessToken = "";
        if (!signal.aborted) {
          onExternalModalChange?.(false);
          restorePickerFocus.current = true;
          await refresh(signal);
        }
      }
    });
  };
  const connectMail = (purpose: "read" | "compose" = "read") => {
    const signal = controller.current?.signal;
    if (!user || !signal || signal.aborted || mailLock.current) return;
    const native = Capacitor.isNativePlatform();
    const attempt = createGmailOAuthPopupAttempt();
    const popup = native ? null : openGmailOAuthPopup(attempt);
    if (!native && !popup) {
      setMailMessage(
        "Allow popups, then retry. Your chat and draft stay here.",
      );
      return;
    }
    mailLock.current = true;
    setMailBusy(true);
    setMailMessage("");
    const close = () => popup?.close();
    signal.addEventListener("abort", close, { once: true });
    void (async () => {
      try {
        const idToken = await user.getIdToken();
        if (signal.aborted) return;
        if (native) {
          const start = await GmailReceiptsService.startNativeConnect({
            idToken,
            purpose,
          });
          if (signal.aborted || !start.configured) return;
          const result = await HushhAuth.connectGmail({
            serverClientId: start.server_client_id,
            purpose: start.purpose,
            preserveSend: purpose === "compose" && gmail.status?.send_permission_granted === true,
          });
          if (signal.aborted) return;
          await GmailReceiptsService.completeNativeConnect({
            idToken,
            userId: user.uid,
            serverAuthCode: result.serverAuthCode,
          });
        } else if (popup) {
          const start = await GmailReceiptsService.startConnect({
            idToken,
            userId: user.uid,
            includeGrantedScopes: purpose === "compose",
            purpose,
          });
          if (signal.aborted) return;
          const url = new URL(start.authorize_url);
          if (
            !start.configured ||
            url.origin !== "https://accounts.google.com" ||
            url.pathname !== "/o/oauth2/v2/auth"
          )
            throw new Error("invalid_start");
          navigateGmailOAuthPopup(popup, start.authorize_url);
          await waitForOAuthPopup({
            popup,
            signal,
            expiresAt: Math.min(
              Date.parse(start.expires_at),
              attempt.startedAt + 10 * 60_000,
            ),
            matches: (value) =>
              isGmailOAuthPopupSettlement(value) &&
              value.attemptId === attempt.attemptId,
            storageValue: readGmailOAuthPopupSettlementFallback,
          });
        }
        if (!signal.aborted) {
          const status = await gmail.refreshStatus({
            force: true,
            reconcile: false,
          });
          if (!signal.aborted)
            setMailMessage(
              status?.connected
                ? purpose === "compose"
                  ? status.compose_permission_granted
                    ? "Gmail drafts enabled. Review your draft in Chat before saving."
                    : "Gmail drafts permission was not granted. Try again."
                  : "Mail connected."
                : "Mail is not connected yet. You can retry.",
            );
        }
      } catch {
        if (!signal.aborted)
          setMailMessage("Could not finish Mail connection. Try again.");
      } finally {
        signal.removeEventListener("abort", close);
        popup?.close();
        clearGmailOAuthPopupAttempt();
        mailLock.current = false;
        if (!signal.aborted) setMailBusy(false);
      }
    })();
  };

  const canConnectDrive =
    statusChecked &&
    drive?.available !== false &&
    overview?.features.google_drive_connection === true &&
    overview?.features.google_drive_live === true;
  const canPick =
    drive?.profile !== "live" &&
    drive?.available !== false &&
    overview?.features.google_drive_picker === true &&
    ["connected", "verifying"].includes(drive?.status ?? "");
  const confirmAction = () => {
    const target = confirm;
    setConfirm(null);
    if (
      !target ||
      (target === "mail" && activeConnector !== "gmail") ||
      (target !== "mail" && activeConnector !== "google_drive")
    ) return;
    updatePendingSelection(null);
    if (target === "mail") {
      const signal = controller.current?.signal;
      if (mailLock.current || !signal || signal.aborted) return;
      mailLock.current = true;
      setMailBusy(true);
      void gmail
        .disconnectGmail()
        .then(() => {
          if (!signal.aborted)
            setMailMessage("Mail disconnected. Drive is unchanged.");
        })
        .catch(() => {
          if (!signal.aborted)
            setMailMessage("Could not disconnect Mail. Check and retry.");
        })
        .finally(() => {
          mailLock.current = false;
          if (!signal.aborted) setMailBusy(false);
        });
    } else if (target)
      void runDrive(async (token, signal) => {
        if (target === "drive") {
          const result = await ExternalConnectorService.disconnect({
            vaultOwnerToken: token,
            connectorId: "google_drive",
          });
          if (signal.aborted) return;
          setDocuments([]);
          setDriveMessage(
            result.revocationOutcome === "revoked"
              ? "Drive disconnected. Mail is unchanged."
              : "Drive is disabled in One. Google revocation was not confirmed; remove access in your Google account if needed.",
          );
        } else await ExternalConnectorService.removeDocument(token, target);
        if (!signal.aborted) {
          await refresh(signal);
          await refreshDocuments(signal);
        }
      });
  };

  const mailConnected = Boolean(
    gmail.status?.connected || gmail.status?.needs_reauth,
  );
  const showConnector = (id: string) => {
    setConfirm(null);
    setActiveConnector(id);
  };
  const entries: ConnectorListEntry[] = [
    {
      id: "gmail",
      name: "Gmail",
      detail: mailConnected
        ? gmail.status?.needs_reauth
          ? "Reconnect needed"
          : `Google Workspace MCP · ${gmail.status?.google_email || "Connected"}`
        : "Google Workspace MCP · Read access after connection",
      connected: mailConnected,
      onOpen: () => showConnector("gmail"),
      action: mailConnected
        ? undefined
        : {
            label: "Connect Gmail",
            onClick: () => {
              showConnector("gmail");
              connectMail();
            },
            disabled: mailBusy || gmail.loadingStatus,
          },
    },
    {
      id: "google_drive",
      name: "Google Drive",
      detail: hasDriveGrant
        ? drive?.status === "needs_reauth"
          ? "Reconnect needed"
          : `${drive?.profile === "live" ? "Google Workspace MCP · Live Drive read" : "Selected files · limited Drive access"} · ${drive?.accountLabel || (drive?.profile === "live" ? "Search your Drive" : "Choose files for One")}`
        : "Google Workspace MCP · Connect for live read or selected files",
      connected: hasDriveGrant,
      onOpen: () => showConnector("google_drive"),
      action: hasDriveGrant
        ? undefined
        : {
            label: "Connect Google Drive",
            onClick: () => {
              showConnector("google_drive");
              startDrive("live");
            },
            disabled: driveBusy || loading || !canConnectDrive,
          },
    },
    {
      id: "calendar",
      name: "Calendar",
      connected: calendar.connected,
      detail: calendar.error
        ? "Status unavailable"
        : !calendar.loaded
          ? "Checking connection…"
          : calendar.status?.status === "needs_reauth"
            ? "Reconnect needed"
          : calendar.connected
              ? "Google Workspace MCP · Connected"
              : "Google Workspace MCP · Not connected",
      action: {
        label: "Manage Calendar",
        onClick: () => {
          onBack();
          router.push(ROUTES.CALENDAR);
        },
      },
    },
    {
      id: "plaid",
      name: "Plaid",
      connected: plaidConnections.length > 0,
      detail: financial.error
        ? "Status unavailable"
        : financial.loading
          ? "Checking connection…"
          : plaidConnections.some((item) => item.status === "needs_relink")
            ? "Reconnect needed"
          : plaidConnections.length > 0
              ? "Finance connection · sharing needs approval (not MCP)"
              : "Finance connection · not connected (not MCP)",
      action: {
        label: "Manage Plaid",
        onClick: () => {
          onBack();
          router.push(ROUTES.KAI_PORTFOLIO_SOURCES);
        },
      },
    },
    ...(overview?.connectors ?? [])
      .filter((item, index, items) =>
        !["google_drive", "gmail", "calendar", "plaid"].includes(item.connectorId) &&
        items.findIndex((candidate) => candidate.connectorId === item.connectorId) === index,
      )
      .map((item): ConnectorListEntry => ({
        id: item.connectorId,
        name: item.displayName,
        detail: item.accountLabel || item.description || undefined,
        connected: !["not_connected", "revoked"].includes(item.status),
        onOpen: !["not_connected", "revoked"].includes(item.status)
          ? () => showConnector(item.connectorId)
          : undefined,
        trailingText: ["not_connected", "revoked"].includes(item.status)
          ? labels[item.status]
          : undefined,
      })),
  ];
  const query = search.trim().toLocaleLowerCase();
  const matchingEntries = entries.filter(
    (entry) =>
      !query ||
      `${entry.name} ${entry.detail ?? ""}`.toLocaleLowerCase().includes(query),
  );
  const connectedEntries = matchingEntries.filter((entry) => entry.connected);
  const availableEntries = matchingEntries.filter((entry) => !entry.connected);
  const selectedCatalog = overview?.connectors.find(
    (item) => item.connectorId === activeConnector,
  );

  return (
    <div
      className={`flex h-full min-h-0 flex-col bg-background text-foreground ${surface === "drawer" ? "border-l border-border" : ""}`}
      data-connections-panel
      data-surface={surface}
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4">
        {activeConnector || surface === "settings" ? (
          <ShellActionSurface
            ref={detailBackRef}
            className="size-11"
            onClick={() => {
              setConfirm(null);
              if (activeConnector) setActiveConnector(null);
              else onBack();
            }}
            aria-label={activeConnector ? "Back to connectors" : "Back to profile"}
          >
            <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
          </ShellActionSurface>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {activeConnector
            ? entries.find((entry) => entry.id === activeConnector)?.name || "Connector"
            : "Connectors"}
        </h2>
        {surface === "drawer" ? (
          <ShellActionSurface
            className="size-11"
            onClick={() => {
              setConfirm(null);
              onClose();
            }}
            aria-label="Close connectors"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </ShellActionSurface>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
        {!vaultOwnerToken ? (
          <p role="status" className="text-sm text-muted-foreground">
            Unlock your vault to manage connectors.
          </p>
        ) : !activeConnector ? (
          <>
            <label className="flex min-h-11 items-center gap-2 rounded-full bg-foreground/10 px-4 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search connectors"
                placeholder="Search connectors"
                className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            {([[
              "Connected",
              connectedEntries,
            ], [
              "Available",
              availableEntries,
            ]] as const).map(([heading, items]) =>
              query && items.length === 0 ? null : (
                <section key={heading} aria-label={heading} className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">{heading}</h3>
                  <ul className="overflow-hidden rounded-2xl bg-foreground/10">
                    {items.length ? items.map((entry) => <ConnectorRow key={entry.id} entry={entry} />) : (
                      <li className="px-4 py-4 text-sm text-muted-foreground">
                        {heading === "Connected" ? "No connected connectors" : "No available connectors"}
                      </li>
                    )}
                  </ul>
                </section>
              ),
            )}
            {query && matchingEntries.length === 0 ? (
              <p role="status" className="py-4 text-center text-sm text-muted-foreground">No connectors found</p>
            ) : null}
          </>
        ) : (
          <>
            {activeConnector === "gmail" && <section
              aria-labelledby="connection-mail-title"
              className="space-y-3 rounded-xl border border-border p-3"
            >
              <h3 id="connection-mail-title" className="font-semibold">
                Gmail
              </h3>
              <p className="break-all text-sm text-muted-foreground">
                {gmail.status?.google_email || "Gmail"}
              </p>
              <p role="status" className="text-sm">
                {gmail.loadingStatus
                  ? "Checking Mail…"
                  : gmail.statusError
                    ? "Status unavailable"
                    : gmail.status?.needs_reauth
                      ? "Reconnect needed"
                      : gmail.status?.connected
                        ? "Connected"
                        : "Not connected"}
              </p>
              <div className="flex flex-wrap gap-2">
                {(!gmail.status?.connected || gmail.status?.needs_reauth) && (
                  <Button
                    className={touch}
                    disabled={mailBusy || gmail.loadingStatus}
                    onClick={() => connectMail()}
                  >
                    {gmail.status?.needs_reauth
                      ? "Reconnect Mail"
                      : "Connect Mail"}
                  </Button>
                )}
                {gmail.status?.connected && !gmail.status.compose_permission_granted && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={mailBusy || gmail.loadingStatus}
                    onClick={() => connectMail("compose")}
                  >
                    Enable Gmail drafts
                  </Button>
                )}
                {(gmail.status?.connected || gmail.status?.needs_reauth) && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={mailBusy}
                    onClick={() => setConfirm("mail")}
                  >
                    Disconnect Mail
                  </Button>
                )}
                {gmail.statusError && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={mailBusy}
                    onClick={() =>
                      void gmail.refreshStatus({
                        force: true,
                        reconcile: false,
                      })
                    }
                  >
                    Retry Mail
                  </Button>
                )}
              </div>
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {mailBusy ? "Updating Mail…" : mailMessage}
              </p>
            </section>}
            {activeConnector === "google_drive" && <section
              aria-labelledby="connection-drive-title"
              className="space-y-3 rounded-xl border border-border p-3"
            >
              <h3 id="connection-drive-title" className="font-semibold">
                Google Drive
              </h3>
              <p className="break-all text-sm text-muted-foreground">
                {drive?.accountLabel || "Search and read files"}
              </p>
              <p role="status" className="text-sm">
                {loading
                  ? "Checking Drive…"
                  : drive
                    ? (labels[drive.status] ?? "Status unavailable")
                    : "Not connected"}
              </p>
              <div className="flex flex-wrap gap-2">
                {(!hasDriveGrant ||
                  drive?.status === "needs_reauth" ||
                  drive?.status === "error") && (
                  <Button
                    className={touch}
                    disabled={driveBusy || loading || !canConnectDrive}
                    onClick={() => startDrive("live")}
                  >
                    {hasDriveGrant ? "Reconnect Drive" : "Connect Drive"}
                  </Button>
                )}
                {overview?.features.google_drive_live === true &&
                  drive?.status === "connected" && drive?.profile !== "live" && (
                    <Button
                      className={touch}
                      disabled={driveBusy || loading || !canConnectDrive}
                      onClick={() => startDrive("live")}
                    >
                      Reconnect Drive
                    </Button>
                  )}
                {hasDriveGrant && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={driveBusy}
                    onClick={() => setConfirm("drive")}
                  >
                    Disconnect Drive
                  </Button>
                )}
                <Button
                  className={touch}
                  variant="ghost"
                  disabled={driveBusy || loading}
                  onClick={() => {
                    void refresh(controller.current?.signal);
                    if (controller.current)
                      void refreshDocuments(controller.current.signal).catch(
                        () => undefined,
                      );
                  }}
                >
                  Retry Drive
                </Button>
              </div>
              {overview?.features.google_drive_live === true && drive?.profile !== "live" && (
                <p className="text-sm text-muted-foreground">
                  Live access lets One search your Drive when needed. Connecting never shares files;
                  each request still needs your approval or a separate permission you set.
                </p>
              )}
              {drive?.profile === "live" && drive.status === "connected" && (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <p className="text-sm">Prepare document requests while you’re away. One reads relevant files on Hushh servers and sends excerpts to Gemini. Files are shared only after your approval or under document trust.</p>
                  <Button className={touch} disabled={driveBusy || liveBackground === null}
                    onClick={() => void runDrive(async (token) => {
                      const next = !liveBackground;
                      await ExternalConnectorService.setLiveBackground(token, next);
                      setLiveBackground(next);
                      setDriveMessage(next ? "Background preparation enabled." : "Background preparation disabled.");
                    })}>
                    {liveBackground ? "Stop background preparation" : "Prepare requests while away"}
                  </Button>
                </div>
              )}
              {vaultOwnerToken ? <TrustedDocumentRules token={vaultOwnerToken} /> : null}
              {!canConnectDrive && (
                <p className="text-sm text-muted-foreground">
                  Drive connection is unavailable in this session. Try again later.
                </p>
              )}
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {driveBusy ? "Updating Drive…" : driveMessage}
              </p>
              {pending && (
                <section
                  ref={pendingRef}
                  className="space-y-3 rounded-lg border border-border p-3"
                  aria-label="Confirm selected files"
                >
                  <p className="text-sm">
                    Add these files to your One file list? Google access
                    is not the same as sharing with another person.
                  </p>
                  <ul className="space-y-2 text-sm">
                    {pending.files.map((file) => (
                      <li key={file.id} className="break-all">
                        {file.name}
                      </li>
                    ))}
                  </ul>
                  {overview?.features.drive_document_indexing && (
                    <label className="flex min-h-11 items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 size-5 shrink-0"
                        checked={allowBackground}
                        disabled={driveBusy}
                        onChange={(event) =>
                          setAllowBackground(event.target.checked)
                        }
                      />
                      <span>
                        Allow Hushh to process these files on its servers, even
                        when the app is closed. Relevant excerpts may be sent
                        to Gemini to prepare suggestions. The encrypted file
                        index is held by Hushh, not your vault. Sharing still
                        needs your approval.
                      </span>
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className={touch}
                      disabled={driveBusy}
                      onClick={() =>
                        void runDrive(async (token, signal) => {
                          if (pending.kind === "native") {
                            const selected =
                              await ExternalConnectorService.confirmNativePicker(
                                {
                                  vaultOwnerToken: token,
                                  attemptId: pending.attemptId,
                                  backgroundProcessing: allowBackground,
                                  isEffectCurrent: () =>
                                    !signal.aborted &&
                                    currentToken.current === token,
                                },
                              );
                            if (!signal.aborted) setDocuments(selected.documents);
                          } else {
                            await ExternalConnectorService.selectDocuments(
                              token,
                              pending.sessionId,
                              pending.files.map((file) => file.id),
                              allowBackground,
                            );
                          }
                          if (!signal.aborted) {
                            restorePickerFocus.current = true;
                            updatePendingSelection(null);
                            await refreshDocuments(signal);
                          }
                        })
                      }
                    >
                      Add selected files
                    </Button>
                    <Button
                      className={touch}
                      variant="outline"
                      disabled={driveBusy}
                      onClick={() => {
                        if (pending.kind !== "native") {
                          restorePickerFocus.current = true;
                          updatePendingSelection(null);
                          return;
                        }
                        void runDrive(async (token, signal) => {
                          await ExternalConnectorService.cancelNativePicker({
                            vaultOwnerToken: token,
                            attemptId: pending.attemptId,
                            isEffectCurrent: () =>
                              !signal.aborted && currentToken.current === token,
                          });
                          if (!signal.aborted) {
                            restorePickerFocus.current = true;
                            updatePendingSelection(null);
                          }
                        });
                      }}
                    >
                      Cancel selection
                    </Button>
                  </div>
                </section>
              )}
              {(documents.length > 0 || canPick) && (
                <details>
                <summary className="cursor-pointer py-3 text-sm">Previously added files</summary>
                {canPick && (
                  <Button
                    ref={chooseRef}
                    className={touch}
                    disabled={driveBusy || Boolean(pending)}
                    onClick={chooseFiles}
                  >
                    Choose files
                  </Button>
                )}
                {documents.length > 0 && <ul className="space-y-3" aria-label="Selected Drive files">
                  {documents.map((item) => (
                    <li
                      key={item.documentId}
                      className="space-y-1 border-t border-border pt-3"
                    >
                      <p className="break-all text-sm">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {!item.backgroundProcessing && item.status === "queued"
                          ? "Background processing is off"
                          : (labels[item.status] ?? "Status unavailable")}
                      </p>
                      {(overview?.features.drive_document_indexing ||
                        item.backgroundProcessing) && (
                        <label className="flex min-h-11 items-start gap-3 text-sm">
                          <input
                            type="checkbox"
                            className="mt-1 size-5 shrink-0"
                            checked={item.backgroundProcessing === true}
                            aria-label={`Background processing for ${item.name}`}
                            disabled={driveBusy}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              void runDrive(async (token, signal) => {
                                await ExternalConnectorService.setDocumentProcessing(
                                  token,
                                  item.documentId,
                                  enabled,
                                );
                                await refreshDocuments(signal);
                              });
                            }}
                          />
                          <span>
                            Allow Hushh to process this file on its servers,
                            even when the app is closed. Relevant excerpts may
                            be sent to Gemini. The encrypted index is held by
                            Hushh, not your vault. Turning this off stops new
                            processing but keeps the index until you remove
                            the file. Sharing still needs your approval.
                          </span>
                        </label>
                      )}
                      {item.backgroundProcessing &&
                        overview?.features.drive_document_indexing && (
                          <Button
                            variant="ghost"
                            className={touch}
                            aria-label={`Sync ${item.name} now`}
                            disabled={driveBusy}
                            onClick={() =>
                              void runDrive(async (token, signal) => {
                                await ExternalConnectorService.syncDocument(
                                  token,
                                  item.documentId,
                                );
                                await refreshDocuments(signal);
                              })
                            }
                          >
                            Sync now
                          </Button>
                        )}
                      <Button
                        variant="ghost"
                        className={touch}
                        disabled={driveBusy}
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setConfirm(item.documentId)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>}
                </details>
              )}
            </section>}
            {selectedCatalog && activeConnector !== "google_drive" && activeConnector !== "gmail" && (
              <section className="space-y-3 rounded-xl border border-border p-3" aria-label={`${selectedCatalog.displayName} details`}>
                <h3 className="font-semibold">{selectedCatalog.displayName}</h3>
                <p className="text-sm text-muted-foreground">{selectedCatalog.description}</p>
                {selectedCatalog.accountLabel ? <p className="break-all text-sm">{selectedCatalog.accountLabel}</p> : null}
                <p role="status" className="text-sm">{labels[selectedCatalog.status] ?? "Status unavailable"}</p>
              </section>
            )}
            {confirm && (
              <section
                className="space-y-3 rounded-xl border border-border p-3"
                aria-label="Confirm connection change"
              >
                <p className="text-sm">
                  {confirm === "mail"
                    ? "Disconnect Mail? Drive stays connected."
                    : confirm === "drive"
                      ? "Disconnect Drive and remove its selected files from One? Existing Google sharing stays active until you revoke it. Mail stays connected."
                      : "Remove this file from One? The original in Google Drive is unchanged."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className={touch}
                    disabled={mailBusy || driveBusy}
                    onClick={confirmAction}
                  >
                    Confirm
                  </Button>
                  <Button
                    className={touch}
                    variant="outline"
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
