// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh

import { JSDOM } from "jsdom";

import {
  LOCATION_CONNECT_ACTION_PILL_CLASSNAME,
  LOCATION_CONNECT_ACTION_TARGET_CLASSNAME,
  LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME,
  LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME,
} from "../../components/one-location/redesign/location-action-styles";

export function alignPeopleActionsWithMountedRecipe(markup: string): string {
  // Generated fixtures already use the mounted recipe. Keep the legacy
  // substitution for older fixtures so this helper is safe to call twice.
  const targetCount = markup.split(LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME).length - 1;
  const pillCount = markup.split(LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME).length - 1;
  if (targetCount === 6 && pillCount === 6) return markup;
  if (markup.split(LOCATION_CONNECT_ACTION_PILL_CLASSNAME).length - 1 === 6) {
    return markup
      .replaceAll(LOCATION_CONNECT_ACTION_TARGET_CLASSNAME, LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME)
      .replaceAll(LOCATION_CONNECT_ACTION_PILL_CLASSNAME, LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME);
  }
  const shareTarget = "h-11 min-h-11 min-w-11 bg-transparent px-0 font-medium text-white shadow-none [--type-compact-button-label-weight:500] hover:bg-transparent hover:no-underline rounded-full";
  const askTarget = "h-11 min-h-11 min-w-11 bg-transparent px-0 font-medium text-[color:var(--app-accent)] shadow-none [--type-compact-button-label-weight:500] hover:bg-transparent rounded-full";
  const sharePill = "inline-flex h-10 w-full items-center justify-center bg-[color:var(--app-accent)] px-3 rounded-full";
  const askPill = "inline-flex h-10 w-full items-center justify-center bg-[#F2F2F7] px-3 rounded-full";
  for (const legacyClass of [shareTarget, askTarget, sharePill, askPill]) {
    if (!markup.includes(legacyClass)) throw new Error(`People fixture changed: ${legacyClass}`);
  }
  return markup
    .replaceAll(shareTarget, LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME)
    .replaceAll(askTarget, LOCATION_PEOPLE_ACTION_TARGET_CLASSNAME)
    .replaceAll(sharePill, LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME)
    .replaceAll(askPill, LOCATION_PEOPLE_ACTION_LABEL_CLASSNAME);
}

export function alignInviteAndPublicActionsWithMountedRecipe(markup: string): string {
  const document = new JSDOM(markup).window.document;
  for (const groupId of ["circle-invite-actions", "public-link-actions"]) {
    const group = document.querySelector(`[data-testid="${groupId}"]`);
    if (!group) throw new Error(`Missing ${groupId} fixture`);
    for (const button of group.querySelectorAll("button")) {
      const label = button.textContent?.trim() ?? "";
      const icon = button.querySelector("svg")?.outerHTML ?? "";
      button.className = `${LOCATION_CONNECT_ACTION_TARGET_CLASSNAME} ${groupId === "circle-invite-actions" ? "w-full min-w-0" : ""}`;
      button.removeAttribute("data-location-type-role");
      button.replaceChildren();
      const pill = document.createElement("span");
      pill.setAttribute("data-location-type-role", "compact-action");
      pill.setAttribute("data-location-action-surface", "true");
      pill.className = `${LOCATION_CONNECT_ACTION_PILL_CLASSNAME} ${groupId === "circle-invite-actions" ? "w-full min-w-0 px-2" : label === "Copy link" ? "w-[116px]" : ""}`;
      pill.innerHTML = icon;
      pill.append(document.createTextNode(label));
      button.append(pill);
      const ripple = document.createElement("div");
      ripple.setAttribute("data-ripple-mode", "material");
      ripple.className = "morphy-ripple-host pointer-events-none absolute inset-0 isolate overflow-hidden";
      button.append(ripple);
    }
  }
  return document.body.innerHTML;
}
