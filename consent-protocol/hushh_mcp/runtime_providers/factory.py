"""Provider-keyed runtime client factory.

Replaces the Gemini-only branches with a registry-keyed factory. Gemini still
returns the real ``genai.Client``; every other provider returns a native
transport adapter that honors the same genai-client contract. Provider choice
is orthogonal to credential mode: BYOK uses the user's turn-bounded key, while
managed Gemini uses Vertex workload ADC and never falls back to a hosted key.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Literal

from google.genai.types import HttpOptionsDict

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
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_LOCATION_RE = re.compile(r"^(?:global|us|eu|[a-z]+-[a-z]+[0-9]+)$")
_PROJECT_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")


class GeminiByokTransportUnsupportedError(ValueError):
    """Raised when a caller names a Gemini transport outside the typed contract."""


def _vertex_api_key_http_options(location: str) -> HttpOptionsDict:
    """Bind a Vertex API-key request to its selected regional endpoint.

    google-genai treats ``project``/``location`` and ``api_key`` as mutually
    exclusive constructor inputs. Vertex API keys are already bound to their
    Cloud project, so retain the project as validated user configuration while
    selecting the regional endpoint through the supported HTTP option.
    """
    base_url = (
        "https://aiplatform.googleapis.com/"
        if location == "global"
        else f"https://{location}-aiplatform.googleapis.com/"
    )
    return HttpOptionsDict(base_url=base_url)


@dataclass(frozen=True)
class ManagedGeminiRuntimeBinding:
    """Canonical managed Gemini/Vertex runtime resolved from one environment contract.

    The binding contains endpoint metadata only. Credentials remain owned by ADC
    and are acquired/refreshed by Google libraries from the attached Cloud Run
    service identity. It is safe to construct once per process and must never be
    serialized into a user session or browser payload.
    """

    project: str
    locations: tuple[str, ...]
    auth_mode: str

    @classmethod
    def from_environment(cls) -> "ManagedGeminiRuntimeBinding":
        mode = _managed_genai_auth_mode()
        if mode == DEVELOPER_API_KEY_AUTH_MODE:
            # Local-only compatibility mode. It remains explicit and cannot be
            # selected in a hosted environment.
            return cls(project="", locations=(), auth_mode=mode)
        return cls(
            project=_vertex_project(),
            locations=_vertex_locations(),
            auth_mode=mode,
        )

    @property
    def primary_location(self) -> str:
        if not self.locations:
            raise RuntimeError("Managed Vertex binding has no configured location")
        return self.locations[0]

    def validate_model(self, model: str, *, location: str | None = None) -> str:
        clean_model = str(model or "").strip()
        if not clean_model or not _MODEL_ID_RE.fullmatch(clean_model):
            raise ValueError("Managed Gemini model identifier is invalid")
        if location is not None and not _LOCATION_RE.fullmatch(str(location).strip()):
            raise ValueError("Managed Vertex location is invalid")
        return clean_model

    def locations_for_model(self, model: str) -> tuple[str, ...]:
        """Return configured endpoints compatible with the model contract."""
        from .registry import resolve_model_entry

        clean_model = self.validate_model(model)
        supported = resolve_model_entry("gemini", clean_model).supported_vertex_locations
        if not supported:
            return self.locations
        locations = tuple(location for location in self.locations if location in supported)
        if not locations:
            raise RuntimeError(
                f"Managed Gemini model {clean_model!r} has no configured supported Vertex location"
            )
        return locations

    def build_direct_client(self, *, model: str | None = None) -> Any:
        from google import genai

        if self.auth_mode == DEVELOPER_API_KEY_AUTH_MODE:
            key = (
                _clean_env("GEMINI_API_KEY")
                or _clean_env("GOOGLE_API_KEY")
                or _clean_env("GOOGLE_GENAI_API_KEY")
            )
            if not key:
                raise RuntimeError("Developer Gemini API key is not configured")
            return genai.Client(vertexai=False, api_key=key)

        locations = self.locations_for_model(model) if model else self.locations
        if len(locations) == 1:
            return genai.Client(
                vertexai=True,
                project=self.project,
                location=locations[0],
            )
        return VertexRegionalClient(
            project=self.project,
            locations=locations,
            client_factory=genai.Client,
            cooldown_seconds=_vertex_location_cooldown_seconds(),
        )

    def build_adk_model(self, model: str, *, location: str | None = None) -> Any:
        from google.adk.models import Gemini

        clean_location = str(location or "").strip() or (
            self.primary_location if self.auth_mode == VERTEX_ADC_AUTH_MODE else ""
        )
        clean_model = self.validate_model(
            model,
            location=clean_location or None,
        )
        if self.auth_mode == DEVELOPER_API_KEY_AUTH_MODE:
            key = (
                _clean_env("GEMINI_API_KEY")
                or _clean_env("GOOGLE_API_KEY")
                or _clean_env("GOOGLE_GENAI_API_KEY")
            )
            if not key:
                raise RuntimeError("Developer Gemini API key is not configured")
            return Gemini(
                model=clean_model,
                client_kwargs={"vertexai": False, "api_key": key},
            )
        return Gemini(
            model=clean_model,
            client_kwargs={
                "vertexai": True,
                "project": self.project,
                "location": clean_location,
            },
        )


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
            project = str(vertex_project or "").strip()
            location = str(vertex_location or "").strip()
            if not _PROJECT_RE.fullmatch(project) or not location:
                raise ValueError(
                    "Vertex API-key BYOK requires a valid Google Cloud project and location"
                )
            if not _LOCATION_RE.fullmatch(location):
                raise ValueError("Vertex API-key BYOK location is invalid")
            # The API key itself is bound to the selected owner project. The
            # SDK rejects project/location alongside an API key, so project is
            # validated at the contract edge and location binds this endpoint.
            del project
            return genai.Client(
                vertexai=True,
                api_key=api_key,
                http_options=_vertex_api_key_http_options(location),
            )
        return genai.Client(vertexai=False, api_key=api_key)

    # Hosted managed Gemini always uses the Cloud Run service identity through
    # ADC. Never pass or fall back to a long-lived API key in this mode.
    return ManagedGeminiRuntimeBinding.from_environment().build_direct_client()


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


def build_managed_gemini_adk_model(
    model: str,
    *,
    vertex_location: str | None = None,
) -> Any:
    """Build an ADK Gemini model from the canonical managed auth contract.

    ADK accepts a bare model name, but doing so makes it rediscover credentials
    and endpoint settings from ambient process state. Keep Agent Chat, One, and
    its ADK specialists on the same explicit auth/project/location resolver as
    every direct google-genai caller.

    ADK owns its internal client, so regional retry remains a direct-client
    capability. This function deliberately pins the configured primary region;
    it does not pretend to provide ``VertexRegionalClient`` failover.
    """

    return ManagedGeminiRuntimeBinding.from_environment().build_adk_model(
        model,
        location=vertex_location,
    )


def build_gemini_byok_adk_model(
    model: str,
    api_key: str,
    *,
    transport: GeminiByokTransport = "developer_api",
    vertex_project: str | None = None,
    vertex_location: str | None = None,
) -> Any:
    """Build a turn-local ADK BYOK model with an explicit endpoint.

    Developer API BYOK always pins ``vertexai=False`` so an ambient managed
    Vertex environment cannot capture the user's key. Vertex API-key BYOK
    explicitly names the owner's project and location.
    """
    from google.adk.models import Gemini

    clean_model = str(model or "").strip()
    clean_key = str(api_key or "").strip()
    if not clean_model or not _MODEL_ID_RE.fullmatch(clean_model):
        raise ValueError("Gemini BYOK ADK model identifier is invalid")
    if not clean_key:
        raise ValueError("Gemini BYOK credential is required")
    if transport == "vertex_api_key":
        project = str(vertex_project or "").strip()
        location = str(vertex_location or "").strip()
        if not _PROJECT_RE.fullmatch(project) or not _LOCATION_RE.fullmatch(location):
            raise ValueError(
                "Vertex API-key BYOK requires a valid Google Cloud project and location"
            )
        return Gemini(
            model=clean_model,
            client_kwargs={
                "vertexai": True,
                "api_key": clean_key,
                "http_options": _vertex_api_key_http_options(location),
            },
        )
    return Gemini(
        model=clean_model,
        client_kwargs={"vertexai": False, "api_key": clean_key},
    )


def build_developer_api_live_client(api_key: str) -> Any:
    """Direct google-genai client for developer_api-transport Live models.

    Used by the deploy-time managed-runtime verifier to probe the canonical
    live model when its GEMINI_LIVE_COMPATIBILITY transport is developer_api
    (e.g. gemini-3.1-flash-live-preview, which is not published on Vertex).
    Pins ``vertexai=False`` so an ambient managed Vertex environment can never
    capture the managed live key. Client construction stays centralized here
    per test_genai_client_construction_is_centralized.
    """
    from google import genai

    clean_key = str(api_key or "").strip()
    if not clean_key:
        raise ValueError("Developer API live client requires an API key")
    return genai.Client(vertexai=False, api_key=clean_key)
