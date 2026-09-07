"use client";

export function SessionVerificationRecovery({
  onRetry,
  onSignOut,
}: {
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <main className="flex min-h-[70vh] items-center justify-center bg-background px-6 py-12">
      <section
        aria-labelledby="session-verification-title"
        className="w-full max-w-md rounded-3xl border border-border/70 bg-card p-7 text-center shadow-sm"
        role="alert"
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted text-xl"
        >
          🔒
        </div>
        <h1
          id="session-verification-title"
          className="text-xl font-semibold tracking-tight text-foreground"
        >
          Reconnect to continue securely
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          We couldn&apos;t verify this account, so your private information
          stayed hidden. Check your connection and try again.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            className="min-h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background"
            onClick={onRetry}
            type="button"
          >
            Try again
          </button>
          <button
            className="min-h-11 rounded-full border border-border px-6 text-sm font-semibold text-foreground"
            onClick={onSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}
