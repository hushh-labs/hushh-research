"""ADK Connections chat; owner-bound reads/proposals and legacy confirmed selection.
The authority-ingress adapter remains responsible for validating the caller.
Selection continuation keeps its existing execution path; no mutation function
is exposed as an agent tool.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable
from uuid import uuid4

from google.adk.tools.function_tool import FunctionTool

from hushh_mcp.agents.connections.agent import build_connections_agent
from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
from hushh_mcp.services.agent_chat_service import get_agent_chat_service
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService

logger = logging.getLogger(__name__)
_MAX_TOOL_STEPS = 4
_UNAVAILABLE_MESSAGE = "The connections assistant is temporarily unavailable. Please try again."
_PROMPT_STATE_KEY = "hussh:specialist_directive"


class _PromptTool(FunctionTool):
    """A read/proposal tool whose validated result may stop for owner input."""

    def __init__(
        self, func, prompt_builder, before_read: Callable[[], Awaitable[None]] | None = None
    ):
        super().__init__(func=func)
        self._prompt_builder = prompt_builder
        self._before_read = before_read

    async def run_async(self, *, args, tool_context):
        # Admission/revocation errors must escape before service access, outside
        # the legacy service-error narration below.
        if self._before_read is not None:
            await self._before_read()
        # Even if a model emitted several calls together, once a card is ready
        # no later tool executes in that turn.
        if tool_context.state.get(_PROMPT_STATE_KEY):
            tool_context.actions.skip_summarization = True
            return {"status": "awaiting_owner"}
        try:
            result = await super().run_async(args=args, tool_context=tool_context)
        except ConnectionsError as exc:
            return {"error": "tool_failed", "message": exc.message}
        except PermissionError:
            raise
        except Exception:
            logger.warning("connections_chat.tool_failed name=%s", self.name)
            return {"error": "tool_failed"}
        result = result if isinstance(result, dict) else {"result": result}
        prompt = self._prompt_builder(self.name, result)
        if prompt is not None:
            tool_context.state[_PROMPT_STATE_KEY] = {"kind": "prompt", "payload": prompt}
            tool_context.actions.skip_summarization = True
        return result


class ConnectionsChatService:
    def __init__(
        self,
        service: ConnectionsService | None = None,
        *,
        chat_store: Any = None,
        model: Any = None,
        ready: Callable[[], bool] | None = None,
    ) -> None:
        self._service = service or ConnectionsService()
        self._chat_store = chat_store if chat_store is not None else get_agent_chat_service()
        self._model = model
        self._ready = ready or (lambda: True)

    async def handle_turn(
        self,
        *,
        user_id: str,
        message: str | None,
        consent_token: str | None = None,
        conversation_id: str | None = None,
        selection_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        conv = conversation_id or ""
        if selection_result is not None:
            return self._complete_action(user_id, selection_result, conv)
        if not (message or "").strip():
            return self._reply(
                "Tell me who you'd like to connect with, or ask who your connections are.",
                conv,
                state_changed=False,
            )
        turn = await self._chat_store.prepare_turn(
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
        )
        if not self._ready():
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None
            )
        try:
            agent = build_connections_agent(
                tools=self.build_read_proposal_tools(user_id),
                model=self._model,
            )
            result = await run_specialist_adk_turn(
                agent=agent,
                app_name="hushh_connections",
                user_id=user_id,
                consent_token=consent_token or "",
                message=message,
                history=turn.history,
                max_llm_calls=_MAX_TOOL_STEPS,
            )
            directive = result.state.get(_PROMPT_STATE_KEY)
            prompt = directive.get("payload") if isinstance(directive, dict) else None
            if not result.final_text.strip() and prompt is None:
                raise RuntimeError("Connections returned neither an answer nor a prompt")
        except Exception:
            logger.warning("Connections chat turn failed")
            return await self._finish(
                turn, _UNAVAILABLE_MESSAGE, user_id, errored=True, prompt=None
            )
        return await self._finish(
            turn,
            result.final_text,
            user_id,
            errored=False,
            prompt=prompt,
        )

    def build_read_proposal_tools(
        self,
        user_id: str,
        before_read: Callable[[], Awaitable[None]] | None = None,
    ) -> list[FunctionTool]:
        """Build owner-bound tools without a chat session or selection executor.

        New parent composition must provide per-call authority revalidation.
        Legacy ingress may omit it because its adapter retains full admission.
        """
        if not user_id.strip():
            raise ValueError("Connections tools require an owner")
        return [
            _PromptTool(func, self._prompt_from_tool, before_read)
            for func in self._build_tools(user_id).values()
        ]

    def _build_tools(self, user_id: str) -> dict[str, Callable]:
        service = self._service

        def list_my_connections(query: str = "", page: int = 1, limit: int = 25) -> dict:
            """Read one bounded page of active connections; query filters names, page is 1-based and limit is at most 100."""
            return service.list_connections_page(
                user_id,
                query=query,
                page=max(1, int(page or 1)),
                limit=max(1, min(int(limit or 25), 100)),
            )

        def list_pending_requests(direction: str = "incoming") -> dict:
            """Read pending incoming or outgoing requests. Use returned request ids for proposals."""
            direction = "outgoing" if str(direction).lower() == "outgoing" else "incoming"
            return {"items": service.list_requests(user_id, direction=direction)}

        def find_people(query: str) -> dict:
            """Search the owner directory by name. Resolve a real person before proposing a request; ambiguous names require request_person_choice."""
            return service.search_directory(user_id, query=query)

        def propose_send_request(addressee_user_id: str, label: str = "them") -> dict:
            """Propose sending a request to the person resolved by find_people. This only asks for confirmation and never sends."""
            return {
                "proposal": {
                    "op": "send_request",
                    "addresseeUserId": str(addressee_user_id),
                    "label": str(label),
                    "verb": "send a request to",
                    "summary": f"Send a connection request to {label}?",
                }
            }

        def propose_accept_request(request_id: str, label: str = "them") -> dict:
            """Propose accepting an incoming request returned by list_pending_requests. Does not accept it."""
            return {
                "proposal": {
                    "op": "accept",
                    "requestId": str(request_id),
                    "label": str(label),
                    "verb": "accept the request from",
                    "summary": f"Accept the connection request from {label}?",
                }
            }

        def propose_reject_request(request_id: str, label: str = "them") -> dict:
            """Propose declining an incoming request returned by list_pending_requests. Does not decline it."""
            return {
                "proposal": {
                    "op": "reject",
                    "requestId": str(request_id),
                    "label": str(label),
                    "verb": "decline the request from",
                    "summary": f"Decline the connection request from {label}?",
                }
            }

        def propose_remove_connection(connection_id: str, label: str = "them") -> dict:
            """Propose removing an active connection returned by list_my_connections. Does not remove it."""
            return {
                "proposal": {
                    "op": "remove",
                    "connectionId": str(connection_id),
                    "label": str(label),
                    "verb": "remove",
                    "summary": f"Remove {label} from your connections?",
                }
            }

        def request_person_choice(name: str) -> dict:
            """Ask the owner to choose an ambiguous directory person. A single match returns resolved; multiple matches attach a picker; never guess."""
            items = (service.search_directory(user_id, query=name) or {}).get("items") or []
            people = [p for p in items if p.get("userId")]
            if not people:
                return {"status": "not_found", "name": name}
            if len(people) == 1:
                p = people[0]
                return {
                    "status": "resolved",
                    "addresseeUserId": str(p.get("userId")),
                    "label": str(p.get("displayName") or "them"),
                }
            return {
                "status": "ambiguous",
                "name": name,
                "candidates": [
                    {
                        "userId": str(p.get("userId")),
                        "displayName": str(p.get("displayName") or "Someone"),
                    }
                    for p in people
                ],
            }

        return {
            "list_my_connections": list_my_connections,
            "list_pending_requests": list_pending_requests,
            "find_people": find_people,
            "propose_send_request": propose_send_request,
            "propose_accept_request": propose_accept_request,
            "propose_reject_request": propose_reject_request,
            "propose_remove_connection": propose_remove_connection,
            "request_person_choice": request_person_choice,
        }

    def _prompt_from_tool(self, name: str, result: dict) -> dict | None:
        if not isinstance(result, dict) or result.get("error"):
            return None
        if name == "request_person_choice" and result.get("status") == "ambiguous":
            options = [
                {
                    "label": c["displayName"],
                    "ref": {
                        "op": "send_request",
                        "addresseeUserId": c["userId"],
                        "label": c["displayName"],
                    },
                    "hint": None,
                }
                for c in (result.get("candidates") or [])
                if c.get("userId")
            ]
            return {
                "id": "prm-" + uuid4().hex[:12],
                "kind": "select",
                "purpose": "send_trusted_connection",
                "question": f'Which "{result.get("name")}"?',
                "options": options,
                "minSelections": 1,
                "maxSelections": 1,
                "allowFreeText": False,
            }
        proposal = result.get("proposal")
        if not (name.startswith("propose_") and isinstance(proposal, dict)):
            return None
        ref = {k: v for k, v in proposal.items() if k not in ("verb", "summary")}
        label = str(proposal.get("label") or "them")
        verb = str(proposal.get("verb") or "do this with")
        return {
            "id": "prm-" + uuid4().hex[:12],
            "kind": "select",
            "purpose": f"confirm_{proposal.get('op')}",
            "question": str(proposal.get("summary") or "Confirm?"),
            "options": [{"label": f"Yes, {verb} {label}", "ref": ref, "hint": None}],
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": False,
        }

    async def _finish(
        self, turn: Any, reply: str, user_id: str, *, errored: bool, prompt: dict | None
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
            "stateChanged": False,
        }
        if prompt is not None:
            out["clientPrompt"] = prompt
            out["isComplete"] = False
        return out

    # ---- selection round-trip ----

    _SUCCESS_TEXT = {
        "send_request": "Sent a connection request to {label}.",
        "accept": "You're now connected with {label}.",
        "reject": "Declined the request from {label}.",
        "remove": "Removed {label} from your connections.",
    }

    def _complete_action(
        self, user_id: str, selection_result: dict[str, Any], conv: str
    ) -> dict[str, Any]:
        if str(selection_result.get("status")) == "cancelled":
            return self._reply("Okay, I won't change anything.", conv, state_changed=False)

        selected = selection_result.get("selected") or []
        chosen = selected[0] if selected and isinstance(selected[0], dict) else {}
        op = str(chosen.get("op") or "")
        label = str(chosen.get("label") or selection_result.get("display") or "them")

        try:
            if op == "send_request":
                addressee = str(chosen.get("addresseeUserId") or "")
                if not addressee:
                    return self._reply(
                        "I didn't catch who to connect with — try again?", conv, state_changed=False
                    )
                self._service.create_request(user_id, addressee_user_id=addressee)
            elif op == "accept":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply(
                        "I didn't catch which request — try again?", conv, state_changed=False
                    )
                self._service.accept_request(user_id, rid)
            elif op == "reject":
                rid = str(chosen.get("requestId") or "")
                if not rid:
                    return self._reply(
                        "I didn't catch which request — try again?", conv, state_changed=False
                    )
                self._service.reject_request(user_id, rid)
            elif op == "remove":
                cid = str(chosen.get("connectionId") or "")
                if not cid:
                    return self._reply(
                        "I didn't catch which connection — try again?", conv, state_changed=False
                    )
                self._service.remove_connection(user_id, cid)
            else:
                return self._reply(
                    "I didn't catch what to do — try again?", conv, state_changed=False
                )
        except ConnectionsError as exc:
            return self._reply(exc.message, conv, state_changed=False)

        return self._reply(self._SUCCESS_TEXT[op].format(label=label), conv, state_changed=True)

    @staticmethod
    def _reply(
        response: str,
        conv: str,
        *,
        state_changed: bool,
        client_prompt: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "response": response,
            "conversationId": conv,
            "isComplete": True,
            "stateChanged": state_changed,
        }
        if client_prompt is not None:
            out["clientPrompt"] = client_prompt
            # A prompt turn is a mid-conversation ask, not a completed action.
            out["isComplete"] = False
        return out
