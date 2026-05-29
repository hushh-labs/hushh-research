from __future__ import annotations

import json

import pytest

from api.routes.kai import losers as losers_routes


def _decode_sse_frame(frame: dict[str, str]) -> dict:
    return json.loads(frame["data"])


class _FakeRequest:
    async def is_disconnected(self) -> bool:
        return False


class _CapturedEventSourceResponse:
    def __init__(self, generator, **_kwargs):
        self.body_iterator = generator


@pytest.mark.asyncio
async def test_losers_stream_unexpected_failure_emits_opaque_error(monkeypatch):
    sensitive_detail = "connect ECONNREFUSED backend.test token=vault_owner_token user_id=user_123"

    async def _raise_sensitive_failure(**_kwargs):
        raise RuntimeError(sensitive_detail)

    monkeypatch.setattr(losers_routes, "_build_optimization_context", _raise_sensitive_failure)
    monkeypatch.setattr(losers_routes, "EventSourceResponse", _CapturedEventSourceResponse)

    response = await losers_routes.analyze_portfolio_losers_stream(
        losers_routes.AnalyzeLosersRequest(
            user_id="user_123",
            losers=[losers_routes.PortfolioLoser(symbol="AAPL", gain_loss_pct=-10.0)],
        ),
        _FakeRequest(),
        {"user_id": "user_123", "token": "vault_owner_token"},
    )

    frames = [frame async for frame in response.body_iterator]
    terminal = _decode_sse_frame(frames[-1])
    payload = terminal["payload"]

    assert terminal["event"] == "error"
    assert terminal["terminal"] is True
    assert payload["code"] == "OPTIMIZE_STREAM_FAILED"
    assert (
        payload["message"] == "Portfolio optimization is temporarily unavailable. Please try again."
    )

    serialized_payload = json.dumps(payload)
    assert "vault_owner_token" not in serialized_payload
    assert "user_123" not in serialized_payload
    assert "ECONNREFUSED" not in serialized_payload
    assert "backend.test" not in serialized_payload
