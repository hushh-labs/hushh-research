/**
 * Mirrors the shell's geometry variables onto <html>.
 *
 * The fixed siblings (top shell, agent bar, bottom glass) and route content
 * both consume these, so the complete top-shell chain is mirrored (a tabbed
 * route must never resolve a root-level `0px` tab stack for its mask or
 * fade) and the complete bottom-chrome chain (the app-level AgentBar must
 * resolve the same hide distance as the navbar).
 *
 * Every write on <html> invalidates style for the whole document, on the
 * frame the incoming route is mounting. So: a value is written only when it
 * changed, the dataset flags likewise, and the values captured on first
 * mount are restored only when the shell unmounts. A cleanup that ran on
 * every dependency change used to strip all of them and write them back on
 * each navigation (about fifty root mutations per tab switch, with the
 * page's own layout reads landing in between).
 */

export const ROOT_MIRRORED_SHELL_VARS = [
  "--top-tabs-gap",
  "--top-tabs-total",
  "--top-subnav-total",
  "--top-systembar-row-gap",
  "--top-fade-active",
  "--top-ambient-tab-tail-midpoint",
  "--top-shell-reserved-height",
  "--top-shell-visual-height",
  "--top-shell-live-height",
  "--top-shell-mask-tabs-gap",
  "--top-shell-mask-solid-height",
  "--top-shell-mask-visible-height",
  "--top-shell-h",
  "--top-glass-h",
  "--page-top-start",
  "--page-top-local-offset",
  "--app-top-mask-tail-clearance",
  "--app-top-content-offset",
  "--app-fullscreen-flow-content-offset",
  "--app-top-shell-visible",
  "--app-top-offset-mode",
  "--bottom-chrome-stack-height",
  "--bottom-chrome-full-height",
  "--bottom-chrome-search-height",
  "--bottom-chrome-visual-height",
  "--bottom-chrome-hide-distance",
] as const;

export type RootShellMirrorDataset = {
  appShellOffsetMode: string;
  appShellRouteLayout: string;
  appTopShellProfile: string;
};

export type RootShellMirror = {
  /** Writes changed values only; returns how many root mutations it made. */
  apply(resolve: (key: string) => string, dataset: RootShellMirrorDataset): number;
  /** Puts back what was on <html> before the first apply. */
  restore(): void;
};

export function createRootShellMirror(root: HTMLElement): RootShellMirror {
  let captured = false;
  const previous = new Map<string, string>();
  return {
    apply(resolve, dataset) {
      if (!captured) {
        for (const key of ROOT_MIRRORED_SHELL_VARS) {
          previous.set(key, root.style.getPropertyValue(key));
        }
        captured = true;
      }
      let writes = 0;
      for (const key of ROOT_MIRRORED_SHELL_VARS) {
        const nextValue = resolve(key);
        if (nextValue && nextValue !== root.style.getPropertyValue(key)) {
          root.style.setProperty(key, nextValue);
          writes += 1;
        }
      }
      for (const [name, value] of Object.entries(dataset)) {
        if (root.dataset[name] !== value) {
          root.dataset[name] = value;
          writes += 1;
        }
      }
      return writes;
    },
    restore() {
      if (!captured) return;
      for (const key of ROOT_MIRRORED_SHELL_VARS) {
        const value = previous.get(key) || "";
        if (value) {
          root.style.setProperty(key, value);
        } else {
          root.style.removeProperty(key);
        }
      }
      captured = false;
      previous.clear();
      delete root.dataset.appShellOffsetMode;
      delete root.dataset.appShellRouteLayout;
      delete root.dataset.appTopShellProfile;
    },
  };
}
