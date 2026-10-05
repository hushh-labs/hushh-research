"""The sealed "Bring your own AI" envelope, from the owner's device to their own agent.

The person picks a provider, a model and an API key in their Vault on the device. The
device seals that choice to THIS pod's X25519 public key (the ``pod_public_key`` in the
hub-signed binding the device already holds), so the hub that carries the request can
read none of it. Only the pod's private half, which never leaves the pod process
(``pod_self_registration``), can open it.

Contract C1, version 1::

    {"v": 1, "alg": "X25519-HKDF-SHA256-AES256GCM",
     "epk": b64url(32-byte ephemeral X25519 public key), "iv": b64url(12 bytes),
     "ct": b64url(AES-256-GCM ciphertext || 16-byte tag),
     "aad": {"purpose": "ai_selection", "hushhId", "podKeyId", "issuedAtMs", "selectionId"}}

* key = HKDF-SHA256(ikm = X25519(shared), salt = epk || pod public key,
  info = ``hussh/ai-selection/v1``, 32 bytes);
* AAD bytes = the canonical JSON of ``aad`` (sorted keys, no whitespace), the same
  ``canonical_json`` the hub, the pod and the device already share for bindings;
* plaintext = canonical JSON of ``{provider, model, apiKey, transport, vertexProject,
  vertexLocation}``.

Base64url is unpadded and canonical: a non-canonical spelling is refused rather than
normalised, so one envelope has exactly one byte form. ``tests/fixtures/
ai_selection_seal_vector_v1.json`` is the deterministic vector both ends assert.

Every refusal is a typed code and nothing else. A refusal never carries the plaintext,
the key, or why AES-GCM failed, because each of those is either the secret itself or
an oracle about it.
"""

from __future__ import annotations

import base64
import json
import re
import secrets
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.services.pod_session_authority import canonical_json

ENVELOPE_VERSION = 1
ENVELOPE_ALG = "X25519-HKDF-SHA256-AES256GCM"
PURPOSE = "ai_selection"
HKDF_INFO = b"hussh/ai-selection/v1"
#: How far ``issuedAtMs`` may sit from the pod's clock, either way.
MAX_CLOCK_SKEW_MS = 10 * 60 * 1000
MAX_API_KEY_CHARS = 512
#: The providers this agent can run a person's turns on with their own key.
SUPPORTED_PROVIDERS: tuple[str, ...] = ("gemini", "openai")
GEMINI_TRANSPORTS = frozenset({"developer_api", "vertex_api_key"})

BAD_ENVELOPE = "BAD_ENVELOPE"
STALE_SELECTION = "STALE_SELECTION"
PROVIDER_UNSUPPORTED = "PROVIDER_UNSUPPORTED"

_ENVELOPE_KEYS = frozenset({"v", "alg", "epk", "iv", "ct", "aad"})
_AAD_KEYS = frozenset({"purpose", "hushhId", "podKeyId", "issuedAtMs", "selectionId"})
_PLAINTEXT_KEYS = frozenset(
    {"provider", "model", "apiKey", "transport", "vertexProject", "vertexLocation"}
)
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_MAX_CIPHERTEXT_BYTES = 4096
_KEY_BYTES = 32
_IV_BYTES = 12
_TAG_BYTES = 16


class AiSelectionRefused(ValueError):
    """An envelope this pod will not accept. ``code`` is the whole explanation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class OpenedSelection:
    """The person's choice, opened. ``api_key`` never appears in a repr."""

    provider: str
    model: Optional[str]
    api_key: str = field(repr=False)
    transport: Optional[str]
    vertex_project: Optional[str]
    vertex_location: Optional[str]
    issued_at_ms: int
    selection_id: str


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: Any, *, length: Optional[int] = None) -> bytes:
    """Strict, canonical, unpadded base64url; anything else is a bad envelope."""
    if not isinstance(text, str) or not _B64URL_RE.fullmatch(text) or len(text) % 4 == 1:
        raise AiSelectionRefused(BAD_ENVELOPE)
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64url_encode(raw) != text or (length is not None and len(raw) != length):
        raise AiSelectionRefused(BAD_ENVELOPE)
    return raw


def _raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def derive_key(shared: bytes, epk_raw: bytes, pod_public_raw: bytes) -> bytes:
    """The AES-256 key: HKDF-SHA256 over the X25519 secret, salted by both public keys."""
    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_BYTES, salt=epk_raw + pod_public_raw, info=HKDF_INFO
    ).derive(shared)


def aad_bytes(aad: Mapping[str, Any]) -> bytes:
    return canonical_json(aad).encode("utf-8")


def seal_ai_selection(
    selection: Mapping[str, Any],
    *,
    pod_public_key_raw: bytes,
    aad: Mapping[str, Any],
    ephemeral_private_key_raw: Optional[bytes] = None,
    iv: Optional[bytes] = None,
) -> dict[str, Any]:
    """The device's half, kept here for the golden vector and the tests.

    ``ephemeral_private_key_raw`` and ``iv`` exist only so a vector is reproducible;
    a real seal draws both fresh, and reusing either with the same pod key breaks the
    scheme.
    """
    ephemeral = (
        X25519PrivateKey.from_private_bytes(ephemeral_private_key_raw)
        if ephemeral_private_key_raw is not None
        else X25519PrivateKey.generate()
    )
    nonce = iv if iv is not None else secrets.token_bytes(_IV_BYTES)
    epk_raw = _raw_public(ephemeral.public_key())
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(pod_public_key_raw))
    key = derive_key(shared, epk_raw, pod_public_key_raw)
    plaintext = canonical_json(selection).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad_bytes(aad))
    return {
        "v": ENVELOPE_VERSION,
        "alg": ENVELOPE_ALG,
        "epk": b64url_encode(epk_raw),
        "iv": b64url_encode(nonce),
        "ct": b64url_encode(ciphertext),
        "aad": dict(aad),
    }


def _parse_envelope(envelope: Any) -> tuple[bytes, bytes, bytes, dict[str, Any]]:
    if not isinstance(envelope, Mapping) or set(envelope) != _ENVELOPE_KEYS:
        raise AiSelectionRefused(BAD_ENVELOPE)
    version = envelope.get("v")
    if type(version) is not int or version != ENVELOPE_VERSION:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if envelope.get("alg") != ENVELOPE_ALG:
        raise AiSelectionRefused(BAD_ENVELOPE)
    aad = envelope.get("aad")
    if not isinstance(aad, Mapping) or set(aad) != _AAD_KEYS:
        raise AiSelectionRefused(BAD_ENVELOPE)
    epk = b64url_decode(envelope.get("epk"), length=_KEY_BYTES)
    iv = b64url_decode(envelope.get("iv"), length=_IV_BYTES)
    ct = b64url_decode(envelope.get("ct"))
    if not _TAG_BYTES < len(ct) <= _MAX_CIPHERTEXT_BYTES:
        raise AiSelectionRefused(BAD_ENVELOPE)
    return epk, iv, ct, dict(aad)


def _decrypt(
    private_key: X25519PrivateKey, epk: bytes, iv: bytes, ct: bytes, aad: Mapping[str, Any]
) -> bytes:
    try:
        shared = private_key.exchange(X25519PublicKey.from_public_bytes(epk))
        key = derive_key(shared, epk, _raw_public(private_key.public_key()))
        return AESGCM(key).decrypt(iv, ct, aad_bytes(aad))
    except Exception:  # noqa: BLE001 - one code for every failure: no oracle
        raise AiSelectionRefused(BAD_ENVELOPE) from None


def _check_aad(
    aad: Mapping[str, Any], *, hushh_id: str, pod_key_id: str, now_ms: int, floor_ms: int
) -> tuple[int, str]:
    if aad.get("purpose") != PURPOSE:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if not hushh_id or aad.get("hushhId") != hushh_id:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if not pod_key_id or aad.get("podKeyId") != pod_key_id:
        raise AiSelectionRefused(BAD_ENVELOPE)
    selection_id = aad.get("selectionId")
    try:
        parsed = uuid.UUID(str(selection_id))
    except ValueError:
        raise AiSelectionRefused(BAD_ENVELOPE) from None
    if not isinstance(selection_id, str) or parsed.version != 4 or str(parsed) != selection_id:
        raise AiSelectionRefused(BAD_ENVELOPE)
    issued = aad.get("issuedAtMs")
    if type(issued) is not int:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if abs(now_ms - issued) > MAX_CLOCK_SKEW_MS or issued <= floor_ms:
        # Too old, from the future, or not newer than what this agent already holds:
        # a replay or a rollback, never a fresh choice.
        raise AiSelectionRefused(STALE_SELECTION)
    return issued, selection_id


def _optional_text(value: Any, *, limit: int) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise AiSelectionRefused(BAD_ENVELOPE)
    return value.strip()


def _parse_plaintext(raw: bytes) -> dict[str, Any]:
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise AiSelectionRefused(BAD_ENVELOPE) from None
    if not isinstance(body, dict) or not set(body) <= _PLAINTEXT_KEYS:
        raise AiSelectionRefused(BAD_ENVELOPE)
    provider = body.get("provider")
    if not isinstance(provider, str) or not provider:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if provider not in SUPPORTED_PROVIDERS:
        raise AiSelectionRefused(PROVIDER_UNSUPPORTED)
    api_key = body.get("apiKey")
    if not isinstance(api_key, str) or not api_key.strip() or len(api_key) > MAX_API_KEY_CHARS:
        raise AiSelectionRefused(BAD_ENVELOPE)
    model = _optional_text(body.get("model"), limit=128)
    if model is not None and not _MODEL_RE.fullmatch(model):
        raise AiSelectionRefused(BAD_ENVELOPE)
    transport = _optional_text(body.get("transport"), limit=32)
    project = _optional_text(body.get("vertexProject"), limit=64)
    location = _optional_text(body.get("vertexLocation"), limit=64)
    if provider == "openai" and (transport not in {None, "developer_api"} or project or location):
        raise AiSelectionRefused(BAD_ENVELOPE)
    if transport is not None and transport not in GEMINI_TRANSPORTS:
        raise AiSelectionRefused(BAD_ENVELOPE)
    if transport == "vertex_api_key" and not (project and location):
        raise AiSelectionRefused(BAD_ENVELOPE)
    return {
        "provider": provider,
        "model": model,
        "api_key": api_key.strip(),
        "transport": transport,
        "vertex_project": project,
        "vertex_location": location,
    }


def open_ai_selection(
    envelope: Any,
    *,
    pod_private_key: X25519PrivateKey,
    hushh_id: str,
    pod_key_id: str,
    now_ms: int,
    floor_issued_at_ms: int = 0,
) -> OpenedSelection:
    """Open and check one envelope against THIS pod, now. Raises ``AiSelectionRefused``.

    The AAD is checked only after AES-GCM has authenticated it, so a code other than
    ``BAD_ENVELOPE`` is never an answer about bytes the device did not seal.
    """
    epk, iv, ct, aad = _parse_envelope(envelope)
    plaintext = _decrypt(pod_private_key, epk, iv, ct, aad)
    issued, selection_id = _check_aad(
        aad, hushh_id=hushh_id, pod_key_id=pod_key_id, now_ms=now_ms, floor_ms=floor_issued_at_ms
    )
    fields = _parse_plaintext(plaintext)
    return OpenedSelection(**fields, issued_at_ms=issued, selection_id=selection_id)


__all__ = [
    "BAD_ENVELOPE",
    "ENVELOPE_ALG",
    "HKDF_INFO",
    "MAX_API_KEY_CHARS",
    "MAX_CLOCK_SKEW_MS",
    "PROVIDER_UNSUPPORTED",
    "STALE_SELECTION",
    "SUPPORTED_PROVIDERS",
    "AiSelectionRefused",
    "OpenedSelection",
    "aad_bytes",
    "b64url_decode",
    "b64url_encode",
    "derive_key",
    "open_ai_selection",
    "seal_ai_selection",
]
