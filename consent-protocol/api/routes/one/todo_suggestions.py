"""Explicit, nonpersisting task-summary processing by One."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from api.middleware import require_vault_owner_token
from api.middlewares.rate_limit import limiter
from api.utils.private_no_store import PRIVATE_NO_STORE_HEADERS, PrivateNoStoreRoute
from hushh_mcp.adk_bridge.delegation import validate_first_party_owner_token
from hushh_mcp.runtime_settings import one_todo_suggestions_enabled
from hushh_mcp.services.one_todo_suggestions import TaskSuggestionRequest, suggest_tasks
from hushh_mcp.services.owner_placement_guard import hub_content_owner, require_hub_content_current

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/todos", route_class=PrivateNoStoreRoute)


@router.get("/suggestions/status")
async def task_suggestion_status(owner: dict = Depends(require_vault_owner_token)) -> JSONResponse:
    return JSONResponse(
        {"available": one_todo_suggestions_enabled()}, headers=PRIVATE_NO_STORE_HEADERS
    )


@router.post("/suggestions")
@limiter.limit("3/minute")
async def todo_suggestions(
    request: Request,
    body: TaskSuggestionRequest,
    owner: dict = Depends(hub_content_owner),
) -> JSONResponse:
    if not one_todo_suggestions_enabled():
        raise HTTPException(503, "Task suggestions are not available yet.")
    user_id, token = owner["user_id"], owner.get("token", "")

    async def check_owner() -> None:
        if await validate_first_party_owner_token(user_id, token) is None:
            raise HTTPException(403, "Unlock your vault again to suggest tasks.")

    async def require_access() -> None:
        await require_hub_content_current(user_id, "one_todo_suggestions", check_owner)

    try:
        result = await suggest_tasks(
            body, user_id=user_id, consent_token=token, require_access=require_access
        )
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(403, "Approve processing these summaries first.") from None
    except Exception:
        # Metadata only: never owner summaries, model text, handles or provider errors.
        logger.warning("one_todo_suggestions stage=failed")
        raise HTTPException(503, "Task suggestions could not load. Try again.") from None
    logger.info("one_todo_suggestions stage=completed count=%d", len(result.items))
    return JSONResponse(result.model_dump(), headers=PRIVATE_NO_STORE_HEADERS)
