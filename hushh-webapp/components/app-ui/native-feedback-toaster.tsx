"use client";

import { useEffect } from "react";
import { useSonner } from "sonner";
import { reconcileNativeFeedback, retainNativeFeedbackConsumer } from "@/lib/capacitor/native-feedback";
import { subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";

/** Headless Sonner consumer. Native-tagged messages never mount a DOM toaster;
 * native expiry dismisses the same canonical Sonner handle. */
export function NativeFeedbackToaster() {
  return customNativePresentationEnabled() ? <NativeFeedbackConsumer /> : null;
}

function NativeFeedbackConsumer() {
  const { toasts } = useSonner();
  useEffect(() => retainNativeFeedbackConsumer(), []);
  useEffect(() => {
    reconcileNativeFeedback(toasts);
    return subscribeNativePrivacyObservation(() => reconcileNativeFeedback(toasts));
  }, [toasts]);
  return null;
}
