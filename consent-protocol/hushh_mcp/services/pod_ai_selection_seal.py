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
an oracle about it. The envelope mechanics are shared with every other sealed purpose
(``pod_sealed_envelope``); this module is the purpose: its label, its AAD and its
plaintext rules.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Optional

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

from hushh_mcp.services import pod_sealed_envelope as envelope_core
from hushh_mcp.services.pod_sealed_envelope import (
    BAD_ENVELOPE,
    ENVELOPE_ALG,
    ENVELOPE_VERSION,
    MAX_CLOCK_SKEW_MS,
    SealPurpose,
    SealRefused,
    aad_bytes,
    b64url_encode,
)

PURPOSE = "ai_selection"
HKDF_INFO = b"hussh/ai-selection/v1"
MAX_API_KEY_CHARS = 512
#: The providers this agent can run a person's turns on with their own key.
SUPPORTED_PROVIDERS: tuple[str, ...] = ("gemini", "openai")
GEMINI_TRANSPORTS = frozenset({"developer_api", "vertex_api_key"})

STALE_SELECTION = "STALE_SELECTION"
PROVIDER_UNSUPPORTED = "PROVIDER_UNSUPPORTED"

_AAD_KEYS = frozenset({"purpose", "hushhId", "podKeyId", "issuedAtMs", "selectionId"})
_PLAINTEXT_KEYS = frozenset(
    {"provider", "model", "apiKey", "transport", "vertexProject", "vertexLocation"}
)
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


class AiSelectionRefused(SealRefused):
    """An envelope this pod will not accept. ``code`` is the whole explanation."""


SEAL_PURPOSE = SealPurpose(
    name=PURPOSE, hkdf_info=HKDF_INFO, aad_keys=_AAD_KEYS, refusal=AiSelectionRefused
)


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


def b64url_decode(text: Any, *, length: Optional[int] = None) -> bytes:
    """Strict, canonical, unpadded base64url; anything else is a bad envelope."""
    return envelope_core.b64url_decode(text, length=length, refusal=AiSelectionRefused)


def derive_key(shared: bytes, epk_raw: bytes, pod_public_raw: bytes) -> bytes:
    """The AES-256 key: HKDF-SHA256 over the X25519 secret, salted by both public keys."""
    return envelope_core.derive_key(shared, epk_raw, pod_public_raw, info=HKDF_INFO)


def seal_ai_selection(
    selection: Mapping[str, Any],
    *,
    pod_public_key_raw: bytes,
    aad: Mapping[str, Any],
    ephemeral_private_key_raw: Optional[bytes] = None,
    iv: Optional[bytes] = None,
) -> dict[str, Any]:
    """The device's half, kept here for the golden vector and the tests."""
    return envelope_core.seal(
        selection,
        purpose=SEAL_PURPOSE,
        pod_public_key_raw=pod_public_key_raw,
        aad=aad,
        ephemeral_private_key_raw=ephemeral_private_key_raw,
        iv=iv,
    )


def _check_aad(
    aad: Mapping[str, Any], *, hushh_id: str, pod_key_id: str, now_ms: int, floor_ms: int
) -> tuple[int, str]:
    envelope_core.check_binding(aad, purpose=SEAL_PURPOSE, hushh_id=hushh_id, pod_key_id=pod_key_id)
    selection_id = envelope_core.check_uuid4(aad.get("selectionId"), purpose=SEAL_PURPOSE)
    issued = envelope_core.check_issued(
        aad, purpose=SEAL_PURPOSE, now_ms=now_ms, floor_ms=floor_ms, stale_code=STALE_SELECTION
    )
    return issued, selection_id


def _optional_text(value: Any, *, limit: int) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise AiSelectionRefused(BAD_ENVELOPE)
    return value.strip()


def _parse_plaintext(raw: bytes) -> dict[str, Any]:
    body = envelope_core.parse_json_object(raw, purpose=SEAL_PURPOSE)
    if not set(body) <= _PLAINTEXT_KEYS:
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
    plaintext, aad = envelope_core.open_envelope(
        envelope, purpose=SEAL_PURPOSE, pod_private_key=pod_private_key
    )
    issued, selection_id = _check_aad(
        aad, hushh_id=hushh_id, pod_key_id=pod_key_id, now_ms=now_ms, floor_ms=floor_issued_at_ms
    )
    fields = _parse_plaintext(plaintext)
    return OpenedSelection(**fields, issued_at_ms=issued, selection_id=selection_id)


__all__ = [
    "BAD_ENVELOPE",
    "ENVELOPE_ALG",
    "ENVELOPE_VERSION",
    "HKDF_INFO",
    "MAX_API_KEY_CHARS",
    "MAX_CLOCK_SKEW_MS",
    "PROVIDER_UNSUPPORTED",
    "SEAL_PURPOSE",
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
