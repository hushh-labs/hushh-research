"""The range bundle: records after a standby's head, sealed to it and signed by the primary.

WHAT IT ADDS TO THE WHOLE-LOG BUNDLE
------------------------------------
``pod_migration_bundle.seal_bundle`` carries a whole log from sequence 1 into an
empty pod. A standby is never empty and never torn down, so sync carries only the
records after the standby's head ``(base_seq, base_head_sha)``, and the first of
them must chain to that head. The whole-log bundle is unchanged.

THREE PROPERTIES, EACH WITH ITS OWN MECHANISM
---------------------------------------------
* **Secrecy** -- ECIES to the standby's X25519 key, exactly as the whole-log bundle,
  but under its own HKDF info (``hussh.pod.sync.range.v1``). The AAD binds the
  version, the recipient key id, the base and the head (E6). A whole-log bundle
  presented as a range, or the reverse, derives a different key and fails at
  authenticated decryption, not at a label check.
* **Origin** -- the primary signs ``(recipient, base, head, ciphertext digest)`` with
  its Ed25519 pod signing key (E5). Sealing to the standby proves nothing about who
  sealed: without the signature the hub, which knows the standby's public key, could
  mint chain-valid records. The standby verifies against the key id pinned in its
  role object, BEFORE it decrypts anything.
* **Continuity** -- the plaintext's records are re-hashed from ``base_head_sha`` with
  the commit log's own chain function, and must arrive at the signed ``head_sha``.
  The caller then checks the standby's OWN head against that chain before any append.

The hub ferries the envelope. It holds no key for either side.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# The chain function is the commit log's own, deliberately: a second definition
# could agree with it today and drift tomorrow, and equal heads would stop meaning
# what they mean.
from hushh_mcp.services.pod_commit_log import _record_sha
from hushh_mcp.services.pod_migration_bundle import BUNDLE_ALG, PodMigrationBundleError
from hushh_mcp.services.pod_request_signing import (
    is_signing_key_id,
    is_signing_public_key,
    public_key_b64,
    signing_key_id,
)

RANGE_VERSION = "hussh.pod.sync.range.v1"
SIGNATURE_ALG = "ed25519"

_HKDF_INFO = b"hussh.pod.sync.range.v1"
_SIGNATURE_PURPOSE = "hussh.pod.sync.range.signature.v1"
_NONCE_LEN = 12
_KEY_LEN = 32
_SHA_HEX_LEN = 64


class PodSyncBundleError(PodMigrationBundleError):
    """A range bundle could not be built, opened, or trusted."""


@dataclass(frozen=True)
class RangeContents:
    """A verified range: signed by the pinned primary and internally chain-continuous.

    ``chain`` maps every sequence in ``[base_seq, head_seq]`` to the head sha the log
    has at that sequence; ``chain[base_seq] == base_head_sha``. The importer uses it
    to place its own head on this chain before writing anything.
    """

    base_seq: int
    base_head_sha: str
    head_seq: int
    head_sha: str
    records: tuple[dict[str, Any], ...]
    chain: dict[int, str]


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _unb64(value: Any) -> bytes:
    if not isinstance(value, str):
        raise PodSyncBundleError("the range envelope is malformed")
    try:
        return base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise PodSyncBundleError("the range envelope is malformed") from exc


def _raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def _derive(shared: bytes, ephemeral_public: bytes, recipient_public: bytes) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_LEN,
        salt=ephemeral_public + recipient_public,
        info=_HKDF_INFO,
    ).derive(shared)


def _check_coordinates(base_seq: Any, base_head_sha: Any, head_seq: Any, head_sha: Any) -> None:
    """Shape of a base and a head. Base 0 is the empty log, whose sha is ``""``."""
    if type(base_seq) is not int or type(head_seq) is not int or base_seq < 0:
        raise PodSyncBundleError("range sequences must be non-negative integers")
    if head_seq <= base_seq:
        raise PodSyncBundleError("a range must end after its base")
    if not is_chain_sha(head_sha):
        raise PodSyncBundleError("the range head sha is malformed")
    if base_seq == 0 and base_head_sha != "":
        raise PodSyncBundleError("the empty log has no head sha")
    if base_seq > 0 and not is_chain_sha(base_head_sha):
        raise PodSyncBundleError("the range base sha is malformed")


def is_chain_sha(value: Any) -> bool:
    """A lower-case hex SHA-256, as the commit log writes it."""
    return (
        isinstance(value, str)
        and len(value) == _SHA_HEX_LEN
        and all(character in "0123456789abcdef" for character in value)
    )


def chain_from(base_seq: int, base_head_sha: str, records: list[dict[str, Any]]) -> dict[int, str]:
    """Re-hash ``records`` from the base; returns seq -> head sha. Raises on a gap."""
    chain = {base_seq: base_head_sha}
    prev: Optional[str] = base_head_sha or None
    for offset, record in enumerate(records, start=1):
        seq = record.get("seq")
        kind = record.get("kind")
        if type(seq) is not int or seq != base_seq + offset or not isinstance(kind, str):
            raise PodSyncBundleError("the range's records are not contiguous after its base")
        prev = _record_sha(seq, kind, record.get("payload"), prev)
        chain[seq] = prev
    return chain


def _aad(
    recipient_key_id: str, base_seq: int, base_head_sha: str, head_seq: int, head_sha: str
) -> bytes:
    return _canonical(
        {
            "version": RANGE_VERSION,
            "recipientKeyId": recipient_key_id,
            "baseSeq": base_seq,
            "baseHeadSha": base_head_sha,
            "headSeq": head_seq,
            "headSha": head_sha,
        }
    )


def _signed_statement(envelope: dict[str, Any]) -> bytes:
    """What the primary signs: who it is for, base, head, and the ciphertext digest."""
    digest = hashlib.sha256(
        _unb64(envelope.get("ephemeralPublicKey"))
        + _unb64(envelope.get("nonce"))
        + _unb64(envelope.get("ciphertext"))
    ).hexdigest()
    return _canonical(
        {
            "purpose": _SIGNATURE_PURPOSE,
            "version": envelope.get("version"),
            "recipientKeyId": envelope.get("recipientKeyId"),
            "baseSeq": envelope.get("baseSeq"),
            "baseHeadSha": envelope.get("baseHeadSha"),
            "headSeq": envelope.get("headSeq"),
            "headSha": envelope.get("headSha"),
            "ciphertextSha256": digest,
        }
    )


def seal_range_bundle(
    *,
    records: list[dict[str, Any]],
    base_seq: int,
    base_head_sha: str,
    recipient_public_key_b64: str,
    recipient_key_id: str,
    signing_key: Ed25519PrivateKey,
) -> dict[str, Any]:
    """Seal the records after ``base_seq`` for one standby, signed by this primary.

    Runs INSIDE the primary. ``records`` are chain-verified replay output for
    sequences ``base_seq + 1 .. head``; they are re-hashed from the base here, so a
    caller that sliced the wrong window is refused rather than shipped.
    """
    if not records:
        raise PodSyncBundleError("refusing to seal an empty range")
    if not str(recipient_key_id or "").strip():
        raise PodSyncBundleError("a range is addressed to a recipient key id")
    chain = chain_from(base_seq, base_head_sha, records)
    head_seq = base_seq + len(records)
    head_sha = chain[head_seq]
    _check_coordinates(base_seq, base_head_sha, head_seq, head_sha)
    if any(record.get("sha") not in (None, chain[record["seq"]]) for record in records):
        raise PodSyncBundleError("the range does not chain from its base")
    try:
        recipient_raw = base64.b64decode(recipient_public_key_b64, validate=True)
        recipient = X25519PublicKey.from_public_bytes(recipient_raw)
    except Exception as exc:
        raise PodSyncBundleError("the recipient public key is not a valid X25519 key") from exc

    ephemeral = X25519PrivateKey.generate()
    ephemeral_public = _raw_public(ephemeral.public_key())
    key = _derive(ephemeral.exchange(recipient), ephemeral_public, recipient_raw)
    plaintext = _canonical(
        {
            "records": [
                {"seq": r["seq"], "kind": r["kind"], "payload": r.get("payload")} for r in records
            ],
            "baseSeq": base_seq,
            "baseHeadSha": base_head_sha,
            "headSeq": head_seq,
            "headSha": head_sha,
        }
    )
    nonce = secrets.token_bytes(_NONCE_LEN)
    aad = _aad(recipient_key_id, base_seq, base_head_sha, head_seq, head_sha)
    signer_public = public_key_b64(signing_key)
    envelope: dict[str, Any] = {
        "version": RANGE_VERSION,
        "alg": BUNDLE_ALG,
        "recipientKeyId": recipient_key_id,
        "baseSeq": base_seq,
        "baseHeadSha": base_head_sha,
        "headSeq": head_seq,
        "headSha": head_sha,
        "ephemeralPublicKey": _b64(ephemeral_public),
        "nonce": _b64(nonce),
        "ciphertext": _b64(AESGCM(key).encrypt(nonce, plaintext, aad)),
        "signer": {
            "alg": SIGNATURE_ALG,
            "keyId": signing_key_id(signer_public),
            "publicKey": signer_public,
        },
    }
    envelope["signature"] = _b64(signing_key.sign(_signed_statement(envelope)))
    return envelope


def _verify_origin(envelope: dict[str, Any], pinned_signing_key_id: str) -> None:
    """The signer must be the pinned primary, and the signature must hold."""
    signer = envelope.get("signer")
    if not isinstance(signer, dict) or signer.get("alg") != SIGNATURE_ALG:
        raise PodSyncBundleError("the range is not signed")
    public = signer.get("publicKey")
    if not is_signing_key_id(pinned_signing_key_id):
        raise PodSyncBundleError("no primary signing key is pinned on this standby")
    if not is_signing_public_key(public) or signing_key_id(public) != pinned_signing_key_id:
        raise PodSyncBundleError("the range was not signed by this standby's pinned primary")
    if signer.get("keyId") != pinned_signing_key_id:
        raise PodSyncBundleError("the range signer key id does not match its public key")
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public, validate=True)).verify(
            _unb64(envelope.get("signature")), _signed_statement(envelope)
        )
    except InvalidSignature as exc:
        raise PodSyncBundleError("the range signature does not verify") from exc


def _decrypt(envelope: dict[str, Any], private_key: X25519PrivateKey, key_id: str) -> bytes:
    ephemeral_public = _unb64(envelope.get("ephemeralPublicKey"))
    try:
        shared = private_key.exchange(X25519PublicKey.from_public_bytes(ephemeral_public))
    except ValueError as exc:
        raise PodSyncBundleError("the range envelope is malformed") from exc
    key = _derive(shared, ephemeral_public, _raw_public(private_key.public_key()))
    aad = _aad(
        key_id,
        envelope["baseSeq"],
        envelope["baseHeadSha"],
        envelope["headSeq"],
        envelope["headSha"],
    )
    try:
        return AESGCM(key).decrypt(
            _unb64(envelope.get("nonce")), _unb64(envelope.get("ciphertext")), aad
        )
    except Exception as exc:
        raise PodSyncBundleError(
            "the range failed authenticated decryption -- altered, truncated, or not ours"
        ) from exc


def open_range_bundle(
    envelope: dict[str, Any],
    *,
    private_key: X25519PrivateKey,
    expected_key_id: str,
    pinned_signing_key_id: str,
) -> RangeContents:
    """Verify origin, then decrypt, then re-hash. Runs INSIDE the standby.

    Order matters: the recipient and the signature are checked before any key
    agreement, so an envelope from anyone but the pinned primary is refused without
    the standby ever decrypting attacker-chosen bytes.
    """
    if not isinstance(envelope, dict) or envelope.get("version") != RANGE_VERSION:
        raise PodSyncBundleError("unknown range bundle version")
    if envelope.get("alg") != BUNDLE_ALG:
        raise PodSyncBundleError("unsupported range bundle alg")
    if envelope.get("recipientKeyId") != expected_key_id:
        raise PodSyncBundleError("this range is addressed to a different pod key")
    coordinates = tuple(
        envelope.get(field) for field in ("baseSeq", "baseHeadSha", "headSeq", "headSha")
    )
    _check_coordinates(*coordinates)
    _verify_origin(envelope, pinned_signing_key_id)
    try:
        body = json.loads(_decrypt(envelope, private_key, expected_key_id))
    except ValueError as exc:
        raise PodSyncBundleError("the range plaintext is malformed") from exc
    if (
        not isinstance(body, dict)
        or tuple(body.get(field) for field in ("baseSeq", "baseHeadSha", "headSeq", "headSha"))
        != coordinates
    ):
        raise PodSyncBundleError("the range plaintext disagrees with its signed coordinates")
    records = body.get("records")
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        raise PodSyncBundleError("the range carries no records")
    base_seq, base_head_sha, head_seq, head_sha = coordinates
    chain = chain_from(base_seq, base_head_sha, records)
    if base_seq + len(records) != head_seq or chain[head_seq] != head_sha:
        raise PodSyncBundleError("the range does not chain from its base to its head")
    return RangeContents(
        base_seq=base_seq,
        base_head_sha=base_head_sha,
        head_seq=head_seq,
        head_sha=head_sha,
        records=tuple(records),
        chain=chain,
    )


__all__ = [
    "RANGE_VERSION",
    "PodSyncBundleError",
    "RangeContents",
    "chain_from",
    "is_chain_sha",
    "open_range_bundle",
    "seal_range_bundle",
]
