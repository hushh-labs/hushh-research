"""Chat orchestration for the One Personal Information Agent (marketplace).

Runs a Gemini function-calling loop restricted to the marketplace query tools,
executed INSIDE a HushhContext so each @hushh_tool enforces its consent scope
(DB-backed). Reuses AgentChatService for durable, encrypted conversation
persistence. Mirrors LocationChatService but is read-only for slice 1: the tools
only read the owner's published-slice metadata and pricing, so no client-action
or client-prompt handoff is needed and no turn ever mutates state.

Why not HushhAgent / Google ADK execution: identical to LocationChatService —
that wrapper targets an ADK API incompatible with the pinned google-adk and has
never executed. We call the backend Gemini client (operons.kai.llm) directly;
consent is preserved because the tool callables validate scope against the
active HushhContext, which this service opens around the loop.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Awaitable, Callable

from hushh_mcp.agents.personal_information.agent import (
    get_personal_information_chat_agent,
)
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.agent_chat_service import get_agent_chat_service
from hushh_mcp.services.marketplace_information_service import (
    MarketplaceInformationService,
)

logger = logging.getLogger(__name__)

# Deterministic publish-card trigger: the model is unreliable at calling
# propose_publish, so when the user's message is clearly a publish/monetize intent
# we attach the publish card ourselves (in the marketplace chat AND Agent One).
_PUBLISH_INTENT_RE = re.compile(
    r"\b(?:publish|sell|monet|earn|make money|offers?|put .* (?:on|up)|list my)\b",
    re.IGNORECASE,
)
# Topic words to tailor the card to what the user is asking about.
_TOPIC_WORDS = (
    "financial",
    "finance",
    "travel",
    "health",
    "professional",
    "career",
    "insurance",
    "shopping",
    "personal",
    "lifestyle",
    "education",
    "home",
)


def _publish_intent_topic(message: str | None) -> tuple[bool, str | None]:
    """(is_publish_intent, topic). Topic is the first known category word in the
    message, else None (all offer-worthy)."""
    text = (message or "").lower()
    if not text or not _PUBLISH_INTENT_RE.search(text):
        return False, None
    topic = next((w for w in _TOPIC_WORDS if w in text), None)
    return True, topic


_MAX_HISTORY = 12
_MAX_TOOL_STEPS = 5
_LLM_TIMEOUT_S = 30.0
_HISTORY_CHARS = 2000

_UNAVAILABLE_MESSAGE = (
    "The marketplace assistant is temporarily unavailable. Please try again, or "
    "use the controls on this page to manage your published slices."
)
_GAVE_UP_MESSAGE = (
    "I couldn't finish that — please try rephrasing, or use the controls on this "
    "page to manage your published slices."
)

# model call seam: (contents, config) -> Gemini response. Injectable for tests.
ModelCall = Callable[[Any, Any], Awaitable[Any]]


def _function_declarations(types: Any) -> list:
    """Function declarations for the read-only marketplace query tools."""
    schema = types.Schema
    kind = types.Type
    return [
        types.FunctionDeclaration(
            name="list_published_slices",
            description=(
                "List the data slices the user has published (set to 'Available') to "
                "the marketplace, with labels and public metadata. Read-only. Call "
                "this to answer what data the user has on the market."
            ),
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
        ),
        types.FunctionDeclaration(
            name="get_earnings_summary",
            description=(
                "Summarize buyer demand + POTENTIAL monthly earnings for the user's "
                "published slices. Returns real demand (pendingRequestCount, "
                "approvedBuyerCount, interestedBuyerCount) plus each slice's price and "
                "its `math` factors (floor, data value, buyer fit, freshness, "
                "exclusivity, geo) and the pricing `formula` — use these to explain "
                "'show math'. Payments are NOT enabled yet (payoutsEnabled False, "
                "accruedCents 0): cite real buyer interest but always say payments are "
                "coming soon and nothing has been paid out. Read-only."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "power": schema(
                        type=kind.STRING,
                        description="Buyer spending band: mass|mid|affluent|hnw|uhnw",
                    ),
                    "mood": schema(
                        type=kind.STRING,
                        description="Buyer intent: passive|affinity|in_market|hot",
                    ),
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="propose_publish",
            description=(
                "Propose unpublished, offer-worthy slices the owner could publish "
                "for offers, as a publish card the UI renders. Pass `topic` (e.g. "
                "'financial', 'travel') to tailor suggestions to the conversation. "
                "Read-only — does NOT publish. Call whenever the talk is about "
                "putting data on the marketplace / earning from data."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "topic": schema(
                        type=kind.STRING,
                        description="Optional context to tailor suggestions, e.g. 'financial'",
                    )
                },
                required=[],
            ),
        ),
        types.FunctionDeclaration(
            name="list_access_requests",
            description=(
                "List the owner's pending marketplace access requests (durable, "
                "server-side). Call this FIRST to get a real request id before "
                "approving or denying — never guess an id. Read-only."
            ),
            parameters=schema(type=kind.OBJECT, properties={}, required=[]),
        ),
        types.FunctionDeclaration(
            name="approve_access_request",
            description=(
                "Approve a pending marketplace access request server-side, ONLY when "
                "the owner explicitly asks. request_id MUST come from "
                "list_access_requests."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "request_id": schema(
                        type=kind.STRING, description="Pending request id from list_access_requests"
                    )
                },
                required=["request_id"],
            ),
        ),
        types.FunctionDeclaration(
            name="deny_access_request",
            description=(
                "Deny a pending marketplace access request server-side, ONLY when the "
                "owner explicitly asks. request_id MUST come from list_access_requests."
            ),
            parameters=schema(
                type=kind.OBJECT,
                properties={
                    "request_id": schema(
                        type=kind.STRING, description="Pending request id from list_access_requests"
                    )
                },
                required=["request_id"],
            ),
        ),
    ]


# Tools that mutate durable state — a successful call means the UI should refetch
# (stateChanged). Everything else is read-only.
_MUTATING_TOOLS = {"approve_access_request", "deny_access_request"}


def _history_contents(history: list[Any], types: Any) -> list:
    contents: list = []
    for message in history[-_MAX_HISTORY:]:
        role = getattr(message, "role", "")
        if role not in ("user", "assistant"):
            continue
        genai_role = "user" if role == "user" else "model"
        text = (getattr(message, "content", "") or "")[:_HISTORY_CHARS]
        contents.append(types.Content(role=genai_role, parts=[types.Part(text=text)]))
    return contents


def _as_response_dict(result: Any) -> dict:
    return result if isinstance(result, dict) else {"result": result}


class InformationChatService:
    def __init__(
        self,
        *,
        chat_store: Any = None,
        model_call: ModelCall | None = None,
        genai_types: Any = None,
        ready: Callable[[], bool] | None = None,
        tools: list | None = None,
        system_prompt: str | None = None,
    ) -> None:
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()

        if model_call is not None:
            self._model_call = model_call
            self._types = genai_types
            self._ready = ready or (lambda: True)
        else:
            from hushh_mcp.operons.kai import llm as _llm

            self._types = genai_types or _llm.types
            self._ready = ready or _llm._require_gemini_ready

            async def _default_call(contents: Any, config: Any) -> Any:
                return await asyncio.wait_for(
                    _llm._gemini_client.aio.models.generate_content(
                        model=_llm._gemini_model_name,
                        contents=contents,
                        config=config,
                    ),
                    timeout=_LLM_TIMEOUT_S,
                )

            self._model_call = _default_call

        need_agent = system_prompt is None or tools is None
        agent = get_personal_information_chat_agent() if need_agent else None
        self._system_prompt = (
            system_prompt if system_prompt is not None else agent.manifest.system_instruction
        )
        tool_list = tools if tools is not None else agent.hushh_tools
        self._dispatch = {getattr(t, "_name", getattr(t, "__name__", "")): t for t in tool_list}

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None = None,
        consent_token: str,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        if not message:
            return {
                "conversationId": conversation_id or "",
                "response": "Ask me what you've published to the marketplace or what it's worth.",
                "isComplete": True,
                "stateChanged": False,
            }

        turn = await self._chat_store.prepare_turn(
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
        )

        if self._types is None or not self._ready():
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        types = self._types
        contents = _history_contents(turn.history, types)
        contents.append(types.Content(role="user", parts=[types.Part(text=message)]))

        try:
            reply, errored, state_changed, directives = await self._run_tool_loop(
                user_id=user_id, consent_token=consent_token, contents=contents
            )
        except Exception:
            logger.exception("Information chat turn failed")
            return await self._finish(turn, _UNAVAILABLE_MESSAGE, user_id, errored=True)

        if not reply:
            reply = "Done."
        client_action = self._build_publish_action(directives)
        # Deterministic publish card: if the model didn't stage one but the user
        # clearly asked to publish/monetize, attach it ourselves (topic-tailored).
        if client_action is None and not errored:
            intent, topic = _publish_intent_topic(message)
            if intent:
                try:
                    slices = await MarketplaceInformationService().list_publishable_slices(
                        user_id=user_id, topic=topic
                    )
                    if slices:
                        client_action = {
                            "type": "publish_slices",
                            "topic": topic,
                            "slices": slices,
                        }
                except Exception:
                    logger.warning("mkt.deterministic_publish_card_failed", exc_info=True)
        return await self._finish(
            turn,
            reply,
            user_id,
            errored=errored,
            state_changed=state_changed and not errored,
            client_action=client_action,
        )

    async def _run_tool_loop(
        self, *, user_id: str, consent_token: str, contents: list
    ) -> tuple[str, bool, bool, list[dict]]:
        """Run the Gemini function-calling loop inside HushhContext.

        Returns (reply, errored, state_changed, directives). state_changed is True
        when a mutating tool (approve/deny) succeeded; directives are publish-card
        payloads staged by propose_publish.
        """
        types = self._types
        config = types.GenerateContentConfig(
            system_instruction=self._system_prompt,
            tools=[types.Tool(function_declarations=_function_declarations(types))],
            temperature=0.2,
        )
        reply = ""
        errored = False
        state_changed = False
        directives: list[dict] = []
        with HushhContext(user_id=user_id, consent_token=consent_token, vault_keys={}):
            for _ in range(_MAX_TOOL_STEPS):
                response = await self._model_call(contents, config)
                calls = list(getattr(response, "function_calls", None) or [])
                if not calls:
                    reply = (getattr(response, "text", "") or "").strip()
                    break
                contents.append(response.candidates[0].content)
                # Gemini requires the number of function_response parts to equal the
                # number of function_call parts in the model turn. When the model
                # emits several parallel calls, all their responses must go back in a
                # SINGLE tool content — one response per call — not one message each.
                tool_parts = []
                for call in calls:
                    result, mutated, directive = await self._run_tool(
                        call.name, dict(call.args or {})
                    )
                    state_changed = state_changed or mutated
                    if directive is not None:
                        directives.append(directive)
                    tool_parts.append(
                        types.Part.from_function_response(name=call.name, response=result)
                    )
                contents.append(types.Content(role="tool", parts=tool_parts))
            else:
                reply = _GAVE_UP_MESSAGE
                errored = True
        return reply, errored, state_changed, directives

    async def _run_tool(self, name: str, args: dict) -> tuple[dict, bool, dict | None]:
        """Execute one tool inside the active HushhContext.

        Returns (result, mutated, directive): mutated is True when a mutating tool
        (approve/deny) succeeded; directive is a publish card from propose_publish.
        """
        tool = self._dispatch.get(name)
        if tool is None:
            logger.warning("mkt.tool_dispatch_miss name=%s known=%s", name, list(self._dispatch))
            return {"error": "unknown_tool"}, False, None
        try:
            result = await tool(**args)
        except PermissionError as exc:
            logger.warning("mkt.tool_consent_denied name=%s err=%s", name, exc)
            return {"error": "consent_denied"}, False, None
        except ValueError as exc:
            logger.warning("mkt.tool_invalid_argument name=%s err=%s", name, exc)
            return {"error": "invalid_argument", "message": str(exc)}, False, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Marketplace tool %s failed: %s", name, exc, exc_info=True)
            return {"error": "tool_failed"}, False, None
        result_dict = _as_response_dict(result)
        mutated = name in _MUTATING_TOOLS and not result_dict.get("error")
        directive = self._directive_from_tool(name, result_dict)
        return result_dict, mutated, directive

    @staticmethod
    def _directive_from_tool(name: str, result: dict) -> dict | None:
        """A propose_publish result with slices becomes a publish-card directive."""
        if name != "propose_publish" or result.get("error"):
            return None
        slices = result.get("slices") or []
        if not slices:
            return None
        return {"type": "publish_slices", "topic": result.get("topic"), "slices": slices}

    @staticmethod
    def _build_publish_action(directives: list[dict]) -> dict | None:
        """Fold publish-card directives into one clientAction (first non-empty wins)."""
        for d in directives:
            if d.get("type") == "publish_slices" and d.get("slices"):
                return {
                    "type": "publish_slices",
                    "topic": d.get("topic"),
                    "slices": d["slices"],
                }
        return None

    async def _finish(
        self,
        turn: Any,
        reply: str,
        user_id: str,
        *,
        errored: bool,
        state_changed: bool = False,
        client_action: dict | None = None,
    ) -> dict[str, Any]:
        await self._chat_store.add_message(
            conversation_id=turn.conversation_id,
            user_id=user_id,
            role="assistant",
            content=reply,
            status="error" if errored else "complete",
        )
        out: dict[str, Any] = {
            "conversationId": turn.conversation_id,
            "response": reply,
            "isComplete": not errored,
            # True when a mutating tool (approve/deny) succeeded — the UI refetches
            # the durable request inbox.
            "stateChanged": state_changed,
        }
        if client_action is not None:
            # Publish card (propose_publish) the UI renders inline.
            out["clientAction"] = client_action
        return out
