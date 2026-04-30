from __future__ import annotations

import json
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

    if not str(os.getenv("IAPD_VERIFY_BASE_URL", "")).strip():
        raise RuntimeError("IAPD_VERIFY_BASE_URL is required in production.")

    if not str(os.getenv("IAPD_VERIFY_API_KEY", "")).strip():
        raise RuntimeError("IAPD_VERIFY_API_KEY is required in production.")

    if _env_truthy("ADVISORY_VERIFICATION_BYPASS_ENABLED") or _env_truthy("RIA_DEV_BYPASS_ENABLED"):
        raise RuntimeError(
            "ADVISORY_VERIFICATION_BYPASS_ENABLED / RIA_DEV_BYPASS_ENABLED must remain false in production."
        )

    if str(os.getenv("RIA_DEV_ALLOWLIST", "")).strip():
        raise RuntimeError("RIA_DEV_ALLOWLIST must not be set in production.")

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


def _contains_official_regulator_source(payload: dict[str, Any]) -> bool:
    verified_profiles = payload.get("verified_profiles")
    if not isinstance(verified_profiles, list):
        return False
    for item in verified_profiles:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or item.get("source_url") or "").lower()
        label = str(item.get("label") or item.get("platform") or "").lower()
        if (
            "brokercheck.finra.org" in url
            or "adviserinfo.sec.gov" in url
            or "sec.gov" in url
            or "finra" in label
            or "sec" in label
            or "brokercheck" in label
        ):
            return True
    return False


class RIAIntelligenceVerificationAdapter:
    """Verifies advisory identity by exact CRD + IAPD/IARD evidence."""

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_BASE_URL", "")).strip().rstrip("/")
        self._verify_url = str(os.getenv("RIA_INTELLIGENCE_VERIFY_URL", "")).strip()
        endpoint_path = str(
            os.getenv("RIA_INTELLIGENCE_VERIFY_ENDPOINT_PATH", "/v1/ria/profile")
        ).strip()
        if endpoint_path and not endpoint_path.startswith("/"):
            endpoint_path = f"/{endpoint_path}"
        self._endpoint_path = endpoint_path or "/v1/ria/profile"
        self._api_key = str(os.getenv("RIA_INTELLIGENCE_VERIFY_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("RIA_INTELLIGENCE_VERIFY_TIMEOUT_SECONDS", "25"))
        self._transport = transport

    async def verify(
        self,
        *,
        legal_name: str,
        finra_crd: str | None,
        sec_iard: str | None,
    ) -> VerificationResult:
        _ = legal_name
        request_url = self._verify_url or (
            f"{self._base_url}{self._endpoint_path}" if self._base_url else ""
        )
        if not request_url:
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification provider not configured",
                metadata={"provider": "ria_intelligence", "reason": "not_configured"},
            )

        normalized_crd = _normalize_crd(finra_crd)
        normalized_iard = _normalize_crd(sec_iard)
        query = " ".join(
            part
            for part in (
                f"CRD {normalized_crd}" if normalized_crd else "",
                f"IARD {normalized_iard}" if normalized_iard else "",
            )
            if part
        ).strip()
        if not query:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Individual CRD and Firm IAPD / IARD are required for verification.",
                metadata={"provider": "ria_intelligence", "reason": "missing_identifiers"},
            )

        if not normalized_crd:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Individual CRD is required for verification.",
                metadata={"provider": "ria_intelligence", "reason": "missing_crd"},
            )

        if not normalized_iard:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Firm IAPD / IARD is required for verification.",
                metadata={"provider": "ria_intelligence", "reason": "missing_iard"},
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
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification request failed",
                metadata={"provider": "ria_intelligence", "error": type(exc).__name__},
            )

        if response.status_code >= 500:
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification provider unavailable",
                metadata={"provider": "ria_intelligence", "status_code": response.status_code},
            )

        payload = response.json() if response.content else {}
        if not isinstance(payload, dict):
            return VerificationResult(
                verified=False,
                rejected=False,
                outcome="provider_unavailable",
                message="RIA intelligence verification returned invalid payload",
                metadata={"provider": "ria_intelligence", "status_code": response.status_code},
            )

        subject = payload.get("subject")
        subject_name = ""
        subject_crd = ""
        if isinstance(subject, dict):
            subject_name = str(subject.get("full_name") or "").strip()
            subject_crd = _normalize_crd(subject.get("crd_number"))

        source_urls: list[str] = []
        verified_profiles = payload.get("verified_profiles")
        if isinstance(verified_profiles, list):
            for item in verified_profiles:
                if isinstance(item, dict):
                    candidate_url = str(item.get("url") or item.get("source_url") or "").strip()
                    if candidate_url:
                        source_urls.append(candidate_url)

        official_source = _contains_official_regulator_source(payload)
        crd_matches = bool(subject_crd and subject_crd == normalized_crd)
        payload_digits = _normalize_crd(json.dumps(payload, ensure_ascii=True))
        iard_matches = bool(normalized_iard and normalized_iard in payload_digits)

        if subject_crd and subject_crd != normalized_crd:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="CRD does not match FINRA/SEC records for the provided identity.",
                metadata={
                    "provider": "ria_intelligence",
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd,
                    "input_crd_number": normalized_crd,
                    "source_urls": source_urls[:5],
                },
            )

        if crd_matches and not iard_matches:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message="Firm IAPD / IARD does not match the verified advisory record.",
                metadata={
                    "provider": "ria_intelligence",
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd or None,
                    "input_iard_number": normalized_iard,
                    "source_urls": source_urls[:5],
                },
            )

        if official_source and crd_matches and iard_matches:
            return VerificationResult(
                verified=True,
                rejected=False,
                outcome="verified",
                message="Regulatory identity verified by CRD and Firm IAPD / IARD evidence.",
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
                metadata={
                    "provider": "ria_intelligence",
                    "subject_full_name": subject_name,
                    "subject_crd_number": subject_crd or None,
                    "input_iard_number": normalized_iard,
                    "source_urls": source_urls[:5],
                },
            )

        no_match_message = ""
        unverified = payload.get("unverified_or_not_found")
        if isinstance(unverified, list):
            for item in unverified:
                text = str(item or "").strip()
                lowered = text.lower()
                if "no confident finra or sec match" in lowered:
                    no_match_message = text
                    break

        if no_match_message:
            return VerificationResult(
                verified=False,
                rejected=True,
                outcome="rejected",
                message=no_match_message,
                metadata={
                    "provider": "ria_intelligence",
                    "subject_full_name": subject_name or None,
                    "subject_crd_number": subject_crd or None,
                    "input_iard_number": normalized_iard,
                    "source_urls": source_urls[:5],
                },
            )

        return VerificationResult(
            verified=False,
            rejected=False,
            outcome="provider_unavailable",
            message="RIA intelligence verification could not produce a terminal decision.",
            metadata={
                "provider": "ria_intelligence",
                "subject_full_name": subject_name or None,
                "subject_crd_number": subject_crd or None,
                "input_iard_number": normalized_iard,
                "source_urls": source_urls[:5],
            },
        )


class RIAIntelligenceStage1LookupAdapter:
    _cache: dict[str, _Stage1LookupCacheEntry] = {}
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
        self._cache_ttl_seconds = int(os.getenv("RIA_INTELLIGENCE_STAGE1_CACHE_TTL_SECONDS", "300"))

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
    ) -> tuple[dict[str, Any] | None, NameVerificationResult | None]:
        request_url = self._verify_url or (
            f"{self._base_url}{self._endpoint_path}" if self._base_url else ""
        )
        if not request_url:
            return None, NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification provider not configured",
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "reason": "not_configured"},
            )

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        request_body: dict[str, Any] = {"query": query}

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
                headers=headers,
            ) as client:
                response = await client.post(
                    request_url,
                    json=request_body,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ria.intelligence_stage1_request_failed: %s", exc)
            return None, NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification request failed",
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "error": type(exc).__name__},
            )

        if response.status_code >= 400:
            return None, NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification provider unavailable",
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "status_code": response.status_code},
            )

        try:
            payload = response.json() if response.content else {}
        except Exception as exc:  # noqa: BLE001
            return None, NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification returned invalid JSON",
                provider=self._provider_label,
                metadata={
                    "provider": self._provider_label,
                    "status_code": response.status_code,
                    "error": type(exc).__name__,
                },
            )
        if not isinstance(payload, dict):
            return None, NameVerificationResult(
                status="provider_unavailable",
                reason="RIA intelligence verification returned invalid payload",
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "status_code": response.status_code},
            )
        return payload, None

    def _cache_key(self, query: str) -> str:
        return _normalize_identity_text(query)

    @classmethod
    def _prune_expired_cache(cls, now: datetime) -> None:
        expired_keys = [key for key, entry in cls._cache.items() if entry.expires_at <= now]
        for key in expired_keys:
            cls._cache.pop(key, None)

    def _get_cached_result(
        self,
        query: str,
    ) -> NameVerificationResult | None:
        now = datetime.now(timezone.utc)
        self._prune_expired_cache(now)
        entry = self._cache.get(self._cache_key(query))
        if entry is None or entry.expires_at <= now:
            return None
        return entry.result

    def _store_cached_result(
        self,
        query: str,
        result: NameVerificationResult,
    ) -> None:
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
                provider=self._provider_label,
                metadata={"provider": self._provider_label, "reason": "missing_query"},
            )

        if use_cache:
            cached = self._get_cached_result(normalized_query)
            if cached is not None:
                return cached

        payload, error = await self._request_payload(query=normalized_query)
        if error is not None:
            return error
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
        metadata = {"provider": self._provider_label, "source_urls": source_urls}

        normalized_result_crd = _normalize_crd(crd_number)
        if exists_on_finra and not normalized_result_crd:
            result = NameVerificationResult(
                status="not_verified",
                matched_name=matched_name,
                crd_number=crd_number,
                current_firm=current_firm,
                sec_number=sec_number,
                reason="Verification did not return a CRD-backed advisor record. Onboarding stays blocked.",
                reason_code="no_confident_match",
                suggested_names=suggested_names,
                provider=self._provider_label,
                metadata={**metadata, "reason_code": "missing_crd"},
            )
            self._store_cached_result(normalized_query, result)
            return result

        if exists_on_finra and normalized_result_crd:
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
