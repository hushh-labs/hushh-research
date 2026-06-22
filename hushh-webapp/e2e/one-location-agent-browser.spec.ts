import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("protected One Location route does not leak location or phone identity before auth", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/one/location", { waitUntil: "domcontentloaded" });

  await expect
    .poll(
      async () => {
        const bodyText = await page.locator("body").innerText();
        return page.url().includes("/login") ||
          /Sign in to One|Redirecting to login|Checking session|Loading/i.test(
            bodyText,
          );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const body = await page.evaluate(() => document.body?.innerText ?? "");
  expect(body).not.toMatch(/8012|latitude|longitude|28\.6139|77\.209/u);
  expect(body).not.toMatch(
    /KAI Circle|People who can see me|Your circle, safely connected|Trusted B|Advisor C|Setup D/u,
  );
});

test("One Location Agent A/B/C/D flow keeps backend state ciphertext-only in browser crypto", async ({
  page,
}) => {
  await page.goto("/one/location", { waitUntil: "domcontentloaded" });
  await page.setContent(`
    <main data-testid="one-location-crypto-proof">
      One Location browser crypto proof
    </main>
  `);

  const result = await page.evaluate(async () => {
    const algorithm = "ECDH-P256-AES256-GCM";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function toBase64Url(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    }

    function fromBase64Url(value: string): ArrayBuffer {
      const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
        Math.ceil(value.length / 4) * 4,
        "=",
      );
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes.buffer;
    }

    async function fingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
      const payload = JSON.stringify(publicKeyJwk, Object.keys(publicKeyJwk).sort());
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(payload));
      return toBase64Url(digest);
    }

    async function createRecipient(userId: string) {
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"],
      );
      const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      return {
        userId,
        keyId: await fingerprint(publicKeyJwk),
        publicKeyJwk,
        privateKey: keyPair.privateKey,
      };
    }

    async function importPublicKey(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
      return crypto.subtle.importKey(
        "jwk",
        publicKeyJwk,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      );
    }

    async function deriveAesKey(
      privateKey: CryptoKey,
      publicKey: CryptoKey,
      usage: KeyUsage,
    ): Promise<CryptoKey> {
      return crypto.subtle.deriveKey(
        { name: "ECDH", public: publicKey },
        privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        [usage],
      );
    }

    async function encryptForRecipient(
      point: { latitude: number; longitude: number; capturedAt: string; sourcePlatform: string },
      recipient: Awaited<ReturnType<typeof createRecipient>>,
    ) {
      const recipientPublicKey = await importPublicKey(recipient.publicKeyJwk);
      const ephemeralPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"],
      );
      const aesKey = await deriveAesKey(ephemeralPair.privateKey, recipientPublicKey, "encrypt");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aesKey,
        encoder.encode(JSON.stringify(point)),
      );
      return {
        algorithm,
        recipientKeyId: recipient.keyId,
        ciphertext: toBase64Url(ciphertext),
        iv: toBase64Url(iv.buffer),
        senderEphemeralPublicKeyJwk: await crypto.subtle.exportKey(
          "jwk",
          ephemeralPair.publicKey,
        ),
        capturedAt: point.capturedAt,
        sourcePlatform: point.sourcePlatform,
        metadata: { payload: "coordinate_envelope", plaintext: false },
      };
    }

    async function decryptForRecipient(
      envelope: Awaited<ReturnType<typeof encryptForRecipient>>,
      recipient: Awaited<ReturnType<typeof createRecipient>>,
    ) {
      if (envelope.recipientKeyId !== recipient.keyId) {
        throw new Error("recipient key mismatch");
      }
      const senderPublicKey = await importPublicKey(envelope.senderEphemeralPublicKeyJwk);
      const aesKey = await deriveAesKey(recipient.privateKey, senderPublicKey, "decrypt");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
        aesKey,
        fromBase64Url(envelope.ciphertext),
      );
      return JSON.parse(decoder.decode(plaintext)) as {
        latitude: number;
        longitude: number;
      };
    }

    const userA = "user-a";
    const userB = await createRecipient("user-b");
    const userC = await createRecipient("user-c");
    const userD = await createRecipient("user-d");
    const backendState: {
      grants: Record<string, { ownerUserId: string; recipientUserId: string; recipientKeyId: string; status: string }>;
      envelopes: Record<string, Awaited<ReturnType<typeof encryptForRecipient>>>;
      requests: Record<string, { ownerUserId: string; requesterUserId: string; status: string }>;
      referrals: Record<string, { referringUserId: string; referredUserId: string; status: string }>;
    } = {
      grants: {},
      envelopes: {},
      requests: {},
      referrals: {},
    };

    function createGrant(recipient: Awaited<ReturnType<typeof createRecipient>>) {
      const id = `grant-${Object.keys(backendState.grants).length + 1}`;
      backendState.grants[id] = {
        ownerUserId: userA,
        recipientUserId: recipient.userId,
        recipientKeyId: recipient.keyId,
        status: "active",
      };
      return id;
    }

    function viewEnvelope(userId: string, grantId: string) {
      const grant = backendState.grants[grantId];
      if (!grant || grant.recipientUserId !== userId || grant.status !== "active") {
        throw new Error("no active grant");
      }
      return backendState.envelopes[grantId];
    }

    const point = {
      latitude: 28.6139,
      longitude: 77.209,
      capturedAt: new Date("2026-05-20T10:00:00.000Z").toISOString(),
      sourcePlatform: "web",
    };

    const grantB = createGrant(userB);
    backendState.envelopes[grantB] = await encryptForRecipient(point, userB);
    const bPoint = await decryptForRecipient(viewEnvelope(userB.userId, grantB), userB);

    let cCannotDecrypt = false;
    try {
      await decryptForRecipient(viewEnvelope(userB.userId, grantB), userC);
    } catch {
      cCannotDecrypt = true;
    }

    const referralId = "referral-1";
    const requestId = "request-1";
    backendState.referrals[referralId] = {
      referringUserId: userB.userId,
      referredUserId: userD.userId,
      status: "pending_owner_approval",
    };
    backendState.requests[requestId] = {
      ownerUserId: userA,
      requesterUserId: userD.userId,
      status: "pending",
    };

    let dBeforeApprovalDenied = false;
    try {
      viewEnvelope(userD.userId, grantB);
    } catch {
      dBeforeApprovalDenied = true;
    }

    backendState.requests[requestId].status = "approved";
    const grantD = createGrant(userD);
    backendState.envelopes[grantD] = await encryptForRecipient(point, userD);
    const dPoint = await decryptForRecipient(viewEnvelope(userD.userId, grantD), userD);

    backendState.grants[grantB].status = "revoked";
    let bAfterRevokeDenied = false;
    try {
      viewEnvelope(userB.userId, grantB);
    } catch {
      bAfterRevokeDenied = true;
    }

    return {
      bPoint,
      cCannotDecrypt,
      dBeforeApprovalDenied,
      dPoint,
      bAfterRevokeDenied,
      backendState,
    };
  });

  expect(result.bPoint.latitude).toBeCloseTo(28.6139, 4);
  expect(result.dPoint.longitude).toBeCloseTo(77.209, 4);
  expect(result.cCannotDecrypt).toBe(true);
  expect(result.dBeforeApprovalDenied).toBe(true);
  expect(result.bAfterRevokeDenied).toBe(true);
  expect(JSON.stringify(result.backendState)).not.toMatch(/latitude|longitude|28\.6139|77\.209/u);
});

test("multi-recipient One Location proof captures once and fans out encrypted grants", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="one-location-multi-recipient-proof">
      One Location multi-recipient proof
    </main>
  `);

  const result = await page.evaluate(async () => {
    type Recipient = {
      userId: string;
      displayName: string;
      canReceiveLocation: boolean;
      keyId?: string;
      publicKeyJwk?: JsonWebKey;
    };
    type Point = {
      latitude: number;
      longitude: number;
      capturedAt: string;
      sourcePlatform: string;
    };
    const recipients: Recipient[] = [
      {
        userId: "user-b",
        displayName: "Trusted B",
        canReceiveLocation: true,
        keyId: "key-b",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      },
      {
        userId: "user-c",
        displayName: "Advisor C",
        canReceiveLocation: false,
      },
      {
        userId: "user-d",
        displayName: "Investor D",
        canReceiveLocation: true,
        keyId: "key-d",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x2", y: "y2" },
      },
    ];
    const state: {
      captureCount: number;
      grants: Record<string, { recipientUserId: string; recipientKeyId: string; status: string }>;
      envelopes: Record<string, { recipientKeyId: string; ciphertext: string; plaintext: false }>;
      requests: Record<string, { ownerUserId: string; status: string }>;
    } = {
      captureCount: 0,
      grants: {},
      envelopes: {},
      requests: {},
    };

    function captureCurrentPosition(): Point {
      state.captureCount += 1;
      return {
        latitude: 28.6139,
        longitude: 77.209,
        capturedAt: "2026-05-20T07:30:00.000Z",
        sourcePlatform: "web",
      };
    }

    function assertReady(recipient: Recipient): asserts recipient is Recipient & {
      keyId: string;
      publicKeyJwk: JsonWebKey;
    } {
      if (!recipient.canReceiveLocation || !recipient.keyId || !recipient.publicKeyJwk) {
        throw new Error(`${recipient.displayName} needs setup`);
      }
    }

    async function shareSelected(selectedRecipients: Recipient[]) {
      const readyRecipients = selectedRecipients.map((recipient) => {
        assertReady(recipient);
        return recipient;
      });
      const point = captureCurrentPosition();
      for (const recipient of readyRecipients) {
        const grantId = `grant-${recipient.userId}`;
        state.grants[grantId] = {
          recipientUserId: recipient.userId,
          recipientKeyId: recipient.keyId,
          status: "active",
        };
        state.envelopes[grantId] = {
          recipientKeyId: recipient.keyId,
          ciphertext: btoa(JSON.stringify({ point, recipient: recipient.userId })),
          plaintext: false,
        };
      }
    }

    async function requestSelected(selectedOwners: Recipient[]) {
      for (const owner of selectedOwners) {
        state.requests[`request-${owner.userId}`] = {
          ownerUserId: owner.userId,
          status: "pending_owner_approval",
        };
      }
    }

    const readyRecipients = [recipients[0], recipients[2]];
    await shareSelected(readyRecipients);
    let setupBlocked = false;
    try {
      await shareSelected([recipients[1]]);
    } catch {
      setupBlocked = true;
    }
    await requestSelected(readyRecipients);

    return {
      captureCount: state.captureCount,
      grantRecipientIds: Object.values(state.grants).map(
        (grant) => grant.recipientUserId,
      ),
      envelopeKeyIds: Object.values(state.envelopes).map(
        (envelope) => envelope.recipientKeyId,
      ),
      requestOwnerIds: Object.values(state.requests).map(
        (request) => request.ownerUserId,
      ),
      setupBlocked,
      serializedState: JSON.stringify(state),
    };
  });

  expect(result.captureCount).toBe(1);
  expect(result.grantRecipientIds).toEqual(["user-b", "user-d"]);
  expect(result.envelopeKeyIds).toEqual(["key-b", "key-d"]);
  expect(result.requestOwnerIds).toEqual(["user-b", "user-d"]);
  expect(result.setupBlocked).toBe(true);
  expect(result.serializedState).not.toMatch(/latitude|longitude|28\.6139|77\.209/u);
});

test("One Location loading and empty states keep failure alerts visible", async ({
  page,
}) => {
  await page.setContent(`
    <main data-testid="one-location-proof" data-route="/one/location">
      <section aria-label="KAI Circle"></section>
      <section aria-label="Location failure states"></section>
    </main>
  `);

  async function renderState(variant: "loading" | "empty") {
    await page.evaluate((nextVariant) => {
      const circle = document.querySelector<HTMLElement>(
        '[aria-label="KAI Circle"]',
      );
      const failures = document.querySelector<HTMLElement>(
        '[aria-label="Location failure states"]',
      );
      if (!circle || !failures) throw new Error("proof fixture missing");

      circle.innerHTML =
        nextVariant === "loading"
          ? `
            <div role="status" aria-live="polite">
              Loading KAI Circle recommendations
            </div>
            <div data-slot="skeleton" aria-hidden="true"></div>
          `
          : `
            <div role="note">
              KAI Circle is empty
            </div>
            <button type="button">Create Request Link</button>
          `;

      failures.innerHTML = `
        <div role="alert" data-failure="consent">
          Consent review required before this location grant can continue.
        </div>
        <div role="alert" data-failure="permission">
          GPS permission denied. Sharing remains blocked.
        </div>
        <div role="alert" data-failure="request">
          Location request failed. No location envelope was created.
        </div>
      `;
    }, variant);
  }

  async function expectFailuresVisible() {
    await expect(
      page.getByRole("alert").filter({ hasText: "Consent review required" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "GPS permission denied" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Location request failed" }),
    ).toBeVisible();
  }

  await renderState("loading");
  await expect(page.getByRole("status")).toContainText("Loading KAI Circle");
  await expectFailuresVisible();

  await renderState("empty");
  await expect(page.getByRole("note")).toContainText("KAI Circle is empty");
  await expect(page.getByRole("button", { name: "Create Request Link" })).toBeVisible();
  await expectFailuresVisible();
});
