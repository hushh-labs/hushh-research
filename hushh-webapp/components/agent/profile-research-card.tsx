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
import { HelperText } from "@/components/app-ui/typography";
import { AgentPkmReviewPanel } from "@/components/agent/agent-pkm-review-panel";
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
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import {
  prepareProfileReview,
  profileReviewMessage,
  saveProfileReview,
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
  ownerId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  enabled: boolean;
  pathname: string;
  renderMessage?: (card: ReactNode, businessFacts?: ReactNode) => ReactNode;
  embedded?: boolean;
  present?: boolean;
  onAvailabilityChange?: (availability: ProfileResearchAvailability) => void;
  onBusinessAvailabilityChange?: (available: boolean) => void;
};
export type ProfileResearchAvailability =
  "hidden" | "loading" | "offered" | "empty" | "failed" | "saved";
type Phase =
  | "loading"
  | "draft"
  | "preparing"
  | "review"
  | "saving"
  | "saved"
  | "failed"
  | "skipped";

/** Ephemeral One card: outside transcript persistence and automatic memory capture. */
export function ProfileResearchCard({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  enabled,
  pathname,
  renderMessage,
  embedded = false,
  present = true,
  onAvailabilityChange,
  onBusinessAvailabilityChange,
}: Props) {
  const consume = useOneConversationSession(
    (state) => state.consumeProfileResearch,
  );
  const [result, setResult] = useState<ProfileResearchResult | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<ReviewedProfile | null>(null);
  const [selectedCards, setSelectedCards] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [sharingOpen, setSharingOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visibleOwner, setVisibleOwner] = useState<{
    ownerId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  } | null>(null);
  const credentials = useRef({ ownerId, vaultKey, vaultOwnerToken, enabled });
  credentials.current = { ownerId, vaultKey, vaultOwnerToken, enabled };
  const operations = useRef(new Set<AbortController>());
  const attempted = useRef<string | null>(null);
  const busy = phase === "preparing" || phase === "saving";
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
    if (busy) return true;
    if (editing) {
      setEditing(false);
      return true;
    }
    if (review) {
      setReview(null);
      setSelectedCards(new Set());
      setPhase("draft");
      return true;
    }
    return false;
  }, [busy, editing, review]);
  useBackLayer(
    pathname,
    present && visible && (editing || review || busy) ? (embedded ? 3 : 2) : 0,
    cancelReview,
  );

  useEffect(() => {
    setResult(null);
    setReview(null);
    setEditing(false);
    setSharingOpen(false);
    setVisibleOwner(null);
    attempted.current = null;
    const activeOperations = operations.current;
    return () => {
      activeOperations.forEach((controller) => controller.abort());
      activeOperations.clear();
    };
  }, [ownerId, vaultKey, vaultOwnerToken, enabled]);

  useEffect(() => {
    if (!enabled || !ownerId || !vaultKey || !vaultOwnerToken) return;
    const attempt = JSON.stringify([ownerId, vaultKey, vaultOwnerToken, retry]);
    if (attempted.current === attempt) return;
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
      if (!guard.isCurrent()) return;
      attempted.current = attempt;
      setPhase("loading");
      void ProfileResearchService.research({
        vaultKey,
        vaultOwnerToken,
        signal: controller.signal,
      })
        .then((next) => {
          if (!guard.isCurrent()) return;
          setResult(next);
          setPhase(next.status === "unavailable" ? "failed" : "draft");
          if (next.status === "saved") {
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
            // Existing and newly onboarded owners share this path. Consuming
            // the optional setup marker must not dispatch another request.
            consume(ownerId);
          } else if (next.status !== "unavailable") consume(ownerId);
        })
        .catch(() => {
          if (guard.isCurrent()) setPhase("failed");
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, ownerId, vaultKey, vaultOwnerToken, consume, retry]);

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
      await operation({ userId: ownerId, vaultKey, vaultOwnerToken, ...guard });
    } finally {
      operations.current.delete(controller);
    }
  };
  const prepare = () =>
    void withSession(async (session) => {
      if (result?.status !== "offered") return;
      setPhase("preparing");
      try {
        const prepared = await prepareProfileReview(
          session,
          profileReviewMessage(result.report, selected, edits),
        );
        await session.assertCurrent();
        setReview(prepared);
        setSelectedCards(new Set(prepared.cards.map((card) => card.card_id)));
        setEditing(false);
        setPhase("review");
      } catch (error) {
        if (session.isCurrent()) {
          setPhase("draft");
          morphyToast.error(
            error instanceof Error ? error.message : "Please try again.",
          );
        }
      }
    });
  const save = (sharingAcknowledged = false) =>
    void withSession(async (session) => {
      if (!review || !selectedCards.size) return;
      const cards = review.cards.filter((card) =>
        selectedCards.has(card.card_id),
      );
      if (connectorMemorySharingImpact(cards) > 0 && !sharingAcknowledged) {
        setSharingOpen(true);
        return;
      }
      setSharingOpen(false);
      setPhase("saving");
      try {
        const saving = (async () => {
          const outcome = await saveProfileReview(
            session,
            review,
            selectedCards,
            sharingAcknowledged,
          );
          await session.assertCurrent();
          const remaining = new Set(
            [...selectedCards].filter((id) => !outcome.committed.has(id)),
          );
          setSelectedCards(remaining);
          if (remaining.size) {
            setPhase("review");
            throw new Error("Some details still need saving. Retry to finish.");
          }
          setPhase("saved");
          consume(session.userId);
          return outcome;
        })();
        morphyToast.promise(saving, {
          loading: "Saving your reviewed Magic Intelligence details…",
          success: "Magic Intelligence saved privately.",
          error: (error) =>
            error instanceof Error
              ? error.message
              : "Couldn’t save Magic Intelligence. Please try again.",
        });
        await saving;
      } catch {
        if (session.isCurrent()) setPhase("review");
      }
    });

  const availability: ProfileResearchAvailability =
    visible && (phase === "saved" || result?.status === "saved")
      ? "saved"
      : !visible || phase === "skipped" || (!hasOffer && phase === "draft")
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
  if (
    !present ||
    !visible ||
    phase === "skipped" ||
    (embedded && phase === "saved") ||
    (!hasOffer && phase === "draft")
  )
    return renderMessage ? renderMessage(null, null) : null;
  const report = result?.status === "offered" ? result.report : null;
  const dismiss = () => {
    if (!busy) {
      setPhase("skipped");
      setResult(null);
      setReview(null);
      consume(ownerId!);
    }
  };
  const renderSection = (section: ProfileReport["sections"][number]) => (
    <AccordionItem key={section.kind} value={section.kind}>
      <AccordionTrigger>
        {embedded && section.kind === "business"
          ? "Public sources"
          : PROFILE_SECTION_LABELS[section.kind]}{" "}
        · {section.facts.length}
      </AccordionTrigger>
      <AccordionContent className="space-y-4">
        {section.facts.map((fact, index) => {
          const id = `${section.kind}:${index}`;
          return (
            <div key={id} className="space-y-2">
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={selected.has(id)}
                  disabled={busy || !!review}
                  aria-label={`Keep ${fact.statement}`}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 text-sm leading-6">
                  {edits[id] ?? fact.statement}
                </span>
              </label>
              {editing && (
                <Textarea
                  aria-label={`Edit ${fact.statement}`}
                  maxLength={600}
                  value={edits[id] ?? fact.statement}
                  onChange={(event) =>
                    setEdits((current) => ({
                      ...current,
                      [id]: event.target.value,
                    }))
                  }
                />
              )}
              {fact.confidence !== "supported" && (
                <HelperText>
                  {fact.confidence === "conflicting"
                    ? "Sources disagree"
                    : "Uncertain match"}
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
      <CardHeader className={embedded ? "p-0 pb-2" : "p-4 pb-2"}>
        {!embedded && (
          <CardTitle className="text-base">Magic Intelligence</CardTitle>
        )}
        {report?.name && <HelperText>{report.name}</HelperText>}
        <HelperText>
          {phase === "loading"
            ? "One is building your Magic Intelligence profile…"
            : phase === "failed"
              ? "Magic Intelligence is unavailable right now."
              : phase === "saved"
                ? "Your Magic Intelligence details are saved."
                : report?.match_status === "no_match"
                  ? "Magic Intelligence couldn’t find a reliable public profile for you. You can skip this and tell One about yourself in chat."
                  : report?.summary}
        </HelperText>
        {report?.match_status === "uncertain" && (
          <HelperText>
            Check that these details belong to you before selecting them.
          </HelperText>
        )}
      </CardHeader>
      <CardContent
        className={embedded ? "space-y-3 p-0" : "space-y-3 p-4 pt-2"}
      >
        {report && phase !== "saved" && (
          <Accordion type="multiple">
            {report.sections
              .filter((section) => !embedded || section.kind !== "business")
              .map(renderSection)}
          </Accordion>
        )}
        {result?.status === "offered" &&
          phase !== "saved" &&
          result.search_suggestions.map((html, index) => (
            <iframe
              key={index}
              title={`Google Search suggestions ${index + 1}`}
              srcDoc={html}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="h-24 w-full border-0"
            />
          ))}
        {phase === "review" && review ? (
          <AgentPkmReviewPanel
            compact
            showSourceText
            cards={review.cards}
            selectedCardIds={selectedCards}
            onToggleCard={(id, checked) =>
              setSelectedCards((current) => {
                const next = new Set(current);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onSave={() => save()}
            onDismiss={dismiss}
            saveLabel="Confirm and save"
            onEdit={() => {
              setReview(null);
              setEditing(true);
              setPhase("draft");
            }}
          />
        ) : phase === "saved" ? null : (
          <FlowActionGroup
            secondary={
              <Button variant="none" onClick={dismiss} disabled={busy}>
                Skip
              </Button>
            }
            primary={
              phase === "failed" ? (
                <Button onClick={() => setRetry((current) => current + 1)}>
                  Try again
                </Button>
              ) : (
                <Button
                  onClick={prepare}
                  disabled={busy || !report || !selected.size}
                >
                  {busy ? "Preparing…" : "Review and save"}
                </Button>
              )
            }
          />
        )}
        {report && report.sections.length > 0 && phase === "draft" && (
          <Button
            variant="none"
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? "Done editing" : "Edit"}
          </Button>
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
