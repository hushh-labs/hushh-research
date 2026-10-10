"use client";

import { useId, useState } from "react";

import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { DocumentPayoutAccountCard } from "@/components/consent/document-payout-account";
import { SettingsDetailPanel } from "@/components/app-ui/settings-ui";
import { BodyText, FormLabel, HelperText } from "@/components/app-ui/typography";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  DEFAULT_DOCUMENT_REQUEST_PRICE_CENTS,
  DOCUMENT_REQUEST_PRICE_PRESETS_CENTS,
  formatDocumentRequestPrice,
  parseWholeDollarPrice,
} from "@/lib/consent/document-request-price";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";

export interface DocumentRequestPriceSheetProps {
  open: boolean;
  /** Who pays: a name or an email. A generic label reads "The requester". */
  requesterLabel: string;
  purpose?: string | null;
  /** The Google account that receives Viewer access. */
  recipientEmail?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /**
   * The request's terms have not loaded. Allow stays off until the owner can
   * read what they are allowing.
   */
  detailsPending?: boolean;
  /** False for a free request: no price controls, and Allow submits null. */
  paymentRequired: boolean;
  /** New requests hold the quote shown to the requester; legacy requests remain editable. */
  lockedAmountCents?: number | null;
  busy: boolean;
  error: string | null;
  onSubmit: (amountCents: number | null) => void;
  onCancel: () => void;
}

/** The same rule, in the same words, as the server's invalid_payment_amount. */
export const DOCUMENT_REQUEST_PRICE_RULE =
  "Choose a whole-dollar price from $1 to $500.";

// 44px targets, the same chip grammar as the Location duration ladder: a fixed
// four-cell row on a phone (all four fit at 320px), content-width chips from sm.
const CHIP_ROW_CLASS = "grid grid-cols-4 gap-2 sm:flex sm:flex-wrap";
const CHIP_CLASS =
  "flex min-h-11 min-w-0 items-center justify-center whitespace-nowrap rounded-full border px-1 text-[15px] font-semibold leading-5 transition-colors touch-manipulation disabled:pointer-events-none disabled:opacity-50 sm:min-w-[4.5rem] sm:px-4";
const CHIP_OFF_CLASS =
  "border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] text-[color:var(--app-label)] hover:bg-[color:var(--app-neutral-fill-strong)]";
const CHIP_ON_CLASS =
  "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]";

const GENERIC_REQUESTER_LABELS = new Set([
  "",
  "document request",
  "requester",
  "someone",
]);

type PriceChoice = number | "custom";

function payerLabel(requesterLabel: string): string {
  const label = requesterLabel.trim();
  return GENERIC_REQUESTER_LABELS.has(label.toLowerCase())
    ? "The requester"
    : label;
}

/** One term of the request, in the review's own label/value grammar. */
function RequestTerm({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-11 items-start justify-between gap-4 py-2.5">
      <HelperText as="dt" className="shrink-0">
        {label}
      </HelperText>
      <BodyText as="dd" className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value}
      </BodyText>
    </div>
  );
}

/**
 * Allow for a document request from outside the Trusted circle. The owner
 * sets what the requester pays; nothing is searched or shared before that.
 */
export function DocumentRequestPriceSheet(props: DocumentRequestPriceSheetProps) {
  // Every opening starts at the default price, never at the last choice. The
  // sheet stays mounted while it closes, so its exit animation still plays.
  const [opening, setOpening] = useState({ open: props.open, count: 0 });
  if (opening.open !== props.open) {
    setOpening({
      open: props.open,
      count: opening.count + (props.open ? 1 : 0),
    });
  }
  return <PriceSheet key={opening.count} {...props} />;
}

function PriceSheet({
  open,
  requesterLabel,
  purpose,
  recipientEmail,
  periodStart,
  periodEnd,
  detailsPending = false,
  paymentRequired,
  lockedAmountCents = null,
  busy,
  error,
  onSubmit,
  onCancel,
}: DocumentRequestPriceSheetProps) {
  const [choice, setChoice] = useState<PriceChoice>(
    DEFAULT_DOCUMENT_REQUEST_PRICE_CENTS,
  );
  const [customText, setCustomText] = useState("");
  const priceLabelId = useId();
  const customInputId = useId();
  const customRuleId = useId();

  const customCents = parseWholeDollarPrice(customText);
  const customInvalid =
    choice === "custom" && customText.trim() !== "" && customCents === null;
  const lockedQuote = paymentRequired && lockedAmountCents !== null;
  const amountCents = !paymentRequired
    ? null
    : lockedQuote
      ? lockedAmountCents
    : choice === "custom"
      ? customCents
      : choice;
  const ready = !detailsPending && (!paymentRequired || amountCents !== null);
  const purposeText = purpose?.trim() || null;
  const recipientText = recipientEmail?.trim() || null;
  const periodText =
    periodStart && periodEnd ? `${periodStart} – ${periodEnd}` : null;

  const submit = () => {
    if (busy || !ready) return;
    onSubmit(amountCents);
  };

  return (
    <SettingsDetailPanel
      open={open}
      onOpenChange={(next) => {
        // A decision in flight finishes first; Back and Escape wait for it.
        if (!next && !busy) onCancel();
      }}
      title="Allow request"
      description={
        paymentRequired
          ? `${payerLabel(requesterLabel)} pays this once matching files are found. Nothing is shared before payment.`
          : "Your private agent finds the matching files and shares them."
      }
      headerTextOverflow="wrap"
      mobilePresentation="sheet"
      showCloseButton={false}
      desktopMaxWidthClassName="sm:!max-w-[520px]"
      footer={
        <FlowActionGroup
          primary={
            <Button
              size="prominent"
              loading={busy}
              disabled={busy || !ready}
              onClick={submit}
            >
              {amountCents === null
                ? "Allow"
                : `Allow · ${formatDocumentRequestPrice(amountCents)}`}
            </Button>
          }
          secondary={
            <Button
              size="standard"
              variant="none"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </Button>
          }
        />
      }
    >
      <div className="space-y-3 pb-1 pt-2">
        {detailsPending ? (
          error ? null : (
            <HelperText role="status">Loading request…</HelperText>
          )
        ) : (
          <>
            {/* In full: from the Feed, this is the only place the owner reads it. */}
            {purposeText ? (
              <BodyText className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                “{purposeText}”
              </BodyText>
            ) : null}
            {/* What Allow grants, read where the owner confirms it. */}
            <dl className="divide-y divide-border/60 border-y border-border/60">
              {recipientText ? (
                <RequestTerm label="Share with" value={recipientText} />
              ) : null}
              {periodText ? (
                <RequestTerm label="Period" value={periodText} />
              ) : null}
              <RequestTerm label="Access" value="Viewer, until removed" />
            </dl>
          </>
        )}
        {paymentRequired ? (
          <>
            {lockedQuote ? (
              <div className="space-y-1" aria-label="Locked document request quote">
                <FormLabel as="p">Request price</FormLabel>
                <BodyText>{formatDocumentRequestPrice(lockedAmountCents)}</BodyText>
                <HelperText>The requester saw this price before sending. It stays fixed for this request.</HelperText>
              </div>
            ) : <>
            <FormLabel as="p" id={priceLabelId}>
              Price
            </FormLabel>
            <div
              role="group"
              aria-labelledby={priceLabelId}
              className={CHIP_ROW_CLASS}
            >
              {DOCUMENT_REQUEST_PRICE_PRESETS_CENTS.map((cents) => (
                <button
                  key={cents}
                  type="button"
                  aria-pressed={choice === cents}
                  disabled={busy}
                  onClick={() => setChoice(cents)}
                  className={cn(
                    CHIP_CLASS,
                    choice === cents ? CHIP_ON_CLASS : CHIP_OFF_CLASS,
                  )}
                >
                  {formatDocumentRequestPrice(cents)}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={choice === "custom"}
                aria-expanded={choice === "custom"}
                disabled={busy}
                onClick={() => setChoice("custom")}
                className={cn(
                  CHIP_CLASS,
                  choice === "custom" ? CHIP_ON_CLASS : CHIP_OFF_CLASS,
                )}
              >
                Custom
              </button>
            </div>
            {choice === "custom" ? (
              <div className="space-y-1.5">
                <FormLabel htmlFor={customInputId}>Custom price</FormLabel>
                <InputGroup className="h-11 border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)]">
                  <InputGroupAddon className="ui-text-input-value text-[color:var(--app-secondary-label)]">
                    $
                  </InputGroupAddon>
                  <InputGroupInput
                    id={customInputId}
                    // Opening Custom is asking to type the amount.
                    autoFocus
                    inputMode="numeric"
                    autoComplete="off"
                    enterKeyHint="done"
                    placeholder="Whole dollars"
                    value={customText}
                    disabled={busy}
                    aria-invalid={customInvalid}
                    aria-describedby={customInvalid ? customRuleId : undefined}
                    onChange={(event) => setCustomText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      submit();
                    }}
                  />
                </InputGroup>
                {customInvalid ? (
                  <HelperText id={customRuleId} role="alert">
                    {DOCUMENT_REQUEST_PRICE_RULE}
                  </HelperText>
                ) : null}
              </div>
            ) : null}
            </>}
            <HelperText>
              Your net earnings are calculated after delivery, minus Hushh&apos;s 3% commission and the actual Stripe fee. Undelivered files are refunded to the requester.
            </HelperText>
            <DocumentPayoutAccountCard active={open} compact disabled={busy} />
          </>
        ) : null}
        {error ? <HelperText role="alert">{error}</HelperText> : null}
      </div>
    </SettingsDetailPanel>
  );
}
