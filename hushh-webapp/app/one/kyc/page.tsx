import React from "react";
import { ProgressStepper } from "@/components/app-ui/progress-stepper";

export default function OneKYCPage() {
  // Define the actual steps for the Hushh One onboarding flow
  const kycSteps = [
    { id: "identity", title: "Identity Verification", description: "Verify your personal details" },
    { id: "documents", title: "Document Upload", description: "Upload government-issued ID" },
    { id: "review", title: "Final Review", description: "Review and submit" },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Hushh One KYC</h1>
        <p className="text-sm text-muted-foreground">Please complete your identity verification to unlock full platform features.</p>
      </div>

      <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
        {/* Attach our unattached component to the surface! */}
        <ProgressStepper steps={kycSteps} currentStepIndex={1} />

        <div className="mt-12 flex flex-col items-center gap-4 rounded-md bg-muted/20 p-8 text-center border border-dashed border-border">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-foreground">Step 2: Document Upload</h2>
            <p className="text-sm text-muted-foreground">Please securely upload your driver's license or passport here.</p>
          </div>
          
          <div className="mt-4 flex h-32 w-full max-w-md items-center justify-center rounded-lg bg-muted/50 border border-input">
             <span className="text-sm font-medium text-muted-foreground">Secure Dropzone Area</span>
          </div>
        </div>
      </section>
    </div>
  );
}