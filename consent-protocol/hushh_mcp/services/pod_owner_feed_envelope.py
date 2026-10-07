"""The owner feed's wire form: signed by the hub, sealed to one agent.

A feed answers one read an owner-cloud agent used to make per question through a
consent-token door (location, consent center, marketplace, command reads). The hub
builds the projection, SIGNS it under ``OWNER_FEED`` (so the agent knows the hub said
it, and nobody holding only the agent's public key could forge one) and SEALS the
signed document to the agent's X25519 key (so only that agent can read it)::

    signed   = {"feed": {kind, ownerId, hushhId, version, issuedAtMs, projection},
                "signature": "ed25519.<kid>.<b64url>"}       # over canonical_json(feed)
    envelope = {"v": 1, "alg": "X25519-HKDF-SHA256-AES256GCM", "epk", "iv", "ct",
                "aad": {purpose: "owner_feed", hushhId, podKeyId, kind, issuedAtMs}}

key = HKDF-SHA256(X25519(shared), salt = epk || pod public key,
info = ``hussh/owner-feed/v1``); a distinct info string from every other sealed
envelope, so a ciphertext made for one purpose never opens as another. ``version`` is
a digest of the projection, which is what the agent caches on.

Every refusal is ``OwnerFeedRefused`` with a code and nothing else: never the
plaintext, never which AES-GCM check failed.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
from collections.abc import Mapping
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from hushh_mcp.consent.token_signing import OWNER_FEED, sign_payload, verify_payload
from hushh_mcp.services.pod_session_authority import canonical_json

ENVELOPE_VERSION = 1
ENVELOPE_ALG = "X25519-HKDF-SHA256-AES256GCM"
PURPOSE = "owner_feed"
HKDF_INFO = b"hussh/owner-feed/v1"
FEED_KINDS = frozenset({"location", "nav", "marketplace", "command"})
#: How far a feed's issue time may sit from the agent's clock, either way.
MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
_MAX_CIPHERTEXT_BYTES = 512 * 1024
_ENVELOPE_KEYS = frozenset({"v", "alg", "epk", "iv", "ct", "aad"})
_AAD_KEYS = frozenset({"purpose", "hushhId", "podKeyId", "kind", "issuedAtMs"})
_FEED_KEYS = frozenset({"kind", "ownerId", "hushhId", "version", "issuedAtMs", "projection"})
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")


class OwnerFeedRefused(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: Any, *, length: Optional[int] = None) -> bytes:
    if not isinstance(text, str) or not _B64URL_RE.fullmatch(text) or len(text) % 4 == 1:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if _b64e(raw) != text or (length is not None and len(raw) != length):
        raise OwnerFeedRefused("BAD_ENVELOPE")
    return raw


def _raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


def _key(shared: bytes, epk: bytes, pod_public: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=epk + pod_public, info=HKDF_INFO).derive(
        shared
    )


def projection_version(projection: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(projection).encode("utf-8")).hexdigest()[:32]


def _metadata_fields(raw: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise OwnerFeedRefused("BAD_PROJECTION")
    result = {key: raw[key] for key in fields if key in raw}
    if any(
        value is not None and type(value) not in {str, int, float, bool}
        for value in result.values()
    ):
        raise OwnerFeedRefused("BAD_PROJECTION")
    return result


def _location_metadata_record(raw: dict[str, Any]) -> dict[str, Any]:
    """Kept names cannot smuggle content through an unexpected object value."""
    result = _metadata_fields(
        raw, tuple(key for key in raw if key not in {"publicKeyJwk", "capabilityScopes"})
    )
    if "capabilityScopes" in raw:
        scopes = raw["capabilityScopes"]
        if not isinstance(scopes, list) or not all(isinstance(scope, str) for scope in scopes):
            raise OwnerFeedRefused("BAD_PROJECTION")
        result["capabilityScopes"] = list(scopes)
    if "publicKeyJwk" in raw:
        jwk = raw["publicKeyJwk"]
        if jwk is None:
            result["publicKeyJwk"] = None
        else:
            if not isinstance(jwk, dict) or any(
                not isinstance(value, str) for key, value in jwk.items() if key != "key_ops"
            ):
                raise OwnerFeedRefused("BAD_PROJECTION")
            public = dict(jwk)
            if "key_ops" in public:
                operations = public["key_ops"]
                if not isinstance(operations, list) or not all(
                    isinstance(operation, str) for operation in operations
                ):
                    raise OwnerFeedRefused("BAD_PROJECTION")
                public["key_ops"] = list(operations)
            result["publicKeyJwk"] = public
    return result


def project_feed_projection(kind: str, raw: Any) -> dict[str, Any]:
    """Only declared hub metadata and publication summaries enter an owner feed."""
    if not isinstance(raw, dict):
        raise OwnerFeedRefused("BAD_PROJECTION")
    if kind == "location":
        from hushh_mcp.services.pod_data_door import project_location_state

        result = project_location_state(raw)
        # A request's free-form message is private content, not sharing metadata.
        for request in result["requests"]:
            request.pop("message", None)
        for field in (
            "recipients",
            "circles",
            "ownerGrants",
            "receivedGrants",
            "publicInvites",
            "requests",
        ):
            result[field] = [_location_metadata_record(row) for row in result[field]]
        if result["myRecipientKey"] is not None:
            result["myRecipientKey"] = _location_metadata_record(result["myRecipientKey"])
        return result
    if kind == "nav":
        from hushh_mcp.services.pod_data_door import project_nav_state

        return project_nav_state(raw)
    if kind == "marketplace":
        from hushh_mcp.services.pod_marketplace_read import (
            MarketplaceReadOptions,
            project_marketplace_read,
        )

        if "result" in raw:
            return project_marketplace_read(
                raw["result"], MarketplaceReadOptions(operation="earnings")
            )
        items = raw.get("items")
        if not isinstance(items, list):
            raise OwnerFeedRefused("BAD_PROJECTION")
        operation = "published" if not items or "publicProfileHandle" in items[0] else "publishable"
        return project_marketplace_read(items, MarketplaceReadOptions(operation=operation))
    if kind != "command" or not isinstance(raw.get("projection"), dict):
        raise OwnerFeedRefused("BAD_PROJECTION")
    from hushh_mcp.operons.location.references import LocationObservation

    source = raw["projection"]
    result = _metadata_fields(source, ("status", "reason", "page", "hasMore", "totalCount"))
    if "items" in source:
        if not isinstance(source["items"], list) or len(source["items"]) > 20:
            raise OwnerFeedRefused("BAD_PROJECTION")
        result["items"] = [
            _metadata_fields(
                item,
                (
                    "reference",
                    "name",
                    "kind",
                    "memberCount",
                    "canManageMembers",
                    "relationship",
                    "role",
                    "direction",
                    "status",
                    "expiresAt",
                    "durationHours",
                ),
            )
            for item in source["items"]
        ]
    if "autoApproval" in source:
        approval = source["autoApproval"]
        result["autoApproval"] = _metadata_fields(
            approval, ("enabled", "scopeKind", "ruleVersion", "scopeComplete")
        )
        circles = approval.get("circles")
        if not isinstance(circles, list) or len(circles) > 50:
            raise OwnerFeedRefused("BAD_PROJECTION")
        result["autoApproval"]["circles"] = [
            _metadata_fields(item, ("reference", "name")) for item in circles
        ]
    if "map" in source:
        result["map"] = _metadata_fields(source["map"], ("presenceMode",))
    observations = raw.get("observations", [])
    if not isinstance(observations, list) or len(observations) > 50:
        raise OwnerFeedRefused("BAD_PROJECTION")
    parsed = [LocationObservation.model_validate(item) for item in observations]
    if any(item.kind == "place" for item in parsed):
        raise OwnerFeedRefused("BAD_PROJECTION")
    return {"projection": result, "observations": [item.model_dump(mode="json") for item in parsed]}


def sign_feed(
    *, kind: str, owner_id: str, hushh_id: str, projection: Mapping[str, Any], issued_at_ms: int
) -> dict[str, Any]:
    """The hub's half. Raises when no ``OWNER_FEED`` private key is configured."""
    if kind not in FEED_KINDS:
        raise ValueError("unknown owner feed kind")
    projection = project_feed_projection(kind, projection)
    feed = {
        "kind": kind,
        "ownerId": owner_id,
        "hushhId": hushh_id,
        "version": projection_version(projection),
        "issuedAtMs": int(issued_at_ms),
        "projection": dict(projection),
    }
    signature = sign_payload(
        canonical_json(feed), hmac_key="", namespace=OWNER_FEED, require_asymmetric=True
    )
    return {"feed": feed, "signature": signature}


def seal_feed(
    signed: Mapping[str, Any], *, pod_public_key_raw: bytes, pod_key_id: str
) -> dict[str, Any]:
    feed = signed["feed"]
    aad = {
        "purpose": PURPOSE,
        "hushhId": feed["hushhId"],
        "podKeyId": pod_key_id,
        "kind": feed["kind"],
        "issuedAtMs": feed["issuedAtMs"],
    }
    ephemeral = X25519PrivateKey.generate()
    epk = _raw_public(ephemeral.public_key())
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(pod_public_key_raw))
    iv = secrets.token_bytes(12)
    ct = AESGCM(_key(shared, epk, pod_public_key_raw)).encrypt(
        iv, canonical_json(signed).encode("utf-8"), canonical_json(aad).encode("utf-8")
    )
    return {
        "v": ENVELOPE_VERSION,
        "alg": ENVELOPE_ALG,
        "epk": _b64e(epk),
        "iv": _b64e(iv),
        "ct": _b64e(ct),
        "aad": aad,
    }


def _decrypt(envelope: Any, private_key: X25519PrivateKey) -> tuple[bytes, Mapping[str, Any]]:
    if not isinstance(envelope, Mapping) or set(envelope) != _ENVELOPE_KEYS:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    if envelope.get("v") != ENVELOPE_VERSION or envelope.get("alg") != ENVELOPE_ALG:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    aad = envelope.get("aad")
    if not isinstance(aad, Mapping) or set(aad) != _AAD_KEYS:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    epk = _b64d(envelope.get("epk"), length=32)
    iv = _b64d(envelope.get("iv"), length=12)
    ct = _b64d(envelope.get("ct"))
    if not 16 < len(ct) <= _MAX_CIPHERTEXT_BYTES:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    try:
        shared = private_key.exchange(X25519PublicKey.from_public_bytes(epk))
        key = _key(shared, epk, _raw_public(private_key.public_key()))
        return AESGCM(key).decrypt(iv, ct, canonical_json(aad).encode("utf-8")), aad
    except Exception:  # noqa: BLE001 - one code for every failure: no oracle
        raise OwnerFeedRefused("BAD_ENVELOPE") from None


def open_feed(
    envelope: Any,
    *,
    pod_private_key: X25519PrivateKey,
    hushh_id: str,
    pod_key_id: str,
    kind: str,
    now_ms: int,
) -> dict[str, Any]:
    """Open, authenticate and bind one feed to THIS agent and this read, now."""
    plaintext, aad = _decrypt(envelope, pod_private_key)
    if (
        aad.get("purpose") != PURPOSE
        or not hushh_id
        or aad.get("hushhId") != hushh_id
        or not pod_key_id
        or aad.get("podKeyId") != pod_key_id
        or aad.get("kind") != kind
    ):
        raise OwnerFeedRefused("WRONG_AGENT")
    try:
        signed = json.loads(plaintext.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise OwnerFeedRefused("BAD_ENVELOPE") from None
    if not isinstance(signed, dict) or set(signed) != {"feed", "signature"}:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    feed, signature = signed["feed"], signed["signature"]
    if not isinstance(feed, dict) or set(feed) != _FEED_KEYS or not isinstance(signature, str):
        raise OwnerFeedRefused("BAD_ENVELOPE")
    if not verify_payload(
        canonical_json(feed), signature, hmac_key="", namespace=OWNER_FEED, require_asymmetric=True
    ):
        raise OwnerFeedRefused("BAD_SIGNATURE")
    issued = feed.get("issuedAtMs")
    if feed.get("kind") != kind or feed.get("hushhId") != hushh_id:
        raise OwnerFeedRefused("WRONG_AGENT")
    if type(issued) is not int or issued != aad.get("issuedAtMs"):
        raise OwnerFeedRefused("BAD_ENVELOPE")
    if abs(now_ms - issued) > MAX_CLOCK_SKEW_MS:
        raise OwnerFeedRefused("STALE_FEED")
    projection = feed.get("projection")
    if not isinstance(projection, dict) or feed.get("version") != projection_version(projection):
        raise OwnerFeedRefused("BAD_ENVELOPE")
    try:
        if project_feed_projection(kind, projection) != projection:
            raise OwnerFeedRefused("BAD_PROJECTION")
    except (ValueError, TypeError, KeyError):
        raise OwnerFeedRefused("BAD_PROJECTION") from None
    if not isinstance(feed.get("ownerId"), str) or not feed["ownerId"]:
        raise OwnerFeedRefused("BAD_ENVELOPE")
    return feed


__all__ = [
    "FEED_KINDS",
    "HKDF_INFO",
    "OwnerFeedRefused",
    "open_feed",
    "projection_version",
    "project_feed_projection",
    "seal_feed",
    "sign_feed",
]
