"""Provider-keyed runtime client factory.

Replaces the Gemini-only branches with a registry-keyed factory. Gemini still
returns the real ``genai.Client``; every other provider returns a native
transport adapter that honors the same genai-client contract. Provider choice
is orthogonal to credential mode: BYOK uses the user's turn-bounded key, while
managed Gemini uses Vertex workload ADC and never falls back to a hosted key.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from .registry import ProviderId, normalize_provider
from .vertex_failover import VertexRegionalClient

GENAI_AUTH_MODE_ENV = "HUSHH_GENAI_AUTH_MODE"
VERTEX_ADC_AUTH_MODE = "vertex_adc"
DEVELOPER_API_KEY_AUTH_MODE = "developer_api_key"
VERTEX_LOCATIONS_ENV = "HUSHH_VERTEX_LOCATIONS"
VERTEX_LOCATION_COOLDOWN_SECONDS_ENV = "HUSHH_VERTEX_LOCATION_COOLDOWN_SECONDS"
_HOSTED_ENVIRONMENTS = {"dev", "uat", "staging", "production", "prod"}
_PROJECT_ENV_NAMES = (
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "GOOGLE_PROJECT",
    "GCLOUD_PROJECT",
    "VERTEX_PROJECT_ID",
)
GeminiByokTransport = Literal["developer_api", "vertex_api_key"]


def _clean_env(name: str) -> str:
    return str(os.getenv(name) or "").strip()


def _deployment_environment() -> str:
    return (_clean_env("HUSHH_DEPLOY_ENV") or _clean_env("ENVIRONMENT")).lower()


def _managed_genai_auth_mode() -> str:
    mode = (_clean_env(GENAI_AUTH_MODE_ENV) or VERTEX_ADC_AUTH_MODE).lower()
    if mode not in {VERTEX_ADC_AUTH_MODE, DEVELOPER_API_KEY_AUTH_MODE}:
        raise RuntimeError(
            f"{GENAI_AUTH_MODE_ENV} must be {VERTEX_ADC_AUTH_MODE!r} or "
            f"{DEVELOPER_API_KEY_AUTH_MODE!r}"
        )
    if mode == DEVELOPER_API_KEY_AUTH_MODE and _deployment_environment() in _HOSTED_ENVIRONMENTS:
        raise RuntimeError("Hosted Gemini runtimes must use Vertex ADC")
    if mode == VERTEX_ADC_AUTH_MODE and _deployment_environment() in _HOSTED_ENVIRONMENTS:
        vertex_enabled = _clean_env("GOOGLE_GENAI_USE_VERTEXAI").lower()
        if vertex_enabled not in {"1", "true", "yes", "on"}:
            raise RuntimeError("Hosted Gemini runtimes require GOOGLE_GENAI_USE_VERTEXAI=true")
    return mode


def _vertex_project() -> str:
    for name in _PROJECT_ENV_NAMES:
        project = _clean_env(name)
        if project:
            return project

    if _deployment_environment() in _HOSTED_ENVIRONMENTS:
        raise RuntimeError("Hosted Vertex ADC requires GOOGLE_CLOUD_PROJECT")

    try:
        import google.auth

        _, detected_project = google.auth.default()
    except Exception as exc:
        raise RuntimeError(
            "Vertex ADC is unavailable; configure workload ADC and GOOGLE_CLOUD_PROJECT"
        ) from exc
    project = str(detected_project or "").strip()
    if not project:
        raise RuntimeError("Vertex ADC requires GOOGLE_CLOUD_PROJECT")
    return project


def _vertex_location() -> str:
    location = (
        _clean_env("GOOGLE_CLOUD_LOCATION")
        or _clean_env("GCP_LOCATION")
        or _clean_env("VERTEX_LOCATION")
    )
    if location:
        return location
    if _deployment_environment() in _HOSTED_ENVIRONMENTS:
        raise RuntimeError("Hosted Vertex ADC requires GOOGLE_CLOUD_LOCATION")
    return "global"


def _vertex_locations() -> tuple[str, ...]:
    primary = _vertex_location()
    configured = tuple(
        value.strip() for value in _clean_env(VERTEX_LOCATIONS_ENV).split(",") if value.strip()
    )
    ordered = (primary, *configured)
    return tuple(dict.fromkeys(ordered))


def _vertex_location_cooldown_seconds() -> float:
    raw = _clean_env(VERTEX_LOCATION_COOLDOWN_SECONDS_ENV)
    if not raw:
        return 300.0
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{VERTEX_LOCATION_COOLDOWN_SECONDS_ENV} must be numeric") from exc
    if value < 0:
        raise RuntimeError(f"{VERTEX_LOCATION_COOLDOWN_SECONDS_ENV} must be non-negative")
    return value


def _gemini_client(
    api_key: str,
    *,
    managed: bool,
    byok_transport: GeminiByokTransport = "developer_api",
    vertex_project: str | None = None,
    vertex_location: str | None = None,
) -> Any:
    from google import genai

    if not managed:
        # BYOK is deliberately isolated from backend ADC and environment keys.
        if byok_transport == "vertex_api_key":
            project = (vertex_project or "").strip()
            location = (vertex_location or "").strip()
            if not project or not location:
                raise ValueError("Vertex API-key BYOK requires project and location")
            # This is a Google Cloud/Gemini Enterprise API key, not a Gemini
            # Developer API key. Never infer the endpoint from key shape.
            return genai.Client(
                vertexai=True,
                api_key=api_key,
                project=project,
                location=location,
            )
        return genai.Client(vertexai=False, api_key=api_key)

    mode = _managed_genai_auth_mode()
    if mode == DEVELOPER_API_KEY_AUTH_MODE:
        key = (
            (api_key or "").strip()
            or _clean_env("GEMINI_API_KEY")
            or _clean_env("GOOGLE_API_KEY")
            or _clean_env("GOOGLE_GENAI_API_KEY")
        )
        if not key:
            raise RuntimeError("Developer Gemini API key is not configured")
        return genai.Client(vertexai=False, api_key=key)

    # Hosted managed Gemini always uses the Cloud Run service identity through
    # ADC. Never pass or fall back to a long-lived API key in this mode.
    project = _vertex_project()
    locations = _vertex_locations()
    if len(locations) == 1:
        return genai.Client(vertexai=True, project=project, location=locations[0])
    return VertexRegionalClient(
        project=project,
        locations=locations,
        client_factory=genai.Client,
        cooldown_seconds=_vertex_location_cooldown_seconds(),
    )


def _build(
    provider: ProviderId,
    api_key: str,
    *,
    managed: bool,
    gemini_byok_transport: GeminiByokTransport = "developer_api",
    vertex_project: str | None = None,
    vertex_location: str | None = None,
) -> Any:
    if provider == "gemini":
        return _gemini_client(
            api_key,
            managed=managed,
            byok_transport=gemini_byok_transport,
            vertex_project=vertex_project,
            vertex_location=vertex_location,
        )
    if provider == "anthropic":
        from .anthropic_transport import AnthropicTransport

        return AnthropicTransport(api_key=api_key)
    if provider == "openai":
        from .openai_transport import OpenAITransport

        return OpenAITransport(api_key=api_key, provider="openai")
    if provider == "grok":
        from .openai_transport import GROK_BASE_URL, OpenAITransport

        return OpenAITransport(api_key=api_key, base_url=GROK_BASE_URL, provider="grok")
    # normalize_provider already rejects unknown providers, so this is defensive.
    raise ValueError(f"Unsupported runtime provider: {provider!r}")


def build_runtime_client(
    runtime_provider: str,
    user_key: str,
    *,
    gemini_byok_transport: GeminiByokTransport = "developer_api",
    vertex_project: str | None = None,
    vertex_location: str | None = None,
) -> Any:
    """BYOK client: the user supplies the key for the chosen provider."""

    provider = normalize_provider(runtime_provider)
    key = (user_key or "").strip()
    if not key:
        raise ValueError("User BYOK runtime key is required")
    if gemini_byok_transport not in {"developer_api", "vertex_api_key"}:
        raise ValueError("Unsupported Gemini BYOK transport")
    return _build(
        provider,
        key,
        managed=False,
        gemini_byok_transport=gemini_byok_transport,
        vertex_project=vertex_project,
        vertex_location=vertex_location,
    )


def build_managed_runtime_client(runtime_provider: str, managed_credential: str = "") -> Any:
    """Hushh-managed client.

    Gemini uses workload ADC in hosted environments. Other providers retain
    their explicit platform-credential contract until they gain an equivalent
    workload-identity mechanism.
    """

    provider = normalize_provider(runtime_provider)
    key = (managed_credential or "").strip()
    if provider != "gemini" and not key:
        raise RuntimeError("Managed runtime API key is not configured")
    return _build(provider, key, managed=True)
