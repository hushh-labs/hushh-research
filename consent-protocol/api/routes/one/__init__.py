"""One product-shell API routes."""

from fastapi import APIRouter

from .a2a import router as a2a_router
from .a2a import well_known_router as a2a_well_known_router
from .adk_live import router as adk_live_router
from .advisors import router as advisors_router
from .agent_chat import router as agent_chat_router
from .calendar import router as calendar_router
from .connections import router as connections_router
from .email import router as email_router
from .email_chat import router as email_chat_router
from .feed import router as feed_router
from .gmail_delivery import router as gmail_delivery_router
from .gmail_information_requests import router as gmail_information_requests_router
from .information_chat import router as information_chat_router
from .information_requests import router as information_requests_router
from .insurance_agents import router as insurance_agents_router
from .location import router as location_router
from .location_chat import router as location_chat_router
from .marketplace_catalog import router as marketplace_catalog_router
from .marketplace_requests import router as marketplace_requests_router
from .opportunity_signals import router as opportunity_signals_router
from .people import public_router as public_people_router
from .people import router as people_router
from .places import router as places_router
from .referrals import router as referrals_router
from .runtime import router as runtime_router

router = APIRouter()
router.include_router(a2a_well_known_router)
router.include_router(a2a_router)
router.include_router(adk_live_router)
router.include_router(advisors_router)
router.include_router(agent_chat_router)
router.include_router(connections_router)
router.include_router(calendar_router)
router.include_router(email_router)
router.include_router(email_chat_router)
router.include_router(gmail_delivery_router)
router.include_router(gmail_information_requests_router)
router.include_router(feed_router)
router.include_router(location_router)
router.include_router(location_chat_router)
router.include_router(information_chat_router)
router.include_router(information_requests_router)
router.include_router(insurance_agents_router)
router.include_router(marketplace_catalog_router)
router.include_router(marketplace_requests_router)
router.include_router(opportunity_signals_router)
router.include_router(places_router)
router.include_router(public_people_router)
router.include_router(people_router)
router.include_router(referrals_router)
router.include_router(runtime_router)

__all__ = ["router"]
