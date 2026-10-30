import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AnswerRequestCard } from "@/components/consent/answer-request-card";
import { ensureMarketplaceRecipientKey, encryptSliceForRecipient } from "@/lib/one-marketplace/encryption";
import { FixtureSessionProvider, PHOTO_REQUESTER, useFixtureSession } from "./answer-profile-photo-boundaries";

export const PHOTO_REQUEST_ID = "01234567-89ab-4cde-8fab-0123456789ab";
// A generated 3x2 PNG with valid CRCs. No private photo or external image URL.
const PHOTO_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAE0lEQVR4nGNQLt0LQQwvZgRAEABXLwlwCUowZgAAAABJRU5ErkJggg==";

async function makeEnvelope() {
  const recipient = await ensureMarketplaceRecipientKey(PHOTO_REQUESTER);
  await ensureMarketplaceRecipientKey("synthetic-other-requester");
  return encryptSliceForRecipient({
    recipientPublicKeyJwk: recipient.publicKeyJwk,
    recipientKeyId: recipient.keyId,
    payload: {
      version: 1,
      answerMode: "agent",
      answer: "The approved profile photo belongs to Avery.\n\n![Untrusted model image](https://untrusted.invalid/model-image.png)",
      approvedScopes: ["attr.identity.identity_profile.full_name", "attr.identity.identity_profile.profile_photo_url"],
      ownerIdentity: { displayName: "Avery", photoUrl: PHOTO_URL },
    },
  });
}

// Only ciphertext is exposed to the intercepted server. Private CryptoKeys
// remain in the production IndexedDB recipient store throughout the test.
Object.assign(window, { answerPhotoEnvelope: makeEnvelope() });

function Fixture() {
  const { session, change } = useFixtureSession();
  return <main className="mx-auto max-w-md space-y-6 p-6">
    <h1>Paid answer profile photo</h1>
    <div className="flex flex-wrap gap-3">
      <button onClick={() => change(session.uid, false)}>Lock fixture vault</button>
      <button onClick={() => change("synthetic-other-requester", true)}>Switch fixture account</button>
    </div>
    <section aria-label="Paid answer"><AnswerRequestCard requestId={PHOTO_REQUEST_ID} /></section>
  </main>;
}

// Production Markdown links require Next's router context even when they are
// inert. No navigation is exercised by this image-decoding fixture.
const unexpectedNavigation = () => { throw new Error("Unexpected fixture navigation"); };
const router = { back: unexpectedNavigation, forward: unexpectedNavigation, refresh: unexpectedNavigation,
  push: unexpectedNavigation, replace: unexpectedNavigation, prefetch: async () => undefined };
createRoot(document.getElementById("root")!).render(
  <AppRouterContext.Provider value={router}><FixtureSessionProvider><Fixture /></FixtureSessionProvider></AppRouterContext.Provider>,
);
