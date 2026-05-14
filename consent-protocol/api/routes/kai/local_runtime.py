from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.middleware import require_firebase_auth


router = APIRouter()


class ModelPackManifest(BaseModel):
    pack_id: str
    version: str
    size_bytes: int
    checksum: str
    min_ram_gb: int
    min_storage_mb: int
    languages: list[str]
    tasks: list[Literal["ocr", "stt", "tts", "slm"]]


class LocalRuntimeCapability(BaseModel):
    processing_mode_contract: list[Literal["cloud", "hybrid", "on_device"]]
    offline_ready: bool
    installed_packs: list[ModelPackManifest]
    supported_tasks: list[Literal["ocr", "stt", "tts", "slm"]]
    fallback_mode: Literal["cloud", "hybrid"]


B_PACK_MANIFEST = ModelPackManifest(
    pack_id="hussh-b-pack-v1",
    version="1.0.0",
    size_bytes=900000000,
    checksum="PLACEHOLDER_SHA256",
    min_ram_gb=6,
    min_storage_mb=1100,
    languages=["en"],
    tasks=["ocr", "stt", "tts", "slm"],
)


@router.get("/local-runtime/capability", response_model=LocalRuntimeCapability)
async def get_local_runtime_capability(
    _firebase_uid: str = Depends(require_firebase_auth),
) -> LocalRuntimeCapability:
    return LocalRuntimeCapability(
        processing_mode_contract=["cloud", "hybrid", "on_device"],
        offline_ready=False,
        installed_packs=[B_PACK_MANIFEST],
        supported_tasks=["ocr", "stt", "tts", "slm"],
        fallback_mode="cloud",
    )
