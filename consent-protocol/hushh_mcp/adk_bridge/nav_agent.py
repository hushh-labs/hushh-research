"""Inline A2A runtime for Agent Nav.

This file adds an executable A2A surface for the existing Nav specialist without
changing the core Nav manifest or the working Location A2A path.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from hushh_mcp.adk_bridge.contract import (
    A2ADirective,
    A2ATask,
    SpecialistTurnResult,
    require_attenuated_authority,
)
from hushh_mcp.adk_bridge.delegation import (
    validate_a2a_consent_token_with_db,
    validate_first_party_owner_token,
)
from hushh_mcp.agents.nav.agent import build_nav_agent
from hushh_mcp.agents.nav.tools import DIRECTIVE_STATE_KEY, TIMEZONE_STATE_KEY
from hushh_mcp.hushh_adk.manifest import ManifestLoader
from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn

DELEGATED_MODEL = "one+nav"
NAV_AGENT_ID = "agent_nav"


class NavAgent:
    agent_id = NAV_AGENT_ID

    def __init__(
        self,
        manifest_path: str | Path | None = None,
        *,
        model: Any | None = None,
        connections_service: Any | None = None,
    ) -> None:
        self._manifest_path = Path(manifest_path) if manifest_path else _default_manifest_path()
        self._manifest = ManifestLoader.load(str(self._manifest_path))
        self._model = model
        self._connections_service = connections_service

    async def handle(self, task: A2ATask) -> SpecialistTurnResult:
        validation = await validate_a2a_consent_token_with_db(self.agent_id, task.consent_token)
        owner_matches = validation.user_id == task.user_id
        if not validation.ok or not owner_matches:
            return SpecialistTurnResult(
                conversation_id=task.conversation_id or "",
                # Owner words only: the scope id stays in the directive payload
                # below, where the app reads it, never in the sentence.
                text="I can review your sharing once you allow the consent assistant to see it.",
                directive=A2ADirective(
                    kind="prompt",
                    payload={
                        "kind": "consent_required",
                        "agentId": self.agent_id,
                        "requiredScope": validation.required_scope.value,
                        "reason": validation.reason if not validation.ok else "owner_mismatch",
                    },
                ),
                is_complete=True,
                model=DELEGATED_MODEL,
                state_changed=False,
            )

        target = task.specialist_target or "consent"
        if target not in {"consent", "connections"}:
            raise PermissionError("Invalid specialist target")
        connections_tools = None
        if target == "connections":
            if task.delegate_result is not None:
                raise PermissionError("Connection actions require the governed action gateway")
            connections_tools = await self._connections_tools(task)
        elif task.authority is not None:
            self._require_invocation(task, self._manifest)

        message = (task.message or "").strip()
        if not message:
            return SpecialistTurnResult(
                conversation_id=task.conversation_id or "",
                text="Nav is ready to review consent, scope release, vault access, deletion, and revocation questions.",
                directive=None,
                is_complete=True,
                model=DELEGATED_MODEL,
                state_changed=False,
            )
        turn = await run_specialist_adk_turn(
            agent=build_nav_agent(
                model=self._model, manifest=self._manifest, connections_tools=connections_tools
            ),
            app_name="hushh_nav",
            user_id=task.user_id,
            consent_token=task.consent_token,
            message=message,
            state={TIMEZONE_STATE_KEY: task.timezone or "UTC", "nav_target": target},
        )
        raw = turn.state.get(DIRECTIVE_STATE_KEY)
        directive = A2ADirective(kind=raw["kind"], payload=raw["payload"]) if raw else None
        answer_text = turn.final_text
        if target == "connections" and raw:
            # Legacy select cards would bypass the generated action ledger.
            # Only a typed proposal goes back to One; no selection executes here.
            directive, answer_text = _connection_proposal(raw)
        if not answer_text.strip() and directive is None:
            raise RuntimeError("Nav returned no answer")
        return SpecialistTurnResult(
            conversation_id=task.conversation_id or "",
            text=answer_text,
            directive=directive,
            is_complete=not (directive and directive.payload.get("type") == "connections_choice"),
            model=DELEGATED_MODEL,
            state_changed=False,
        )

    @staticmethod
    def _require_invocation(task: A2ATask, manifest):
        capabilities = tuple(manifest.authorities.invocation)
        if not capabilities:
            raise PermissionError("Specialist invocation is not declared")
        for capability in capabilities:
            require_attenuated_authority(
                task,
                required_invocation=capability,
                expected_tenant_id=task.expected_tenant_id,
                expected_task_id=task.expected_task_id,
            )

    async def _connections_tools(self, task: A2ATask):
        from hushh_mcp.services.connections_chat_service import ConnectionsChatService

        self._require_invocation(task, self._manifest)
        child_manifest = ManifestLoader.load(
            str(Path(__file__).resolve().parents[1] / "agents" / "connections" / "agent.yaml")
        )
        self._require_invocation(task, child_manifest)
        child_task = replace(
            task,
            authority=replace(
                task.authority,
                invocation_capabilities=tuple(child_manifest.authorities.invocation),
                information_grant_refs=(),
                encrypted_export_refs=(),
                action_capabilities=(),
                confirmation_receipt=None,
            ),
        )

        async def before_read():
            self._require_invocation(child_task, child_manifest)
            if await validate_first_party_owner_token(task.user_id, task.consent_token) is None:
                raise PermissionError("Connection owner authority is unavailable")

        await before_read()
        service = self._connections_service or ConnectionsChatService()
        return service.build_read_proposal_tools(task.user_id, before_read=before_read)


def _connection_proposal(raw: dict) -> tuple[A2ADirective | None, str]:
    payload = raw.get("payload") or {}
    question = str(payload.get("question") or "Please choose the connection action in the app.")
    options = payload.get("options") or []
    if payload.get("purpose") == "send_trusted_connection":
        candidates = []
        for option in options[:25]:
            ref = option.get("ref") or {}
            identity, label = ref.get("addresseeUserId"), option.get("label")
            if (
                not isinstance(identity, str)
                or not identity.strip()
                or len(identity) > 256
                or not isinstance(label, str)
                or not label.strip()
                or len(label) > 200
            ):
                raise PermissionError("Invalid connection choice")
            candidates.append({"userId": identity, "displayName": label})
        if len(candidates) < 2:
            raise PermissionError("Connection choice is incomplete")
        return A2ADirective(
            kind="prompt",
            payload={
                "type": "connections_choice",
                "question": question[:500],
                "candidates": candidates,
            },
        ), question[:500]
    if len(options) != 1 or not str(payload.get("purpose", "")).startswith("confirm_"):
        return None, question
    ref = options[0].get("ref") or {}
    mapping = {
        "send_request": ("connect.send_request", "addresseeUserId"),
        "accept": ("connect.accept_request", "requestId"),
        "reject": ("connect.reject_request", "requestId"),
        "remove": ("connect.remove_connection", "connectionId"),
    }
    action = mapping.get(ref.get("op"))
    if action is None:
        raise PermissionError("Unsupported connection proposal")
    action_id, identity_key = action
    identity = ref.get(identity_key)
    person = ref.get("label")
    if not isinstance(identity, str) or not identity.strip() or len(identity) > 256:
        raise PermissionError("Connection proposal requires an exact identity")
    if not isinstance(person, str) or not person.strip() or len(person) > 200:
        raise PermissionError("Connection proposal requires a person label")
    return A2ADirective(
        kind="action",
        payload={
            "type": "connections_proposal",
            "actionId": action_id,
            "slots": {
                "person": person,
                "userId" if identity_key == "addresseeUserId" else identity_key: identity,
            },
        },
    ), question


_singleton: NavAgent | None = None


def get_nav_a2a() -> NavAgent:
    global _singleton
    if _singleton is None:
        _singleton = NavAgent()
    return _singleton


def _default_manifest_path() -> Path:
    return Path(__file__).resolve().parents[1] / "agents" / "nav" / "agent.yaml"
