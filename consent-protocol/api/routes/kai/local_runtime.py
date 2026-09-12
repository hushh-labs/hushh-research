"""Metadata-only discovery for the optional local private-agent voice runtime.

The endpoint exposes a short-lived model download URL only after reading a
deployment-owned registry of immutable Cloud Storage objects. It never serves
model bytes, registry object names, user information, or a static signed URL
from an environment variable. Missing or invalid configuration fails closed to
the existing cloud/hybrid runtime.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal, Protocol
from urllib.parse import parse_qsl, urlparse

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logger = logging.getLogger(__name__)
router = APIRouter()

_REGISTRY_SECRET_ENV = "HUSHH_LOCAL_RUNTIME_PACK_REGISTRY_SECRET"  # noqa: S105 - env key, not a value
_REGISTRY_PROJECT_ENV = "HUSHH_LOCAL_RUNTIME_PACK_REGISTRY_PROJECT"
_SIGNER_SERVICE_ACCOUNT_ENV = "HUSHH_LOCAL_RUNTIME_PACK_SIGNER_SERVICE_ACCOUNT"
_URL_TTL_SECONDS_ENV = "HUSHH_LOCAL_RUNTIME_PACK_URL_TTL_SECONDS"
_REGISTRY_CACHE_SECONDS_ENV = "HUSHH_LOCAL_RUNTIME_PACK_REGISTRY_CACHE_SECONDS"
_SHA256_HEX = re.compile(r"^[0-9a-fA-F]{64}$")
_SOURCE_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
_PACK_RUNTIMES = {
    "sherpa_onnx_web",
    "onnxruntime_web",
    "onnxruntime_mobile",
    "fluid_audio",
}
_PACK_TASKS = {"ocr", "stt", "tts", "slm", "intent"}
_SIGNATURE_QUERY_KEYS = {
    "signature",
    "x-amz-signature",
    "x-goog-signature",
    "sig",
}
_EXPIRY_QUERY_KEYS = {"expires", "x-amz-expires", "x-goog-expires", "se"}
_REGISTRY_PROTOCOL = "one.voice.model-pack-registry.v1"
_DEFAULT_URL_TTL_SECONDS = 900
_DEFAULT_CACHE_SECONDS = 60
_MAX_URL_TTL_SECONDS = 900
_MAX_CACHE_SECONDS = 300


def _bounded_int(raw: str | None, default: int, maximum: int) -> int:
    try:
        value = int(str(raw or default).strip())
    except (TypeError, ValueError):
        return default
    return value if 1 <= value <= maximum else default


@dataclass(frozen=True)
class RuntimePackConfiguration:
    registry_secret: str
    registry_project: str
    signer_service_account: str
    url_ttl_seconds: int
    cache_seconds: int


def _runtime_pack_configuration() -> RuntimePackConfiguration | None:
    registry_secret = str(os.getenv(_REGISTRY_SECRET_ENV) or "").strip()
    signer_service_account = str(os.getenv(_SIGNER_SERVICE_ACCOUNT_ENV) or "").strip()
    registry_project = str(
        os.getenv(_REGISTRY_PROJECT_ENV) or os.getenv("GOOGLE_CLOUD_PROJECT") or ""
    ).strip()
    if not registry_secret or not signer_service_account or not registry_project:
        return None
    return RuntimePackConfiguration(
        registry_secret=registry_secret,
        registry_project=registry_project,
        signer_service_account=signer_service_account,
        url_ttl_seconds=_bounded_int(
            os.getenv(_URL_TTL_SECONDS_ENV), _DEFAULT_URL_TTL_SECONDS, _MAX_URL_TTL_SECONDS
        ),
        cache_seconds=_bounded_int(
            os.getenv(_REGISTRY_CACHE_SECONDS_ENV), _DEFAULT_CACHE_SECONDS, _MAX_CACHE_SECONDS
        ),
    )


class _PackMetadata(BaseModel):
    """Shared immutable metadata for a registry record and public pack."""

    model_config = ConfigDict(extra="forbid")

    pack_id: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=64)
    size_bytes: int = Field(gt=0)
    checksum: str = Field(min_length=64, max_length=128)
    min_ram_gb: float = Field(ge=0)
    min_storage_mb: float = Field(ge=0)
    languages: list[str] = Field(min_length=1, max_length=16)
    tasks: list[Literal["ocr", "stt", "tts", "slm", "intent"]] = Field(min_length=1, max_length=8)
    runtime: Literal[
        "sherpa_onnx_web",
        "onnxruntime_web",
        "onnxruntime_mobile",
        "fluid_audio",
    ]
    preprocessing_version: str = Field(min_length=1, max_length=64)
    entrypoint: str = Field(min_length=1, max_length=256)

    @field_validator("checksum")
    @classmethod
    def validate_checksum(cls, value: str) -> str:
        normalized = value.strip()
        if _SHA256_HEX.fullmatch(normalized):
            return normalized.lower()
        if len(normalized) == 44 and normalized.endswith("="):
            return normalized
        raise ValueError("checksum must be a SHA-256 digest")

    @field_validator("languages")
    @classmethod
    def validate_languages(cls, values: list[str]) -> list[str]:
        normalized = [value.strip().lower() for value in values if value.strip()]
        if len(normalized) != len(values) or len(set(normalized)) != len(normalized):
            raise ValueError("languages must be non-empty and unique")
        return normalized

    @field_validator("tasks")
    @classmethod
    def validate_tasks(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or any(value not in _PACK_TASKS for value in values):
            raise ValueError("tasks must be unique generated task ids")
        return values

    @field_validator("runtime")
    @classmethod
    def validate_runtime(cls, value: str) -> str:
        if value not in _PACK_RUNTIMES:
            raise ValueError("unsupported model pack runtime")
        return value


class VoiceModelPackManifest(_PackMetadata):
    """Public, non-sensitive metadata for one temporary pack download."""

    artifact_url: str = Field(min_length=1, max_length=2048)
    # These values prove which reviewed source and generated action catalog
    # produced a pack. They deliberately contain no object location, customer
    # information, or credential and are required for release matching.
    source_sha: str = Field(min_length=7, max_length=64)
    catalog_version: str = Field(min_length=1, max_length=128)
    license_notice_id: str = Field(min_length=1, max_length=128)
    license_approved: bool = False

    @field_validator("artifact_url")
    @classmethod
    def validate_artifact_url(cls, value: str) -> str:
        normalized = value.strip()
        parsed = urlparse(normalized)
        if parsed.scheme.lower() != "https":
            raise ValueError("artifact_url must use HTTPS")
        query_keys = {key.lower() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}
        if not (query_keys & _SIGNATURE_QUERY_KEYS and query_keys & _EXPIRY_QUERY_KEYS):
            raise ValueError("artifact_url must be a signed, expiring URL")
        return normalized

    @field_validator("source_sha")
    @classmethod
    def validate_public_source_sha(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not _SOURCE_SHA.fullmatch(normalized):
            raise ValueError("source_sha must be a git SHA")
        return normalized


class RegisteredVoiceModelPack(_PackMetadata):
    """Private immutable object reference kept only in Secret Manager."""

    bucket: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$")
    object_name: str = Field(min_length=1, max_length=1024)
    source_sha: str = Field(min_length=7, max_length=64)
    catalog_version: str = Field(min_length=1, max_length=128)
    license_notice_id: str = Field(min_length=1, max_length=128)
    license_approved: bool = False

    @field_validator("source_sha")
    @classmethod
    def validate_source_sha(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not _SOURCE_SHA.fullmatch(normalized):
            raise ValueError("source_sha must be a git SHA")
        return normalized

    @field_validator("object_name")
    @classmethod
    def validate_object_name(cls, value: str) -> str:
        normalized = value.strip().lstrip("/")
        if not normalized or ".." in normalized.split("/"):
            raise ValueError("object_name must be a normalized object path")
        return normalized

    @model_validator(mode="after")
    def require_fluid_audio_approval(self) -> "RegisteredVoiceModelPack":
        if self.runtime == "fluid_audio" and not self.license_approved:
            raise ValueError("fluid_audio pack requires recorded model-license approval")
        return self

    def public_manifest(self, artifact_url: str) -> VoiceModelPackManifest:
        return VoiceModelPackManifest(
            pack_id=self.pack_id,
            version=self.version,
            size_bytes=self.size_bytes,
            checksum=self.checksum,
            min_ram_gb=self.min_ram_gb,
            min_storage_mb=self.min_storage_mb,
            languages=self.languages,
            tasks=self.tasks,
            runtime=self.runtime,
            artifact_url=artifact_url,
            preprocessing_version=self.preprocessing_version,
            entrypoint=self.entrypoint,
            source_sha=self.source_sha,
            catalog_version=self.catalog_version,
            license_notice_id=self.license_notice_id,
            license_approved=self.license_approved,
        )


class VoiceModelPackRegistry(BaseModel):
    """Deployment-owned active/rollback registry with no bearer URLs."""

    model_config = ConfigDict(extra="forbid")

    protocol_version: Literal["one.voice.model-pack-registry.v1"]
    source_sha: str = Field(min_length=7, max_length=64)
    catalog_version: str = Field(min_length=1, max_length=128)
    active_packs: list[RegisteredVoiceModelPack] = Field(min_length=1, max_length=16)
    rollback_packs: list[RegisteredVoiceModelPack] = Field(default_factory=list, max_length=16)

    @field_validator("source_sha")
    @classmethod
    def validate_registry_source_sha(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not _SOURCE_SHA.fullmatch(normalized):
            raise ValueError("source_sha must be a git SHA")
        return normalized

    @model_validator(mode="after")
    def require_unique_active_packs(self) -> "VoiceModelPackRegistry":
        identifiers = [(pack.pack_id, pack.version) for pack in self.active_packs]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("active_packs must have unique pack/version pairs")
        return self


class LocalRuntimeCapability(BaseModel):
    model_config = ConfigDict(extra="forbid")

    processing_mode_contract: list[Literal["cloud", "hybrid", "on_device"]]
    offline_ready: bool
    installed_packs: list[VoiceModelPackManifest]
    available_packs: list[VoiceModelPackManifest]
    supported_tasks: list[Literal["ocr", "stt", "tts", "slm", "intent"]]
    fallback_mode: Literal["cloud", "hybrid"]


class PackRegistryReader(Protocol):
    def read(self, configuration: RuntimePackConfiguration) -> str: ...


class PackUrlSigner(Protocol):
    def sign(self, pack: RegisteredVoiceModelPack) -> str: ...


class GoogleSecretManagerRegistryReader:
    """Read the latest registry version at runtime, not Cloud Run boot time."""

    def read(self, configuration: RuntimePackConfiguration) -> str:
        from google.cloud import secretmanager

        client = secretmanager.SecretManagerServiceClient()
        name = (
            f"projects/{configuration.registry_project}/secrets/"
            f"{configuration.registry_secret}/versions/latest"
        )
        response = client.access_secret_version(request={"name": name})
        return response.payload.data.decode("utf-8")


class GoogleCloudStoragePackUrlSigner:
    """Use workload identity/ADC plus IAM signBlob; never a key file."""

    def __init__(self, configuration: RuntimePackConfiguration) -> None:
        self.configuration = configuration

    def sign(self, pack: RegisteredVoiceModelPack) -> str:
        import google.auth
        from google.auth.transport.requests import Request
        from google.cloud import storage

        credentials, detected_project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        request = Request()
        if not credentials.valid or credentials.expired or not credentials.token:
            credentials.refresh(request)
        client = storage.Client(
            project=self.configuration.registry_project or detected_project,
            credentials=credentials,
        )
        return (
            client.bucket(pack.bucket)
            .blob(pack.object_name)
            .generate_signed_url(
                version="v4",
                expiration=timedelta(seconds=self.configuration.url_ttl_seconds),
                method="GET",
                service_account_email=self.configuration.signer_service_account,
                access_token=credentials.token,
            )
        )


def _create_registry_reader() -> PackRegistryReader:
    return GoogleSecretManagerRegistryReader()


def _create_url_signer(configuration: RuntimePackConfiguration) -> PackUrlSigner:
    return GoogleCloudStoragePackUrlSigner(configuration)


_registry_cache_lock = threading.Lock()
_registry_cache: tuple[tuple[str, str], float, VoiceModelPackRegistry] | None = None


def _clear_registry_cache_for_tests() -> None:
    """Reset only in-process metadata cache; intentionally not an API."""

    global _registry_cache
    with _registry_cache_lock:
        _registry_cache = None


def _load_registry(configuration: RuntimePackConfiguration) -> VoiceModelPackRegistry:
    global _registry_cache
    cache_key = (configuration.registry_project, configuration.registry_secret)
    now = time.monotonic()
    with _registry_cache_lock:
        cached = _registry_cache
        if cached and cached[0] == cache_key and cached[1] > now:
            return cached[2]

    raw = _create_registry_reader().read(configuration)
    registry = VoiceModelPackRegistry.model_validate(json.loads(raw))

    with _registry_cache_lock:
        _registry_cache = (cache_key, now + configuration.cache_seconds, registry)
    return registry


def _configured_packs() -> list[VoiceModelPackManifest]:
    configuration = _runtime_pack_configuration()
    if configuration is None:
        return []
    try:
        registry = _load_registry(configuration)
        signer = _create_url_signer(configuration)
        # Sign only after the complete registry validates. A single failed
        # signature returns no packs rather than advertising a partial catalog.
        return [pack.public_manifest(signer.sign(pack)) for pack in registry.active_packs]
    except (TypeError, ValueError, json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        logger.warning("local_runtime.pack_registry_unavailable error=%s", type(exc).__name__)
        return []
    except Exception as exc:  # Cloud client errors vary by provider version.
        logger.warning("local_runtime.pack_registry_unavailable error=%s", type(exc).__name__)
        return []


def _empty_capability() -> LocalRuntimeCapability:
    return LocalRuntimeCapability(
        processing_mode_contract=["cloud", "hybrid"],
        offline_ready=False,
        installed_packs=[],
        available_packs=[],
        supported_tasks=[],
        fallback_mode="hybrid",
    )


@router.get("/local-runtime/capability", response_model=LocalRuntimeCapability)
async def local_runtime_capability() -> LocalRuntimeCapability:
    """Return ephemeral pack metadata without private application state."""

    available = await asyncio.to_thread(_configured_packs)
    if not available:
        return _empty_capability()
    return LocalRuntimeCapability(
        processing_mode_contract=["cloud", "hybrid", "on_device"],
        offline_ready=False,
        installed_packs=[],
        available_packs=available,
        supported_tasks=sorted({task for pack in available for task in pack.tasks}),
        fallback_mode="hybrid",
    )
