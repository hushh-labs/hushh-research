"use client";

import { KaiOnboardingGuard } from "@/components/kai/onboarding/kai-onboarding-guard";
import { KaiChatView } from "@/components/kai/views/kai-chat-view";

export default function KaiChatPage() {
  return (
    <KaiOnboardingGuard>
      <KaiChatView />
    </KaiOnboardingGuard>
  );
}
