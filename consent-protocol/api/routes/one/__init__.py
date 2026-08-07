"""One product-shell API routes."""

from fastapi import APIRouter

from .a2a import router as a2a_router
from .a2a import well_known_router as a2a_well_known_router
from .adk_live import router as adk_live_router
from .advisors import router as advisors_router
from .agent_prompt import router as agent_prompt_router
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
from .personal_agent import router as personal_agent_router
from .pod_consent import router as pod_consent_router
from .pod_heartbeat import router as pod_heartbeat_router
from .pod_relay import router as pod_relay_router
from .runtime import router as runtime_router
from .webauthn import router as webauthn_router

router = APIRouter()
router.include_router(a2a_well_known_router)
router.include_router(a2a_router)
router.include_router(adk_live_router)
router.include_router(advisors_router)
router.include_router(agent_prompt_router)
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
router.include_router(personal_agent_router)
# Hub-only: the private relay is the sole authorized door to a pod. A pod must
# NEVER mount this -- a pod serving the relay could proxy to other pods. The
# allowlist in pod_server.py keeps it off the pod surface.
router.include_router(pod_consent_router)
router.include_router(pod_heartbeat_router)
router.include_router(pod_relay_router)
router.include_router(runtime_router)
router.include_router(webauthn_router)

__all__ = ["router"]
