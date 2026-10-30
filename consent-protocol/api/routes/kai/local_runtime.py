"""Retirement boundary: obsolete clients never receive model-pack credentials."""

from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get("/local-runtime/capability")
async def local_runtime_capability():
    raise HTTPException(
        410,
        {"code": "ONE_LOCAL_VOICE_RETIRED", "message": "Update HUSSH to use Location commands."},
    )
