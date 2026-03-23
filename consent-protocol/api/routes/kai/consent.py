# api/routes/kai/consent.py
"""
Kai Consent Endpoints

Handles Kai-specific consent grants for analysis operations.

Only PKM scopes are used (attr.{domain}.*, agent.kai.analyze).

SECURITY: All consent grant endpoints require Firebase authentication.
The authenticated user can only grant consent for their own data.
"""

import logging
import uuid
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_db import ConsentDBService

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# MODELS
# ============================================================================


class GrantConsentRequest(BaseModel):
    user_id: str
    scopes: List[str] = [
        "attr.financial.*",
        "agent.kai.analyze",
    ]


class GrantConsentResponse(BaseModel):
    consent_id: str
    tokens: Dict[str, str]
    expires_at: str


# ============================================================================
# ENDPOINTS
# ============================================================================


@router.post("/consent/grant", response_model=GrantConsentResponse)
async def grant_consent(
    request: GrantConsentRequest,
    firebase_uid: str = Depends(require_firebase_auth),
):
    """
    Grant consent for Kai data access.

    SECURITY: Requires Firebase authentication. User can only grant consent for their own data.

    Stateless: Issues tokens for the requested user_id and scopes.
    Does not rely on a pre-existing session.
    """
    # Verify user is granting consent for their own data
    verify_user_id_match(firebase_uid, request.user_id)

    service = ConsentDBService()

    tokens = {}
    consent_id = f"kai_consent_{uuid.uuid4().hex[:16]}"
    last_token_issued = None

    for scope_str in request.scopes:
        try:
            scope = ConsentScope(scope_str)
            token = issue_token(user_id=request.user_id, agent_id="agent_kai", scope=scope)
            tokens[scope_str] = token.token
            last_token_issued = token

            # Internal Kai grants should not appear in the investor-facing consent ledger.
            await service.insert_internal_event(
                user_id=request.user_id,
                agent_id="agent_kai",
                scope=scope_str,
                action="CONSENT_GRANTED",
                token_id=token.token,
                expires_at=token.expires_at,
                scope_description=scope_str,
            )

        except Exception as e:
            logger.error(f"Failed to issue token for scope {scope_str}: {e}")
            raise HTTPException(status_code=400, detail=f"Invalid scope: {scope_str}")

    if not tokens:
        raise HTTPException(status_code=400, detail="No valid scopes provided")

    logger.info(f"[Kai] Consent granted for user: {request.user_id}")

    return GrantConsentResponse(
        consent_id=consent_id,
        tokens=tokens,
        expires_at=str(last_token_issued.expires_at) if last_token_issued else "",
    )
