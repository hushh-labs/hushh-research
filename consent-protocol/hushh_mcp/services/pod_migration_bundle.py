"""The sealed envelope that carries one agent's memory between two clouds.

WHY THIS SHAPE, AND WHY hushh CANNOT DO THE WORK
------------------------------------------------
Moving a private agent means moving its commit log. The log is sealed under a key
that only its pod holds -- on BYOC a pod-minted DEK wrapped in the person's own
KMS, on the hosted tier the same envelope in hussh's keyring with the hub holding
``cloudkms.admin`` and provably not encrypt or decrypt. So there is no server-side
step that could read the source log and re-seal it for the destination: the one
process able to decrypt is the source pod, and the one able to encrypt for the
destination is the destination pod.

That constraint is not an obstacle to work around. It is the property being
preserved, and this module is what makes it survive a migration:

    source pod  --(plaintext records, sealed to the target's public key)-->  hub
    hub         --(the same ciphertext, unopened)-->  target pod
    target pod  --(unwraps, verifies, re-seals under its OWN key)-->  its log

Every byte the hub touches is ciphertext under a key the hub does not have. The
honesty clause -- "hussh does not read this pod, and here is the migration path to
where it structurally cannot" -- is engineered here rather than asserted.

THE ZERO-LOSS ORACLE
--------------------
``PodCommitLog``'s chain hash is computed over PLAINTEXT-KEYED fields only::

    sha = sha256({seq, kind, payload, prev_sha})

Not over the ciphertext, not over the nonce, not over the object key. So a log
rebuilt by appending the same ``(kind, payload)`` values in the same order, into
an empty log, produces byte-identical hashes at every seq under a completely
different seal key. Comparing the two head SHAs is therefore a cryptographic
statement that every record arrived intact and in order -- not a sample, not a
count, not a spot check.

That is why the import does not need (and deliberately does not have) a way to
write a chosen ``sha``: it replays through the ordinary ``append`` path, and the
hashes come out equal because the inputs were equal. An import that could stamp a
sha it was handed would be able to make a broken chain look whole, which is the
one thing this verification must not permit.

WHAT A BUNDLE CONTAINS, AND WHAT IT MUST NEVER
----------------------------------------------
Contains: the log records' ``{seq, kind, payload}`` triples, in order, and the
source's head SHA and count so the destination can check its own work.

Never contains: the source's seal key, its DEK, its wrapped-key blob, or any
material the destination could use to read the SOURCE's storage afterwards. The
destination is given this agent's history, not the ability to impersonate the pod
that held it.
"""

from __future__ import annotations

import base64
import json
import secrets
from dataclasses import dataclass
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

#: The wrapping this bundle uses, and the one the registry already records for
#: every pod public key (`pod_connector_keypair_service.WRAPPING_ALG`). Stated in
#: the bundle so a future scheme change is a refusal rather than a misparse.
BUNDLE_ALG = "X25519-AES256-GCM"
BUNDLE_VERSION = "hussh.pod.migration.bundle.v1"

_NONCE_LEN = 12
_KEY_LEN = 32
#: Binds the derived key to this exact purpose. A key agreed for one purpose must
#: never be usable for another, and the info string is what enforces that.
_HKDF_INFO = b"hussh.pod.migration.bundle.v1"


class PodMigrationBundleError(RuntimeError):
    """A bundle could not be built, opened, or trusted."""


@dataclass(frozen=True)
class BundleReceipt:
    """What the source proved about what it exported.

    Carried alongside the ciphertext so the hub can record it WITHOUT being able
    to read the bundle: a head sha and a count are coordinates, not content.
    """

    head_sha: str
    record_count: int
    recipient_key_id: str


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _derive(shared_secret: bytes, ephemeral_public: bytes, recipient_public: bytes) -> bytes:
    """One-shot HKDF over the agreed secret AND both public halves.

    Binding both public keys into the salt is what stops a bundle sealed to one
    pod from being replayed at another that happens to hold the same ephemeral
    material: the derived key differs the moment the recipient differs.
    """
    return HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN,
        salt=ephemeral_public + recipient_public,
        info=_HKDF_INFO,
    ).derive(shared_secret)


def _public_bytes(key: X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def seal_bundle(
    *,
    records: list[dict[str, Any]],
    head_sha: str,
    recipient_public_key_b64: str,
    recipient_key_id: str,
    wrapping_alg: str = BUNDLE_ALG,
) -> tuple[dict[str, Any], BundleReceipt]:
    """Seal a replayed commit log for exactly one destination pod.

    Runs INSIDE the source pod -- it needs plaintext records, which only that pod
    can produce. The returned dict is safe for the hub to hold and ferry: it is
    ciphertext plus the recipient's own key id.

    ``records`` must be the output of ``PodCommitLog.replay()``, which is already
    chain-verified; this function does not re-verify it, because a bundle built
    from an unverified log is a problem to catch at the source, not here.
    """
    if str(wrapping_alg or "").strip() != BUNDLE_ALG:
        raise PodMigrationBundleError(f"unsupported wrapping alg: {wrapping_alg!r}")
    if not records:
        # An empty export is almost always a misconfiguration (wrong bucket,
        # wrong prefix, a pod that never wrote) rather than a genuinely blank
        # agent, and shipping it would REPLACE nothing with nothing while
        # reporting success. Refusing costs a person one retry; succeeding
        # quietly costs them their agent's memory.
        raise PodMigrationBundleError("refusing to seal an empty log")

    try:
        recipient_raw = base64.b64decode(recipient_public_key_b64, validate=True)
        recipient = X25519PublicKey.from_public_bytes(recipient_raw)
    except Exception as exc:
        raise PodMigrationBundleError("the recipient public key is not a valid X25519 key") from exc

    ephemeral = X25519PrivateKey.generate()
    shared = ephemeral.exchange(recipient)
    ephemeral_public = _public_bytes(ephemeral.public_key())
    key = _derive(shared, ephemeral_public, recipient_raw)

    payload = _canonical(
        {
            "records": [
                {"seq": int(r["seq"]), "kind": str(r["kind"]), "payload": r.get("payload")}
                for r in records
            ],
            "headSha": head_sha,
            "recordCount": len(records),
        }
    )
    nonce = secrets.token_bytes(_NONCE_LEN)
    # The recipient key id is authenticated additional data, so a bundle cannot
    # be re-labelled for a different pod without breaking the tag.
    aad = recipient_key_id.encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, payload, aad)

    envelope = {
        "version": BUNDLE_VERSION,
        "alg": BUNDLE_ALG,
        "recipientKeyId": recipient_key_id,
        "ephemeralPublicKey": base64.b64encode(ephemeral_public).decode("utf-8"),
        "nonce": base64.b64encode(nonce).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8"),
    }
    return envelope, BundleReceipt(
        head_sha=head_sha,
        record_count=len(records),
        recipient_key_id=recipient_key_id,
    )


def open_bundle(
    envelope: dict[str, Any],
    *,
    private_key: X25519PrivateKey,
    expected_key_id: str,
) -> tuple[list[dict[str, Any]], str, int]:
    """Open a bundle sealed to THIS pod. Returns (records, head_sha, count).

    Runs INSIDE the destination pod. ``expected_key_id`` is this pod's own key id
    and is checked before any decryption is attempted: a bundle addressed to a
    different pod is refused by name rather than failing later as an opaque tag
    error, because those two situations need different answers from an operator.
    """
    if str(envelope.get("version") or "") != BUNDLE_VERSION:
        raise PodMigrationBundleError(f"unknown bundle version: {envelope.get('version')!r}")
    if str(envelope.get("alg") or "") != BUNDLE_ALG:
        raise PodMigrationBundleError(f"unsupported bundle alg: {envelope.get('alg')!r}")

    addressed_to = str(envelope.get("recipientKeyId") or "")
    if addressed_to != expected_key_id:
        raise PodMigrationBundleError(
            f"this bundle is addressed to pod key {addressed_to!r}, not to {expected_key_id!r}"
        )

    try:
        ephemeral_public = base64.b64decode(envelope["ephemeralPublicKey"], validate=True)
        nonce = base64.b64decode(envelope["nonce"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
    except Exception as exc:
        raise PodMigrationBundleError("the bundle envelope is malformed") from exc

    recipient_raw = _public_bytes(private_key.public_key())
    shared = private_key.exchange(X25519PublicKey.from_public_bytes(ephemeral_public))
    key = _derive(shared, ephemeral_public, recipient_raw)

    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, expected_key_id.encode("utf-8"))
    except Exception as exc:
        # Authenticated decryption failing means the bundle was altered, truncated,
        # or is not ours. All three are refusals, and none of them may be recovered
        # from by ignoring records -- a partially-imported log is worse than none.
        raise PodMigrationBundleError(
            "the bundle failed authenticated decryption -- altered, truncated, or not ours"
        ) from exc

    body = json.loads(plaintext)
    records = list(body.get("records") or [])
    head_sha = str(body.get("headSha") or "")
    count = int(body.get("recordCount") or 0)
    if len(records) != count:
        raise PodMigrationBundleError(
            f"the bundle carries {len(records)} records but claims {count}"
        )
    if not records:
        raise PodMigrationBundleError("the bundle carries no records")
    # Contiguous and ordered from 1, the same invariant `replay` enforces. A
    # bundle that fails it could never rebuild an identical chain, so this is
    # caught here rather than after writing half a log.
    if [int(r.get("seq") or 0) for r in records] != list(range(1, len(records) + 1)):
        raise PodMigrationBundleError("the bundle's sequence numbers are not contiguous from 1")
    return records, head_sha, count


def verify_rebuilt_head(*, source_head_sha: str, target_head_sha: str) -> None:
    """The switch-over gate. Byte-equal heads or the migration does not happen.

    Raised rather than returned because a caller who ignores a boolean here
    switches a person onto a pod with a different history than the one they had,
    and no later step would notice.
    """
    if not source_head_sha or not target_head_sha:
        raise PodMigrationBundleError(
            "a head sha is missing, so nothing was proved -- refusing the switch"
        )
    if source_head_sha != target_head_sha:
        raise PodMigrationBundleError(
            "the rebuilt chain head does not match the source: "
            f"{target_head_sha[:12]}… != {source_head_sha[:12]}…"
        )


def head_sha_of(records: list[dict[str, Any]]) -> Optional[str]:
    """The last record's sha, which IS the chain head."""
    return str(records[-1].get("sha") or "") if records else None
