"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "@/components/icons";

import {
  LegalDocumentBody,
  LegalDocumentMeta,
} from "@/components/legal/legal-document-body";
import {
  LEGAL_DOCUMENTS,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";

function LegalBackButton() {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }

  const handleBack = () => {
    if (router && typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else if (router) {
      router.push("/");
    } else if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  return (
    <div className="mb-4">
      <button
        type="button"
        aria-label="Go back"
        onClick={handleBack}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.05] text-[color:var(--app-label)] transition-colors hover:bg-black/[0.08] dark:bg-white/10 dark:hover:bg-white/15"
      >
        <ChevronLeft className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

// Public, static, and signed-out safe: linked from sign-in, Profile, the
// Google OAuth consent screen, and the store listings, so it must render for
// someone who has never opened the app. It is also bundled into the native
// static export, so in-app links never leave the app.
export function LegalDocumentPage({ type }: { type: LegalDocumentType }) {
  const doc = LEGAL_DOCUMENTS[type];
  const other = LEGAL_DOCUMENTS[type === "privacy" ? "terms" : "privacy"];

  return (
    <main
      className="min-h-dvh bg-[color:var(--app-grouped-background)] px-4 pb-28 pt-[max(var(--app-safe-area-top-effective,0px),20px)] sm:px-6"
      data-testid={`legal-${type}-page`}
    >
      <article className="mx-auto w-full max-w-[720px]">
        <LegalBackButton />
        <p className="text-[14px] font-medium uppercase tracking-wide text-[color:var(--app-secondary-label)]">
          Hussh One
        </p>
        <h1 className="mt-2 text-[32px] font-semibold leading-10 text-[color:var(--app-label)]">
          {doc.title}
        </h1>
        <p className="mt-2 text-[14px] text-[color:var(--app-secondary-label)]">
          <LegalDocumentMeta doc={doc} />
        </p>
        <p className="mt-4 text-[16px] leading-7 text-[color:var(--app-secondary-label)]">
          {doc.summary}
        </p>

        <nav
          aria-label="On this page"
          className="mt-8 rounded-2xl bg-[color:var(--app-card-surface-default-solid)] p-5"
        >
          <p className="text-[14px] font-semibold text-[color:var(--app-label)]">
            On this page
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-6 text-[15px] leading-6">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <a
                  className="text-[color:var(--app-accent)] hover:underline"
                  href={`#${section.id}`}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10">
          <LegalDocumentBody doc={doc} />
        </div>

        <p className="mt-12 text-[16px] leading-7 text-[color:var(--app-secondary-label)]">
          See also our{" "}
          <Link
            className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
            href={other.route}
          >
            {other.title}
          </Link>
          .
        </p>
      </article>
    </main>
  );
}
