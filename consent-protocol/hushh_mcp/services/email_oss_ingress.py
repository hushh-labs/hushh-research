"""Owner-bound OSS Email ingress over injected factories and existing ports."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from hushh_mcp.services.email_chat_service import _MAX_HISTORY, _UNAVAILABLE_MESSAGE, logger


def _history_messages(history: list[Any]) -> list[Any]:
    from langchain_core.messages import AIMessage, HumanMessage

    messages = []
    for row in history[-_MAX_HISTORY:]:
        role, content = (
            (row.get("role", ""), row.get("content", ""))
            if isinstance(row, dict)
            else (getattr(row, "role", ""), getattr(row, "content", ""))
        )
        if role in {"assistant", "user"} and isinstance(content, str) and content:
            messages.append((AIMessage if role == "assistant" else HumanMessage)(content=content))
    return messages


async def _selection_context(
    service: Any,
    selected_messages: dict | None,
    read_offer: dict | None,
    user_id: str,
    conversation_id: str,
) -> dict | None:
    if selected_messages is None and read_offer is not None:
        from hushh_mcp.services.email_delegated_read import current_mail_read_offer

        offer = current_mail_read_offer(
            read_offer, owner_id=user_id, conversation_id=conversation_id
        )
        if offer is not None:
            grant = await service._gmail.read_execution_grant_binding(user_id=user_id)
            if grant and grant[2] == offer.account:
                selected_messages = {
                    "owner_id": user_id,
                    "grant_binding": list(grant),
                    "messages": [
                        {"id": identity, "thread_id": None} for identity in offer.message_ids
                    ],
                }
    return selected_messages


async def _run_runtime_turn(
    runtime: Any, arguments: dict, on_text: Callable[[str], Awaitable[None]] | None
) -> dict:
    if on_text is None:
        result = await runtime.handle_turn(**arguments)
    else:
        result = None
        async for event in runtime.stream_turn(**arguments):
            if event["type"] == "text":
                await on_text(event["text"])
            elif event["type"] == "result":
                result = event["result"]
        if result is None:
            raise RuntimeError("Email stream returned no terminal result")
    return result


async def run_oss_turn(
    service: Any,
    *,
    user_id: str,
    consent_token: str,
    conversation_id: str,
    message: str,
    require_access: Any,
    timezone: str,
    memory_markdown: str,
    history: list[Any],
    pending_email_draft: str = "",
    page_context: dict | None = None,
    supports_email_reviews: bool = False,
    selected_messages: dict | None = None,
    read_offer: dict | None = None,
    on_text: Callable[[str], Awaitable[None]] | None = None,
) -> dict:
    from hushh_mcp.services.email_oss.bindings import owner_email_runtime

    messages = _history_messages(history)
    factory = service._oss_runtime_factory or owner_email_runtime
    await require_access()
    try:
        selected_messages = await _selection_context(
            service, selected_messages, read_offer, user_id, conversation_id
        )
        async with factory(
            gmail=service._gmail,
            user_id=user_id,
            require_access=require_access,
            memory_markdown=memory_markdown,
            pending_email_draft=pending_email_draft,
            page_context=page_context,
            supports_email_reviews=supports_email_reviews,
            selected_messages=selected_messages,
        ) as (runtime, admitted):
            arguments = dict(
                user_id=user_id,
                message=message,
                conversation_id=conversation_id,
                consent_token=consent_token,
                timezone=timezone,
                current_memory_md=memory_markdown,
                history=messages,
                require_access=admitted,
                pending_email_draft=pending_email_draft,
                page_context=page_context,
            )
            result = await _run_runtime_turn(runtime, arguments, on_text)
    except PermissionError:
        raise
    except Exception as error:
        logger.warning("email_oss.binding_unavailable reason=%s", type(error).__name__)
        result = {
            "conversationId": conversation_id,
            "response": _UNAVAILABLE_MESSAGE,
            "isComplete": True,
            "stateChanged": False,
            "status": "unavailable",
        }
    await require_access()
    result.setdefault(
        "structured",
        {
            "connector": "mail",
            "status": "ok" if result.get("status") == "ok" else "unavailable",
            "sources": [],
            "truncated": False,
            "metadata_only": False,
        },
    )
    return result
