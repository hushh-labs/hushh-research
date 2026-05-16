"""Voice routing fallback tests — MANUAL_ONLY_MODE on planner exceptions.

[Voice Routing Guard by Abdul Gaffar]

Verifies that ``hushh_mcp.services.voice_router.VoiceRouter.dispatch()``
never crashes the core request loop when it receives broken, unparseable, or
structurally invalid audio intent stream payloads — instead it always forces
the session routing state to ``RoutingState.MANUAL_ONLY_MODE``.

Problem being solved
--------------------
The automated planner orchestration loop parses raw audio intent payloads and
routes them to the appropriate Kai action.  When a parse exception or block
condition occurs, the naive implementation lets the exception propagate,
crashing the request loop and giving the user an unhandled 500.

``VoiceRouter.dispatch()`` wraps the entire planner loop in a robust
try/except boundary.  Any exception — malformed JSON, empty payload, type
error, planner crash — transitions the session to MANUAL_ONLY_MODE.  The
request loop ALWAYS returns a ``VoiceRoutingResult``.

Canonical surface : hushh_mcp.services.voice_router.VoiceRouter
Canonical caller  : api.routes.kai.voice — every voice turn that passes
                    through the automated planner orchestration loop.

No DB, no network, no LLM.

[Voice Routing Guard by Abdul Gaffar]
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services.voice_router import (
    RoutingState,
    VoiceRouter,
    VoiceRoutingResult,
    _parse_intent,
)

# ===========================================================================
# TestBrokenPayloadFallback — core contract: broken input → MANUAL_ONLY_MODE
# ===========================================================================


class TestBrokenPayloadFallback:
    """[Voice Routing Guard by Abdul Gaffar] Broken payloads must produce MANUAL_ONLY_MODE."""

    def test_unparseable_string_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Broken JSON string → MANUAL_ONLY_MODE."""
        router = VoiceRouter()

        result = router.dispatch("<<<broken audio intent stream payload>>>")

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE, (
            "[Voice Routing Guard by Abdul Gaffar] "
            "Broken string must fall back to MANUAL_ONLY_MODE"
        )

    def test_dispatch_never_raises_on_broken_payload(self):
        """[Voice Routing Guard by Abdul Gaffar] dispatch() must NEVER raise — always returns a result."""
        router = VoiceRouter()

        # This must not raise even with completely garbage input
        result = router.dispatch("<<< completely broken audio intent stream >>>")

        assert isinstance(result, VoiceRoutingResult)

    def test_empty_string_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Empty string → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch("")

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_whitespace_only_string_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Whitespace-only string → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch("   \n\t   ")

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_none_payload_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] None payload → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch(None)

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_partial_json_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Truncated JSON → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch('{"intent": "play_music", "slo')

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_wrong_type_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] JSON array (not object) → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch('["not", "a", "dict"]')

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_empty_dict_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Empty dict → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch("{}")

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_bytes_garbage_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Raw binary garbage → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch(b"\xff\xfe invalid utf8 intent bytes")

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE


# ===========================================================================
# TestManualOnlyModeProperties — result structure when fallback triggers
# ===========================================================================


class TestManualOnlyModeProperties:
    """[Voice Routing Guard by Abdul Gaffar] MANUAL_ONLY_MODE result has correct properties."""

    def test_is_manual_only_property_true_on_fallback(self):
        """result.is_manual_only is True when MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch("broken payload")

        assert result.is_manual_only is True

    def test_is_actionable_property_false_on_fallback(self):
        """result.is_actionable is False when MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch("broken payload")

        assert result.is_actionable is False

    def test_action_payload_is_none_on_fallback(self):
        """action_payload is None when MANUAL_ONLY_MODE — no action executes."""
        router = VoiceRouter()
        result = router.dispatch("broken payload")

        assert result.action_payload is None

    def test_error_is_recorded_on_fallback(self):
        """result.error holds the exception that triggered the fallback."""
        router = VoiceRouter()
        result = router.dispatch("not valid json {{ garbage }}")

        assert result.error is not None
        assert isinstance(result.error, Exception)

    def test_diagnostics_contain_stage_and_reason(self):
        """result.diagnostics has 'stage' and 'reason' keys."""
        router = VoiceRouter()
        result = router.dispatch("broken")

        assert "stage" in result.diagnostics
        assert "reason" in result.diagnostics

    def test_raw_intent_preserved_in_result(self):
        """result.raw_intent carries the original payload for reply construction."""
        router = VoiceRouter()
        payload = "<<< audio intent: play my morning playlist >>>"
        result = router.dispatch(payload)

        assert result.raw_intent == payload


# ===========================================================================
# TestPlannerExceptionFallback — planner itself raises → MANUAL_ONLY_MODE
# ===========================================================================


class TestPlannerExceptionFallback:
    """[Voice Routing Guard by Abdul Gaffar] Planner exceptions → MANUAL_ONLY_MODE."""

    def test_planner_raises_falls_back_to_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Planner crash → MANUAL_ONLY_MODE."""
        def _crashing_planner(_intent: dict) -> None:
            raise RuntimeError("Planner internal error — LLM timeout")

        router = VoiceRouter(planner_fn=_crashing_planner)
        valid_intent = json.dumps({"intent": "play_music", "slots": {"artist": "Daft Punk"}})

        result = router.dispatch(valid_intent)

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE, (
            "[Voice Routing Guard by Abdul Gaffar] "
            "Planner crash must fall back to MANUAL_ONLY_MODE"
        )

    def test_planner_raises_does_not_propagate_exception(self):
        """dispatch() never propagates exceptions from the planner."""
        def _raising_planner(_intent: dict) -> None:
            raise ValueError("Cannot parse planner output — schema mismatch")

        router = VoiceRouter(planner_fn=_raising_planner)
        valid_intent = '{"intent": "set_alarm", "time": "07:00"}'

        # Must not raise
        result = router.dispatch(valid_intent)
        assert isinstance(result, VoiceRoutingResult)

    def test_planner_returns_none_falls_back_to_manual_only(self):
        """If planner returns None, the router falls back to MANUAL_ONLY_MODE."""
        router = VoiceRouter(planner_fn=lambda _: None)
        valid_intent = '{"intent": "check_weather"}'

        result = router.dispatch(valid_intent)

        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    def test_planner_raises_error_recorded(self):
        """The planner exception is recorded in result.error."""
        original_exc = RuntimeError("LLM parse block")

        def _exc_planner(_intent: dict) -> None:
            raise original_exc

        router = VoiceRouter(planner_fn=_exc_planner)
        result = router.dispatch('{"intent": "navigate"}')

        assert result.error is original_exc

    def test_planner_diagnostics_contain_planner_stage(self):
        """When the planner raises, diagnostics show stage='planner'."""
        router = VoiceRouter(planner_fn=lambda _: (_ for _ in ()).throw(OSError("timeout")))
        result = router.dispatch('{"intent": "search"}')

        assert result.diagnostics.get("stage") == "planner"
        assert result.diagnostics.get("reason") == "planner_execution_failed"


# ===========================================================================
# TestValidIntentSucceeds — happy path contrast
# ===========================================================================


class TestValidIntentSucceeds:
    """[Voice Routing Guard by Abdul Gaffar] Valid payloads route as PLANNER_ACTIVE."""

    def test_valid_json_string_routes_as_planner_active(self):
        """A well-formed JSON intent → PLANNER_ACTIVE routing state."""
        router = VoiceRouter()
        valid = json.dumps({"intent": "play_music", "artist": "Daft Punk"})

        result = router.dispatch(valid)

        assert result.routing_state == RoutingState.PLANNER_ACTIVE

    def test_valid_dict_routes_as_planner_active(self):
        """A dict intent → PLANNER_ACTIVE routing state."""
        router = VoiceRouter()
        result = router.dispatch({"intent": "set_alarm", "time": "07:00"})

        assert result.routing_state == RoutingState.PLANNER_ACTIVE

    def test_valid_bytes_json_routes_as_planner_active(self):
        """A UTF-8 encoded JSON bytes intent → PLANNER_ACTIVE."""
        router = VoiceRouter()
        payload = json.dumps({"intent": "check_weather"}).encode("utf-8")

        result = router.dispatch(payload)

        assert result.routing_state == RoutingState.PLANNER_ACTIVE

    def test_valid_intent_is_actionable(self):
        """A valid intent produces an actionable result."""
        router = VoiceRouter()
        result = router.dispatch({"intent": "play_podcast"})

        assert result.is_actionable is True
        assert result.action_payload is not None

    def test_valid_intent_not_manual_only(self):
        """A valid intent does NOT produce a manual-only result."""
        router = VoiceRouter()
        result = router.dispatch({"intent": "navigate_home"})

        assert result.is_manual_only is False


# ===========================================================================
# TestParseIntent — unit tests for the internal parser
# ===========================================================================


class TestParseIntent:
    """[Voice Routing Guard by Abdul Gaffar] _parse_intent() unit tests."""

    def test_valid_json_string_parsed_to_dict(self):
        result = _parse_intent('{"intent": "play_music"}')
        assert result == {"intent": "play_music"}

    def test_valid_dict_returned_unchanged(self):
        data = {"intent": "set_alarm", "time": "08:00"}
        result = _parse_intent(data)
        assert result == data

    def test_valid_bytes_decoded_and_parsed(self):
        payload = json.dumps({"intent": "navigate"}).encode("utf-8")
        result = _parse_intent(payload)
        assert result == {"intent": "navigate"}

    def test_none_raises_value_error(self):
        with pytest.raises(ValueError, match="None"):
            _parse_intent(None)

    def test_empty_string_raises_value_error(self):
        with pytest.raises(ValueError, match="empty string"):
            _parse_intent("")

    def test_broken_json_raises_value_error(self):
        with pytest.raises(ValueError, match="not valid JSON"):
            _parse_intent("{ broken json }")

    def test_json_array_raises_type_error(self):
        with pytest.raises(TypeError, match="must be a dict"):
            _parse_intent("[1, 2, 3]")

    def test_empty_dict_raises_value_error(self):
        with pytest.raises(ValueError, match="empty dict"):
            _parse_intent("{}")


# ===========================================================================
# TestTrustBoundaryProof — canonical attach point named explicitly
# ===========================================================================


class TestTrustBoundaryProof:
    """
    Canonical surface : hushh_mcp.services.voice_router.VoiceRouter.dispatch()
                        (planner orchestration fallback boundary)
    Canonical caller  : api.routes.kai.voice — every voice turn passes through
                        dispatch() before reaching the planner:
                          POST /api/kai/voice/turn
                          POST /api/kai/voice/plan
                          POST /api/kai/voice/compose
                        When any exception occurs in parse or planner, the turn
                        returns MANUAL_ONLY_MODE — the request loop never crashes.
    Attach point proof: The tests below prove dispatch() is importable from
                        its canonical location, that broken payloads always
                        produce MANUAL_ONLY_MODE (the core fallback contract),
                        and that the planner exception path is fully isolated.
    """

    def test_importable_from_canonical_location(self):
        """VoiceRouter is importable from hushh_mcp.services.voice_router."""
        from hushh_mcp.services.voice_router import VoiceRouter as VR  # noqa: F401
        assert callable(VR)

    def test_dispatch_always_returns_routing_result(self):
        """[Voice Routing Guard by Abdul Gaffar] dispatch() ALWAYS returns VoiceRoutingResult."""
        router = VoiceRouter()
        for payload in [
            None,
            "",
            "broken",
            '{"valid": true}',
            b"\xff\xfe",
            {"intent": "ok"},
        ]:
            result = router.dispatch(payload)
            assert isinstance(result, VoiceRoutingResult), (
                f"[Voice Routing Guard by Abdul Gaffar] "
                f"dispatch({payload!r}) must return VoiceRoutingResult, got {type(result)}"
            )

    def test_broken_payload_always_manual_only(self):
        """[Voice Routing Guard by Abdul Gaffar] Any broken payload → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        broken_payloads = [
            "<<< broken audio intent stream payload >>>",
            "{not valid}",
            "   \n   ",
            '{"intent": "truncated...',
        ]
        for payload in broken_payloads:
            result = router.dispatch(payload)
            assert result.routing_state == RoutingState.MANUAL_ONLY_MODE, (
                f"[Voice Routing Guard by Abdul Gaffar] "
                f"Payload {payload!r} must produce MANUAL_ONLY_MODE"
            )

    def test_planner_crash_never_leaks_exception(self):
        """[Voice Routing Guard by Abdul Gaffar] Planner exception is contained — never propagates."""
        def _exploding_planner(_i: dict) -> None:
            raise SystemError("critical planner failure")

        router = VoiceRouter(planner_fn=_exploding_planner)
        # Must not raise SystemError
        result = router.dispatch('{"intent": "voice_command"}')
        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE

    @pytest.mark.parametrize("broken", [
        "<<< broken audio intent >>>",
        "",
        None,
        '["array", "not", "dict"]',
        "{}",
        b"\xff\xfe garbage bytes",
    ])
    def test_all_broken_forms_produce_manual_only(self, broken: object):
        """[Voice Routing Guard by Abdul Gaffar] Every broken payload form → MANUAL_ONLY_MODE."""
        router = VoiceRouter()
        result = router.dispatch(broken)
        assert result.routing_state == RoutingState.MANUAL_ONLY_MODE, (
            f"[Voice Routing Guard by Abdul Gaffar] "
            f"dispatch({broken!r}) must be MANUAL_ONLY_MODE, got {result.routing_state}"
        )
