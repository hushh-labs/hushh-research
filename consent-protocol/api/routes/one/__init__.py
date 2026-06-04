"""One product-shell API routes."""

from fastapi import APIRouter

from .email import router as email_router
from .location import router as location_router

router = APIRouter()
router.include_router(email_router)
router.include_router(location_router)

__all__ = ["router"]
