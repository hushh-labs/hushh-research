# api/routes/kai/consent.py
"""
Kai Consent Endpoints

Attach point: api/routes/kai/consent.py

Handles Kai-specific consent grants for analysis operations.

Only PKM scopes are used (attr.{domain}.*, agent.kai.analyze).

SECURITY: All consent grant endpoints require Firebase authentication.
The authenticated user can only grant consent for their own data.

Scope-item length guard (CWE-400 / CWE-209):
  ``GrantConsentRequest.scopes`` capped the *count* of items (max_length=20)
  but left each scope *string* unbounded.  A caller could send a single
  megabyte-scale scope string that:
    1. Reaches ``ConsentScope(scope_str)`` (raises ValueError — never stored).
    2. Is echoed verbatim in ``detail=f"Invalid scope: {scope_str}"`` (CWE-209)
       and written to the error log.

  Fix: annotate each list element with ``Field(max_length=128)``.  All
  legitimate ConsentScope values are well under 64 characters.  Pydantic
  returns HTTP 422 before the loop body runs.  The error-detail message is
  replaced with a static opaque string so user-supplied text is never
  reflected back.
"""

import logging
import re
import uuid
from typing import Annotated, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from api.middleware import require_firebase_auth, verify_user_id_match
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_db import ConsentDBService

logger = logging.getLogger(__name__)

router = APIRouter()

# Allowed dynamic scope prefixes for Kai consent grants.
# Only financial data and Kai agent scopes may be issued at this boundary.
# Broader PKM domains (health, food, travel, etc.) are outside the Kai
# finance/analysis contract and must be rejected.
_KAI_DYNAMIC_SCOPE_PREFIXES: frozenset[str] = frozenset(
    {
        "attr.financial",
        "agent.kai",
    }
)

# Structural format check: a valid dynamic scope looks like attr.domain.sub.*
_DYNAMIC_SCOPE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z*][a-z0-9_.*]*)*$")


def _validate_scope(scope_str: str) -> None:
    """Raise ValueError when scope_str is not in the Kai consent contract.

    Accepts:
      - Any ConsentScope enum value (e.g. agent.kai.analyze, vault.owner)
      - Dynamic scopes rooted at attr.financial or agent.kai
        (e.g. attr.financial.*, attr.financial.portfolio.*)

    Rejects anything outside that contract, including attr.health.*,
    attr.food.*, and arbitrary strings.
    """
    try:
        ConsentScope(scope_str)
        return
    except ValueError:
        pass

    if not _DYNAMIC_SCOPE_PATTERN.match(scope_str):
        raise ValueError(f"Unknown scope: {scope_str!r}")

    if any(
        scope_str == prefix or scope_str.startswith(prefix + ".")
        for prefix in _KAI_DYNAMIC_SCOPE_PREFIXES
    ):
        return

    raise ValueError(f"Scope is outside the Kai consent contract: {scope_str!r}")


# ============================================================================
# MODELS
# ============================================================================


class GrantConsentRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=128)
    # Each scope string is capped at 128 chars (all real ConsentScope values
    # are under 64 chars).  The list itself is capped at 20 items.
    scopes: List[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=lambda: ["attr.financial.*", "agent.kai.analyze"],
        max_length=20,
    )


class GrantConsentResponse(BaseModel):
    consent_id: str = Field(..., max_length=256)
    tokens: Dict[str, str]
    expires_at: str = Field(..., max_length=64)


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
            _validate_scope(scope_str)
            # issue_token accepts both ConsentScope enum values and dynamic
            # attr.* strings directly; passing scope_str avoids the double
            # enum lookup that previously rejected valid dynamic scopes.
            token = issue_token(
                user_id=request.user_id,
                agent_id="agent_kai",
                scope=scope_str,
            )
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

        except HTTPException:
            raise
        except ValueError:
            logger.warning(
                "grant_consent.invalid_scope user_id=%s scope=%s", request.user_id, scope_str
            )
            raise HTTPException(status_code=400, detail="Invalid scope requested.")
        except Exception as e:
            logger.error(
                "grant_consent.token_issue_failed user_id=%s scope=%s: %s",
                request.user_id,
                scope_str,
                e,
            )
            raise HTTPException(status_code=500, detail="Failed to issue consent token.")

    if not tokens:
        raise HTTPException(status_code=400, detail="No valid scopes provided")

    logger.info("grant_consent.issued user_id=%s scopes=%d", request.user_id, len(tokens))

    return GrantConsentResponse(
        consent_id=consent_id,
        tokens=tokens,
        expires_at=str(last_token_issued.expires_at) if last_token_issued else "",
    )
