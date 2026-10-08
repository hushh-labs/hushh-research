"use client";

import { useState, type ReactNode } from "react";

import { BodyText, PageTitle, SupportingText } from "@/components/app-ui/typography";
import { useKaiPlacement } from "@/lib/kai/kai-placement";
import { useAuth } from "@/lib/firebase/auth-context";
import { Button } from "@/lib/morphy-ux/button";

/**
 * Kai renders only for a Shared owner. Everyone else sees, plainly, that Kai is
 * coming to their own agent, and no Kai route is ever called on the hub for them.
 */
export function KaiPrivateAgentGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const placement = useKaiPlacement(user?.uid, attempt);
  if (placement === "shared") return <>{children}</>;
  if (placement === "checking") return null;
  return (
    <section
      className="mx-auto flex max-w-md flex-col gap-3 px-4 py-16 text-center"
      data-kai-placement={placement}
      aria-live="polite"
    >
      {placement === "private" ? (
        <>
          <PageTitle>Kai is coming to your agent</PageTitle>
          <BodyText>
            Your agent runs privately, so Kai will run inside it too. Your finance questions
            and holdings will stay with your agent and never pass through Hussh.
          </BodyText>
          <SupportingText>Kai will be available on your agent soon.</SupportingText>
        </>
      ) : (
        <>
          <PageTitle>Kai could not check where your agent runs</PageTitle>
          <BodyText>Try again in a moment.</BodyText>
          <div>
            <Button onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
          </div>
        </>
      )}
    </section>
  );
}
