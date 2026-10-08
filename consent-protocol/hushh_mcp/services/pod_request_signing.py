"""Cloud-neutral pod-to-hub request signing: one Ed25519 scheme for every cloud.

WHY THIS EXISTS. A pod used to prove itself to the hub with a Google ID token minted
by the instance metadata server. That token only exists on Google Cloud, so a pod in
a person's Azure subscription could not prove anything at all. The hub therefore
verifies one thing for every cloud: a signature made with a key the pod derives from
its OWN X25519 private key (``pod_self_registration.pod_signing_key``). No Entra token
verifier is built, ever (``docs/reference/architecture/byoc-azure.md``).

WHAT A SIGNATURE BINDS. The canonical JSON (``pod_session_authority.canonical_json``:
sorted keys, compact separators, UTF-8) of exactly these fields::

    purpose      "hushh/pod-hub-request/v1"
    aud          the hub audience, trailing "/" stripped
    hushh_id     the HusshID the pod asserts in ``X-Hushh-Pod-Id``
    kid          the signing key id, ``pods_`` + 32 hex
    method       upper-case HTTP method
    path         the request path as sent
    query        sorted, RFC 3986 encoded ``k=v`` pairs joined by "&" ("" when none)
    body_sha256  hex SHA-256 of the exact raw body bytes (empty body included)
    ts_ms        the signing time, milliseconds since the epoch
    nonce        16 random bytes, base64url without padding
    epoch        ONLY when ``X-Hushh-Pod-Epoch`` is sent: the placement epoch the pod
                 was told (an integer). Absent, the payload is byte-identical to the
                 scheme before epochs existed, so the golden vector is unchanged.

Changing any one of them -- the body, the path, the query, the audience or the
asserted HusshID -- invalidates the signature, which is what the golden vector in
``tests/test_pod_request_signing.py`` pins byte for byte.

WHAT A SIGNATURE DOES NOT PROVE ON ITS OWN. Which key is THIS pod's. The hub records
the public half only from a GET it initiates itself, to the address it recorded when
it created the pod (``pod_key_collector``); a request never carries key material.
Replay (the nonce store) and the per-row latch are the hub verifier's job
(``pod_request_verifier``). This module is pure and side-effect free.
"""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from hushh_mcp.services.pod_session_authority import canonical_json

PURPOSE = "hushh/pod-hub-request/v1"
SIGNING_ALG = "ed25519"
KEY_ID_PREFIX = "pods_"

SIGNATURE_HEADER = "X-Hushh-Pod-Signature"
TIMESTAMP_HEADER = "X-Hushh-Pod-Timestamp"
NONCE_HEADER = "X-Hushh-Pod-Nonce"
#: The placement epoch the pod holds (STANDBY-SYNC.md E4). Signed when present; the
#: hub demands it once a person has a standby or an epoch above 0.
EPOCH_HEADER = "X-Hushh-Pod-Epoch"

#: Acceptance window, relative to the hub's clock: ts in [now - 60 s, now + 30 s].
MAX_AGE_MS = 60_000
MAX_AHEAD_MS = 30_000
NONCE_BYTES = 16

_TAG = f"{SIGNING_ALG}."
_KEY_ID_RE = re.compile(r"^pods_[0-9a-f]{32}$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")
_TIMESTAMP_RE = re.compile(r"^[0-9]{1,15}$")
_SIGNATURE_RE = re.compile(r"^[A-Za-z0-9_-]{86}$")
_PUBLIC_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")
_EPOCH_RE = re.compile(r"^(0|[1-9][0-9]{0,17})$")
_UNRESERVED = "-._~"


@dataclass(frozen=True)
class VerifiedPod:
    """A pod the hub authenticated, and the evidence it was authenticated by.

    ``key_id`` is set when the request carried a valid signature under the key the
    hub recorded for this row. ``service_account`` is set only on the transitional
    BYOC Google path, where the verified service account is bound to the row. The
    managed Google path sets neither: there the HusshID is the pod's own assertion.
    """

    hushh_id: str
    key_id: Optional[str] = None
    service_account: Optional[str] = None
    #: True only when the STANDBY placement's key signed (accepted on sync paths only).
    standby: bool = False

    @property
    def signed(self) -> bool:
        return bool(self.key_id)

    @property
    def owner_bound(self) -> bool:
        """True when the evidence distinguishes this pod from every other pod."""
        return self.signed or bool(self.service_account)


@dataclass(frozen=True)
class SignedRequestHeaders:
    """The signature headers of one request, parsed and shape-checked."""

    kid: str
    signature: bytes
    ts_ms: int
    nonce: str
    epoch: Optional[int] = None


class PodRequestSignatureMalformed(ValueError):
    """A signature header is present but is not the shape this scheme emits."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def signing_key_id(public_key_b64: str) -> str:
    """``pods_`` + 32 hex of SHA-256 over the base64 public key (``_stable_key_id`` shape)."""
    digest = hashlib.sha256(public_key_b64.encode("utf-8")).hexdigest()[:32]
    return f"{KEY_ID_PREFIX}{digest}"


def public_key_b64(private_key: Ed25519PrivateKey) -> str:
    """Standard base64 of the raw 32-byte public key."""
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return base64.b64encode(raw).decode("ascii")


def is_signing_public_key(value: object) -> bool:
    """True for a standard-base64 raw 32-byte Ed25519 public key."""
    if not isinstance(value, str) or not _PUBLIC_KEY_RE.match(value):
        return False
    try:
        return len(base64.b64decode(value, validate=True)) == 32
    except ValueError:
        return False


def is_signing_key_id(value: object) -> bool:
    return isinstance(value, str) and bool(_KEY_ID_RE.match(value))


def query_pairs_from_params(params: Optional[Mapping[str, Any]]) -> list[tuple[str, str]]:
    """The (key, value) pairs ``requests`` sends for ``params``.

    Mirrors ``requests``: a ``None`` value is dropped, a list or tuple becomes one
    pair per item, anything else is ``str()``-ed. The signer and the transport must
    agree on the pairs, or a correct pod would sign a query it never sent.
    """
    pairs: list[tuple[str, str]] = []
    for key, value in (params or {}).items():
        values = value if isinstance(value, (list, tuple)) else [value]
        pairs.extend((str(key), str(item)) for item in values if item is not None)
    return pairs


def canonical_query(pairs: Iterable[tuple[str, str]]) -> str:
    """Sorted, RFC 3986 encoded ``k=v`` pairs joined by ``&``; ``""`` when empty."""
    ordered = sorted((str(key), str(value)) for key, value in pairs)
    return "&".join(
        f"{quote(key, safe=_UNRESERVED)}={quote(value, safe=_UNRESERVED)}" for key, value in ordered
    )


def normalize_audience(aud: str) -> str:
    return str(aud or "").strip().rstrip("/")


def request_signing_payload(
    *,
    aud: str,
    hushh_id: str,
    kid: str,
    method: str,
    path: str,
    query_pairs: Iterable[tuple[str, str]],
    body: bytes,
    ts_ms: int,
    nonce: str,
    epoch: Optional[int] = None,
) -> bytes:
    """The exact bytes that are signed and verified. ``epoch`` is bound only when sent."""
    fields: dict[str, Any] = {
        "purpose": PURPOSE,
        "aud": normalize_audience(aud),
        "hushh_id": hushh_id,
        "kid": kid,
        "method": str(method).upper(),
        "path": path,
        "query": canonical_query(query_pairs),
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "ts_ms": int(ts_ms),
        "nonce": nonce,
    }
    if epoch is not None:
        fields["epoch"] = int(epoch)
    return canonical_json(fields).encode("utf-8")


def new_nonce() -> str:
    return _b64url(secrets.token_bytes(NONCE_BYTES))


def sign_pod_request(
    private_key: Ed25519PrivateKey,
    *,
    aud: str,
    hushh_id: str,
    method: str,
    path: str,
    query_pairs: Iterable[tuple[str, str]],
    body: bytes,
    ts_ms: Optional[int] = None,
    nonce: Optional[str] = None,
    epoch: int | None = None,
) -> dict[str, str]:
    """The signature headers for one request. ``hushh_id`` rides separately.

    With ``epoch``, a fourth header carries it and the signature covers it.
    """
    if epoch is not None and (type(epoch) is not int or not _EPOCH_RE.match(str(epoch))):
        raise ValueError("a placement epoch is a non-negative integer")
    kid = signing_key_id(public_key_b64(private_key))
    stamp = int(ts_ms if ts_ms is not None else time.time() * 1000)
    fresh = nonce or new_nonce()
    payload = request_signing_payload(
        aud=aud,
        hushh_id=hushh_id,
        kid=kid,
        method=method,
        path=path,
        query_pairs=query_pairs,
        body=body,
        ts_ms=stamp,
        nonce=fresh,
        epoch=epoch,
    )
    headers = {
        SIGNATURE_HEADER: f"{_TAG}{kid}.{_b64url(private_key.sign(payload))}",
        TIMESTAMP_HEADER: str(stamp),
        NONCE_HEADER: fresh,
    }
    if epoch is not None:
        headers[EPOCH_HEADER] = str(epoch)
    return headers


def parse_signature_headers(headers: Mapping[str, str]) -> Optional[SignedRequestHeaders]:
    """The signature headers, or None when the request carries no signature.

    Raises :class:`PodRequestSignatureMalformed` for a present-but-wrong shape, so a
    caller can tell "unsigned" (may fall back to the transitional path) from
    "signed badly" (must be refused outright, never downgraded).
    """
    raw = str(headers.get(SIGNATURE_HEADER) or "").strip()
    if not raw:
        return None
    if not raw.startswith(_TAG):
        raise PodRequestSignatureMalformed("unsupported signature algorithm")
    kid, _, encoded = raw[len(_TAG) :].partition(".")
    stamp = str(headers.get(TIMESTAMP_HEADER) or "").strip()
    nonce = str(headers.get(NONCE_HEADER) or "").strip()
    epoch = headers.get(EPOCH_HEADER)
    if not (
        _KEY_ID_RE.match(kid)
        and _SIGNATURE_RE.match(encoded)
        and _TIMESTAMP_RE.match(stamp)
        and _NONCE_RE.match(nonce)
        and (epoch is None or _EPOCH_RE.match(str(epoch).strip()))
    ):
        raise PodRequestSignatureMalformed("malformed signature headers")
    return SignedRequestHeaders(
        kid=kid,
        signature=_b64url_decode(encoded),
        ts_ms=int(stamp),
        nonce=nonce,
        epoch=None if epoch is None else int(str(epoch).strip()),
    )


def timestamp_in_window(ts_ms: int, now_ms: int) -> bool:
    return now_ms - MAX_AGE_MS <= ts_ms <= now_ms + MAX_AHEAD_MS


def verify_request_signature(
    public_key: str,
    signed: SignedRequestHeaders,
    *,
    aud: str,
    hushh_id: str,
    method: str,
    path: str,
    query_pairs: Iterable[tuple[str, str]],
    body: bytes,
) -> bool:
    """True only when ``signed`` is a valid signature by ``public_key`` over this request.

    The kid is recomputed from the key, so a header naming one key while carrying a
    signature from another can never verify.
    """
    if not is_signing_public_key(public_key) or signing_key_id(public_key) != signed.kid:
        return False
    if not normalize_audience(aud) or not hushh_id:
        return False
    payload = request_signing_payload(
        aud=aud,
        hushh_id=hushh_id,
        kid=signed.kid,
        method=method,
        path=path,
        query_pairs=query_pairs,
        body=body,
        ts_ms=signed.ts_ms,
        nonce=signed.nonce,
        epoch=signed.epoch,
    )
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key)).verify(
            signed.signature, payload
        )
    except (InvalidSignature, ValueError):
        return False
    return True
