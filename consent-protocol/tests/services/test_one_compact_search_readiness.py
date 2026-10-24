"""Exact compact-model qualification and known-answer admission controls."""

import json

import pytest

from tests.services.test_azure_adk import model


@pytest.mark.parametrize(
    "control", ["qualified", "selector_bypassed", "missing_fact", "wrong_registration"]
)
async def test_compact_readiness_qualifies_exact_selected_model_and_public_facts(
    monkeypatch, control
):
    from hushh_mcp.one_adk import agent_tree, search_answer
    from hushh_mcp.runtime_providers import managed_text as managed
    from hushh_mcp.runtime_providers.managed_azure import ManagedAzureBinding
    from scripts.probe_managed_capabilities import _probe_public_search
    from tests.test_azure_web_receipts import response as search_response

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "azure_openai")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    raw = search_response()
    raw["output"][2]["content"][0]["text"] = json.dumps(
        {
            "domains": ["example.net"]
            if control == "missing_fact"
            else ["example.net", "example.org"],
            "registration_available": control == "wrong_registration",
            "explanation": "IANA example domains documentation.",
        }
    )
    adapter, client, factory, token = model([raw])
    wrapped = managed.ManagedPrimaryTextModel(
        model=adapter.model,
        endpoint=adapter.endpoint,
        client_factory=factory,
        token_supplier=token,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        allow_fallback=False,
        runtime_binding=ManagedAzureBinding.from_environment(),
    )
    root = agent_tree.build_one_text_agent(model=wrapped)
    monkeypatch.setattr(agent_tree, "build_one_text_agent", lambda: root)
    if control == "selector_bypassed":
        monkeypatch.setattr(search_answer, "compact_public_search_model", lambda value: value)
        with pytest.raises(ValueError, match="admitted model"):
            await _probe_public_search(compact=True)
        assert client.requests == []
    elif control in {"missing_fact", "wrong_registration"}:
        with pytest.raises(ValueError, match="public fact"):
            await _probe_public_search(compact=True)
    else:
        proof = await _probe_public_search(compact=True)
        assert proof == {
            "cited_sources": 1,
            "fresh_page_retrieval_claimed": False,
            "synthetic_content_verified": True,
        }
        assert client.requests[0]["model"] == "one-search-gpt-54-mini-eval"
        assert client.requests[0]["reasoning"] == {"effort": "none"}
        assert client.requests[0]["tools"][0]["search_context_size"] == "low"
