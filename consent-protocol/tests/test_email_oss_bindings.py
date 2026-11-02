"""Owner-bound Gmail/central-model integration through the real production facade."""

from types import SimpleNamespace

import pytest

from hushh_mcp.services.email_chat_service import EmailChatService
from tests.test_email_chat_service import _TOKEN, _FakeGmail, _FakeStore


@pytest.mark.parametrize(
    ("deploy_env", "environment", "uses_oss"),
    [
        (None, "production", False),
        (None, "local", False),
        (None, "uat", True),
        (" UAT ", "production", True),
        ("production", "uat", False),
    ],
)
async def test_default_runtime_preserves_non_uat_and_never_falls_back_in_uat(
    monkeypatch, deploy_env, environment, uses_oss
):
    from unittest.mock import AsyncMock

    from hushh_mcp.operons.kai import llm

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    if deploy_env is not None:
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", deploy_env)
    monkeypatch.setattr(llm, "_require_gemini_ready", lambda: True)
    monkeypatch.setattr(llm, "agent_chat_model_call", AsyncMock())
    legacy = AsyncMock(return_value={"response": "Existing Mail answer", "status": "ok"})
    monkeypatch.setattr("hushh_mcp.services.email_delegated_read.run_delegated_mail_read", legacy)
    service = EmailChatService(chat_store=_FakeStore(), gmail_service=_FakeGmail())
    oss = AsyncMock(return_value={"response": "Unavailable", "status": "unavailable"})
    monkeypatch.setattr(service, "_run_oss_turn", oss)
    out = await service.handle_delegated_turn(
        user_id="owner",
        consent_token=_TOKEN,
        conversation_id="conv",
        message="Find invoices",
        require_access=AsyncMock(),
    )
    assert oss.await_count == int(uses_oss)
    assert legacy.await_count == int(not uses_oss)
    assert out["status"] == ("unavailable" if uses_oss else "ok")
    assert (service._model_call is None) == uses_oss

    loop = AsyncMock(return_value=("Existing direct answer", False))
    monkeypatch.setattr(service, "_run_tool_loop", loop)
    await service.handle_turn(user_id="owner", message="Find invoices", consent_token=_TOKEN)
    assert loop.await_count == int(not uses_oss)
    assert oss.await_count == 2 * int(uses_oss)


async def test_oss_delegation_uses_existing_owner_memory_and_no_legacy_planner(monkeypatch):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    captured = {}
    runtime = SimpleNamespace(
        handle_turn=AsyncMock(
            return_value={
                "response": "One invoice, INR 123.45; more pages remain.",
                "conversationId": "conv",
                "isComplete": True,
                "stateChanged": False,
                "status": "ok",
            }
        )
    )
    admitted = AsyncMock()

    @asynccontextmanager
    async def factory(**kwargs):
        captured.update(kwargs)
        yield runtime, admitted

    legacy = AsyncMock(side_effect=AssertionError("Legacy MailReadPlan must not run"))
    monkeypatch.setattr("hushh_mcp.services.email_delegated_read.run_delegated_mail_read", legacy)
    service = EmailChatService(
        chat_store=_FakeStore(), gmail_service=_FakeGmail(), oss_runtime_factory=factory
    )
    out = await service.handle_delegated_turn(
        user_id="owner",
        consent_token=_TOKEN,
        conversation_id="conv",
        message="last 7 days invoices",
        require_access=admitted,
        timezone="Asia/Kolkata",
        memory_markdown="## Facts\n- Contact: Alice",
    )
    assert out["structured"]["status"] == "ok"
    assert captured["user_id"] == "owner"
    assert (
        runtime.handle_turn.await_args.kwargs["current_memory_md"] == "## Facts\n- Contact: Alice"
    )
    assert runtime.handle_turn.await_args.kwargs["require_access"] is admitted
    legacy.assert_not_called()


async def test_oss_factory_failure_is_structured_unavailable():
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    @asynccontextmanager
    async def unavailable(**kwargs):
        raise RuntimeError("central processor unavailable")
        yield

    service = EmailChatService(
        chat_store=_FakeStore(), gmail_service=_FakeGmail(), oss_runtime_factory=unavailable
    )
    out = await service.handle_delegated_turn(
        user_id="owner",
        consent_token=_TOKEN,
        conversation_id="conv",
        message="hello is Gmail connected",
        require_access=AsyncMock(),
    )
    assert out["structured"]["status"] == "unavailable"
    assert out["stateChanged"] is False


async def test_owner_gmail_sdk_port_fences_account_switch_and_closes_resource(monkeypatch):
    from unittest.mock import AsyncMock, Mock

    import pytest

    from hushh_mcp.services.email_oss.bindings import OwnerGmailExecution

    grant = ("owner", "gmail", "account-A", "connected", "revision-A")
    gmail = SimpleNamespace(
        get_bound_read_access_token=AsyncMock(return_value=("synthetic-access", grant)),
        read_execution_grant_binding=AsyncMock(return_value=grant),
    )
    resource = SimpleNamespace(close=Mock())
    build = Mock(return_value=resource)
    monkeypatch.setattr("googleapiclient.discovery.build", build)
    adapter = OwnerGmailExecution(gmail, "owner", AsyncMock())

    async def source_read(**kwargs):
        gmail.read_execution_grant_binding.return_value = (
            "owner",
            "gmail",
            "account-B",
            "new",
            "revision-B",
        )
        await adapter.require_current_grant()
        return {"id": "m1"}

    monkeypatch.setattr(
        "hushh_mcp.services.email_oss.bindings.GmailExecution",
        lambda *a, **k: SimpleNamespace(get_message=source_read),
    )
    with pytest.raises(PermissionError, match="grant changed"):
        await adapter.get_message(message_id="m1")
    resource.close.assert_called_once()
    http = build.call_args.kwargs["http"].http
    assert http.timeout == 8
    assert build.call_args.kwargs["static_discovery"] is True
    assert not adapter.observed_messages


@pytest.mark.parametrize("changed,refresh", [(False, False), (False, True), (True, False)])
async def test_vault_token_is_bound_to_its_actual_post_refresh_account(changed, refresh):
    from copy import deepcopy
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService

    service = object.__new__(GmailReceiptsService)
    row = {
        "status": "connected",
        "revoked": False,
        "google_sub": "A",
        "connected_at": "connected",
        "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
        "token_updated_at": "refresh-new" if refresh else "old",
        "refresh_token_ciphertext": "synthetic-envelope",
        "refresh_token_iv": "synthetic-iv",
        "refresh_token_tag": "synthetic-tag",
    }
    service.assert_read_ready = AsyncMock()
    service._ensure_access_token = AsyncMock(return_value=("synthetic-access", deepcopy(row)))
    current = deepcopy(row)
    if changed:
        current["google_sub"] = "B"
    current["last_sync_at"] = "unrelated sync must not invalidate this grant"
    service._fetch_connection_row = Mock(return_value=current)
    if changed:
        with pytest.raises(GmailApiError, match="connection changed"):
            await service.get_bound_read_access_token(user_id="owner")
    else:
        token, binding = await service.get_bound_read_access_token(user_id="owner")
        assert token == "synthetic-access" and binding[2] == "A"
        assert binding == await service.read_execution_grant_binding(user_id="owner")


@pytest.mark.parametrize("account_changed", [False, True])
async def test_email_selection_survives_token_refresh_but_not_account_switch(
    monkeypatch, account_changed
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.email_oss.bindings import owner_email_runtime

    old_grant = ("owner", "gmail", "account-A", "connected", "old-token-revision")
    live_grant = (
        "owner",
        "gmail",
        "account-B" if account_changed else "account-A",
        "connected",
        "new-token-revision",
    )
    gmail = SimpleNamespace(read_execution_grant_binding=AsyncMock(return_value=live_grant))
    binding = SimpleNamespace(
        require_current=lambda: None,
        endpoint="https://synthetic.invalid/v1",
        token_supplier=lambda: "synthetic",
        capabilities={
            "one_text_root": {
                "deployment": "synthetic-approved-one",
                "reasoning_effort": "none",
                "text_verbosity": "low",
            }
        },
    )
    monkeypatch.setattr(
        "hushh_mcp.runtime_providers.managed_azure.ManagedAzureBinding.from_environment",
        lambda: binding,
    )
    model_arguments = {}

    def model_factory(**kwargs):
        model_arguments.update(kwargs)
        return object()

    monkeypatch.setattr("langchain_openai.ChatOpenAI", model_factory)
    async with owner_email_runtime(
        gmail=gmail,
        user_id="owner",
        require_access=AsyncMock(),
        selected_messages={
            "owner_id": "owner",
            "grant_binding": list(old_grant),
            "messages": [{"id": "m1", "thread_id": "t1"}],
        },
    ) as (runtime, _admitted):
        execution = runtime.execution_factory(None)
        assert bool(execution.observed_messages) is not account_changed
        assert model_arguments["model"] == "synthetic-approved-one"
        assert model_arguments["reasoning"] == {"effort": "low"}
        assert model_arguments["verbosity"] == "low"
        if not account_changed:
            assert execution.grant_binding == live_grant
            assert execution.observed_messages["m1"]["thread_id"] == "t1"


@pytest.mark.parametrize(
    "owner_matches,account_matches", [(True, True), (False, True), (True, False)]
)
async def test_legacy_mail_offer_is_migrated_only_for_current_owner_conversation_account(
    owner_matches, account_matches
):
    import time
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    captured = {}
    runtime = SimpleNamespace(
        handle_turn=AsyncMock(return_value={"response": "Message read", "status": "ok"})
    )

    @asynccontextmanager
    async def factory(**kwargs):
        captured.update(kwargs)
        yield runtime, AsyncMock()

    gmail = SimpleNamespace(
        read_execution_grant_binding=AsyncMock(
            return_value=("owner", "gmail", "account-A", "connected", "revision")
        )
    )
    service = EmailChatService(
        chat_store=_FakeStore(), gmail_service=gmail, oss_runtime_factory=factory
    )
    await service.handle_delegated_turn(
        user_id="owner",
        consent_token=_TOKEN,
        conversation_id="conv",
        message="Read the second one",
        require_access=AsyncMock(),
        read_offer={
            "owner_id": "owner" if owner_matches else "another-owner",
            "conversation_id": "conv",
            "account": "account-A" if account_matches else "account-B",
            "mailbox": "inbox",
            "message_ids": ["m1", "m2"],
            "created_at_ms": int(time.time() * 1000),
        },
    )
    selection = captured["selected_messages"]
    if owner_matches and account_matches:
        assert [row["id"] for row in selection["messages"]] == ["m1", "m2"]
        assert all(row["thread_id"] is None for row in selection["messages"])
    else:
        assert selection is None
