# Java 17/JCA consent-export decryptor

This dependency-free reference implements the current Hussh consent export
envelope v2 with Java 17 cryptography:

1. X25519 key agreement using the connector private key and
   `sender_public_key`.
2. SHA-256 of the shared secret as the AES-256 wrapping key.
3. AES-256-GCM unwrap of `wrapped_export_key`, authenticated with canonical
   `export_envelope_json`.
4. AES-256-GCM decrypt of `ciphertext`, authenticated with canonical
   `export_envelope_json.aad`.

It intentionally does not change the MCP schema or introduce another
cryptographic profile. It accepts the flat fields returned by
`get-encrypted-scoped-export`.

## Run the interoperability vector

```bash
cd consent-protocol/examples/java17-jca-export-decryptor
mkdir -p build
javac --release 17 -d build \
  src/main/java/ai/hussh/consent/ConsentExportDecryptor.java \
  src/test/java/ai/hussh/consent/ConsentExportDecryptorSelfTest.java
java -cp build ai.hussh.consent.ConsentExportDecryptorSelfTest
```

The fixed vector was generated with the repository's Python
`cryptography` implementation and includes nested brokerage information and a
holdings array. The self-test proves successful Java decryption and
fail-closed rejection of a tampered payload tag.

## Connector integration boundary

- Parse the MCP `structuredContent` object, or its `content[0].text` JSON
  mirror, with the connector's normal JSON parser.
- Parse `export_envelope_json` as a map and construct `FlatExportPackage`.
- Build `ExpectedContext` from the authenticated request/grant lifecycle, not
  by trusting the encrypted-export response.
- Pass a non-exportable `PrivateKey` supplied by the approved JCA/KMS/HSM
  provider. `x25519PrivateKeyFromPkcs8` exists only for local interoperability
  testing.
- Process the returned UTF-8 bytes inside trusted connector code and keep them
  outside Agentforce, prompts, logs, traces, SObjects used as transport, and
  support artifacts.

This sample validates the algorithm, connector key ID, envelope version,
request/grant context, scope, revision, expiry, recipient fingerprint, AAD
digest, ciphertext digest, byte length, and exact X25519/AES-GCM field sizes
before returning information.
