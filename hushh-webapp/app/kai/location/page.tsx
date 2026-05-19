"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Clipboard,
  ExternalLink,
  Info,
  LocateFixed,
  MapPin,
  MessageCircle,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  StopCircle,
  Trash2,
  X,
} from "lucide-react";

import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
} from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/app-ui/page-sections";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  buildMapsUrls,
  buildSharedLocationUrl,
  buildWhatsAppShareUrl,
  copyLocationUrl,
  getFreshLocationPoint,
  getLocationSharingErrorMessage,
  isLocationApiUnavailable,
  KaiLocationSharingService,
  shareOrCopyLocationUrl,
} from "@/lib/location-sharing/service";
import type {
  LocationContact,
  LocationContactTier,
  LocationLatestPoint,
  LocationOwnerState,
  LocationShare,
} from "@/lib/location-sharing/types";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

const EMPTY_STATE: LocationOwnerState = {
  contacts: [],
  shares: [],
  accessRequests: [],
  latest: null,
  limits: { family: 3, friend: 7 },
};

const SHARE_DURATION_OPTIONS = [
  { value: "0.25", label: "15 min" },
  { value: "1", label: "1 hour" },
  { value: "8", label: "8 hours" },
  { value: "24", label: "24 hours" },
] as const;

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatPoint(point: LocationLatestPoint | null): string {
  if (!point) return "No GPS fix yet";
  return `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`;
}

function tierLabel(tier: LocationContactTier): string {
  return tier === "family" ? "Family" : "Friend";
}

function KaiLocationContent() {
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const [requestId, setRequestId] = useState<string | null>(null);

  const [state, setState] = useState<LocationOwnerState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [currentPoint, setCurrentPoint] = useState<LocationLatestPoint | null>(null);
  const [apiNotice, setApiNotice] = useState<string | null>(null);
  const [shareUrlsById, setShareUrlsById] = useState<Record<string, string>>({});
  const [shareDurationHours, setShareDurationHours] = useState("1");
  const [form, setForm] = useState<{
    displayName: string;
    tier: LocationContactTier;
    autoApprove: boolean;
  }>({
    displayName: "",
    tier: "family",
    autoApprove: true,
  });

  const activeContacts = useMemo(
    () => state.contacts.filter((contact) => contact.status === "active"),
    [state.contacts]
  );
  const activeShares = useMemo(
    () => state.shares.filter((share) => share.status === "active"),
    [state.shares]
  );
  const pendingRequests = useMemo(
    () => state.accessRequests.filter((request) => request.status === "pending"),
    [state.accessRequests]
  );
  const currentMaps = useMemo(
    () => (currentPoint ? buildMapsUrls(currentPoint) : null),
    [currentPoint]
  );
  const familyCount = activeContacts.filter((contact) => contact.tier === "family").length;
  const friendCount = activeContacts.filter((contact) => contact.tier === "friend").length;
  const limitReached =
    form.tier === "family"
      ? familyCount >= state.limits.family
      : friendCount >= state.limits.friend;

  useEffect(() => {
    setRequestId(new URLSearchParams(window.location.search).get("requestId"));
  }, []);

  const refreshState = useCallback(async () => {
    if (!vaultOwnerToken) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const nextState = await KaiLocationSharingService.getOwnerState(vaultOwnerToken);
      setState(nextState);
      setCurrentPoint(nextState.latest);
      setApiNotice(null);
    } catch (error) {
      const message = getLocationSharingErrorMessage(error, "Could not load location sharing.");
      if (isLocationApiUnavailable(error)) setApiNotice(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    return () => {
      void KaiLocationSharingService.stopLiveUpdates().catch(() => undefined);
    };
  }, []);

  const refreshGps = useCallback(async () => {
    setBusy("gps");
    try {
      const point = await getFreshLocationPoint();
      setCurrentPoint(point);
      toast.success("Fresh GPS fix ready.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Location permission was denied.");
    } finally {
      setBusy(null);
    }
  }, []);

  const startLiveUpdates = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("live");
    try {
      const session = await KaiLocationSharingService.issueUpdateSession(vaultOwnerToken);
      await KaiLocationSharingService.startLiveUpdates({
        updateToken: session.token,
        endpointPath: session.endpointPath,
      });
      setLiveRunning(true);
      setApiNotice(null);
      toast.success("Live location updates are running.");
    } catch (error) {
      const message = getLocationSharingErrorMessage(error, "Could not start live location.");
      if (isLocationApiUnavailable(error)) setApiNotice(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [vaultOwnerToken]);

  const stopLiveUpdates = useCallback(async () => {
    setBusy("stop-live");
    try {
      await KaiLocationSharingService.stopLiveUpdates();
      setLiveRunning(false);
      toast.success("Live location updates stopped.");
    } finally {
      setBusy(null);
    }
  }, []);

  const stopAllSharing = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("stop-sharing");
    try {
      const result = await KaiLocationSharingService.stopActiveShares(vaultOwnerToken);
      await KaiLocationSharingService.stopLiveUpdates();
      setLiveRunning(false);
      setShareUrlsById({});
      setApiNotice(null);
      toast.success(
        result.stoppedCount > 0
          ? "Live location sharing stopped."
          : "No active location shares to stop."
      );
      await refreshState();
    } catch (error) {
      const message = getLocationSharingErrorMessage(
        error,
        "Could not stop live location sharing."
      );
      if (isLocationApiUnavailable(error)) setApiNotice(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [refreshState, vaultOwnerToken]);

  const createContact = useCallback(async () => {
    if (!vaultOwnerToken || limitReached) return;
    setBusy("contact");
    try {
      await KaiLocationSharingService.createContact({
        vaultOwnerToken,
        displayName: form.displayName,
        tier: form.tier,
        autoApprove: form.autoApprove,
      });
      setForm((previous) => ({ ...previous, displayName: "" }));
      setApiNotice(null);
      toast.success("Recipient added.");
      await refreshState();
    } catch (error) {
      const message = getLocationSharingErrorMessage(error, "Could not add recipient.");
      if (isLocationApiUnavailable(error)) setApiNotice(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [form, limitReached, refreshState, vaultOwnerToken]);

  const revokeContact = useCallback(
    async (contactId: string) => {
      if (!vaultOwnerToken) return;
      setBusy(`contact:${contactId}`);
      try {
        await KaiLocationSharingService.revokeContact({ vaultOwnerToken, contactId });
        toast.success("Recipient revoked.");
        await refreshState();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not revoke recipient.");
      } finally {
        setBusy(null);
      }
    },
    [refreshState, vaultOwnerToken]
  );

  const createShare = useCallback(
    async (contact: LocationContact) => {
      if (!vaultOwnerToken) return;
      setBusy(`share:${contact.id}`);
      try {
        const point = currentPoint ?? (await getFreshLocationPoint());
        setCurrentPoint(point);
        const result = await KaiLocationSharingService.createShare({
          vaultOwnerToken,
          contactId: contact.id,
          point,
          durationHours: Number(shareDurationHours) || 1,
          liveMode: true,
        });
        const url = buildSharedLocationUrl(result.token);
        setShareUrlsById((previous) => ({ ...previous, [result.share.id]: url }));
        try {
          const mode = await shareOrCopyLocationUrl(url);
          toast.success(mode === "shared" ? "Live location link shared." : "Live location link copied.");
        } catch {
          toast.success("Live location link created. Copy it from Active Shares.");
        }
        setApiNotice(null);
        await refreshState();
        if (!liveRunning) {
          await startLiveUpdates();
        }
      } catch (error) {
        const message = getLocationSharingErrorMessage(error, "Could not create location link.");
        if (isLocationApiUnavailable(error)) setApiNotice(message);
        toast.error(message);
      } finally {
        setBusy(null);
      }
    },
    [currentPoint, liveRunning, refreshState, shareDurationHours, startLiveUpdates, vaultOwnerToken]
  );

  const copyKnownShareUrl = useCallback(async (share: LocationShare) => {
    const url = shareUrlsById[share.id];
    if (!url) {
      toast.error("This link token is only shown when a new share is created.");
      return;
    }
    await copyLocationUrl(url);
    toast.success("Location link copied.");
  }, [shareUrlsById]);

  const shareKnownUrlOnWhatsApp = useCallback((share: LocationShare) => {
    const url = shareUrlsById[share.id];
    if (!url) {
      toast.error("This link token is only shown when a new share is created.");
      return;
    }
    window.open(buildWhatsAppShareUrl(url), "_blank", "noopener,noreferrer");
  }, [shareUrlsById]);

  const revokeShare = useCallback(
    async (shareId: string) => {
      if (!vaultOwnerToken) return;
      setBusy(`share-revoke:${shareId}`);
      try {
        await KaiLocationSharingService.revokeShare({ vaultOwnerToken, shareId });
        setApiNotice(null);
        toast.success("Location share revoked.");
        await refreshState();
      } catch (error) {
        const message = getLocationSharingErrorMessage(error, "Could not revoke location share.");
        if (isLocationApiUnavailable(error)) setApiNotice(message);
        toast.error(message);
      } finally {
        setBusy(null);
      }
    },
    [refreshState, vaultOwnerToken]
  );

  const decideRequest = useCallback(
    async (accessRequestId: string, decision: "approve" | "deny") => {
      if (!vaultOwnerToken) return;
      setBusy(`${decision}:${accessRequestId}`);
      try {
        if (decision === "approve") {
          await KaiLocationSharingService.approveAccessRequest({
            vaultOwnerToken,
            requestId: accessRequestId,
          });
          toast.success("Location access approved for another 24 hours.");
        } else {
          await KaiLocationSharingService.denyAccessRequest({
            vaultOwnerToken,
            requestId: accessRequestId,
          });
          toast.success("Location access denied.");
        }
        await refreshState();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not update access request.");
      } finally {
        setBusy(null);
      }
    },
    [refreshState, vaultOwnerToken]
  );

  if (authLoading || !user) {
    return null;
  }

  const locked = !isVaultUnlocked || !vaultOwnerToken;

  return (
    <AppPageShell
      as="div"
      width="expanded"
      className="relative pb-32"
    >
      <AppPageContentRegion className="space-y-5">
        <PageHeader
          eyebrow="KAI"
          title="Location Sharing"
          description="Share a live GPS link for up to 24 hours, renew access by consent, and auto-approve only trusted family recipients."
          icon={MapPin}
          accent="kai"
          actions={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshState()}
                isLoading={loading}
              >
                <RefreshCw aria-hidden="true" />
                Refresh
              </Button>
              {liveRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void stopLiveUpdates()}
                  isLoading={busy === "stop-live"}
                >
                  <StopCircle aria-hidden="true" />
                  Pause GPS
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void startLiveUpdates()}
                  disabled={locked || activeShares.length === 0}
                  isLoading={busy === "live"}
                >
                  <Radio aria-hidden="true" />
                  Start live
                </Button>
              )}
              {activeShares.length > 0 ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void stopAllSharing()}
                  disabled={locked}
                  isLoading={busy === "stop-sharing"}
                >
                  <StopCircle aria-hidden="true" />
                  Stop sharing
                </Button>
              ) : null}
            </div>
          }
        />

        {locked ? (
          <SurfaceCard tone="warning">
            <SurfaceCardHeader>
              <SurfaceCardTitle>Unlock Vault to manage sharing</SurfaceCardTitle>
              <SurfaceCardDescription>
                You can refresh GPS now, but adding recipients and creating share links requires
                your VAULT_OWNER consent token.
              </SurfaceCardDescription>
            </SurfaceCardHeader>
            <SurfaceCardContent>
              <Button type="button" size="sm" onClick={() => setVaultDialogOpen(true)}>
                <ShieldCheck aria-hidden="true" />
                Unlock Vault
              </Button>
            </SurfaceCardContent>
          </SurfaceCard>
        ) : null}

        {apiNotice ? (
          <SurfaceCard tone="critical">
            <SurfaceCardHeader>
              <SurfaceCardTitle>Live Location API Needs Deployment</SurfaceCardTitle>
              <SurfaceCardDescription>{apiNotice}</SurfaceCardDescription>
            </SurfaceCardHeader>
            <SurfaceCardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  The web app is ready, but the configured backend is not serving the KAI
                  location routes yet.
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshState()}
                isLoading={loading}
              >
                <RefreshCw aria-hidden="true" />
                Retry backend
              </Button>
            </SurfaceCardContent>
          </SurfaceCard>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <SurfaceCard>
            <SurfaceCardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <SurfaceCardTitle>Live Location Preview</SurfaceCardTitle>
                  <SurfaceCardDescription>
                    A fresh fix is required before creating a new link.
                  </SurfaceCardDescription>
                </div>
                <Badge variant={liveRunning ? "default" : "outline"}>
                  {liveRunning ? "Live" : "Idle"}
                </Badge>
              </div>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-4">
              {currentMaps ? (
                <div className="overflow-hidden rounded-md border bg-background/50">
                  <iframe
                    title="KAI owner live location preview"
                    src={currentMaps.osmEmbed}
                    className="h-72 w-full border-0"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : (
                <div className="flex min-h-56 items-center justify-center rounded-md border border-dashed bg-background/50 p-4 text-center">
                  <div>
                    <MapPin className="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
                    <p className="mt-3 text-sm font-medium">No live map yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Refresh GPS to preview the live location before creating a share.
                    </p>
                  </div>
                </div>
              )}
              <div className="rounded-md border bg-background/50 p-3">
                <p className="text-sm font-medium">{formatPoint(currentPoint)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Accuracy: {currentPoint?.accuracyM ? `${Math.round(currentPoint.accuracyM)}m` : "Unknown"} · Fresh:{" "}
                  {formatDateTime(currentPoint?.capturedAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshGps()}
                isLoading={busy === "gps"}
              >
                <LocateFixed aria-hidden="true" />
                Refresh GPS
              </Button>
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard>
            <SurfaceCardHeader>
              <SurfaceCardTitle>Add Recipient</SurfaceCardTitle>
              <SurfaceCardDescription>
                Active limits: {familyCount}/{state.limits.family} family and {friendCount}/
                {state.limits.friend} friends.
              </SurfaceCardDescription>
            </SurfaceCardHeader>
            <SurfaceCardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_10rem_auto]">
              <div className="space-y-2">
                <Label htmlFor="location-recipient-name">Name</Label>
                <Input
                  id="location-recipient-name"
                  value={form.displayName}
                  placeholder="Mom, Dad, Alex"
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, displayName: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Tier</Label>
                <Select
                  value={form.tier}
                  onValueChange={(value) =>
                    setForm((previous) => ({
                      ...previous,
                      tier: value as LocationContactTier,
                      autoApprove: value === "family" ? previous.autoApprove : false,
                    }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="family">Family</SelectItem>
                    <SelectItem value="friend">Friend</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Duration</Label>
                <Select value={shareDurationHours} onValueChange={setShareDurationHours}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHARE_DURATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-3">
                <label className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
                  <Switch
                    size="sm"
                    checked={form.autoApprove}
                    disabled={form.tier !== "family"}
                    onCheckedChange={(checked) =>
                      setForm((previous) => ({ ...previous, autoApprove: checked }))
                    }
                  />
                  Auto
                </label>
                <Button
                  type="button"
                  onClick={() => void createContact()}
                  disabled={locked || !form.displayName.trim() || limitReached}
                  isLoading={busy === "contact"}
                >
                  <Plus aria-hidden="true" />
                  Add
                </Button>
              </div>
              {limitReached ? (
                <p className="text-xs text-amber-700 sm:col-span-4 dark:text-amber-300">
                  {tierLabel(form.tier)} recipient limit reached.
                </p>
              ) : null}
              {locked ? (
                <p className="text-xs text-muted-foreground sm:col-span-4">
                  Unlock Vault before adding recipients or creating share links.
                </p>
              ) : null}
            </SurfaceCardContent>
          </SurfaceCard>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <SurfaceCard>
            <SurfaceCardHeader>
              <SurfaceCardTitle>Recipients</SurfaceCardTitle>
              <SurfaceCardDescription>
                Share links are bearer links. Anyone with an active link can view until expiry.
              </SurfaceCardDescription>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-2">
              {activeContacts.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Add family or friends before creating a location link.
                </p>
              ) : (
                activeContacts.map((contact) => (
                  <div
                    key={contact.id}
                    className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{contact.displayName}</p>
                        <Badge variant="outline">{tierLabel(contact.tier)}</Badge>
                        {contact.autoApprove ? (
                          <Badge className="bg-emerald-600 text-white">
                            <ShieldCheck aria-hidden="true" />
                            Auto approve
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Added {formatDateTime(contact.createdAt)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void createShare(contact)}
                        disabled={locked}
                        isLoading={busy === `share:${contact.id}`}
                      >
                        <Send aria-hidden="true" />
                        Share
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Revoke ${contact.displayName}`}
                        onClick={() => void revokeContact(contact.id)}
                        isLoading={busy === `contact:${contact.id}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </SurfaceCardContent>
          </SurfaceCard>

          <SurfaceCard>
            <SurfaceCardHeader>
              <SurfaceCardTitle>Pending Access Requests</SurfaceCardTitle>
              <SurfaceCardDescription>
                Expired friend links and non-auto family links require your decision.
              </SurfaceCardDescription>
            </SurfaceCardHeader>
            <SurfaceCardContent className="space-y-2">
              {pendingRequests.length === 0 ? (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No pending requests.
                </p>
              ) : (
                pendingRequests.map((accessRequest) => (
                  <div
                    key={accessRequest.id}
                    className={cn(
                      "rounded-md border p-3",
                      requestId === accessRequest.id && "border-primary bg-primary/5"
                    )}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {accessRequest.contactDisplayName || "Location recipient"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Requested {formatDateTime(accessRequest.requestedAt)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void decideRequest(accessRequest.id, "approve")}
                          isLoading={busy === `approve:${accessRequest.id}`}
                        >
                          <Check aria-hidden="true" />
                          Approve
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void decideRequest(accessRequest.id, "deny")}
                          isLoading={busy === `deny:${accessRequest.id}`}
                        >
                          <X aria-hidden="true" />
                          Deny
                        </Button>
                      </div>
                    </div>
                    {accessRequest.requesterMessage ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {accessRequest.requesterMessage}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </SurfaceCardContent>
          </SurfaceCard>
        </div>

        <SurfaceCard>
          <SurfaceCardHeader>
            <SurfaceCardTitle>Active Shares</SurfaceCardTitle>
            <SurfaceCardDescription>
              Copy or send newly created location URLs through WhatsApp or any message app.
            </SurfaceCardDescription>
          </SurfaceCardHeader>
          <SurfaceCardContent className="space-y-2">
            {activeShares.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                No active location shares.
              </p>
            ) : (
              activeShares.map((share) => (
                <div
                  key={share.id}
                  className="flex flex-col gap-3 rounded-md border p-3"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">
                          {share.contactDisplayName || "Recipient"}
                        </p>
                        <Badge variant="outline">{share.contactTier || "contact"}</Badge>
                        <Badge>{share.liveMode ? "Live" : "Snapshot"}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Expires {formatDateTime(share.expiresAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!shareUrlsById[share.id]}
                        onClick={() => void copyKnownShareUrl(share)}
                      >
                        <Clipboard aria-hidden="true" />
                        Copy
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!shareUrlsById[share.id]}
                        onClick={() => shareKnownUrlOnWhatsApp(share)}
                      >
                        <MessageCircle aria-hidden="true" />
                        WhatsApp
                      </Button>
                      {shareUrlsById[share.id] ? (
                        <Button asChild variant="outline" size="sm">
                          <a href={shareUrlsById[share.id]} target="_blank" rel="noreferrer">
                            <ExternalLink aria-hidden="true" />
                            Open
                          </a>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void revokeShare(share.id)}
                        isLoading={busy === `share-revoke:${share.id}`}
                      >
                        <StopCircle aria-hidden="true" />
                        Stop
                      </Button>
                    </div>
                  </div>
                  {shareUrlsById[share.id] ? (
                    <div className="rounded-md border bg-background/50 p-3">
                      <Label className="text-xs text-muted-foreground">Live location URL</Label>
                      <Input
                        readOnly
                        value={shareUrlsById[share.id]}
                        className="mt-2 font-mono text-xs"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </div>
                  ) : (
                    <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      For security, the raw bearer URL is shown only immediately after creating
                      the share in this browser session.
                    </p>
                  )}
                </div>
              ))
            )}
          </SurfaceCardContent>
        </SurfaceCard>
        {user ? (
          <VaultUnlockDialog
            user={user}
            open={vaultDialogOpen}
            onOpenChange={setVaultDialogOpen}
            title="Unlock Vault for location sharing"
            description="Unlock your Vault to add recipients and create KAI location links."
            enableGeneratedDefault
            onSuccess={() => {
              setVaultDialogOpen(false);
              void refreshState();
            }}
          />
        ) : null}
      </AppPageContentRegion>
    </AppPageShell>
  );
}

export default function KaiLocationPage() {
  return (
    <Suspense fallback={null}>
      <KaiLocationContent />
    </Suspense>
  );
}
