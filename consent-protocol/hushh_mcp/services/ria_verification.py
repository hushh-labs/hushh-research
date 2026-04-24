from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _runtime_environment() -> str:
    for name in ("APP_ENV", "ENVIRONMENT", "HUSHH_ENV", "ENV"):
        value = str(os.getenv(name, "")).strip().lower()
        if value:
            return value
    return ""


def _is_production() -> bool:
    return _runtime_environment() in {"prod", "production"}


def validate_regulated_runtime_configuration() -> None:
    if not _is_production():
        return

    verify_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_URL", "")).strip()
    verify_base_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "")).strip()
    if not verify_url and not verify_base_url:
        raise RuntimeError(
            "RIA_INTELLIGENCE_VERIFY_BASE_URL or RIA_INTELLIGENCE_VERIFY_URL is required in production."
        )

    if _env_truthy("ADVISORY_VERIFICATION_BYPASS_ENABLED") or _env_truthy("RIA_DEV_BYPASS_ENABLED"):
        raise RuntimeError(
            "ADVISORY_VERIFICATION_BYPASS_ENABLED / RIA_DEV_BYPASS_ENABLED must remain false in production."
        )

    if _env_truthy("BROKER_VERIFICATION_BYPASS_ENABLED"):
        raise RuntimeError("BROKER_VERIFICATION_BYPASS_ENABLED must remain false in production.")

    if _env_truthy("BROKER_CAPABILITY_ENABLED"):
        if not str(os.getenv("BROKER_VERIFY_BASE_URL", "")).strip():
            raise RuntimeError(
                "BROKER_VERIFY_BASE_URL is required when BROKER_CAPABILITY_ENABLED=true in production."
            )
        if not str(os.getenv("BROKER_VERIFY_API_KEY", "")).strip():
            raise RuntimeError(
                "BROKER_VERIFY_API_KEY is required when BROKER_CAPABILITY_ENABLED=true in production."
            )


@dataclass(frozen=True)
class VerificationResult:
    verified: bool
    rejected: bool
    outcome: str
    message: str
    expires_at: datetime | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NameVerificationResult:
    status: str
    matched_name: str | None = None
    crd_number: str | None = None
    current_firm: str | None = None
    sec_number: str | None = None
    reason: str | None = None
    reason_code: str | None = None
    suggested_names: list[str] = field(default_factory=list)
    provider: str = "ria_intelligence_stage1"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class _Stage1LookupCacheEntry:
    expires_at: datetime
    result: NameVerificationResult


def _normalize_identity_text(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def _normalize_crd(value: str | None) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _normalize_stage1_path(value: str | None) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return "/v1/ria/profile/stage1"
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    if normalized.rstrip("/") == "/v1/ria/profile":
        return "/v1/ria/profile/stage1"
    return normalized


def _normalize_stage1_url(value: str | None) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    if normalized.rstrip("/").endswith("/v1/ria/profile"):
        return f"{normalized.rstrip('/')}/stage1"
    return normalized


def _reason_code_from_provider_reason(reason: str | None) -> str:
    normalized = str(reason or "").strip().lower()
    if not normalized:
        return "no_confident_match"
    broad_markers = (
        "too broad",
        "insufficiently specific",
        "more specific",
        "full last name",
        "full legal name",
        "firm context",
        "confidently identify a single",
    )
    if any(marker in normalized for marker in broad_markers):
        return "query_too_broad"
    return "no_confident_match"


class RIAIntelligenceVerificationAdapter:
    """Verifies advisory identity by exact CRD + IAPD/IARD evidence."""

    _provider_label = "ria_intelligence_stage1"

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "")).strip().rstrip("/")
        self._verify_url = _normalize_stage1_url(os.getenv("RIA_INTELLIGENCE_VERIFY_URL", ""))
        self._endpoint_path = _normalize_stage1_path(
            os.getenv("RIA_INTELLIGENCE_VERIFY_ENDPOINT_PATH", "/v1/ria/profile/stage1")
        )
        self._api_key = str(os.getenv("RIA_INTELLIGENCE_VERIFY_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("RIA_INTELLIGENCE_VERIFY_TIMEOUT_SECONDS", "60"))
        self._transport = transport

    @staticmethod
    def _profile_payload(payload: dict[str, Any]) -> dict[str, Any]:
        profile = payload.get("profile")
        return profile if isinstance(profile, dict) else {}

    @classmethod
    def _suggested_names(cls, payload: dict[str, Any]) -> list[str]:
        profile = cls._profile_payload(payload)
        value = profile.get("suggestedNames")
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            candidate = str(item or "").strip()
            if candidate:
                out.append(candidate)
        return out

    @classmethod
    def _not_found_reason(cls, payload: dict[str, Any]) -> str:
        profile = cls._profile_payload(payload)
        candidate = str(profile.get("reasonIfNotExists") or "").strip()
        if candidate:
            return candidate
        return "No confident FINRA or SEC match was found for the query."

    @classmethod
    def _source_urls(cls, payload: dict[str, Any]) -> list[str]:
        sources = payload.get("sources")
        if not isinstance(sources, list):
            return []
        out: list[str] = []
        for item in sources:
            if not isinstance(item, dict):
                continue
            candidate = str(item.get("uri") or item.get("url") or "").strip()
            if candidate:
                out.append(candidate)
        return out[:5]

    async def _request_payload(
        self,
        *,
        query: str,
    ) -> tuple[dict[str, Any] | None, VerificationResult | None]:
        request_url = self._verify_url or (
            f"{self._base_url}{self._endpoint_path}" if self._base_url else ""
        )
        if not request_url:
            return None, VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification provider not configured",
                metadata={"provider": self._provider_label, "reason": "not_configured"},
            )

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
                headers=headers,
            ) as client:
                response = await client.post(
                    request_url,
                    json={"query": query},
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ria.intelligence_verification_request_failed: %s", exc)
            return None, VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification request failed",
                metadata={"provider": self._provider_label, "error": type(exc).__name__},
            )

        if response.status_code >= 500:
            return None, VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification provider unavailable",
                metadata={"provider": self._provider_label, "status_code": response.status_code},
            )

        payload = response.json() if response.content else {}
        if not isinstance(payload, dict):
            return None, VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification returned invalid payload",
                metadata={"provider": self._provider_label, "status_code": response.status_code},
            )
        return payload, None

    async def verify(
        self,
        *,
        legal_name: str,
        finra_crd: str | None,
        sec_iard: str | None,
    ) -> VerificationResult:
        normalized_query = str(legal_name or "").strip()
        if not normalized_query:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Individual legal name is required for verification.",
                metadata={"provider": self._provider_label, "reason": "missing_name"},
            )

        normalized_crd = _normalize_crd(finra_crd)
        normalized_iard = _normalize_crd(sec_iard)
        if not normalized_crd:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Individual CRD is required for verification.",
                metadata={"provider": self._provider_label, "reason": "missing_crd"},
            )

        if not normalized_iard:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Firm IAPD / IARD is required for verification.",
                metadata={"provider": self._provider_label, "reason": "missing_iard"},
            )

        payload, error = await self._request_payload(query=normalized_query)
        if error is not None:
            return error
        if payload is None:
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification returned no payload.",
                metadata={"provider": self._provider_label, "reason": "missing_payload"},
            )

        profile = self._profile_payload(payload)
        exists_on_finra = bool(profile.get("existsOnFinra") is True)
        subject_name = str(profile.get("fullName") or normalized_query).strip()
        subject_crd_raw = str(profile.get("crdNumber") or "").strip()
        subject_crd = _normalize_crd(subject_crd_raw)
        subject_iard_raw = str(profile.get("secNumber") or "").strip()
        subject_iard = _normalize_crd(subject_iard_raw)
        source_urls = self._source_urls(payload)

        if not exists_on_finra or not subject_crd:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message=self._not_found_reason(payload),
                metadata={
                    "provider": self._provider_label,
                    "subject_full_name": subject_name or None,
                    "subject_crd_number": subject_crd_raw or None,
                    "input_iard_number": sec_iard,
                    "suggested_names": self._suggested_names(payload),
                    "source_urls": source_urls,
                },
            )

        if subject_crd != normalized_crd:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="CRD does not match FINRA/SEC records for the provided identity.",
                metadata={
                    "provider": self._provider_label,
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd_raw or subject_crd,
                    "input_crd_number": normalized_crd,
                    "source_urls": source_urls,
                },
            )

        if not subject_iard:
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence stage 1 returned no firm IAPD / IARD evidence.",
                metadata={
                    "provider": self._provider_label,
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd_raw or subject_crd,
                    "input_iard_number": sec_iard,
                    "source_urls": source_urls,
                },
            )

        if subject_iard != normalized_iard:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Firm IAPD / IARD does not match the verified advisory record.",
                metadata={
                    "provider": self._provider_label,
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd_raw or subject_crd,
                    "subject_sec_number": subject_iard_raw or subject_iard,
                    "input_iard_number": sec_iard,
                    "source_urls": source_urls,
                },
            )

        return VerificationResult(
            verified=True,
            rejected=False,
            outcome="verified",
            message="Regulatory identity verified by stage 1 CRD and firm IAPD / IARD evidence.",
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            metadata={
                "provider": self._provider_label,
                "subject_full_name": subject_name,
                "subject_crd_number": subject_crd_raw or subject_crd,
                "subject_sec_number": subject_iard_raw or subject_iard,
                "input_iard_number": sec_iard,
                "source_urls": source_urls,
            },
        )


class RIAIntelligenceStage1LookupAdapter(RIAIntelligenceVerificationAdapter):
    _cache: dict[str, _Stage1LookupCacheEntry] = {}

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(transport=transport)
        self._cache_ttl_seconds = int(
            os.getenv("RIA_INTELLIGENCE_STAGE1_CACHE_TTL_SECONDS", "300")
        )

    def _cache_key(self, query: str) -> str:
        return _normalize_identity_text(query)

    @classmethod
    def _prune_expired_cache(cls, now: datetime) -> None:
        expired_keys = [key for key, entry in cls._cache.items() if entry.expires_at <= now]
        for key in expired_keys:
            cls._cache.pop(key, None)

    def _get_cached_result(self, query: str) -> NameVerificationResult | None:
        now = datetime.now(timezone.utc)
        self._prune_expired_cache(now)
        entry = self._cache.get(self._cache_key(query))
        if entry is None or entry.expires_at <= now:
            return None
        return entry.result

    def _store_cached_result(self, query: str, result: NameVerificationResult) -> None:
        if result.status not in {"verified", "not_verified"} or self._cache_ttl_seconds <= 0:
            return
        self._prune_expired_cache(datetime.now(timezone.utc))
        self._cache[self._cache_key(query)] = _Stage1LookupCacheEntry(
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=self._cache_ttl_seconds),
            result=result,
        )

    async def verify_name(
        self,
        *,
        query: str,
        use_cache: bool = True,
    ) -> NameVerificationResult:
        normalized_query = str(query or "").strip()
        if not normalized_query:
            return NameVerificationResult(
                status="not_verified",
                reason="query must not be blank",
                reason_code="no_confident_match",
                metadata={"provider": self._provider_label, "reason": "missing_query"},
            )

        if use_cache:
            cached = self._get_cached_result(normalized_query)
            if cached is not None:
                return cached

        payload, error = await self._request_payload(query=normalized_query)
        if error is not None:
            return NameVerificationResult(
                status="provider_unavailable",
                reason=error.message,
                provider=self._provider_label,
                metadata=error.metadata,
            )
        if payload is None:
            return NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification returned no payload.",
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "reason": "missing_payload"},
            )

        profile = self._profile_payload(payload)
        exists_on_finra = bool(profile.get("existsOnFinra") is True)
        matched_name = str(profile.get("fullName") or normalized_query).strip() or None
        crd_number = str(profile.get("crdNumber") or "").strip() or None
        current_firm = str(profile.get("currentFirm") or "").strip() or None
        sec_number = str(profile.get("secNumber") or "").strip() or None
        suggested_names = self._suggested_names(payload)
        not_found_reason = self._not_found_reason(payload)
        reason_code = _reason_code_from_provider_reason(not_found_reason)
        source_urls = self._source_urls(payload)
        metadata = {
            "provider": self._provider_label,
            "source_urls": source_urls,
        }

        if exists_on_finra and _normalize_crd(crd_number):
            result = NameVerificationResult(
                status="verified",
                matched_name=matched_name,
                crd_number=crd_number,
                current_firm=current_firm,
                sec_number=sec_number,
                provider=self._provider_label,
                metadata=metadata,
            )
            self._store_cached_result(normalized_query, result)
            return result

        result = NameVerificationResult(
            status="not_verified",
            matched_name=matched_name,
            crd_number=crd_number,
            current_firm=current_firm,
            sec_number=sec_number,
            reason=not_found_reason,
            reason_code=reason_code,
            suggested_names=suggested_names,
            provider=self._provider_label,
            metadata={
                **metadata,
                "reason_code": reason_code,
                "suggested_names": suggested_names,
            },
        )
        self._store_cached_result(normalized_query, result)
        return result


class IapdVerificationAdapter:
    """Official advisory verification path via the app's IAPD worker/service."""

    def __init__(self) -> None:
        self._base_url = str(os.getenv("IAPD_VERIFY_BASE_URL", "")).strip().rstrip("/")
        self._api_key = str(os.getenv("IAPD_VERIFY_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("IAPD_VERIFY_TIMEOUT_SECONDS", "5"))

    async def verify(
        self,
        *,
        individual_legal_name: str,
        individual_crd: str,
        advisory_firm_legal_name: str,
        advisory_firm_iapd_number: str,
        force_live: bool = False,
    ) -> VerificationResult:
        if (
            not force_live
            and not _is_production()
            and (
                _env_truthy("ADVISORY_VERIFICATION_BYPASS_ENABLED")
                or _env_truthy("RIA_DEV_BYPASS_ENABLED")
            )
        ):
            return VerificationResult(
                verified=True,
                rejected=False,
                outcome="bypassed",
                message="Advisory verification bypassed in this non-production environment.",
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
                metadata={"provider": "advisory_bypass", "reason": "bypass_enabled"},
            )

        if not self._base_url or not self._api_key:
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="IAPD verification provider not configured. Set IAPD_VERIFY_BASE_URL and IAPD_VERIFY_API_KEY.",
                metadata={"provider": "iapd", "reason": "not_configured"},
            )

        payload = {
            "individual_legal_name": individual_legal_name,
            "individual_crd": individual_crd,
            "advisory_firm_legal_name": advisory_firm_legal_name,
            "advisory_firm_iapd_number": advisory_firm_iapd_number,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    f"{self._base_url}/verify-advisory",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                if response.status_code >= 500:
                    return VerificationResult(
                        verified=False,
                        rejected=False,
                        outcome="provider_unavailable",
                        message="IAPD verification provider unavailable",
                        metadata={"provider": "iapd", "status_code": response.status_code},
                    )
                data = response.json() if response.content else {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("ria.iapd_verification_request_failed: %s", exc)
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="IAPD verification provider request failed",
                metadata={"provider": "iapd", "error": type(exc).__name__},
            )

        verified = bool(data.get("verified") is True)
        rejected = bool(data.get("rejected") is True)
        if verified:
            ttl_days = int(data.get("ttl_days") or 30)
            return VerificationResult(
                verified=True,
                rejected=False,
                outcome="verified",
                message="IAPD verification successful",
                expires_at=datetime.now(timezone.utc) + timedelta(days=ttl_days),
                metadata={
                    "provider": "iapd",
                    "reference_id": data.get("reference_id"),
                    "source_url": data.get("source_url"),
                },
            )

        if rejected:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message=str(data.get("message") or "IAPD verification rejected"),
                metadata={
                    "provider": "iapd",
                    "reference_id": data.get("reference_id"),
                    "reason_code": data.get("reason_code"),
                    "source_url": data.get("source_url"),
                },
            )

        return VerificationResult(
            verified=False,
            rejected=False,
            outcome="provider_unavailable",
            message="IAPD verification did not return a terminal decision",
            metadata={"provider": "iapd"},
        )


class BrokerVerificationAdapter:
    """Broker capability verification with official verification and evidence-only fallback."""

    def __init__(self) -> None:
        self._base_url = str(os.getenv("BROKER_VERIFY_BASE_URL", "")).strip().rstrip("/")
        self._api_key = str(os.getenv("BROKER_VERIFY_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("BROKER_VERIFY_TIMEOUT_SECONDS", "5"))
        self._public_fallback_enabled = str(
            os.getenv("BROKER_PUBLIC_FALLBACK_ENABLED", "false")
        ).strip().lower() in {"1", "true", "yes", "on"}

    async def verify(
        self,
        *,
        individual_legal_name: str,
        individual_crd: str,
        broker_firm_legal_name: str,
        broker_firm_crd: str,
    ) -> VerificationResult:
        if not _is_production() and _env_truthy("BROKER_VERIFICATION_BYPASS_ENABLED"):
            return VerificationResult(
                verified=True,
                rejected=False,
                outcome="bypassed",
                message="Broker verification bypassed in this non-production environment.",
                expires_at=datetime.now(timezone.utc) + timedelta(days=1),
                metadata={"provider": "broker_bypass", "reason": "bypass_enabled"},
            )

        if not self._base_url or not self._api_key:
            if self._public_fallback_enabled:
                return VerificationResult(
                    verified=False,
                    rejected=False,
                    outcome="evidence_only",
                    message="Broker capability is awaiting official verification configuration",
                    metadata={
                        "provider": "broker_public_fallback",
                        "reason": "official_not_configured",
                    },
                )
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="Broker verification provider not configured",
                metadata={"provider": "broker", "reason": "not_configured"},
            )

        payload = {
            "individual_legal_name": individual_legal_name,
            "individual_crd": individual_crd,
            "broker_firm_legal_name": broker_firm_legal_name,
            "broker_firm_crd": broker_firm_crd,
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    f"{self._base_url}/verify-broker-capability",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                if response.status_code >= 500:
                    return VerificationResult(
                        verified=False,
                        rejected=False,
                        outcome="provider_unavailable",
                        message="Broker verification provider unavailable",
                        metadata={"provider": "broker", "status_code": response.status_code},
                    )
                data = response.json() if response.content else {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("ria.broker_verification_request_failed: %s", exc)
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="Broker verification provider request failed",
                metadata={"provider": "broker", "error": type(exc).__name__},
            )

        verified = bool(data.get("verified") is True)
        rejected = bool(data.get("rejected") is True)
        if verified:
            ttl_days = int(data.get("ttl_days") or 30)
            return VerificationResult(
                verified=True,
                rejected=False,
                outcome="verified",
                message="Broker verification successful",
                expires_at=datetime.now(timezone.utc) + timedelta(days=ttl_days),
                metadata={
                    "provider": "broker",
                    "reference_id": data.get("reference_id"),
                    "source_url": data.get("source_url"),
                },
            )

        if rejected:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message=str(data.get("message") or "Broker verification rejected"),
                metadata={
                    "provider": "broker",
                    "reference_id": data.get("reference_id"),
                    "reason_code": data.get("reason_code"),
                    "source_url": data.get("source_url"),
                },
            )

        return VerificationResult(
            verified=False,
            rejected=False,
            outcome="provider_unavailable",
            message="Broker verification did not return a terminal decision",
            metadata={"provider": "broker"},
        )


class RegulatoryVerificationGateway:
    def __init__(self) -> None:
        self._advisory_provider = IapdVerificationAdapter()
        self._broker_provider = BrokerVerificationAdapter()

    async def verify_advisory(
        self,
        *,
        individual_legal_name: str,
        individual_crd: str,
        advisory_firm_legal_name: str,
        advisory_firm_iapd_number: str,
    ) -> VerificationResult:
        return await self._advisory_provider.verify(
            individual_legal_name=individual_legal_name,
            individual_crd=individual_crd,
            advisory_firm_legal_name=advisory_firm_legal_name,
            advisory_firm_iapd_number=advisory_firm_iapd_number,
        )

    async def verify_brokerage(
        self,
        *,
        individual_legal_name: str,
        individual_crd: str,
        broker_firm_legal_name: str,
        broker_firm_crd: str,
    ) -> VerificationResult:
        return await self._broker_provider.verify(
            individual_legal_name=individual_legal_name,
            individual_crd=individual_crd,
            broker_firm_legal_name=broker_firm_legal_name,
            broker_firm_crd=broker_firm_crd,
        )


class FinraVerificationAdapter:
    """
    Backward-compatible adapter for legacy FINRA verification call sites.

    The new verification stack uses advisory verification naming backed by IAPD.
    This adapter preserves the older `verify(legal_name, finra_crd, sec_iard)` shape
    used by `RIAIAMService`.
    """

    def __init__(self) -> None:
        self._ria_intelligence_provider = RIAIntelligenceVerificationAdapter()
        self._advisory_provider = IapdVerificationAdapter()

    async def verify(
        self,
        *,
        legal_name: str,
        finra_crd: str | None,
        sec_iard: str | None,
        force_live: bool = False,
    ) -> VerificationResult:
        advisory_result = await self._advisory_provider.verify(
            individual_legal_name=legal_name,
            individual_crd=(finra_crd or "").strip(),
            advisory_firm_legal_name=legal_name,
            advisory_firm_iapd_number=(sec_iard or "").strip(),
            force_live=force_live,
        )
        if advisory_result.verified or advisory_result.rejected:
            return advisory_result

        intelligence_result = await self._ria_intelligence_provider.verify(
            legal_name=legal_name,
            finra_crd=finra_crd,
            sec_iard=sec_iard,
        )
        if intelligence_result.verified or intelligence_result.rejected:
            merged = dict(intelligence_result.metadata or {})
            merged.setdefault(
                "iapd_fallback",
                {
                    "outcome": advisory_result.outcome,
                    "message": advisory_result.message,
                },
            )
            return VerificationResult(
                verified=intelligence_result.verified,
                rejected=intelligence_result.rejected,
                outcome=intelligence_result.outcome,
                message=intelligence_result.message,
                expires_at=intelligence_result.expires_at,
                metadata=merged,
            )

        iapd_reason = str((advisory_result.metadata or {}).get("reason") or "").strip().lower()
        intelligence_reason = (
            str((intelligence_result.metadata or {}).get("reason") or "").strip().lower()
        )
        providers_unconfigured = (
            advisory_result.outcome == "provider_unavailable"
            and intelligence_result.outcome == "provider_unavailable"
            and iapd_reason == "not_configured"
            and intelligence_reason == "not_configured"
        )

        message = "No verification provider returned a terminal decision."
        if providers_unconfigured:
            message = (
                "Verification providers are not configured in this environment. "
                "Configure IAPD_VERIFY_* or RIA_INTELLIGENCE_VERIFY_* variables."
            )

        return VerificationResult(
            verified=False,
            rejected=False,
            outcome="provider_unavailable",
            message=message,
            metadata={
                "providers": {
                    "ria_intelligence": {
                        "outcome": intelligence_result.outcome,
                        "message": intelligence_result.message,
                        "metadata": intelligence_result.metadata,
                    },
                    "iapd": {
                        "outcome": advisory_result.outcome,
                        "message": advisory_result.message,
                        "metadata": advisory_result.metadata,
                    },
                }
            },
        )


@dataclass(frozen=True)
class DossierSubjectResult:
    full_name: str
    crd_number: str | None = None
    current_firm: str | None = None
    location: str | None = None


@dataclass(frozen=True)
class DossierVerifiedProfileResult:
    platform: str
    label: str
    url: str
    handle: str | None = None
    source_title: str = ""
    source_url: str = ""
    evidence_note: str = ""


@dataclass(frozen=True)
class DossierPublicImageResult:
    kind: str
    image_url: str
    source_page_url: str
    source_title: str = ""
    confidence_note: str = ""


@dataclass(frozen=True)
class DossierKeyFactResult:
    fact: str
    source_title: str
    source_url: str
    evidence_note: str = ""


@dataclass(frozen=True)
class PublicProfileDossierResult:
    """Structured result from the full dossier endpoint."""

    status: str  # "completed", "not_found", "partial", "failed"
    subject: DossierSubjectResult
    executive_summary: str = ""
    verified_profiles: list[DossierVerifiedProfileResult] = field(default_factory=list)
    public_images: list[DossierPublicImageResult] = field(default_factory=list)
    key_facts: list[DossierKeyFactResult] = field(default_factory=list)
    unverified_or_not_found: list[str] = field(default_factory=list)
    suggested_names: list[str] = field(default_factory=list)


class RIAIntelligenceDossierAdapter:
    """Fetches full public profile dossier from the RIA Intelligence API.

    Calls ``POST /v1/ria/profile`` which runs Stage 1 verification *plus*
    OpenAI dossier research, image discovery, and image ranking.  This is a
    long-running request (can take multiple minutes) so callers should invoke
    it from a background task, never from the request hot-path.
    """

    _provider_label = "ria_intelligence_dossier"

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "")).strip().rstrip("/")
        self._verify_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_URL", "")).strip()
        self._api_key = str(os.getenv("RIA_INTELLIGENCE_VERIFY_API_KEY", "")).strip()
        self._timeout_seconds = float(
            os.getenv("RIA_INTELLIGENCE_DOSSIER_TIMEOUT_SECONDS", "600")
        )
        self._transport = transport

    def _dossier_url(self) -> str:
        """Resolve the full dossier endpoint URL."""
        if self._verify_url:
            # If a full stage1 URL is set, derive the dossier URL from it
            # e.g. ".../v1/ria/profile/stage1" → ".../v1/ria/profile"
            base = self._verify_url.rstrip("/")
            if base.endswith("/stage1"):
                return base[: -len("/stage1")]
            # Otherwise just replace last path segment
            if "/v1/ria/profile" in base:
                idx = base.index("/v1/ria/profile")
                return base[: idx + len("/v1/ria/profile")]
            return base
        if self._base_url:
            return f"{self._base_url}/v1/ria/profile"
        return ""

    @staticmethod
    def _parse_subject(value: dict[str, Any] | None) -> DossierSubjectResult:
        if not isinstance(value, dict):
            return DossierSubjectResult(full_name="")
        return DossierSubjectResult(
            full_name=str(value.get("full_name") or "").strip(),
            crd_number=str(value.get("crd_number") or "").strip() or None,
            current_firm=str(value.get("current_firm") or "").strip() or None,
            location=str(value.get("location") or "").strip() or None,
        )

    @staticmethod
    def _parse_verified_profiles(value: Any) -> list[DossierVerifiedProfileResult]:
        if not isinstance(value, list):
            return []
        results: list[DossierVerifiedProfileResult] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            platform = str(item.get("platform") or "").strip()
            url = str(item.get("url") or "").strip()
            if not platform or not url:
                continue
            results.append(
                DossierVerifiedProfileResult(
                    platform=platform,
                    label=str(item.get("label") or "").strip(),
                    url=url,
                    handle=str(item.get("handle") or "").strip() or None,
                    source_title=str(item.get("source_title") or "").strip(),
                    source_url=str(item.get("source_url") or url).strip(),
                    evidence_note=str(item.get("evidence_note") or "").strip(),
                )
            )
        return results

    @staticmethod
    def _parse_public_images(value: Any) -> list[DossierPublicImageResult]:
        if not isinstance(value, list):
            return []
        results: list[DossierPublicImageResult] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            image_url = str(item.get("image_url") or "").strip()
            source_page_url = str(item.get("source_page_url") or "").strip()
            if not image_url or not source_page_url:
                continue
            results.append(
                DossierPublicImageResult(
                    kind=str(item.get("kind") or "headshot").strip(),
                    image_url=image_url,
                    source_page_url=source_page_url,
                    source_title=str(item.get("source_title") or "").strip(),
                    confidence_note=str(item.get("confidence_note") or "").strip(),
                )
            )
        return results

    @staticmethod
    def _parse_key_facts(value: Any) -> list[DossierKeyFactResult]:
        if not isinstance(value, list):
            return []
        results: list[DossierKeyFactResult] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            fact = str(item.get("fact") or "").strip()
            source_url = str(item.get("source_url") or "").strip()
            if not fact or not source_url:
                continue
            results.append(
                DossierKeyFactResult(
                    fact=fact,
                    source_title=str(item.get("source_title") or "").strip(),
                    source_url=source_url,
                    evidence_note=str(item.get("evidence_note") or "").strip(),
                )
            )
        return results

    @staticmethod
    def _parse_string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if isinstance(item, str) and str(item).strip()]

    async def fetch_dossier(self, *, query: str) -> PublicProfileDossierResult:
        """Fetch a full public profile dossier for the given advisor query.

        This is a **long-running** call (can take multiple minutes).
        Callers must invoke from a background task.
        """
        normalized_query = str(query or "").strip()
        if not normalized_query:
            return PublicProfileDossierResult(
                status="failed",
                subject=DossierSubjectResult(full_name=""),
                executive_summary="Query was blank.",
            )

        request_url = self._dossier_url()
        if not request_url:
            logger.warning("ria.dossier_adapter_not_configured")
            return PublicProfileDossierResult(
                status="failed",
                subject=DossierSubjectResult(full_name=normalized_query),
                executive_summary="RIA Intelligence dossier provider is not configured.",
            )

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
                headers=headers,
            ) as client:
                response = await client.post(
                    request_url,
                    json={"query": normalized_query},
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ria.dossier_request_failed: %s", exc)
            return PublicProfileDossierResult(
                status="failed",
                subject=DossierSubjectResult(full_name=normalized_query),
                executive_summary=f"Dossier request failed: {type(exc).__name__}",
            )

        if response.status_code >= 500:
            logger.warning(
                "ria.dossier_upstream_error status_code=%s", response.status_code
            )
            return PublicProfileDossierResult(
                status="failed",
                subject=DossierSubjectResult(full_name=normalized_query),
                executive_summary="RIA Intelligence dossier provider unavailable.",
            )

        try:
            payload = response.json() if response.content else {}
        except Exception:  # noqa: BLE001
            payload = {}

        if not isinstance(payload, dict):
            return PublicProfileDossierResult(
                status="failed",
                subject=DossierSubjectResult(full_name=normalized_query),
                executive_summary="Dossier returned invalid payload.",
            )

        subject = self._parse_subject(payload.get("subject"))
        executive_summary = str(payload.get("executive_summary") or "").strip()
        verified_profiles = self._parse_verified_profiles(payload.get("verified_profiles"))
        public_images = self._parse_public_images(payload.get("public_images"))
        key_facts = self._parse_key_facts(payload.get("key_facts"))
        unverified = self._parse_string_list(payload.get("unverified_or_not_found"))
        suggested_names = self._parse_string_list(payload.get("suggested_names"))

        # Determine status
        if not subject.full_name and not subject.crd_number:
            status = "not_found"
        elif not verified_profiles and not key_facts and not public_images:
            status = "partial"
        else:
            status = "completed"

        logger.info(
            "ria.dossier_fetched query=%s status=%s verified_profiles=%d public_images=%d key_facts=%d",
            normalized_query,
            status,
            len(verified_profiles),
            len(public_images),
            len(key_facts),
        )

        return PublicProfileDossierResult(
            status=status,
            subject=subject,
            executive_summary=executive_summary,
            verified_profiles=verified_profiles,
            public_images=public_images,
            key_facts=key_facts,
            unverified_or_not_found=unverified,
            suggested_names=suggested_names,
        )


class VerificationGateway:
    """
    Backward-compatible gateway wrapper for legacy `verify(...)` call sites.
    """

    def __init__(self, provider: FinraVerificationAdapter | None = None) -> None:
        self._provider = provider or FinraVerificationAdapter()

    async def verify(
        self,
        *,
        legal_name: str,
        finra_crd: str | None,
        sec_iard: str | None,
        force_live: bool = False,
    ) -> VerificationResult:
        return await self._provider.verify(
            legal_name=legal_name,
            finra_crd=finra_crd,
            sec_iard=sec_iard,
            force_live=force_live,
        )
