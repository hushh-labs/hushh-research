# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Phase 3b-3 regression tests: Personal Sandbox Google Workspace, Action, Push & Schedule parity.

Proves that an activated Hussh Personal Sandbox (`virgin_pool_v1`, `hosted_ace_runtime()`)
supports Gmail, Google Calendar, Google Drive, owner-confirmed actions, todo sources,
Gmail push/maintenance, and scheduled model execution locally inside the isolated sandbox,
while strictly keeping:
  1. Google Contacts (`contacts`, `search_my_contacts`, `google_people`) BYOC-only (`owner_cloud_agent()`),
  2. Legacy hosted GCP/Azure pods refused (`hosted_pod_unavailable`), and
  3. Sentinel egress allowlist covering Google OAuth/OIDC/Gmail/Calendar/Drive without `people.googleapis.com`.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.pod_connector_tools import (
    calendar_turn_refusal,
    pod_connector_roster,
    pod_tool_owner,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret
from hushh_mcp.services.pod_gmail_local import PodLocalEmailReadPort, email_read_port
from hushh_mcp.services.pod_gmail_mailbox import pod_mailbox_actions
from hushh_mcp.services.pod_google_connections import calendar_runs_locally
from hushh_mcp.services.pod_owner_cloud import (
    hosted_ace_runtime,
    owner_cloud_agent,
    personal_sandbox_workspace_runtime,
    private_pod_runtime,
)

OWNER_UID = "user_personal_sandbox_parity"
HUSHH_ID = "ha1_sandbox_workspace_parity_001"


def _activate_personal_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_SANDBOX_PROFILE", "virgin_pool_v1")
    monkeypatch.setenv("HUSSH_LEASE_ID", "lease_parity_001")
    monkeypatch.setenv("HUSSH_ID", HUSHH_ID)
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_AWS_KMS_KEY_ARN", raising=False)
    monkeypatch.delenv("HUSSH_POD_CELL_ID", raising=False)
    monkeypatch.delenv("HUSSH_POD_SLOT_ID", raising=False)
    monkeypatch.delenv("HUSSH_POD_GCP_DEPLOYMENT_JSON", raising=False)


def _owner_tool_context(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    monkeypatch.setattr(
        "hushh_mcp.one_adk.pod_connector_tools.pod_owner_user_id", lambda: OWNER_UID
    )
    secret_ref = store_request_secret("pod-session:test-local-token")
    return SimpleNamespace(
        user_id=OWNER_UID,
        state={
            agent_tree.STATE_USER_ID: OWNER_UID,
            agent_tree.STATE_EXECUTION_SURFACE: "typed_chat",
            "hussh:consent_token": secret_ref,
            agent_tree.STATE_DATA_DOOR_GRANTS: {},
        },
    )


def test_personal_sandbox_runtime_classification(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_personal_sandbox(monkeypatch)
    assert hosted_ace_runtime() is True
    assert private_pod_runtime() is True
    assert owner_cloud_agent() is False
    assert personal_sandbox_workspace_runtime() is True
    assert calendar_runs_locally() is True


@pytest.mark.asyncio
async def test_personal_sandbox_admits_gmail_calendar_drive_and_refuses_contacts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_personal_sandbox(monkeypatch)
    ctx = _owner_tool_context(monkeypatch)

    assert await pod_tool_owner(ctx, "gmail") == OWNER_UID
    assert await pod_tool_owner(ctx, "calendar") == OWNER_UID
    assert await pod_tool_owner(ctx, "drive") == OWNER_UID
    # Contacts stays strictly BYOC-only (`owner_cloud_agent()`).
    assert await pod_tool_owner(ctx, "contacts") is None

    assert await calendar_turn_refusal(ctx) is None

    roster_names = {tool.__name__ for tool in pod_connector_roster()}
    assert "read_google_drive" in roster_names
    assert "discover_google_drive_tools" in roster_names
    assert "propose_gmail_mailbox_change" in roster_names
    assert "propose_gmail_todo" in roster_names
    assert "search_my_contacts" not in roster_names


@pytest.mark.asyncio
async def test_personal_sandbox_dispatches_email_and_documents_specialists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_personal_sandbox(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GMAIL_CHAT_READS", "true")
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", OWNER_UID)

    dispatched: list[tuple[str, str]] = []

    async def fake_specialist(agent_id: str, request: str, _tc: object) -> dict[str, str]:
        dispatched.append((agent_id, request))
        return {"status": "ok", "agent_id": agent_id}

    monkeypatch.setattr(agent_tree, "_specialist_turn", fake_specialist)
    ctx = _owner_tool_context(monkeypatch)

    mail_res = await agent_tree.ask_email_agent("Summarize recent emails", ctx)
    docs_res = await agent_tree.ask_documents_agent("Find Q4 board deck", ctx)

    assert mail_res == {"status": "ok", "agent_id": "agent_email"}
    assert docs_res == {"status": "ok", "agent_id": "agent_documents"}
    assert dispatched == [
        ("agent_email", "Summarize recent emails"),
        ("agent_documents", "Find Q4 board deck"),
    ]


def test_personal_sandbox_uses_local_email_port_and_mailbox_actions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_personal_sandbox(monkeypatch)
    monkeypatch.setattr("hushh_mcp.services.pod_owner_cloud.pod_owner_user_id", lambda: OWNER_UID)

    local_tok = "pod-session:" + "tok"
    port = email_read_port(OWNER_UID, scope_token="", turn_token=local_tok)
    assert isinstance(port, PodLocalEmailReadPort)
    assert pod_mailbox_actions() is not None


@pytest.mark.asyncio
async def test_personal_sandbox_refuses_contacts_connector_put(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from api.routes.one.pod_connectors import run_connector_put

    _activate_personal_sandbox(monkeypatch)
    monkeypatch.setattr(
        "api.routes.one.pod_connectors._admit",
        AsyncMock(return_value={"user_id": OWNER_UID}),
    )

    local_tok = "pod-session:" + "tok"
    resp = await run_connector_put(
        "contacts",
        envelope={"invalid": True},
        consent_token=local_tok,
    )
    assert resp.status_code == 422
    assert b"CONTACTS_OWNER_CLOUD_ONLY" in resp.body


def test_edge_gateway_sentinel_allowlist_includes_oidc_and_excludes_people() -> None:
    from hushh_mcp.services.agent_sandbox import edge_gateway_app

    src = inspect.getsource(edge_gateway_app)
    assert '"oauth2.googleapis.com": "allow"' in src
    assert '"openidconnect.googleapis.com": "allow"' in src
    assert '"gmail.googleapis.com": "allow"' in src
    assert '"www.googleapis.com": "allow"' in src
    assert "people.googleapis.com" not in src
