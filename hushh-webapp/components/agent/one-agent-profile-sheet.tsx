"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";

import {
  Sheet,
  SheetContent,
  SheetClose,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SettingsGroup,
  SettingsPresentationProvider,
} from "@/components/app-ui/settings-ui";
import { FeedRow } from "@/components/feed/feed-row";
import {
  Fingerprint,
  Heart,
  X,
  Newspaper,
  ArrowUpRight,
} from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { useOneDisplayName } from "@/lib/agent/use-one-display-name";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { CACHE_KEYS } from "@/lib/services/cache-service";
import {
  FeedService,
  type FeedItem,
  type FeedListResponse,
} from "@/lib/services/feed-service";
import { useFeedLiveRefresh } from "@/lib/feed/use-feed-live-refresh";
import { collapseConsentBundleRows } from "@/lib/feed/feed-consent-grouping";
import { collapseDriveLifecycleRows } from "@/lib/feed/feed-drive-grouping";
import { isFeedItemHidden } from "@/lib/feed/feed-visibility";
import { isFeedIdAtOrBefore } from "@/lib/feed/feed-pagination";
import { readFeedClearedThroughId } from "@/lib/feed/feed-clear-watermark";
import { isLocalCrmBuildEnabled } from "@/lib/connected-systems/crm-product-availability";
import { ROUTES } from "@/lib/navigation/routes";
import { useNativeDrawerPresentation } from "@/lib/capacitor/use-native-drawer-presentation";
import { nativeDrawersPlatformEligible } from "@/lib/capacitor/native-drawers";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { NativeFeaturePage } from "@/components/app-ui/native-feature-page";

import styles from "./one-agent-profile-sheet.module.css";
import { OnePresenceAvatar, type OnePresenceState } from "./one-presence-avatar";

/** A read-only feed preview; the full Feed owns actions and read acknowledgements. */
function OneFeedPreview({
  user,
  onNavigate,
}: {
  user: User;
  onNavigate: (href: string) => void;
}) {
  const { data, loading, error, refresh } = useStaleResource<FeedListResponse>({
    cacheKey: CACHE_KEYS.FEED_LIST(user.uid),
    resourceLabel: "one_profile_feed",
    retainOnInvalidate: true,
    load: async (options) =>
      FeedService.list({
        idToken: await user.getIdToken(),
        userId: user.uid,
        limit: 20,
        force: options?.force,
      }),
  });
  useFeedLiveRefresh(() => {
    void refresh({ force: true });
  });
  const clearedThrough = readFeedClearedThroughId(user.uid);
  const visibleItems = (data?.items ?? []).filter(
    (item) =>
      !isFeedItemHidden(item, isLocalCrmBuildEnabled()) &&
      (!clearedThrough || !isFeedIdAtOrBefore(item.id, clearedThrough)),
  );
  const items = collapseDriveLifecycleRows(
    collapseConsentBundleRows(visibleItems),
  );
  const openFullFeed = (_item: FeedItem) => onNavigate(ROUTES.ONE_FEED);

  return (
    <div className={styles.feed}>
      <div className={styles.sectionHeading}>
        <h3 data-app-pane-section-label>Latest activity</h3>
        <button type="button" onClick={() => onNavigate(ROUTES.ONE_FEED)}>
          Open Feed <ArrowUpRight className="size-4" aria-hidden />
        </button>
      </div>
      {loading && !data ? (
        <p role="status" className={styles.notice}>
          Loading your feed…
        </p>
      ) : null}
      {error && !data ? (
        <div className={styles.notice}>
          <p>Your feed couldn’t load.</p>
          <button
            type="button"
            onClick={() => {
              void refresh({ force: true });
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <div className={styles.empty}>
          <Newspaper className="size-7" aria-hidden />
          <p>No recent activity.</p>
          <span>New activity will appear here.</span>
        </div>
      ) : null}
      {items.length ? (
        <SettingsPresentationProvider density="compact" separatorInset>
          <SettingsGroup>
            {items.map((item) => (
              <FeedRow key={item.id} item={item} onOpen={openFullFeed} />
            ))}
          </SettingsGroup>
        </SettingsPresentationProvider>
      ) : null}
    </div>
  );
}

function ProfileCards({ close }: { close: () => void }) {
  return (
    <div className={styles.profile}>
      <div className={styles.cards}>
        <article
          className={`${styles.fileCard} ${styles.soul}`}
          aria-label="soul.md preview"
        >
          <div>
            <Heart className="size-5" aria-hidden />
            <h4 data-app-pane-row-title>soul.md</h4>
            <p>Voice, values, and personality.</p>
          </div>
          <div className={styles.cardFooter}>
            <span>Soul preview</span>
            <Heart className="size-5" fill="currentColor" aria-hidden />
          </div>
        </article>
        <Link
          href={ROUTES.PKM}
          onClick={close}
          className={`${styles.fileCard} ${styles.memory}`}
          aria-label="Open memory.md in Memory"
        >
          <div>
            <Fingerprint className="size-5" aria-hidden />
            <h4 data-app-pane-row-title>memory.md</h4>
            <p>What you’ve chosen to remember.</p>
          </div>
          <div className={styles.cardFooter}>
            <span>Open Memory</span>
            <ArrowUpRight className="size-5" aria-hidden />
          </div>
        </Link>
      </div>
    </div>
  );
}

type OneAgentProfileProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  modelControl?: ReactNode;
  nativeReady?: boolean;
  presenceState?: OnePresenceState;
};

/** One's presentation is independent of the account Profile lease. The same
 * native drawer owner handles its scrim/motion, while Feed and Memory retain
 * their existing React operations and private information boundaries. */
function NativeOneAgentProfile({ open, onOpenChange, modelControl, nativeReady = false, presenceState = "connected" }: OneAgentProfileProps) {
  const { user } = useAuth();
  const router = useRouter();
  const [section, setSection] = useState<"feed" | "profile" | null>(null);
  const [prepared, setPrepared] = useState<string | null>(null);
  const epoch = snapshotVaultSessionEpoch();
  const context = JSON.stringify([user?.uid, epoch, section]);
  const close = () => onOpenChange(false);
  useEffect(() => { if (!open) { setSection(null); setPrepared(null); } }, [open]);
  const renderer = useNativeDrawerPresentation({ family: "agent-profile", owner: user?.uid ?? null,
    vaultEpoch: epoch, ready: nativeReady && !!user, title: "One",
    open: open && (!section || prepared !== context),
    project: () => ({ sections: [{ id: "one-sections", rows: [
      { id: "one-feed", label: "Feed", symbol: "newspaper", enabled: nativeReady, chevron: true },
      { id: "one-profile", label: "Profile", symbol: "person.crop.circle", enabled: nativeReady, chevron: true },
    ] }], actions: { open: () => undefined, close, rows: new Map([
      ["one-feed", () => setSection("feed")], ["one-profile", () => setSection("profile")],
    ]) } }) });
  const navigate = (href: string) => { close(); router.push(href); };
  if (!open) return null;
  if (renderer === "web") return <WebOneAgentProfile open onOpenChange={onOpenChange} modelControl={modelControl} presenceState={presenceState} />;
  return section ? <NativeFeaturePage pane open title={section === "feed" ? "Feed" : "One"}
    owner={user?.uid ?? null} context={context} backLabel="Back to One profile" closeLabel="Close One profile"
    onReady={() => setPrepared(context)} onBack={() => { setSection(null); setPrepared(null); }} onClose={close}>
    <div className={styles.scroll}>
      {section === "feed" && user ? <OneFeedPreview user={user} onNavigate={navigate} /> :
        <>{modelControl ? <div className={styles.modelControl}>{modelControl}</div> : null}<ProfileCards close={close} /></>}
    </div>
  </NativeFeaturePage> : null;
}

export function OneAgentProfileSheet(props: OneAgentProfileProps) {
  return nativeDrawersPlatformEligible() ? <NativeOneAgentProfile {...props} /> : <WebOneAgentProfile {...props} />;
}

function WebOneAgentProfile({
  open,
  onOpenChange,
  triggerRef,
  modelControl,
  presenceState = "connected",
}: OneAgentProfileProps) {
  const { user } = useAuth();
  const profileName = useOneDisplayName(open);
  const router = useRouter();
  const [tab, setTab] = useState("feed");
  const scrollRef = useRef<HTMLDivElement>(null);
  const changeTab = (value: string) => {
    setTab(value);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const navigate = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  let feed: ReactNode = (
    <p className={styles.notice}>Sign in to view your feed.</p>
  );
  if (open && tab === "feed" && user)
    feed = <OneFeedPreview key={user.uid} user={user} onNavigate={navigate} />;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal>
      <SheetContent
        side="right"
        className={styles.sheet}
        data-app-side-pane
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          if (triggerRef?.current?.isConnected) {
            event.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <SheetClose asChild>
          <button
            type="button"
            aria-label="Close One profile"
            className="app-side-pane-close absolute right-5 z-10 inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        </SheetClose>
        <div className={styles.hero}>
          <div className={styles.avatar}>
            <OnePresenceAvatar state={presenceState} presentation="profile" className={styles.artwork} />
          </div>
          <SheetTitle className={styles.title}>{profileName}</SheetTitle>
          <SheetDescription className="sr-only">
            One profile and activity.
          </SheetDescription>
        </div>
        {modelControl ? <div className={styles.modelControl}>{modelControl}</div> : null}
        <Tabs value={tab} onValueChange={changeTab} className={styles.tabs}>
          <TabsList
            className={styles.tabList}
            aria-label="One profile sections"
          >
            <TabsTrigger value="feed">
              <Newspaper aria-hidden /> Feed
            </TabsTrigger>
            <TabsTrigger value="profile">
              <Fingerprint aria-hidden /> Profile
            </TabsTrigger>
          </TabsList>
          <div ref={scrollRef} className={styles.scroll} data-one-profile-scroll>
            <TabsContent value="feed">{feed}</TabsContent>
            <TabsContent value="profile">
              <ProfileCards close={() => onOpenChange(false)} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
