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
import time
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from hushh_mcp.one_voice.actor_proof import ActorProof, ProofOutcome, verify_firebase_actor
from hushh_mcp.one_voice.pending_actions import (
    ORIGIN_TURN_KEY,
    PendingAction,
    PendingActionConflict,
    PendingActionStore,
)
from hushh_mcp.one_voice.private_pending import open_sealed, seal
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmationRequired,
    ConfirmationWaiting,
    Rejected,
    ToolContext,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    arg_refs,
)

logger = logging.getLogger(__name__)


# Tools that start a new lookup. While one of these runs, any open card is a
# proposal about the *previous* target: a correction ("no, Priya Sharma") must
# not leave a card whose spoken yes would still act on the old one. Every
# mutation card names a counterpart one way or another (a person, a circle, or
# a request id), so all open cards are superseded, not only those with typed
# person/circle arguments.
LOOKUP_TOOLS = frozenset({"resolve_person", "resolve_circle"})
# Key under which a card's prepared-effect snapshot rides in the stored args.
# Stripped before the input model sees the args again at execution.
PREPARED_KEY = "_prepared"


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
# Result status when the model proposes a voice-tier action that is already
# open with the same arguments. Never success, never a new row or card.
CONFIRMATION_WAITING = "confirmation_waiting"
# How long the model's own cancel of a voice-tier card is remembered, so an
# unchanged re-proposal right after it can say so instead of asking again.
# Observed on UAT 2026-10-02: "Yes, go ahead for 1 hour" was read as a
# correction, the card cancelled, and the identical question asked again.
RECENT_CANCEL_SECONDS = 30.0


def _person_visible(args: dict[str, Any] | None) -> dict[str, Any]:
    """Stored args without the server's private keys (``_prepared``, origin turn)."""
    return {k: v for k, v in (args or {}).items() if not str(k).startswith("_")}


class ToolExecutor:
    def __init__(
        self,
        *,
        pending_store: PendingActionStore | None = None,
        actor_proof: ActorProof | None = None,
    ) -> None:
        self._pending = pending_store
        self._actor_proof = actor_proof or verify_firebase_actor
        # conversation_id -> (tool, public args, monotonic time) of the last
        # voice-tier card the model cancelled. In memory only: it informs the
        # model about its own last move and never confirms anything.
        self._recent_cancels: dict[str, tuple[str, dict[str, Any], float]] = {}

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
            # Every person named, so a batch cannot smuggle an unconfirmed id in
            # beside confirmed ones. An absent or empty argument names nobody and
            # is refused the same way a single missing ref always was.
            refs = arg_refs(getattr(parsed, arg, None))
            if not refs:
                return Rejected(
                    reason_code="person_not_confirmed",
                    spoken_facts=[
                        "I need to confirm who you mean first. Resolve the person, read back their name, and confirm."
                    ],
                    needs="disambiguation",
                )
            for ref in refs:
                user_id = getattr(ref, "user_id", None)
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
        self,
        ctx: ToolContext,
        name: str,
        args: dict[str, Any] | None,
        *,
        origin_turn_id: str | None = None,
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
            facts = [f"I'm missing {', '.join(missing) or 'a detail'} for that."]
            if "circle" in missing and ctx.screen.active_circle_id:
                # The person is looking at a circle: say where its id comes from
                # rather than leaving the model to guess one.
                facts.append(
                    "Call get_circle_details with no argument to read the circle on screen, "
                    "then use its circle_id."
                )
            return ToolCallOutcome(
                result=Rejected(reason_code="invalid_arguments", spoken_facts=facts),
                spec=spec,
            )
        problem = self._entity_problem(spec, ctx, parsed)
        if problem is not None:
            return ToolCallOutcome(result=problem, spec=spec, parsed=parsed)
        superseded: list[PendingAction] = []
        if spec.name in LOOKUP_TOOLS:
            superseded = await self._supersede_targeted(ctx)
        if spec.policy.needs_confirmation:
            existing = await self._open_duplicate(ctx, spec, parsed)
            if existing is not None:
                # The same proposal is already waiting. Minting a second row
                # would cancel the card the person may be answering, so the
                # model gets the existing id back instead. Nothing is confirmed.
                shown = existing.shown_at is not None
                logger.info(
                    "one_voice.pending.reused tool=%s shown=%s",
                    spec.name,
                    "yes" if shown else "no",
                )
                return ToolCallOutcome(
                    result=ConfirmationWaiting(
                        pending_action_id=existing.id,
                        summary=existing.summary,
                        card_shown=shown,
                        spoken_facts=[
                            f"That's already waiting for your answer: {existing.summary}."
                        ],
                    ),
                    spec=spec,
                    pending=existing,
                    parsed=parsed,
                )
            args_json = parsed.model_dump(mode="json")
            if spec.private_args:
                public_args = {
                    key: value for key, value in args_json.items() if key not in spec.private_args
                }
                private_args = {key: args_json[key] for key in spec.private_args}
                try:
                    sealed_args = seal(
                        private_args,
                        owner_id=ctx.user_id,
                        conversation_id=ctx.conversation_id,
                        tool=spec.name,
                        public_args=public_args,
                    )
                except Exception as exc:  # noqa: BLE001 - fail closed without persisting text
                    logger.warning(
                        "one_voice.tool.seal_failed tool=%s error=%s",
                        spec.name,
                        type(exc).__name__,
                    )
                    return ToolCallOutcome(
                        result=Rejected(
                            reason_code="private_draft_unavailable",
                            spoken_facts=[
                                "I couldn't prepare that draft securely. Nothing was sent."
                            ],
                        ),
                        spec=spec,
                        parsed=parsed,
                    )
                args_json = {**public_args, "_sealed_args": sealed_args}
            if origin_turn_id:
                args_json[ORIGIN_TURN_KEY] = origin_turn_id
            if spec.prepare is not None:
                # The exact effect is computed from authorized state now, so
                # the card names what will really happen and execution can
                # tell when that changed. A ToolResult answers without a card.
                try:
                    prepared = await spec.prepare(ctx, parsed)
                except Exception as exc:  # noqa: BLE001 - no card on an unreadable effect
                    logger.warning(
                        "one_voice.tool.prepare_failed tool=%s error=%s",
                        spec.name,
                        type(exc).__name__,
                    )
                    return ToolCallOutcome(
                        result=Rejected(
                            reason_code="prepare_failed",
                            spoken_facts=[
                                "I couldn't check what that would do right now, so I "
                                "haven't prepared it. Nothing was changed."
                            ],
                        ),
                        spec=spec,
                        parsed=parsed,
                        superseded=superseded,
                    )
                if isinstance(prepared, ToolResult):
                    return ToolCallOutcome(
                        result=prepared, spec=spec, parsed=parsed, superseded=superseded
                    )
                summary = prepared.summary
                args_json[PREPARED_KEY] = dict(prepared.snapshot)
            else:
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
                args=args_json,
                summary=summary,
            )
            repeated = self._repeats_recent_cancel(ctx, spec, parsed)
            if repeated:
                logger.info("one_voice.pending.repeat_after_cancel tool=%s", spec.name)
            result: ToolResult = ConfirmationRequired(
                pending_action_id=row.id,
                tier="tap" if row.tier == "tap" else "voice",
                summary=summary,
                spoken_facts=[
                    (
                        f"I can {summary}. Tap Confirm on the card to go ahead."
                        if row.tier == "tap"
                        else f"That's the same as the one just cancelled: {summary}."
                        if repeated
                        else f"I can {summary}. Should I go ahead?"
                    )
                ],
            )
            if repeated:
                # The model cancelled this exact proposal moments ago and made
                # it again unchanged. Say so; the model still decides.
                result = result.model_copy(update={"repeats_cancelled": True})
            return ToolCallOutcome(
                result=result,
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

    async def _open_duplicate(
        self, ctx: ToolContext, spec: ToolSpec, parsed: Any
    ) -> PendingAction | None:
        """An open voice-tier row for the same tool with identical public args.

        Voice tier only: a tap card's receipt is handed out once, at creation.
        Never for sealed args: two dictations to one recipient stay two proposals.
        """
        if not self._repeat_guarded(spec):
            return None
        wanted = parsed.model_dump(mode="json")
        for row in await self.pending.list_open(
            user_id=ctx.user_id, conversation_id=ctx.conversation_id
        ):
            if (
                row.tool_name == spec.name
                and row.tier == "voice"
                and _person_visible(row.args) == wanted
            ):
                return row
        return None

    @staticmethod
    def _repeat_guarded(spec: ToolSpec | None) -> bool:
        """Voice tier without sealed args: the same scope as the duplicate guard."""
        return (
            spec is not None and spec.policy is ToolPolicy.confirm_voice and not spec.private_args
        )

    def _remember_cancel(self, ctx: ToolContext, row: PendingAction) -> None:
        if self._repeat_guarded(registry.get_tool(row.tool_name)):
            self._recent_cancels[ctx.conversation_id] = (
                row.tool_name,
                _person_visible(row.args),
                time.monotonic(),
            )

    def _repeats_recent_cancel(self, ctx: ToolContext, spec: ToolSpec, parsed: Any) -> bool:
        """True when this proposal is the voice-tier card the model itself just
        cancelled, unchanged. Consumed by the next proposal either way."""
        recent = self._recent_cancels.pop(ctx.conversation_id, None)
        if recent is None or not self._repeat_guarded(spec):
            return False
        tool_name, args, cancelled_at = recent
        return (
            tool_name == spec.name
            and args == parsed.model_dump(mode="json")
            and time.monotonic() - cancelled_at <= RECENT_CANCEL_SECONDS
        )

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
        args = dict(pending.args or {})
        snapshot = args.pop(PREPARED_KEY, None)
        args.pop(ORIGIN_TURN_KEY, None)
        sealed_args = args.pop("_sealed_args", None)
        ctx.prepared = dict(snapshot) if isinstance(snapshot, dict) else None
        try:
            if spec.private_args:
                private = open_sealed(
                    sealed_args,
                    owner_id=ctx.user_id,
                    conversation_id=ctx.conversation_id,
                    tool=spec.name,
                    public_args=args,
                )
                if set(private) != set(spec.private_args):
                    raise ValueError("voice pending draft fields changed")
                args.update(private)
            parsed = spec.input_model.model_validate(args)
            result = await spec.handler(ctx, parsed)
        except Exception as exc:  # noqa: BLE001 - recorded as failed, never as success
            ctx.prepared = None
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
        ctx.prepared = None
        if spec.ui_refresh and result.status not in {"rejected", "unsupported"}:
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        status = "failed" if result.status in {"rejected", "unsupported"} else "executed"
        resolved = await self.pending.resolve(
            user_id=ctx.user_id,
            pending_action_id=pending.id,
            status=status,
            # A pending row is retained after it resolves. Its receipt must not
            # become a second plaintext copy of a dictated mail draft.
            result=(
                {"status": result.status, "needs": result.needs}
                if spec.private_args
                else result.public()
            ),
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
            ).model_copy(
                update={
                    "pending_action": row.public(),
                    "pending_action_id": row.id,
                    "card_shown": row.shown_at is not None,
                }
            )
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
            self._remember_cancel(ctx, cancelled)
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
            logger.info(
                "one_voice.pending.confirm_refused reason=%s",
                code if code in {"tap_required", "card_not_shown"} else "not_pending",
            )
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
                    ).model_copy(
                        # The id to confirm once the card shows, so the model
                        # retries this row instead of proposing a new one.
                        update={"pending_action_id": pending_id, "card_shown": False}
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
