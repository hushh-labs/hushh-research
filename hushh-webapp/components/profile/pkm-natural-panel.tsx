"use client";

import {
  SpinnerGapIcon as Loader2,
  LockIcon as Lock,
  ShieldWarningIcon as ShieldAlert,
} from "@/components/icons";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { LocationMemoryView } from "@/components/profile/location-memory-view";
import { PkmMemoryDetail } from "@/components/profile/pkm-memory-detail";
import { PkmMemoryLevel } from "@/components/profile/pkm-memory-level";
import { PkmMemoryRow } from "@/components/profile/pkm-memory-row";
import { PkmSavedSharing } from "@/components/profile/pkm-saved-sharing";
import { PkmDomainSharing } from "@/components/profile/pkm-domain-sharing";
import { MemoryCommerceSummary } from "@/components/profile/memory-commerce-summary";
import { ScopeTariffEditor } from "@/components/consent/scope-tariff-editor";
import { consentScopeForPermission } from "@/lib/personal-knowledge-model/slice-publishing";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/morphy";
import { ROUTES, normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import { sharingPriceTargets } from "@/lib/profile/pkm-sharing-price-review";

import { MemoryKnowledgeHub } from "./memory-knowledge-hub";
import {
  cardImpactKey,
  usePkmNaturalModel,
  type PkmNaturalModel,
  type PkmNaturalModelOptions,
} from "./use-pkm-natural-model";
import { NativeMemoryWorkspace, type NativeMemoryRetainedOwners } from "./native-memory-workspace";
import { MemoryCommerceSummaryView } from "./memory-commerce-summary";

export function PkmNaturalPanel(
  options: PkmNaturalModelOptions & { onOpenExplorer?: () => void } = {},
) {
  const model = usePkmNaturalModel(options);
  const pathname = normalizeStaticExportPathname(usePathname() ?? "/");
  if (pathname === ROUTES.PKM && (options.view ?? "home") === "home") {
    return <NativeMemoryWorkspace model={model} renderFallback={owners =>
      <PkmNaturalPanelBody model={model} view="home" locationMemoryId={null} retainedOwners={owners} />} />;
  }
  return (
    <PkmNaturalPanelBody
      model={model}
      view={options.view ?? "home"}
      locationMemoryId={options.locationMemoryId ?? null}
    />
  );
}

/** Shared web fallback; the retained feature model lives above renderer selection. */
export function PkmNaturalPanelBody({
  model,
  view,
  locationMemoryId,
  retainedOwners,
  locationSearch,
}: {
  model: PkmNaturalModel;
  view: NonNullable<PkmNaturalModelOptions["view"]>;
  locationMemoryId: string | null;
  retainedOwners?: NativeMemoryRetainedOwners;
  locationSearch?: { query: string; setQuery: (value: string) => void };
}) {
  const {
    authLoading,
    sessionVerificationRequired,
    isVaultUnlocked,
    locationView,
    setSelectedDomainKey,
    setPathStack,
    metadata,
    bootstrapLoading,
    bootstrapError,
    setRefreshNonce,
    pathStack,
    locationPresentation,
    locationField,
    selectedCard,
    unwindMemory,
    setMemoryCardsNonce,
    memoryActionId,
    memoryActionError,
    sharingImpacts,
    sharingImpactError,
    exportBusy,
    exportStatus,
    exportError,
    handleExportMemory,
    memoryScopeShareBundle,
    ownerId,
    sharingManifests,
    sharingManifestsLoading,
    sharingActionKey,
    memorySharingActionId,
    memorySharingError,
    setMemorySharingError,
    memoryCards,
    memoryCardsLoading,
    memoryCardsLoadError,
    visibleMetadataDomains,
    selectedMetadataDomain,
    categories,
    persistMemoryCardChange,
    updateSharingBundles,
    memorySharingState,
    memorySharingPosture,
    updateMemoryScopeSharing,
    recentMemories,
    openMemory,
    canOpen,
    signedIn,
    locationLoading,
    domainDetail,
    navigate,
    replaceRoute,
  } = model;
  const { nativeDataState } = model;
  const nativeBeacon = (
    <NativeTestBeacon
      routeId={
        view === "location-detail"
          ? ROUTES.PKM_LOCATION_DETAIL
          : view === "location"
            ? ROUTES.PKM_LOCATION
            : view === "recent"
              ? ROUTES.PKM_RECENT
              : ROUTES.PKM
      }
      marker={
        view === "location-detail"
          ? "native-route-pkm-location-detail"
          : view === "location"
            ? "native-route-pkm-location"
            : view === "recent"
              ? "native-route-pkm-recent"
              : "native-route-pkm"
      }
      authState={
        signedIn ? "authenticated" : authLoading ? "pending" : "anonymous"
      }
      dataState={nativeDataState}
      errorCode={nativeDataState === "error" ? "pkm_memory_unavailable" : null}
    />
  );

  function renderCategoryRow(domain: {
    key: string;
    title: string;
    count: number;
  }) {
    const countLabel = `${domain.count} ${domain.count === 1 ? "memory" : "memories"}`;
    const manifest =
      domain.key !== "location" && !sharingManifestsLoading
        ? sharingManifests[domain.key]
        : null;
    const bundles = manifest ? buildPkmShareBundles(manifest) : [];
    const enabledCount = bundles.filter((bundle) => bundle.enabled).length;
    const sharingSummary =
      bundles.length === 0
        ? ""
        : enabledCount === 0
          ? " · Private"
          : enabledCount === bundles.length
            ? " · Ask first"
            : ` · ${enabledCount} of ${bundles.length} ask first`;
    return (
      <SettingsRow
        key={domain.key}
        title={domain.title}
        description={`${countLabel}${sharingSummary}`}
        onClick={() =>
          domain.key === "location"
            ? navigate(ROUTES.PKM_LOCATION)
            : setSelectedDomainKey(domain.key)
        }
        chevron
        ariaLabel={`Open category: ${domain.title}`}
        testId={`memory-category-${domain.key}`}
      />
    );
  }

  if (authLoading) {
    return (
      <>
        {nativeBeacon}
        <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Opening Memory…
        </SurfaceInset>
      </>
    );
  }

  if (!signedIn || (locationView && sessionVerificationRequired)) {
    return (
      <>
        {nativeBeacon}
        <SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            Sign in to open Memory
          </div>
          <p data-pkm-body="true">Your saved details stay connected to your account.</p>
        </SurfaceInset>
      </>
    );
  }

  if (!canOpen) {
    return (
      <>
        {nativeBeacon}
        <SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <Lock className="h-4 w-4" aria-hidden />
            Unlock your vault to open Memory
          </div>
          <p data-pkm-body="true">
            Your saved details are decrypted only for this unlocked session.
          </p>
        </SurfaceInset>
      </>
    );
  }

  if (locationView && (view === "location" || !selectedCard)) {
    const missingDetail =
      view === "location-detail" &&
      !locationLoading &&
      !bootstrapError &&
      !domainDetail.error;
    return (
      <>
        {nativeBeacon}
        {missingDetail ? (
          <SurfaceInset className="space-y-3 p-4" data-pkm-location-view="true">
            <p>This detail is no longer available.</p>
            <Button
              variant="none"
              effect="fade"
              size="compact"
              data-pkm-action="compact"
              onClick={() => replaceRoute(ROUTES.PKM_LOCATION)}
            >
              Open Location memory
            </Button>
          </SurfaceInset>
        ) : (
          <LocationMemoryView
            presentation={locationPresentation}
            search={locationSearch}
            loading={locationLoading}
            error={bootstrapError || domainDetail.error}
            onRetry={() => {
              setRefreshNonce((value) => value + 1);
              setMemoryCardsNonce((value) => value + 1);
            }}
            onOpen={(field) =>
              navigate(`${ROUTES.PKM_LOCATION_DETAIL}?memory=${field.selector}`)
            }
          />
        )}
      </>
    );
  }

  if (selectedCard) {
    const priceSection = memoryScopeShareBundle(selectedCard);
    return (
      <>
        {nativeBeacon}
        <PkmMemoryDetail
          key={locationView ? locationMemoryId : selectedCard.id}
          card={selectedCard}
          displayLabel={locationField?.label}
          displayValue={locationField?.value}
          displayContext={locationField?.context}
          hideBack={locationView}
          sharingState={memorySharingState(selectedCard)}
          sharingPosture={memorySharingPosture(selectedCard)}
          sharingBusy={memorySharingActionId === cardImpactKey(selectedCard)}
          sharingError={memorySharingError}
          sharingPriceControl={priceSection?.scopeHandle ? <div className="space-y-2 border-t pt-4">
            <p className="text-xs text-muted-foreground">Price applies to requests for the entire {priceSection.label} section. You review the requested scope before approval.</p>
            <ScopeTariffEditor key={`${ownerId}:${priceSection.scopeHandle}:${selectedCard.domain}:${priceSection.topLevelScopePath}`} scopeHandle={priceSection.scopeHandle} machineScope={consentScopeForPermission(selectedCard.domain, priceSection.topLevelScopePath)} label={priceSection.label} showSavedPrice />
          </div> : null}
          canMutate={
            selectedCard.editable &&
            Boolean(sharingImpacts[cardImpactKey(selectedCard)])
          }
          saving={memoryActionId === `${selectedCard.id}:edited`}
          deleting={memoryActionId === `${selectedCard.id}:deleted`}
          actionError={memoryActionError}
          onBack={() => {
            if (locationView) navigate(ROUTES.PKM_LOCATION);
            else unwindMemory();
          }}
          onSharingChange={(nextPosture) =>
            void updateMemoryScopeSharing(selectedCard, nextPosture)
          }
          onSharingOpenChange={(open) => {
            if (!open) setMemorySharingError(null);
          }}
          onSave={(nextValue) =>
            void persistMemoryCardChange({
              card: selectedCard,
              action: "edited",
              nextValue,
            })
          }
          onForget={() =>
            void persistMemoryCardChange({
              card: selectedCard,
              action: "deleted",
            })
          }
          onOpenOwner={(routePattern) => navigate(routePattern)}
        />
      </>
    );
  }

  if (selectedMetadataDomain) {
    const domainManifest = sharingManifests[selectedMetadataDomain.key];
    const coveredRootSegments = new Set(
      (domainManifest ? buildPkmShareBundles(domainManifest) : [])
        .filter((bundle) =>
          sharingPriceTargets(domainManifest!).some(
            (target) =>
              target.scopeHandle === bundle.scopeHandle &&
              target.machineScope ===
                `attr.${domainManifest!.domain}.${bundle.topLevelScopePath}.*`,
          ),
        )
        .map((bundle) => bundle.topLevelScopePath),
    );
    return (
      <>
        {nativeBeacon}
        <PkmMemoryLevel
          domainKey={selectedMetadataDomain.key}
          domainTitle={selectedMetadataDomain.displayName}
          data={domainDetail.data}
          pathStack={pathStack}
          loading={domainDetail.loading || memoryCardsLoading}
          error={domainDetail.error}
          sharingImpactError={sharingImpactError}
          sourceLabel={selectedMetadataDomain.readableSourceLabel || undefined}
          updatedAt={
            selectedMetadataDomain.readableUpdatedAt ||
            selectedMetadataDomain.lastUpdated ||
            null
          }
          onDrill={(segment) => setPathStack((stack) => [...stack, segment])}
          onBack={unwindMemory}
          onOpenLeaf={openMemory}
          coveredRootSegments={coveredRootSegments}
          renderSharingControls={({ sectionCounts, onOpenSection }) =>
            domainManifest ? (
              <PkmDomainSharing
                key={`${ownerId}:${selectedMetadataDomain.key}`}
                userId={ownerId}
                title={selectedMetadataDomain.displayName}
                manifest={domainManifest}
                pendingKey={sharingActionKey}
                sectionCounts={sectionCounts}
                onOpenSection={onOpenSection}
                onChange={updateSharingBundles}
              />
            ) : (
              <SurfaceInset className="space-y-2 p-4 text-sm text-muted-foreground">
                <p>
                  {sharingManifestsLoading
                    ? "Checking sharing and prices…"
                    : "Sharing and prices could not be checked."}
                </p>
                {!sharingManifestsLoading ? (
                  <Button
                    variant="none"
                    effect="fade"
                    size="compact"
                    data-pkm-action="compact"
                    onClick={() => setRefreshNonce((value) => value + 1)}
                  >
                    Retry sharing settings
                  </Button>
                ) : null}
              </SurfaceInset>
            )
          }
        />
      </>
    );
  }

  if (view === "recent") {
    return (
      <>
        {nativeBeacon}
        {recentMemories.length > 0 ? (
          <SettingsGroup separatorInset testId="memory-recent-list">
            {recentMemories.map((card) => (
              <PkmMemoryRow key={card.id} card={card} onOpen={openMemory} />
            ))}
          </SettingsGroup>
        ) : (
          <SurfaceInset
            className="px-4 py-4 text-sm text-muted-foreground"
            data-testid="memory-recent-empty"
          >
            Nothing learned yet.
          </SurfaceInset>
        )}
      </>
    );
  }

  return (
    <>
      {nativeBeacon}
      <div className="space-y-5 pb-1 pr-px" data-pkm-saved-panel="true">
        <MemoryKnowledgeHub />
        {retainedOwners ? (
          <MemoryCommerceSummaryView model={retainedOwners.commerce} />
        ) : (
          <MemoryCommerceSummary />
        )}
        {(bootstrapLoading ||
          (!metadata && !bootstrapError) ||
          memoryCardsLoading) &&
        memoryCards.length === 0 ? (
          <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Opening Memory…
          </SurfaceInset>
        ) : memoryCardsLoadError && memoryCards.length === 0 ? (
          <SurfaceInset className="space-y-3 p-4 text-sm text-muted-foreground">
            <p>Some saved details couldn’t be opened.</p>
            <Button
              size="compact"
              variant="none"
              effect="fade"
              data-pkm-action="compact"
              onClick={() => setMemoryCardsNonce((current) => current + 1)}
            >
              Try again
            </Button>
          </SurfaceInset>
        ) : (
          <>
            {categories.length > 0 ? (
              <SettingsGroup
                title="Scopes"
                separatorInset
                testId="memory-categories"
              >
                {categories.map(renderCategoryRow)}
              </SettingsGroup>
            ) : metadata &&
              !bootstrapLoading &&
              !bootstrapError &&
              !memoryCardsLoading &&
              !memoryCardsLoadError ? (
              <SurfaceInset
                className="px-4 py-4 text-sm text-muted-foreground"
                data-testid="memory-scopes-empty"
              >
                No sharable scopes saved yet.
              </SurfaceInset>
            ) : null}

            {bootstrapError ? (
              <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
                <p>Some saved details couldn’t be loaded.</p>
                <Button
                  size="compact"
                  variant="none"
                  effect="fade"
                  data-pkm-action="compact"
                  onClick={() => setRefreshNonce((current) => current + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : null}
            {memoryCardsLoadError ? (
              <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
                <p>
                  Some saved details couldn’t be refreshed. Your available
                  details are still here.
                </p>
                <Button
                  size="compact"
                  variant="none"
                  effect="fade"
                  data-pkm-action="compact"
                  onClick={() => setMemoryCardsNonce((current) => current + 1)}
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </>
        )}
        <PkmSavedSharing
          userId={ownerId}
          active={true}
          owner={retainedOwners?.sharing}
          domains={visibleMetadataDomains}
          sharingManifests={sharingManifests}
          sharingManifestsLoading={sharingManifestsLoading}
          sharingActionKey={sharingActionKey}
          retrySharing={() => setRefreshNonce((value) => value + 1)}
          isVaultUnlocked={isVaultUnlocked}
          exportBusy={exportBusy}
          exportStatus={exportStatus}
          exportError={exportError}
          handleExportMemory={handleExportMemory}
          updateSharingBundles={updateSharingBundles}
        />
      </div>
    </>
  );
}
