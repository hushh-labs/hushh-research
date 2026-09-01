"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { SegmentedTabs as SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/lib/morphy-ux/morphy";
import { cn } from "@/lib/utils";
import {
  WALLET_CARD_COPY,
  WALLET_CARD_OWNER_COPY,
} from "@/components/wallet-card/wallet-card-copy";
import {
  WALLET_CARD_FIELD_LIMITS,
  WALLET_CARD_PREFERRED_CONTACT_OPTIONS,
  WALLET_CARD_RECOMMENDED_FIELDS,
  countWalletCardMoreDetails,
  getWalletCardMoreDetailsFields,
  getWalletCardPreferredField,
  type WalletCardDraft,
  type WalletCardFieldDefinition,
  type WalletCardValidationErrors,
} from "@/components/wallet-card/wallet-card-fields";
import type { WalletCardPreferredContact } from "@/lib/services/wallet-card-service";

function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "1";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "1";
}

function DraftField({
  definition,
  value,
  error,
  onChange,
}: {
  definition: WalletCardFieldDefinition;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const describedBy = `${inputId}-help`;
  const help = error || definition.description;
  const isUrlField =
    definition.inputMode === "url" || definition.type === "url";

  return (
    <div className="space-y-1.5" data-wallet-field={definition.key}>
      <Label
        htmlFor={inputId}
        className="text-[14px] font-semibold leading-[18px] text-[color:var(--app-primary-label)]"
      >
        {definition.label}
      </Label>
      {definition.multiline ? (
        <Textarea
          id={inputId}
          data-wallet-field-input={definition.key}
          value={value}
          rows={3}
          maxLength={WALLET_CARD_FIELD_LIMITS[definition.key]}
          placeholder={definition.placeholder}
          className="min-h-24 rounded-[12px] border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] text-[16px] leading-[22px] shadow-none"
          aria-invalid={error ? true : undefined}
          aria-describedby={help ? describedBy : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={inputId}
          data-wallet-field-input={definition.key}
          value={value}
          type={definition.type ?? "text"}
          inputMode={definition.inputMode}
          autoComplete={definition.autoComplete}
          autoCapitalize={isUrlField ? "none" : undefined}
          autoCorrect={isUrlField ? "off" : undefined}
          spellCheck={isUrlField ? false : undefined}
          maxLength={WALLET_CARD_FIELD_LIMITS[definition.key]}
          placeholder={definition.placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={help ? describedBy : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {help ? (
        <p
          id={describedBy}
          role={error ? "alert" : undefined}
          className={cn(
            "text-[13px] leading-[18px]",
            error
              ? "text-destructive"
              : "text-[color:var(--app-secondary-label)]",
          )}
        >
          {help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Smart-default review.
 *
 * A person whose Hussh profile is already complete only reviews this screen:
 * their name and preferred contact are pre-filled from what the product
 * already knows, the photo comes straight from their profile, and everything
 * else sits behind an optional disclosure that never blocks the flow.
 */
export function WalletCardSetup({
  draft,
  errors,
  avatarUrl,
  saving,
  isEditingExisting,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: WalletCardDraft;
  errors: WalletCardValidationErrors;
  avatarUrl: string | null;
  saving: boolean;
  isEditingExisting: boolean;
  onChange: (key: keyof WalletCardDraft, value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const [optionalOpen, setOptionalOpen] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const preferredMeta = getWalletCardPreferredField(draft.preferredContact);
  const preferredField = preferredMeta.key;
  const moreDetailsFields = useMemo(
    () => getWalletCardMoreDetailsFields(draft.preferredContact),
    [draft.preferredContact],
  );
  const moreDetailsCount = countWalletCardMoreDetails(draft);
  const preferredFieldError = errors[preferredField] || errors.preferredContact;

  // The optional fields are unmounted while collapsed, so an error on one of
  // them would render nowhere and Save would look dead. Open the disclosure so
  // the message the owner has to act on is actually on screen.
  const hasCollapsedOptionalError = moreDetailsFields.some((definition) =>
    Boolean(errors[definition.key]),
  );
  useEffect(() => {
    if (hasCollapsedOptionalError) setOptionalOpen(true);
  }, [hasCollapsedOptionalError]);

  useEffect(() => {
    const firstInvalidKey = preferredFieldError
      ? preferredField
      : ((["fullName", "headline"] as const).find((key) => errors[key]) ??
        moreDetailsFields.find((definition) => errors[definition.key])?.key);
    if (!firstInvalidKey) return;

    window.requestAnimationFrame(() => {
      const input = formRef.current?.querySelector<HTMLElement>(
        `[data-wallet-field-input="${firstInvalidKey}"]`,
      );
      input?.scrollIntoView({ block: "center", behavior: "smooth" });
      input?.focus({ preventScroll: true });
    });
  }, [errors, moreDetailsFields, preferredField, preferredFieldError]);

  const selectedContactDefinition: WalletCardFieldDefinition = {
    key: preferredMeta.key,
    label: preferredMeta.label,
    placeholder: preferredMeta.placeholder,
    type: preferredMeta.type,
    inputMode: preferredMeta.inputMode,
    autoComplete: preferredMeta.autoComplete,
  };

  return (
    <form
      ref={formRef}
      className="w-full space-y-6"
      data-testid="wallet-card-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) onSubmit();
      }}
    >
      <section
        className="space-y-4"
        aria-labelledby="wallet-card-shared-information-heading"
      >
        <h2
          id="wallet-card-shared-information-heading"
          data-wallet-grid-item="shared-information-heading"
          className="text-[20px] font-semibold leading-[25px] text-[color:var(--app-primary-label)]"
        >
          Shared information
        </h2>

        <div
          data-wallet-grid-item="photo-row"
          className="flex min-h-[62px] items-center gap-3 rounded-2xl border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-4 py-2.5"
        >
          <div className="shrink-0">
            <Avatar size="lg" className="size-11">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
              <AvatarFallback className="text-[13px] font-medium">
                {initialsFrom(draft.fullName)}
              </AvatarFallback>
            </Avatar>
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold leading-[20px] text-[color:var(--app-primary-label)]">
              Photo
            </p>
            <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
              {WALLET_CARD_OWNER_COPY.fromYourProfile}
            </p>
          </div>
        </div>

        {WALLET_CARD_RECOMMENDED_FIELDS.map((definition) => (
          <div
            key={definition.key}
            data-wallet-grid-item={`${definition.key}-field`}
          >
            <DraftField
              definition={definition}
              value={draft[definition.key]}
              error={errors[definition.key]}
              onChange={(value) => onChange(definition.key, value)}
            />
          </div>
        ))}

        <div className="space-y-3" data-wallet-grid-item="primary-contact">
          <div className="space-y-1">
            <Label className="text-[14px] font-semibold leading-[18px] text-[color:var(--app-primary-label)]">
              Primary contact
            </Label>
            <p className="text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
              Shown first after a scan.
            </p>
          </div>
          <SettingsSegmentedTabs
            value={draft.preferredContact}
            onValueChange={(value) =>
              onChange("preferredContact", value as WalletCardPreferredContact)
            }
            options={WALLET_CARD_PREFERRED_CONTACT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            mobileColumns={2}
            className="min-h-11"
          />
          <div data-wallet-grid-item="selected-contact-input">
            <DraftField
              definition={selectedContactDefinition}
              value={draft[preferredField]}
              error={preferredFieldError}
              onChange={(value) => onChange(preferredField, value)}
            />
          </div>
        </div>
      </section>

      <section
        className="overflow-hidden rounded-2xl border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)]"
        data-wallet-grid-item="more-details"
      >
        <button
          type="button"
          className="flex min-h-[58px] w-full items-center justify-between gap-4 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          aria-expanded={optionalOpen}
          aria-controls="wallet-card-more-details-panel"
          onClick={() => setOptionalOpen((open) => !open)}
        >
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold leading-[20px] text-[color:var(--app-primary-label)]">
              {WALLET_CARD_OWNER_COPY.optionalDisclosure}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
            {moreDetailsCount} added
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                optionalOpen && "rotate-180",
              )}
              aria-hidden
            />
          </span>
        </button>
        {optionalOpen ? (
          <div
            id="wallet-card-more-details-panel"
            className="space-y-4 border-t border-[color:var(--app-separator)] px-4 py-4"
          >
            {moreDetailsFields.map((definition) => (
              <DraftField
                key={definition.key}
                definition={definition}
                value={draft[definition.key]}
                error={errors[definition.key]}
                onChange={(value) => onChange(definition.key, value)}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section
        className="space-y-1.5"
        data-wallet-grid-item="privacy-assurance"
        aria-labelledby="wallet-card-privacy-heading"
      >
        <h2
          id="wallet-card-privacy-heading"
          className="text-[16px] font-semibold leading-[22px] text-[color:var(--app-primary-label)]"
        >
          {WALLET_CARD_COPY.privacyAssurance.title}
        </h2>
        <p className="text-[14px] leading-[20px] text-[color:var(--app-secondary-label)]">
          {WALLET_CARD_COPY.privacyAssurance.description}
        </p>
      </section>

      <div className="space-y-2 pt-1" data-wallet-grid-item="actions">
        <Button
          type="submit"
          className="min-h-[52px] w-full rounded-2xl text-[17px] font-semibold leading-[22px]"
          loading={saving}
          disabled={saving}
        >
          {isEditingExisting
            ? WALLET_CARD_OWNER_COPY.saveChanges
            : WALLET_CARD_OWNER_COPY.createProfile}
        </Button>
        <Button
          type="button"
          variant="none"
          effect="fade"
          className="min-h-11 w-full text-[16px] font-semibold leading-5 text-[color:var(--app-accent)]"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
