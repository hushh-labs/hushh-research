import { base64ToBytes, bytesToBase64 } from "@/lib/vault/base64";
import { decryptExport, derivePasswordExportKey, encryptForExport, PASSWORD_EXPORT_ITERATIONS } from "@/lib/vault/export-encrypt";
import { projectSharedPaymentCard, type SharedPaymentCard } from "./shared-payment-card";

export const ENCRYPTED_CARD_MAX_BYTES = 8192;
const FORMAT = "hushh-encrypted-payment-card";
export type EncryptedCardFile = {
  format: typeof FORMAT;
  version: 1;
  kdf: { algorithm: "PBKDF2-SHA256"; iterations: typeof PASSWORD_EXPORT_ITERATIONS; salt: string };
  payload: { ciphertext: string; iv: string; tag: string };
  openAt?: string;
};

function binding(value: EncryptedCardFile): string {
  return JSON.stringify([value.format, value.version, value.kdf.algorithm, value.kdf.iterations, value.kdf.salt]);
}

export function parseEncryptedCardFile(text: string): EncryptedCardFile {
  if (new TextEncoder().encode(text).length > ENCRYPTED_CARD_MAX_BYTES) throw new Error("Choose an encrypted card file.");
  let value: EncryptedCardFile;
  try { value = JSON.parse(text); } catch { throw new Error("Choose an encrypted card file."); }
  if (!value || value.format !== FORMAT || value.version !== 1 ||
      value.kdf?.algorithm !== "PBKDF2-SHA256" || value.kdf.iterations !== PASSWORD_EXPORT_ITERATIONS ||
      !/^[A-Za-z\d+/]{22}==$/.test(value.kdf.salt) ||
      !/^[A-Za-z\d+/]{16}$/.test(value.payload?.iv) ||
      !/^[A-Za-z\d+/]{22}==$/.test(value.payload?.tag) ||
      typeof value.payload?.ciphertext !== "string" || value.payload.ciphertext.length > 2048 ||
      !/^[A-Za-z\d+/]+=*$/.test(value.payload.ciphertext)) throw new Error("Choose an encrypted card file.");
  // Ignore untrusted optional instructions. They never determine navigation.
  return { format: FORMAT, version: 1, kdf: value.kdf, payload: value.payload };
}

export async function createEncryptedCardFile(card: SharedPaymentCard, password: string, openAt?: string): Promise<File> {
  if (password.length < 12) throw new Error("Use a password with at least 12 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derivePasswordExportKey(password, salt);
  const value: EncryptedCardFile = {
    format: FORMAT, version: 1,
    kdf: { algorithm: "PBKDF2-SHA256", iterations: PASSWORD_EXPORT_ITERATIONS, salt: bytesToBase64(salt) },
    payload: { ciphertext: "", iv: "", tag: "" },
  };
  value.payload = await encryptForExport(JSON.stringify(projectSharedPaymentCard(card)), key, { additionalData: binding(value) });
  if (openAt) value.openAt = openAt;
  return new File([JSON.stringify(value)], "encrypted-card.json", { type: "application/json" });
}

export async function readEncryptedCardFile(file: File): Promise<EncryptedCardFile> {
  if (!file.size || file.size > ENCRYPTED_CARD_MAX_BYTES) throw new Error("Choose an encrypted card file.");
  return parseEncryptedCardFile(await file.text());
}

export async function openEncryptedCardFile(value: EncryptedCardFile, password: string): Promise<SharedPaymentCard> {
  // Validate again at this boundary before performing an expensive derivation.
  const envelope = parseEncryptedCardFile(JSON.stringify(value));
  const key = await derivePasswordExportKey(password, base64ToBytes(envelope.kdf.salt));
  const plaintext = await decryptExport(envelope.payload.ciphertext, envelope.payload.iv, envelope.payload.tag, key, { additionalData: binding(envelope) });
  return projectSharedPaymentCard(JSON.parse(plaintext));
}
