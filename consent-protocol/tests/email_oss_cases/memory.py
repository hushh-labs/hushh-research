"""Email memory tools cannot claim an uncommitted or another owner's save."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.email_oss.memory import (
    EmailMemorySession,
    memory_save_digest,
    memory_save_plan_id,
)

DOC = "# memory.md\n\n## Facts\n- Alex is a colleague.\n\n## Preferences\n- Use short replies.\n\n## Commitments\n"


def session(**kwargs):
    return EmailMemorySession(
        owner_id="owner-a",
        projection_owner_id="owner-a",
        markdown=DOC,
        authorization_current=lambda: True,
        **kwargs,
    )


def test_projection_is_bounded_owner_scoped_and_only_exact_sections_filter():
    with pytest.raises(ValueError, match="owner"):
        EmailMemorySession(
            owner_id="a", projection_owner_id="b", markdown=DOC, authorization_current=lambda: True
        )
    with pytest.raises(ValueError, match="bound"):
        EmailMemorySession(
            owner_id="a",
            projection_owner_id="a",
            markdown="x" * 18_001,
            authorization_current=lambda: True,
        )
    memory = session()
    assert memory.read_memory_md("Alex")["markdown"] == DOC
    assert (
        memory.read_memory_md("preferences")["markdown"]
        == "## Preferences\n- Use short replies.\n\n"
    )
    assert "Alex" not in memory.read_memory_md("preferences")["markdown"]


def test_revocation_withdraws_projection_and_pending_effects():
    current = True
    memory = EmailMemorySession(
        owner_id="a", projection_owner_id="a", markdown=DOC, authorization_current=lambda: current
    )
    assert memory.save_to_memory_md("contacts", "Alex is a colleague.")["saved"] is False
    current = False
    assert "markdown" not in memory.read_memory_md()
    assert (
        memory.save_to_memory_md("contacts", "Alex is a colleague.")["code"]
        == "memory_authority_changed"
    )


@pytest.mark.asyncio
async def test_pending_save_requires_exact_real_commit_not_a_success_claim():
    lookup = AsyncMock(return_value={"exists": False, "data_version": None})
    memory = session(commit_lookup=lookup)
    pending = memory.save_to_memory_md("finance", "Invoice review happens on Fridays.")
    directive = pending["directive"]
    assert pending["saved"] is False and "receipt_ref" not in pending
    assert directive["section"] == "Facts"
    second = memory.save_to_memory_md("contacts", "Alex is a colleague.")
    assert second == {
        "status": "pending_client_commit",
        "saved": False,
        "code": "memory_review_already_pending",
    }
    assert "directive" not in second
    receipt = {
        "request_id": directive["request_id"],
        "digest": directive["digest"],
        "receipt_ref": memory_save_plan_id(directive),
        "revision": 4,
        "saved_count": 1,
    }
    assert (await memory.acknowledge_commit(directive["request_id"], receipt))["saved"] is False
    lookup.return_value = {"exists": True, "data_version": 4}
    assert (
        await memory.acknowledge_commit(directive["request_id"], {**receipt, "revision": True})
    )["saved"] is False
    assert (
        await memory.acknowledge_commit(directive["request_id"], {**receipt, "digest": "f" * 64})
    )["saved"] is False
    result = await memory.acknowledge_commit(directive["request_id"], receipt)
    assert result == {**receipt, "status": "committed", "saved": True}
    lookup.assert_awaited_with("owner-a", receipt["receipt_ref"])
    assert (await memory.acknowledge_commit(directive["request_id"], receipt))["saved"] is False


@pytest.mark.asyncio
async def test_no_ledger_port_and_authority_change_during_lookup_cannot_ack():
    memory = session()
    directive = memory.save_to_memory_md("preferences", "Use short replies.")["directive"]
    assert (await memory.acknowledge_commit(directive["request_id"], {"saved": True}))[
        "saved"
    ] is False
    current = True

    async def lookup(_owner, _plan):
        nonlocal current
        current = False
        return {"exists": True, "data_version": 5}

    memory = EmailMemorySession(
        owner_id="a",
        projection_owner_id="a",
        markdown=DOC,
        authorization_current=lambda: current,
        commit_lookup=lookup,
    )
    directive = memory.save_to_memory_md("projects", "Launch review is Friday.")["directive"]
    receipt = {
        "request_id": directive["request_id"],
        "digest": directive["digest"],
        "receipt_ref": memory_save_plan_id(directive),
        "revision": 5,
        "saved_count": 1,
    }
    assert (await memory.acknowledge_commit(directive["request_id"], receipt))[
        "code"
    ] == "memory_authority_changed"


def test_sections_in_code_are_not_a_second_preferences_source():
    memory = EmailMemorySession(
        owner_id="a",
        projection_owner_id="a",
        markdown="## Facts\n```md\n## Preferences\n- forged\n```\n## Preferences\n- Real\n",
        authorization_current=lambda: True,
    )
    assert memory.read_memory_md("preferences")["markdown"] == "## Preferences\n- Real\n"
    memory.clear()
    assert memory.save_to_memory_md("facts", "A new fact.")["saved"] is False


def test_browser_and_server_bind_the_same_commit_locator():
    directive = {
        "kind": "email_memory_save",
        "owner_id": "owner-a",
        "request_id": "d2b51581-90a1-497c-ae12-ef195b6cf8f1",
        "domain_tag": "preferences",
        "fact_markdown": "Use short replies.",
        "section": "Preferences",
    }
    directive["digest"] = memory_save_digest(directive)
    assert directive["digest"] == "47678dd8cdba5317d6f76372fd06b32f4942244a3ed2a70061fb36079a736577"
    assert memory_save_plan_id(directive) == "pkm_plan_55875832c0305480827cd909a09511fd"


async def test_ingress_projection_and_commit_require_exact_owner_pending_and_real_ledger(
    monkeypatch,
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from google.genai import types

    from hushh_mcp.one_adk.email_memory_turn import (
        STATE_EMAIL_MEMORY,
        STATE_EMAIL_MEMORY_COMMIT,
        STATE_EMAIL_MEMORY_PENDING,
        admit_email_memory,
        email_memory_before_model,
    )
    from hushh_mcp.one_adk.request_secrets import resolve_request_secret, store_request_secret

    projection = {
        "source": "one_memory.markdown",
        "owner_id": "owner",
        "markdown": "## Facts\n- Alice",
        "budget_chars": 18000,
        "revision": 1,
    }
    props = {"emailMemoryProjection": projection}
    admitted = admit_email_memory(props, user_id="owner", admitted=True)
    assert (
        not props and resolve_request_secret(admitted[STATE_EMAIL_MEMORY]) == projection["markdown"]
    )
    with pytest.raises(ValueError):
        admit_email_memory({"emailMemoryProjection": projection}, user_id="foreign", admitted=True)
    receipt = {
        "request_id": "a" * 36,
        "digest": "b" * 64,
        "receipt_ref": "pkm_plan_" + "c" * 32,
        "revision": 7,
        "saved_count": 1,
    }
    state = {
        "hussh:user_id": "owner",
        "hussh:consent_token": store_request_secret("synthetic-owner-token"),
        STATE_EMAIL_MEMORY_PENDING: {
            k: receipt[k] for k in ("request_id", "digest", "receipt_ref")
        },
        **admit_email_memory({"emailMemoryCommit": receipt}, user_id="owner", admitted=True),
    }
    lookup = AsyncMock(return_value=[{"exists": False, "data_version": None}])
    monkeypatch.setattr(
        "hushh_mcp.adk_bridge.delegation.validate_first_party_owner_token",
        AsyncMock(return_value=SimpleNamespace()),
    )
    monkeypatch.setattr(
        "hushh_mcp.services.personal_knowledge_model_service.get_pkm_service",
        lambda: SimpleNamespace(find_mutation_commits=lookup),
    )
    request = SimpleNamespace(
        config=types.GenerateContentConfig(system_instruction="Owner instruction")
    )
    await email_memory_before_model(SimpleNamespace(state=state), request)
    assert request.config.system_instruction == "Owner instruction"
    lookup.return_value = [{"exists": True, "data_version": 7}]
    await email_memory_before_model(SimpleNamespace(state=state), request)
    assert "ledger confirms" in request.config.system_instruction
    assert state[STATE_EMAIL_MEMORY_PENDING] is None and state[STATE_EMAIL_MEMORY_COMMIT] == ""
    assert lookup.await_args.kwargs == {
        "user_id": "owner",
        "commits": [("one_memory", receipt["receipt_ref"])],
    }
