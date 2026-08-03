"use client";

import { useId, useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";

import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
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
  WALLET_CARD_OPTIONAL_FIELDS,
  WALLET_CARD_PREFERRED_CONTACT_OPTIONS,
  WALLET_CARD_RECOMMENDED_FIELDS,
  describeSharedFields,
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

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId} className="text-[13px] font-medium">
        {definition.label}
      </Label>
      {definition.multiline ? (
        <Textarea
          id={inputId}
          value={value}
          rows={3}
          maxLength={WALLET_CARD_FIELD_LIMITS[definition.key]}
          placeholder={definition.placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={help ? describedBy : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={inputId}
          value={value}
          inputMode={definition.inputMode}
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
          className={cn(
            "text-[11.5px] leading-[1.45]",
            error ? "text-destructive" : "text-muted-foreground",
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
  const shared = describeSharedFields(draft);
  const preferredOption = WALLET_CARD_PREFERRED_CONTACT_OPTIONS.find(
    (option) => option.value === draft.preferredContact,
  );

  return (
    <div className="space-y-4">
      {!isEditingExisting ? (
        <SettingsGroup>
          <SettingsRow
            icon={ShieldCheck}
            iconTone="blue"
            title={WALLET_CARD_COPY.setupIntro.title}
            description={WALLET_CARD_COPY.setupIntro.description}
          />
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title={WALLET_CARD_OWNER_COPY.recommendedGroupTitle}
        description={WALLET_CARD_OWNER_COPY.onlyThisInformation}
      >
        <SettingsRow
          leading={
            <Avatar size="lg" className="size-11">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
              <AvatarFallback className="text-[13px] font-medium">
                {initialsFrom(draft.fullName)}
              </AvatarFallback>
            </Avatar>
          }
          title="Photo"
          description={WALLET_CARD_OWNER_COPY.fromYourProfile}
        />
        <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
          {WALLET_CARD_RECOMMENDED_FIELDS.map((definition) => (
            <DraftField
              key={definition.key}
              definition={definition}
              value={draft[definition.key]}
              error={errors[definition.key]}
              onChange={(value) => onChange(definition.key, value)}
            />
          ))}

          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium">Preferred contact</Label>
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
            />
            {preferredOption &&
            preferredOption.field !== "website" &&
            preferredOption.field !== "linkedin" ? (
              <div className="pt-1">
                <Input
                  value={draft[preferredOption.field]}
                  inputMode={preferredOption.value === "phone" ? "tel" : "email"}
                  maxLength={WALLET_CARD_FIELD_LIMITS[preferredOption.field]}
                  placeholder={
                    preferredOption.value === "phone" ? "+1 555 0100" : "you@example.com"
                  }
                  aria-label={preferredOption.label}
                  aria-invalid={errors[preferredOption.field] ? true : undefined}
                  onChange={(event) =>
                    onChange(preferredOption.field, event.target.value)
                  }
                />
              </div>
            ) : null}
            {errors.preferredContact || errors[preferredOption?.field ?? "email"] ? (
              <p className="text-[11.5px] leading-[1.45] text-destructive">
                {errors.preferredContact || errors[preferredOption?.field ?? "email"]}
              </p>
            ) : (
              <p className="text-[11.5px] leading-[1.45] text-muted-foreground">
                This is the action a visitor sees first.
              </p>
            )}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={WALLET_CARD_COPY.privacyAssurance.title}
          description={WALLET_CARD_COPY.privacyAssurance.description}
          icon={ShieldCheck}
          iconTone="green"
        />
        <div className="px-[var(--settings-row-px)] pb-[var(--settings-row-py)]">
          <div className="flex flex-wrap gap-1.5">
            {shared.map((label) => (
              <span
                key={label}
                className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={WALLET_CARD_OWNER_COPY.optionalDisclosure}
          description={WALLET_CARD_OWNER_COPY.optionalDisclosureHint}
          onClick={() => setOptionalOpen((open) => !open)}
          trailing={
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                optionalOpen && "rotate-180",
              )}
              aria-hidden
            />
          }
        />
        {optionalOpen ? (
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            {WALLET_CARD_OPTIONAL_FIELDS.map((definition) => (
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
      </SettingsGroup>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" loading={saving} onClick={onSubmit}>
          {WALLET_CARD_OWNER_COPY.reviewPrimaryAction}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="none"
          effect="fade"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
