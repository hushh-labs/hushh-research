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
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  SearchIcon,
  XIcon,
} from "@/components/icons";
import { ConnectedSystemsAgentIcon } from "@/components/icons/agents";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectorConfirm } from "@/components/agent/connector-confirm";
import { Switch } from "@/components/ui/switch";
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
import { disconnectVaultPlaid, vaultConnections } from "@/lib/kai/plaid-vault/vault-sync";
import {
  createGmailOAuthPopupAttempt,
  openGmailOAuthPopup,
  navigateGmailOAuthPopup,
  isGmailOAuthPopupSettlement,
  readGmailOAuthPopupSettlementFallback,
  clearGmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";
import {
  clearDrivePopupAttempt,
  createDrivePopupAttempt,
  openDriveOAuthPopup,
  navigateDriveOAuthPopup,
  waitForDrivePopup,
  waitForOAuthPopup,
  type DrivePopupAttempt,
} from "@/lib/profile/drive-oauth-popup";
import {
  clearCuratedPopupAttempt,
  createCuratedPopupAttempt,
  navigateCuratedOAuthPopup,
  openCuratedOAuthPopup,
  waitForCuratedPopup,
  type CuratedPopupAttempt,
} from "@/lib/profile/curated-connector-popup";
import { connectCalendarInPlace } from "@/lib/connections/google-connect-in-place";
import { OAUTH_WINDOW_BLOCKED_COPY } from "@/lib/connections/oauth-window";
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
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import {
  type DriveChatRecoveryReason,
} from "@/lib/agent/drive-oauth-chat-recovery";
import { TrustedDocumentRules } from "@/components/consent/trusted-document-rules";
import { CustomConnectorsSettings } from "@/components/agent/custom-connectors-settings";

type Props = {
  open: boolean;
  onBack: () => void;
  onClose?: () => void;
  /** Reports whether account-backed connector management is currently ready. */
  onAvailableChange?: (available: boolean) => void;
  onCatalogStateChange?: (state: "loading" | "loaded" | "unavailable-valid") => void;
  /**
   * `drawer`: the chat's own Connectors sheet, with its own header and close.
   * `profile`: a section inside Profile, whose pane header owns the title and
   * Back, so the panel draws no header of its own.
   */
  surface?: "drawer" | "profile";
  initialConnector?: "google_drive" | "gmail" | null;
  /**
   * The open connector, when the host keeps it in its own address (Profile
   * does, so Back and deep links behave like every other Profile detail).
   * Leave undefined for the panel to hold it itself.
   */
  activeConnector?: string | null;
  onActiveConnectorChange?: (connectorId: string | null) => void;
  onExternalModalChange?: (open: boolean) => void;
  onPrepareRecovery?: (input: {
    attemptId: string;
    reason: DriveChatRecoveryReason;
    customConnector?: { connectorId: string; revision: string };
  }) => Promise<"ready" | "busy" | "unavailable">;
  onClearRecovery?: () => Promise<void>;
};
const touch = "min-h-11 min-w-11 whitespace-normal";
const labels: Record<string, string> = {
  not_connected: "Not connected",
  revoked: "Not connected",
  connected: "Connected",
  verifying: "Authorized · choose files to verify",
  needs_reauth: "Sign-in needed",
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
  /** A change on this connector is in flight. */
  pending?: "connect" | "disconnect";
  /** The last disconnect did not finish; the row says so until it does. */
  failure?: string;
};

/** The row's second line: in-flight and failed changes are always visible. */
function connectorRowStatus(entry: ConnectorListEntry): string | undefined {
  if (entry.pending === "disconnect") return "Disconnecting…";
  if (entry.pending === "connect") return "Connecting…";
  if (entry.failure) return entry.failure;
  return undefined;
}

/**
 * The row's action keeps one width whatever it says. Both verbs are laid in
 * the same grid cell and only the live one is visible, so "Connect",
 * "Disconnect" and the in-flight spinner occupy an identical box and nothing
 * beside them moves when the state changes.
 */
function ConnectorActionLabel({ entry }: { entry: ConnectorListEntry }) {
  const verb = entry.action?.label.split(" ")[0] ?? "";
  return (
    <span className="grid place-items-center">
      <span aria-hidden="true" className="invisible [grid-area:1/1]">Disconnect</span>
      <span aria-hidden="true" className="invisible [grid-area:1/1]">Connect</span>
      {entry.pending ? (
        <Loader2Icon
          aria-hidden="true"
          className="size-4 animate-spin [grid-area:1/1] motion-reduce:animate-none"
        />
      ) : (
        <span className="[grid-area:1/1]">{verb}</span>
      )}
    </span>
  );
}

const CONNECTOR_LOGOS: Record<string, string> = {
  gmail: "gmail",
  google_drive: "drive",
  calendar: "calendar",
  plaid: "plaid",
  attio: "attio",
  hubspot: "hubspot",
  notion: "notion",
};

// Single-colour black marks disappear on the dark theme, so they invert there.
// (Official files are used unmodified: see public/icons/connectors/README.md.)
const MONOCHROME_LOGOS = new Set(["plaid", "attio", "notion"]);

/**
 * Profile's leading glyph: the connector's own mark, bare, in the same 28px
 * well and 22px optical size as every other Profile row icon. No tile.
 * A connector without a mark takes the registry's connections glyph.
 */
function ProfileConnectorGlyph({ id }: { id: string }) {
  const logo = CONNECTOR_LOGOS[id];
  return (
    <span className="inline-flex size-7 shrink-0 items-center justify-center" aria-hidden="true">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/icons/connectors/${logo}.svg`} alt="" className={`size-[22px] object-contain${MONOCHROME_LOGOS.has(id) ? " dark:invert" : ""}`} />
      ) : (
        <ConnectedSystemsAgentIcon size={22} />
      )}
    </span>
  );
}

function ConnectorGlyph({ id }: { id: string }) {
  const logo = CONNECTOR_LOGOS[id];
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground shadow-sm" aria-hidden="true">
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/icons/connectors/${logo}.svg`} alt="" className={`size-6 object-contain${MONOCHROME_LOGOS.has(id) ? " dark:invert" : ""}`} />
      ) : (
        <span className="text-sm font-semibold">•</span>
      )}
    </span>
  );
}

function ConnectorRow({ entry }: { entry: ConnectorListEntry }) {
  const detailId = useId();
  const status = connectorRowStatus(entry);
  return (
    <li
      data-connector-row={entry.id}
      aria-busy={entry.pending ? true : undefined}
      className="flex min-h-14 min-w-0 items-center gap-3 border-b border-foreground/10 px-4 last:border-b-0"
    >
      <ConnectorGlyph id={entry.id} />
      {entry.onOpen ? (
        <button
          type="button"
          aria-label={entry.name}
          aria-describedby={entry.detail ? detailId : undefined}
          onClick={entry.onOpen}
          className="flex min-h-14 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry.name}</span>
            {status ? (
              <span id={detailId} role="status" className="block truncate text-xs text-muted-foreground">{status}</span>
            ) : entry.detail ? <span id={detailId} className="sr-only">{entry.detail}</span> : null}
          </span>
          {!entry.action ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        </button>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.name}</span>
          {status ? (
            <span role="status" className="block truncate text-xs text-muted-foreground">{status}</span>
          ) : entry.detail ? <span className="sr-only">{entry.detail}</span> : null}
        </span>
      )}
      {entry.action ? (
        <button
          type="button"
          className="min-h-11 shrink-0 px-1 text-sm font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={entry.action.label}
          disabled={entry.action.disabled || Boolean(entry.pending)}
          onClick={entry.action.onClick}
        >
          <ConnectorActionLabel entry={entry} />
        </button>
      ) : entry.trailingText ? (
        <span className="shrink-0 text-xs text-muted-foreground">{entry.trailingText}</span>
      ) : null}
    </li>
  );
}

/**
 * The same row every Profile section draws: title, one supporting line, and
 * either a chevron into the connector or its connect/disconnect action.
 */
function ProfileConnectorRow({ entry }: { entry: ConnectorListEntry }) {
  const status = connectorRowStatus(entry);
  const description =
    status ??
    entry.detail ??
    (entry.action || entry.onOpen
      ? entry.connected
        ? "Connected"
        : "Not connected"
      : undefined);
  // No wrapper element: the group's first/last corners and hairlines are
  // keyed to the row being a direct child of the group's list.
  return (
    <SettingsRow
      leading={<ProfileConnectorGlyph id={entry.id} />}
      title={entry.name}
      description={description}
      textOverflow="truncate"
      onClick={entry.onOpen}
      chevron={Boolean(entry.onOpen) && !entry.action && !entry.trailingText}
      trailingInteractive={Boolean(entry.action)}
      testId={`profile-connector-row-${entry.id}`}
      trailing={
        entry.action ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            className="px-3"
            aria-label={entry.action.label}
            aria-busy={entry.pending ? true : undefined}
            disabled={entry.action.disabled || Boolean(entry.pending)}
            onClick={entry.action.onClick}
          >
            <ConnectorActionLabel entry={entry} />
          </Button>
        ) : entry.trailingText
      }
    />
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
  activeConnector: hostActiveConnector,
  onActiveConnectorChange,
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
  const [liveBackgroundError, setLiveBackgroundError] = useState(false);
  const [liveBackgroundRead, retryLiveBackground] = useState(0);
  const [loading, setLoading] = useState(false);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [driveMessage, setDriveMessage] = useState("");
  const [mailMessage, setMailMessage] = useState("");
  const [plaidMessage, setPlaidMessage] = useState("");
  const [driveBusy, setDriveBusy] = useState(false);
  const [mailBusy, setMailBusy] = useState(false);
  const [drivePopupPending, setDrivePopupPending] = useState(false);
  const [mailPopupPending, setMailPopupPending] = useState(false);
  const [plaidBusy, setPlaidBusy] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarPopupPending, setCalendarPopupPending] = useState(false);
  const [calendarMessage, setCalendarMessage] = useState("");
  const [curatedBusy, setCuratedBusy] = useState(false);
  const [curatedMessage, setCuratedMessage] = useState("");
  const [curatedPopupPending, setCuratedPopupPending] = useState(false);
  // Coming back from the provider's consent page with Back can restore this page
  // from the bfcache with the in-flight flag still set; nothing is in flight then.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setCuratedBusy(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const [pending, setPending] = useState<PendingDriveSelection | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [ownActiveConnector, setOwnActiveConnector] = useState<string | null>(initialConnector);
  const connectorHeldByHost = hostActiveConnector !== undefined;
  const activeConnector = connectorHeldByHost ? hostActiveConnector : ownActiveConnector;
  const activeConnectorRef = useRef(activeConnector);
  useLayoutEffect(() => {
    activeConnectorRef.current = activeConnector;
  }, [activeConnector]);
  // Idempotent: asking for the connector already open is not a navigation,
  // so a double tap never stacks two identical history entries in Profile.
  const setActiveConnector = useCallback(
    (next: string | null) => {
      if (!connectorHeldByHost) {
        setOwnActiveConnector(next);
        return;
      }
      if (activeConnectorRef.current === next) return;
      activeConnectorRef.current = next;
      onActiveConnectorChange?.(next);
    },
    [connectorHeldByHost, onActiveConnectorChange],
  );
  // A disconnect that did not finish, per connector, until it does.
  const [disconnectFailures, setDisconnectFailures] = useState<Record<string, string>>({});
  // Disconnects in flight, per connector: the row's pending state is this,
  // not a shared busy flag that other Drive work also raises.
  const [disconnecting, setDisconnecting] = useState<Record<string, boolean>>({});
  // The section a row sat in when the person acted on it from the list. The
  // row keeps that place while they stay on the list; it moves only when they
  // next arrive at the list, never under their finger.
  const [pinnedSections, setPinnedSections] = useState<Record<string, boolean>>({});
  // Synchronous single flight per change target. React state is not yet
  // committed between two taps in one frame; a ref is.
  const changesInFlight = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const driveBackgroundId = useId();
  const previousActiveConnector = useRef<string | null>(null);
  const appliedInitialConnector = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const detailRegionRef = useRef<HTMLDivElement>(null);
  const panelRootRef = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const currentToken = useRef(vaultOwnerToken);
  const curatedRequest = useRef(0);
  const curatedDisconnectId = useRef<string | null>(null);
  // The in-session curated sign-in: `session` ends it with the owner session,
  // `cancel` is the person's own Cancel sign-in.
  const curatedPopupSession = useRef<AbortController | null>(null);
  const curatedPopupCancel = useRef<AbortController | null>(null);
  // Two taps in one frame both read the same `curatedBusy`; each would open a
  // window and leave an orphan attempt. This lock is synchronous.
  const curatedLock = useRef(false);
  // The connector the open sign-in window belongs to, so only its detail view
  // offers Cancel.
  const [curatedPopupFor, setCuratedPopupFor] = useState<string | null>(null);
  const latestOverview = useRef<ConnectorOverview | null>(null);
  const ownerUid = user?.uid;
  useEffect(
    () => () => curatedPopupSession.current?.abort(),
    [ownerUid],
  );
  useLayoutEffect(() => {
    if (currentToken.current !== vaultOwnerToken) {
      // A renewed owner token retires the old async request. The catalog is
      // re-read below with the new token; do not leave an old row spinning.
      // The one exception is a sign-in the person is completing at the provider:
      // the vault renews its owner token shortly before expiry, and that must not
      // close their window. Only locking the vault (no token) or a different
      // owner ends it; its own refresh reads the current token when it settles.
      if (curatedPopupSession.current && vaultOwnerToken) {
        currentToken.current = vaultOwnerToken;
        return;
      }
      curatedRequest.current++;
      curatedPopupSession.current?.abort();
      const id = curatedDisconnectId.current;
      if (id) {
        changesInFlight.current.delete(`curated:${id}`);
        setDisconnecting((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        curatedDisconnectId.current = null;
      }
      setCuratedBusy(false);
    }
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
  const drivePopupCancel = useRef<AbortController | null>(null);
  const mailPopupCancel = useRef<AbortController | null>(null);
  const calendarLock = useRef(false);
  const calendarPopupCancel = useRef<AbortController | null>(null);
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
    setCatalogLoadFailed(false);
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
      latestOverview.current = result;
      setOverview(result);
      setCatalogLoadFailed(false);
      setStatusChecked(true);
      onCatalogStateChange?.("loaded");
      return true;
    } catch {
      if (
        !signal?.aborted &&
        currentToken.current === token &&
        request === overviewRead.current
      ) {
        setCatalogLoadFailed(true);
        setDriveMessage(
          "Could not check Drive. Retry before starting another connection.",
        );
      }
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
  }, [initialConnector, open, setActiveConnector]);
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
      setPinnedSections({});
    }
    if (open && vaultOwnerToken) void refresh(controller.current?.signal);
  }, [open, vaultOwnerToken, refresh, setActiveConnector]);
  useLayoutEffect(() => {
    const previous = previousActiveConnector.current;
    previousActiveConnector.current = activeConnector;
    if (!open || previous === activeConnector) return;
    // Arriving at the list (or leaving it) is when rows may settle into their
    // current sections; they never move while the person is on the list.
    setPinnedSections({});
    // A question asked about one connector never follows the person to
    // another: Profile's Back and a native return both move the open
    // connector without passing through the dialog's own Cancel.
    setConfirm(null);
    // Picker review owns focus when a native return restores a pending choice.
    if (activeConnector === "google_drive" && pendingSelection.current) return;
    const frame = requestAnimationFrame(() => {
      if (surface === "profile") {
        // Profile's pane header owns Back. Land on the detail's content, and
        // on return put focus back on the row the person opened: a search
        // field would raise the keyboard on a phone for no reason.
        if (activeConnector) {
          detailRegionRef.current?.focus({ preventScroll: true });
          return;
        }
        panelRootRef.current
          ?.querySelector<HTMLElement>(
            `[data-testid="profile-connector-row-${previous}"] button`,
          )
          ?.focus({ preventScroll: true });
        return;
      }
      if (activeConnector) detailBackRef.current?.focus();
      else searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConnector, open, surface]);
  const drive = overview?.connectors.find(
    (item) => item.connectorId === "google_drive",
  );
  useEffect(() => {
    if (!open || !vaultOwnerToken || drive?.profile !== "live" || drive.status !== "connected") {
      setLiveBackground(null);
      setLiveBackgroundError(false);
      return;
    }
    let active = true;
    setLiveBackground(null);
    setLiveBackgroundError(false);
    void ExternalConnectorService.liveBackground(vaultOwnerToken)
      .then((enabled) => { if (active) setLiveBackground(enabled); })
      .catch(() => { if (active) setLiveBackgroundError(true); });
    return () => { active = false; };
  }, [open, vaultOwnerToken, drive?.profile, drive?.status, liveBackgroundRead]);
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
  }, [pending, updatePendingSelection, setActiveConnector]);
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
    if (!controller.current || controller.current.signal.aborted) {
      setDriveMessage("Drive is still preparing. Try again.");
      return;
    }
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
          signal,
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
                : "Drive connected. Choose files for One to read."
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
          signal,
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
    const attemptCancel = new AbortController();
    drivePopupCancel.current = attemptCancel;
    setDrivePopupPending(true);
    void runDrive(async (token, signal) => {
      let attempt: DrivePopupAttempt | null = null;
      let popupClosed = false;
      const close = () => {
        if (popupClosed) return;
        popupClosed = true;
        popup.close();
      };
      signal.addEventListener("abort", close, { once: true });
      attemptCancel.signal.addEventListener("abort", close, { once: true });
      const startController = new AbortController();
      const abortStart = (source: AbortSignal) => {
        if (!startController.signal.aborted)
          startController.abort(source.reason);
      };
      const abortForDriveSession = () => abortStart(signal);
      const abortForUserCancel = () => abortStart(attemptCancel.signal);
      signal.addEventListener("abort", abortForDriveSession, { once: true });
      attemptCancel.signal.addEventListener("abort", abortForUserCancel, { once: true });
      if (signal.aborted) abortForDriveSession();
      if (attemptCancel.signal.aborted) abortForUserCancel();
      try {
        let start: Awaited<ReturnType<typeof ExternalConnectorService.startOAuthConnect>>;
        try {
          start = await ExternalConnectorService.startOAuthConnect({
            vaultOwnerToken: token,
            connectorId: "google_drive",
            redirectUri: `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`,
            flow: "web",
            profile,
            signal: startController.signal,
          });
        } catch {
          if (attemptCancel.signal.aborted) {
            if (!signal.aborted) setDriveMessage("Drive connection cancelled.");
            return;
          }
          if (signal.aborted) return;
          setDriveMessage("Drive sign-in could not start. Check the connection and try again.");
          return;
        }
        if (signal.aborted || attemptCancel.signal.aborted) return;
        if (!start.attemptId || start.connectorId !== "google_drive")
          throw new Error("invalid_start");
        attempt = createDrivePopupAttempt(start.attemptId);
        navigateDriveOAuthPopup(popup, attempt, start.authorizeUrl);
        await waitForDrivePopup(popup, attempt, signal, attemptCancel.signal);
        if (attemptCancel.signal.aborted) {
          if (!signal.aborted) setDriveMessage("Drive connection cancelled.");
          return;
        }
        if (!signal.aborted && (await refresh(signal)))
          setDriveMessage(
            profile === "live"
              ? "Live Drive connection checked. Ask One to find files."
              : "Connection checked. Ask One to find a file.",
          );
      } finally {
        if (attempt) clearDrivePopupAttempt(attempt);
        if (drivePopupCancel.current === attemptCancel) drivePopupCancel.current = null;
        if (!signal.aborted) setDrivePopupPending(false);
        signal.removeEventListener("abort", abortForDriveSession);
        attemptCancel.signal.removeEventListener("abort", abortForUserCancel);
        attemptCancel.signal.removeEventListener("abort", close);
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
      // Release the app's focus trap before Google's in-page picker focuses
      // its own dialog. WebKit can otherwise redirect that first focus back
      // into the app before React commits the asynchronous state update.
      flushSync(() => onExternalModalChange?.(true));
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
    const attempt = createGmailOAuthPopupAttempt(user.uid, "read");
    const popup = native ? null : openGmailOAuthPopup(attempt);
    if (!native && !popup) {
      setMailMessage(
        OAUTH_WINDOW_BLOCKED_COPY,
      );
      return;
    }
    const attemptCancel = new AbortController();
    if (popup) {
      mailPopupCancel.current = attemptCancel;
      setMailPopupPending(true);
    }
    mailLock.current = true;
    setMailBusy(true);
    setMailMessage("");
    const close = () => popup?.close();
    signal.addEventListener("abort", close, { once: true });
    void (async () => {
      let webPopupFailureCode: "USER_CANCELLED" | "POPUP_TIMEOUT" | null = null;
      try {
        const idToken = await user.getIdToken();
        if (signal.aborted) return;
        if (native) {
          const start = await GmailReceiptsService.startNativeConnect({
            idToken,
            userId: user.uid,
            purpose,
          });
          if (signal.aborted || !start.configured) return;
          let result: Awaited<ReturnType<typeof HushhAuth.connectGmail>>;
          try {
            result = await HushhAuth.connectGmail({
              serverClientId: start.server_client_id,
              purpose: start.purpose,
              preserveSend: purpose === "compose" && gmail.status?.send_permission_granted === true,
              preserveModify: gmail.status?.modify_permission_granted === true,
            });
          } catch (error) {
            GmailReceiptsService.recordConsentFailure(error, user.uid);
            throw error;
          }
          if (signal.aborted) {
            GmailReceiptsService.recordConsentFailure({
              code: "USER_CANCELLED",
            }, user.uid);
            return;
          }
          if (!result.serverAuthCode?.trim()) {
            const error = new Error(
              "Google did not return a Mail authorization code.",
            );
            GmailReceiptsService.recordConsentFailure(error, user.uid);
            throw error;
          }
          await GmailReceiptsService.completeNativeConnect({
            idToken,
            userId: user.uid,
            serverAuthCode: result.serverAuthCode,
            purpose: "read",
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
            cancelSignal: attemptCancel.signal,
            expiresAt: Math.min(
              Date.parse(start.expires_at),
              attempt.startedAt + 10 * 60_000,
            ),
            matches: (value) =>
              isGmailOAuthPopupSettlement(value) &&
              value.attemptId === attempt.attemptId,
            storageValue: readGmailOAuthPopupSettlementFallback,
            onFinish: (reason) => {
              if (reason === "closed") webPopupFailureCode = "USER_CANCELLED";
              else if (reason === "expired") webPopupFailureCode = "POPUP_TIMEOUT";
            },
          });
          if (attemptCancel.signal.aborted) {
            if (!signal.aborted) setMailMessage("Mail connection cancelled.");
            return;
          }
        }
        if (!signal.aborted) {
          const status = await gmail.refreshStatus({
            force: true,
            reconcile: false,
          });
          if (!status?.connected && webPopupFailureCode) {
            GmailReceiptsService.recordConsentFailure({
              code: webPopupFailureCode,
            }, user.uid);
            webPopupFailureCode = null;
          }
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
        if (!signal.aborted && webPopupFailureCode) {
          GmailReceiptsService.recordConsentFailure({
            code: webPopupFailureCode,
          }, user.uid);
          webPopupFailureCode = null;
        }
        if (!signal.aborted)
          setMailMessage("Could not finish Mail connection. Try again.");
      } finally {
        if (mailPopupCancel.current === attemptCancel) mailPopupCancel.current = null;
        if (!signal.aborted) setMailPopupPending(false);
        signal.removeEventListener("abort", close);
        popup?.close();
        clearGmailOAuthPopupAttempt();
        mailLock.current = false;
        if (!signal.aborted) setMailBusy(false);
      }
    })();
  };

  /**
   * Connects Calendar without leaving the drawer. Web opens Google's consent
   * in a popup (a new tab if the popup is refused) through the same callback
   * page and settlement contract as the Calendar workspace; native uses the
   * platform Google sign-in sheet. The WebView never navigates, so the vault
   * stays unlocked. A settlement is only a hint: the owner-authenticated
   * status read decides what the drawer shows.
   */
  const connectCalendar = (accessLevel: "read" | "manage" = "read") => {
    const signal = controller.current?.signal;
    if (!user || !signal || signal.aborted || calendarLock.current) return;
    const attemptCancel = new AbortController();
    // Opens the consent window synchronously, inside this click.
    const attempt = connectCalendarInPlace({
      owner: user,
      accessLevel,
      signal,
      cancelSignal: attemptCancel.signal,
    });
    if (attempt.surface === "blocked") {
      setCalendarMessage(
        OAUTH_WINDOW_BLOCKED_COPY,
      );
      return;
    }
    if (attempt.surface === "window") {
      calendarPopupCancel.current = attemptCancel;
      setCalendarPopupPending(true);
    }
    calendarLock.current = true;
    setCalendarBusy(true);
    setCalendarMessage("");
    void attempt.result.then((outcome) => {
      if (calendarPopupCancel.current === attemptCancel)
        calendarPopupCancel.current = null;
      calendarLock.current = false;
      if (outcome === "stale" || signal.aborted) return;
      setCalendarPopupPending(false);
      setCalendarBusy(false);
      if (outcome === "connected") calendar.refresh();
      setCalendarMessage(
        outcome === "connected"
          ? "Calendar connected."
          : outcome === "failed"
            ? "Could not finish Calendar connection. Try again."
            : "Calendar not connected.",
      );
    });
  };

  const canConnectDrive =
    statusChecked &&
    drive?.available === true;
  const driveConnectionProfile: "live" | "selected" =
    overview?.features.google_drive_live === true ? "live" : "selected";
  const canPick =
    drive?.profile !== "live" &&
    drive?.available !== false &&
    overview?.features.google_drive_picker === true &&
    ["connected", "verifying"].includes(drive?.status ?? "");
  const DISCONNECT_FAILED = "Couldn't disconnect. Try again.";
  const beginDisconnect = (id: string) => {
    setDisconnectFailures((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDisconnecting((current) => ({ ...current, [id]: true }));
  };
  const endDisconnect = (id: string, failure?: string) => {
    setDisconnecting((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (failure) setDisconnectFailures((current) => ({ ...current, [id]: failure }));
  };
  /**
   * Ask before a connection changes, without leaving where the person is. From
   * the list the row also keeps its section until they next arrive at the list.
   */
  const askToDisconnect = (id: string, target: string, fromList: boolean) => {
    if (fromList) setPinnedSections((current) => ({ ...current, [id]: true }));
    setConfirm(target);
  };
  const curatedRolloutEnabled = overview?.features.curated_mcp_connectors === true;
  const connectCurated = (connectorId: string, name: string) => {
    if (!vaultOwnerToken || !user?.uid || curatedBusy || curatedLock.current) return;
    const connector = overview?.connectors.find((item) => item.connectorId === connectorId);
    if (
      !connector ||
      connector.curatedOAuth !== true ||
      !curatedRolloutEnabled ||
      connector.available !== true
    ) {
      setCuratedMessage(name + " is unavailable here.");
      return;
    }
    if (Capacitor.isNativePlatform()) {
      setCuratedMessage(`Connect ${name} on the web. It works here once connected.`);
      return;
    }
    curatedLock.current = true;
    // Open the sign-in window synchronously in the click, before any awaited
    // work, so the browser keeps the user gesture. This window never navigates
    // on this path, so the memory-only vault key and the chat survive.
    const popup = openCuratedOAuthPopup();
    if (!popup) {
      // Both a popup and a tab were refused. Like Mail, Calendar and Drive, stay
      // here: a full-page redirect would reload the app and re-lock the vault.
      curatedLock.current = false;
      setCuratedMessage(OAUTH_WINDOW_BLOCKED_COPY);
      return;
    }
    const token = vaultOwnerToken;
    const signal = controller.current?.signal;
    const request = ++curatedRequest.current;
    setCuratedBusy(true);
    setCuratedMessage("");
    const session = new AbortController();
    const attemptCancel = new AbortController();
    curatedPopupSession.current = session;
    curatedPopupCancel.current = attemptCancel;
    setCuratedPopupPending(true);
    setCuratedPopupFor(connectorId);
    const endSession = () => session.abort();
    const close = () => popup.close();
    signal?.addEventListener("abort", endSession, { once: true });
    attemptCancel.signal.addEventListener("abort", endSession, { once: true });
    session.signal.addEventListener("abort", close, { once: true });
    if (signal?.aborted) endSession();
    void (async () => {
      let attempt: CuratedPopupAttempt | null = null;
      // A renewed owner token does not end the sign-in (see the token effect);
      // locking the vault, a new owner, unmounting or Cancel does.
      const current = () => !session.signal.aborted && curatedRequest.current === request;
      try {
        let start: Awaited<ReturnType<typeof ExternalConnectorService.startOAuthConnect>>;
        try {
          start = await ExternalConnectorService.startOAuthConnect({
            vaultOwnerToken: token,
            connectorId,
            redirectUri: `${window.location.origin}${ROUTES.PROFILE_CONNECTOR_OAUTH_RETURN}`,
            flow: "web",
            signal: session.signal,
          });
        } catch {
          if (attemptCancel.signal.aborted) {
            if (!signal?.aborted && curatedRequest.current === request) setCuratedMessage("Sign-in cancelled.");
            return;
          }
          if (!current()) return;
          setCuratedMessage(`Could not start ${name}. Try again.`);
          return;
        }
        if (!current()) return;
        if (!start.attemptId || start.connectorId !== connectorId) throw new Error("invalid_start");
        attempt = createCuratedPopupAttempt(connectorId, start.attemptId);
        navigateCuratedOAuthPopup(popup, attempt, start.authorizeUrl);
        await waitForCuratedPopup(popup, attempt, session.signal, attemptCancel.signal);
        if (attemptCancel.signal.aborted) {
          if (!signal?.aborted && curatedRequest.current === request) setCuratedMessage("Sign-in cancelled.");
          return;
        }
        // The popup's outcome is advisory: re-read the owner-authenticated
        // status and report what the server says, not what a message claimed.
        if (current() && (await refresh(session.signal))) {
          const status = latestOverview.current?.connectors.find(
            (item) => item.connectorId === connectorId,
          )?.status;
          setCuratedMessage(
            status === "connected" ? `${name} connected.` : "Sign-in did not finish. Try again.",
          );
        }
      } catch {
        if (current()) setCuratedMessage(`Could not start ${name}. Try again.`);
      } finally {
        if (attempt) clearCuratedPopupAttempt(attempt);
        signal?.removeEventListener("abort", endSession);
        attemptCancel.signal.removeEventListener("abort", endSession);
        session.signal.removeEventListener("abort", close);
        popup.close();
        if (curatedPopupSession.current === session) curatedPopupSession.current = null;
        if (curatedPopupCancel.current === attemptCancel) {
          curatedPopupCancel.current = null;
          if (!signal?.aborted) {
            setCuratedPopupPending(false);
            setCuratedPopupFor(null);
          }
        }
        if (curatedRequest.current === request && !signal?.aborted) setCuratedBusy(false);
        curatedLock.current = false;
      }
    })();
  };
  const confirmAction = () => {
    const target = confirm;
    // One change per target at a time: a second tap in the same frame reads
    // the same `confirm`, so the guard has to be synchronous.
    if (!target || changesInFlight.current.has(target)) return;
    setConfirm(null);
    if (target.startsWith("curated:")) {
      const connectorId = target.slice("curated:".length);
      const token = vaultOwnerToken;
      const signal = controller.current?.signal;
      if (
        !overview?.connectors.some(
          (item) => item.connectorId === connectorId && item.curatedOAuth === true,
        ) ||
        !token || !signal || signal.aborted || curatedBusy
      ) return;
      changesInFlight.current.add(target);
      const request = ++curatedRequest.current;
      curatedDisconnectId.current = connectorId;
      beginDisconnect(connectorId);
      setCuratedBusy(true);
      void ExternalConnectorService.disconnect({ vaultOwnerToken: token, connectorId })
        .then(async () => {
          if (signal.aborted || currentToken.current !== token || curatedRequest.current !== request) return;
          setCuratedMessage("Disconnected.");
          await refresh(signal);
          if (signal.aborted || curatedRequest.current !== request) return;
          endDisconnect(connectorId);
        })
        .catch(() => {
          if (!signal.aborted && currentToken.current === token && curatedRequest.current === request) {
            setCuratedMessage("Could not disconnect. Try again.");
            endDisconnect(connectorId, DISCONNECT_FAILED);
          }
        })
        .finally(() => {
          if (curatedRequest.current !== request) return;
          changesInFlight.current.delete(target);
          curatedDisconnectId.current = null;
          if (!signal.aborted) setCuratedBusy(false);
        });
      return;
    }
    if (target.startsWith("plaid:") && activeConnector === "plaid") {
      const itemId = target.slice("plaid:".length);
      const financialData = financial.data?.data;
      const ownerId = user?.uid;
      const ownerToken = vaultOwnerToken;
      const key = vaultKey;
      const signal = controller.current?.signal;
      if (!itemId || !financialData || !ownerId || !ownerToken || !key || !signal || signal.aborted || plaidBusy) return;
      if (!vaultConnections(financialData)[itemId]) return;
      changesInFlight.current.add(target);
      beginDisconnect("plaid");
      setPlaidBusy(true);
      void disconnectVaultPlaid({ userId: ownerId, vaultKey: key, vaultOwnerToken: ownerToken, itemId, financial: financialData, surface: Capacitor.getPlatform() === "ios" ? "ios" : Capacitor.getPlatform() === "android" ? "android" : "web" })
        .then(async (disconnected) => {
          if (signal.aborted || currentToken.current !== ownerToken) return;
          setPlaidMessage(disconnected ? "Bank disconnected." : "Could not disconnect this bank. Retry.");
          endDisconnect("plaid", disconnected ? undefined : DISCONNECT_FAILED);
          if (disconnected) await financial.refresh({ force: true });
        })
        .catch(() => {
          if (!signal.aborted && currentToken.current === ownerToken) {
            setPlaidMessage("Could not disconnect this bank. Retry.");
            endDisconnect("plaid", DISCONNECT_FAILED);
          }
        })
        .finally(() => {
          changesInFlight.current.delete(target);
          if (!signal.aborted && currentToken.current === ownerToken) setPlaidBusy(false);
        });
      return;
    }
    if (target === "calendar") {
      const ownerId = user?.uid;
      const ownerToken = vaultOwnerToken;
      const signal = controller.current?.signal;
      if (!ownerId || !ownerToken || !user || !signal || signal.aborted || calendarBusy) return;
      changesInFlight.current.add(target);
      beginDisconnect("calendar");
      setCalendarBusy(true);
      void user.getIdToken()
        .then((idToken) => {
          if (signal.aborted || user.uid !== ownerId || currentToken.current !== ownerToken) return null;
          return GoogleCalendarService.disconnect(idToken, ownerId);
        })
        .then((result) => {
          if (!result || signal.aborted || user.uid !== ownerId || currentToken.current !== ownerToken) return;
          setCalendarMessage("Calendar disconnected.");
          endDisconnect("calendar");
          calendar.refresh();
        })
        .catch(() => {
          if (!signal.aborted && currentToken.current === ownerToken) {
            setCalendarMessage("Could not disconnect Calendar. Try again.");
            endDisconnect("calendar", DISCONNECT_FAILED);
          }
        })
        .finally(() => {
          changesInFlight.current.delete(target);
          if (!signal.aborted) {
            setCalendarBusy(false);
            endDisconnect("calendar");
          }
        });
      return;
    }
    updatePendingSelection(null);
    if (target === "mail") {
      const signal = controller.current?.signal;
      if (mailLock.current || !signal || signal.aborted) return;
      mailLock.current = true;
      changesInFlight.current.add(target);
      beginDisconnect("gmail");
      setMailBusy(true);
      void gmail
        .disconnectGmail()
        .then(() => {
          if (signal.aborted) return;
          setMailMessage("Mail disconnected. Drive is unchanged.");
          endDisconnect("gmail");
        })
        .catch(() => {
          if (signal.aborted) return;
          setMailMessage("Could not disconnect Mail. Check and retry.");
          endDisconnect("gmail", DISCONNECT_FAILED);
        })
        .finally(() => {
          mailLock.current = false;
          changesInFlight.current.delete(target);
          if (!signal.aborted) setMailBusy(false);
        });
      return;
    }
    if (target === "drive") {
      if (driveLock.current) return;
      changesInFlight.current.add(target);
      beginDisconnect("google_drive");
      void runDrive(async (token, signal) => {
        let result: Awaited<ReturnType<typeof ExternalConnectorService.disconnect>>;
        try {
          result = await ExternalConnectorService.disconnect({
            vaultOwnerToken: token,
            connectorId: "google_drive",
          });
        } catch (error) {
          if (!signal.aborted) endDisconnect("google_drive", DISCONNECT_FAILED);
          throw error;
        }
        if (signal.aborted) return;
        setDocuments([]);
        setDriveMessage(
          result.revocationOutcome === "revoked"
            ? "Drive disconnected. Mail is unchanged."
            : "Drive is disabled in One. Google revocation was not confirmed; remove access in your Google account if needed.",
        );
        endDisconnect("google_drive");
        await refresh(signal);
        await refreshDocuments(signal);
      }).finally(() => {
        changesInFlight.current.delete(target);
        endDisconnect("google_drive");
      });
      return;
    }
    // A selected Drive file, offered only from the Drive detail.
    if (activeConnector !== "google_drive") return;
    void runDrive(async (token, signal) => {
      await ExternalConnectorService.removeDocument(token, target);
      if (!signal.aborted) {
        await refresh(signal);
        await refreshDocuments(signal);
      }
    });
  };
  const confirmBusy =
    confirm === "mail"
      ? mailBusy
      : confirm === "calendar"
        ? calendarBusy
        : confirm?.startsWith("curated:")
          ? curatedBusy
        : confirm?.startsWith("plaid:")
          ? plaidBusy
          : driveBusy;
  const mailConnected = Boolean(gmail.status?.connected && !gmail.status?.needs_reauth);
  const driveConnected = ["connected", "verifying"].includes(drive?.status ?? "");
  const calendarNeedsReconnect = calendar.status?.status === "needs_reauth";
  const calendarStatusLabel = calendar.error
    ? "Status unavailable"
    : !calendar.loaded
      ? "Checking Calendar connection…"
      : calendar.connected
        ? "Connected"
        : calendarNeedsReconnect
          ? "Reconnect needed"
          : "Not connected";
  const calendarDescription = calendar.error
    ? "We couldn’t check your calendar connection."
    : !calendar.loaded
      ? "Checking your calendar connection."
      : calendar.connected
        ? calendar.status?.access_level === "manage"
          ? "Your private agent can help schedule meetings. You approve every change."
          : "Your private agent can check your availability."
        : calendarNeedsReconnect
          ? "Reconnect to keep planning around your schedule."
          : "Plan around your schedule.";
  const calendarConnectLabel = calendarNeedsReconnect
    ? "Reconnect Calendar"
    : "Connect Calendar";
  const showConnector = (id: string) => {
    setConfirm(null);
    setActiveConnector(id);
  };
  const entries: ConnectorListEntry[] = [
    {
      id: "gmail",
      name: "Gmail",
      detail: gmail.status?.needs_reauth ? "Sign-in needed" : undefined,
      connected: mailConnected,
      onOpen: () => showConnector("gmail"),
      pending: disconnecting.gmail ? "disconnect" : mailPopupPending ? "connect" : undefined,
      failure: disconnectFailures.gmail,
      action: mailConnected
        ? { label: "Disconnect Gmail", onClick: () => askToDisconnect("gmail", "mail", true), disabled: mailBusy }
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
      detail: drive?.status === "needs_reauth"
        ? "Sign-in needed"
        : canConnectDrive && driveConnectionProfile === "selected"
          ? "Selected files only"
          : undefined,
      connected: driveConnected,
      onOpen: () => showConnector("google_drive"),
      pending: disconnecting.google_drive ? "disconnect" : drivePopupPending ? "connect" : undefined,
      failure: disconnectFailures.google_drive,
      action: driveConnected
        ? { label: "Disconnect Google Drive", onClick: () => askToDisconnect("google_drive", "drive", true), disabled: driveBusy }
        : !canConnectDrive
          ? undefined
        : {
            label: driveConnectionProfile === "live" ? "Review Google Drive access" : "Connect Google Drive",
            onClick: () => {
              showConnector("google_drive");
              if (driveConnectionProfile !== "live") startDrive(driveConnectionProfile);
            },
            disabled: driveBusy || loading || !canConnectDrive,
          },
      trailingText: !driveConnected && !canConnectDrive
        ? loading ? "Checking…" : statusChecked ? "Unavailable" : "Check connection"
        : undefined,
    },
    {
      id: "calendar",
      name: "Calendar",
      connected: calendar.connected,
      onOpen: () => showConnector("calendar"),
      pending: disconnecting.calendar ? "disconnect" : calendarPopupPending ? "connect" : undefined,
      failure: disconnectFailures.calendar,
      detail: calendar.error
        ? "Status unavailable"
        : !calendar.loaded
          ? "Checking connection…"
          : calendar.connected
            ? "Connected"
            : calendarNeedsReconnect
              ? "Reconnect needed"
              : "Plan around your schedule.",
      action: !calendar.loaded || calendar.error ? undefined : {
        label: calendar.connected ? "Disconnect Calendar" : calendarConnectLabel,
        onClick: () => {
          if (calendar.connected) {
            askToDisconnect("calendar", "calendar", true);
            return;
          }
          showConnector("calendar");
          connectCalendar();
        },
        disabled: calendarBusy,
      },
      trailingText: !calendar.loaded ? "Checking…" : undefined,
    },
    {
      id: "plaid",
      name: "Plaid",
      connected: plaidConnections.length > 0,
      onOpen: () => showConnector("plaid"),
      pending: disconnecting.plaid ? "disconnect" : undefined,
      failure: disconnectFailures.plaid,
      detail: financial.error
        ? "Status unavailable"
        : financial.loading
          ? "Checking connection…"
          : plaidConnections.some((item) => item.status === "needs_relink")
            ? "Sign-in needed"
            : undefined,
    },
    ...(overview?.connectors ?? [])
      .filter((item, index, items) => {
        if (["google_drive", "gmail", "calendar", "plaid"].includes(item.connectorId)) return false;
        if (items.findIndex((candidate) => candidate.connectorId === item.connectorId) !== index) return false;
        // A reviewed manifest may request a card before its runtime row is
        // actionable. It is still rendered, but can never grant OAuth itself.
        if (item.catalogCard === true) return true;
        // A curated connector shows when it can accept a new grant, or while
        // an existing owner grant still needs a Disconnect/recovery path.
        if (item.curatedOAuth === true) {
          const hasExistingGrant = !["not_connected", "revoked"].includes(item.status);
          return (curatedRolloutEnabled && item.available === true) || hasExistingGrant;
        }
        return true;
      })
      .map((item): ConnectorListEntry => {
        const storedGrant = !["not_connected", "revoked"].includes(item.status);
        const curated = item.curatedOAuth === true;
        const canStartCurated =
          curated && curatedRolloutEnabled && item.available === true;
        const catalogStateLabel =
          item.catalogState === "setup_pending"
            ? "Setup pending"
            : item.catalogState === "discovery_pending"
              ? "Discovery pending"
              : item.catalogState === "unavailable"
                ? "Unavailable"
                : undefined;
        // A curated connection stuck before verification cannot be used by Kai,
        // so it reads as needing sign-in rather than as connected.
        const signInNeeded =
          item.status === "needs_reauth" || (curated && item.status === "verifying");
        return {
          id: item.connectorId,
          name: item.displayName,
          detail:
            catalogStateLabel ??
            (signInNeeded && canStartCurated
              ? "Sign-in needed"
              : curated && storedGrant && !canStartCurated
                ? "Unavailable"
                : undefined),
          connected: curated ? item.status === "connected" : storedGrant,
          onOpen: storedGrant || canStartCurated ? () => showConnector(item.connectorId) : undefined,
          pending: disconnecting[item.connectorId] ? "disconnect" : undefined,
          failure: disconnectFailures[item.connectorId],
          action: !curated
            ? undefined
            : canStartCurated && (signInNeeded || !storedGrant)
              ? {
                  label: `${signInNeeded ? "Reconnect" : "Connect"} ${item.displayName}`,
                  onClick: () => {
                    showConnector(item.connectorId);
                    connectCurated(item.connectorId, item.displayName);
                },
                disabled: curatedBusy || loading,
              }
              : storedGrant
                ? {
                  label: `Disconnect ${item.displayName}`,
                  onClick: () => askToDisconnect(item.connectorId, `curated:${item.connectorId}`, true),
                  disabled: curatedBusy,
                }
                : undefined,
          trailingText:
            catalogStateLabel ??
            (!storedGrant && !curated ? labels[item.status] : undefined),
        };
      }),
  ];
  const query = search.trim().toLocaleLowerCase();
  const matchingEntries = entries.filter(
    (entry) =>
      !query ||
      `${entry.name} ${entry.detail ?? ""}`.toLocaleLowerCase().includes(query),
  );
  // A row the person acted on from the list keeps its section until they next
  // arrive at the list: the list never re-sorts under their finger.
  const sitsInConnected = (entry: ConnectorListEntry) =>
    pinnedSections[entry.id] ?? entry.connected;
  const connectedEntries = matchingEntries.filter(sitsInConnected);
  const availableEntries = matchingEntries.filter((entry) => !sitsInConnected(entry));
  const selectedCatalog = overview?.connectors.find(
    (item) => item.connectorId === activeConnector,
  );
  const canStartSelectedCurated = Boolean(
    selectedCatalog &&
      selectedCatalog.curatedOAuth === true &&
      curatedRolloutEnabled &&
      selectedCatalog.available === true,
  );

  const inProfile = surface === "profile";
  const listSections = [
    ["Connected", connectedEntries],
    ["Available", availableEntries],
  ] as const;
  const catalogState = !overview && loading ? (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      Loading connector catalog…
    </p>
  ) : catalogLoadFailed ? (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/10 px-3 py-2">
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        Connector catalog unavailable. Try again.
      </p>
      <Button
        size="compact"
        variant="ghost"
        className={touch}
        onClick={() => void refresh(controller.current?.signal)}
        disabled={loading}
      >
        Retry connector catalog
      </Button>
    </div>
  ) : null;
  return (
    <div
      ref={panelRootRef}
      className={
        inProfile
          ? "flex min-w-0 flex-col text-foreground"
          : "flex h-full min-h-0 flex-col bg-background text-foreground"
      }
      data-connections-panel
      data-connection-compact={activeConnector === "google_drive" && statusChecked && !loading && drive?.status === "connected" && !pending ? "" : undefined}
      data-surface={surface}
    >
      {inProfile ? null : <header className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4">
        {activeConnector ? (
          <ShellActionSurface
            ref={detailBackRef}
            className="size-11"
            onClick={() => {
              setConfirm(null);
              setActiveConnector(null);
            }}
            aria-label="Back to connectors"
          >
            <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
          </ShellActionSurface>
        ) : null}
        {activeConnector ? <ConnectorGlyph id={activeConnector} /> : null}
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {activeConnector
            ? entries.find((entry) => entry.id === activeConnector)?.name || "Connector"
            : "Connectors"}
        </h2>
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
      </header>}
      <div
        className={
          inProfile
            ? "min-w-0 space-y-5"
            : "min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        }
      >
        {!vaultOwnerToken ? (
          <p role="status" className="text-sm text-muted-foreground">
            Unlock your vault to manage connectors.
          </p>
        ) : !activeConnector && inProfile ? (
          <>
            {catalogState}
            {listSections.map(([heading, items]) =>
              items.length === 0 ? null : (
                <SettingsGroup key={heading} title={heading} testId={`profile-connectors-${heading.toLowerCase()}`}>
                  {items.map((entry) => <ProfileConnectorRow key={entry.id} entry={entry} />)}
                </SettingsGroup>
              ),
            )}
            {open && user?.uid && vaultKey && vaultOwnerToken ? <CustomConnectorsSettings
              key={user.uid}
              access={{ userId: user.uid, vaultKey, vaultOwnerToken }}
              onPrepareRecovery={onPrepareRecovery}
            /> : null}
          </>
        ) : !activeConnector ? (
          <>
            <label className="flex min-h-11 items-center gap-2 rounded-full bg-foreground/10 px-4 text-muted-foreground focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
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
            {catalogState}
            {listSections.map(([heading, items]) =>
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
            {!query && open && user?.uid && vaultKey && vaultOwnerToken ? <CustomConnectorsSettings
              key={user.uid}
              access={{ userId: user.uid, vaultKey, vaultOwnerToken }}
              onPrepareRecovery={onPrepareRecovery}
            /> : null}
          </>
        ) : (
          <div
            key={activeConnector}
            ref={detailRegionRef}
            tabIndex={-1}
            data-connector-detail={activeConnector}
            className="min-w-0 space-y-5 focus:outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150"
          >
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
                      ? "Sign-in needed"
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
                    Connect Mail
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
              {gmail.status?.connected && (
                <div className="divide-y rounded-lg border border-border px-3 text-sm" aria-label="Gmail permissions">
                  <div className="flex min-h-11 items-center justify-between gap-3"><span>Read mail</span><span className="text-muted-foreground">Allowed</span></div>
                  <div className="flex min-h-11 items-center justify-between gap-3"><span>Send mail</span><span className="text-muted-foreground">{gmail.status.send_permission_granted ? "Allowed · review required" : "Not enabled"}</span></div>
                  <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1">
                    <span>Drafts</span>
                    {gmail.status.compose_permission_granted ? <span className="text-muted-foreground">Allowed · review required</span>
                      : <Button size="compact" variant="outline" aria-label="Enable Gmail drafts" disabled={mailBusy || gmail.loadingStatus}
                        onClick={() => connectMail("compose")}>Enable</Button>}
                  </div>
                </div>
              )}
              {mailPopupPending && <Button size="compact" variant="outline" onClick={() => mailPopupCancel.current?.abort()}>Cancel sign-in</Button>}
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
              className="space-y-3"
            >
              <h3 id="connection-drive-title" className="sr-only">
                Google Drive
              </h3>
              {statusChecked && !loading && drive?.status === "connected" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-foreground/5 px-4 py-3 text-sm">
                  <span className="min-w-0 break-all text-muted-foreground">{drive.accountLabel || "Google Drive"}</span>
                  <span role="status" className="font-medium">Connected</span>
                </div>
              ) : (
                <>
                  <p className="break-all text-sm text-muted-foreground">
                    {drive?.accountLabel || "Search and read files"}
                  </p>
                  <p role="status" className="text-sm">
                    {loading
                      ? "Checking Drive…"
                      : !statusChecked
                        ? "Connection status unavailable"
                        : drive
                          ? (labels[drive.status] ?? "Status unavailable")
                          : "Not connected"}
                  </p>
                </>
              )}
              {overview?.features.google_drive_live === true &&
                (drive?.status !== "connected" || drive?.profile !== "live") && (
                <p className="text-sm text-muted-foreground">
                  Full Drive access turns on background reads by default unless you turned them off. While you’re away, One may search Drive, send excerpts to Gemini, and share matching originals for document requests from accepted Trusted Circle members without asking again. The requester can open a file only after Google confirms access. Turn background access off anytime; your choice is saved.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {canConnectDrive && (!hasDriveGrant ||
                  drive?.status === "needs_reauth" ||
                  drive?.status === "error") && (
                  <Button
                    size="compact"
                    className={touch}
                    disabled={driveBusy || loading}
                    onClick={() => startDrive(driveConnectionProfile)}
                  >
                    Connect Drive
                  </Button>
                )}
                {canConnectDrive &&
                  drive?.status === "connected" && drive?.profile !== "live" && (
                    <Button
                      className={touch}
                      disabled={driveBusy || loading}
                      onClick={() => startDrive("live")}
                    >
                      Enable full Drive access
                    </Button>
                  )}
                {hasDriveGrant && drive?.status !== "connected" && (
                  <Button
                    className={touch}
                    variant="outline"
                    disabled={driveBusy}
                    onClick={() => setConfirm("drive")}
                  >
                    Disconnect Drive
                  </Button>
                )}
                {(!statusChecked || (!canConnectDrive && drive?.status !== "connected") || drive?.status === "error") && <Button
                  size="compact"
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
                </Button>}
              </div>
              {drivePopupPending && <Button size="compact" variant="outline" onClick={() => drivePopupCancel.current?.abort()}>Cancel sign-in</Button>}
              {canConnectDrive && driveConnectionProfile === "selected" && !hasDriveGrant && (
                <p className="text-sm text-muted-foreground">
                  You can choose files after connecting. One cannot search your entire Drive with this access.
                </p>
              )}
              {drive?.profile === "live" && drive.status === "connected" && (
                <div className="rounded-2xl bg-foreground/5 px-4 py-3">
                  <label htmlFor={driveBackgroundId} className={`flex min-h-11 items-center justify-between gap-4${liveBackground === null ? "" : " cursor-pointer"}`}>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">Background Drive access</span>
                      <span className="block text-xs text-muted-foreground">On by default. One may read Drive files, send excerpts to Gemini, and share matching originals for requests from accepted Trusted Circle members while you’re away. Turn off anytime.</span>
                    </span>
                    {liveBackground !== null ? <Switch id={driveBackgroundId} size="ios" aria-label="Background Drive access" checked={liveBackground}
                      disabled={driveBusy}
                      onCheckedChange={(next) => void runDrive(async (token) => {
                        const confirmed = await ExternalConnectorService.setLiveBackground(token, next);
                        setLiveBackground(confirmed);
                        setDriveMessage(confirmed ? "Background Drive access is on." : "Background Drive access is off. New automatic document requests will wait.");
                      })}
                    /> : null}
                  </label>
                  {liveBackground === null ? <div className="mt-2 text-xs text-muted-foreground">
                    {liveBackgroundError ? <>
                      Couldn’t check background Drive access. <Button size="compact" variant="ghost" onClick={() => retryLiveBackground((attempt) => attempt + 1)}>Retry setting</Button>
                    </> : "Checking background Drive access…"}
                  </div> : <p className="mt-2 text-xs text-muted-foreground">
                    {liveBackground ? "On. Relevant work can continue while you’re away." : "Off. New automatic document requests wait until you turn this on."}
                  </p>}
                </div>
              )}
              {drive?.profile === "live" && drive.status === "connected" && (
                <details className="group rounded-2xl bg-foreground/5 text-sm">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
                    Sharing and approval
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                  </summary>
                  <p className="px-4 pb-4 text-muted-foreground">
                    Sharing a file needs your approval, document trust, or an accepted connection in your Trusted Circle while background Drive access is on. Google Drive confirms each file’s access before the requester can open it.
                  </p>
                </details>
              )}
              {vaultOwnerToken ? <TrustedDocumentRules token={vaultOwnerToken} /> : null}
              {hasDriveGrant && drive?.status === "connected" && (
                <Button className={`${touch} self-start px-0 text-destructive`} variant="ghost" disabled={driveBusy}
                  onClick={() => setConfirm("drive")}>Disconnect Drive</Button>
              )}
              {statusChecked && !canConnectDrive && !hasDriveGrant && (
                <p className="text-sm text-muted-foreground">
                  Drive sign-in is not configured here. Try again later.
                </p>
              )}
              <p
                role="status"
                aria-live="polite"
                className="text-sm text-muted-foreground"
              >
                {drivePopupPending
                  ? "Preparing secure Google sign-in…"
                  : driveBusy
                    ? "Updating Drive…"
                    : driveMessage}
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
                      <span>Prepare these files while the app is closed. Relevant excerpts may be sent to Gemini. Prepared file information is stored outside your vault. Sharing still needs your approval.</span>
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
                <div className="flex flex-wrap gap-2">
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
                {documents.length > 0 && (
                  <Button className={touch} variant="ghost" disabled={driveBusy}
                    onClick={() => {
                      const signal = controller.current?.signal;
                      if (signal) void refreshDocuments(signal).catch(() => {
                        if (!signal.aborted) setDriveMessage("Could not refresh files. Try again.");
                      });
                    }}>Refresh files</Button>
                )}
                </div>
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
                          <span>Prepare this file while the app is closed. Excerpts may be sent to Gemini. Prepared information is stored outside your vault. Turning this off stops new preparation; remove the file to clear what was prepared. Sharing still needs your approval.</span>
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
            {activeConnector === "calendar" && (
              <section
                aria-label="Calendar details"
                className="space-y-6 rounded-3xl border border-border bg-foreground/[0.04] p-5 sm:p-6"
              >
                <div className="space-y-1.5">
                  <h3 className="text-xl font-semibold tracking-tight">
                    Google Calendar
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {calendarDescription}
                  </p>
                </div>

                <div className="space-y-3">
                  <p role="status" className="text-lg font-medium">
                    {calendarStatusLabel}
                  </p>
                  {calendar.connected ? (
                    <Button
                      className={touch}
                      size="compact"
                      variant="outline"
                      disabled={calendarBusy}
                      onClick={() => setConfirm("calendar")}
                    >
                      Disconnect Calendar
                    </Button>
                  ) : (
                    <Button
                      className={`${touch} h-12 px-6 text-base font-semibold`}
                      disabled={calendarBusy}
                      onClick={() => connectCalendar()}
                    >
                      {calendarConnectLabel}
                    </Button>
                  )}
                  {!calendar.error && !calendar.connected && !calendarNeedsReconnect ? (
                    <p className="text-sm text-muted-foreground">
                      Private by default. Disconnect anytime.
                    </p>
                  ) : calendar.connected ? (
                    <p className="text-sm text-muted-foreground">
                      Disconnect anytime.
                    </p>
                  ) : null}
                  {calendarPopupPending && (
                    <Button
                      size="compact"
                      variant="outline"
                      onClick={() => calendarPopupCancel.current?.abort()}
                    >
                      Cancel sign-in
                    </Button>
                  )}
                  {calendar.error ? (
                    <Button
                      size="compact"
                      variant="ghost"
                      onClick={() => calendar.refresh()}
                    >
                      Retry
                    </Button>
                  ) : null}
                  {calendarBusy || calendarMessage ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="text-sm text-muted-foreground"
                    >
                      {calendarPopupPending
                        ? "Finish signing in with Google in the window that opened."
                        : calendarBusy
                          ? "Updating Calendar…"
                          : calendarMessage}
                    </p>
                  ) : null}
                </div>
              </section>
            )}
            {activeConnector === "plaid" && (
              <section className="space-y-3" aria-label="Plaid connection details">
                <p className="text-sm text-muted-foreground">
                  {financial.error ? "Could not check bank connections." : financial.loading ? "Checking bank connections…" : plaidConnections.length ? `${plaidConnections.length} connected ${plaidConnections.length === 1 ? "bank" : "banks"}` : "No banks connected"}
                </p>
                {Object.entries(vaultConnections(financial.data?.data)).map(([itemId, connection]) => (
                  <div key={itemId} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{connection.institution_name || "Bank connection"}</p>
                      <p className="text-xs text-muted-foreground">{connection.status === "needs_relink" ? "Reconnect needed" : "Connected"}</p>
                    </div>
                    <Button className={touch} size="compact" variant="outline" disabled={plaidBusy} onClick={() => setConfirm(`plaid:${itemId}`)}>
                      Disconnect
                    </Button>
                  </div>
                ))}
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{plaidBusy ? "Disconnecting bank…" : plaidMessage}</p>
                {!plaidConnections.length && !financial.loading && !financial.error && (
                  <Button className={touch} size="compact" variant="outline" onClick={() => { onBack(); router.push(ROUTES.KAI_PORTFOLIO_SOURCES); }}>
                    Connect a bank
                  </Button>
                )}
              </section>
            )}
            {selectedCatalog && !["google_drive", "gmail", "calendar", "plaid"].includes(activeConnector ?? "") && (
              <section className="space-y-3 rounded-xl border border-border p-3" aria-label={`${selectedCatalog.displayName} details`}>
                <h3 className="font-semibold">{selectedCatalog.displayName}</h3>
                <p className="text-sm text-muted-foreground">{selectedCatalog.description}</p>
                {selectedCatalog.accountLabel ? <p className="break-all text-sm">{selectedCatalog.accountLabel}</p> : null}
                <p role="status" className="text-sm">
                  {selectedCatalog.curatedOAuth === true &&
                  !canStartSelectedCurated &&
                  !["not_connected", "revoked"].includes(selectedCatalog.status)
                    ? "Unavailable"
                    : selectedCatalog.curatedOAuth === true &&
                        selectedCatalog.status === "verifying"
                      ? "Sign-in needed"
                    : (labels[selectedCatalog.status] ?? "Status unavailable")}
                </p>
                {selectedCatalog.curatedOAuth === true ? (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {canStartSelectedCurated &&
                      ["not_connected", "revoked", "needs_reauth", "verifying"].includes(selectedCatalog.status) ? (
                        <Button
                          className={touch}
                          disabled={curatedBusy || loading}
                          onClick={() => connectCurated(selectedCatalog.connectorId, selectedCatalog.displayName)}
                        >
                          {["needs_reauth", "verifying"].includes(selectedCatalog.status) ? "Reconnect" : "Connect"}
                        </Button>
                      ) : null}
                      {curatedPopupPending && curatedPopupFor === selectedCatalog.connectorId ? (
                        <Button className={touch} variant="outline" onClick={() => curatedPopupCancel.current?.abort()}>
                          Cancel sign-in
                        </Button>
                      ) : null}
                      {!["not_connected", "revoked"].includes(selectedCatalog.status) ? (
                        <Button
                          className={touch}
                          variant="outline"
                          disabled={curatedBusy}
                          onClick={() => setConfirm(`curated:${selectedCatalog.connectorId}`)}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </div>
                    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                      {curatedBusy ? "Working…" : curatedMessage}
                    </p>
                  </>
                ) : null}
              </section>
            )}
          </div>
        )}
      </div>
      <ConnectorConfirm
        target={confirm}
        busy={confirmBusy}
        onConfirm={confirmAction}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
