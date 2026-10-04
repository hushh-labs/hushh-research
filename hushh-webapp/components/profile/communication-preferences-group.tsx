"use client";

/**
 * The "How One writes to you" rows and footer, with no loading or storage of
 * their own (the container is communication-preferences-section.tsx).
 *
 * Layout contract, checked by e2e/style-settings.layout.spec.ts: the rows are
 * the shared SettingsRow geometry, every text control is 44 px tall with one
 * shared right edge, the note block and the footer keep the row's 16 px side
 * inset, and the surfaces are flat.
 */
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  LanguageRowIcon,
  PreferredNameRowIcon,
  PunctuationRowIcon,
  ReplyLengthRowIcon,
  ToneRowIcon,
} from "@/components/icons/agents";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  OWNER_STYLE_LANGUAGES,
  OWNER_STYLE_LANGUAGE_LABEL,
  OWNER_STYLE_LENGTHS,
  OWNER_STYLE_LENGTH_LABEL,
  OWNER_STYLE_TONES,
  OWNER_STYLE_TONE_LABEL,
  PREFERRED_NAME_MAX,
  STYLE_NOTE_MAX,
  type OwnerStyleSettings,
} from "@/lib/agent/owner-style-settings";

const NO_PREFERENCE = "none";
const CONTROL_WIDTH = "w-full sm:w-60";
// The select matches the text field beside it: one height, fill, corner and
// value type (the pairing e2e/gemini-endpoint-fields.layout.spec.ts guards).
const SELECT_CLASSNAME = `${CONTROL_WIDTH} data-[size=default]:h-11 border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3.5 ui-text-input-value shadow-none dark:bg-[color:var(--app-secondary-surface)] dark:hover:bg-[color:var(--app-secondary-surface)]`;
// Stacked under its label on a phone: 8 px grid gap plus the trailing's 4 px top
// padding gives a 12 px step, on the 4 pt scale.
const ROW_CLASSNAME = "[--settings-row-stack-gap:8px]";

function ChoiceSelect<T extends string>({
  value,
  options,
  labels,
  label,
  disabled,
  onChange,
}: {
  value: T | undefined;
  options: readonly T[];
  labels: Record<T, string>;
  label: string;
  disabled: boolean;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Select
      value={value ?? NO_PREFERENCE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === NO_PREFERENCE ? undefined : (next as T))}
    >
      <SelectTrigger className={SELECT_CLASSNAME} aria-label={label}>
        <SelectValue placeholder="No preference" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_PREFERENCE}>No preference</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The editable rows and footer, with no loading or storage of their own. */
export function CommunicationPreferencesGroup({
  value,
  onChange,
  onSave,
  dirty,
  saving,
  unavailable = false,
  suggested,
}: {
  value: OwnerStyleSettings;
  onChange: (next: OwnerStyleSettings) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  /** The stored values could not be read, so saving is held back. */
  unavailable?: boolean;
  /** True when the values came from a chat offer and are not saved yet. */
  suggested: boolean;
}) {
  const set = <K extends keyof OwnerStyleSettings>(key: K, next: OwnerStyleSettings[K]) => {
    const updated: OwnerStyleSettings = { ...value };
    if (next === undefined || next === "") delete updated[key];
    else updated[key] = next;
    onChange(updated);
  };
  const note = value.owner_style_note ?? "";
  return (
    <div className="space-y-4" data-testid="style-settings">
      <SettingsGroup
        title="How One writes to you"
        description="One follows these on every reply. They change its writing only, never what it can see, share or do."
        testId="style-settings-group"
      >
        <SettingsRow
          icon={PreferredNameRowIcon}
          iconTone="capability"
          title="Call me"
          description="The name One uses for you."
          trailing={
            <Input
              value={value.preferred_name ?? ""}
              maxLength={PREFERRED_NAME_MAX}
              placeholder="Your name"
              aria-label="Name One calls you"
              disabled={saving}
              className={CONTROL_WIDTH}
              onChange={(event) => set("preferred_name", event.target.value)}
            />
          }
          stackTrailingOnMobile
          className={ROW_CLASSNAME}
          testId="style-settings-row"
        />
        <SettingsRow
          icon={ToneRowIcon}
          iconTone="capability"
          title="Tone"
          description="How One sounds."
          trailing={
            <ChoiceSelect value={value.tone} options={OWNER_STYLE_TONES} labels={OWNER_STYLE_TONE_LABEL}
              label="Tone" disabled={saving} onChange={(next) => set("tone", next)} />
          }
          stackTrailingOnMobile
          className={ROW_CLASSNAME}
          testId="style-settings-row"
        />
        <SettingsRow
          icon={ReplyLengthRowIcon}
          iconTone="capability"
          title="Length"
          description="How much One writes."
          trailing={
            <ChoiceSelect value={value.length} options={OWNER_STYLE_LENGTHS} labels={OWNER_STYLE_LENGTH_LABEL}
              label="Length" disabled={saving} onChange={(next) => set("length", next)} />
          }
          stackTrailingOnMobile
          className={ROW_CLASSNAME}
          testId="style-settings-row"
        />
        <SettingsRow
          icon={LanguageRowIcon}
          iconTone="capability"
          title="Language"
          description="The language One replies in."
          trailing={
            <ChoiceSelect value={value.language} options={OWNER_STYLE_LANGUAGES} labels={OWNER_STYLE_LANGUAGE_LABEL}
              label="Language" disabled={saving} onChange={(next) => set("language", next)} />
          }
          stackTrailingOnMobile
          className={ROW_CLASSNAME}
          testId="style-settings-row"
        />
        <SettingsRow
          icon={PunctuationRowIcon}
          iconTone="capability"
          title="Avoid em dashes"
          description="One uses commas and periods instead."
          trailing={
            // A 44 px tall target, so this row sits on the same 60 px rhythm.
            <span className="inline-flex h-11 items-center">
              <Switch
                checked={value.avoid_em_dashes === true}
                disabled={saving}
                aria-label="Avoid em dashes"
                onCheckedChange={(checked) => set("avoid_em_dashes", checked)}
              />
            </span>
          }
          testId="style-settings-row"
        />
      </SettingsGroup>
      <SettingsGroup
        title="Style note"
        description="Optional guidance in your words. It shapes writing only and can't give One permission to do anything."
        testId="style-settings-note-group"
      >
        <div className="flex flex-col gap-2 p-4" data-testid="style-settings-note-block">
          <textarea
            value={note}
            maxLength={STYLE_NOTE_MAX}
            rows={3}
            disabled={saving}
            aria-label="Style note"
            placeholder="For example: write Hussh with two s's, and lead with numbers."
            className="ui-text-input-value block h-28 w-full resize-none rounded-[var(--app-radius-md,14px)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3.5 py-3 outline-none placeholder:text-muted-foreground focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] disabled:opacity-50"
            onChange={(event) => set("owner_style_note", event.target.value.replace(/[\r\n]+/g, " "))}
          />
          <p className="flex h-4 items-center justify-end text-xs tabular-nums text-muted-foreground" data-testid="style-settings-note-count">
            {note.length}/{STYLE_NOTE_MAX}
          </p>
        </div>
      </SettingsGroup>
      <div className="flex min-h-11 items-center justify-between gap-4 px-4" data-testid="style-settings-footer">
        <p className="min-w-0 text-sm text-muted-foreground" role="status" data-testid="style-settings-status">
          {unavailable
            ? "Couldn't load your writing style. Reopen to try again."
            : suggested ? "Suggested in chat. Check it, then save." : dirty ? "Unsaved changes." : "Saved in your vault."}
        </p>
        <MorphyButton type="button" size="sm" disabled={!dirty || saving || unavailable} onClick={onSave}
          className="min-h-11 shrink-0 px-6" data-testid="style-settings-save">
          {saving ? "Saving" : "Save"}
        </MorphyButton>
      </div>
    </div>
  );
}
