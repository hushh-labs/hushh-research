"""Dispatch a model function call into the typed tool layer.

The executor is where the hallucination contract becomes mechanical:

* unknown tool → ``rejected/unknown_tool``;
* arguments that do not parse → ``rejected/invalid_arguments``; for a
  ``confirm_*`` tool the open card that proposal was correcting is retired too;
* a person/circle id not confirmed in this conversation → ``rejected/*_not_confirmed``;
* a ``confirm_*`` policy → a pending row and ``confirmation_required``; the
  handler runs only after :meth:`ToolExecutor.execute_pending`.

The executor never chooses a tool, never rewrites arguments, and never
narrates. It returns typed results the model has to read back.
"""

from __future__ import annotations

import dataclasses
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import ValidationError

from hushh_mcp.one_voice.actor_proof import ActorProof, ProofOutcome, verify_firebase_actor
from hushh_mcp.one_voice.pending_actions import (
    ORIGIN_TURN_KEY,
    PendingAction,
    PendingActionConflict,
    PendingActionStorageError,
    PendingActionStore,
)
from hushh_mcp.one_voice.private_pending import open_sealed, seal
from hushh_mcp.one_voice.tools import registry
from hushh_mcp.one_voice.tools.base import (
    ConfirmationRequired,
    ConfirmationWaiting,
    PendingActionExists,
    Rejected,
    ToolContext,
    ToolPolicy,
    ToolResult,
    ToolSpec,
    arg_refs,
)

logger = logging.getLogger(__name__)


# Lookups, and the kind of entity each one re-targets. While one runs, an open
# card about that kind of entity is a proposal about the *previous* target: a
# correction ("no, Priya Sharma") must not leave a card whose spoken yes would
# still act on the old one. A card about something else survives it -- a person
# lookup made for a follow-up request does not cancel "create Family" -- and
# ``ToolSpec.stale_on_lookup`` decides which is which from the tool's metadata.
LOOKUP_TOOLS: dict[str, Literal["person", "circle"]] = {
    "resolve_person": "person",
    "resolve_circle": "circle",
}
# Key under which a card's prepared-effect snapshot rides in the stored args.
# Stripped before the input model sees the args again at execution.
PREPARED_KEY = "_prepared"
# Key inside that snapshot naming the server-side target of a positional
# proposal (``ToolSpec.target_key``), so a duplicate is the same target too.
TARGET_KEY = "target_key"
# Reason code when voice storage could not be read or written. Fails closed:
# nothing is proposed, confirmed or cancelled on a read that did not happen,
# and the session stays up (this used to end it with close code 4013).
STORAGE_UNAVAILABLE = "storage_unavailable"


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _storage_unavailable(fact: str) -> Rejected:
    return Rejected(reason_code=STORAGE_UNAVAILABLE, spoken_facts=[fact])


def _exists_outcome(spec: ToolSpec, blocking: PendingAction, parsed: Any) -> ToolCallOutcome:
    """Refuse a proposal because a different card is still waiting.

    No row is written and the open card is untouched; the model is handed its
    id so the person can answer it (confirm or cancel) before anything new.
    """
    logger.info("one_voice.pending.blocked tool=%s open_tool=%s", spec.name, blocking.tool_name)
    tap = blocking.tier == "tap"
    fact = (
        f"Before that, this is still waiting on the card: {blocking.summary}. "
        "Tap Confirm on it, or tell me to cancel it."
        if tap
        else f"Before that, this is still waiting for your answer: {blocking.summary}. "
        "Should I go ahead with it, or cancel it?"
    )
    return ToolCallOutcome(
        result=PendingActionExists(
            pending_action_id=blocking.id,
            tool=blocking.tool_name,
            tier="tap" if tap else "voice",
            summary=blocking.summary,
            card_shown=blocking.shown_at is not None,
            spoken_facts=[fact],
        ),
        spec=spec,
        pending=blocking,
        parsed=parsed,
    )


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
    # Monotonic milliseconds per executor phase, for latency logs only.
    timings: dict[str, int] = field(default_factory=dict)

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
# Result status when a different action's card is still open. Never success,
# never a new row: that card is answered (confirmed or cancelled) first.
PENDING_ACTION_EXISTS = "pending_action_exists"
# How long the model's own cancel of a voice-tier card is remembered, so an
# unchanged re-proposal right after it can say so instead of asking again.
# Observed on UAT 2026-10-02: "Yes, go ahead for 1 hour" was read as a
# correction, the card cancelled, and the identical question asked again.
RECENT_CANCEL_SECONDS = 30.0


def _person_visible(args: dict[str, Any] | None) -> dict[str, Any]:
    """Stored args without the server's private keys (``_prepared``, origin turn)."""
    return {k: v for k, v in (args or {}).items() if not str(k).startswith("_")}


def _changed_fields(spec: ToolSpec, parsed: Any, replaced: PendingAction) -> list[str]:
    """Names of the public arguments a new proposal changed from the card it
    replaced, sorted. Names only: a value never reaches a log line."""
    new = {
        key: value
        for key, value in parsed.model_dump(mode="json").items()
        if key not in spec.private_args
    }
    old = _person_visible(replaced.args)
    return sorted(key for key in set(new) | set(old) if new.get(key) != old.get(key))


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
        timings: dict[str, int] = {}
        started = time.monotonic()
        outcome = await self._call(ctx, name, args, origin_turn_id=origin_turn_id, timings=timings)
        timings["total"] = _elapsed_ms(started)
        outcome.timings.update(timings)
        return outcome

    async def _call(
        self,
        ctx: ToolContext,
        name: str,
        args: dict[str, Any] | None,
        *,
        origin_turn_id: str | None,
        timings: dict[str, int],
    ) -> ToolCallOutcome:
        if name in registry.SESSION_TOOL_NAMES:
            return await self._session_tool(ctx, name, args or {}, timings=timings)
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
            invalid = Rejected(reason_code="invalid_arguments", spoken_facts=facts)
            if spec.policy.needs_confirmation:
                return await self._refuse_correction(
                    ctx, spec, args or {}, invalid, phase="arguments", failed=frozenset(missing)
                )
            return ToolCallOutcome(result=invalid, spec=spec)
        problem = self._entity_problem(spec, ctx, parsed)
        if problem is not None:
            return ToolCallOutcome(result=problem, spec=spec, parsed=parsed)
        superseded: list[PendingAction] = []
        lookup_kind = LOOKUP_TOOLS.get(spec.name)
        if lookup_kind is not None:
            try:
                superseded = await self._supersede_conflicting(ctx, lookup_kind)
            except PendingActionStorageError:
                # A correction cannot start while the card it corrects might
                # still be open: a later yes could act on the old target.
                logger.warning(
                    "one_voice.pending.storage_failed phase=supersede tool=%s", spec.name
                )
                return ToolCallOutcome(
                    result=_storage_unavailable(
                        "I can't look that up right now. Please try again in a moment."
                    ),
                    spec=spec,
                    parsed=parsed,
                )
        if spec.policy.needs_confirmation:
            pending_started = time.monotonic()
            try:
                open_rows = await self.pending.list_open(
                    user_id=ctx.user_id, conversation_id=ctx.conversation_id
                )
            except PendingActionStorageError:
                # "Unreadable" is not "none open": treating it so could mint a
                # duplicate beside the card the person is answering.
                logger.warning("one_voice.pending.storage_failed phase=open tool=%s", spec.name)
                return ToolCallOutcome(
                    result=_storage_unavailable(
                        "I can't prepare that right now. Nothing was changed. "
                        "Please try again in a moment."
                    ),
                    spec=spec,
                    parsed=parsed,
                )
            timings["pending"] = _elapsed_ms(pending_started)
            target = self._target_key(ctx, spec, parsed)
            existing = self._open_duplicate(ctx, spec, parsed, open_rows, target=target)
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
            blocking = self._blocking_pending(spec, open_rows)
            if blocking is not None:
                return _exists_outcome(spec, blocking, parsed)
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
                prepare_started = time.monotonic()
                try:
                    prepared = await spec.prepare(ctx, parsed)
                    timings["prepare"] = _elapsed_ms(prepare_started)
                except Exception as exc:  # noqa: BLE001 - no card on an unreadable effect
                    logger.warning(
                        "one_voice.tool.prepare_failed tool=%s error=%s",
                        spec.name,
                        type(exc).__name__,
                    )
                    unprepared = Rejected(
                        reason_code="prepare_failed",
                        spoken_facts=[
                            "I couldn't check what that would do right now, so I "
                            "haven't prepared it. Nothing was changed."
                        ],
                    )
                    return await self._refuse_correction(
                        ctx,
                        spec,
                        args or {},
                        unprepared,
                        phase="prepare",
                        parsed=parsed,
                        superseded=superseded,
                    )
                if isinstance(prepared, ToolResult):
                    if isinstance(prepared, Rejected) and prepared.retire_open_proposal:
                        # The refusal asks the person a question, so the next
                        # yes answers that question, never the card the model
                        # cancelled earlier: that re-proposal is asked fresh.
                        self._recent_cancels.pop(ctx.conversation_id, None)
                        # The refused proposal was a correction of the open
                        # card; a yes to that card would now act on what the
                        # person just corrected, so it is retired with the
                        # refusal and reported like any superseded card.
                        retired, complete = await self._retire_corrected(ctx, spec)
                        superseded = [*superseded, *retired]
                        if not complete:
                            # The card may still be open, so no question is
                            # asked over it: fail closed, as a lookup does when
                            # it cannot retire the card it corrects.
                            return ToolCallOutcome(
                                result=_storage_unavailable(
                                    "I couldn't prepare that right now. Nothing was changed. "
                                    "Please try again in a moment."
                                ),
                                spec=spec,
                                parsed=parsed,
                                superseded=superseded,
                            )
                    return ToolCallOutcome(
                        result=prepared, spec=spec, parsed=parsed, superseded=superseded
                    )
                summary = prepared.summary
                args_json[PREPARED_KEY] = dict(prepared.snapshot)
            else:
                summary = spec.summarize(ctx, parsed) if spec.summarize else spec.description
            if target is not None:
                args_json[PREPARED_KEY] = {**args_json.get(PREPARED_KEY, {}), TARGET_KEY: target}
            create_started = time.monotonic()
            try:
                # Re-read just before the insert: only cards still open now are
                # the ones the insert replaces, and each must still pass the
                # gate above -- the store's insert cancels whatever is open.
                superseded = await self.pending.list_open(
                    user_id=ctx.user_id, conversation_id=ctx.conversation_id
                )
                blocking = self._blocking_pending(spec, superseded)
                if blocking is not None:
                    return _exists_outcome(spec, blocking, parsed)
                row, receipt = await self.pending.create(
                    user_id=ctx.user_id,
                    conversation_id=ctx.conversation_id,
                    tool_name=spec.name,
                    gateway_action_id=spec.gateway_action_id,
                    tier=spec.policy.tier or "tap",
                    args=args_json,
                    summary=summary,
                )
            except PendingActionStorageError:
                # The insert may have failed after the store already retired
                # the card it was replacing, so nothing about earlier cards is
                # claimed here; only that this proposal was not made.
                logger.warning("one_voice.pending.storage_failed phase=create tool=%s", spec.name)
                return ToolCallOutcome(
                    result=_storage_unavailable(
                        "I couldn't prepare that right now. Please try again in a moment."
                    ),
                    spec=spec,
                    parsed=parsed,
                )
            timings["create"] = _elapsed_ms(create_started)
            for replaced in superseded:
                if replaced.id != row.id:
                    logger.info(
                        "one_voice.pending.superseded tool=%s fields=%s",
                        spec.name,
                        ",".join(_changed_fields(spec, parsed, replaced)),
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
        handler_started = time.monotonic()
        try:
            result = await spec.handler(ctx, parsed)
            timings["handler"] = _elapsed_ms(handler_started)
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

    @staticmethod
    def _target_key(ctx: ToolContext, spec: ToolSpec, parsed: Any) -> str | None:
        if spec.target_key is None:
            return None
        try:
            return spec.target_key(ctx, parsed)
        except Exception as exc:  # noqa: BLE001 - unresolvable target: never reuse a card
            logger.warning(
                "one_voice.tool.target_failed tool=%s error=%s", spec.name, type(exc).__name__
            )
            return None

    def _open_duplicate(
        self,
        ctx: ToolContext,
        spec: ToolSpec,
        parsed: Any,
        open_rows: list[PendingAction],
        *,
        target: str | None = None,
    ) -> PendingAction | None:
        """An open voice-tier row for the same tool with identical arguments.

        Voice tier only: a tap card's receipt is handed out once, at creation.
        Sealed arguments (a dictated mail) are compared too, by opening the open
        row's own sealed payload in memory: public args alone cannot tell two
        dictations to one recipient apart, and a different dictation is a new
        proposal. Nothing about the draft is stored or logged to make this check.
        A tool with a ``target_key`` must also name the same target: "the second
        one" of a newer list is a different email from the second of the old.
        """
        if spec.policy is not ToolPolicy.confirm_voice:
            return None
        if spec.target_key is not None and target is None:
            return None
        wanted = parsed.model_dump(mode="json")
        public_wanted = {
            key: value for key, value in wanted.items() if key not in spec.private_args
        }
        for row in open_rows:
            if (
                row.tool_name != spec.name
                or row.tier != "voice"
                or _person_visible(row.args) != public_wanted
            ):
                continue
            stored = row.args.get(PREPARED_KEY)
            if target is not None and (
                not isinstance(stored, dict) or stored.get(TARGET_KEY) != target
            ):
                continue
            if not spec.private_args:
                return row
            sealed = row.args.get("_sealed_args")
            if not isinstance(sealed, str):
                continue
            try:
                private = open_sealed(
                    sealed,
                    owner_id=ctx.user_id,
                    conversation_id=ctx.conversation_id,
                    tool=spec.name,
                    public_args=public_wanted,
                )
            except Exception:  # noqa: BLE001 - unreadable is "not the same", never an error
                continue
            if private == {key: wanted[key] for key in spec.private_args}:
                return row
        return None

    @staticmethod
    def _blocking_pending(spec: ToolSpec, open_rows: list[PendingAction]) -> PendingAction | None:
        """An open card this proposal may not replace, if there is one.

        A proposal from the same tool, or from a tool declared in the same
        ``correction_group``, corrects the card the person is looking at ("call
        it Home instead", "not Roopman") and replaces it, as before. Anything
        else does not: a card the person has seen is answered first -- confirmed
        or cancelled -- so a reviewed effect is never swapped for an unrelated
        one behind their back. A card never shown was never reviewed and blocks
        nothing (it cannot be answered either). Only a tool declared
        ``preempts_pending`` replaces a shown card unanswered.
        """
        if spec.preempts_pending:
            return None
        for row in open_rows:
            if row.shown_at is None:
                continue
            open_spec = registry.get_tool(row.tool_name)
            if open_spec is None:
                # Nothing could execute it any more; it blocks nothing.
                continue
            if open_spec.correction_key != spec.correction_key:
                return row
        return None

    @staticmethod
    def _repeat_guarded(spec: ToolSpec | None) -> bool:
        """Voice tier without sealed args. Narrower than the duplicate guard: the
        cancel memory keeps public args only, so it cannot tell two sealed
        dictations apart and never flags one as repeating another."""
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

    async def _supersede_conflicting(
        self, ctx: ToolContext, kind: Literal["person", "circle"]
    ) -> list[PendingAction]:
        """Cancel the open cards a ``kind`` lookup makes stale, and only those.

        A card whose tool is no longer in the catalog counts as stale: nothing
        could execute it. These cancels are deliberately NOT remembered by the
        recent-cancel guard: that guard lets the model confirm a re-proposal on
        the person's earlier yes, and after a lookup the earlier yes answered
        "is that who you mean?", never the action. A corrected card is asked
        fresh. The model's own cancel is still remembered, and a lookup neither
        consumes nor resets that memory.
        """
        cancelled: list[PendingAction] = []
        for row in await self.pending.list_open(
            user_id=ctx.user_id, conversation_id=ctx.conversation_id
        ):
            spec = registry.get_tool(row.tool_name)
            if spec is not None and not spec.stale_on_lookup(kind):
                continue
            done = await self.pending.cancel(user_id=ctx.user_id, pending_action_id=row.id)
            if done is not None:
                cancelled.append(done)
        return cancelled

    async def _retire_corrected(
        self, ctx: ToolContext, spec: ToolSpec
    ) -> tuple[list[PendingAction], bool]:
        """Cancel the open cards a refused correction from ``spec`` was aimed at.

        Only cards that share its correction key: an unrelated card is still the
        person's to answer. Like a lookup's supersede, these cancels are not the
        model's own and are not remembered by the recent-cancel guard.

        Returns the cards actually cancelled and whether every one was reached.
        Storage failing here never ends the session; it returns ``False`` so the
        caller fails closed, and the cards cancelled before the failure are
        still reported as retired.
        """
        retired: list[PendingAction] = []
        try:
            open_rows = await self.pending.list_open(
                user_id=ctx.user_id, conversation_id=ctx.conversation_id
            )
            for row in open_rows:
                open_spec = registry.get_tool(row.tool_name)
                if open_spec is None or open_spec.correction_key != spec.correction_key:
                    continue
                done = await self.pending.cancel(user_id=ctx.user_id, pending_action_id=row.id)
                if done is not None:
                    retired.append(done)
        except PendingActionStorageError:
            logger.warning("one_voice.pending.storage_failed phase=retire tool=%s", spec.name)
            return retired, False
        return retired, True

    async def _refuse_correction(
        self,
        ctx: ToolContext,
        spec: ToolSpec,
        raw_args: dict[str, Any],
        default: Rejected,
        *,
        phase: Literal["arguments", "prepare"],
        parsed: Any = None,
        superseded: list[PendingAction] | None = None,
        failed: frozenset[str] = frozenset(),
    ) -> ToolCallOutcome:
        """Refuse a confirm-tier proposal that could not be read or prepared.

        It was aimed at the open card of its own correction key just as a
        well-formed correction is, so that card is retired with the refusal: a
        yes must not reach what the person was correcting. If it cannot be
        retired, nothing is asked over it (fail closed). The answer is the
        tool's own ``on_invalid_correction`` refusal when it gives one, else
        ``default``. ``raw_args`` go only to that hook, never to a log, with
        ``failed``: the names of the top-level arguments that failed validation.
        """
        retired, complete = await self._retire_corrected(ctx, spec)
        if retired:
            # The next yes answers this refusal's question, never a card the
            # model cancelled earlier: a re-proposal is asked fresh.
            self._recent_cancels.pop(ctx.conversation_id, None)
            logger.info(
                "one_voice.pending.retired phase=%s tool=%s count=%d",
                phase,
                spec.name,
                len(retired),
            )
        cancelled = [*(superseded or []), *retired]
        if not complete:
            return ToolCallOutcome(
                result=_storage_unavailable(
                    "I couldn't prepare that right now. Nothing was changed. "
                    "Please try again in a moment."
                ),
                spec=spec,
                parsed=parsed,
                superseded=cancelled,
            )
        result = default
        if spec.on_invalid_correction is not None:
            try:
                specific = spec.on_invalid_correction(dict(raw_args), failed)
            except Exception as exc:  # noqa: BLE001 - a broken hook keeps the generic refusal
                logger.warning(
                    "one_voice.tool.refusal_failed tool=%s error=%s",
                    spec.name,
                    type(exc).__name__,
                )
                specific = None
            if isinstance(specific, Rejected):
                result = specific
        return ToolCallOutcome(result=result, spec=spec, parsed=parsed, superseded=cancelled)

    async def _resolve_failed(
        self,
        ctx: ToolContext,
        spec: ToolSpec,
        pending: PendingAction,
        result: dict[str, Any],
    ) -> PendingAction:
        """Record a failed execution and return the row as resolved.

        The caller hands this row back so the relay retires the card; the
        confirmed row it started from would leave a dead card that still looks
        answerable. An unwritable ledger row never replaces the answer or ends
        the session: the card is retired from this answer, not from storage.
        """
        try:
            resolved = await self.pending.resolve(
                user_id=ctx.user_id,
                pending_action_id=pending.id,
                status="failed",
                result=result,
            )
        except PendingActionStorageError:
            logger.warning("one_voice.pending.storage_failed phase=resolve tool=%s", spec.name)
            resolved = None
        return (
            resolved
            if resolved is not None
            else dataclasses.replace(pending, status="failed", result=result)
        )

    async def execute_pending(
        self,
        ctx: ToolContext,
        pending: PendingAction,
        *,
        timings: dict[str, int] | None = None,
    ) -> ToolCallOutcome:
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
        except Exception:  # noqa: BLE001 - nothing has run yet, so nothing changed
            # The stored proposal could not be opened (a sealed draft that fails
            # authentication, arguments that no longer validate). The handler
            # never started, so "I can't confirm whether anything changed"
            # would be wrong in the other direction: nothing did.
            ctx.prepared = None
            reason = "private_draft_unavailable" if spec.private_args else "invalid_arguments"
            failed_row = await self._resolve_failed(
                ctx, spec, pending, {"status": reason, "outcome": "not_started"}
            )
            return ToolCallOutcome(
                result=Rejected(
                    reason_code=reason,
                    spoken_facts=[
                        "I couldn't open that draft securely, so I didn't open it. "
                        "Nothing was sent."
                        if spec.private_args
                        else "That didn't go through. Nothing was changed."
                    ],
                ),
                spec=spec,
                pending=failed_row,
            )
        handler_started = time.monotonic()
        try:
            result = await spec.handler(ctx, parsed)
        except Exception as exc:  # noqa: BLE001 - recorded as failed, never as success
            ctx.prepared = None
            failed_row = await self._resolve_failed(
                ctx, spec, pending, {"error_class": type(exc).__name__, "outcome": "unknown"}
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
                pending=failed_row,
            )
        ctx.prepared = None
        if timings is not None:
            timings["handler"] = _elapsed_ms(handler_started)
        if spec.ui_refresh and result.status not in {"rejected", "unsupported"}:
            result.ui_refresh = sorted(set(result.ui_refresh) | set(spec.ui_refresh))
        status = "failed" if result.status in {"rejected", "unsupported"} else "executed"
        # A pending row is retained after it resolves. Its receipt must not
        # become a second plaintext copy of a dictated mail draft.
        recorded = (
            {"status": result.status, "needs": result.needs}
            if spec.private_args
            else result.public()
        )
        try:
            resolved = await self.pending.resolve(
                user_id=ctx.user_id,
                pending_action_id=pending.id,
                status=status,
                result=recorded,
            )
        except PendingActionStorageError:
            # The service already answered, so its result is the truth about
            # the effect and is reported as it stands. Only the voice ledger row
            # could not be written: it stays "confirmed" (never re-executable),
            # and the card is retired from this answer, not from storage.
            logger.warning("one_voice.pending.storage_failed phase=resolve tool=%s", spec.name)
            resolved = dataclasses.replace(pending, status=status, result=recorded)
        return ToolCallOutcome(
            result=result,
            spec=spec,
            pending=resolved if resolved is not None else pending,
            parsed=parsed,
        )

    # -- session tools -------------------------------------------------------

    async def _session_tool(
        self,
        ctx: ToolContext,
        name: str,
        args: dict[str, Any],
        *,
        timings: dict[str, int],
    ) -> ToolCallOutcome:
        try:
            return await self._session_tool_inner(ctx, name, args, timings=timings)
        except PendingActionStorageError:
            # Nothing was confirmed, cancelled or executed on a read or a
            # compare-and-set that did not happen; the card stays as it was.
            logger.warning("one_voice.pending.storage_failed phase=session tool=%s", name)
            return ToolCallOutcome(
                result=_storage_unavailable(
                    "I couldn't reach that right now, so nothing was changed. "
                    "Please try again in a moment."
                )
            )

    async def _session_tool_inner(
        self,
        ctx: ToolContext,
        name: str,
        args: dict[str, Any],
        *,
        timings: dict[str, int],
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
        confirm_started = time.monotonic()
        try:
            row = await self.pending.confirm(
                user_id=ctx.user_id, pending_action_id=pending_id, source="voice"
            )
            timings["confirm"] = _elapsed_ms(confirm_started)
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
        return await self.execute_pending(ctx, row, timings=timings)
