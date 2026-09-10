"""The pod admits its owner's devices itself: bindings, challenges, sessions.

Three artefacts, one authority.

1. **The binding** (``pod_binding_v1``) is a record the hub signs with the same Ed25519
   key it uses for consent tokens and every pod already verifies with
   ``CONSENT_ED25519_PUBLIC_KEYS``. It names the owner, the environment, THIS
   deployment (the pod key id and public key the registry row already carries, and
   the url), the subject (a device or an app installation, by P-256 public key and
   platform), the role, the scopes, a monotonic version and an expiry. The hub
   derives the role from the trusted-device platform; the pod accepts only the role
   the signed record states. Nothing a caller says in a header or a hello frame can
   raise it.

2. **The challenge and proof** have the shape of ``trusted_device_service`` proof of
   possession (``signing_payload`` / ``verify_challenge``): a nonce the pod minted, a
   canonical JSON payload the subject signs with its P-256 key, verify first and
   consume only after. The payload carries ``purpose="pod-session-admission"``, this
   pod's key id and the current incarnation epoch, so a proof produced for another
   pod or another incarnation is unknown here by construction.

3. **The session** is an HMAC-SHA256 over canonical claims under a key derived from
   the pod's DEK with its own HKDF label, twelve hours, verified statelessly and
   then checked live against the tombstones and the recorded version. It carries the
   role from the binding and nothing else can change it.

A hub consent token is never local authority. It has a different prefix, a different
key and a different meaning, and the verifier refuses it by shape before it looks at
anything else.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable, Optional

from hushh_mcp.consent.token_signing import CONSENT_TOKENS, known_kids, verify_payload
from hushh_mcp.services.pod_authority_store import (
    IncarnationLease,
    PodAuthorityError,
    PodAuthorityStore,
    TombstoneRecord,
)
from hushh_mcp.services.pod_consent_client import ConsentVerdict

logger = logging.getLogger(__name__)

BINDING_KIND = "pod_binding_v1"
SESSION_PREFIX = "pst1."
SESSION_TTL_SECONDS = 12 * 60 * 60
CHALLENGE_TTL_SECONDS = 120
CHALLENGE_PURPOSE = "pod-session-admission"
LOCAL_TOKEN_PREFIX = "pod-session:"  # noqa: S105 - a marker prefix, not a credential

ROLE_DEVICE = "device"
ROLE_APP = "app"
ROLE_BY_PLATFORM: dict[str, str] = {
    "macos": ROLE_DEVICE,
    "web": ROLE_APP,
    "ios": ROLE_APP,
    "android": ROLE_APP,
}

SCOPE_PKM_READ = "pkm.read"
SCOPE_POD_CONFIG = "pod.config"
SCOPE_POD_STATUS = "pod.status"
SCOPE_POD_REVOKE = "pod.revoke"
SCOPE_PUPPY_INFERENCE = "puppy.inference"
APP_SCOPES: tuple[str, ...] = (SCOPE_PKM_READ, SCOPE_POD_CONFIG, SCOPE_POD_STATUS, SCOPE_POD_REVOKE)
DEVICE_SCOPES: tuple[str, ...] = ()
DEVICE_INFERENCE_SCOPES: tuple[str, ...] = (SCOPE_PUPPY_INFERENCE,)

_SESSION_HMAC_INFO = b"hussh/pod-session/hmac/v1"
_KEY_LEN = 32
_MAX_TOKEN_LEN = 4096
_MAX_CHALLENGES = 256


class PodSessionRefused(Exception):
    """One exact refusal. ``code`` is stable and safe to log; ``status`` maps to HTTP."""

    def __init__(self, code: str, detail: str = "", *, status: int = 403) -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail
        self.status = status


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def canonical_json(value: Mapping[str, Any]) -> str:
    """Byte-exact canonical form shared by the hub, the pod and the device."""
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def expected_environment() -> str:
    """The lane this pod was deployed to, in the same precedence the relay uses."""
    return _clean(os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT")).lower()


def role_for_platform(platform: str) -> Optional[str]:
    return ROLE_BY_PLATFORM.get(_clean(platform).lower())


# -- the binding ----------------------------------------------------------------------


@dataclass(frozen=True)
class PodBindingV1:
    hushh_id: str
    user_id: str
    environment: str
    pod_key_id: str
    pod_public_key: str
    url: str
    subject_id: str
    subject_kind: str
    subject_public_key: str
    platform: str
    role: str
    scopes: tuple[str, ...]
    version: int
    issued_at_ms: int
    expires_at_ms: int
    kind: str = BINDING_KIND

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "hushh_id": self.hushh_id,
            "user_id": self.user_id,
            "environment": self.environment,
            "pod_key_id": self.pod_key_id,
            "pod_public_key": self.pod_public_key,
            "url": self.url,
            "subject_id": self.subject_id,
            "subject_kind": self.subject_kind,
            "subject_public_key": self.subject_public_key,
            "platform": self.platform,
            "role": self.role,
            "scopes": list(self.scopes),
            "version": self.version,
            "issued_at_ms": self.issued_at_ms,
            "expires_at_ms": self.expires_at_ms,
        }

    def canonical(self) -> str:
        return canonical_json(self.to_dict())

    @classmethod
    def from_mapping(cls, raw: Any) -> PodBindingV1:
        if not isinstance(raw, Mapping):
            raise PodSessionRefused("malformed", "a binding is an object", status=400)
        if _clean(raw.get("kind")) != BINDING_KIND:
            raise PodSessionRefused("malformed", "unknown binding kind", status=400)
        text_fields = (
            "hushh_id",
            "user_id",
            "environment",
            "pod_key_id",
            "pod_public_key",
            "url",
            "subject_id",
            "subject_kind",
            "subject_public_key",
            "platform",
            "role",
        )
        values: dict[str, Any] = {}
        for name in text_fields:
            value = raw.get(name)
            if not isinstance(value, str) or not value.strip() or len(value) > 4096:
                raise PodSessionRefused(
                    "malformed", f"binding field {name} is required", status=400
                )
            values[name] = value.strip()
        scopes = raw.get("scopes")
        if not isinstance(scopes, list) or any(
            not isinstance(s, str) or not s.strip() or len(s) > 64 for s in scopes
        ):
            raise PodSessionRefused("malformed", "binding scopes are a list of names", status=400)
        for name in ("version", "issued_at_ms", "expires_at_ms"):
            value = raw.get(name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise PodSessionRefused(
                    "malformed", f"binding field {name} is an integer", status=400
                )
            values[name] = value
        if values["version"] < 1:
            raise PodSessionRefused("malformed", "a binding version starts at 1", status=400)
        return cls(scopes=tuple(scopes), **values)


# -- proof of possession ------------------------------------------------------------------


def challenge_signing_payload(
    *,
    challenge_id: str,
    nonce: str,
    hushh_id: str,
    subject_id: str,
    pod_key_id: str,
    epoch: int,
) -> str:
    """The exact bytes the subject signs. Sorted keys, compact separators, UTF-8."""
    return canonical_json(
        {
            "challenge_id": challenge_id,
            "epoch": int(epoch),
            "hushh_id": hushh_id,
            "nonce": nonce,
            "pod_key_id": pod_key_id,
            "purpose": CHALLENGE_PURPOSE,
            "subject_id": subject_id,
        }
    )


def verify_subject_proof(subject_public_key_b64: str, payload: str, signature_b64: str) -> bool:
    """ECDSA P-256 over SHA-256, exactly as ``trusted_device_service.verify_challenge``."""
    from cryptography.exceptions import InvalidSignature  # noqa: PLC0415
    from cryptography.hazmat.primitives import hashes, serialization  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415

    try:
        public_key = serialization.load_der_public_key(
            base64.b64decode(_clean(subject_public_key_b64), validate=True)
        )
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            return False
        public_key.verify(
            base64.b64decode(_clean(signature_b64), validate=True),
            payload.encode("utf-8"),
            ec.ECDSA(hashes.SHA256()),
        )
        return True
    except (InvalidSignature, TypeError, ValueError):
        return False


def _secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass
class _Challenge:
    subject_id: str
    nonce_hash: str
    epoch: int
    expires_at: float


# -- the authority -----------------------------------------------------------------------


def derive_session_key(dek: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415

    if len(dek) != _KEY_LEN:
        raise PodSessionRefused("unavailable", "the pod DEK must be 32 bytes", status=503)
    return HKDF(
        algorithm=hashes.SHA256(), length=_KEY_LEN, salt=None, info=_SESSION_HMAC_INFO
    ).derive(dek)


class PodSessionAuthority:
    """Owner-local admission for one pod. Every refusal is one exact code."""

    def __init__(
        self,
        *,
        store: PodAuthorityStore,
        lease: IncarnationLease,
        dek: bytes,
        pod_key_id: str,
        pod_public_key: str,
        environment: Optional[str] = None,
        clock: Callable[[], float] = time.time,
        session_ttl_seconds: int = SESSION_TTL_SECONDS,
    ) -> None:
        self._store = store
        self._lease = lease
        self._session_key = derive_session_key(dek)
        self._pod_key_id = _clean(pod_key_id)
        self._pod_public_key = _clean(pod_public_key)
        self._environment = _clean(
            environment if environment is not None else expected_environment()
        ).lower()
        self._clock = clock
        self._ttl = int(session_ttl_seconds)
        self._challenges: dict[str, _Challenge] = {}

    # -- properties -----------------------------------------------------------------

    @property
    def store(self) -> PodAuthorityStore:
        return self._store

    @property
    def lease(self) -> IncarnationLease:
        return self._lease

    @property
    def epoch(self) -> int:
        return self._lease.epoch

    @property
    def hushh_id(self) -> str:
        return self._store.hushh_id

    @property
    def pod_key_id(self) -> str:
        return self._pod_key_id

    @property
    def environment(self) -> str:
        return self._environment

    async def require_held(self) -> None:
        state = await self._lease.state()
        if state == "held":
            return
        raise PodSessionRefused(
            "fenced" if state == "fenced" else "uncertain",
            "this incarnation no longer holds the pod"
            if state == "fenced"
            else "the fence could not be read",
            status=503,
        )

    # -- binding verification -------------------------------------------------------

    def verify_binding(self, raw: Any, signature: Any) -> PodBindingV1:
        """Every check a binding must pass before it is trusted. Order is deliberate:
        the signature first, so no unsigned field steers a later refusal code."""
        binding = PodBindingV1.from_mapping(raw)
        sig = _clean(signature)
        if not sig.startswith("ed25519."):
            raise PodSessionRefused("bad_signature", "a binding carries an Ed25519 signature")
        kid = sig[len("ed25519.") :].partition(".")[0]
        if kid not in known_kids(CONSENT_TOKENS):
            raise PodSessionRefused("unknown_key_id", "the binding was signed by an unknown key")
        if not verify_payload(binding.canonical(), sig, hmac_key="", require_asymmetric=True):
            raise PodSessionRefused("bad_signature", "the binding signature did not verify")
        if binding.hushh_id != self.hushh_id:
            raise PodSessionRefused("foreign_owner", "the binding names another owner")
        if binding.environment.lower() != self._environment:
            raise PodSessionRefused("foreign_environment", "the binding names another environment")
        if binding.pod_key_id != self._pod_key_id or binding.pod_public_key != self._pod_public_key:
            raise PodSessionRefused("foreign_deployment", "the binding names another pod")
        expected_role = role_for_platform(binding.platform)
        if binding.role not in {ROLE_DEVICE, ROLE_APP} or binding.role != expected_role:
            raise PodSessionRefused("forged_role", "the role does not follow from the platform")
        if binding.subject_kind != binding.role:
            raise PodSessionRefused("forged_role", "the subject kind does not match the role")
        if self._clock() * 1000 >= binding.expires_at_ms:
            raise PodSessionRefused("expired", "the binding has expired")
        status = self._store.subject(binding.subject_id)
        if status.tombstone is not None and status.tombstone.at_version >= binding.version:
            raise PodSessionRefused("revoked", "this subject was revoked at or above this version")
        if binding.version <= self._store.highest_version(binding.subject_id):
            raise PodSessionRefused("stale_version", "a newer binding is already recorded")
        return binding

    # -- challenges -----------------------------------------------------------------

    def create_challenge(self, subject_id: str) -> dict[str, Any]:
        subject = _clean(subject_id)
        if not subject or len(subject) > 128:
            raise PodSessionRefused("malformed", "a subject id is required", status=400)
        now = self._clock()
        self._prune_challenges(now)
        if len(self._challenges) >= _MAX_CHALLENGES:
            raise PodSessionRefused("busy", "too many open challenges", status=429)
        challenge_id = f"psc_{secrets.token_urlsafe(24)}"
        nonce = secrets.token_urlsafe(32)
        self._challenges[challenge_id] = _Challenge(
            subject_id=subject,
            nonce_hash=_secret_hash(nonce),
            epoch=self.epoch,
            expires_at=now + CHALLENGE_TTL_SECONDS,
        )
        return {
            "challenge_id": challenge_id,
            "nonce": nonce,
            "epoch": self.epoch,
            "pod_key_id": self._pod_key_id,
            "expires_at_ms": int((now + CHALLENGE_TTL_SECONDS) * 1000),
            "signing_payload": challenge_signing_payload(
                challenge_id=challenge_id,
                nonce=nonce,
                hushh_id=self.hushh_id,
                subject_id=subject,
                pod_key_id=self._pod_key_id,
                epoch=self.epoch,
            ),
        }

    def _prune_challenges(self, now: float) -> None:
        for key in [k for k, c in self._challenges.items() if c.expires_at <= now]:
            self._challenges.pop(key, None)

    # -- admission ------------------------------------------------------------------

    async def admit(
        self,
        *,
        binding: Any,
        signature: Any,
        challenge_id: Any,
        nonce: Any,
        proof: Any,
        epoch: Any,
    ) -> tuple[str, dict[str, Any]]:
        """Verify binding and proof, record trust, mint a session. Appends nothing on refusal."""
        await self.require_held()
        verified = self.verify_binding(binding, signature)
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch != self.epoch:
            raise PodSessionRefused("foreign_incarnation", "the proof names another incarnation")
        now = self._clock()
        self._prune_challenges(now)
        challenge = self._challenges.get(_clean(challenge_id))
        if challenge is None:
            raise PodSessionRefused(
                "replayed_proof", "the challenge is unknown, used or expired", status=401
            )
        if challenge.epoch != self.epoch:
            raise PodSessionRefused(
                "foreign_incarnation", "the challenge belongs to another incarnation"
            )
        if challenge.subject_id != verified.subject_id or not hmac.compare_digest(
            challenge.nonce_hash, _secret_hash(_clean(nonce))
        ):
            raise PodSessionRefused(
                "replayed_proof", "the challenge does not match this subject", status=401
            )
        payload = challenge_signing_payload(
            challenge_id=_clean(challenge_id),
            nonce=_clean(nonce),
            hushh_id=self.hushh_id,
            subject_id=verified.subject_id,
            pod_key_id=self._pod_key_id,
            epoch=self.epoch,
        )
        if not verify_subject_proof(verified.subject_public_key, payload, proof):
            raise PodSessionRefused("bad_proof", "the possession proof did not verify", status=401)
        # Consume only after the proof verified; a failed attempt may be retried.
        self._challenges.pop(_clean(challenge_id), None)
        try:
            await self._store.record_trust(verified.to_dict())
        except PodAuthorityError as exc:
            raise PodSessionRefused(exc.code, exc.detail) from exc
        token, claims = self.mint_session(verified)
        logger.info(
            "pod_session.admitted role=%s version=%s epoch=%s",
            verified.role,
            verified.version,
            self.epoch,
        )
        return token, claims

    # -- sessions -------------------------------------------------------------------

    def mint_session(self, binding: PodBindingV1) -> tuple[str, dict[str, Any]]:
        now = int(self._clock())
        claims = {
            "sid": f"pss_{secrets.token_urlsafe(18)}",
            "hushh_id": binding.hushh_id,
            "user_id": binding.user_id,
            "subject_id": binding.subject_id,
            "role": binding.role,
            "scopes": list(binding.scopes),
            "version": binding.version,
            "epoch": self.epoch,
            "iat": now,
            "exp": now + self._ttl,
        }
        body = canonical_json(claims).encode("utf-8")
        mac = hmac.new(self._session_key, body, hashlib.sha256).digest()
        return f"{SESSION_PREFIX}{_b64url(body)}.{_b64url(mac)}", claims

    def verify_session(self, token: Any, *, expected_role: Optional[str] = None) -> dict[str, Any]:
        """Stateless verification, then the live checks the log owns."""
        raw = _clean(token)
        if not raw or len(raw) > _MAX_TOKEN_LEN:
            raise PodSessionRefused(
                "not_local_authority", "a pod session bearer is required", status=401
            )
        if not raw.startswith(SESSION_PREFIX):
            # A hub consent token, an OIDC token, anything else: refused by shape.
            raise PodSessionRefused("not_local_authority", "this is not a pod session", status=401)
        encoded, _, mac_b64 = raw[len(SESSION_PREFIX) :].partition(".")
        try:
            body = _b64url_decode(encoded)
            presented = _b64url_decode(mac_b64)
        except (ValueError, TypeError) as exc:
            raise PodSessionRefused(
                "not_local_authority", "malformed pod session", status=401
            ) from exc
        expected = hmac.new(self._session_key, body, hashlib.sha256).digest()
        if not hmac.compare_digest(presented, expected):
            raise PodSessionRefused(
                "bad_signature", "the session signature did not verify", status=401
            )
        try:
            claims = json.loads(body)
        except ValueError as exc:
            raise PodSessionRefused(
                "not_local_authority", "malformed pod session", status=401
            ) from exc
        if not isinstance(claims, dict):
            raise PodSessionRefused("not_local_authority", "malformed pod session", status=401)
        if _clean(claims.get("hushh_id")) != self.hushh_id:
            raise PodSessionRefused("foreign_owner", "the session names another owner")
        if int(claims.get("exp") or 0) <= int(self._clock()):
            raise PodSessionRefused("expired", "the session has expired", status=401)
        role = _clean(claims.get("role"))
        if expected_role is not None and role != expected_role:
            raise PodSessionRefused("role_mismatch", f"a {expected_role}-role session is required")
        status = self._store.subject(_clean(claims.get("subject_id")))
        if status.state != "trusted" or status.trust is None:
            raise PodSessionRefused("revoked", "this subject is no longer trusted")
        if int(claims.get("version") or 0) < status.trust.version:
            raise PodSessionRefused("stale_version", "a newer binding superseded this session")
        return claims

    async def renew(self, token: Any) -> tuple[str, dict[str, Any]]:
        await self.require_held()
        claims = self.verify_session(token)
        trust = self._store.subject(claims["subject_id"]).trust
        if trust is None:  # pragma: no cover - verify_session guarantees a trusted subject
            raise PodSessionRefused("revoked", "this subject is no longer trusted")
        binding = PodBindingV1.from_mapping(trust.binding)
        if self._clock() * 1000 >= binding.expires_at_ms:
            raise PodSessionRefused(
                "expired", "the binding behind this session has expired", status=401
            )
        return self.mint_session(binding)

    # -- verifier seam --------------------------------------------------------------

    def local_token(self, claims: Mapping[str, Any]) -> str:
        """The stand-in the turn path carries where a hub token used to travel."""
        return f"{LOCAL_TOKEN_PREFIX}{_clean(claims.get('sid'))}"

    def local_verifier(self, claims: Mapping[str, Any]) -> Callable[..., Any]:
        """A ``verify_consent``-shaped callable answering from this session and the log.

        It re-reads the tombstones on every call, so a revocation that lands in the
        middle of a turn refuses the next tool, exactly as the hub path would.
        """
        session = dict(claims)
        expected_token = self.local_token(session)

        async def verify(
            token: str, *, expected_scope: str = "", **_ignored: Any
        ) -> ConsentVerdict:
            if _clean(token) != expected_token:
                return ConsentVerdict(valid=False, available=True, reason="not local authority")
            if self._store.subject(_clean(session.get("subject_id"))).state != "trusted":
                return ConsentVerdict(valid=False, available=True, reason="subject revoked")
            return ConsentVerdict.from_local_session(session, expected_scope=expected_scope)

        return verify

    # -- revocation -----------------------------------------------------------------

    async def revoke_subject(
        self, subject_id: str, *, at_version: Optional[int] = None, reason: str = ""
    ) -> TombstoneRecord:
        subject = _clean(subject_id)
        version = (
            at_version if at_version is not None else max(1, self._store.highest_version(subject))
        )
        try:
            return await self._store.record_tombstone(
                subject, at_version=int(version), reason=reason
            )
        except PodAuthorityError as exc:
            raise PodSessionRefused(exc.code, exc.detail, status=400) from exc

    # -- reporting ------------------------------------------------------------------

    def subjects_report(self) -> list[dict[str, Any]]:
        """Trusted and revoked subjects, shape only: ids, roles, versions, platform."""
        report: list[dict[str, Any]] = []
        seen: set[str] = set()
        for record in self._store.trusted_subjects():
            seen.add(record.subject_id)
            report.append(
                {
                    "subjectId": record.subject_id,
                    "role": record.role,
                    "version": record.version,
                    "platform": _clean(record.binding.get("platform")),
                    "scopes": list(record.binding.get("scopes") or []),
                    "state": "trusted",
                }
            )
        for tomb in self._store.tombstones():
            if tomb.subject_id in seen:
                continue
            report.append(
                {
                    "subjectId": tomb.subject_id,
                    "atVersion": tomb.at_version,
                    "state": "revoked",
                    "reason": tomb.reason,
                }
            )
        return report


# -- the tombstone courier, pod side -----------------------------------------------------------

TOMBSTONE_INTENT_KIND = "pod_tombstone_intent_v1"
_TOMBSTONE_INTENT_KEYS = frozenset(
    {"kind", "intentId", "hushhId", "subjectId", "atVersion", "issuedAtMs", "signerSubjectId"}
)


async def apply_pending_tombstones(
    payload: Any, *, authority: Optional[PodSessionAuthority] = None
) -> list[str]:
    """Apply owner-signed revocations the hub couriered on a heartbeat. Returns applied ids.

    The hub is a courier and nothing more: each intent is verified HERE against the
    signer's key as recorded in this pod's own trust store, and only a trusted
    app-role subject may sign one. A foreign owner, an unknown or device-role
    signer, a bad signature or a malformed intent applies nothing and is not
    reported as applied, so the hub keeps offering it and the log shows why.
    """
    authority = authority if authority is not None else active_session_authority()
    if authority is None:
        return []
    entries = (payload or {}).get("pendingTombstones") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return []
    applied: list[str] = []
    for entry in entries[:64]:
        intent = entry.get("intent") if isinstance(entry, dict) else None
        signature = entry.get("signature") if isinstance(entry, dict) else None
        if not isinstance(intent, dict) or set(intent) != _TOMBSTONE_INTENT_KEYS:
            logger.warning("pod_tombstone.malformed")
            continue
        intent_id = _clean(intent.get("intentId"))
        if intent.get("kind") != TOMBSTONE_INTENT_KIND or not intent_id:
            logger.warning("pod_tombstone.malformed")
            continue
        if _clean(intent.get("hushhId")) != authority.hushh_id:
            logger.warning("pod_tombstone.foreign_owner")
            continue
        at_version = intent.get("atVersion")
        if isinstance(at_version, bool) or not isinstance(at_version, int) or at_version < 1:
            logger.warning("pod_tombstone.malformed")
            continue
        signer = authority.store.subject(_clean(intent.get("signerSubjectId")))
        if signer.state != "trusted" or signer.trust is None or signer.trust.role != ROLE_APP:
            logger.warning("pod_tombstone.signer_not_trusted")
            continue
        signer_key = _clean(signer.trust.binding.get("subject_public_key"))
        if not verify_subject_proof(signer_key, canonical_json(intent), signature):
            logger.warning("pod_tombstone.bad_signature")
            continue
        subject_id = _clean(intent.get("subjectId"))
        try:
            await authority.revoke_subject(subject_id, at_version=at_version, reason="owner_intent")
        except PodSessionRefused as exc:
            logger.warning("pod_tombstone.refused code=%s", exc.code)
            continue
        try:
            from hushh_mcp.services.puppy_broker import BROKER  # noqa: PLC0415

            await BROKER.close_subject(subject_id)
        except Exception:  # noqa: BLE001 - the tombstone is the authority
            pass
        applied.append(intent_id)
        logger.info("pod_tombstone.applied at_version=%s", at_version)
    return applied


# -- process-wide active copy ------------------------------------------------------------------

_ACTIVE: Optional[PodSessionAuthority] = None


def active_session_authority() -> Optional[PodSessionAuthority]:
    return _ACTIVE


def set_active_session_authority(authority: Optional[PodSessionAuthority]) -> None:
    global _ACTIVE
    _ACTIVE = authority


async def build_pod_session_authority(*, instance_id: Optional[str] = None) -> PodSessionAuthority:
    """Pod startup: claim the incarnation, replay the authority records, derive the session key.

    Raises on every failure. The caller (``pod_server._pod_startup``) logs and leaves the
    active copy unset, and the routes answer 503 "local authority unavailable" rather
    than admitting anyone on a half-built authority.
    """
    from hushh_mcp.services.byoc_key_custody import resolve_pod_log_key  # noqa: PLC0415
    from hushh_mcp.services.pod_authority_store import (  # noqa: PLC0415
        claim_incarnation,
        set_active_authority_store,
    )
    from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415
    from hushh_mcp.services.pod_self_registration import pod_keypair  # noqa: PLC0415

    hushh_id = _clean(os.getenv("HUSSH_ID"))
    log = _resolve_log()
    if log is None:
        raise RuntimeError("this pod has no durable log; local authority stays unavailable")
    store_backend = getattr(log, "_store", None)
    if store_backend is None:
        raise RuntimeError("the pod log exposes no object store for the incarnation fence")
    dek = resolve_pod_log_key()
    incarnation = await claim_incarnation(
        store_backend,
        dek,
        instance_id=_clean(instance_id or os.getenv("K_REVISION")) or secrets.token_hex(8),
    )
    store = PodAuthorityStore(log, hushh_id=hushh_id)
    await store.load()
    keypair = pod_keypair()
    authority = PodSessionAuthority(
        store=store,
        lease=IncarnationLease(store_backend, incarnation),
        dek=dek,
        pod_key_id=keypair.key_id,
        pod_public_key=keypair.public_key_b64,
    )
    set_active_authority_store(store)
    set_active_session_authority(authority)
    logger.info(
        "pod_session_authority.ready epoch=%s subjects=%s",
        incarnation.epoch,
        len(store.trusted_subjects()),
    )
    return authority


__all__ = [
    "APP_SCOPES",
    "BINDING_KIND",
    "CHALLENGE_PURPOSE",
    "CHALLENGE_TTL_SECONDS",
    "DEVICE_INFERENCE_SCOPES",
    "DEVICE_SCOPES",
    "LOCAL_TOKEN_PREFIX",
    "ROLE_APP",
    "ROLE_BY_PLATFORM",
    "ROLE_DEVICE",
    "SCOPE_PKM_READ",
    "SCOPE_POD_CONFIG",
    "SCOPE_POD_REVOKE",
    "SCOPE_POD_STATUS",
    "SCOPE_PUPPY_INFERENCE",
    "SESSION_PREFIX",
    "SESSION_TTL_SECONDS",
    "PodBindingV1",
    "PodSessionAuthority",
    "PodSessionRefused",
    "active_session_authority",
    "build_pod_session_authority",
    "canonical_json",
    "challenge_signing_payload",
    "derive_session_key",
    "expected_environment",
    "role_for_platform",
    "set_active_session_authority",
    "verify_subject_proof",
]
