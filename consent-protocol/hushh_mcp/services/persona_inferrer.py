"""Persona inference — silent, public-data classification of a freshly signed-in
One user as a likely RIA (Registered Investment Adviser) candidate.

This powers the "soft prompt" onboarding posture: after a regular user signs in,
we run a best-effort, *public-data-only* enrichment lookup. If the signals point
to a registered investment adviser, persona state surfaces a ``ria_candidate``
flag so the home surface can offer a personalized "looks like you're an RIA —
verify your CRD" card instead of a generic, buried setup option.

Important boundaries:

* This produces a *suggestion*, never an entitlement. Regulatory access still
  flows exclusively through ``ria_verification`` (FINRA/SEC CRD + IAPD evidence).
* No consent receipt is written here. The receipt is recorded downstream, when
  the user actively engages the RIA onboarding flow.
* Enrichment uses publicly available data only. The real provider is gated
  behind explicit configuration, mirroring ``ria_verification``'s posture.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

PERSONA_RIA_CANDIDATE = "ria_candidate"
PERSONA_GENERAL = "general"

# Confidence at or above which the soft prompt is surfaced.
RIA_CANDIDATE_THRESHOLD = 0.6

# Public-profile role/keyword signals that move confidence toward RIA.
_RIA_SIGNAL_WEIGHTS: dict[str, float] = {
    "registered investment adviser": 0.5,
    "registered investment advisor": 0.5,
    "investment adviser representative": 0.45,
    "wealth management": 0.3,
    "wealth advisor": 0.3,
    "financial advisor": 0.25,
    "financial adviser": 0.25,
    "ria": 0.2,
    "fiduciary": 0.2,
    "portfolio management": 0.15,
    "estate planning": 0.1,
}

# Authoritative regulator hosts. A hit here is near-decisive on its own.
_REGULATOR_HOSTS = (
    "adviserinfo.sec.gov",
    "brokercheck.finra.org",
    "sec.gov",
)


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


def validate_persona_inference_runtime_configuration() -> None:
    """Fail fast if persona inference is misconfigured for production.

    The dev allowlist and any bypass must never ship enabled to production, and
    if enrichment is switched on the real provider must be fully configured.
    """
    if not _is_production():
        return

    if str(os.getenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", "")).strip():
        raise RuntimeError("PERSONA_INFER_DEV_RIA_ALLOWLIST must not be set in production.")

    if _env_truthy("PERSONA_INFER_DEV_BYPASS_ENABLED"):
        raise RuntimeError("PERSONA_INFER_DEV_BYPASS_ENABLED must remain false in production.")

    if _env_truthy("PERSONA_ENRICH_ENABLED"):
        if not str(os.getenv("PERSONA_ENRICH_BASE_URL", "")).strip():
            raise RuntimeError(
                "PERSONA_ENRICH_BASE_URL is required when PERSONA_ENRICH_ENABLED=true in production."
            )
        if not str(os.getenv("PERSONA_ENRICH_API_KEY", "")).strip():
            raise RuntimeError(
                "PERSONA_ENRICH_API_KEY is required when PERSONA_ENRICH_ENABLED=true in production."
            )


@dataclass(frozen=True)
class PersonaInferenceResult:
    persona: str
    confidence: float
    signals: list[str] = field(default_factory=list)
    provider: str = "persona_inferrer_v1"
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def is_ria_candidate(self) -> bool:
        return self.persona == PERSONA_RIA_CANDIDATE


def _general_result(provider: str, *, reason: str) -> PersonaInferenceResult:
    return PersonaInferenceResult(
        persona=PERSONA_GENERAL,
        confidence=0.0,
        signals=[],
        provider=provider,
        metadata={"reason": reason},
    )


def _normalize_email(value: str | None) -> str:
    return str(value or "").strip().lower()


def _email_domain(email: str) -> str:
    _, _, domain = _normalize_email(email).partition("@")
    return domain


def _parse_allowlist(raw: str) -> set[str]:
    return {entry.strip().lower() for entry in raw.split(",") if entry.strip()}


def classify_enrichment_payload(payload: dict[str, Any]) -> PersonaInferenceResult:
    """Score a public-profile enrichment payload into a persona result.

    Pure function so the scoring rules are unit-testable without any provider.
    """
    if not isinstance(payload, dict):
        return _general_result("persona_inferrer_v1", reason="empty_payload")

    haystack_parts: list[str] = []
    for key in ("headline", "summary", "title", "occupation", "bio", "description"):
        value = payload.get(key)
        if isinstance(value, str):
            haystack_parts.append(value)
    roles = payload.get("roles")
    if isinstance(roles, list):
        haystack_parts.extend(str(role) for role in roles)
    haystack = " ".join(haystack_parts).lower()

    signals: list[str] = []
    confidence = 0.0
    for phrase, weight in _RIA_SIGNAL_WEIGHTS.items():
        if phrase in haystack:
            signals.append(phrase)
            confidence += weight

    # An explicit CRD on a public profile is a strong adviser indicator.
    crd = str(payload.get("crd_number") or payload.get("crd") or "").strip()
    if crd:
        signals.append("crd_number")
        confidence += 0.4

    # A link to an official regulator profile is near-decisive.
    sources = payload.get("sources")
    if isinstance(sources, list):
        for item in sources:
            url = ""
            if isinstance(item, dict):
                url = str(item.get("url") or item.get("uri") or "").lower()
            elif isinstance(item, str):
                url = item.lower()
            if any(host in url for host in _REGULATOR_HOSTS):
                signals.append("regulator_source")
                confidence += 0.6
                break

    confidence = min(confidence, 1.0)
    persona = PERSONA_RIA_CANDIDATE if confidence >= RIA_CANDIDATE_THRESHOLD else PERSONA_GENERAL
    return PersonaInferenceResult(
        persona=persona,
        confidence=round(confidence, 4),
        signals=signals,
        provider="persona_inferrer_v1",
        metadata={"crd_number": crd} if crd else {},
    )


class PersonaEnrichmentProvider(Protocol):
    async def infer(self, *, full_name: str, email: str) -> PersonaInferenceResult: ...


class DevStubPersonaEnrichmentProvider:
    """Local/dev provider. Classifies allowlisted emails or domains as RIA
    candidates so the soft-prompt flow is exercisable without a live data vendor.
    """

    provider_name = "persona_dev_stub"

    def __init__(self) -> None:
        self._allowlist = _parse_allowlist(os.getenv("PERSONA_INFER_DEV_RIA_ALLOWLIST", ""))

    async def infer(self, *, full_name: str, email: str) -> PersonaInferenceResult:
        _ = full_name
        normalized = _normalize_email(email)
        domain = _email_domain(normalized)
        if normalized in self._allowlist or (domain and domain in self._allowlist):
            return PersonaInferenceResult(
                persona=PERSONA_RIA_CANDIDATE,
                confidence=1.0,
                signals=["dev_allowlist"],
                provider=self.provider_name,
                metadata={"matched": normalized in self._allowlist and normalized or domain},
            )
        return _general_result(self.provider_name, reason="not_allowlisted")


class HttpPersonaEnrichmentProvider:
    """Production provider. Posts the minimal identity tuple to a configured
    public-data enrichment endpoint and scores the response.
    """

    provider_name = "persona_http_enrich"

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base_url = str(os.getenv("PERSONA_ENRICH_BASE_URL", "")).strip().rstrip("/")
        endpoint_path = str(os.getenv("PERSONA_ENRICH_ENDPOINT_PATH", "/v1/persona/enrich")).strip()
        if endpoint_path and not endpoint_path.startswith("/"):
            endpoint_path = f"/{endpoint_path}"
        self._endpoint_path = endpoint_path or "/v1/persona/enrich"
        self._api_key = str(os.getenv("PERSONA_ENRICH_API_KEY", "")).strip()
        self._timeout_seconds = float(os.getenv("PERSONA_ENRICH_TIMEOUT_SECONDS", "15"))
        self._transport = transport

    async def infer(self, *, full_name: str, email: str) -> PersonaInferenceResult:
        if not self._base_url:
            return _general_result(self.provider_name, reason="not_configured")

        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"

        try:
            async with httpx.AsyncClient(
                transport=self._transport, timeout=self._timeout_seconds
            ) as client:
                response = await client.post(
                    f"{self._base_url}{self._endpoint_path}",
                    headers=headers,
                    json={"full_name": full_name, "email": email},
                )
        except httpx.HTTPError as exc:
            logger.warning("Persona enrichment request failed: %s", exc)
            return _general_result(self.provider_name, reason="provider_unavailable")

        if response.status_code != 200:
            logger.warning("Persona enrichment returned HTTP %s", response.status_code)
            return _general_result(self.provider_name, reason="provider_error")

        try:
            payload = response.json()
        except ValueError:
            return _general_result(self.provider_name, reason="invalid_response")

        result = classify_enrichment_payload(payload if isinstance(payload, dict) else {})
        return PersonaInferenceResult(
            persona=result.persona,
            confidence=result.confidence,
            signals=result.signals,
            provider=self.provider_name,
            metadata=result.metadata,
        )


def build_persona_enrichment_provider(
    *, transport: httpx.AsyncBaseTransport | None = None
) -> PersonaEnrichmentProvider:
    """Select the provider based on configuration.

    Real enrichment only runs when ``PERSONA_ENRICH_ENABLED`` is truthy; otherwise
    the dev stub keeps the flow exercisable without contacting any external vendor.
    """
    if _env_truthy("PERSONA_ENRICH_ENABLED"):
        return HttpPersonaEnrichmentProvider(transport=transport)
    return DevStubPersonaEnrichmentProvider()


async def infer_persona(
    *,
    full_name: str,
    email: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> PersonaInferenceResult:
    """Best-effort persona inference. Never raises for inference failures —
    an unavailable provider degrades to a ``general`` (no-prompt) result.
    """
    normalized_email = _normalize_email(email)
    if not normalized_email:
        return _general_result("persona_inferrer_v1", reason="missing_email")

    provider = build_persona_enrichment_provider(transport=transport)
    try:
        return await provider.infer(full_name=str(full_name or "").strip(), email=normalized_email)
    except Exception as exc:  # noqa: BLE001 — inference must never block sign-in
        logger.warning("Persona inference failed, defaulting to general: %s", exc)
        return _general_result(
            getattr(provider, "provider_name", "persona_inferrer_v1"), reason="error"
        )
