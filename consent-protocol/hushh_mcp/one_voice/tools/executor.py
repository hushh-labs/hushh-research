"""Dispatch a model function call into the typed tool layer.

The executor is where the hallucination contract becomes mechanical:

* unknown tool → ``rejected/unknown_tool``;
* arguments that do not parse → ``rejected/invalid_arguments``;
* a person/circle id not confirmed in this conversation → ``rejected/*_not_confirmed``;
* a ``confirm_*`` policy → a pending row and ``confirmation_required``; the
  handler runs only after :meth:`ToolExecutor.execute_pending`.

The executor never chooses a tool, never rewrites arguments, and never
narrates. It returns typed results the model has to read back.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from hushh_mcp.one_voice.actor_proof import ActorProof, ProofOutcome, verify_firebase_actor
from hushh_mcp.one_voice.pending_actions import (
    PendingAction,
    PendingActionConflict,
    PendingActionStore,
)
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmationRequired,
    Rejected,
    ToolContext,
    ToolResult,
    ToolSpec,
)

logger = logging.getLogger(__name__)


# Tools that start a new lookup. While one of these runs, any open card is a
# proposal about the *previous* target: a correction ("no, Priya Sharma") must
# not leave a card whose spoken yes would still act on the old one. Every
# mutation card names a counterpart one way or another (a person, a circle, or
# a request id), so all open cards are superseded, not only those with typed
# person/circle arguments.
LOOKUP_TOOLS = frozenset({"resolve_person", "resolve_circle"})


@dataclass
class ToolCallOutcome:
    result: ToolResult
    spec: ToolSpec | None = None
    pending: PendingAction | None = None
    receipt_token: str | None = None
    # The parsed input, exposed so the relay can render an entity card.
    parsed: Any = None
    # Open pending actions this call superseded (a newer proposal replaced
    # them, or a new lookup made their target stale). The relay tells the
    # client and the model so no card outlives its meaning.
    superseded: list[PendingAction] = field(default_factory=list)

    @property
    def public(self) -> dict[str, Any]:
        return self.result.public()


# Result status when a firebase-plane confirmation arrives without a proof
# that names the signed-in user. Never success; the card stays pending so a
# tap (which carries a fresh proof) can still complete it.
FIREBASE_PROOF_REQUIRED = "firebase_proof_required"


class ToolExecutor:
    def __init__(
        self,
        *,
        pending_store: PendingActionStore | None = None,
        actor_proof: ActorProof | None = None,
    ) -> None:
        self._pending = pending_store
        self._actor_proof = actor_proof or verify_firebase_actor

    async def prove_actor(self, ctx: ToolContext, spec: ToolSpec | None) -> ProofOutcome:
        """For a firebase-plane tool, verify the context's Firebase proof names
        the signed-in user. Other tools need no proof beyond the session."""
        if spec is None or not spec.firebase_plane:
            return "ok"
        return await self._actor_proof(ctx.firebase_id_token, ctx.user_id)

    @property
    def pending(self) -> PendingActionStore:
        if self._pending is None:
            self._pending = PendingActionStore()
        return self._pending

    # -- entity guards -------------------------------------------------------

    @staticmethod
    def _entity_problem(spec: ToolSpec, ctx: ToolContext, parsed: Any) -> Rejected | None:
        for arg in spec.person_args:
            ref = getattr(parsed, arg, None)
            user_id = getattr(ref, "user_id", None) if ref is not None else None
            if not user_id or ctx.entities.person(str(user_id)) is None:
                return Rejected(
                    reason_code="person_not_confirmed",
                    spoken_facts=[
                        "I need to confirm who you mean first. Resolve the person, read back their name, and confirm."
                    ],
                    needs="disambiguation",
                )
        for arg in spec.circle_args:
            ref = getattr(parsed, arg, None)
            circle_id = getattr(ref, "circle_id", None) if ref is not None else None
            if not circle_id or ctx.entities.circle(str(circle_id)) is None:
                return Rejected(
                    reason_code="circle_not_confirmed",
                    spoken_facts=["I need to confirm which circle you mean first."],
                    needs="disambiguation",
                )
        return None

    # -- dispatch ------------------------------------------------------------

    async def call(
        self, ctx: ToolContext, name: str, args: dict[str, Any] | None
    ) -> ToolCallOutcome:
        if name in registry.SESSION_TOOL_NAMES:
            return await self._session_tool(ctx, name, args or {})
        spec = registry.get_tool(name)
        if spec is None:
            return ToolCallOutcome(
                result=Rejected(
                    reason_code="unknown_tool",
                    spoken_facts=["I can't do that here."],
                )
            )
        try:
            parsed = spec.input_model.model_validate(args or {})
        except ValidationError as exc:
            missing = sorted({str(err.get("loc", ("?",))[0]) for err in exc.errors()})
            return ToolCallOutcome(
                result=Rejected(
                    reason_code="invalid_arguments",
                    spoken_facts=[f"I'm missing {', '.join(missing) or 'a detail'} for that."],
                ),
                spec=spec,
            )
        problem = self._entity_problem(spec, ctx, parsed)
        if problem is not None:
            return ToolCallOutcome(result=problem, spec=spec, parsed=parsed)
        superseded: list[PendingAction] = []
        if spec.name in LOOKUP_TOOLS:
            superseded = await self._supersede_targeted(ctx)
        if spec.policy.needs_confirmation:
            summary = spec.summarize(ctx, parsed) if spec.summarize else spec.description
            superseded = await self.pending.list_open(
                user_id=ctx.user_id, conversation_id=ctx.conversation_id
            )
            row, receipt = await self.pending.create(
                user_id=ctx.user_id,
                conversation_id=ctx.conversation_id,
                tool_name=spec.name,
                gateway_action_id=spec.gateway_action_id,
                tier=spec.policy.tier or "tap",
                args=parsed.model_dump(mode="json"),
                summary=summary,
            )
            return ToolCallOutcome(
                result=ConfirmationRequired(
                    pending_action_id=row.id,
                    tier="tap" if row.tier == "tap" else "voice",
                    summary=summary,
                    spoken_facts=[
                        (
                            f"I can {summary}. Tap Confirm on the card to go ahead."
                            if row.tier == "tap"
                            else f"I can {summary}. Should I go ahead?"
                        )
                    ],
                ),
                spec=spec,
                pending=row,
                receipt_token=receipt,
                parsed=parsed,
                superseded=[item for item in superseded if item.id != row.id],
            )
        try:
            result = await spec.handler(ctx, parsed)
        except Exception as exc:  # noqa: BLE001 - a broken tool must not end the session
            logger.warning("one_voice.tool.failed tool=%s error=%s", spec.name, type(exc).__name__)
            # Cards superseded before the handler ran are still superseded.
            return ToolCallOutcome(
                result=Rejected(
                    reason_code="execution_failed",
                    spoken_facts=["I couldn't check that right now. Nothing was changed."],
                ),
                spec=spec,
                parsed=parsed,
                superseded=superseded,
            )
        if spec.ui_refresh and result.status not in {"rejected", "unsupported"}:
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        return ToolCallOutcome(result=result, spec=spec, parsed=parsed, superseded=superseded)

    async def _supersede_targeted(self, ctx: ToolContext) -> list[PendingAction]:
        """Cancel every open pending action: a new lookup makes its target stale."""
        cancelled: list[PendingAction] = []
        for row in await self.pending.list_open(
            user_id=ctx.user_id, conversation_id=ctx.conversation_id
        ):
            done = await self.pending.cancel(user_id=ctx.user_id, pending_action_id=row.id)
            if done is not None:
                cancelled.append(done)
        return cancelled

    async def execute_pending(self, ctx: ToolContext, pending: PendingAction) -> ToolCallOutcome:
        """Run the handler for a *confirmed* pending action and record the result."""
        spec = registry.get_tool(pending.tool_name)
        if spec is None or pending.status != "confirmed":
            return ToolCallOutcome(
                result=Rejected(reason_code="pending_not_confirmed"), spec=spec, pending=pending
            )
        result: ToolResult
        try:
            parsed = spec.input_model.model_validate(pending.args)
            result = await spec.handler(ctx, parsed)
        except Exception as exc:  # noqa: BLE001 - recorded as failed, never as success
            await self.pending.resolve(
                user_id=ctx.user_id,
                pending_action_id=pending.id,
                status="failed",
                result={"error_class": type(exc).__name__, "outcome": "unknown"},
            )
            # The handler died somewhere between "not started" and "committed":
            # "nothing changed" would be a claim, not a fact.
            return ToolCallOutcome(
                result=Rejected(
                    reason_code="execution_failed",
                    spoken_facts=[
                        "That didn't go through, and I can't confirm whether anything "
                        "changed. Check before trying again."
                    ],
                ),
                spec=spec,
                pending=pending,
            )
        if spec.ui_refresh and result.status not in {"rejected", "unsupported"}:
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        status = "failed" if result.status in {"rejected", "unsupported"} else "executed"
        resolved = await self.pending.resolve(
            user_id=ctx.user_id, pending_action_id=pending.id, status=status, result=result.public()
        )
        return ToolCallOutcome(
            result=result,
            spec=spec,
            pending=resolved if resolved is not None else pending,
            parsed=parsed,
        )

    # -- session tools -------------------------------------------------------

    async def _session_tool(
        self, ctx: ToolContext, name: str, args: dict[str, Any]
    ) -> ToolCallOutcome:
        pending_id = str(args.get("pending_action_id") or "").strip()
        if name == "get_pending_action":
            open_rows = await self.pending.list_open(
                user_id=ctx.user_id, conversation_id=ctx.conversation_id
            )
            if not open_rows:
                return ToolCallOutcome(
                    result=ToolResult(
                        status="none", spoken_facts=["Nothing is waiting for confirmation."]
                    )
                )
            row = open_rows[0]
            summary_result = ToolResult(
                status="pending", spoken_facts=[f"Waiting for confirmation: {row.summary}."]
            ).model_copy(update={"pending_action": row.public()})
            return ToolCallOutcome(result=summary_result, pending=row)
        if not pending_id:
            return ToolCallOutcome(result=Rejected(reason_code="invalid_arguments"))
        if name == "cancel_pending_action":
            cancelled = await self.pending.cancel(user_id=ctx.user_id, pending_action_id=pending_id)
            if cancelled is None:
                return ToolCallOutcome(
                    result=ToolResult(
                        status="not_pending", spoken_facts=["There was nothing pending to cancel."]
                    )
                )
            return ToolCallOutcome(
                result=ToolResult(
                    status="cancelled", spoken_facts=["Okay, cancelled. Nothing was changed."]
                ),
                pending=cancelled,
            )
        # confirm_pending_action (voice tier only)
        current = await self.pending.get(user_id=ctx.user_id, pending_action_id=pending_id)
        if current is not None and current.status == "pending" and current.tier != "tap":
            # A tap-tier card gets the tap_required answer below; its proof is
            # checked on the tap. A voice-tier card needs the session's proof
            # now. The row stays pending either way, and the outcome carries no
            # pending row: the client already holds the card and its receipt.
            proof = await self.prove_actor(ctx, registry.get_tool(current.tool_name))
            if proof != "ok":
                return ToolCallOutcome(
                    result=ToolResult(
                        status=FIREBASE_PROOF_REQUIRED,
                        reason_code=f"firebase_proof_{proof}",
                        needs="confirmation",
                        spoken_facts=[
                            "I need you to tap Confirm on the card for this one, to prove it's you."
                        ],
                    )
                )
        try:
            row = await self.pending.confirm(
                user_id=ctx.user_id, pending_action_id=pending_id, source="voice"
            )
        except PendingActionConflict as exc:
            code = str(exc)
            if code == "tap_required":
                return ToolCallOutcome(
                    result=ToolResult(
                        status="tap_required",
                        reason_code="tap_required",
                        spoken_facts=["This one needs a tap. Please tap Confirm on the card."],
                        needs="confirmation",
                    )
                )
            if code == "card_not_shown":
                return ToolCallOutcome(
                    result=ToolResult(
                        status="card_not_shown",
                        reason_code="card_not_shown",
                        spoken_facts=[
                            "The confirmation hasn't appeared on screen yet. One moment."
                        ],
                        needs="confirmation",
                    )
                )
            return ToolCallOutcome(
                result=ToolResult(
                    status="not_pending",
                    reason_code=code,
                    spoken_facts=["That action is no longer waiting for confirmation."],
                )
            )
        return await self.execute_pending(ctx, row)
