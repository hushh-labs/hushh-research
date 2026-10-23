"""Native Tavily receipts, provider lineage and explicit fresh-consent regressions."""

import copy
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.one_adk.world_model_azure import run_world_model_azure
from tests.fixtures.world_model_gateway import IDENTITY, URL, FakeGateway


@pytest.mark.asyncio
async def test_tavily_search_uses_documented_keyless_mode_and_bounds_without_retries(monkeypatch):
    from hushh_mcp.one_adk import tavily_search as search

    receipt = {
        "request_id": "synthetic-search",
        "usage": {"credits": 1},
        "results": [{"title": "Public bio", "url": URL, "content": "Alex's public biography."}],
    }
    requests = []
    status = 200

    def dispatch(request):
        requests.append(request)
        return httpx.Response(status, json=receipt)

    original = httpx.AsyncClient
    monkeypatch.setattr(
        search.httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(dispatch)),
    )
    raw = await search.search_tavily('"Alex Example" public work')
    evidence = search.extract_tavily_receipts(raw)
    assert evidence.observed and evidence.credits == 1 and evidence.num_requests == 1
    assert evidence.sources[0].url == URL and evidence.citations == ()
    assert "Alex's public biography." in evidence.answer
    assert requests[0].headers["X-Tavily-Access-Mode"] == "keyless"
    assert "authorization" not in requests[0].headers
    assert json.loads(requests[0].content)["include_answer"] is False
    assert json.loads(requests[0].content)["include_raw_content"] is False
    status = 429
    with pytest.raises(search.TavilyUnavailable) as denied:
        await search.search_tavily("Synthetic query")
    assert denied.value.code == 429 and len(requests) == 2
    assert "Synthetic query" not in str(denied.value)
    for bad in ({**receipt, "usage": {}}, {**receipt, "request_id": None}):
        with pytest.raises(ValueError):
            search.extract_tavily_receipts(bad)


@pytest.mark.asyncio
async def test_tavily_runner_keeps_native_receipts_and_rejects_bing_lineage():
    charges, snapshots = [], []

    class TavilyGateway(FakeGateway):
        async def search(self, request):
            await super().search(request)  # Existing charge-before-dispatch assertions.
            return {
                "request_id": "synthetic-search",
                "usage": {"credits": 1},
                "results": [
                    {
                        "title": "Public bio",
                        "url": URL,
                        "content": "A public bio names Alex Example.",
                    }
                ],
            }

    async def charge(slots):
        charges.extend(slots)

    async def progress(work):
        snapshots.append(copy.deepcopy(work))

    kwargs = dict(
        identity=IDENTITY,
        user_id="owner",
        consent_token="synthetic",  # noqa: S106 - synthetic test authority
        require_access=AsyncMock(),
        on_attempts_start=charge,
        on_progress=progress,
        owner_decisions={"rejected": ["An unrelated claim"]},
        gateway=TavilyGateway(charges=charges, snapshots=snapshots),
        search_provider="tavily",
    )
    result = await run_world_model_azure(**kwargs)
    assert result["status"] == "offered"
    assert result["research"]["provider"] == "azure_openai_tavily"
    assert result["research"]["source_use"] == "tavily_review_retained"
    assert result["report"]["match_status"] == "uncertain"
    assert snapshots[-1]["attempts"]["1"]["search_credits"] == 1
    assert snapshots[-1]["attempts"]["1"]["bing_requests"] == 0
    assert snapshots[-1]["search_provider"] == "tavily"
    assert result["grounded_answers"][0]["citations"] == []
    with pytest.raises(ValueError, match="another search provider"):
        await run_world_model_azure(**kwargs, work={"azure_work_version": 1})


def test_tavily_requires_fresh_matching_consent_and_never_relabels_bing(monkeypatch):
    from hushh_mcp.services import world_model_preferences as preferences

    monkeypatch.setattr(preferences, "load_pwm_policy", lambda: {"provider": "azure_openai_tavily"})
    for marker in (None, "pwm-native-v1", "pwm-azure-bing-v1", "pwm-azure-tavily-v1"):
        result = preferences.public_preferences(
            {"enabled": True, "email_enabled": False, "consent_version": marker}
        )
        assert result["enabled"] is (marker == "pwm-azure-tavily-v1")
        assert result["research_provider"] == "azure_openai_tavily"
