"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useVault } from "@/lib/vault/vault-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { Checkbox } from "@/components/ui/checkbox";
import { HelperText } from "@/components/app-ui/typography";
import { PROFILE_SECTION_LABELS } from "@/lib/services/profile-research-service";
import { WorldModelResearchService } from "@/lib/services/world-model-research-service";
import { useWorldModelResearch } from "./world-model-provider";

/** Native provider attribution is isolated from app privileges and saved facts. */
function SearchSuggestions({ html, index }: { html: string; index: number }) {
  return (
    <iframe
      title={`Google Search suggestions ${index + 1}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-36 w-full border-0"
      srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:">${html}`}
    />
  );
}
export function WorldModelResearchPanel() {
  const { result, preferences, failed, reload, refresh } =
    useWorldModelResearch();
  const { vaultKey, vaultOwnerToken } = useVault();
  const requestedDraft = useSearchParams().get("draft_id");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const [email, setEmail] = useState(false);
  const offered = result?.status === "offered" ? result : null;
  const stale =
    result?.status !== "insufficient_identity" &&
    result?.status !== "not_ready" &&
    !!requestedDraft &&
    result?.status !== "pending" &&
    result?.status !== "paused" &&
    !!result &&
    !("draft_id" in result && result.draft_id === requestedDraft);
  async function update(enabled: boolean, emailEnabled: boolean) {
    if (!vaultKey || !vaultOwnerToken) return;
    setBusy(true);
    setError(false);
    try {
      await WorldModelResearchService.updatePreferences(
        { vaultKey, vaultOwnerToken },
        { enabled, email_enabled: emailEnabled },
      );
      reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!offered || !vaultKey || !vaultOwnerToken) return;
    setBusy(true);
    setError(false);
    try {
      await WorldModelResearchService.discard(
        { vaultKey, vaultOwnerToken },
        offered.draft_id,
      );
      reload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card preset="compact">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">Your research</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {preferences?.enabled ? (
          <>
            <HelperText>
              Public research is enabled. Gemini uses your name and verified
              contact to distinguish you from people with the same name.
            </HelperText>
            <label className="flex min-h-11 items-center gap-3 text-xs">
              <Checkbox
                checked={preferences.email_enabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void update(true, checked === true)
                }
                data-voice-control-id="pwm_email"
              />{" "}
              Email me when research is ready
            </label>
            <Button
              variant="none"
              size="compact"
              disabled={busy}
              data-voice-control-id="pwm_pause"
              onClick={() => void update(false, preferences.email_enabled)}
            >
              Stop automatic research
            </Button>
          </>
        ) : preferences ? (
          <>
            <HelperText>
              Let Gemini search public sources using your name and verified
              email or phone. Results are a draft for you to review. Private
              accounts and advertising history need your own authorized
              connection.
            </HelperText>
            <label className="flex min-h-11 items-center gap-3 text-xs">
              <Checkbox
                checked={email}
                disabled={busy}
                onCheckedChange={(checked) => setEmail(checked === true)}
                data-voice-control-id="pwm_email"
              />{" "}
              Email me when ready
            </label>
            <Button
              size="compact"
              disabled={busy}
              data-voice-control-id="pwm_build"
              onClick={() => void update(true, email)}
            >
              Prepare my model
            </Button>
          </>
        ) : (
          <HelperText role="status">Opening research settings…</HelperText>
        )}
        {stale ? (
          <HelperText role="status">
            This research draft is no longer available. Open Personal World
            Model from Profile to see current research.
          </HelperText>
        ) : offered ? (
          <>
            <div className="space-y-2">
              <p className="text-sm">{offered.report.summary}</p>
              <HelperText>{offered.research.identity.reason}</HelperText>
            </div>
            {offered.report.sections.map((section) => (
              <section key={section.kind} className="space-y-2">
                <h3 className="text-xs font-semibold">
                  {PROFILE_SECTION_LABELS[section.kind]}
                </h3>
                <ul className="space-y-3">
                  {section.facts.map((fact, index) => (
                    <li
                      key={`${section.kind}:${index}`}
                      className="space-y-1 text-[13px]"
                    >
                      <p>{fact.statement}</p>
                      {fact.confidence !== "supported" && (
                        <HelperText>
                          {fact.confidence === "uncertain"
                            ? "Uncertain — please review"
                            : "Sources disagree"}
                        </HelperText>
                      )}
                      <div className="flex flex-wrap gap-x-3">
                        {fact.sources.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline"
                          >
                            {source.title}
                          </a>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <details className="space-y-2">
              <summary className="min-h-11 cursor-pointer text-xs">
                What we checked and what is missing
              </summary>
              <ul className="space-y-3">
                {offered.research.coverage.map((row) => (
                  <li key={row.topic} className="text-xs">
                    <span className="font-semibold">
                      {PROFILE_SECTION_LABELS[
                        row.topic as keyof typeof PROFILE_SECTION_LABELS
                      ] ?? row.topic}
                      :{" "}
                    </span>
                    {row.explanation}
                  </li>
                ))}
              </ul>
            </details>
            {offered.search_suggestions.length > 0 && (
              <div aria-label="Google Search suggestions">
                {offered.search_suggestions.map((html, index) => (
                  <SearchSuggestions key={index} html={html} index={index} />
                ))}
              </div>
            )}
            <details className="space-y-3">
              <summary className="min-h-11 cursor-pointer text-xs">
                Original research responses
              </summary>
              {offered.grounded_answers.map((answer, index) => (
                <section key={index} className="space-y-2">
                  <p className="whitespace-pre-wrap text-[13px]">
                    {answer.answer}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {answer.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center text-xs underline"
                      >
                        {source.title}
                      </a>
                    ))}
                  </div>
                  {answer.search_suggestions.map((html, i) => (
                    <SearchSuggestions key={i} html={html} index={i} />
                  ))}
                </section>
              ))}
            </details>
            <HelperText>
              This Google research response is for viewing. Your saved model
              contains details you have separately approved from your own
              information and permitted sources.
            </HelperText>
            <Button
              size="compact"
              variant="muted"
              disabled={busy}
              data-voice-control-id="pwm_discard"
              onClick={() => void discard()}
            >
              Discard research
            </Button>
          </>
        ) : result?.status === "pending" || result?.status === "paused" ? (
          <HelperText role="status">
            {result.status === "paused"
              ? "Continuing from the last completed research step…"
              : "Preparing your Personal World Model. You can keep using One; Feed will let you know when it is ready."}
          </HelperText>
        ) : result?.status === "insufficient_identity" ? (
          <HelperText>
            Add your name and verify an email or phone to prepare your model.
          </HelperText>
        ) : result?.status === "not_ready" ? (
          <HelperText>Finish account setup to begin preparation.</HelperText>
        ) : result?.status === "saved" ? (
          <HelperText>No active research draft.</HelperText>
        ) : null}
        {result?.status === "saved" && preferences?.enabled && (
          <Button
            size="compact"
            variant="muted"
            onClick={refresh}
            data-voice-control-id="pwm_refresh"
          >
            Refresh research
          </Button>
        )}
        {(failed || error || result?.status === "unavailable") && (
          <div className="space-y-2">
            <HelperText role="status">
              Research couldn’t finish. Completed steps remain available for a
              retry while this draft is retained.
            </HelperText>
            <Button
              variant="muted"
              size="compact"
              disabled={busy}
              onClick={reload}
              data-voice-control-id="pwm_retry"
            >
              Try again
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
