import { Plus, KeyRound, X, LocateFixed, UsersRound } from "@/components/icons";
import { FindPersonSearchIcon, InvitePersonPlusIcon, ManageConnectionsIcon } from "@/components/icons/ui/people-action-icons";
import type { LucideIcon } from "@/components/icons";

/** Authored icon identity only. Operations are never inferred from artwork,
 * text or DOM; ActionMenu keeps its explicit feature callback. These IDs are
 * generated from the same exported SVG components for native and web. */
export const NATIVE_ACTION_ARTWORK = new Map<LucideIcon, string>([
  [Plus, "action-add"], [KeyRound, "action-join"], [X, "action-close"],
  [LocateFixed, "action-locate"], [UsersRound, "action-people"],
  [FindPersonSearchIcon, "action-find-contacts"], [InvitePersonPlusIcon, "action-invite"],
  [ManageConnectionsIcon, "action-manage-connections"],
]);
export function nativeActionArtwork(icon?: LucideIcon): string | undefined {
  return icon ? NATIVE_ACTION_ARTWORK.get(icon) : undefined;
}
