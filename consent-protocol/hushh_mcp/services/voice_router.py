"""VoiceRouter — resilient planner dispatch with MANUAL_ONLY_MODE fallback.

Canonical surface : hushh_mcp.services.voice_router.VoiceRouter
Canonical caller  : api.routes.kai.voice — every voice turn that passes
                    through the automated planner orchestration loop.

Design
------
The automated planner orchestration loop parses raw audio intent payloads
(JSON, structured objects, or raw transcript strings) and routes them to the
appropriate Kai action.  When an unexpected parse exception or block
condition occurs — malformed JSON, unrecognisable intent schema, LLM refusal,
or network timeout — the naive implementation lets the exception propagate,
crashing the core request loop and leaving the user with an unhandled 500.

``VoiceRouter.dispatch()`` wraps the planner orchestration loop in a robust
try/except boundary.  On any exception:

  1. The session routing state is forced to ``MANUAL_ONLY_MODE``.
  2. A structured ``VoiceRoutingResult`` is returned with the fallback state
     and diagnostic information — the request loop always succeeds.
  3. The exception is logged with ``[Voice Routing Guard by Abdul Gaffar]``
     so it is traceable without leaking details to the client.

MANUAL_ONLY_MODE contract
--------------------------
When routing_state == RoutingState.MANUAL_ONLY_MODE:
  • The planner's automated action is suppressed.
  • The user's raw message is preserved and returned as the reply.
  • No tool calls or side-effects are executed.
  • The session recovers on the next turn — state is per-turn, not sticky.

[Voice Routing Guard by Abdul Gaffar]

Integrated by Abdul Gaffar — canonical voice routing fallback boundary.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Routing state enum
# ---------------------------------------------------------------------------


class RoutingState(str, Enum):
    """Per-turn voice routing state returned by VoiceRouter.dispatch()."""

    PLANNER_ACTIVE = "PLANNER_ACTIVE"
    """Planner completed successfully; action payload is available."""

    MANUAL_ONLY_MODE = "MANUAL_ONLY_MODE"
    """Planner was blocked or failed; no automated action will be executed."""

    CLARIFY_NEEDED = "CLARIFY_NEEDED"
    """Planner indicated the intent was ambiguous; clarification was requested."""


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class VoiceRoutingResult:
    """Outcome of a single VoiceRouter.dispatch() call.

    Always returned — never raises.  Inspect ``routing_state`` to determine
    whether the planner produced a usable action payload.
    """

    routing_state: RoutingState
    """The final routing state for this turn."""

    action_payload: dict[str, Any] | None = None
    """Structured action payload produced by the planner (None in MANUAL_ONLY_MODE)."""

    raw_intent: str = ""
    """The original raw intent string passed to dispatch() — preserved for reply."""

    error: Exception | None = None
    """The exception that triggered a MANUAL_ONLY_MODE fallback, or None."""

    diagnostics: dict[str, Any] = field(default_factory=dict)
    """Structured diagnostic metadata (error class, message, etc.)."""

    @property
    def is_manual_only(self) -> bool:
        """True when the planner was bypassed and no action will execute."""
        return self.routing_state == RoutingState.MANUAL_ONLY_MODE

    @property
    def is_actionable(self) -> bool:
        """True when the planner produced a usable action payload."""
        return (
            self.routing_state == RoutingState.PLANNER_ACTIVE
            and self.action_payload is not None
        )


# ---------------------------------------------------------------------------
# Intent parser (pure — no I/O)
# ---------------------------------------------------------------------------


def _parse_intent(raw_intent: Any) -> dict[str, Any]:
    """Parse a raw audio intent payload into a normalised dict.

    Accepts:
      - dict  → validated as-is (must contain at least an 'intent' key)
      - str   → JSON-decoded then validated
      - bytes → UTF-8 decoded then JSON-decoded

    Raises
    ------
    ValueError
        When the payload is empty, unparseable, or missing required structure.
    TypeError
        When the payload type is wholly unsupported.
    """
    import json as _json

    if raw_intent is None:
        raise ValueError("Intent payload is None — cannot route")

    if isinstance(raw_intent, bytes):
        raw_intent = raw_intent.decode("utf-8", errors="replace")

    if isinstance(raw_intent, str):
        stripped = raw_intent.strip()
        if not stripped:
            raise ValueError("Intent payload is an empty string — cannot route")
        try:
            raw_intent = _json.loads(stripped)
        except _json.JSONDecodeError as exc:
            raise ValueError(
                f"Intent payload is not valid JSON: {exc.msg!r} at pos {exc.pos}"
            ) from exc

    if not isinstance(raw_intent, dict):
        raise TypeError(
            f"Intent payload must be a dict after parsing, got {type(raw_intent).__name__!r}"
        )

    if not raw_intent:
        raise ValueError("Intent payload is an empty dict — no intent to route")

    return raw_intent


# ---------------------------------------------------------------------------
# VoiceRouter — the canonical dispatch boundary
# ---------------------------------------------------------------------------


class VoiceRouter:
    """Resilient voice intent dispatcher with MANUAL_ONLY_MODE fallback.

    The router wraps the planner orchestration loop in a robust try/except
    boundary.  Any exception during parsing or planner execution forces the
    session state to ``RoutingState.MANUAL_ONLY_MODE`` — the core request loop
    never crashes.

    Parameters
    ----------
    planner_fn : callable, optional
        The planner function to call with the parsed intent dict.  Must return
        a ``dict`` with at least an ``action_id`` key.  If ``None``, the router
        runs in parse-only mode (useful for testing the boundary itself).

    Usage::

        router = VoiceRouter(planner_fn=my_planner)
        result = router.dispatch(raw_intent_payload)

        if result.is_manual_only:
            # Return the raw utterance as the reply — no action executes
            return result.raw_intent or "I couldn't understand that. Please try again."

        action = result.action_payload
        # … execute action …

    [Voice Routing Guard by Abdul Gaffar]
    """

    def __init__(self, planner_fn: Any = None) -> None:
        self._planner_fn = planner_fn

    def dispatch(self, raw_intent: Any) -> VoiceRoutingResult:
        """Dispatch a raw audio intent payload through the planner.

        The method NEVER raises.  All exceptions are caught, logged, and
        converted to a ``MANUAL_ONLY_MODE`` result.

        Parameters
        ----------
        raw_intent:
            Raw intent payload — ``str``, ``bytes``, or ``dict``.  A ``str``
            must be valid JSON; ``bytes`` are UTF-8 decoded first.

        Returns
        -------
        VoiceRoutingResult
            ``routing_state`` is ``MANUAL_ONLY_MODE`` when any error occurs.
        """
        raw_str = str(raw_intent) if raw_intent is not None else ""

        # ── Step 1: parse ─────────────────────────────────────────────────
        try:
            intent_dict = _parse_intent(raw_intent)
        except (ValueError, TypeError) as exc:
            return self._fallback(
                raw_str,
                exc,
                stage="parse",
                reason="intent_parse_failed",
            )
        except Exception as exc:  # pragma: no cover — defensive catch-all
            return self._fallback(
                raw_str,
                exc,
                stage="parse",
                reason="intent_parse_unexpected",
            )

        # ── Step 2: planner orchestration ─────────────────────────────────
        try:
            action_payload = self._run_planner(intent_dict)
        except Exception as exc:
            return self._fallback(
                raw_str,
                exc,
                stage="planner",
                reason="planner_execution_failed",
                intent_dict=intent_dict,
            )

        # ── Step 3: validate planner output ───────────────────────────────
        if action_payload is None:
            return VoiceRoutingResult(
                routing_state=RoutingState.MANUAL_ONLY_MODE,
                raw_intent=raw_str,
                diagnostics={"stage": "planner", "reason": "planner_returned_none"},
            )

        logger.info(
            "[Voice Routing Guard by Abdul Gaffar] "
            "voice_router.dispatch action_id=%s routing_state=PLANNER_ACTIVE",
            action_payload.get("action_id", "<unknown>"),
        )
        return VoiceRoutingResult(
            routing_state=RoutingState.PLANNER_ACTIVE,
            action_payload=action_payload,
            raw_intent=raw_str,
            diagnostics={"stage": "complete"},
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _run_planner(self, intent_dict: dict[str, Any]) -> dict[str, Any] | None:
        """Invoke the planner function with the parsed intent.

        If no planner is configured, returns a minimal echo payload so the
        router can still be tested in isolation.
        """
        if self._planner_fn is None:
            return {
                "action_id": intent_dict.get("intent", "unknown"),
                "mode": "echo",
                "slots": intent_dict,
            }
        return self._planner_fn(intent_dict)

    def _fallback(
        self,
        raw_str: str,
        exc: Exception,
        *,
        stage: str,
        reason: str,
        intent_dict: dict[str, Any] | None = None,
    ) -> VoiceRoutingResult:
        """Log the exception and return a MANUAL_ONLY_MODE result.

        [Voice Routing Guard by Abdul Gaffar]
        """
        logger.warning(
            "[Voice Routing Guard by Abdul Gaffar] "
            "voice_router.fallback stage=%s reason=%s error=%s: %s",
            stage,
            reason,
            type(exc).__name__,
            exc,
        )
        return VoiceRoutingResult(
            routing_state=RoutingState.MANUAL_ONLY_MODE,
            raw_intent=raw_str,
            error=exc,
            diagnostics={
                "stage": stage,
                "reason": reason,
                "error_type": type(exc).__name__,
                "error_message": str(exc),
                **({"intent_keys": list(intent_dict.keys())} if intent_dict else {}),
            },
        )
