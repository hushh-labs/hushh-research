"""Sealed frames between a pod and its owner's Puppy device.

Once the device dials the pod directly, the hub is out of the path and the pod is
reachable over public ingress. TLS still protects the socket, but TLS terminates at
the platform edge and says nothing about WHICH owner, device, session, incarnation
and position in the stream a frame belongs to. The envelope binds all of that:

* **Key.** X25519 between the pod's identity key (the durable keypair the registry
  row already carries) and a fresh ephemeral public key the device sends in its
  hello, through HKDF-SHA256 with this module's own label. One connection, one key;
  a device that reconnects gets a new one. Both sides derive it; nobody transmits it.
* **AAD.** ``{v, hushhId, deviceId, sessionId, epoch, seq, dir, innerType}`` in the
  canonical JSON form ``export_envelope.canonical_aad_bytes`` uses (sorted keys,
  compact separators, UTF-8), so a frame lifted from one session, one device, one
  incarnation or one direction fails authentication rather than decrypting.
* **Nonce.** ``dir || 0x000000 || seq`` (12 bytes). Deterministic, never reused:
  each direction has its own counter and each counter is strictly increasing.
  Re-using a sequence number is a protocol error the receiver refuses, which is
  also what makes replay detectable without any state beyond one integer.

The device side implements the same bytes; see
``docs/future/personal-agent/PUPPY-DEVICE-BINDING-SPEC-2026-09-10.md``.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Mapping

ENVELOPE_VERSION = 1
SEALED_FRAME_TYPE = "sealed"
DIR_POD_TO_DEVICE = "p2d"
DIR_DEVICE_TO_POD = "d2p"
_DIR_BYTE = {DIR_POD_TO_DEVICE: 0x00, DIR_DEVICE_TO_POD: 0x01}

_KEY_INFO = b"hussh/puppy-envelope/aes256gcm/v1"
_KEY_LEN = 32
_NONCE_LEN = 12
_AAD_KEYS = frozenset({"v", "hushhId", "deviceId", "sessionId", "epoch", "seq", "dir", "innerType"})
_MAX_INNER_BYTES = 1_048_576


class PuppyEnvelopeError(ValueError):
    """A frame could not be sealed or did not authenticate."""


def derive_frame_key(pod_private_key: Any, device_ephemeral_public_b64: str) -> bytes:
    """Pod side: ECDH with the device's ephemeral key, then HKDF under our label."""
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    try:
        raw = base64.b64decode(str(device_ephemeral_public_b64 or ""), validate=True)
    except (ValueError, TypeError) as exc:
        raise PuppyEnvelopeError("the device ephemeral key is not valid base64") from exc
    if len(raw) != 32:
        raise PuppyEnvelopeError("the device ephemeral key is not 32 raw X25519 bytes")
    shared = pod_private_key.exchange(X25519PublicKey.from_public_bytes(raw))
    return HKDF(algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_KEY_INFO).derive(
        shared
    )


def derive_frame_key_device_side(device_ephemeral_private_key: Any, pod_public_b64: str) -> bytes:
    """The device's half, kept here so the two derivations are tested against each other."""
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    raw = base64.b64decode(str(pod_public_b64 or ""), validate=True)
    if len(raw) != 32:
        raise PuppyEnvelopeError("the pod public key is not 32 raw X25519 bytes")
    shared = device_ephemeral_private_key.exchange(X25519PublicKey.from_public_bytes(raw))
    return HKDF(algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_KEY_INFO).derive(
        shared
    )


def canonical_aad_bytes(aad: Mapping[str, Any]) -> bytes:
    """Deterministic AAD bytes. Exactly the eight keys, nothing else, sorted, compact."""
    if set(aad) != _AAD_KEYS:
        raise PuppyEnvelopeError("envelope AAD must carry exactly the eight binding fields")
    if aad["v"] != ENVELOPE_VERSION or aad["dir"] not in _DIR_BYTE:
        raise PuppyEnvelopeError("envelope AAD version or direction is not recognised")
    for name in ("epoch", "seq"):
        if isinstance(aad[name], bool) or not isinstance(aad[name], int) or aad[name] < 1:
            raise PuppyEnvelopeError(f"envelope AAD {name} is a positive integer")
    for name in ("hushhId", "deviceId", "sessionId", "innerType"):
        if not isinstance(aad[name], str) or not aad[name]:
            raise PuppyEnvelopeError(f"envelope AAD {name} is a non-empty string")
    return json.dumps(dict(aad), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def frame_nonce(direction: str, seq: int) -> bytes:
    if direction not in _DIR_BYTE:
        raise PuppyEnvelopeError("unknown envelope direction")
    if isinstance(seq, bool) or not isinstance(seq, int) or not 1 <= seq < 2**63:
        raise PuppyEnvelopeError("envelope sequence out of range")
    return bytes([_DIR_BYTE[direction], 0, 0, 0]) + seq.to_bytes(8, "big")


class PuppyEnvelope:
    """Seal and open frames for one connection between one pod and one device."""

    def __init__(
        self, key: bytes, *, hushh_id: str, device_id: str, session_id: str, epoch: int
    ) -> None:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

        if len(key) != _KEY_LEN:
            raise PuppyEnvelopeError("the frame key must be exactly 32 bytes")
        self._aead = AESGCM(key)
        self._hushh_id = str(hushh_id or "")
        self._device_id = str(device_id or "")
        self._session_id = str(session_id or "")
        self._epoch = int(epoch)

    def aad(self, *, direction: str, seq: int, inner_type: str) -> dict[str, Any]:
        return {
            "v": ENVELOPE_VERSION,
            "hushhId": self._hushh_id,
            "deviceId": self._device_id,
            "sessionId": self._session_id,
            "epoch": self._epoch,
            "seq": seq,
            "dir": direction,
            "innerType": inner_type,
        }

    def seal(self, frame: Mapping[str, Any], *, direction: str, seq: int) -> dict[str, Any]:
        inner_type = str(frame.get("type") or "")
        if not inner_type:
            raise PuppyEnvelopeError("an inner frame carries a type")
        plaintext = json.dumps(dict(frame), separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        )
        if len(plaintext) > _MAX_INNER_BYTES:
            raise PuppyEnvelopeError("inner frame too large")
        aad = canonical_aad_bytes(self.aad(direction=direction, seq=seq, inner_type=inner_type))
        ciphertext = self._aead.encrypt(frame_nonce(direction, seq), plaintext, aad)
        return {
            "type": SEALED_FRAME_TYPE,
            "v": ENVELOPE_VERSION,
            "dir": direction,
            "seq": seq,
            "innerType": inner_type,
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        }

    def open(
        self, sealed: Mapping[str, Any], *, expected_direction: str, expected_seq: int
    ) -> dict[str, Any]:
        """Authenticate and decrypt one frame at exactly the position we expect."""
        if str(sealed.get("type") or "") != SEALED_FRAME_TYPE:
            raise PuppyEnvelopeError("not a sealed frame")
        if sealed.get("v") != ENVELOPE_VERSION:
            raise PuppyEnvelopeError("unsupported envelope version")
        if sealed.get("dir") != expected_direction:
            raise PuppyEnvelopeError("envelope direction mismatch")
        seq = sealed.get("seq")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq != expected_seq:
            raise PuppyEnvelopeError("envelope sequence mismatch")
        inner_type = str(sealed.get("innerType") or "")
        try:
            ciphertext = base64.b64decode(str(sealed.get("ciphertext") or ""), validate=True)
        except (ValueError, TypeError) as exc:
            raise PuppyEnvelopeError("envelope ciphertext is not valid base64") from exc
        if len(ciphertext) > _MAX_INNER_BYTES + 64:
            raise PuppyEnvelopeError("envelope too large")
        aad = canonical_aad_bytes(
            self.aad(direction=expected_direction, seq=seq, inner_type=inner_type)
        )
        try:
            plaintext = self._aead.decrypt(frame_nonce(expected_direction, seq), ciphertext, aad)
            inner = json.loads(plaintext)
        except Exception as exc:  # noqa: BLE001 - one answer for every failure
            raise PuppyEnvelopeError("the frame did not authenticate") from exc
        if not isinstance(inner, dict) or str(inner.get("type") or "") != inner_type:
            raise PuppyEnvelopeError("the inner frame does not match its declared type")
        return inner


__all__ = [
    "DIR_DEVICE_TO_POD",
    "DIR_POD_TO_DEVICE",
    "ENVELOPE_VERSION",
    "SEALED_FRAME_TYPE",
    "PuppyEnvelope",
    "PuppyEnvelopeError",
    "canonical_aad_bytes",
    "derive_frame_key",
    "derive_frame_key_device_side",
    "frame_nonce",
]
