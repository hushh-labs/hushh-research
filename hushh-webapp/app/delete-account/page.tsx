import type { Metadata } from "next";

// Linked from Google Play's Data safety "Delete account URL". It must work for
// someone who no longer has the app, so it is static, public, and never
// deletes anything itself: a request is only acted on after ownership is
// verified. Keep the in-app steps in sync with the Profile "Delete account" flow.
const SUPPORT_EMAIL = "support@hushh.ai";
const REQUEST_SUBJECT = "Delete my Hussh One account";
const PRIVACY_POLICY_URL = "/privacy";

export const metadata: Metadata = {
  title: "Delete your Hussh One account · Hussh",
  description:
    "How to delete your Hussh One account and information, in the app or without it, and what is kept afterwards.",
  alternates: { canonical: "/delete-account" },
};

const sectionHeading =
  "mt-10 text-[20px] font-semibold leading-7 text-[color:var(--app-label)]";
const bodyText =
  "mt-3 text-[16px] leading-6 text-[color:var(--app-secondary-label)]";
const listText =
  "mt-3 list-disc space-y-2 pl-6 text-[16px] leading-6 text-[color:var(--app-secondary-label)]";

// Where a person removes a Google grant themselves if our revoke did not land.
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

export default function DeleteAccountPage() {
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(REQUEST_SUBJECT)}`;

  return (
    <main
      className="min-h-dvh bg-[color:var(--app-grouped-background)] px-4 pb-28 pt-[max(var(--app-safe-area-top-effective,0px),32px)] sm:px-6"
      data-testid="delete-account-page"
    >
      <article className="mx-auto w-full max-w-[680px]">
        <p className="text-[14px] font-medium uppercase tracking-wide text-[color:var(--app-secondary-label)]">
          Hussh One
        </p>
        <h1 className="mt-2 text-[32px] font-semibold leading-10 text-[color:var(--app-label)]">
          Delete your account
        </h1>
        <p className={bodyText}>
          This page explains how to delete your Hussh One account and the
          information linked to it. It applies to the Hussh One app on Android
          and iPhone and to one.hushh.ai. Deleting your account can’t be undone.
        </p>

        <h2 className={sectionHeading}>Delete it in the app</h2>
        <p className={bodyText}>This is the fastest way, and it takes effect right away.</p>
        <ol className="mt-3 list-decimal space-y-2 pl-6 text-[16px] leading-6 text-[color:var(--app-secondary-label)]">
          <li>Open Hussh One and sign in.</li>
          <li>Go to Profile.</li>
          <li>Tap Delete account. If your vault is locked, unlock it first.</li>
          <li>Confirm. You’re signed out once the deletion finishes.</li>
        </ol>

        <h2 className={sectionHeading}>Ask us to delete it without the app</h2>
        <p className={bodyText}>
          If you no longer have the app or can’t sign in, email{" "}
          <a
            className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
            href={mailto}
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          with the subject “{REQUEST_SUBJECT}”. Send it from the email address
          on your account if you can, and include the phone number you signed
          in with.
        </p>
        <p className={bodyText}>
          Before we delete anything, we confirm the request came from the
          account owner. We reply to the email or phone number already on the
          account, and we only proceed once you confirm from there. We will
          never ask for your password, your vault passphrase, or a verification
          code sent to you by text. Don’t include them in your email.
        </p>
        <p className={bodyText}>
          We’ll let you know when the deletion is complete.
        </p>

        <h2 className={sectionHeading}>What gets deleted</h2>
        <ul className={listText}>
          <li>Your profile and sign-in account</li>
          <li>
            Your vault and everything in it, including what One remembers about
            you
          </li>
          <li>Your chat history with One</li>
          <li>
            Your connections: the services you linked, the people you connected
            with, and what you shared with them
          </li>
          <li>Your location sharing, circles, and check-ins</li>
          <li>Your settings</li>
        </ul>

        <h2 className={sectionHeading}>Google, banks, and other services</h2>
        <ul className={listText}>
          <li>
            Before anything is deleted, we disconnect the banks you linked
            through Plaid. If that fails, nothing is deleted and the app asks
            you to try again.
          </li>
          <li>
            After deletion, we ask Google to revoke One’s access to your Google
            account, including Gmail, Calendar, and Drive. If Hussh One still
            appears under{" "}
            <a
              className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
              href={GOOGLE_PERMISSIONS_URL}
              rel="noopener"
            >
              your Google account’s third-party access
            </a>
            , remove it there.
          </li>
          <li>
            Other services you connected keep their own record of the link.
            Remove Hussh One, or revoke any key you gave it, in that service’s
            settings.
          </li>
          <li>
            If you ask us by email, we can’t open your vault, so we can’t
            disconnect your banks for you. Remove the connection in your
            bank’s or Plaid’s settings.
          </li>
        </ul>

        <h2 className={sectionHeading}>If you set up a private agent in your own cloud</h2>
        <p className={bodyText}>
          If your private agent runs in your own cloud account, the app asks you
          to remove it before your account can be deleted. If that step doesn’t
          finish, email {SUPPORT_EMAIL} and we’ll help you remove it.
        </p>

        <h2 className={sectionHeading}>What we may keep</h2>
        <ul className={listText}>
          <li>
            Receipts of the subscriptions you granted to or revoked from
            businesses, because they form a tamper-evident ledger.
          </li>
          <li>
            A one-way code made from your account identifier, so a deleted
            account can’t be quietly recreated or restored.
          </li>
          <li>
            Database backups, for a limited period. Deleted information stays
            in them until they expire on their own schedule.
          </li>
        </ul>
        <p className={bodyText}>
          Contact matching doesn’t store your address book, so there is no
          contact list to delete.
        </p>

        <p className={bodyText}>
          Read our{" "}
          <a
            className="font-medium text-[color:var(--app-accent)] underline underline-offset-2"
            href={PRIVACY_POLICY_URL}
            rel="noopener"
          >
            privacy policy
          </a>{" "}
          for more about how we handle your information.
        </p>
      </article>
    </main>
  );
}
