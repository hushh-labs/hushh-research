"use client";

import { usePublishVoiceSurfaceMetadata } from "@/lib/kai/actions/voice-surface-metadata";
import { ROUTES } from "@/lib/navigation/routes";

export function usePhoneMandateMetadata(active: boolean, verificationStep: "phone" | "code" | "linked") {
  usePublishVoiceSurfaceMetadata(
    active
      ? {
          screenId: "phone_mandate",
          title: "Verify your phone",
          purpose:
            "Verify your phone to continue setup or accept your invitation.",
          // The step is the only verification state published to One. Phone
          // numbers and OTPs stay inside the input and auth operation.
          screenMetadata: { phone_verification_step: verificationStep },
          actions:
            verificationStep === "phone"
              ? [
                  {
                    id: "phone_mandate.submit_number",
                    actionId: "phone_mandate.submit_number",
                    label: "Send a verification code",
                    purpose: "Send a code after the phone form is completed.",
                  },
                ]
              : verificationStep === "code"
                ? [
                    {
                      id: "phone_mandate.submit_code",
                      actionId: "phone_mandate.submit_code",
                      label: "Confirm verification code",
                      purpose: "Confirm the code in the current verification form.",
                    },
                  ]
                : [],
          controls:
            verificationStep === "phone"
              ? [
                  {
                    id: "phone-flow-number",
                    label: "Phone number",
                    type: "tel",
                    actionId: "phone_mandate.submit_number",
                  },
                ]
              : verificationStep === "code"
                ? [
                    {
                      id: "phone-flow-code",
                      label: "Verification code",
                      type: "text",
                      actionId: "phone_mandate.submit_code",
                    },
                  ]
                : [],
        }
      : null,
    { role: "route", routeKey: ROUTES.PHONE_MANDATE },
  );
}
