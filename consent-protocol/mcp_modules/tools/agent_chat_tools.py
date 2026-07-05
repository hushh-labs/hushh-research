"""Internal MCP tools for first-party Agent chat turns."""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.types import TextContent

from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.agent_chat_service import (
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
)
from hushh_mcp.services.agent_chat_turn_service import (
    AgentChatTurnInput,
    collect_agent_chat_turn,
)

logger = logging.getLogger("hushh-mcp-server")

_USER_ID_MAX = 128
_MESSAGE_MAX = 8000
_CONVERSATION_ID_MAX = 128
_PKM_CONTEXT_MAX = 20000
_SCREEN_CONTEXT_MAX = 20000
_TIMEZONE_MAX = 64
_RUNTIME_CREDENTIAL_MAX = 12000
_RUNTIME_CREDENTIAL_MODE_MAX = 64
_DELEGATE_RESULT_MAX = 30000


def _json_response(payload: dict[str, Any]) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))]


def _bounded_string(
    args: dict[str, Any],
    key: str,
    *,
    max_length: int,
    required: bool = False,
    strip: bool = True,
) -> tuple[str | None, dict[str, Any] | None]:
    value = args.get(key)
    if value is None:
        if required:
            return None, {
                "status": "access_denied",
                "error": f"{key}_required",
                "message": f"{key} is required.",
            }
        return None, None
    text = str(value)
    if strip:
        text = text.strip()
    if required and not text:
        return None, {
            "status": "access_denied",
            "error": f"{key}_required",
            "message": f"{key} is required.",
        }
    if len(text) > max_length:
        return None, {
            "status": "invalid_request",
            "error": f"{key}_too_long",
            "message": f"{key} must be {max_length} characters or fewer.",
        }
    return text, None


def _coerce_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _bounded_record(
    args: dict[str, Any],
    key: str,
    *,
    max_json_length: int,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    value = args.get(key)
    if value is None:
        return None, None
    record = _coerce_record(value)
    if record is None:
        return None, {
            "status": "invalid_request",
            "error": f"{key}_invalid",
            "message": f"{key} must be an object.",
        }
    if len(json.dumps(record, default=str, ensure_ascii=False)) > max_json_length:
        return None, {
            "status": "invalid_request",
            "error": f"{key}_too_large",
            "message": f"{key} is too large.",
        }
    return record, None


async def handle_agent_chat_turn(args: dict[str, Any]) -> list[TextContent]:
    """Run one internal Agent chat turn over the shared A2A orchestration path."""

    user_id, error = _bounded_string(
        args,
        "user_id",
        max_length=_USER_ID_MAX,
        required=True,
    )
    if error is not None:
        return _json_response(error)

    vault_owner_token = str(
        args.get("vault_owner_token") or args.get("consent_token") or ""
    ).strip()
    if not vault_owner_token:
        return _json_response(
            {
                "status": "access_denied",
                "error": "vault_owner_token_required",
                "message": "A VAULT_OWNER token is required for internal Agent chat.",
            }
        )
    if len(vault_owner_token) > _RUNTIME_CREDENTIAL_MAX:
        return _json_response(
            {
                "status": "invalid_request",
                "error": "vault_owner_token_too_long",
                "message": "vault_owner_token is too long.",
            }
        )

    message, error = _bounded_string(
        args,
        "message",
        max_length=_MESSAGE_MAX,
        strip=False,
    )
    if error is not None:
        return _json_response(error)
    conversation_id, error = _bounded_string(
        args,
        "conversation_id",
        max_length=_CONVERSATION_ID_MAX,
    )
    if error is not None:
        return _json_response(error)
    pkm_context, error = _bounded_string(
        args,
        "pkm_context",
        max_length=_PKM_CONTEXT_MAX,
        strip=False,
    )
    if error is not None:
        return _json_response(error)
    timezone, error = _bounded_string(args, "timezone", max_length=_TIMEZONE_MAX)
    if error is not None:
        return _json_response(error)
    runtime_credential, error = _bounded_string(
        args,
        "runtime_credential",
        max_length=_RUNTIME_CREDENTIAL_MAX,
        strip=False,
    )
    if error is not None:
        return _json_response(error)
    runtime_credential_mode, error = _bounded_string(
        args,
        "runtime_credential_mode",
        max_length=_RUNTIME_CREDENTIAL_MODE_MAX,
    )
    if error is not None:
        return _json_response(error)
    screen_context, error = _bounded_record(
        args,
        "screen_context",
        max_json_length=_SCREEN_CONTEXT_MAX,
    )
    if error is not None:
        return _json_response(error)
    delegate_result, error = _bounded_record(
        args,
        "delegate_result",
        max_json_length=_DELEGATE_RESULT_MAX,
    )
    if error is not None:
        return _json_response(error)

    valid, _reason, token_obj = await validate_token_with_db(
        vault_owner_token,
        ConsentScope.VAULT_OWNER,
    )
    if not valid or token_obj is None:
        logger.warning("agent_chat_turn denied invalid VAULT_OWNER token")
        return _json_response(
            {
                "status": "access_denied",
                "error": "vault_owner_token_invalid",
                "message": "A valid VAULT_OWNER token is required.",
            }
        )
    if str(token_obj.user_id) != user_id:
        logger.warning("agent_chat_turn denied token user mismatch")
        return _json_response(
            {
                "status": "access_denied",
                "error": "vault_owner_token_user_mismatch",
                "message": "The VAULT_OWNER token does not match user_id.",
            }
        )

    try:
        turn = await collect_agent_chat_turn(
            AgentChatTurnInput(
                user_id=user_id,
                message=message or "",
                conversation_id=conversation_id,
                pkm_context=pkm_context,
                screen_context=screen_context,
                timezone=timezone,
                runtime_credential=runtime_credential,
                runtime_credential_mode=runtime_credential_mode,
                delegate_result=delegate_result,
            ),
            consent_token=vault_owner_token,
        )
    except AgentRuntimeContractError as error:
        return _json_response(
            {
                "status": "error",
                "error": error.error_code,
                "message": error.message,
            }
        )
    except AgentRuntimeProviderError as error:
        return _json_response(
            {
                "status": "error",
                "error": error.error_code,
                "message": error.message,
                "detail": error.detail,
            }
        )

    return _json_response(turn.to_payload())
