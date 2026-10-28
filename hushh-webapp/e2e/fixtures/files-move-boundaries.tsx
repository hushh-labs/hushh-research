// Only storage and unavailable native presentation are substituted. Actual
// ActionMenu, Radix focus lifecycles, dialog and paginated picker remain real.
import type { Ref } from "react";
import type { FileEntry } from "../../lib/files/service";
export const file: FileEntry = {
  id: "synthetic-file", name: "notes.txt", originalName: "notes.txt",
  parent: "root", kind: "file", state: "ready", size: 1, received: 1,
  receivedHash: "synthetic", revision: 1,
};
export const FilesService = {
  async list(parent: string) {
    return { entries: parent === "root" ? [{ ...file, id: "destination", kind: "folder", name: "Documents" }] : [], cursor: "" };
  },
};
export function useNativeNavigationOverlayRef<T>(ref?: Ref<T>) { return ref; }
export function nativeShellOverlayBlocked() { return false; }
export function useNativeShellOverlayBlocked() { return false; }
export function useNativeOverlayCollisionPadding<T>(padding: T) { return padding; }
export function NativeChatChrome() { throw new Error("Native presentation is not admitted in this web fixture"); }

export function FilesSettingsPanel() { throw new Error("Settings are outside this move fixture"); }
export function FilesOrganizationHistory() { throw new Error("Organization is outside this move fixture"); }
