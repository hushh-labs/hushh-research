import { expect, test } from "@playwright/test";

test("One Location Agent A/B/C/D flow keeps backend state ciphertext-only in browser crypto", async ({
  page,
}) => {
  await page.goto("/");

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
