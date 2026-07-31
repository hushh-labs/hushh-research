# api/routes/kai/health.py
"""
Kai Health Check Endpoint
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def kai_health():
    """Kai API health check."""
    return {"status": "ok", "agent": "kai", "version": "1.0.0"}
