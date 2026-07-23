/*
 * SPDX-FileCopyrightText: 2026 Hushh
 * SPDX-License-Identifier: Apache-2.0
 */
package ai.hussh.consent;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.NamedParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.XECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Java 17/JCA reference decryptor for a Hussh consent export envelope v2.
 *
 * <p>The caller should parse the MCP tool result with its normal JSON library and pass the
 * canonical {@code export_envelope_json} object as a Map. The cryptography itself uses only
 * Java 17 APIs. Production connectors should pass a non-exportable PrivateKey supplied by their
 * approved JCA/KMS/HSM provider instead of loading private-key bytes.
 */
public final class ConsentExportDecryptor {
  public static final String WRAPPING_ALGORITHM = "X25519-AES256-GCM";
  private static final String PAYLOAD_ALGORITHM = "AES-256-GCM";
  private static final int X25519_KEY_BYTES = 32;
  private static final int AES_256_KEY_BYTES = 32;
  private static final int GCM_IV_BYTES = 12;
  private static final int GCM_TAG_BYTES = 16;

  private ConsentExportDecryptor() {}

  public record FlatExportPackage(
      String status,
      String delivery,
      String expectedScope,
      String grantedScope,
      long expiresAt,
      long exportRevision,
      String ciphertext,
      String payloadIv,
      String payloadTag,
      String wrappedExportKey,
      String wrappedKeyIv,
      String wrappedKeyTag,
      String senderPublicKey,
      String connectorKeyId,
      String wrappingAlg,
      Map<String, Object> exportEnvelope) {}

  /**
   * Context learned from the authenticated consent lifecycle, not from the encrypted response.
   */
  public record ExpectedContext(
      String appId,
      String grantId,
      long revision,
      String requestedScope,
      String envelopeScope,
      String scopeHandle,
      String recipientKeyFingerprint,
      long expiresAtMs,
      String connectorKeyId) {}

  public static byte[] decrypt(
      FlatExportPackage input, PrivateKey connectorPrivateKey, ExpectedContext expected)
      throws Exception {
    return decryptAt(input, connectorPrivateKey, expected, System.currentTimeMillis());
  }

  static byte[] decryptAt(
      FlatExportPackage input,
      PrivateKey connectorPrivateKey,
      ExpectedContext expected,
      long nowMs)
      throws Exception {
    Objects.requireNonNull(input, "input");
    Objects.requireNonNull(connectorPrivateKey, "connectorPrivateKey");
    Objects.requireNonNull(expected, "expected");
    requireEquals(WRAPPING_ALGORITHM, input.wrappingAlg(), "wrapping_alg");
    requireEquals(expected.connectorKeyId(), input.connectorKeyId(), "connector_key_id");
    requireEquals("success", input.status(), "status");
    requireEquals("encrypted_inline", input.delivery(), "delivery");
    requireEquals(expected.requestedScope(), input.expectedScope(), "expected_scope");
    requireEquals(expected.envelopeScope(), input.grantedScope(), "granted_scope");
    requireLongValue(expected.revision(), input.exportRevision(), "export_revision");
    requireLongValue(expected.expiresAtMs(), input.expiresAt(), "expires_at");
    if (!scopeCovers(expected.envelopeScope(), expected.requestedScope())) {
      throw new IllegalArgumentException("granted_scope does not cover expected_scope.");
    }

    Map<String, Object> envelope = requireMap(input.exportEnvelope(), "export_envelope");
    Map<String, Object> aad = requireMap(envelope.get("aad"), "export_envelope.aad");
    validateEnvelope(envelope, aad, expected, nowMs);

    byte[] ciphertext = decodeBase64(input.ciphertext(), "ciphertext");
    byte[] payloadIv = decodeBase64(input.payloadIv(), "payload_iv");
    byte[] payloadTag = decodeBase64(input.payloadTag(), "payload_tag");
    byte[] wrappedExportKey = decodeBase64(input.wrappedExportKey(), "wrapped_export_key");
    byte[] wrappedKeyIv = decodeBase64(input.wrappedKeyIv(), "wrapped_key_iv");
    byte[] wrappedKeyTag = decodeBase64(input.wrappedKeyTag(), "wrapped_key_tag");
    byte[] senderPublicKey = decodeBase64(input.senderPublicKey(), "sender_public_key");

    requireLength(payloadIv, GCM_IV_BYTES, "payload_iv");
    requireLength(payloadTag, GCM_TAG_BYTES, "payload_tag");
    requireLength(wrappedExportKey, AES_256_KEY_BYTES, "wrapped_export_key");
    requireLength(wrappedKeyIv, GCM_IV_BYTES, "wrapped_key_iv");
    requireLength(wrappedKeyTag, GCM_TAG_BYTES, "wrapped_key_tag");
    requireLength(senderPublicKey, X25519_KEY_BYTES, "sender_public_key");
    requireLong(envelope, "ciphertext_bytes", ciphertext.length);
    requireEquals(
        requireString(envelope, "ciphertext_sha256"),
        sha256Label(ciphertext),
        "ciphertext_sha256");

    byte[] sharedSecret = null;
    byte[] wrappingKey = null;
    byte[] exportKey = null;
    try {
      KeyAgreement agreement = KeyAgreement.getInstance("X25519");
      agreement.init(connectorPrivateKey);
      agreement.doPhase(rawX25519PublicKey(senderPublicKey), true);
      sharedSecret = agreement.generateSecret();
      int nonZero = 0;
      for (byte value : sharedSecret) {
        nonZero |= value;
      }
      if (nonZero == 0) {
        throw new IllegalArgumentException("Rejected all-zero X25519 shared secret.");
      }
      wrappingKey = MessageDigest.getInstance("SHA-256").digest(sharedSecret);

      exportKey =
          decryptAesGcm(
              wrappingKey,
              wrappedKeyIv,
              concat(wrappedExportKey, wrappedKeyTag),
              canonicalJsonBytes(envelope));
      requireLength(exportKey, AES_256_KEY_BYTES, "unwrapped_export_key");

      return decryptAesGcm(
          exportKey, payloadIv, concat(ciphertext, payloadTag), canonicalJsonBytes(aad));
    } finally {
      wipe(sharedSecret);
      wipe(wrappingKey);
      wipe(exportKey);
    }
  }

  /**
   * Convenience loader for local interoperability tests only.
   *
   * <p>Production code should obtain a non-exportable PrivateKey from its configured JCA provider.
   */
  public static PrivateKey x25519PrivateKeyFromPkcs8(byte[] pkcs8) throws Exception {
    return KeyFactory.getInstance("X25519").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
  }

  public static byte[] canonicalJsonBytes(Object value) {
    return canonicalJson(value).getBytes(StandardCharsets.UTF_8);
  }

  private static void validateEnvelope(
      Map<String, Object> envelope,
      Map<String, Object> aad,
      ExpectedContext expected,
      long nowMs)
      throws Exception {
    requireLong(envelope, "version", 2);
    requireLong(aad, "version", 2);
    requireEquals(
        requireString(envelope, "export_id"), requireString(aad, "export_id"), "export_id");
    requireEquals(expected.appId(), requireString(aad, "app_id"), "app_id");
    requireEquals(expected.grantId(), requireString(aad, "grant_id"), "grant_id");
    requireLong(aad, "revision", expected.revision());
    requireEquals(expected.envelopeScope(), requireString(aad, "machine_scope"), "machine_scope");
    requireEquals(expected.scopeHandle(), requireString(aad, "scope_handle"), "scope_handle");
    requireEquals(
        expected.recipientKeyFingerprint(),
        requireString(aad, "recipient_key_fingerprint"),
        "recipient_key_fingerprint");
    requireEquals(
        PAYLOAD_ALGORITHM, requireString(aad, "payload_algorithm"), "payload_algorithm");
    requireLong(aad, "expires_at_ms", expected.expiresAtMs());
    if (expected.expiresAtMs() <= nowMs) {
      throw new IllegalArgumentException("The consent export has expired.");
    }
    requireEquals(
        requireString(envelope, "aad_sha256"),
        sha256Label(canonicalJsonBytes(aad)),
        "aad_sha256");
  }

  private static PublicKey rawX25519PublicKey(byte[] littleEndianU) throws Exception {
    byte[] bigEndianU = littleEndianU.clone();
    reverse(bigEndianU);
    BigInteger coordinate = new BigInteger(1, bigEndianU);
    return KeyFactory.getInstance("X25519")
        .generatePublic(new XECPublicKeySpec(NamedParameterSpec.X25519, coordinate));
  }

  private static byte[] decryptAesGcm(byte[] key, byte[] iv, byte[] combined, byte[] aad)
      throws Exception {
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(
        Cipher.DECRYPT_MODE,
        new SecretKeySpec(key, "AES"),
        new GCMParameterSpec(GCM_TAG_BYTES * 8, iv));
    cipher.updateAAD(aad);
    return cipher.doFinal(combined);
  }

  private static String canonicalJson(Object value) {
    if (value == null) {
      return "null";
    }
    if (value instanceof String string) {
      return quoteJson(string);
    }
    if (value instanceof Boolean bool) {
      return bool.toString();
    }
    if (value instanceof Byte
        || value instanceof Short
        || value instanceof Integer
        || value instanceof Long
        || value instanceof BigInteger) {
      return value.toString();
    }
    if (value instanceof Map<?, ?> map) {
      List<Map.Entry<String, Object>> entries = new ArrayList<>();
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!(entry.getKey() instanceof String key)) {
          throw new IllegalArgumentException("Canonical JSON object keys must be strings.");
        }
        entries.add(Map.entry(key, entry.getValue()));
      }
      entries.sort(Comparator.comparing(Map.Entry::getKey));
      StringBuilder output = new StringBuilder("{");
      for (int index = 0; index < entries.size(); index++) {
        if (index > 0) {
          output.append(',');
        }
        Map.Entry<String, Object> entry = entries.get(index);
        output.append(quoteJson(entry.getKey())).append(':').append(canonicalJson(entry.getValue()));
      }
      return output.append('}').toString();
    }
    if (value instanceof List<?> list) {
      StringBuilder output = new StringBuilder("[");
      for (int index = 0; index < list.size(); index++) {
        if (index > 0) {
          output.append(',');
        }
        output.append(canonicalJson(list.get(index)));
      }
      return output.append(']').toString();
    }
    throw new IllegalArgumentException(
        "Unsupported canonical JSON value type: " + value.getClass().getName());
  }

  private static String quoteJson(String value) {
    StringBuilder output = new StringBuilder(value.length() + 2).append('"');
    for (int index = 0; index < value.length(); index++) {
      char character = value.charAt(index);
      switch (character) {
        case '"' -> output.append("\\\"");
        case '\\' -> output.append("\\\\");
        case '\b' -> output.append("\\b");
        case '\f' -> output.append("\\f");
        case '\n' -> output.append("\\n");
        case '\r' -> output.append("\\r");
        case '\t' -> output.append("\\t");
        default -> {
          if (character < 0x20) {
            output.append(String.format("\\u%04x", (int) character));
          } else {
            output.append(character);
          }
        }
      }
    }
    return output.append('"').toString();
  }

  private static byte[] decodeBase64(String encoded, String field) {
    if (encoded == null || encoded.isBlank() || !encoded.equals(encoded.trim())) {
      throw new IllegalArgumentException(field + " must be non-empty canonical base64.");
    }
    try {
      return Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException error) {
      throw new IllegalArgumentException(field + " is not valid base64.", error);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> requireMap(Object value, String field) {
    if (!(value instanceof Map<?, ?> map)) {
      throw new IllegalArgumentException(field + " must be an object.");
    }
    return (Map<String, Object>) map;
  }

  private static String requireString(Map<String, Object> map, String field) {
    Object value = map.get(field);
    if (!(value instanceof String string) || string.isBlank()) {
      throw new IllegalArgumentException(field + " must be a non-empty string.");
    }
    return string;
  }

  private static void requireLong(Map<String, Object> map, String field, long expected) {
    Object value = map.get(field);
    if (!(value instanceof Number number) || number.longValue() != expected) {
      throw new IllegalArgumentException(field + " does not match the expected context.");
    }
  }

  private static void requireEquals(Object expected, Object actual, String field) {
    if (!Objects.equals(expected, actual)) {
      throw new IllegalArgumentException(field + " does not match the expected context.");
    }
  }

  private static void requireLength(byte[] value, int expected, String field) {
    if (value.length != expected) {
      throw new IllegalArgumentException(field + " must be exactly " + expected + " bytes.");
    }
  }

  private static void requireLongValue(long expected, long actual, String field) {
    if (expected != actual) {
      throw new IllegalArgumentException(field + " does not match the expected context.");
    }
  }

  private static boolean scopeCovers(String grantedScope, String expectedScope) {
    if (Objects.equals(grantedScope, expectedScope)) {
      return true;
    }
    if (grantedScope == null || expectedScope == null || !grantedScope.endsWith(".*")) {
      return false;
    }
    return expectedScope.startsWith(grantedScope.substring(0, grantedScope.length() - 1));
  }

  private static String sha256Label(byte[] value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
    try {
      return "sha256:" + java.util.HexFormat.of().formatHex(digest);
    } finally {
      wipe(digest);
    }
  }

  private static byte[] concat(byte[] left, byte[] right) {
    byte[] combined = Arrays.copyOf(left, left.length + right.length);
    System.arraycopy(right, 0, combined, left.length, right.length);
    return combined;
  }

  private static void reverse(byte[] value) {
    for (int left = 0, right = value.length - 1; left < right; left++, right--) {
      byte current = value[left];
      value[left] = value[right];
      value[right] = current;
    }
  }

  private static void wipe(byte[] value) {
    if (value != null) {
      Arrays.fill(value, (byte) 0);
    }
  }
}
