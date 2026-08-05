"""One product-shell API routes."""

from fastapi import APIRouter

from .a2a import router as a2a_router
from .a2a import well_known_router as a2a_well_known_router
from .adk_live import router as adk_live_router
from .advisors import router as advisors_router
from .connections import router as connections_router
from .email import router as email_router
from .email_chat import router as email_chat_router
from .feed import router as feed_router
from .information_chat import router as information_chat_router
from .insurance_agents import router as insurance_agents_router
from .location import router as location_router
from .location_chat import router as location_chat_router
from .marketplace_catalog import router as marketplace_catalog_router
from .marketplace_requests import router as marketplace_requests_router
from .opportunity_signals import router as opportunity_signals_router
from .runtime import router as runtime_router

router = APIRouter()
router.include_router(a2a_well_known_router)
router.include_router(a2a_router)
router.include_router(adk_live_router)
router.include_router(advisors_router)
router.include_router(connections_router)
router.include_router(email_router)
router.include_router(email_chat_router)
router.include_router(feed_router)
router.include_router(location_router)
router.include_router(location_chat_router)
router.include_router(information_chat_router)
router.include_router(insurance_agents_router)
router.include_router(marketplace_catalog_router)
router.include_router(marketplace_requests_router)
router.include_router(opportunity_signals_router)
router.include_router(runtime_router)

__all__ = ["router"]
