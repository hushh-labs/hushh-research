import { describe, expect, it } from "vitest";
import {
  createPilotContentKey,
  openPilotConnectorStatus,
  pilotSourceAad,
  recoverPilotContentKey,
  sealPilotConnectorStatus,
} from "@/lib/vault/hosted-memory-pilot-crypto";

const context = {
  ownerId: "owner-A",
  grantId: "e35460f9-f31c-4513-b172-8fc6d633f932",
  generation: "4",
  sourceId: "google_drive",
};
const vaultKeyHex = "8a".repeat(32);
const status = {
  provider: "google_drive",
  status: "connected" as const,
  connectedAt: "2026-10-15T01:02:03.000Z",
  authStyle: "oauth" as const,
};

describe("hosted pilot scoped envelope crypto", () => {
  it("round trips a selected source through the owner recovery copy with the exact wire AAD", async () => {
    const { contentKey, ownerWrapped } = await createPilotContentKey(context, vaultKeyHex);
    expect(contentKey.key.extractable).toBe(false);
    expect(ownerWrapped).not.toHaveProperty("key");
    expect(JSON.stringify(ownerWrapped)).not.toContain(vaultKeyHex);
    const restored = await recoverPilotContentKey(context, vaultKeyHex, ownerWrapped);
    const envelope = await sealPilotConnectorStatus({
      contentKey: restored, sourceId: "google_drive", expectedRevision: "0", status,
    });
    expect(envelope.expectedGeneration).toBe("4");
    expect(envelope.expectedRevision).toBe("0");
    expect(envelope.nonceBase64Url).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(envelope.ciphertextBase64Url).not.toContain("connected");
    const aad = pilotSourceAad(context, "google_drive", "1");
    const expectedAad = "hushh-hosted-source-v1\nb3duZXItQQ\ne35460f9-f31c-4513-b172-8fc6d633f932\n4\ngoogle_drive\nconnector_status.v1\n1";
    expect(new TextDecoder().decode(aad)).toBe(expectedAad);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", aad));
    expect(envelope.aadSha256).toBe(
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    await expect(openPilotConnectorStatus({
      contentKey, sourceId: "google_drive", revision: "1",
      nonceBase64Url: envelope.nonceBase64Url,
      ciphertextBase64Url: envelope.ciphertextBase64Url,
    })).resolves.toEqual(status);
  });

  it("fences owner, grant, generation, source, revision, ciphertext and vault key", async () => {
    const { contentKey, ownerWrapped } = await createPilotContentKey(context, vaultKeyHex);
    const envelope = await sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "5", status,
    });
    const open = (patch: Partial<Parameters<typeof openPilotConnectorStatus>[0]> = {}) =>
      openPilotConnectorStatus({
        contentKey, sourceId: "google_drive", revision: "6",
        nonceBase64Url: envelope.nonceBase64Url,
        ciphertextBase64Url: envelope.ciphertextBase64Url,
        ...patch,
      });
    await expect(open({ revision: "7" })).rejects.toThrow();
    await expect(open({ sourceId: "gmail" })).rejects.toThrow();
    await expect(open({ contentKey: { ...contentKey, ownerId: "owner-B" } })).rejects.toThrow();
    await expect(open({ contentKey: { ...contentKey, grantId: "e35460f9-f31c-4513-b172-8fc6d633f933" } })).rejects.toThrow();
    await expect(open({ contentKey: { ...contentKey, generation: "5" } })).rejects.toThrow();
    const corrupted = `${envelope.ciphertextBase64Url[0] === "A" ? "B" : "A"}${envelope.ciphertextBase64Url.slice(1)}`;
    await expect(open({ ciphertextBase64Url: corrupted })).rejects.toThrow();
    await expect(recoverPilotContentKey(context, "00".repeat(32), ownerWrapped)).rejects.toThrow();
    await expect(recoverPilotContentKey({ ...context, ownerId: "owner-B" }, vaultKeyHex, ownerWrapped)).rejects.toThrow();
    await expect(recoverPilotContentKey({ ...context, generation: "5" }, vaultKeyHex, ownerWrapped)).rejects.toThrow();
    await expect(recoverPilotContentKey({ ...context, sourceId: "gmail" }, vaultKeyHex, ownerWrapped)).rejects.toThrow();
  });

  it("rejects values outside the selected status field list and uses a fresh IV", async () => {
    const { contentKey } = await createPilotContentKey(context, vaultKeyHex);
    const first = await sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "0", status,
    });
    const second = await sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "0", status,
    });
    expect(first.nonceBase64Url).not.toBe(second.nonceBase64Url);
    expect(first.ciphertextBase64Url).not.toBe(second.ciphertextBase64Url);
    const disconnected = await sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "1",
      status: { ...status, status: "not_connected", connectedAt: null },
    });
    await expect(openPilotConnectorStatus({
      contentKey, sourceId: "google_drive", revision: "2",
      nonceBase64Url: disconnected.nonceBase64Url,
      ciphertextBase64Url: disconnected.ciphertextBase64Url,
    })).resolves.toMatchObject({ status: "not_connected" });
    await expect(sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "0",
      status: { ...status, provider: "gmail" },
    })).rejects.toThrow("outside pilot source scope");
    await expect(sealPilotConnectorStatus({
      contentKey, sourceId: "google_drive", expectedRevision: "0",
      status: { ...status, status: "invented" as "connected" },
    })).rejects.toThrow("outside pilot source scope");
  });
});
