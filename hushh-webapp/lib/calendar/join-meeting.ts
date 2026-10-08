"use client";

import { Capacitor } from "@capacitor/core";
import { HushhOAuthReturn } from "@/lib/capacitor/oauth-return";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";

/** Reserve the browser gesture before the authenticated live meeting read. */
export async function joinCalendarMeeting(
  token: string,
  eventId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const native = Capacitor.isNativePlatform();
  const popup = native ? null : window.open("about:blank", "_blank");
  if (!native && !popup) throw new Error("Allow pop-ups to open Google Meet.");
  if (popup) popup.opener = null;
  try {
    const url = await GoogleCalendarService.joinMeeting(token, eventId);
    if (!isCurrent()) {
      popup?.close();
      return;
    }
    if (native) await HushhOAuthReturn.openExternalUrl({ url });
    else if (popup && !popup.closed) popup.location.replace(url);
  } catch (error) {
    popup?.close();
    throw error;
  }
}
