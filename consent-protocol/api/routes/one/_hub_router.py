"""Hub-only One route composition; imported by the package router facade."""

from fastapi import APIRouter

from .a2a import router as a2a_router
from .a2a import well_known_router as a2a_well_known_router
from .advisors import router as advisors_router
from .agent_chat import router as agent_chat_router
from .agent_feedback import router as agent_feedback_router
from .agent_prompt import router as agent_prompt_router
from .answer_requests import router as answer_requests_router
from .answer_work_drain import router as answer_work_drain_router
from .area_discovery import router as area_discovery_router
from .business_suggestions import router as business_suggestions_router
from .byoc_azure import router as byoc_azure_router
from .calendar import router as calendar_router
from .calendar_email_followup_drain import router as calendar_email_followup_drain_router
from .calendar_email_followups import router as calendar_email_followups_router
from .calendar_workspace import router as calendar_workspace_router
from .capability_runtime import router as capability_runtime_router
from .career import router as career_router
from .circle_chat import router as circle_chat_router
from .client_connectors import router as client_connectors_router
from .command_proposals import router as command_proposals_router
from .connection_presence import router as connection_presence_router
from .connections import router as connections_router
from .credits import router as credits_router
from .directory_claims import router as directory_claims_router
from .drive_actions import router as drive_actions_router
from .email_chat import router as email_chat_router
from .feed import router as feed_router
from .feed_events import router as feed_events_router
from .finance_sharing import router as finance_sharing_router
from .first_connect_insights import router as first_connect_insights_router
from .gmail_delivery import router as gmail_delivery_router
from .gmail_information_requests import router as gmail_information_requests_router
from .google import router as google_router
from .hosted_memory_pilot import router as hosted_memory_pilot_router
from .information_chat import router as information_chat_router
from .information_requests import router as information_requests_router
from .insurance_agents import router as insurance_agents_router
from .location import public_router as public_location_router
from .location import router as location_router
from .location_chat import router as location_chat_router
from .location_settings import router as location_settings_router
from .marketplace_catalog import router as marketplace_catalog_router
from .marketplace_requests import router as marketplace_requests_router
from .messages import router as messages_router
from .models import router as models_router
from .opportunity_signals import router as opportunity_signals_router
from .packet_orders import router as packet_orders_router
from .payout_activity import router as payout_activity_router
from .payout_balance import router as payout_balance_router
from .payouts import router as payouts_router
from .people import public_router as public_people_router
from .people import router as people_router
from .personal_agent import router as personal_agent_router
from .pkm_packets import router as pkm_packets_router
from .places import router as places_router
from .plg import router as plg_router
from .pod_browser_approval import router as pod_browser_approval_router
from .pod_consent import router as pod_consent_router
from .pod_heartbeat import router as pod_heartbeat_router
from .pod_lifecycle import router as pod_lifecycle_router
from .pod_mcp_approval import router as pod_mcp_approval_router
from .pod_owner_feed import router as pod_owner_feed_router
from .pod_relay import router as pod_relay_router
from .pod_specialist import router as pod_specialist_router
from .pod_wake import router as pod_wake_router
from .profile_discovery import router as profile_discovery_router
from .profile_research import router as profile_research_router
from .puppy_relay import router as puppy_relay_router
from .referrals import router as referrals_router
from .requester_document_payment_source import router as requester_document_payment_source_router
from .retired_voice import router as retired_voice_router
from .runtime import router as runtime_router
from .runtime_providers import router as runtime_providers_router
from .runtime_standby import router as runtime_standby_router
from .scheduled_mail_drain import router as scheduled_mail_drain_router
from .shared_files import router as shared_files_router
from .source_journal import router as source_journal_router
from .todo_suggestions import router as todo_suggestions_router
from .voice import router as voice_router
from .wallet_card_access import router as wallet_card_access_router
from .webauthn import router as webauthn_router
from .world_model import router as world_model_router
from .world_model_stream import router as world_model_stream_router

router = APIRouter()
router.include_router(a2a_well_known_router)
router.include_router(a2a_router)
router.include_router(retired_voice_router)
router.include_router(advisors_router)
router.include_router(agent_chat_router)
router.include_router(agent_prompt_router)
router.include_router(connections_router)
router.include_router(connection_presence_router)
router.include_router(area_discovery_router)
router.include_router(messages_router)
router.include_router(wallet_card_access_router)
router.include_router(finance_sharing_router)
router.include_router(calendar_router)
router.include_router(calendar_email_followups_router)
router.include_router(circle_chat_router)
router.include_router(drive_actions_router)
router.include_router(capability_runtime_router)
router.include_router(command_proposals_router)
router.include_router(client_connectors_router)
router.include_router(email_chat_router)
router.include_router(gmail_delivery_router)
router.include_router(scheduled_mail_drain_router)
router.include_router(calendar_email_followup_drain_router)
router.include_router(gmail_information_requests_router)
router.include_router(google_router)
router.include_router(feed_router)
router.include_router(feed_events_router)
router.include_router(first_connect_insights_router)
router.include_router(profile_research_router)
router.include_router(world_model_router)
router.include_router(world_model_stream_router)
router.include_router(models_router)
router.include_router(agent_feedback_router)
router.include_router(business_suggestions_router)
router.include_router(todo_suggestions_router)
router.include_router(location_router)
router.include_router(public_location_router)
router.include_router(location_chat_router)
router.include_router(location_settings_router)
router.include_router(information_chat_router)
router.include_router(information_requests_router)
router.include_router(insurance_agents_router)
router.include_router(marketplace_catalog_router)
router.include_router(marketplace_requests_router)
router.include_router(pkm_packets_router)
router.include_router(directory_claims_router)
router.include_router(packet_orders_router)
router.include_router(answer_requests_router)
router.include_router(answer_work_drain_router)
router.include_router(credits_router)
router.include_router(payouts_router)
router.include_router(payout_activity_router)
router.include_router(payout_balance_router)
router.include_router(career_router)
router.include_router(opportunity_signals_router)
router.include_router(personal_agent_router)
router.include_router(plg_router)
router.include_router(places_router)
router.include_router(profile_discovery_router)
router.include_router(public_people_router)
router.include_router(people_router)
# Hub-only: the private relay is the sole authorized door to a pod. A pod must
# NEVER mount this -- a pod serving the relay could proxy to other pods. The
# allowlist in pod_server.py keeps it off the pod surface.
router.include_router(pod_consent_router)
router.include_router(pod_mcp_approval_router)
router.include_router(pod_browser_approval_router)
router.include_router(pod_owner_feed_router)
router.include_router(pod_heartbeat_router)
# Hub-only, like the relay: a pod has no registry database and no business
# narrating anyone's provisioning. Pure readers of the narrative log.
router.include_router(pod_lifecycle_router)
router.include_router(pod_wake_router)
router.include_router(pod_relay_router)
router.include_router(puppy_relay_router)
# Hub-only, like the relay: the broker READS a DB-backed specialist for a
# keyless pod. A pod holds no DB credential and must never mount this. The
# allowlist in pod_server.py keeps it off the pod surface.
router.include_router(pod_specialist_router)
router.include_router(referrals_router)
router.include_router(runtime_router)
# Hub-only: the owner's standby "sync now" (STANDBY-SYNC.md), same prefix as runtime.
router.include_router(runtime_standby_router)
# Hub-only: the server-owned "Bring your own AI" provider catalog the app renders.
router.include_router(runtime_providers_router)
# Hub-only, beside the GCP one-click routes: Connect Azure (byoc-azure.md).
router.include_router(byoc_azure_router)
router.include_router(webauthn_router)
router.include_router(voice_router)

# Shared ciphertext library; the private pod Files runtime is never mounted here.
router.include_router(shared_files_router)
router.include_router(calendar_workspace_router)
router.include_router(hosted_memory_pilot_router)
router.include_router(requester_document_payment_source_router)
router.include_router(source_journal_router)
