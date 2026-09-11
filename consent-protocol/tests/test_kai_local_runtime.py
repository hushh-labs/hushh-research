from __future__ import annotations

import json

import pytest

from api.routes.kai import local_runtime


def _registered_pack(**overrides: object) -> dict[str, object]:
    pack: dict[str, object] = {
        "pack_id": "one-voice-en-intent-v1",
        "version": "1.0.0",
        "size_bytes": 123,
        "checksum": "a" * 64,
        "min_ram_gb": 2,
        "min_storage_mb": 128,
        "languages": ["en"],
        "tasks": ["stt", "intent"],
        "runtime": "sherpa_onnx_web",
        "preprocessing_version": "pcm16k-v1",
        "entrypoint": "manifest.json",
        "bucket": "hushh-pda-uat-one-voice-model-packs",
        "object_name": "one-voice/model-packs/one-voice-en-intent-v1/1.0.0.pack",
        "source_sha": "a" * 40,
        "catalog_version": "agent-manifest-v2-1",
        "license_notice_id": "sherpa-onnx-apache-2.0",
        "license_approved": True,
    }
    pack.update(overrides)
    return pack


def _registry(*packs: dict[str, object]) -> str:
    return json.dumps(
        {
            "protocol_version": "one.voice.model-pack-registry.v1",
            "source_sha": "a" * 40,
            "catalog_version": "agent-manifest-v2-1",
            "active_packs": list(packs) or [_registered_pack()],
            "rollback_packs": [],
        }
    )


class _Reader:
    def __init__(self, payload: str) -> None:
        self.payload = payload
        self.calls = 0

    def read(self, _configuration: local_runtime.RuntimePackConfiguration) -> str:
        self.calls += 1
        return self.payload


class _Signer:
    def __init__(self, url: str | None = None, error: Exception | None = None) -> None:
        self.url = url or (
            "https://models.example.test/one-voice.pack?X-Goog-Expires=900&X-Goog-Signature=test"
        )
        self.error = error
        self.calls = 0

    def sign(self, _pack: local_runtime.RegisteredVoiceModelPack) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        return self.url


@pytest.fixture(autouse=True)
def _clear_cache(monkeypatch):
    local_runtime._clear_registry_cache_for_tests()
    monkeypatch.delenv(local_runtime._REGISTRY_SECRET_ENV, raising=False)
    monkeypatch.delenv(local_runtime._REGISTRY_PROJECT_ENV, raising=False)
    monkeypatch.delenv(local_runtime._SIGNER_SERVICE_ACCOUNT_ENV, raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    yield
    local_runtime._clear_registry_cache_for_tests()


def _configure(monkeypatch, payload: str) -> tuple[_Reader, _Signer]:
    reader = _Reader(payload)
    signer = _Signer()
    monkeypatch.setenv(local_runtime._REGISTRY_SECRET_ENV, "HUSHH_LOCAL_RUNTIME_PACK_REGISTRY")
    monkeypatch.setenv(local_runtime._REGISTRY_PROJECT_ENV, "hushh-pda-uat")
    monkeypatch.setenv(
        local_runtime._SIGNER_SERVICE_ACCOUNT_ENV,
        "one-voice-url-signer@hushh-pda-uat.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(local_runtime, "_create_registry_reader", lambda: reader)
    monkeypatch.setattr(local_runtime, "_create_url_signer", lambda _configuration: signer)
    return reader, signer


@pytest.mark.asyncio
async def test_capability_fails_closed_without_registry_configuration():
    result = await local_runtime.local_runtime_capability()

    assert result.available_packs == []
    assert result.offline_ready is False
    assert result.fallback_mode == "hybrid"
    assert result.processing_mode_contract == ["cloud", "hybrid"]


@pytest.mark.asyncio
async def test_capability_signs_valid_registry_objects_without_leaking_private_references(
    monkeypatch,
):
    reader, signer = _configure(monkeypatch, _registry())

    result = await local_runtime.local_runtime_capability()

    assert [pack.pack_id for pack in result.available_packs] == ["one-voice-en-intent-v1"]
    assert result.supported_tasks == ["intent", "stt"]
    assert result.available_packs[0].checksum == "a" * 64
    assert result.available_packs[0].source_sha == "a" * 40
    assert result.available_packs[0].catalog_version == "agent-manifest-v2-1"
    assert result.available_packs[0].license_notice_id == "sherpa-onnx-apache-2.0"
    assert "hushh-pda-uat-one-voice-model-packs" not in result.model_dump_json()
    assert "object_name" not in result.model_dump_json()
    assert reader.calls == 1
    assert signer.calls == 1


@pytest.mark.asyncio
async def test_registry_metadata_is_cached_but_each_response_gets_a_fresh_url(monkeypatch):
    reader, signer = _configure(monkeypatch, _registry())

    first = await local_runtime.local_runtime_capability()
    second = await local_runtime.local_runtime_capability()

    assert reader.calls == 1
    assert signer.calls == 2
    assert first.available_packs[0].artifact_url == second.available_packs[0].artifact_url


@pytest.mark.asyncio
async def test_invalid_registry_falls_back_without_leaking_registry_data(monkeypatch):
    _configure(monkeypatch, json.dumps({"active_packs": [_registered_pack()]}))

    result = await local_runtime.local_runtime_capability()

    assert result.available_packs == []
    assert result.processing_mode_contract == ["cloud", "hybrid"]


@pytest.mark.asyncio
async def test_invalid_signed_url_falls_back_without_advertising_pack(monkeypatch):
    _reader, signer = _configure(monkeypatch, _registry())
    signer.url = "https://models.example.test/one-voice.pack"

    result = await local_runtime.local_runtime_capability()

    assert result.available_packs == []


@pytest.mark.asyncio
async def test_signing_failure_fails_closed(monkeypatch):
    _reader, signer = _configure(monkeypatch, _registry())
    signer.error = RuntimeError("signing unavailable")

    result = await local_runtime.local_runtime_capability()

    assert result.available_packs == []


def test_fluid_audio_requires_recorded_model_license_approval():
    with pytest.raises(ValueError, match="model-license approval"):
        local_runtime.RegisteredVoiceModelPack.model_validate(
            _registered_pack(runtime="fluid_audio", license_approved=False)
        )
