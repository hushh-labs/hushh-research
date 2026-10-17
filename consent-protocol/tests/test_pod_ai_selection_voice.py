"""Live voice never stands in for the owner's own AI selection.

Voice runs on managed Gemini (Live on Vertex), so while a selection is in force, or
cannot be read, the pod reports voice unavailable with the reason and the voice
door refuses before accepting the socket.
"""

from __future__ import annotations

from typing import Any

import pytest

from api.routes.one import pod_capabilities, pod_turn
from hushh_mcp.services import pod_ai_selection
from tests.test_pod_ai_selection_turns import _selection


class _Socket:
    """Just enough of a WebSocket for the pod's voice admission."""

    def __init__(self) -> None:
        self.headers = {
            "x-consent-token": "consent",
            "x-hussh-voice-session": "voice_" + "a" * 32,
        }
        self.closed: tuple[int, str] | None = None
        self.accepted = False

    async def close(self, code: int, reason: str = "") -> None:
        self.closed = (code, reason)

    async def accept(self) -> None:
        self.accepted = True


@pytest.mark.parametrize("state", ["selected", "unreadable"])
async def test_voice_refuses_while_the_owners_own_ai_is_in_force(monkeypatch, state):
    """Live voice runs on managed Gemini, so it must not stand in for the owner's choice.

    Negative control: with no selection the same admitted call goes on to the update
    admission (the next step), which proves the refusal comes from the selection.
    """
    from api.routes.one import pod_live_session
    from hushh_mcp.services import pod_upgrade_admission

    class _Session:
        def __init__(self, **_kw: Any) -> None:
            pass

        async def require_access(self) -> None:
            return None

    async def _consent(_token: str, **_kw: Any) -> dict:
        return {"user_id": "owner-uid"}

    reached_admission: list[bool] = []

    async def _acquire(**_kw: Any) -> Any:
        reached_admission.append(True)
        raise pod_upgrade_admission.PodUpgradeAdmissionRefused("finishing an update")

    monkeypatch.setattr(pod_turn, "_require_enabled", lambda: None)
    monkeypatch.setattr(pod_turn, "_validate_consent", _consent)
    monkeypatch.setattr(pod_capabilities, "vertex_model_configured", lambda: True)
    monkeypatch.setattr("api.routes.one.relay_auth.one_voice_enabled", lambda: True)
    monkeypatch.setattr(pod_live_session, "PodLiveSession", _Session)
    monkeypatch.setattr(pod_upgrade_admission.ADMISSION, "acquire_turn", _acquire)

    if state == "selected":
        pod_ai_selection.set_active_ai_selection(_selection())
    else:
        monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", True)
    try:
        socket = _Socket()
        await pod_turn.pod_live_route(socket)  # type: ignore[arg-type]
        assert socket.closed == (1008, "Private voice unavailable.")
        assert pod_capabilities.voice_capability() == {
            "available": False,
            "reason": "owner_ai_selected",
        }
        assert not socket.accepted and reached_admission == []

        pod_ai_selection.set_active_ai_selection(None)
        control = _Socket()
        await pod_turn.pod_live_route(control)  # type: ignore[arg-type]
        assert reached_admission == [True], "with no selection voice proceeds as before"
    finally:
        pod_ai_selection.set_active_ai_selection(None)
