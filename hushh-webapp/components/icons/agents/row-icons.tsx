"use client";

import {
  AddressBook,
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowsCounterClockwise,
  Broadcast,
  Buildings,
  ChatCircle,
  CheckCircle,
  CircleHalf,
  ClipboardText,
  Cloud,
  Ear,
  Eye,
  FolderSimple,
  HourglassMedium,
  House,
  Key,
  Keyhole,
  LinkBreak,
  LinkSimple,
  LockKey,
  Microphone,
  Palette,
  Pause,
  PencilSimple,
  Phone,
  Play,
  SealCheck,
  ShareNetwork,
  Siren,
  Trash,
  Tray,
  UserPlus,
  UsersThree,
  Vault,
  Warning,
  type Icon,
} from "@phosphor-icons/react";

import type { AgentIconProps } from "./agent-icons";

/**
 * Semantic row glyphs for `SettingsRow iconTone="capability"`.
 *
 * The Profile menu draws each row as an authored Phosphor duotone glyph in its
 * own signature colour on a transparent well, the way /one draws its launcher
 * (founder direction, 2026-09-27). Nested screens used to fall back to legacy
 * utility names on coloured or gray tiles, so the same idea looked different
 * one tap deeper. These exports give every recurring row concept one glyph
 * and one colour, so a concept reads the same wherever it appears.
 *
 * Colours come from the hushh-icon-theme palette. Native 256 viewBox, no
 * backplate: the row's capability tone owns sizing, never the glyph.
 */
const ROW_TONE = {
  emerald: "#10B981",
  amber: "#F59E0B",
  purple: "#8B5CF6",
  rose: "#E11D48",
  sky: "#0284C7",
  cobalt: "#2563EB",
  indigo: "#6366F1",
  red: "#EF4444",
  accent: "var(--app-accent)",
} as const;

function createRowIcon(glyph: Icon, defaultColor: string, name: string) {
  const Glyph = glyph;
  function RowIcon({
    size = "1em",
    weight = "duotone",
    color = defaultColor,
    ...props
  }: AgentIconProps) {
    return <Glyph size={size} weight={weight} color={color} {...props} />;
  }
  RowIcon.displayName = name;
  return RowIcon;
}

// Identity and account
export const PhoneRowIcon = createRowIcon(Phone, ROW_TONE.emerald, "PhoneRowIcon");
export const DiscoverableRowIcon = createRowIcon(AddressBook, ROW_TONE.sky, "DiscoverableRowIcon");
export const ResetRowIcon = createRowIcon(ArrowCounterClockwise, ROW_TONE.amber, "ResetRowIcon");
export const DeleteRowIcon = createRowIcon(Trash, ROW_TONE.red, "DeleteRowIcon");

// Preferences
export const AppearanceRowIcon = createRowIcon(CircleHalf, ROW_TONE.indigo, "AppearanceRowIcon");
export const AccentRowIcon = createRowIcon(Palette, ROW_TONE.accent, "AccentRowIcon");
export const VoiceRowIcon = createRowIcon(Microphone, ROW_TONE.purple, "VoiceRowIcon");
export const LiveVoiceRowIcon = createRowIcon(Broadcast, ROW_TONE.emerald, "LiveVoiceRowIcon");
export const SpeakerSafeRowIcon = createRowIcon(Ear, ROW_TONE.amber, "SpeakerSafeRowIcon");

// Vault and access
export const VaultRowIcon = createRowIcon(Vault, ROW_TONE.cobalt, "VaultRowIcon");
export const PassphraseRowIcon = createRowIcon(Keyhole, ROW_TONE.amber, "PassphraseRowIcon");
export const KeyRowIcon = createRowIcon(Key, ROW_TONE.indigo, "KeyRowIcon");
export const LockedRowIcon = createRowIcon(LockKey, ROW_TONE.indigo, "LockedRowIcon");

// Sync, status and lifecycle
export const SyncRowIcon = createRowIcon(ArrowsClockwise, ROW_TONE.sky, "SyncRowIcon");
export const RotateRowIcon = createRowIcon(ArrowsCounterClockwise, ROW_TONE.purple, "RotateRowIcon");
export const WarningRowIcon = createRowIcon(Warning, ROW_TONE.amber, "WarningRowIcon");
export const ProgressRowIcon = createRowIcon(HourglassMedium, ROW_TONE.amber, "ProgressRowIcon");
export const ReviewRowIcon = createRowIcon(ClipboardText, ROW_TONE.sky, "ReviewRowIcon");
export const QualifiedRowIcon = createRowIcon(SealCheck, ROW_TONE.emerald, "QualifiedRowIcon");
export const SuccessRowIcon = createRowIcon(CheckCircle, ROW_TONE.emerald, "SuccessRowIcon");
export const PauseRowIcon = createRowIcon(Pause, ROW_TONE.amber, "PauseRowIcon");
export const ResumeRowIcon = createRowIcon(Play, ROW_TONE.emerald, "ResumeRowIcon");

// Mail and connections
export const InboxRowIcon = createRowIcon(Tray, ROW_TONE.rose, "InboxRowIcon");
export const DisconnectRowIcon = createRowIcon(LinkBreak, ROW_TONE.red, "DisconnectRowIcon");

// Sharing, people and invitations
export const LinkRowIcon = createRowIcon(LinkSimple, ROW_TONE.cobalt, "LinkRowIcon");
export const ShareRowIcon = createRowIcon(ShareNetwork, ROW_TONE.indigo, "ShareRowIcon");
export const JoinRowIcon = createRowIcon(UserPlus, ROW_TONE.purple, "JoinRowIcon");
export const PeopleRowIcon = createRowIcon(UsersThree, ROW_TONE.indigo, "PeopleRowIcon");
/** An SOS alert from someone who listed you as an emergency contact. */
export const EmergencyRowIcon = createRowIcon(Siren, ROW_TONE.red, "EmergencyRowIcon");
export const InviteCodeRowIcon = createRowIcon(Key, ROW_TONE.amber, "InviteCodeRowIcon");
/** Talking to an agent: the same chat glyph as the one control that opens One. */
export const UseAgentRowIcon = createRowIcon(ChatCircle, ROW_TONE.indigo, "UseAgentRowIcon");

// Information and editing
export const FolderRowIcon = createRowIcon(FolderSimple, ROW_TONE.indigo, "FolderRowIcon");
export const PreviewRowIcon = createRowIcon(Eye, ROW_TONE.sky, "PreviewRowIcon");
export const EditRowIcon = createRowIcon(PencilSimple, ROW_TONE.cobalt, "EditRowIcon");

// Where the agent lives: one building shared with others, the person's own
// cloud, or a home of its own that Hussh runs.
export const SharedHostingRowIcon = createRowIcon(Buildings, ROW_TONE.indigo, "SharedHostingRowIcon");
export const OwnCloudRowIcon = createRowIcon(Cloud, ROW_TONE.sky, "OwnCloudRowIcon");
export const DedicatedHostingRowIcon = createRowIcon(House, ROW_TONE.emerald, "DedicatedHostingRowIcon");
