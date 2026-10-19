"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { HelperText, MediumRowLabel } from "@/components/app-ui/typography";
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
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";
import { connectorMemorySharingImpact } from "@/lib/agent/connector-memory-review";
import {
  bindProfileSelectionSources,
  prepareProfileReview,
  profileReviewMessage,
  saveProfileReview,
  selectedProfileDetails,
  type ReviewedProfile,
} from "@/lib/agent/profile-research-review";
import { useBackLayer } from "@/lib/navigation/back-layers";
import {
  PROFILE_SECTION_LABELS,
  ProfileResearchService,
  type ProfileResearchResult,
  type ProfileReport,
} from "@/lib/services/profile-research-service";

type Props = {
  worldModel?: boolean;
  sourceReview?: boolean;
  initialResult?: ProfileResearchResult;
  onSaved?: () => void;
  onDiscarded?: () => void;
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  enabled: boolean;
  pathname: string;
  backQuery?: Readonly<Record<string, string>>;
  renderMessage?: (card: ReactNode, businessFacts?: ReactNode) => ReactNode;
  embedded?: boolean;
  present?: boolean;
  onAvailabilityChange?: (availability: ProfileResearchAvailability) => void;
  onBusinessAvailabilityChange?: (available: boolean) => void;
};
export type ProfileResearchAvailability =
  | "hidden"
  | "pending"
  | "loading"
  | "offered"
  | "empty"
  | "failed"
  | "saved"
  | "low_confidence"
  | "exhausted";
type Phase =
  "loading" | "draft" | "preparing" | "saving" | "saved" | "failed" | "skipped";

/** Explicitly started profile review; never mounted by the chat surface. */
export function useProfileResearchModel({
  worldModel = false,
  sourceReview = false,
  initialResult,
  onSaved,
  onDiscarded,
  ownerId,
  vaultKey,
  vaultOwnerToken,
  enabled,
  pathname,
  backQuery,
  embedded = false,
  present = true,
  onAvailabilityChange,
  onBusinessAvailabilityChange,
}: Props) {
  const [result, setResult] = useState<ProfileResearchResult | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<ReviewedProfile | null>(null);
  const [saveStarted, setSaveStartedState] = useState(false);
  const recoveringSave = useRef(false);
  const setSaveStarted = useCallback((value: boolean) => { recoveringSave.current = value; setSaveStartedState(value); }, []);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [visibleOwner, setVisibleOwner] = useState<{
    ownerId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  } | null>(null);
  const credentials = useRef({ ownerId, vaultKey, vaultOwnerToken, enabled });
  credentials.current = { ownerId, vaultKey, vaultOwnerToken, enabled };
  const operations = useRef(new Set<AbortController>());
  const busy = phase === "preparing" || phase === "saving";
  const partiallySaved = Boolean(review?.committed.size);
  const hasOffer = result?.status === "offered";
  const visible =
    enabled &&
    ownerId &&
    vaultKey &&
    vaultOwnerToken &&
    visibleOwner?.ownerId === ownerId &&
    visibleOwner.vaultKey === vaultKey &&
    visibleOwner.vaultOwnerToken === vaultOwnerToken;

  const cancelReview = useCallback(() => {
    if (busy || saveStarted) return true;
    if (editing) {
      setEditing(false);
      return true;
    }
    if (review) {
      setReview(null);
      setPhase("draft");
      return true;
    }
    return false;
  }, [busy, saveStarted, editing, review]);
  useBackLayer(
    pathname,
    present && visible && (editing || busy || saveStarted)
      ? embedded
        ? 3
        : 2
      : 0,
    cancelReview,
    backQuery,
  );

  useEffect(() => {
    setPhase("loading");
    setResult(null);
    setReview(null);
    setSaveStarted(false);
    setEditing(false);
    setSharingOpen(false);
    setVisibleOwner(null);
    const activeOperations = operations.current;
    return () => {
      activeOperations.forEach((controller) => controller.abort());
      activeOperations.clear();
    };
  }, [ownerId, vaultKey, vaultOwnerToken, enabled, setSaveStarted]);

  useEffect(() => {
    if (!enabled || !ownerId || !vaultKey || !vaultOwnerToken) return;
    // Source preparation is explicitly started by its existing form. An empty
    // source review must never dispatch ambient account research instead.
    if (sourceReview && !initialResult) return;
    // An arriving source refresh cannot discard the exact prepared cards,
    // idempotency scopes or committed set of a pending/uncertain save.
    if (operations.current.size || recoveringSave.current) return;
    // Cleanup cancels only this reader. A resumed effect must reconnect; the
    // encrypted server lease, not a component ref, owns dispatch coalescing.
    const controller = new AbortController();
    const guard = createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: controller.signal,
      isEnabled: () =>
        credentials.current.enabled &&
        credentials.current.ownerId === ownerId &&
        credentials.current.vaultKey === vaultKey &&
        credentials.current.vaultOwnerToken === vaultOwnerToken,
    });
    // Defer dispatch one tick: StrictMode's trial mount cleans up before a paid request starts.
    const timer = setTimeout(() => {
      if (!guard.isCurrent() || operations.current.size || recoveringSave.current) return;
      setResult(null);
      setPhase("loading");
      setVisibleOwner({ ownerId, vaultKey, vaultOwnerToken });
      void (
        initialResult
          ? Promise.resolve(initialResult)
          : ProfileResearchService.research({
              vaultKey,
              vaultOwnerToken,
              signal: controller.signal,
              isCurrent: guard.isCurrent,
              worldModel,
            })
      )
        .then((next) => {
          if (!guard.isCurrent() || operations.current.size || recoveringSave.current) return;
          setResult(next);
          if (next.status === "saved") setPhase("saved");
          setPhase(
            next.status === "saved"
              ? "saved"
              : next.status === "unavailable" && !next.retry_exhausted
                ? "failed"
                : "draft",
          );
          if (
            next.status === "saved" ||
            next.status === "low_confidence" ||
            (next.status === "unavailable" && next.retry_exhausted)
          ) {
            setVisibleOwner({ ownerId, vaultKey, vaultOwnerToken });
          }
          if (next.status === "offered") {
            setVisibleOwner({ ownerId, vaultKey, vaultOwnerToken });
            setSelected(
              new Set(
                next.report.match_status === "matched"
                  ? next.report.sections.flatMap((section) =>
                      section.facts.flatMap((fact, index) =>
                        fact.confidence === "supported" &&
                        section.kind !== "business"
                          ? [`${section.kind}:${index}`]
                          : [],
                      ),
                    )
                  : [],
              ),
            );
            setEdits({});
          }
        })
        .catch(() => {
          if (guard.isCurrent()) setPhase("failed");
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, ownerId, vaultKey, vaultOwnerToken, worldModel, sourceReview, initialResult]);

  const withSession = async (
    operation: (
      session: Parameters<typeof prepareProfileReview>[0],
    ) => Promise<void>,
  ) => {
    if (!ownerId || !vaultKey || !vaultOwnerToken || operations.current.size)
      return;
    const controller = new AbortController();
    operations.current.add(controller);
    const guard = createAgentPkmCaptureGuard({
      userId: ownerId,
      signal: controller.signal,
      isEnabled: () =>
        credentials.current.enabled &&
        credentials.current.ownerId === ownerId &&
        credentials.current.vaultKey === vaultKey &&
        credentials.current.vaultOwnerToken === vaultOwnerToken,
    });
    try {
      await guard.assertCurrent();
      await operation({
        userId: ownerId,
        vaultKey,
        vaultOwnerToken,
        worldModel,
        sourceReview,
        draftId: result?.status === "offered" ? result.draft_id : undefined,
        ...guard,
      });
    } finally {
      operations.current.delete(controller);
    }
  };
  const save = (sharingAcknowledged = false) =>
    void withSession(async (session) => {
      if (result?.status !== "offered" || !selected.size) return;
      setPhase("preparing");
      let prepared: ReviewedProfile | null = review;
      let writeStarted = saveStarted;
      try {
        const message = profileReviewMessage(result.report, selected, edits);
        if (!prepared || prepared.message !== message) {
          prepared = await prepareProfileReview(session, message);
        }
        await session.assertCurrent();
        bindProfileSelectionSources(
          prepared,
          selectedProfileDetails(result.report, selected, edits),
        );
        setReview(prepared);
        setEditing(false);
        if (
          connectorMemorySharingImpact(prepared.cards) > 0 &&
          !sharingAcknowledged
        ) {
          setPhase("draft");
          setSharingOpen(true);
          return;
        }
        setSharingOpen(false);
        setPhase("saving");
        writeStarted = true;
        setSaveStarted(true);
        const ids = new Set(prepared.cards.map((card) => card.card_id));
        const outcome = await saveProfileReview(
          session,
          prepared,
          ids,
          sharingAcknowledged,
        );
        await session.assertCurrent();
        if (outcome.committed.size !== ids.size) {
          throw new Error("Some details still need saving. Retry to finish.");
        }
        setSaveStarted(false);
        setReview(null);
        setPhase("saved");
        onSaved?.();
        morphyToast.success("Details saved");
      } catch (error) {
        if (session.isCurrent()) {
          // Retain exact scopes after a partial/lost response; Retry must never
          // prepare a different payload or duplicate a committed write.
          if (!writeStarted) setReview(null);
          setPhase("draft");
          morphyToast.error(
            error instanceof Error
              ? error.message
              : "Couldn't save. Try again.",
          );
        }
      }
    });

  const availability: ProfileResearchAvailability =
    enabled &&
    ownerId &&
    vaultKey &&
    vaultOwnerToken &&
    phase === "loading" &&
    !result
      ? "pending"
      : visible && (phase === "saved" || result?.status === "saved")
        ? "saved"
        : visible && result?.status === "unavailable" && result.retry_exhausted
          ? "exhausted"
          : visible && result?.status === "low_confidence"
            ? "low_confidence"
            : !visible ||
                phase === "skipped" ||
                (!hasOffer && phase === "draft")
              ? "hidden"
              : phase === "loading"
                ? "loading"
                : phase === "failed"
                  ? "failed"
                  : result?.status === "offered" &&
                      result.report.match_status === "no_match"
                    ? "empty"
                    : "offered";
  useEffect(() => {
    onAvailabilityChange?.(availability);
  }, [onAvailabilityChange, availability]);
  const businessAvailable =
    availability === "offered" &&
    result?.status === "offered" &&
    result.report.sections.some((section) => section.kind === "business");
  useEffect(() => {
    onBusinessAvailabilityChange?.(businessAvailable);
  }, [onBusinessAvailabilityChange, businessAvailable]);
  const dismiss = () =>
    void withSession(async (session) => {
      if (busy || saveStarted) return;
      try {
        if (worldModel || sourceReview) await ProfileResearchService.discard(session);
        await session.assertCurrent();
        setPhase("skipped"); setResult(null); setReview(null); onDiscarded?.();
      } catch { if (session.isCurrent()) morphyToast.error("Couldn’t discard. Try again."); }
    });
  return { result, phase, selected, setSelected, edits, setEdits, editing, setEditing, review, setReview,
    saveStarted, sharingOpen, setSharingOpen, busy, partiallySaved, hasOffer, visible, save, dismiss, availability,
    cancelReview, operationPending: () => operations.current.size > 0 || recoveringSave.current };
}
export type ProfileResearchModel = ReturnType<typeof useProfileResearchModel>;

/** React and native share this exact encrypted prepare/save owner. */
export function ProfileResearchCard(props: Props) {
  const model = useProfileResearchModel(props);
  const { worldModel = false, embedded = false, present = true, renderMessage } = props;
  const { result, phase, selected, setSelected, edits, setEdits, editing, setEditing, setReview,
    saveStarted, sharingOpen, setSharingOpen, busy, partiallySaved, hasOffer, visible, save, dismiss } = model;
  if (
    !present ||
    !visible ||
    phase === "skipped" ||
    (embedded && phase === "saved") ||
    (!worldModel && result?.status === "saved") ||
    (!worldModel && !hasOffer && phase === "draft")
  )
    return renderMessage ? renderMessage(null, null) : null;
  const report = result?.status === "offered" ? result.report : null;
  const renderSection = (section: ProfileReport["sections"][number]) => (
    <AccordionItem key={section.kind} value={section.kind}>
      <AccordionTrigger className="py-2.5 text-[13px]">
        {embedded && section.kind === "business"
          ? "Public sources"
          : PROFILE_SECTION_LABELS[section.kind]}{" "}
        · {section.facts.length}
      </AccordionTrigger>
      <AccordionContent className="space-y-3">
        {section.facts.map((fact, index) => {
          const id = `${section.kind}:${index}`;
          return (
            <div key={id} className="space-y-2">
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={selected.has(id)}
                  disabled={busy || saveStarted}
                  aria-label={`Keep ${fact.statement}`}
                  onCheckedChange={(checked) => {
                    setReview(null);
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(id);
                      else next.delete(id);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0 text-[13px] leading-5">
                  {edits[id] ?? fact.statement}
                </span>
              </label>
              {editing && (
                <Textarea
                  disabled={busy || saveStarted}
                  aria-label={`Edit ${fact.statement}`}
                  maxLength={600}
                  value={edits[id] ?? fact.statement}
                  onChange={(event) => {
                    setReview(null);
                    setEdits((current) => ({
                      ...current,
                      [id]: event.target.value,
                    }));
                  }}
                />
              )}
              {fact.confidence !== "supported" && (
                <HelperText>
                  {fact.confidence === "conflicting"
                    ? "Sources disagree"
                    : "Possible match"}
                </HelperText>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 pl-7">
                {fact.sources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-xs text-muted-foreground underline underline-offset-4"
                  >
                    {source.title}
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </AccordionContent>
    </AccordionItem>
  );
  const content = (
    <>
      <CardHeader className={embedded ? "p-0 pb-1.5" : "p-3 pb-1.5"}>
        {!embedded && (
          <CardTitle className="text-sm">Personal World Model</CardTitle>
        )}
        {report?.name && <MediumRowLabel as="p">{report.name}</MediumRowLabel>}
        {(phase === "loading" ||
          phase === "failed" ||
          phase === "saved" ||
          report?.match_status === "no_match" ||
          !embedded) && (
          <HelperText>
            {phase === "loading"
              ? "Reading your pages…"
              : phase === "failed"
                ? "Personal World Model is unavailable right now."
                : phase === "saved"
                  ? "Your Personal World Model details are saved."
                  : report?.match_status === "no_match"
                    ? "Couldn’t connect these pages to you. Check the links or try another verified contact."
                    : report?.summary}
          </HelperText>
        )}
        {report?.match_status === "uncertain" && (
          <HelperText>Possible match. Confirm only what’s yours.</HelperText>
        )}
      </CardHeader>
      <CardContent
        className={embedded ? "space-y-2 p-0" : "space-y-2 p-3 pt-1.5"}
      >
        {result?.status === "offered" && result.research && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>{result.research.identity.reason}</p>
            {result.research.gaps.length > 0 && (
              <details>
                <summary>Still unknown</summary>
                <ul className="list-disc space-y-1 pl-4">
                  {result.research.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {worldModel &&
          result &&
          !["offered", "saved", "unavailable"].includes(result.status) && (
            <HelperText role="status">
              {result.status === "insufficient_identity"
                ? "Add a name and verify an email or phone in your account to begin."
                : result.status === "not_ready"
                  ? "Finish account setup to begin."
                  : "Research is not available for this account yet."}
            </HelperText>
          )}
        {report && phase !== "saved" && (
          <Accordion
            type="multiple"
            defaultValue={report.sections
              .filter((section) => !embedded || section.kind !== "business")
              .slice(0, 1)
              .map((section) => section.kind)}
          >
            {report.sections
              .filter((section) => !embedded || section.kind !== "business")
              .map(renderSection)}
          </Accordion>
        )}
        {busy && (
          <HelperText role="status">
            {phase === "preparing"
              ? "Preparing selected details…"
              : "Saving…"}
          </HelperText>
        )}
        {saveStarted && !busy && (
          <HelperText>
            {partiallySaved
              ? "Some details saved. Retry to finish."
              : "Save wasn’t confirmed. Try again."}
          </HelperText>
        )}
        {phase === "saved" ? null : (
          <FlowActionGroup
            stacked
            separateSecondary={false}
            secondary={
              <div className="flex w-full items-center justify-between gap-3">
                {report && report.sections.length > 0 && phase === "draft" && (
                  <Button
                    variant="none"
                    size="compact"
                    disabled={saveStarted}
                    onClick={() => setEditing((current) => !current)}
                  >
                    {editing ? "Done editing" : "Edit"}
                  </Button>
                )}
                <Button
                  variant="none"
                  size="compact"
                  className="ml-auto"
                  onClick={dismiss}
                  disabled={busy || saveStarted || phase === "loading"}
                >
                  {worldModel ? "Discard" : "Skip"}
                </Button>
              </div>
            }
            primary={
              phase === "failed" ? null : (
                <Button
                  data-voice-control-id={worldModel ? "pwm_review" : undefined}
                  onClick={() => save()}
                  disabled={busy || !report || !selected.size}
                >
                  {busy
                    ? "Saving…"
                    : saveStarted
                      ? "Retry save"
                      : worldModel
                        ? "Save selected details"
                        : "Save"}
                </Button>
              )
            }
          />
        )}
        <AlertDialog open={sharingOpen} onOpenChange={setSharingOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Update shared details?</AlertDialogTitle>
              <AlertDialogDescription>
                These changes can affect what people with active sharing
                permissions receive.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => save(true)}>
                Confirm and save
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </>
  );
  const card = embedded ? (
    <section
      aria-label="Public profile details"
      data-testid="profile-research-card"
      className="min-w-0"
    >
      {content}
    </section>
  ) : (
    <Card
      preset="compact"
      data-testid="profile-research-card"
      className="min-w-0"
    >
      {content}
    </Card>
  );
  const businessFacts =
    embedded && report && phase !== "saved" ? (
      <Accordion type="multiple">
        {report.sections
          .filter((section) => section.kind === "business")
          .map(renderSection)}
      </Accordion>
    ) : null;
  return renderMessage ? renderMessage(card, businessFacts) : card;
}
