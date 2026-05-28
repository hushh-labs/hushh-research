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
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserRoundCheck,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
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
import { cn } from "@/lib/utils";

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

function safePersonLabel(value?: string | null, fallback = "KAI member"): string {
  return String(value || "").trim() || fallback;
}

function recipientLabel(recipient: OneLocationRecipient): string {
  return safePersonLabel(recipient.displayName);
}

function grantCounterpartyLabel(grant: OneLocationGrant): string {
  return safePersonLabel(grant.recipientDisplayName);
}

function receivedGrantOwnerLabel(grant: OneLocationGrant): string {
  return safePersonLabel(
    grant.ownerDisplayName || grant.recipientDisplayName,
    "A trusted person",
  );
}

function requestLabel(request: OneLocationAccessRequest): string {
  return safePersonLabel(request.requesterDisplayName, "Someone from KAI");
}

function publicSubmissionLabel(
  submission: OneLocationPublicInviteSubmission,
): string {
  return safePersonLabel(submission.visitorDisplayName, "Public request");
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

type ShareMode = "share" | "request";

const onePanelClassName =
  "overflow-hidden rounded-[20px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_30px_rgba(15,23,42,0.05)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_38px_rgba(0,0,0,0.28)]";
const oneInsetClassName =
  "rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] text-[#1c1c1e] dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white";
const oneSecondaryTextClassName = "text-[#8e8e93] dark:text-white/55";

function sectionLabel(title: string, count?: number) {
  return (
    <div
      role="heading"
      aria-level={2}
      className="ml-1 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#8e8e93] dark:text-white/45"
    >
      {title}
      {typeof count === "number" && count > 0 ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[10px] font-bold text-white">
          {count}
        </span>
      ) : null}
    </div>
  );
}

function displayNameFromRecipient(recipient: OneLocationRecipient): string {
  return recipientLabel(recipient);
}

function initialsForLabel(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] || "";
    const second = words[1]?.[0] || "";
    return `${first}${second}`.toUpperCase();
  }
  return (words[0]?.slice(0, 2) || "?").toUpperCase();
}

function avatarColor(index: number): string {
  const colors = [
    "bg-[#007aff]",
    "bg-[#34c759]",
    "bg-[#5856d6]",
    "bg-[#ff9500]",
    "bg-[#ff3b30]",
  ];
  return colors[index % colors.length] || "bg-[#007aff]";
}

function AvatarBubble({
  label,
  index,
  size = "md",
  muted = false,
}: {
  label: string;
  index: number;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase",
        size === "sm" && "h-9 w-9 text-[15px]",
        size === "md" && "h-[52px] w-[52px] text-[18px]",
        size === "lg" && "h-11 w-11 text-[17px]",
        muted
          ? "bg-[#e5e5ea] text-[#8e8e93] dark:bg-white/10 dark:text-white/55"
          : `${avatarColor(index)} text-white`,
      )}
      aria-hidden="true"
    >
      {initialsForLabel(label)}
    </span>
  );
}

function PromiseCard({
  icon: Icon,
  title,
  description,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone: "blue" | "green" | "orange";
}) {
  const toneClassName = {
    blue: "bg-[#eaf3ff] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]",
    green:
      "bg-[#eaf9ef] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200",
    orange:
      "bg-[#fff3e6] text-[#ff9500] dark:bg-orange-400/15 dark:text-orange-200",
  }[tone];

  return (
    <div className="flex items-center gap-4 rounded-[20px] border border-black/[0.06] bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-[#1c1c1e]/90 dark:shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
          toneClassName,
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[16px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
          {title}
        </h3>
        <p className="mt-1 text-[14px] font-medium leading-snug text-[#8e8e93] dark:text-white/55">
          {description}
        </p>
      </div>
    </div>
  );
}

function SegmentedModeControl({
  value,
  onChange,
}: {
  value: ShareMode;
  onChange: (value: ShareMode) => void;
}) {
  return (
    <div className="flex h-9 w-full items-center rounded-[9px] bg-[#efeff0] p-[3px] dark:bg-white/10">
      {(["share", "request"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={cn(
            "h-full flex-1 rounded-[7px] text-[13px] capitalize transition-all",
            value === mode
              ? "bg-white font-semibold text-[#1c1c1e] shadow-[0_1px_3px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#2c2c2e] dark:text-white"
              : "font-medium text-[#8e8e93] hover:text-[#1c1c1e] dark:text-white/50 dark:hover:text-white",
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function EmptyOneState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-24 items-center gap-3 p-3.5 text-sm">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="font-semibold text-[#1c1c1e] dark:text-white">
          {title}
        </div>
        <div className="text-[13px] leading-5 text-[#8e8e93] dark:text-white/55">
          {description}
        </div>
      </div>
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
  const [activeMode, setActiveMode] = useState<ShareMode>("share");
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
      "Please send a One Location request here. I approve before anything is shared.";
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
      <AppPageHeaderRegion className="mx-auto w-full max-w-[1120px]">
        <div className="flex flex-col gap-4 px-1 pt-3 sm:flex-row sm:items-end sm:justify-between">
          <header className="max-w-[560px] space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.22em] text-[#007aff] dark:text-[#76b7ff]">
              When it matters most
            </span>
            <h1 className="text-[34px] font-bold leading-[1.2] tracking-tight text-[#1c1c1e] sm:text-[42px] dark:text-white">
              Your circle, safely connected.
            </h1>
            <h2 className="sr-only">One Location Agent</h2>
            <p className="max-w-[440px] text-[16px] font-medium leading-snug text-[#8e8e93] dark:text-white/55">
              Share your location with selected contacts, or ask to see theirs
              after they approve.
            </p>
          </header>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={busy === "load"}
            className="h-9 w-fit rounded-full border-black/[0.06] bg-white/80 px-3 text-[#1c1c1e] shadow-sm backdrop-blur-xl hover:bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
          >
            {busy === "load" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            Refresh
          </Button>
        </div>
      </AppPageHeaderRegion>

      <AppPageContentRegion className="mx-auto w-full max-w-[1120px] space-y-6">
        {loadError ? (
          <div className="rounded-[20px] border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-4 text-sm text-[#ff3b30] dark:text-[#ff9f9a]">
            {loadError}
          </div>
        ) : null}

        {showInitialSkeleton ? (
          <OneLocationInitialSkeleton />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,520px)_minmax(0,1fr)] xl:items-start">
            <div className="space-y-7">
              <section className="space-y-3 px-1">
                <PromiseCard
                  icon={LocateFixed}
                  title="Chosen People"
                  description="Only selected contacts can see your location."
                  tone="blue"
                />
                <PromiseCard
                  icon={ShieldCheck}
                  title="Approval First"
                  description="Every location request needs approval."
                  tone="green"
                />
                <PromiseCard
                  icon={KeyRound}
                  title="Stop Anytime"
                  description="Change access, set a time limit, or stop sharing anytime."
                  tone="orange"
                />
              </section>

              <section className="space-y-4 px-1">
                <SegmentedModeControl
                  value={activeMode}
                  onChange={setActiveMode}
                />

                <div className="space-y-2">
                  {sectionLabel("Frequent contacts")}
                  <div className="flex gap-4 overflow-x-auto px-1 pb-2 pt-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {recipients.length ? (
                      recipients.map((recipient, index) => {
                        const label = displayNameFromRecipient(recipient);
                        const selected =
                          activeMode === "share"
                            ? recipient.userId === selectedRecipientId
                            : recipient.userId === selectedRequestOwnerId;
                        return (
                          <button
                            key={recipient.userId}
                            type="button"
                            onClick={() => {
                              if (activeMode === "share") {
                                setSelectedRecipientId(recipient.userId);
                              } else {
                                setSelectedRequestOwnerId(recipient.userId);
                              }
                            }}
                            className="flex shrink-0 flex-col items-center gap-1.5"
                          >
                            <span className="relative">
                              <AvatarBubble label={label} index={index} />
                              <span
                                className={cn(
                                  "absolute bottom-0 right-0 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-black/5 bg-white shadow-sm dark:border-white/10 dark:bg-[#2c2c2e]",
                                  selected && "ring-2 ring-[#007aff]/30",
                                )}
                              >
                                {selected ? (
                                  <CheckCircle2 className="h-3 w-3 text-[#2e7d32] dark:text-emerald-300" />
                                ) : recipient.canReceiveLocation ? (
                                  <ShieldCheck className="h-3 w-3 text-[#8e8e93] dark:text-white/55" />
                                ) : (
                                  <AlertTriangle className="h-3 w-3 text-[#ff9500]" />
                                )}
                              </span>
                            </span>
                            <span className="max-w-[68px] truncate text-[12px] font-medium text-[#1c1c1e] dark:text-white">
                              {label}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <p className="text-[13px] text-[#8e8e93] dark:text-white/55">
                        Verified contacts will appear here.
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#8e8e93]" />
                    <input
                      className="h-10 w-full rounded-[14px] border border-black/[0.04] bg-white pl-10 pr-4 text-[15px] text-[#1c1c1e] shadow-sm outline-none transition-shadow placeholder:text-[#8e8e93] focus:ring-2 focus:ring-[#007aff]/20 dark:border-white/[0.08] dark:bg-white/[0.07] dark:text-white"
                      placeholder="Search contacts..."
                      type="text"
                    />
                  </div>

                  <div className={onePanelClassName}>
                    {recipients.length ? (
                      recipients.map((recipient, index) => {
                        const label = displayNameFromRecipient(recipient);
                        const selected =
                          activeMode === "share"
                            ? recipient.userId === selectedRecipientId
                            : recipient.userId === selectedRequestOwnerId;
                        return (
                          <div
                            key={recipient.userId}
                            className="relative flex flex-col gap-2.5 p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
                          >
                            <div className="flex items-center gap-3">
                              <AvatarBubble
                                label={label}
                                index={index}
                                size="sm"
                                muted={!recipient.canReceiveLocation}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
                                    {recipientLabel(recipient)}
                                  </span>
                                  <span className="rounded-md bg-[#f0f5ff] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
                                    {recipient.phoneVerified
                                      ? "Verified"
                                      : "Contact"}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                                  {recipient.canReceiveLocation
                                    ? "Ready for encrypted location access"
                                    : "Needs a recipient key"}
                                </p>
                              </div>
                              {selected ? (
                                <CheckCircle2 className="h-[22px] w-[22px] text-[#007aff] dark:text-[#76b7ff]" />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (activeMode === "share") {
                                      setSelectedRecipientId(recipient.userId);
                                    } else {
                                      setSelectedRequestOwnerId(
                                        recipient.userId,
                                      );
                                    }
                                  }}
                                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[#f2f2f7] px-3 text-[12px] font-semibold text-[#007aff] transition-colors hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-[#76b7ff] dark:hover:bg-white/15"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Select
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <EmptyOneState
                        icon={UsersRound}
                        title="No verified contacts"
                        description="Sync a trusted person before starting a share or request."
                      />
                    )}
                  </div>

                  {activeMode === "share" ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                        <Select
                          value={selectedRecipientId}
                          onValueChange={setSelectedRecipientId}
                        >
                          <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
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
                          <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DURATION_OPTIONS.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedRecipient &&
                      !selectedRecipient.canReceiveLocation ? (
                        <div className="rounded-[14px] border border-[#ff9500]/30 bg-[#ff9500]/10 p-3 text-xs leading-5 text-[#9a5a00] dark:text-[#ffd79a]">
                          Recipient key unavailable. Ask them to open One
                          Location Agent once.
                        </div>
                      ) : null}
                      <ActionButton
                        busy={busy}
                        busyKey="share"
                        onClick={() => void handleShare()}
                        disabled={!canShare}
                        className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[#1a85ff] to-[#0066ff] text-[16px] font-semibold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] hover:opacity-95"
                      >
                        <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        Start Sharing Location
                        <span className="sr-only">Share Encrypted Update</span>
                      </ActionButton>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <Select
                        value={selectedRequestOwnerId}
                        onValueChange={setSelectedRequestOwnerId}
                      >
                        <SelectTrigger className="h-11 w-full rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
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
                        onChange={(event) =>
                          setRequestMessage(event.target.value)
                        }
                        placeholder="Optional reason"
                        rows={3}
                        className="rounded-[14px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]"
                      />
                      <ActionButton
                        busy={busy}
                        busyKey="request"
                        onClick={() => void handleRequestAccess()}
                        disabled={!vaultOwnerToken || !selectedRequestOwner}
                        className="h-12 w-full rounded-[16px] bg-gradient-to-b from-[#1a85ff] to-[#0066ff] text-[16px] font-semibold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] hover:opacity-95"
                      >
                        <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                        Send Request
                      </ActionButton>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="space-y-6">
              <section className="space-y-2 px-1">
                {sectionLabel("People who can see me")}
                <div className={onePanelClassName}>
                  {(state?.ownerGrants ?? []).length ? (
                    state?.ownerGrants.map((grant, index) => (
                      <div
                        key={grant.id}
                        className="relative flex items-center gap-3 p-3.5 after:absolute after:bottom-0 after:left-[62px] after:right-0 after:border-b after:border-black/[0.05] last:after:hidden dark:after:border-white/[0.08]"
                      >
                        <AvatarBubble
                          label={grantCounterpartyLabel(grant)}
                          index={index}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium tracking-tight text-[#1c1c1e] dark:text-white">
                            {grantCounterpartyLabel(grant)}
                          </h3>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            <Badge variant={statusVariant(grant.status)}>
                              {grant.status}
                            </Badge>
                            <span className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                              {expiresLabel(grant)} - {grant.durationHours}h
                            </span>
                          </div>
                        </div>
                        {grant.status === "active" ? (
                          <div className="flex shrink-0 gap-1.5">
                            <Button
                              aria-label="Update share"
                              variant="outline"
                              size="icon"
                              onClick={() => void handlePublish(grant)}
                              disabled={busy === "publish"}
                              className="h-8 w-8 rounded-full border-0 bg-[#f2f2f7] text-[#8e8e93] hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white/55 dark:hover:bg-white/15"
                            >
                              {busy === "publish" ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Pencil className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              aria-label="Revoke share"
                              variant="outline"
                              size="icon"
                              onClick={() => void handleRevoke(grant.id)}
                              disabled={busy === "revoke"}
                              className="h-8 w-8 rounded-full border-0 bg-[#ff3b30]/10 text-[#ff3b30] hover:bg-[#ff3b30]/20 dark:bg-[#ff453a]/15 dark:text-[#ff9f9a]"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={UsersRound}
                      title="No active shares"
                      description="Create one encrypted grant when you need a trusted person to see you."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Approvals", pendingOwnerRequests.length)}
                <div
                  className={cn(
                    onePanelClassName,
                    pendingOwnerRequests.length &&
                      "relative before:absolute before:bottom-0 before:left-0 before:top-0 before:w-1 before:bg-[#ff3b30]",
                  )}
                >
                  {pendingOwnerRequests.length ? (
                    pendingOwnerRequests.map((request) => (
                      <div key={request.id} className="flex items-start gap-3 p-3.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <UserRoundCheck className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <h3 className="text-[16px] font-semibold tracking-tight text-[#1c1c1e] dark:text-white">
                            {requestLabel(request)}
                          </h3>
                          <p className="text-[13px] font-medium leading-relaxed text-[#8e8e93] dark:text-white/55">
                            {request.message ||
                              `Requested ${formatDateTime(request.requestedAt)}`}
                          </p>
                          <div className="flex gap-2 pt-2">
                            <Button
                              variant="outline"
                              onClick={() => void handleDeny(request.id)}
                              disabled={busy === "deny"}
                              className="h-9 flex-1 rounded-[12px] border-0 bg-[#f2f2f7] font-semibold text-[#1c1c1e] hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                            >
                              Deny
                            </Button>
                            <ActionButton
                              busy={busy}
                              busyKey="approve"
                              onClick={() => void handleApprove(request)}
                              className="h-9 flex-1 rounded-[12px] bg-[#007aff] font-semibold text-white shadow-[0_2px_8px_rgba(0,122,255,0.25)] hover:bg-[#0066ff]"
                            >
                              Approve
                            </ActionButton>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={Clock3}
                      title="No pending requests"
                      description="Referral and direct access requests wait here."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Create request link")}
                <div className={cn(onePanelClassName, "space-y-4 p-3.5")}>
                  <p className="text-[13px] leading-5 text-[#8e8e93] dark:text-white/55">
                    Share a request link. It asks for their details and never
                    shows your location until you approve an encrypted grant.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                    <div className={cn(oneInsetClassName, "px-3 py-2 text-sm")}>
                      <span className={oneSecondaryTextClassName}>
                        {publicInviteUrl ||
                          "Create a fresh request link to copy or share."}
                      </span>
                    </div>
                    <Select
                      value={durationHours}
                      onValueChange={setDurationHours}
                    >
                      <SelectTrigger className="h-10 w-full rounded-[12px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
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
                      className="rounded-full bg-[#007aff] text-white hover:bg-[#0066ff]"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Create Request Link
                    </ActionButton>
                    <Button
                      variant="outline"
                      onClick={() => void handleSharePublicInvite()}
                      disabled={!publicInviteUrl}
                      className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handleCopyPublicInvite()}
                      disabled={!publicInviteUrl}
                      className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </Button>
                  </div>
                  {activePublicInvites.length ? (
                    <div className="space-y-2">
                      {activePublicInvites.map((invite) => (
                        <div
                          key={invite.id}
                          className="flex items-center justify-between gap-3 rounded-[14px] bg-[#f2f2f7] p-3 dark:bg-white/10"
                        >
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold text-[#1c1c1e] dark:text-white">
                              Active request link
                            </p>
                            <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                              Requests expire{" "}
                              {formatDateTime(invite.expiresAt)} -{" "}
                              {invite.durationHours}h
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRevokePublicInvite(invite)}
                            disabled={busy === "publicRevoke"}
                            className="rounded-full"
                          >
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Shared with me")}
                <div className={onePanelClassName}>
                  {visibleReceivedGrants.length ? (
                    visibleReceivedGrants.map((grant, index) => {
                      const point = decryptedPoints[grant.id];
                      return (
                        <div
                          key={grant.id}
                          className="border-b border-black/[0.05] last:border-b-0 dark:border-white/[0.08]"
                        >
                          <div className="flex items-center gap-3 p-3.5">
                            <AvatarBubble
                              label={receivedGrantOwnerLabel(grant)}
                              index={index + 2}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <h3 className="truncate text-[16px] font-medium tracking-tight text-[#1c1c1e] dark:text-white">
                                {receivedGrantOwnerLabel(grant)}
                              </h3>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                <Badge variant={statusVariant(grant.status)}>
                                  {grant.status}
                                </Badge>
                                <span className="text-[12px] font-medium text-[#8e8e93] dark:text-white/55">
                                  {expiresLabel(grant)}
                                </span>
                              </div>
                            </div>
                            {grant.status === "active" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleView(grant)}
                                disabled={busy === "view"}
                                className="rounded-full border-black/[0.06] bg-[#f2f2f7] dark:border-white/[0.08] dark:bg-white/10"
                              >
                                {busy === "view" ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <ShieldCheck className="mr-2 h-4 w-4" />
                                )}
                                View
                              </Button>
                            ) : null}
                          </div>
                          {point ? (
                            <div className="px-3.5 pb-3.5">
                              <LocalMapPreview point={point} />
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <EmptyOneState
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
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Public link responses")}
                <div className={onePanelClassName}>
                  {publicSubmissions.length ? (
                    publicSubmissions.map((submission) => (
                      <div
                        key={submission.id}
                        className="flex items-center gap-3 p-3.5"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <ExternalLink className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium text-[#1c1c1e] dark:text-white">
                            {publicSubmissionLabel(submission)}
                          </h3>
                          <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                            {submission.message ||
                              `Status ${submission.status} - ${formatDateTime(submission.submittedAt)}`}
                          </p>
                        </div>
                        <Badge variant={statusVariant(submission.status)}>
                          {submission.requestStatus || submission.status}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <EmptyOneState
                      icon={ExternalLink}
                      title="No public responses"
                      description="Responses from your request link show up here without exposing your location."
                    />
                  )}
                </div>
              </section>

              <section className="space-y-2 px-1">
                {sectionLabel("Refer someone else")}
                <div className={cn(onePanelClassName, "p-3.5")}>
                  {(state?.receivedGrants ?? []).filter(
                    (grant) => grant.status === "active",
                  ).length ? (
                    state?.receivedGrants
                      .filter((grant) => grant.status === "active")
                      .map((grant) => (
                        <div
                          key={grant.id}
                          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
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
                            <SelectTrigger className="h-10 w-full rounded-[12px] border-black/[0.04] bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.07]">
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
                            className="rounded-full"
                          >
                            Refer
                          </ActionButton>
                        </div>
                      ))
                  ) : (
                    <EmptyOneState
                      icon={UsersRound}
                      title="No active received grant"
                      description="You can refer only from an active share, and the owner still decides."
                    />
                  )}
                </div>
              </section>

              {requestedByMe.length ? (
                <section className="space-y-2 px-1">
                  {sectionLabel("My requests")}
                  <div className={onePanelClassName}>
                    {requestedByMe.map((request) => (
                      <div
                        key={request.id}
                        className="flex items-center gap-3 p-3.5"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] dark:bg-white/10 dark:text-white/55">
                          <Clock3 className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[16px] font-medium text-[#1c1c1e] dark:text-white">
                            {request.ownerUserId}
                          </h3>
                          <p className="truncate text-[12px] text-[#8e8e93] dark:text-white/55">
                            Status {request.status} -{" "}
                            {formatDateTime(request.requestedAt)}
                          </p>
                        </div>
                        <Badge variant={statusVariant(request.status)}>
                          {request.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </section>
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
