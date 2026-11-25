"use client";
import { KaiControlSurface } from "@/components/app-ui/kai-control-surface";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { FinanceSharingPreview } from "./finance-sharing-preview";
import { FinanceSharingManager } from "./finance-sharing-manager";
import { FinanceShareEditor } from "./finance-share-editor";
import {
  useFinanceShareFlow,
  sharingSteps,
  type FinanceShareFlowProps,
} from "./use-finance-share-flow";
import finance from "@/components/kai/shared/finance-workspace.module.css";
import styles from "./finance-sharing.module.css";
export type { FinanceShareUpdate } from "./use-finance-share-flow";
export function FinanceShareFlow(props: FinanceShareFlowProps) {
  const { open, onOpenChange, source, initialShare } = props;
  const flow = useFinanceShareFlow(props);
  const {
    step,
    editIndex,
    changeEditStep,
    returnToEdit,
    selection,
    mode,
    durationLabel,
    selected,
    busy,
    error,
    preview,
    manage,
    setManage,
    accessEnded,
    prepared,
    inFlight,
    pendingConfirmation,
    canContinue,
    review,
    share,
    retryPrevious,
    ready,
  } = flow;
  return (
    <>
      <KaiControlSurface
        open={open && !manage}
        onOpenChange={(value) => {
          if (!inFlight.current) onOpenChange(value);
        }}
        title={
          step === "sent" ? (
            <span className="inline-block motion-step-enter">
              {accessEnded
                ? "Sharing ended"
                : initialShare
                  ? "Access updated"
                  : "Finance shared"}
            </span>
          ) : step === "review" ? (
            "Review before sharing"
          ) : initialShare ? (
            "Update access"
          ) : (
            "Share Finance"
          )
        }
        presentation="sheet"
        bodyClassName={styles.flowBody}
        description={step === "review" && selected.length ? `${selected.map((person) => person.displayName).join(", ")} will see this` : undefined}
        surfaceClassName={`${finance.detail} ${styles.flowSurface}${step === "edit" ? "" : ` ${styles.reviewFrame}`}`}
        footer={
          <div className={styles.toolbar}>
            {step === "edit" ? (
              <>
                {editIndex > 0 ? (
                  <ShellActionSurface
                    variant="pill"
                    disabled={busy}
                    onClick={() =>
                      changeEditStep(
                        (sharingSteps[editIndex - 1] ?? sharingSteps[0]).value,
                      )
                    }
                  >
                    Back
                  </ShellActionSurface>
                ) : (
                  <ShellActionSurface
                    variant="pill"
                    onClick={() => setManage(true)}
                  >
                    Manage sharing
                  </ShellActionSurface>
                )}
                <ShellActionSurface
                  variant="pill"
                  rippleEffect="fill"
                  wrapperClassName={styles.forward}
                  className={styles.primaryAction}
                  disabled={
                    busy ||
                    !ready ||
                    !canContinue ||
                    Boolean(pendingConfirmation)
                  }
                  onClick={() =>
                    editIndex < 2
                      ? changeEditStep(
                          (sharingSteps[editIndex + 1] ?? sharingSteps[0])
                            .value,
                        )
                      : void review()
                  }
                >
                  {busy ? "Preparing…" : editIndex < 2 ? "Continue" : "Preview"}
                </ShellActionSurface>
              </>
            ) : step === "review" ? (
              <>
                <ShellActionSurface
                  variant="pill"
                  disabled={busy || Boolean(prepared.current)}
                  onClick={returnToEdit}
                >
                  Back
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  rippleEffect="fill"
                  wrapperClassName="min-w-0 flex-1 sm:flex-none"
                  className={`${styles.primaryAction} w-full justify-center sm:w-auto`}
                  disabled={busy || !ready}
                  onClick={() => void share()}
                >
                  {busy
                    ? "Sharing…"
                    : prepared.current
                      ? "Retry confirmation"
                      : initialShare
                        ? "Update access"
                        : `Share with ${selected.length} ${selected.length === 1 ? "person" : "people"}`}
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  wrapperClassName={`${styles.forward} hidden sm:block`}
                  disabled={busy}
                  onClick={() => setManage(true)}
                >
                  Manage sharing
                </ShellActionSurface>
              </>
            ) : (
              <>
                <ShellActionSurface
                  variant="pill"
                  onClick={() => setManage(true)}
                >
                  Manage sharing
                </ShellActionSurface>
                <ShellActionSurface
                  variant="pill"
                  onClick={() => onOpenChange(false)}
                >
                  Done
                </ShellActionSurface>
              </>
            )}
          </div>
        }
      >
        {error ? (
          <p role="alert" className="mb-5 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {pendingConfirmation && step === "edit" ? (
          <div className={`${styles.privacy} mb-5`}>
            <p>
              Previous confirmation is unresolved. Retry safely or check Manage
              sharing.
            </p>
            <ShellActionSurface
              variant="pill"
              disabled={busy}
              onClick={() => void retryPrevious()}
            >
              Retry previous confirmation
            </ShellActionSurface>
          </div>
        ) : null}
        {!ready ? (
          <p className={styles.privacy}>
            Unlock your vault to share Finance information.
          </p>
        ) : null}
        {step === "edit" ? (
          <FinanceShareEditor flow={flow} initialShare={initialShare} />
        ) : preview ? (
          <div className={`${styles.reviewPanel} motion-step-enter`}>
            <dl
              className={styles.reviewSummary}
              aria-label={step === "sent" ? "Shared with" : "Ready to share with"}
            >
              <div>
                <dt>Access</dt>
                <dd>{mode === "snapshot" ? "Snapshot" : "Real time"}</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd title={durationLabel}>{durationLabel}</dd>
              </div>
              <div>
                <dt>Dollar amounts</dt>
                <dd>{selection.showAmounts ? "Included" : "Hidden"}</dd>
              </div>
              <div>
                <dt>{step === "sent" ? "Shared with" : "Sharing with"}</dt>
                <dd title={selected.map((person) => person.displayName).join(", ")}>
                  {selected.map((person) => person.displayName).join(", ")}
                </dd>
              </div>
            </dl>
            <FinanceSharingPreview projection={preview} compact />
          </div>
        ) : step === "sent" ? (
          <p className="text-sm">
            {accessEnded ? "Access has ended." : "Sent."}
          </p>
        ) : null}
      </KaiControlSurface>
      <FinanceSharingManager
        open={open && manage}
        onOpenChange={setManage}
        preferredSource={source}
      />
    </>
  );
}
