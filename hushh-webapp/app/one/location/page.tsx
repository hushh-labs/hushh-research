"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  LocateFixed,
  MapPin,
  RefreshCw,
  Send,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { useRequireAuth } from "@/hooks/use-auth";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import {
  decryptLocationEnvelope,
  encryptLocationForRecipient,
  ensureLocationRecipientKey,
} from "@/lib/one-location/encryption";
import {
  buildOneLocationNotificationHref,
  isOneLocationGrantOpened,
  locationShareNotificationDescription,
  markOneLocationGrantOpened,
  ONE_LOCATION_GRANT_ID_PARAM,
  ONE_LOCATION_GRANT_OPENED_EVENT,
  ONE_LOCATION_NOTIFICATION_OPEN_PARAM,
  ONE_LOCATION_NOTIFICATION_OPEN_VALUE,
  playOneLocationNotificationSound,
  recordOneLocationShareNotification,
} from "@/lib/one-location/notifications";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationAccessRequest,
  OneLocationGrant,
  OneLocationPublicInvite,
  OneLocationPublicInviteSubmission,
  OneLocationRecipient,
  OneLocationState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { AccountIdentityService } from "@/lib/services/account-identity-service";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { useVault } from "@/lib/vault/vault-context";

const DURATION_OPTIONS = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

const LIVE_LOCATION_UPDATE_INTERVAL_MS = 20_000;

type BusyState =
  | "load"
  | "share"
  | "publish"
  | "view"
  | "request"
  | "approve"
  | "deny"
  | "refer"
  | "revoke"
  | "publicInvite"
  | "publicRevoke"
  | null;

function formatDateTime(value?: string | null): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function expiresLabel(grant: OneLocationGrant): string {
  if (grant.status === "revoked") return "Revoked";
  if (grant.status === "expired") return "Expired";
  return `Expires ${formatDateTime(grant.expiresAt)}`;
}

function recipientLabel(recipient: OneLocationRecipient): string {
  return [recipient.displayName, recipient.maskedPhone]
    .filter(Boolean)
    .join(" - ");
}

function grantCounterpartyLabel(grant: OneLocationGrant): string {
  return (
    [grant.recipientDisplayName, grant.recipientMaskedPhone]
      .filter(Boolean)
      .join(" - ") || grant.recipientUserId
  );
}

function receivedGrantOwnerLabel(grant: OneLocationGrant): string {
  return (
    [grant.ownerDisplayName, grant.ownerMaskedPhone]
      .filter(Boolean)
      .join(" - ") ||
    [grant.recipientDisplayName, grant.recipientMaskedPhone]
      .filter(Boolean)
      .join(" - ") ||
    grant.ownerUserId
  );
}

function requestLabel(request: OneLocationAccessRequest): string {
  return (
    [request.requesterDisplayName, request.requesterMaskedPhone]
      .filter(Boolean)
      .join(" - ") || request.requesterUserId
  );
}

function publicSubmissionLabel(
  submission: OneLocationPublicInviteSubmission,
): string {
  return (
    [submission.visitorDisplayName, submission.visitorMaskedPhone]
      .filter(Boolean)
      .join(" - ") || "Public request"
  );
}

function publicInviteUrlLabel(value: string): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (typeof window === "undefined") return value;
  return new URL(value, window.location.origin).toString();
}

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "approved") return "default";
  if (status === "revoked" || status === "denied") return "destructive";
  if (status === "expired" || status === "cancelled") return "secondary";
  return "outline";
}

function isTransientOneApiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 502 || status === 503 || status === 504;
}

function oneLocationErrorMessage(error: unknown, fallback: string): string {
  if (isTransientOneApiError(error)) {
    return "One is still catching up. Please refresh once, then check this page before retrying.";
  }
  return error instanceof Error ? error.message : fallback;
}

function permissionCopy(permission: HushhLocationPermissionState | null): {
  title: string;
  description: string;
  tone: "default" | "destructive";
} {
  if (!permission) {
    return {
      title: "Checking location permission",
      description:
        "One is checking foreground location access for this device.",
      tone: "default",
    };
  }
  if (permission.state === "denied") {
    return {
      title: "Location permission not granted",
      description:
        "Enable foreground location permission before sharing your live location.",
      tone: "destructive",
    };
  }
  if (permission.state === "restricted" || permission.state === "unavailable") {
    return {
      title: "Precise location unavailable",
      description:
        "This device cannot provide a precise foreground location right now.",
      tone: "destructive",
    };
  }
  if (permission.background === "foreground-only") {
    return {
      title: "Foreground sharing only",
      description:
        "v1 publishes one foreground update at a time. Background sharing is not enabled.",
      tone: "default",
    };
  }
  return {
    title: "Ready for foreground sharing",
    description:
      "Coordinates are encrypted on this device before One stores the envelope.",
    tone: "default",
  };
}

function LocalMapPreview({ point }: { point: PlainLocationPoint }) {
  const captured = formatDateTime(point.capturedAt);
  return (
    <div className="overflow-hidden rounded-[var(--app-card-radius-standard)] border border-border/70 bg-[color:var(--app-card-surface-default-solid)]">
      <div className="relative h-44 bg-[linear-gradient(to_right,rgba(15,23,42,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.08)_1px,transparent_1px)] bg-[length:28px_28px] dark:bg-[linear-gradient(to_right,rgba(255,255,255,0.10)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.10)_1px,transparent_1px)]">
        <div className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 shadow-[var(--shadow-xs)] dark:text-emerald-200">
          <MapPin className="h-6 w-6" aria-hidden="true" />
        </div>
      </div>
      <div className="grid gap-2 p-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Lat
          </div>
          <div className="font-mono text-foreground">
            {point.latitude.toFixed(6)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Lng
          </div>
          <div className="font-mono text-foreground">
            {point.longitude.toFixed(6)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Freshness
          </div>
          <div className="text-foreground">{captured}</div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-24 items-center gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-sm">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-muted/65 text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-xs leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  busy,
  busyKey,
  children,
  ...props
}: ComponentProps<typeof Button> & { busy: BusyState; busyKey: BusyState }) {
  return (
    <Button {...props} disabled={props.disabled || busy === busyKey}>
      {busy === busyKey ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </Button>
  );
}

function SkeletonRow({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-20 items-center gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
      <Skeleton className="h-9 w-9 shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className={wide ? "h-4 w-2/3" : "h-4 w-40"} />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
      <Skeleton className="hidden h-8 w-20 rounded-full sm:block" />
    </div>
  );
}

function OneLocationInitialSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="space-y-6">
        <SettingsGroup eyebrow="Device" title="Readiness">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </SettingsGroup>
        <SettingsGroup eyebrow="Share" title="Share with trusted person">
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
              <Skeleton className="h-11 rounded-xl" />
              <Skeleton className="h-11 rounded-xl" />
            </div>
            <Skeleton className="h-10 w-56 rounded-xl" />
          </div>
        </SettingsGroup>
        <SettingsGroup eyebrow="Request" title="Ask someone to share">
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <Skeleton className="h-11 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-10 w-40 rounded-xl" />
          </div>
        </SettingsGroup>
      </div>
      <div className="space-y-6">
        <SettingsGroup eyebrow="Owner" title="People who can see me">
          <SkeletonRow wide />
          <SkeletonRow />
        </SettingsGroup>
        <SettingsGroup eyebrow="Recipient" title="Shared with me">
          <SkeletonRow wide />
        </SettingsGroup>
        <SettingsGroup eyebrow="Approvals" title="Pending requests">
          <SkeletonRow />
        </SettingsGroup>
      </div>
    </div>
  );
}

export function OneLocationAgentPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const auth = useRequireAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const [state, setState] = useState<OneLocationState | null>(null);
  const [permission, setPermission] =
    useState<HushhLocationPermissionState | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState("");
  const [selectedRequestOwnerId, setSelectedRequestOwnerId] = useState("");
  const [durationHours, setDurationHours] = useState("1");
  const [requestMessage, setRequestMessage] = useState("");
  const [referralTargets, setReferralTargets] = useState<
    Record<string, string>
  >({});
  const [publicInviteUrl, setPublicInviteUrl] = useState("");
  const [decryptedPoints, setDecryptedPoints] = useState<
    Record<string, PlainLocationPoint>
  >({});
  const [openedGrantTick, setOpenedGrantTick] = useState(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const livePublishInFlightRef = useRef(false);
  const liveViewInFlightRef = useRef(false);

  const recipients = useMemo(
    () => state?.recipients ?? [],
    [state?.recipients],
  );
  const selectedRecipient = useMemo(
    () =>
      recipients.find(
        (recipient) => recipient.userId === selectedRecipientId,
      ) || null,
    [recipients, selectedRecipientId],
  );
  const selectedRequestOwner = useMemo(
    () =>
      recipients.find(
        (recipient) => recipient.userId === selectedRequestOwnerId,
      ) || null,
    [recipients, selectedRequestOwnerId],
  );
  const pendingOwnerRequests = useMemo(
    () =>
      (state?.requests ?? []).filter(
        (request) =>
          request.ownerUserId === auth.userId && request.status === "pending",
      ),
    [auth.userId, state?.requests],
  );
  const requestedByMe = useMemo(
    () =>
      (state?.requests ?? []).filter(
        (request) =>
          request.requesterUserId === auth.userId &&
          request.ownerUserId !== auth.userId,
      ),
    [auth.userId, state?.requests],
  );
  const visibleReceivedGrants = useMemo(() => {
    void openedGrantTick;
    return (state?.receivedGrants ?? []).filter((grant) =>
      isOneLocationGrantOpened(auth.userId, grant.id),
    );
  }, [auth.userId, openedGrantTick, state?.receivedGrants]);
  const activeOwnerGrants = useMemo(
    () =>
      (state?.ownerGrants ?? []).filter((grant) => grant.status === "active"),
    [state?.ownerGrants],
  );
  const activeVisibleReceivedGrants = useMemo(
    () => visibleReceivedGrants.filter((grant) => grant.status === "active"),
    [visibleReceivedGrants],
  );
  const hiddenReceivedGrantCount = (state?.receivedGrants ?? []).filter(
    (grant) =>
      grant.status === "active" &&
      !isOneLocationGrantOpened(auth.userId, grant.id),
  ).length;
  const activePublicInvites = useMemo(
    () =>
      (state?.publicInvites ?? []).filter(
        (invite) => invite.status === "active",
      ),
    [state?.publicInvites],
  );
  const publicSubmissions = useMemo(
    () => state?.publicInviteSubmissions ?? [],
    [state?.publicInviteSubmissions],
  );

  const openLocationShareFromNotification = useCallback(
    (grantId: string) => {
      if (!auth.userId) return;
      markOneLocationGrantOpened(auth.userId, grantId);
      setOpenedGrantTick((value) => value + 1);
      router.push(buildOneLocationNotificationHref(grantId), { scroll: false });
    },
    [auth.userId, router],
  );

  const showLocationShareToast = useCallback(
    (grant: OneLocationGrant) => {
      if (!auth.userId) return;
      const ownerLabel = receivedGrantOwnerLabel(grant);
      const toastKey = `one-location-share:${grant.id}`;
      const description = locationShareNotificationDescription(ownerLabel);
      playOneLocationNotificationSound();
      toast(
        <div className="flex flex-col gap-2">
          <div className="space-y-0.5">
            <p className="line-clamp-1 text-sm font-semibold">
              Location shared
            </p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {description}
            </p>
          </div>
          <button
            onClick={() => {
              toast.dismiss(toastKey);
              openLocationShareFromNotification(grant.id);
            }}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors"
          >
            Open
          </button>
        </div>,
        {
          id: toastKey,
          duration: 10000,
          position: "top-center",
        },
      );
    },
    [auth.userId, openLocationShareFromNotification],
  );

  const refresh = useCallback(async () => {
    if (!auth.userId) {
      setBusy(null);
      setLoadError("Sign in before loading location sharing.");
      return;
    }
    if (!vaultOwnerToken) {
      setBusy(null);
      setLoadError(
        isVaultUnlocked
          ? "Vault owner token is still unavailable. Lock and unlock the vault, then refresh."
          : "Unlock your vault before loading location sharing.",
      );
      return;
    }
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }
    const activeUserId = auth.userId;
    const activeUser = auth.user;
    const activeVaultOwnerToken = vaultOwnerToken;
    setBusy((current) => current ?? "load");
    const task = (async () => {
      setLoadError(null);
      try {
        if (activeUser) {
          await AccountIdentityService.syncCurrentUser(activeUser).catch(
            (error) => {
              console.warn(
                "[OneLocationAgent] Identity shadow sync skipped:",
                error,
              );
              return null;
            },
          );
        }
        const key = await ensureLocationRecipientKey(activeUserId);
        await OneLocationService.registerRecipientKey({
          vaultOwnerToken: activeVaultOwnerToken,
          keyId: key.keyId,
          publicKeyJwk: key.publicKeyJwk,
          algorithm: key.algorithm,
        });
        const [nextPermission, nextState] = await Promise.all([
          OneLocationService.getPermissionState().catch(() => ({
            state: "unavailable" as const,
            precise: false,
            background: "unavailable" as const,
          })),
          OneLocationService.getState(activeVaultOwnerToken),
        ]);
        setPermission(nextPermission);
        setState(nextState);
        setSelectedRecipientId(
          (current) => current || nextState.recipients[0]?.userId || "",
        );
        setSelectedRequestOwnerId(
          (current) => current || nextState.recipients[0]?.userId || "",
        );
      } catch (error) {
        setLoadError(
          oneLocationErrorMessage(error, "Could not load location sharing."),
        );
      } finally {
        refreshInFlightRef.current = null;
        setBusy(null);
      }
    })();
    refreshInFlightRef.current = task;
    return task;
  }, [auth.user, auth.userId, isVaultUnlocked, vaultOwnerToken]);

  useEffect(() => {
    if (!auth.loading) {
      void refresh();
    }
  }, [auth.loading, refresh]);

  useEffect(() => {
    if (!auth.userId || typeof window === "undefined") return;
    const handleLocationNotification = (event: Event) => {
      const detail =
        (event as CustomEvent<Record<string, unknown>>).detail || {};
      const source = String(detail.source || "").trim();
      const notificationType = String(detail.notificationType || "").trim();
      if (
        source !== "one_location_notification" &&
        !notificationType.startsWith("location_")
      ) {
        return;
      }
      void refresh();
    };
    window.addEventListener(
      CONSENT_STATE_CHANGED_EVENT,
      handleLocationNotification,
    );
    return () => {
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        handleLocationNotification,
      );
    };
  }, [auth.userId, refresh]);

  useEffect(() => {
    if (!auth.userId) return;
    const grantId = String(
      searchParams.get(ONE_LOCATION_GRANT_ID_PARAM) || "",
    ).trim();
    const notificationState = String(
      searchParams.get(ONE_LOCATION_NOTIFICATION_OPEN_PARAM) || "",
    ).trim();
    if (grantId && notificationState === ONE_LOCATION_NOTIFICATION_OPEN_VALUE) {
      markOneLocationGrantOpened(auth.userId, grantId);
      setOpenedGrantTick((value) => value + 1);
    }
  }, [auth.userId, searchParams]);

  useEffect(() => {
    if (!auth.userId || typeof window === "undefined") return;
    const handleGrantOpened = (event: Event) => {
      const detail =
        (event as CustomEvent<{ userId?: string; grantId?: string }>).detail ||
        {};
      if (detail.userId && detail.userId !== auth.userId) return;
      setOpenedGrantTick((value) => value + 1);
    };
    window.addEventListener(ONE_LOCATION_GRANT_OPENED_EVENT, handleGrantOpened);
    return () => {
      window.removeEventListener(
        ONE_LOCATION_GRANT_OPENED_EVENT,
        handleGrantOpened,
      );
    };
  }, [auth.userId]);

  useEffect(() => {
    if (!auth.userId || !state?.receivedGrants?.length) return;
    for (const grant of state.receivedGrants) {
      if (grant.status !== "active") continue;
      if (isOneLocationGrantOpened(auth.userId, grant.id)) continue;
      const created = recordOneLocationShareNotification({
        userId: auth.userId,
        grantId: grant.id,
        ownerLabel: receivedGrantOwnerLabel(grant),
        expiresAt: grant.expiresAt,
        durationHours: grant.durationHours,
      });
      if (created) {
        showLocationShareToast(grant);
      }
    }
  }, [
    auth.userId,
    openedGrantTick,
    showLocationShareToast,
    state?.receivedGrants,
  ]);

  const recipientForGrant = useCallback(
    (grant: OneLocationGrant) =>
      recipients.find(
        (recipient) =>
          recipient.userId === grant.recipientUserId &&
          recipient.keyId === grant.recipientKeyId,
      ) || null,
    [recipients],
  );

  const publishEnvelope = useCallback(
    async (
      grant: OneLocationGrant,
      recipient: OneLocationRecipient,
      pointOverride?: PlainLocationPoint,
    ) => {
      if (!vaultOwnerToken) throw new Error("Vault owner token required.");
      if (!recipient.publicKeyJwk || !recipient.keyId) {
        throw new Error("Recipient key unavailable.");
      }
      const point =
        pointOverride ?? (await OneLocationService.captureCurrentPosition());
      const envelope = await encryptLocationForRecipient({
        point,
        recipientPublicKeyJwk: recipient.publicKeyJwk,
        recipientKeyId: recipient.keyId,
      });
      await OneLocationService.storeEnvelope({
        vaultOwnerToken,
        grantId: grant.id,
        envelope,
      });
    },
    [vaultOwnerToken],
  );

  const handleShare = useCallback(async () => {
    if (
      !vaultOwnerToken ||
      !selectedRecipient?.keyId ||
      !selectedRecipient.publicKeyJwk
    )
      return;
    setBusy("share");
    try {
      const grant = await OneLocationService.createGrant({
        vaultOwnerToken,
        recipientUserId: selectedRecipient.userId,
        recipientKeyId: selectedRecipient.keyId,
        durationHours: Number(durationHours),
      });
      await publishEnvelope(grant, selectedRecipient);
      toast.success("Location shared with encrypted recipient access.");
      await refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not share location.",
      );
    } finally {
      setBusy(null);
    }
  }, [
    durationHours,
    publishEnvelope,
    refresh,
    selectedRecipient,
    vaultOwnerToken,
  ]);

  const handlePublish = useCallback(
    async (grant: OneLocationGrant) => {
      const recipient = recipientForGrant(grant);
      if (!recipient) {
        toast.error("Recipient key unavailable for this active share.");
        return;
      }
      setBusy("publish");
      try {
        await publishEnvelope(grant, recipient);
        toast.success("Encrypted location update published.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not publish update.",
        );
      } finally {
        setBusy(null);
      }
    },
    [publishEnvelope, recipientForGrant, refresh],
  );

  const viewGrantEnvelope = useCallback(
    async (grant: OneLocationGrant, options?: { silent?: boolean }) => {
      if (!auth.userId || !vaultOwnerToken) return;
      const silent = Boolean(options?.silent);
      if (!silent) setBusy("view");
      try {
        const response = await OneLocationService.viewEnvelope({
          vaultOwnerToken,
          grantId: grant.id,
        });
        const point = await decryptLocationEnvelope({
          userId: auth.userId,
          envelope: response.envelope,
        });
        setDecryptedPoints((current) => ({ ...current, [grant.id]: point }));
      } catch (error) {
        if (!silent) {
          toast.error(
            error instanceof Error
              ? error.message
              : "Could not view encrypted location.",
          );
        } else {
          console.warn(
            "[OneLocationAgent] Silent location refresh skipped:",
            error,
          );
        }
      } finally {
        if (!silent) setBusy(null);
      }
    },
    [auth.userId, vaultOwnerToken],
  );

  const handleView = useCallback(
    async (grant: OneLocationGrant) => {
      await viewGrantEnvelope(grant);
    },
    [viewGrantEnvelope],
  );

  useEffect(() => {
    if (!vaultOwnerToken || !activeOwnerGrants.length) return;
    if (busy && busy !== "load") return;
    if (
      permission?.state === "denied" ||
      permission?.state === "restricted" ||
      permission?.state === "unavailable"
    ) {
      return;
    }

    const publishActiveGrants = async () => {
      if (livePublishInFlightRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      livePublishInFlightRef.current = true;
      try {
        const point = await OneLocationService.captureCurrentPosition();
        for (const grant of activeOwnerGrants) {
          const recipient = recipientForGrant(grant);
          if (!recipient?.keyId || !recipient.publicKeyJwk) continue;
          await publishEnvelope(grant, recipient, point);
        }
      } catch (error) {
        console.warn(
          "[OneLocationAgent] Foreground live update skipped:",
          error,
        );
      } finally {
        livePublishInFlightRef.current = false;
      }
    };

    const interval = window.setInterval(
      () => void publishActiveGrants(),
      LIVE_LOCATION_UPDATE_INTERVAL_MS,
    );
    void publishActiveGrants();
    return () => window.clearInterval(interval);
  }, [
    activeOwnerGrants,
    busy,
    permission?.state,
    publishEnvelope,
    recipientForGrant,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!activeVisibleReceivedGrants.length) return;
    if (busy && busy !== "load") return;

    const refreshVisibleGrants = async () => {
      if (liveViewInFlightRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      liveViewInFlightRef.current = true;
      try {
        await Promise.allSettled(
          activeVisibleReceivedGrants.map((grant) =>
            viewGrantEnvelope(grant, { silent: true }),
          ),
        );
      } finally {
        liveViewInFlightRef.current = false;
      }
    };

    void refreshVisibleGrants();
    const interval = window.setInterval(
      () => void refreshVisibleGrants(),
      LIVE_LOCATION_UPDATE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeVisibleReceivedGrants, busy, viewGrantEnvelope]);

  const handleRevoke = useCallback(
    async (grantId: string) => {
      if (!vaultOwnerToken) return;
      setBusy("revoke");
      try {
        await OneLocationService.revokeGrant({ vaultOwnerToken, grantId });
        toast.success("Location access revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not revoke access.",
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleRequestAccess = useCallback(async () => {
    if (!vaultOwnerToken || !selectedRequestOwner) return;
    setBusy("request");
    try {
      await OneLocationService.requestAccess({
        vaultOwnerToken,
        ownerUserId: selectedRequestOwner.userId,
        message: requestMessage.trim() || undefined,
      });
      setRequestMessage("");
      playOneLocationNotificationSound();
      toast.success("Request sent. We'll notify you here when they respond.");
      await refresh();
    } catch (error) {
      toast.error(oneLocationErrorMessage(error, "Could not send request."));
      if (isTransientOneApiError(error)) {
        await refresh().catch(() => null);
      }
    } finally {
      setBusy(null);
    }
  }, [refresh, requestMessage, selectedRequestOwner, vaultOwnerToken]);

  const handleCreatePublicInvite = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("publicInvite");
    try {
      const response = await OneLocationService.createPublicInvite({
        vaultOwnerToken,
        durationHours: Number(durationHours),
      });
      const url = publicInviteUrlLabel(response.publicUrl);
      setPublicInviteUrl(url);
      if (navigator.clipboard && url) {
        await navigator.clipboard.writeText(url).catch(() => undefined);
      }
      toast.success(
        "Public request link created. You still approve before sharing.",
      );
      await refresh();
    } catch (error) {
      toast.error(
        oneLocationErrorMessage(error, "Could not create public request link."),
      );
    } finally {
      setBusy(null);
    }
  }, [durationHours, refresh, vaultOwnerToken]);

  const handleCopyPublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    try {
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Request link copied.");
    } catch {
      toast.error("Could not copy the request link.");
    }
  }, [publicInviteUrl]);

  const handleSharePublicInvite = useCallback(async () => {
    if (!publicInviteUrl) return;
    const text =
      "Please request access to my live location here. I approve before anything is shared.";
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Request my location",
          text,
          url: publicInviteUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(publicInviteUrl);
      toast.success("Request link copied.");
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      toast.error("Could not open the share sheet.");
    }
  }, [publicInviteUrl]);

  const handleRevokePublicInvite = useCallback(
    async (invite: OneLocationPublicInvite) => {
      if (!vaultOwnerToken) return;
      setBusy("publicRevoke");
      try {
        await OneLocationService.revokePublicInvite({
          vaultOwnerToken,
          inviteId: invite.id,
        });
        setPublicInviteUrl("");
        toast.success("Public request link revoked.");
        await refresh();
      } catch (error) {
        toast.error(
          oneLocationErrorMessage(
            error,
            "Could not revoke public request link.",
          ),
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleApprove = useCallback(
    async (request: OneLocationAccessRequest) => {
      if (!vaultOwnerToken) return;
      const requester = recipients.find(
        (recipient) => recipient.userId === request.requesterUserId,
      );
      if (!requester?.keyId || !requester.publicKeyJwk) {
        toast.error("Requester key unavailable.");
        return;
      }
      setBusy("approve");
      try {
        const response = await OneLocationService.approveRequest({
          vaultOwnerToken,
          requestId: request.id,
          durationHours: Number(durationHours),
        });
        await publishEnvelope(response.grant, requester);
        toast.success("Request approved and encrypted update published.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not approve request.",
        );
      } finally {
        setBusy(null);
      }
    },
    [durationHours, publishEnvelope, recipients, refresh, vaultOwnerToken],
  );

  const handleDeny = useCallback(
    async (requestId: string) => {
      if (!vaultOwnerToken) return;
      setBusy("deny");
      try {
        await OneLocationService.denyRequest({ vaultOwnerToken, requestId });
        toast.success("Request denied.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not deny request.",
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh, vaultOwnerToken],
  );

  const handleRefer = useCallback(
    async (grant: OneLocationGrant) => {
      if (!vaultOwnerToken) return;
      const target = referralTargets[grant.id];
      if (!target) return;
      setBusy("refer");
      try {
        await OneLocationService.referRecipient({
          vaultOwnerToken,
          grantId: grant.id,
          referredUserId: target,
        });
        toast.success("Referral sent as an owner approval request.");
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not refer recipient.",
        );
      } finally {
        setBusy(null);
      }
    },
    [referralTargets, refresh, vaultOwnerToken],
  );

  const permissionState = permissionCopy(permission);
  const canShare = Boolean(
    vaultOwnerToken &&
    selectedRecipient?.canReceiveLocation &&
    selectedRecipient.keyId &&
    selectedRecipient.publicKeyJwk &&
    permission?.state !== "denied" &&
    permission?.state !== "restricted" &&
    permission?.state !== "unavailable",
  );
  const dataState: "loading" | "loaded" | "unavailable-valid" = loadError
    ? "unavailable-valid"
    : state
      ? "loaded"
      : "loading";
  const showInitialSkeleton =
    !loadError &&
    !state &&
    (auth.loading ||
      busy === "load" ||
      Boolean(auth.userId && vaultOwnerToken));

  return (
    <AppPageShell
      width="standard"
      nativeTest={{
        routeId: "/one/location",
        marker: "native-route-one-location",
        authState: auth.loading
          ? "pending"
          : auth.isAuthenticated
            ? "authenticated"
            : "anonymous",
        dataState,
        errorCode: loadError ? "one_location_unavailable" : null,
        errorMessage: loadError,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="One"
          title="One Location Agent"
          description="Share live location with a trusted person through explicit duration, recipient encryption, revocation, and audit."
          accent="consent"
          icon={LocateFixed}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refresh()}
              disabled={busy === "load"}
            >
              {busy === "load" ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Refresh
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-6">
        {loadError ? (
          <div className="rounded-[var(--app-card-radius-standard)] border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        ) : null}

        {showInitialSkeleton ? (
          <OneLocationInitialSkeleton />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="space-y-6">
              <SettingsGroup
                eyebrow="Device"
                title="Readiness"
                description="One uses foreground location only for v1 and stores only encrypted envelopes."
              >
                <SettingsRow
                  icon={
                    permissionState.tone === "destructive"
                      ? AlertTriangle
                      : ShieldCheck
                  }
                  title={permissionState.title}
                  description={permissionState.description}
                  tone={permissionState.tone}
                  trailing={
                    <Badge
                      variant={
                        permissionState.tone === "destructive"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {permission?.state || "checking"}
                    </Badge>
                  }
                />
                <SettingsRow
                  icon={KeyRound}
                  title={isVaultUnlocked ? "Vault unlocked" : "Vault locked"}
                  description="Recipient private keys and vault owner tokens stay on this device."
                  trailing={
                    <Badge
                      variant={isVaultUnlocked ? "secondary" : "destructive"}
                    >
                      {isVaultUnlocked ? "Ready" : "Locked"}
                    </Badge>
                  }
                />
                <SettingsRow
                  icon={LocateFixed}
                  title={
                    activeOwnerGrants.length
                      ? "Live updates active"
                      : "Live updates ready"
                  }
                  description={
                    activeOwnerGrants.length
                      ? "Foreground encrypted updates are published every 20 seconds while this page is open."
                      : "Create a share to start foreground encrypted updates."
                  }
                  trailing={
                    <Badge
                      variant={
                        activeOwnerGrants.length ? "secondary" : "outline"
                      }
                    >
                      {activeOwnerGrants.length ? "Live" : "Idle"}
                    </Badge>
                  }
                />
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Share"
                title="Share with trusted person"
                description="Choose a verified Hussh user. Phone verification is eligibility only; this action creates the grant."
              >
                <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                    <Select
                      value={selectedRecipientId}
                      onValueChange={setSelectedRecipientId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select verified person" />
                      </SelectTrigger>
                      <SelectContent>
                        {recipients.map((recipient) => (
                          <SelectItem
                            key={recipient.userId}
                            value={recipient.userId}
                          >
                            {recipientLabel(recipient)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={durationHours}
                      onValueChange={setDurationHours}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedRecipient &&
                  !selectedRecipient.canReceiveLocation ? (
                    <div className="rounded-[var(--app-card-radius-standard)] border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                      Recipient key unavailable. Ask them to open One Location
                      Agent once.
                    </div>
                  ) : null}
                  <ActionButton
                    busy={busy}
                    busyKey="share"
                    onClick={() => void handleShare()}
                    disabled={!canShare}
                  >
                    <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                    Share Encrypted Update
                  </ActionButton>
                </div>
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Request"
                title="Ask someone to share"
                description="Requests wait for owner approval and never create access by themselves."
              >
                <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  <Select
                    value={selectedRequestOwnerId}
                    onValueChange={setSelectedRequestOwnerId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select owner" />
                    </SelectTrigger>
                    <SelectContent>
                      {recipients.map((recipient) => (
                        <SelectItem
                          key={recipient.userId}
                          value={recipient.userId}
                        >
                          {recipientLabel(recipient)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={requestMessage}
                    onChange={(event) => setRequestMessage(event.target.value)}
                    placeholder="Optional reason"
                    rows={3}
                  />
                  <ActionButton
                    busy={busy}
                    busyKey="request"
                    onClick={() => void handleRequestAccess()}
                    disabled={!vaultOwnerToken || !selectedRequestOwner}
                    variant="outline"
                  >
                    <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                    Send Request
                  </ActionButton>
                </div>
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Public"
                title="Create request link"
                description="Share a request link with family or friends. The link asks for their details and never shows your location until you approve an encrypted grant."
              >
                <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                    <div className="rounded-[var(--app-card-radius-standard)] border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      {publicInviteUrl ||
                        "Create a fresh request link to copy or share."}
                    </div>
                    <Select
                      value={durationHours}
                      onValueChange={setDurationHours}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      busy={busy}
                      busyKey="publicInvite"
                      onClick={() => void handleCreatePublicInvite()}
                      disabled={!vaultOwnerToken}
                    >
                      <ExternalLink
                        className="mr-2 h-4 w-4"
                        aria-hidden="true"
                      />
                      Create Request Link
                    </ActionButton>
                    <Button
                      variant="outline"
                      onClick={() => void handleSharePublicInvite()}
                      disabled={!publicInviteUrl}
                    >
                      <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyPublicInvite()}
                      disabled={!publicInviteUrl}
                    >
                      <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
                      Copy
                    </Button>
                  </div>
                </div>
                {activePublicInvites.length
                  ? activePublicInvites.map((invite) => (
                      <SettingsRow
                        key={invite.id}
                        icon={ExternalLink}
                        title="Active request link"
                        description={`Requests expire ${formatDateTime(invite.expiresAt)} - ${invite.durationHours}h`}
                        stackTrailingOnMobile
                        trailing={
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void handleRevokePublicInvite(invite)
                            }
                            disabled={busy === "publicRevoke"}
                          >
                            Revoke
                          </Button>
                        }
                      />
                    ))
                  : null}
              </SettingsGroup>
            </div>

            <div className="space-y-6">
              <SettingsGroup
                eyebrow="Owner"
                title="People who can see me"
                description="Each active row is a separate recipient-scoped grant."
              >
                {(state?.ownerGrants ?? []).length ? (
                  state?.ownerGrants.map((grant) => (
                    <SettingsRow
                      key={grant.id}
                      icon={UserRoundCheck}
                      title={grantCounterpartyLabel(grant)}
                      description={`${expiresLabel(grant)} - ${grant.durationHours}h`}
                      stackTrailingOnMobile
                      trailing={
                        <div className="flex flex-wrap justify-end gap-2">
                          <Badge variant={statusVariant(grant.status)}>
                            {grant.status}
                          </Badge>
                          {grant.status === "active" ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handlePublish(grant)}
                                disabled={busy === "publish"}
                              >
                                {busy === "publish" ? (
                                  <Loader2
                                    className="mr-2 h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <LocateFixed
                                    className="mr-2 h-4 w-4"
                                    aria-hidden="true"
                                  />
                                )}
                                Update
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => void handleRevoke(grant.id)}
                                disabled={busy === "revoke"}
                              >
                                Revoke
                              </Button>
                            </>
                          ) : null}
                        </div>
                      }
                    />
                  ))
                ) : (
                  <EmptyState
                    icon={UsersRound}
                    title="No active shares"
                    description="Create one encrypted grant when you need a trusted person to see you."
                  />
                )}
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Recipient"
                title="Shared with me"
                description="Open the notification first; One returns ciphertext only after authorization."
              >
                {visibleReceivedGrants.length ? (
                  visibleReceivedGrants.map((grant) => {
                    const point = decryptedPoints[grant.id];
                    return (
                      <div
                        key={grant.id}
                        className="border-b border-border/60 last:border-b-0"
                      >
                        <SettingsRow
                          icon={MapPin}
                          title={receivedGrantOwnerLabel(grant)}
                          description={expiresLabel(grant)}
                          stackTrailingOnMobile
                          trailing={
                            <div className="flex flex-wrap justify-end gap-2">
                              <Badge variant={statusVariant(grant.status)}>
                                {grant.status}
                              </Badge>
                              {grant.status === "active" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleView(grant)}
                                  disabled={busy === "view"}
                                >
                                  {busy === "view" ? (
                                    <Loader2
                                      className="mr-2 h-4 w-4 animate-spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <ShieldCheck
                                      className="mr-2 h-4 w-4"
                                      aria-hidden="true"
                                    />
                                  )}
                                  View
                                </Button>
                              ) : null}
                            </div>
                          }
                        />
                        {point ? (
                          <div className="px-[var(--settings-row-px)] pb-4">
                            <LocalMapPreview point={point} />
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    icon={MapPin}
                    title={
                      hiddenReceivedGrantCount > 0
                        ? "Open notification to view"
                        : "Nothing shared with you"
                    }
                    description={
                      hiddenReceivedGrantCount > 0
                        ? "A location share is waiting in the notification bell."
                        : "Approved recipient grants appear after you open their notification."
                    }
                  />
                )}
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Approvals"
                title="Pending requests"
                description="Owner approval creates a fresh identity-bound grant."
              >
                {pendingOwnerRequests.length ? (
                  pendingOwnerRequests.map((request) => (
                    <SettingsRow
                      key={request.id}
                      icon={Clock3}
                      title={requestLabel(request)}
                      description={
                        request.message ||
                        `Requested ${formatDateTime(request.requestedAt)}`
                      }
                      stackTrailingOnMobile
                      trailing={
                        <div className="flex flex-wrap justify-end gap-2">
                          <ActionButton
                            busy={busy}
                            busyKey="approve"
                            size="sm"
                            onClick={() => void handleApprove(request)}
                          >
                            <CheckCircle2
                              className="mr-2 h-4 w-4"
                              aria-hidden="true"
                            />
                            Approve
                          </ActionButton>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDeny(request.id)}
                            disabled={busy === "deny"}
                          >
                            <XCircle
                              className="mr-2 h-4 w-4"
                              aria-hidden="true"
                            />
                            Deny
                          </Button>
                        </div>
                      }
                    />
                  ))
                ) : (
                  <EmptyState
                    icon={Clock3}
                    title="No pending requests"
                    description="Referral and direct access requests wait here."
                  />
                )}
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Public"
                title="Public link responses"
                description="People who use your public request link appear here. Location still waits for owner approval."
              >
                {publicSubmissions.length ? (
                  publicSubmissions.map((submission) => (
                    <SettingsRow
                      key={submission.id}
                      icon={Clock3}
                      title={publicSubmissionLabel(submission)}
                      description={
                        submission.message ||
                        `Status ${submission.status} - ${formatDateTime(submission.submittedAt)}`
                      }
                      stackTrailingOnMobile
                      trailing={
                        <Badge variant={statusVariant(submission.status)}>
                          {submission.requestStatus || submission.status}
                        </Badge>
                      }
                    />
                  ))
                ) : (
                  <EmptyState
                    icon={ExternalLink}
                    title="No public responses"
                    description="Responses from your request link show up here without exposing your location."
                  />
                )}
              </SettingsGroup>

              <SettingsGroup
                eyebrow="Referral"
                title="Refer someone else"
                description="A referral opens a request for the owner; it never forwards your access."
              >
                {(state?.receivedGrants ?? []).filter(
                  (grant) => grant.status === "active",
                ).length ? (
                  state?.receivedGrants
                    .filter((grant) => grant.status === "active")
                    .map((grant) => (
                      <div
                        key={grant.id}
                        className="grid gap-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)] sm:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <Select
                          value={referralTargets[grant.id] || ""}
                          onValueChange={(value) =>
                            setReferralTargets((current) => ({
                              ...current,
                              [grant.id]: value,
                            }))
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select referred person" />
                          </SelectTrigger>
                          <SelectContent>
                            {recipients
                              .filter(
                                (recipient) =>
                                  recipient.userId !== grant.ownerUserId,
                              )
                              .map((recipient) => (
                                <SelectItem
                                  key={recipient.userId}
                                  value={recipient.userId}
                                >
                                  {recipientLabel(recipient)}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <ActionButton
                          busy={busy}
                          busyKey="refer"
                          variant="outline"
                          onClick={() => void handleRefer(grant)}
                          disabled={!referralTargets[grant.id]}
                        >
                          Refer
                        </ActionButton>
                      </div>
                    ))
                ) : (
                  <EmptyState
                    icon={UsersRound}
                    title="No active received grant"
                    description="You can refer only from an active share, and the owner still decides."
                  />
                )}
              </SettingsGroup>

              {requestedByMe.length ? (
                <SettingsGroup eyebrow="Activity" title="My requests">
                  {requestedByMe.map((request) => (
                    <SettingsRow
                      key={request.id}
                      icon={Clock3}
                      title={request.ownerUserId}
                      description={`Status ${request.status} - ${formatDateTime(request.requestedAt)}`}
                      trailing={
                        <Badge variant={statusVariant(request.status)}>
                          {request.status}
                        </Badge>
                      }
                    />
                  ))}
                </SettingsGroup>
              ) : null}
            </div>
          </div>
        )}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

export default function OneLocationAgentPage() {
  return (
    <VaultLockGuard>
      <OneLocationAgentPageContent />
    </VaultLockGuard>
  );
}
