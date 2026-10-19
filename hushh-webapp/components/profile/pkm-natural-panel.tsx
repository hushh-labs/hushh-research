"use client";

import { SearchClearButton } from "@/components/app-ui/search-clear-button";
import {
  SpinnerGapIcon as Loader2,
  LockIcon as Lock,
  ShieldWarningIcon as ShieldAlert,
} from "@/components/icons";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import {
  SegmentedTabs,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  describeAgentPkmCardDestination,
  formatAgentPkmCardDestination,
  getIgnoredPkmCards,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { Button } from "@/lib/morphy-ux/morphy";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { ROUTES } from "@/lib/navigation/routes";
import { describePkmCaptureSection } from "@/lib/pkm/pkm-capture-sections";
import { pkmMemoryCardBreadcrumb } from "@/lib/pkm/pkm-memory-level";

import { SoulMemoryPanelBody } from "./soul-memory-panel";
import {
  MEMORY_WORKSPACE_TABS,
  cardImpactKey,
  usePkmNaturalModel,
  type MemoryWorkspaceTab,
  type PkmNaturalModel,
  type PkmNaturalModelOptions,
} from "./use-pkm-natural-model";

function CaptureCardDescription({
  card,
  domainTitles,
}: {
  card: AgentPkmPreviewCard;
  domainTitles: ReadonlyMap<string, string>;
}) {
  const destination = describeAgentPkmCardDestination(card, domainTitles);
  const sharing = card.sharing_impact?.active_recipient_count
    ? card.sharing_impact.summary?.trim() ||
      "This may update a detail that is currently shared."
    : "This stays private unless you choose to share it later.";
  return (
    <>
      <span
        className="block font-medium text-foreground"
        data-testid="memory-capture-destination"
        data-destination-kind={destination.kind}
      >
        {formatAgentPkmCardDestination(destination)}
      </span>
      {destination.kind === "not_saved" ? null : (
        <span className="block">{sharing}</span>
      )}
    </>
  );
}

export function PkmNaturalPanel(
  options: PkmNaturalModelOptions & { onOpenExplorer?: () => void } = {},
) {
  const model = usePkmNaturalModel(options);
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
}: {
  model: PkmNaturalModel;
  view: NonNullable<PkmNaturalModelOptions["view"]>;
  locationMemoryId: string | null;
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
    workspaceTab,
    setWorkspaceTab,
    captureText,
    identifierProcessingApproved,
    setIdentifierProcessingApproval,
    memoryScopeShareBundle,
    ownerId,
    captureCards,
    captureHasSharedRecipients,
    captureSharingImpactAcknowledged,
    setCaptureSharingImpactAcknowledged,
    captureUnresolvedSections,
    captureSourceSnapshot,
    captureRetryingSectionKey,
    captureHasUnresolvedSource,
    captureSaveableCards,
    captureLoading,
    captureSaving,
    captureMessage,
    setCaptureMessage,
    sharingManifests,
    sharingManifestsLoading,
    sharingActionKey,
    memorySharingActionId,
    memorySharingError,
    setMemorySharingError,
    homeSearchQuery,
    setHomeSearchQuery,
    memoryCards,
    memoryCardsLoading,
    memoryCardsLoadError,
    visibleMetadataDomains,
    domainTitles,
    selectedMetadataDomain,
    categories,
    persistMemoryCardChange,
    previewMemoryCapture,
    retryCaptureSection,
    saveMemoryCapture,
    updateSharingBundles,
    memorySharingState,
    memorySharingPosture,
    updateMemoryScopeSharing,
    trimmedQuery,
    searchResults,
    matchedCategories,
    recentMemories,
    openMemory,
    canOpen,
    signedIn,
    locationLoading,
    soul,
    changeCaptureText,
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
    return (
      <SettingsRow
        key={domain.key}
        title={domain.title}
        description={`${domain.count} ${domain.count === 1 ? "memory" : "memories"}`}
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

  const addMemoryRow = (
    <SettingsRow
      title="Add Memory"
      onClick={() => setWorkspaceTab("add")}
      chevron
      ariaLabel="Add Memory"
      testId="memory-add-row"
    />
  );

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
          <p>Your saved details stay connected to your account.</p>
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
          <p>
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
              variant="muted"
              size="sm"
              onClick={() => replaceRoute(ROUTES.PKM_LOCATION)}
            >
              Open Location memory
            </Button>
          </SurfaceInset>
        ) : (
          <LocationMemoryView
            presentation={locationPresentation}
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
          sharingControls={sharingManifests[selectedMetadataDomain.key] ? <PkmDomainSharing
            key={`${ownerId}:${selectedMetadataDomain.key}`}
            userId={ownerId} title={selectedMetadataDomain.displayName} manifest={sharingManifests[selectedMetadataDomain.key]!}
            pendingKey={sharingActionKey} onChange={updateSharingBundles} /> : <SurfaceInset className="space-y-2 p-4 text-sm text-muted-foreground">
              <p>{sharingManifestsLoading ? "Checking sharing and prices…" : "Sharing and prices could not be checked."}</p>
              {!sharingManifestsLoading ? <Button variant="muted" size="sm" onClick={() => setRefreshNonce(value => value + 1)}>Retry sharing settings</Button> : null}
            </SurfaceInset>}

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
      <div className="space-y-[var(--page-header-section-gap)]">
        <SegmentedTabs
          tabSetId="memory"
          ariaLabel="Memory"
          value={workspaceTab}
          onValueChange={(value) =>
            setWorkspaceTab(value as MemoryWorkspaceTab)
          }
          options={MEMORY_WORKSPACE_TABS}
          mobileColumns={2}
          variant="agent-top"
        />
        <SwipeViews
          options={MEMORY_WORKSPACE_TABS}
          tabSetId="memory"
          activeValue={workspaceTab}
          onSelectionChange={(value) =>
            setWorkspaceTab(value as MemoryWorkspaceTab)
          }
          viewportMinHeight="fill"
          heightMode="active"
        >
          <div className="space-y-5 pb-1 pr-px" data-pkm-saved-panel="true">
            <SoulMemoryPanelBody model={soul} />
            <div className="relative">
              <Input
                type="search"
                value={homeSearchQuery}
                onChange={(event) => setHomeSearchQuery(event.target.value)}
                placeholder="Search Memory"
                aria-label="Search Memory"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 pr-11"
              />
              <SearchClearButton
                visible={homeSearchQuery.length > 0}
                label="Clear Memory search"
                onClear={() => setHomeSearchQuery("")}
              />
            </div>

            {workspaceTab === "browse" ? <MemoryCommerceSummary /> : null}
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
                  size="sm"
                  variant="muted"
                  onClick={() => setMemoryCardsNonce((current) => current + 1)}
                >
                  Try again
                </Button>
              </SurfaceInset>
            ) : trimmedQuery ? (
              searchResults.length === 0 && matchedCategories.length === 0 ? (
                <SurfaceInset
                  className="p-4 text-sm text-muted-foreground"
                  data-pkm-search-empty="true"
                >
                  No memories match “{trimmedQuery}”.
                </SurfaceInset>
              ) : (
                <>
                  {searchResults.length > 0 ? (
                    <SettingsGroup
                      title="Memories"
                      separatorInset
                      testId="memory-search-results"
                    >
                      {searchResults.map((card) => (
                        <PkmMemoryRow
                          key={card.id}
                          card={card}
                          onOpen={openMemory}
                          breadcrumb={pkmMemoryCardBreadcrumb(card)}
                        />
                      ))}
                    </SettingsGroup>
                  ) : null}
                  {matchedCategories.length > 0 ? (
                    <SettingsGroup title="Categories" separatorInset>
                      {matchedCategories.map(renderCategoryRow)}
                    </SettingsGroup>
                  ) : null}
                </>
              )
            ) : (
              <>
                {recentMemories.length > 0 ? (
                  <SettingsGroup
                    separatorInset
                    testId="memory-recently-learned"
                  >
                    <SettingsRow
                      title="Recently learned"
                      description={`${recentMemories.length} ${recentMemories.length === 1 ? "memory" : "memories"}`}
                      onClick={() => navigate(ROUTES.PKM_RECENT)}
                      chevron
                      ariaLabel="Open recently learned memories"
                      testId="memory-recently-learned-row"
                    />
                  </SettingsGroup>
                ) : null}

                {categories.length > 0 ? (
                  <SettingsGroup
                    title="Categories"
                    separatorInset
                    testId="memory-categories"
                  >
                    {categories.map(renderCategoryRow)}
                    {addMemoryRow}
                  </SettingsGroup>
                ) : (
                  <>
                    {metadata &&
                    !bootstrapLoading &&
                    !bootstrapError &&
                    !memoryCardsLoading &&
                    !memoryCardsLoadError ? (
                      <p className="px-1 text-sm text-muted-foreground">
                        One hasn’t saved anything yet.
                      </p>
                    ) : null}
                    <SettingsGroup separatorInset>{addMemoryRow}</SettingsGroup>
                  </>
                )}

                {bootstrapError ? (
                  <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
                    <p>Some saved details couldn’t be loaded.</p>
                    <Button
                      size="sm"
                      variant="muted"
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
                      size="sm"
                      variant="muted"
                      onClick={() =>
                        setMemoryCardsNonce((current) => current + 1)
                      }
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          <PkmSavedSharing userId={ownerId} active={workspaceTab === "browse"}
            domains={visibleMetadataDomains} sharingManifests={sharingManifests}
            sharingManifestsLoading={sharingManifestsLoading} sharingActionKey={sharingActionKey}
            retrySharing={() => setRefreshNonce(value => value + 1)}
            isVaultUnlocked={isVaultUnlocked} exportBusy={exportBusy} exportStatus={exportStatus}
            exportError={exportError} handleExportMemory={handleExportMemory} updateSharingBundles={updateSharingBundles} />
          </div>
          <div className="space-y-5 pb-1 pr-px">
            <SurfaceInset
              className="space-y-4 p-4"
              data-pkm-memory-capture="true"
            >
              <Textarea
                value={captureText}
                disabled={captureSaving}
                onPaste={(event) => {
                  const input = event.currentTarget;
                  const length =
                    captureText.length -
                    (input.selectionEnd - input.selectionStart) +
                    event.clipboardData.getData("text/plain").length;
                  if (length > 50000) {
                    event.preventDefault();
                    setCaptureMessage(
                      "That paste is too long. Add smaller sections; your existing note is unchanged.",
                    );
                  }
                }}
                onChange={(event) => {
                  changeCaptureText(event.target.value);
                }}
                placeholder="I prefer morning flights whenever possible."
                aria-label="Memory note"
                maxLength={50000}
              />
              <label className="flex items-start gap-3 text-sm text-muted-foreground">
                <input type="checkbox" checked={identifierProcessingApproved()} disabled={captureLoading || captureSaving}
                  onChange={(event) => setIdentifierProcessingApproval(event.target.checked)} />
                <span>Allow my private agent’s configured model to process personal identifiers in this note, including SSN, to prepare Memory. Sharing requires a separate approval.</span>
              </label>
              <Button
                className="w-full justify-center"
                type="button"
                variant="muted"
                effect="fade"
                disabled={
                  captureLoading || captureSaving || !captureText.trim()
                }
                onClick={() => void previewMemoryCapture()}
              >
                {captureLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Review memory
              </Button>
              {captureMessage ? (
                <p
                  role="status"
                  data-testid="memory-preparation-status"
                  className="text-sm text-muted-foreground"
                >
                  {captureMessage}
                </p>
              ) : null}
              {captureCards.length > 0 ? (
                <SettingsGroup separatorInset>
                  {captureCards.map((card) => (
                    <SettingsRow
                      key={card.card_id}
                      // A multi-line detail (a heading with its list) reads as one row.
                      title={
                        card.source_text?.trim().replace(/\s*\n+\s*/g, " · ") ||
                        "Proposed saved detail"
                      }
                      description={
                        <CaptureCardDescription
                          card={card}
                          domainTitles={domainTitles}
                        />
                      }
                    />
                  ))}
                  {getIgnoredPkmCards(captureCards).length > 0 ? (
                    <SettingsRow
                      title="Some of this note will not be saved"
                      description="Only appropriate details can be added to Memory."
                    />
                  ) : null}
                </SettingsGroup>
              ) : null}
              {captureHasUnresolvedSource ? (
                <SettingsGroup
                  separatorInset
                  testId="memory-unresolved-sections"
                >
                  {captureUnresolvedSections.map((block) => {
                    const section = describePkmCaptureSection(
                      captureSourceSnapshot,
                      block,
                    );
                    return (
                      <SettingsRow
                        key={section.key}
                        testId="memory-unresolved-section"
                        title={section.label}
                        description={`${section.reason} Nothing from this section has been saved.`}
                        stackTrailingOnMobile
                        trailingInteractive
                        trailing={
                          section.retryable ? (
                            <Button
                              type="button"
                              variant="muted"
                              effect="fade"
                              aria-label={`Retry this section: ${section.label}`}
                              disabled={
                                captureLoading ||
                                captureSaving ||
                                captureRetryingSectionKey !== null
                              }
                              onClick={() => void retryCaptureSection(block)}
                            >
                              {captureRetryingSectionKey === section.key ? (
                                <Loader2
                                  className="mr-2 h-4 w-4 animate-spin"
                                  aria-hidden
                                />
                              ) : null}
                              Retry this section
                            </Button>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </SettingsGroup>
              ) : null}
              {captureHasSharedRecipients ? (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
                  data-pkm-sharing-impact="true"
                >
                  <label
                    htmlFor="memory-sharing-impact-ack"
                    className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-foreground"
                  >
                    <Checkbox
                      id="memory-sharing-impact-ack"
                      checked={captureSharingImpactAcknowledged}
                      onCheckedChange={(checked) =>
                        setCaptureSharingImpactAcknowledged(checked === true)
                      }
                      disabled={captureSaving}
                    />
                    <span>
                      I understand that this detail is already shared and will
                      be refreshed for the current recipients.
                    </span>
                  </label>
                  <p className="pl-7 text-xs leading-5 text-muted-foreground">
                    Review this before saving. It does not change who can access
                    the detail.
                  </p>
                </div>
              ) : null}
              {captureCards.length > 0 ? (
                <Button
                  data-testid="memory-save-capture"
                  className="w-full justify-center"
                  type="button"
                  effect="fade"
                  disabled={
                    captureSaving ||
                    captureSaveableCards.length === 0 ||
                    captureRetryingSectionKey !== null ||
                    (captureHasSharedRecipients &&
                      !captureSharingImpactAcknowledged)
                  }
                  onClick={() => void saveMemoryCapture()}
                >
                  {captureSaving ? (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden
                    />
                  ) : null}
                  Save to Memory
                </Button>
              ) : null}
            </SurfaceInset>
          </div>
        </SwipeViews>
      </div>
    </>
  );
}
