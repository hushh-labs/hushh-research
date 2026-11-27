"use client";

import { useEffect, useState } from "react";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Switch } from "@/components/ui/switch";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import {
  canManagePodCircleRules,
  deletePodCircleRule,
  listPodCircleRules,
  togglePodCircleRule,
  upsertPodCircleRule,
  validateScopePatternInput,
  type CircleAutoApproveRule,
} from "@/lib/services/pod-circle-rules";

const CIRCLE_OPTIONS = [
  { id: "trusted", label: "Trusted" },
  { id: "family", label: "Family" },
  { id: "work", label: "Work" },
] as const;

const SCOPE_PRESETS = [
  "travel.itinerary.*",
  "calendar.availability",
  "shipping.preferences",
] as const;

export function CircleAutoApprovePanel({
  testId = "circle-auto-approve-panel",
}: {
  testId?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [rules, setRules] = useState<CircleAutoApproveRule[]>([]);
  const [sessionOnlyLockdown, setSessionOnlyLockdown] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const [circleId, setCircleId] = useState<string>("trusted");
  const [label, setLabel] = useState("");
  const [scopeInput, setScopeInput] = useState("travel.itinerary.*");
  const [nlPolicyFilter, setNlPolicyFilter] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!canManagePodCircleRules()) {
      setAvailable(false);
      return;
    }
    const owner = snapshotValidatedAuthSessionOwner();
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted &&
      (!owner || isValidatedAuthSessionOwnerCurrent(owner));

    void listPodCircleRules({ signal: controller.signal, isCurrent })
      .then((data) => {
        if (!isCurrent() || !data) return;
        setRules(data.rules);
        setSessionOnlyLockdown(data.sessionOnlyLockdown);
        setAvailable(true);
      })
      .catch(() => {
        // Silent fallback when the owner's pod session is not open yet.
      });

    return () => controller.abort();
  }, []);

  if (!available) return null;

  const parsePatterns = (raw: string): string[] =>
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

  const handleSaveRule = async () => {
    if (busy) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isCurrent()) return;

    const cleanLabel = label.trim();
    if (!cleanLabel) {
      setValidationError("Give this rule a short name.");
      return;
    }
    const patterns = parsePatterns(scopeInput);
    if (patterns.length === 0) {
      setValidationError("Add at least one permitted scope pattern.");
      return;
    }
    for (const pattern of patterns) {
      const error = validateScopePatternInput(pattern);
      if (error) {
        setValidationError(error);
        return;
      }
    }

    setValidationError(null);
    setBusy(true);
    try {
      const saved = await upsertPodCircleRule(
        {
          circleId,
          label: cleanLabel,
          scopePatterns: patterns,
          nlPolicyFilter: nlPolicyFilter.trim(),
          enabled: true,
        },
        { isCurrent },
      );
      if (!isCurrent()) return;
      setRules((prev) => {
        const without = prev.filter((item) => item.ruleId !== saved.ruleId);
        return [...without, saved];
      });
      setLabel("");
      setNlPolicyFilter("");
      setAdding(false);
      morphyToast.success("Circle auto-approve rule saved.");
    } catch (error) {
      if (isCurrent()) {
        const message =
          error instanceof Error ? error.message : "Could not save Circle rule. Try again.";
        setValidationError(message);
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const handleToggle = async (rule: CircleAutoApproveRule, next: boolean) => {
    if (busy) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isCurrent()) return;

    setBusy(true);
    try {
      const updated = await togglePodCircleRule(rule.ruleId, next, { isCurrent });
      if (isCurrent()) {
        setRules((prev) =>
          prev.map((item) => (item.ruleId === updated.ruleId ? updated : item)),
        );
      }
    } catch {
      if (isCurrent()) {
        morphyToast.error("Could not update Circle rule. Try again.");
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const handleDelete = async (ruleId: string) => {
    if (busy) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isCurrent()) return;

    setBusy(true);
    try {
      await deletePodCircleRule(ruleId, { isCurrent });
      if (isCurrent()) {
        setRules((prev) => prev.filter((item) => item.ruleId !== ruleId));
        morphyToast.success("Circle rule removed.");
      }
    } catch {
      if (isCurrent()) {
        morphyToast.error("Could not remove Circle rule. Try again.");
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Circle auto-approve" density="compact" headingClassName="!mt-5">
      <div data-testid={testId} className="space-y-3 p-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-foreground">
            Dual-Lock offline sharing rules
          </p>
          <p className="text-xs text-[var(--app-text-secondary)]">
            Master Vault Key stays on your device. Only explicitly permitted domain
            subkeys can auto-fulfill trusted Circle requests offline; anything uncertain
            waits for your tap.
          </p>
        </div>

        {sessionOnlyLockdown ? (
          <p
            data-testid="circle-rules-lockdown-banner"
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-card-surface-default)] px-2.5 py-2 text-xs text-[var(--app-text-secondary)]"
          >
            Session-only lockdown is on. Offline Circle rules are paused until you turn
            lockdown off.
          </p>
        ) : null}

        {rules.length === 0 ? (
          <p className="text-xs text-[var(--app-text-secondary)]">
            No offline Circle rules yet. Every incoming request stages for manual review.
          </p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div
                key={rule.ruleId}
                data-testid={`circle-rule-row-${rule.ruleId}`}
                className="flex items-start justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-background p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">
                      {rule.label}
                    </span>
                    <span className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[11px] capitalize text-[var(--app-text-secondary)]">
                      {rule.circleId}
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-[var(--app-text-secondary)]">
                    {rule.scopePatterns.join(", ")}
                  </p>
                  {rule.nlPolicyFilter ? (
                    <p className="text-xs text-[var(--app-text-secondary)]">
                      Filter: {rule.nlPolicyFilter}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    aria-label={`Toggle ${rule.label}`}
                    checked={rule.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => void handleToggle(rule, checked)}
                  />
                  <Button
                    variant="muted"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleDelete(rule.ruleId)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {adding ? (
          <div
            data-testid="circle-rule-builder"
            className="space-y-3 rounded-xl border border-[var(--app-border)] bg-background p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {CIRCLE_OPTIONS.map((option) => (
                <Button
                  key={option.id}
                  variant={circleId === option.id ? "gradient" : "muted"}
                  size="sm"
                  disabled={busy}
                  onClick={() => setCircleId(option.id)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <div className="space-y-1">
              <label
                htmlFor="circle-rule-label"
                className="text-xs font-medium text-foreground"
              >
                Rule name
              </label>
              <input
                id="circle-rule-label"
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Travel confirmations"
                className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 text-xs text-foreground"
              />
            </div>

            <div className="space-y-1">
              <label
                htmlFor="circle-rule-scopes"
                className="text-xs font-medium text-foreground"
              >
                Lock 1: Allowed scope ceiling
              </label>
              <input
                id="circle-rule-scopes"
                type="text"
                value={scopeInput}
                onChange={(event) => {
                  setScopeInput(event.target.value);
                  setValidationError(null);
                }}
                placeholder="travel.itinerary.*, calendar.availability"
                className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SCOPE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setScopeInput(preset);
                      setValidationError(null);
                    }}
                    className="rounded-full border border-[var(--app-border)] px-2 py-0.5 text-[11px] text-[var(--app-text-secondary)] hover:text-foreground"
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="circle-rule-nl-filter"
                className="text-xs font-medium text-foreground"
              >
                Lock 2: Natural-language filter (optional)
              </label>
              <textarea
                id="circle-rule-nl-filter"
                rows={3}
                value={nlPolicyFilter}
                onChange={(event) => setNlPolicyFilter(event.target.value)}
                placeholder="Auto-share upcoming flight and hotel confirmations with Trusted; never share account balances"
                className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-2.5 py-1.5 text-xs text-foreground"
              />
            </div>

            {validationError ? (
              <p
                data-testid="circle-rule-error"
                className="text-xs text-destructive"
              >
                {validationError}
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                variant="gradient"
                size="sm"
                disabled={busy}
                onClick={() => void handleSaveRule()}
              >
                Save rule
              </Button>
              <Button
                variant="muted"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setValidationError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="muted"
            size="sm"
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            Add Circle rule
          </Button>
        )}
      </div>
    </SettingsGroup>
  );
}
