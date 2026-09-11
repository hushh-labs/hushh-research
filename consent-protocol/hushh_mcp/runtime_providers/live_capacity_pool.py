"""Approved, server-owned capacity selection for Gemini Live setup.

The Live transport is intentionally *not* a generic API-key rotation layer.
Every target is declared by an operator in one bounded JSON configuration, and
credentials are resolved only by the server from a Secret Manager-mounted
environment variable or workload/service-account ADC.  The browser never sees
a target id, project, credential reference, or provider error.

Selection happens once while a WebSocket session is being constructed.  A
selected target is then immutable for that session: provider errors can open a
breaker for the *next* connection, but this module never moves an in-flight
audio stream, request, or resumption handle to another account.

Redis is optional.  When ``RATE_LIMIT_STORAGE_URI`` (or the dedicated pool
URL) points at Memorystore, breaker and affinity state are shared by Cloud Run
instances.  With no shared store, the same bounded policy works process-local.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Literal

from .dependency_health import PROVIDER_UNAVAILABLE, classify_provider_error
from .live_compatibility import GEMINI_LIVE_COMPATIBILITY
from .registry import resolve_model_entry

logger = logging.getLogger(__name__)

LIVE_CAPACITY_POOL_ENV = "HUSHH_GEMINI_LIVE_CAPACITY_POOL_JSON"
LIVE_CAPACITY_REDIS_URL_ENV = "HUSHH_GEMINI_LIVE_CAPACITY_REDIS_URL"
LIVE_CAPACITY_AFFINITY_KEY_ENV = "HUSHH_GEMINI_LIVE_AFFINITY_KEY"
DEFAULT_MANAGED_LIVE_CREDENTIAL_ENV = "HUSHH_MANAGED_GEMINI_LIVE_API_KEY"

_POOL_KEY_PREFIX = "agentone:gemini-live-capacity:v1"
_REDIS_TIMEOUT_SECONDS = 0.35
_TARGET_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_LOCATION_RE = re.compile(r"^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$")
_SERVICE_ACCOUNT_RE = re.compile(
    r"^[a-z][a-z0-9-]{0,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$"
)
_SECRET_ENV_RE = re.compile(r"^HUSHH_(?:MANAGED_)?GEMINI_LIVE_[A-Z0-9_]+$")
_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


class LiveCapacityConfigurationError(RuntimeError):
    """Raised when an operator-declared Live capacity pool is unsafe to use."""


def _vertex_location_supports_model(*, model: str, location: str) -> bool:
    """Return whether a pinned Vertex target can serve this exact model.

    A Live target is selected before any PCM is accepted, so this is the last
    safe place to reject an incompatible endpoint.  In particular, Gemini
    3.5 Transcribe Live currently exposes only ``global``; allowing a
    regional target merely defers the failure until the device reports an
    indistinguishable Live connection error.
    """

    supported = resolve_model_entry("gemini", model).supported_vertex_locations
    return not supported or location in supported


@dataclass(frozen=True)
class ManagedGeminiLiveTarget:
    """One approved server-side target for a new Gemini Live session.

    ``credential_env`` is a *reference*, never a key.  ``service_account`` is
    an optional target principal to impersonate for a Vertex target; omitting
    it uses the Cloud Run workload identity, which can be granted access to a
    separately billed project without distributing a service-account key.
    """

    target_id: str
    transport: Literal["developer_api", "vertex"]
    project: str
    model: str = ""
    location: str = ""
    service_account: str = ""
    credential_env: str = ""
    priority: int = 0

    def model_for(self, requested_model: str) -> str:
        return self.model or requested_model


@dataclass(frozen=True)
class ManagedGeminiLiveSelection:
    """Immutable result used to build one Live runner at connection setup."""

    target: ManagedGeminiLiveTarget
    model: str
    requested_model: str
    # True only when the selected target is the same server-side affinity as a
    # prior connection. The relay uses this to keep a provider resumption
    # handle on its original account, and drops it when setup fails over.
    affinity_reused: bool = False

    @property
    def uses_model_fallback(self) -> bool:
        return self.model != self.requested_model


def _clean_env(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _bounded_int(value: object, *, name: str, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise LiveCapacityConfigurationError(f"{name} must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise LiveCapacityConfigurationError(f"{name} is outside its allowed range")
    return parsed


def _parse_target(raw: object) -> ManagedGeminiLiveTarget:
    if not isinstance(raw, dict):
        raise LiveCapacityConfigurationError("Live capacity targets must be objects")
    # A capacity config is safe to keep in ordinary runtime configuration only
    # because it contains references, not credentials. Reject common direct
    # secret fields instead of silently ignoring a key an operator pasted.
    if any(
        raw.get(name) not in (None, "")
        for name in ("api_key", "credential", "key", "service_account_json")
    ):
        raise LiveCapacityConfigurationError(
            "Live capacity targets must reference server credentials, not contain them"
        )
    target_id = str(raw.get("id") or raw.get("target_id") or "").strip().lower()
    if not _TARGET_ID_RE.fullmatch(target_id):
        raise LiveCapacityConfigurationError("Live capacity target id is invalid")
    transport_value = str(raw.get("transport") or "").strip().lower()
    if transport_value not in {"developer_api", "vertex"}:
        raise LiveCapacityConfigurationError("Live capacity target transport is invalid")
    transport: Literal["developer_api", "vertex"] = (
        "vertex" if transport_value == "vertex" else "developer_api"
    )
    project = str(raw.get("project") or "").strip()
    if not _PROJECT_RE.fullmatch(project):
        raise LiveCapacityConfigurationError("Live capacity target project is invalid")
    model = str(raw.get("model") or "").strip()
    if model and model not in GEMINI_LIVE_COMPATIBILITY:
        raise LiveCapacityConfigurationError("Live capacity target model is not approved")
    location = str(raw.get("location") or "").strip()
    service_account = str(raw.get("service_account") or "").strip()
    credential_env = str(raw.get("credential_env") or "").strip()
    priority = _bounded_int(
        raw.get("priority"),
        name="Live capacity target priority",
        # Same-model targets default to one affinity-balanced tier. Operators
        # can name an explicit higher priority when they intend a strict
        # primary/standby chain; model fallback remains lower priority by
        # construction regardless of this value.
        default=0,
        minimum=0,
        maximum=10_000,
    )

    if transport == "vertex":
        if not _LOCATION_RE.fullmatch(location):
            raise LiveCapacityConfigurationError("Vertex Live capacity target location is invalid")
        if credential_env:
            raise LiveCapacityConfigurationError(
                "Vertex Live capacity targets use ADC, not a credential_env"
            )
        if service_account and not _SERVICE_ACCOUNT_RE.fullmatch(service_account):
            raise LiveCapacityConfigurationError(
                "Vertex Live capacity target service account is invalid"
            )
    else:
        if location or service_account:
            raise LiveCapacityConfigurationError(
                "Developer API Live capacity targets cannot name Vertex identity fields"
            )
        credential_env = credential_env or DEFAULT_MANAGED_LIVE_CREDENTIAL_ENV
        if not _SECRET_ENV_RE.fullmatch(credential_env):
            raise LiveCapacityConfigurationError(
                "Developer API Live capacity credential_env is not an approved server secret reference"
            )

    if model and GEMINI_LIVE_COMPATIBILITY[model].transport != transport:
        raise LiveCapacityConfigurationError(
            "Live capacity target model does not match its approved transport"
        )
    if (
        transport == "vertex"
        and model
        and not _vertex_location_supports_model(model=model, location=location)
    ):
        raise LiveCapacityConfigurationError(
            "Live capacity target location does not support its approved model"
        )
    return ManagedGeminiLiveTarget(
        target_id=target_id,
        transport=transport,
        project=project,
        model=model,
        location=location,
        service_account=service_account,
        credential_env=credential_env,
        priority=priority,
    )


class ManagedGeminiLiveCapacityPool:
    """Bounded target selector with optional shared breaker + affinity state."""

    def __init__(
        self,
        *,
        targets: tuple[ManagedGeminiLiveTarget, ...],
        failure_threshold: int,
        cooldown_seconds: int,
        affinity_ttl_seconds: int,
    ) -> None:
        if not targets:
            raise LiveCapacityConfigurationError("Live capacity pool needs at least one target")
        self.targets = targets
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self.affinity_ttl_seconds = affinity_ttl_seconds
        self._lock = threading.Lock()
        self._failure_counts: dict[str, tuple[int, float]] = {}
        self._open_until: dict[str, float] = {}
        self._affinity: dict[str, tuple[str, float]] = {}
        # A deployed service supplies APP_SIGNING_KEY; a generated process key
        # remains safe for local/test processes that deliberately do not load
        # the full app-security configuration. It means only cross-instance
        # affinity (not safety) degrades when no server secret exists.
        self._affinity_key = (
            _clean_env(LIVE_CAPACITY_AFFINITY_KEY_ENV)
            or _clean_env("APP_SIGNING_KEY")
            or secrets.token_urlsafe(32)
        ).encode("utf-8")
        self._redis_client = None

    @classmethod
    def from_json(cls, raw: str) -> "ManagedGeminiLiveCapacityPool":
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LiveCapacityConfigurationError(
                f"{LIVE_CAPACITY_POOL_ENV} must contain valid JSON"
            ) from exc
        if not isinstance(parsed, dict):
            raise LiveCapacityConfigurationError(
                f"{LIVE_CAPACITY_POOL_ENV} must contain a JSON object"
            )
        version = parsed.get("version", 1)
        if version != 1:
            raise LiveCapacityConfigurationError("Live capacity pool version is not supported")
        raw_targets = parsed.get("targets")
        if not isinstance(raw_targets, list) or not raw_targets or len(raw_targets) > 20:
            raise LiveCapacityConfigurationError(
                "Live capacity pool targets must contain 1 to 20 items"
            )
        targets = tuple(_parse_target(item) for item in raw_targets)
        if len({target.target_id for target in targets}) != len(targets):
            raise LiveCapacityConfigurationError("Live capacity target ids must be unique")
        return cls(
            targets=targets,
            failure_threshold=_bounded_int(
                parsed.get("failure_threshold"),
                name="Live capacity failure_threshold",
                default=1,
                minimum=1,
                maximum=10,
            ),
            cooldown_seconds=_bounded_int(
                parsed.get("cooldown_seconds"),
                name="Live capacity cooldown_seconds",
                default=60,
                minimum=5,
                maximum=3600,
            ),
            affinity_ttl_seconds=_bounded_int(
                parsed.get("affinity_ttl_seconds"),
                name="Live capacity affinity_ttl_seconds",
                default=3600,
                minimum=30,
                maximum=86_400,
            ),
        )

    def _redis_url(self) -> str:
        return _clean_env(LIVE_CAPACITY_REDIS_URL_ENV) or _clean_env("RATE_LIMIT_STORAGE_URI")

    def _get_redis_client(self):
        if self._redis_client is not None:
            return self._redis_client
        url = self._redis_url()
        if not url:
            return None
        try:
            from redis import asyncio as redis_asyncio

            self._redis_client = redis_asyncio.Redis.from_url(
                url,
                socket_timeout=_REDIS_TIMEOUT_SECONDS,
                socket_connect_timeout=_REDIS_TIMEOUT_SECONDS,
            )
        except Exception:  # pragma: no cover - dependency/config boundary
            logger.warning("gemini_live_capacity_redis_unavailable")
            return None
        return self._redis_client

    def _key(self, suffix: str) -> str:
        return f"{_POOL_KEY_PREFIX}:{suffix}"

    def _affinity_digest(self, affinity_key: str | None) -> str:
        clean = str(affinity_key or "").strip()
        if not clean:
            return ""
        return hmac.new(self._affinity_key, clean.encode("utf-8"), hashlib.sha256).hexdigest()

    def _target_for_id(self, target_id: str) -> ManagedGeminiLiveTarget | None:
        return next((target for target in self.targets if target.target_id == target_id), None)

    def _is_open_local(self, target_id: str) -> bool:
        now = time.monotonic()
        with self._lock:
            until = self._open_until.get(target_id, 0.0)
            if until <= now:
                self._open_until.pop(target_id, None)
                return False
            return True

    async def _is_open(self, target_id: str) -> bool:
        if self._is_open_local(target_id):
            return True
        client = self._get_redis_client()
        if client is None:
            return False
        try:
            raw = await client.get(self._key(f"open:{target_id}"))
        except Exception:
            logger.debug("gemini_live_capacity_redis_read_failed")
            return False
        if raw is None:
            return False
        # Redis can return bytes or str depending on deployment options.
        if str(raw.decode("utf-8") if isinstance(raw, bytes) else raw) != "1":
            return False
        with self._lock:
            self._open_until[target_id] = time.monotonic() + min(self.cooldown_seconds, 5)
        return True

    async def _get_affinity(self, digest: str) -> str | None:
        if not digest:
            return None
        now = time.monotonic()
        with self._lock:
            entry = self._affinity.get(digest)
            if entry is not None and entry[1] > now:
                return entry[0]
            self._affinity.pop(digest, None)
        client = self._get_redis_client()
        if client is None:
            return None
        try:
            raw = await client.get(self._key(f"affinity:{digest}"))
        except Exception:
            logger.debug("gemini_live_capacity_redis_read_failed")
            return None
        if raw is None:
            return None
        target_id = str(raw.decode("utf-8") if isinstance(raw, bytes) else raw).strip()
        if self._target_for_id(target_id) is None:
            return None
        with self._lock:
            self._affinity[digest] = (target_id, now + self.affinity_ttl_seconds)
        return target_id

    async def _set_affinity(self, digest: str, target_id: str) -> None:
        if not digest:
            return
        with self._lock:
            self._affinity[digest] = (
                target_id,
                time.monotonic() + self.affinity_ttl_seconds,
            )
        client = self._get_redis_client()
        if client is None:
            return
        try:
            await client.set(
                self._key(f"affinity:{digest}"),
                target_id,
                ex=self.affinity_ttl_seconds,
            )
        except Exception:
            logger.debug("gemini_live_capacity_redis_write_failed")

    def _compatible_candidates(
        self, requested_model: str
    ) -> list[tuple[ManagedGeminiLiveTarget, str]]:
        candidates: list[tuple[ManagedGeminiLiveTarget, str]] = []
        for target in self.targets:
            model = target.model_for(requested_model)
            compatibility = GEMINI_LIVE_COMPATIBILITY.get(model)
            if compatibility is None or compatibility.transport != target.transport:
                continue
            if target.transport == "vertex" and not _vertex_location_supports_model(
                model=model,
                location=target.location,
            ):
                continue
            candidates.append((target, model))
        return candidates

    def has_exact_model_target(self, requested_model: str) -> bool:
        """Whether declared capacity can serve ``requested_model`` unchanged.

        This is intentionally a configuration-only check: it does not read a
        breaker, affinity, Redis, ADC, or provider state.  Deployment
        validation uses it for transports that have no approved model fallback
        (currently the text-only Location command lane).  A generic Live
        session may still use ``select`` and its explicit fallback policy.
        """

        clean_model = str(requested_model or "").strip()
        if clean_model not in GEMINI_LIVE_COMPATIBILITY:
            return False
        return any(
            model == clean_model for _target, model in self._compatible_candidates(clean_model)
        )

    async def select(
        self,
        *,
        requested_model: str,
        affinity_key: str | None,
    ) -> ManagedGeminiLiveSelection | None:
        """Choose an approved, healthy target for one new session.

        No configured pool means the caller retains the legacy binding. Once a
        pool is configured, however, it is an allowlist: a model with no
        compatible approved target fails closed rather than silently escaping
        to an ambient project. If compatible targets are all cooling down, one
        is selected as a bounded probe instead of failing every new connection
        without contacting a provider.
        """
        clean_model = str(requested_model or "").strip()
        if clean_model not in GEMINI_LIVE_COMPATIBILITY:
            raise LiveCapacityConfigurationError("Requested Live model is not approved")
        candidates = self._compatible_candidates(clean_model)
        if not candidates:
            raise LiveCapacityConfigurationError(
                "Configured Live capacity pool has no target for the requested model"
            )
        digest = self._affinity_digest(affinity_key)
        affinity_target_id = await self._get_affinity(digest)
        if affinity_target_id:
            for target, model in candidates:
                if target.target_id == affinity_target_id and not await self._is_open(
                    target.target_id
                ):
                    return ManagedGeminiLiveSelection(
                        target=target,
                        model=model,
                        requested_model=clean_model,
                        affinity_reused=True,
                    )

        healthy = [
            (target, model)
            for target, model in candidates
            if not await self._is_open(target.target_id)
        ]
        # Every target cooling down is intentionally not a hard local outage:
        # make one deterministic probe. A recovering quota/project therefore
        # starts serving again without an operator clearing a latch.
        eligible = healthy or candidates
        # Keep the requested model primary. Explicit, rehearsed fallback
        # models (for example Vertex 2.5 Live) enter only after no requested
        # model target is healthy. Within a tier, target affinity distributes
        # new users deterministically without storing their raw identity.
        best_rank = min(
            (0 if model == clean_model else 1, target.priority) for target, model in eligible
        )
        ranked = [
            (target, model)
            for target, model in eligible
            if (0 if model == clean_model else 1, target.priority) == best_rank
        ]
        if len(ranked) == 1:
            target, model = ranked[0]
        else:
            stable_seed = digest or hashlib.sha256(clean_model.encode("utf-8")).hexdigest()
            target, model = min(
                ranked,
                key=lambda item: hashlib.sha256(
                    f"{stable_seed}:{item[0].target_id}".encode("utf-8")
                ).hexdigest(),
            )
        await self._set_affinity(digest, target.target_id)
        return ManagedGeminiLiveSelection(
            target=target,
            model=model,
            requested_model=clean_model,
        )

    async def record_setup_success(self, selection: ManagedGeminiLiveSelection) -> None:
        """Clear a breaker only after the selected session emits a live event."""
        target_id = selection.target.target_id
        with self._lock:
            self._failure_counts.pop(target_id, None)
            self._open_until.pop(target_id, None)
        client = self._get_redis_client()
        if client is None:
            return
        try:
            await client.delete(self._key(f"failures:{target_id}"), self._key(f"open:{target_id}"))
        except Exception:
            logger.debug("gemini_live_capacity_redis_write_failed")

    async def record_setup_failure(
        self,
        selection: ManagedGeminiLiveSelection,
        error: BaseException,
    ) -> bool:
        """Record only provider-side *setup* failures and maybe open a breaker.

        Invalid credentials and application/configuration faults deliberately do
        not trigger another project. That keeps failover from concealing a bad
        rollout or spraying a malformed request across all approved accounts.
        """
        classification = classify_provider_error(error)
        if classification != PROVIDER_UNAVAILABLE:
            return False
        target_id = selection.target.target_id
        now = time.monotonic()
        with self._lock:
            count, started_at = self._failure_counts.get(target_id, (0, now))
            if now - started_at > self.cooldown_seconds:
                count, started_at = 0, now
            count += 1
            self._failure_counts[target_id] = (count, started_at)
            opened = count >= self.failure_threshold
            if opened:
                self._open_until[target_id] = now + self.cooldown_seconds

        client = self._get_redis_client()
        if client is not None:
            try:
                count = int(await client.incr(self._key(f"failures:{target_id}")))
                await client.expire(self._key(f"failures:{target_id}"), self.cooldown_seconds)
                if count >= self.failure_threshold:
                    opened = True
                    await client.set(self._key(f"open:{target_id}"), "1", ex=self.cooldown_seconds)
            except Exception:
                logger.debug("gemini_live_capacity_redis_write_failed")
        if opened:
            logger.warning(
                "gemini_live_capacity_target_cooldown target=%s classification=%s",
                target_id,
                classification,
            )
        return opened


_pool_lock = threading.Lock()
_pool_source = ""
_pool_instance: ManagedGeminiLiveCapacityPool | None = None


def get_managed_gemini_live_capacity_pool() -> ManagedGeminiLiveCapacityPool | None:
    """Return the configured pool, or ``None`` to retain the legacy binding."""
    global _pool_instance, _pool_source
    raw = _clean_env(LIVE_CAPACITY_POOL_ENV)
    with _pool_lock:
        if raw == _pool_source:
            return _pool_instance
        _pool_source = raw
        _pool_instance = ManagedGeminiLiveCapacityPool.from_json(raw) if raw else None
        return _pool_instance


def reset_managed_gemini_live_capacity_pool_for_tests() -> None:
    """Clear process-local configuration/state between focused tests."""
    global _pool_instance, _pool_source
    with _pool_lock:
        _pool_instance = None
        _pool_source = ""


def resolve_managed_live_api_key(target: ManagedGeminiLiveTarget) -> str:
    """Resolve a Developer API key from its server-only secret reference."""
    if target.transport != "developer_api" or not target.credential_env:
        raise RuntimeError("managed_live_target_credential_invalid")
    key = _clean_env(target.credential_env)
    if not key:
        raise RuntimeError("managed_live_target_credential_missing")
    return key


def resolve_vertex_target_credentials(target: ManagedGeminiLiveTarget):
    """Return workload ADC or an impersonated ADC credential for a target.

    No JSON service-account key is accepted.  Workload Identity / Cloud Run ADC
    acquires and refreshes the source credential, then Google auth performs the
    documented target-principal impersonation when the operator configured one.
    """
    if target.transport != "vertex":
        raise RuntimeError("managed_live_target_credentials_invalid")
    if not target.service_account:
        return None
    try:
        import google.auth
        from google.auth import impersonated_credentials

        source_credentials, _ = google.auth.default(scopes=[_CLOUD_PLATFORM_SCOPE])
        return impersonated_credentials.Credentials(
            source_credentials=source_credentials,
            target_principal=target.service_account,
            target_scopes=[_CLOUD_PLATFORM_SCOPE],
            lifetime=3600,
        )
    except Exception as exc:  # noqa: BLE001 - fail closed at server setup
        raise RuntimeError("managed_live_target_adc_unavailable") from exc
