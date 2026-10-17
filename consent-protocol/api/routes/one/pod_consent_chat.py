"""Private chat adapters for the canonical consent continuation and receipt owners."""

from ag_ui.core import RunAgentInput
from fastapi import HTTPException

from hushh_mcp.one_adk.consent_chat_admission import admit_session_continuation
from hushh_mcp.one_adk.consent_continuation import ConsentContinuationError
from hushh_mcp.one_adk.information_request_submission import (
    RecordInformationRequestSubmission,
    record_submission,
)
from hushh_mcp.one_adk.pod_agui_context import PodChatContext
from hushh_mcp.services.pod_consent_read import PodConsentReadPort


async def admit_continuation(
    forwarded: dict, input_data: RunAgentInput, owner: PodChatContext, app_name: str
) -> dict:
    try:
        return await admit_session_continuation(
            forwarded,
            input_data=input_data,
            owner_id=owner.owner,
            sessions=owner.sessions,
            app_name=app_name,
            get_bundle=PodConsentReadPort(owner).get,
            person_name=lambda _: "they",
        )
    except ConsentContinuationError as exc:
        raise HTTPException(exc.status_code, detail=str(exc)) from None
    except Exception:
        raise HTTPException(503, detail={"code": "POD_CONSENT_AUTHORITY_UNAVAILABLE"}) from None


async def record_request(
    conversation_id: str,
    payload: RecordInformationRequestSubmission,
    owner: PodChatContext,
    app_name: str,
) -> dict:
    await owner.require_access()
    try:
        return await record_submission(
            owner_id=owner.owner,
            conversation_id=conversation_id,
            payload=payload,
            sessions=owner.sessions,
            verify_submission=PodConsentReadPort(owner).get,
            app_name=app_name,
            require_access=owner.require_access,
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, detail={"code": "POD_CONSENT_AUTHORITY_UNAVAILABLE"}) from None
