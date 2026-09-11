import inspect
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from hushh_mcp.adk_bridge.contract import A2ATask
from hushh_mcp.adk_bridge.dispatch import dispatch, is_wired_specialist
from hushh_mcp.adk_bridge.nav_agent import NavAgent, _friendly_expiry, _parse_datetime
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.consent_db import ConsentDBService


def test_parse_datetime_accepts_iso_strings() -> None:
    parsed = _parse_datetime("2026-08-11T10:00:00Z")
    assert parsed == datetime(2026, 8, 11, 10, 0, 0, tzinfo=UTC)


def test_parse_datetime_accepts_epoch_milliseconds() -> None:
    # consent_db.py's audit/token rows carry expires_at/issued_at as epoch
    # milliseconds (compared against now_ms throughout that module), not an
    # ISO string. datetime.fromisoformat rejects a bare digit string, so
    # without this the value fell through to being spoken aloud as a raw
    # number instead of a date.
    epoch_ms = "1785283200000"
    parsed = _parse_datetime(epoch_ms)
    assert parsed is not None
    assert parsed == datetime.fromtimestamp(int(epoch_ms) / 1000, tz=UTC)


def test_parse_datetime_rejects_garbage() -> None:
    assert _parse_datetime("not a date") is None


def test_friendly_expiry_never_speaks_a_raw_epoch_number() -> None:
    entry = {"expires_at": "1785283200000"}
    result = _friendly_expiry(entry, timezone=ZoneInfo("UTC"))
    assert "1785283200000" not in result
    assert "until" in result


@pytest.fixture(autouse=True)
def _db_token_active(monkeypatch):
    """Nav's A2A gate is DB-backed (cross-instance revocation).

    These unit tests issue ad-hoc in-memory tokens with no consent_audit
    grant rows, so stub the DB activity lookup to report the token active.
    Revocation-path behavior is covered by the token-validation suites.
    """

    async def _active(self, user_id, scope, agent_id=None, *, token_id=None):  # noqa: ANN001
        return True

    monkeypatch.setattr(ConsentDBService, "is_token_active", _active)


@pytest.mark.asyncio
async def test_nav_agent_returns_consent_required_directive_without_review_scope():
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token="",
            conversation_id="thread_nav",
            message="Who has access to my vault?",
        )
    )

    assert result.conversation_id == "thread_nav"
    assert result.model == "one+nav"
    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload["requiredScope"] == ConsentScope.AGENT_NAV_REVIEW.value
    assert "cannot review" in result.text


@pytest.mark.asyncio
async def test_nav_agent_answers_inline_with_review_scope():
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="Who has access to my vault?",
        )
    )

    assert result.conversation_id == "thread_nav"
    assert result.model == "one+nav"
    assert result.directive is None
    assert result.text == "You do not have any approved consent requests right now."


@pytest.mark.asyncio
async def test_nav_agent_lists_approved_consent_requests(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001
        assert user_id == "user_nav"
        assert kwargs["actor"] == "investor"
        assert kwargs["surface"] == "active"
        return {
            "total": 2,
            "items": [
                {
                    "id": "one_location_grant:grant_1",
                    "request_id": "req_1",
                    "counterpart_label": "Travel Planner",
                    "scope": "cap.location.live.view",
                    "expires_at": "2026-07-04T01:53:37.924978+00:00",
                    "metadata": {
                        "request_source": "one_location_share_grant",
                        "section": "people",
                        "grant_id": "grant_1",
                    },
                },
                {
                    "id": "grant_2",
                    "request_id": "req_2",
                    "counterpart_label": "Kai",
                    "scope": "attr.financial.portfolio.*",
                    "scope_description": "Portfolio summary",
                },
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
            timezone="America/Los_Angeles",
        )
    )

    assert result.directive is not None
    assert result.directive.kind == "prompt"
    assert result.directive.payload["kind"] == "consent_actions"
    assert result.directive.payload["items"] == [
        {
            "id": "one_location_grant:grant_1",
            "label": "Travel Planner",
            "summary": "Travel Planner can view your live location",
            "scope": "cap.location.live.view",
            "expiresAt": "2026-07-04T01:53:37.924978+00:00",
            "metadata": {
                "request_source": "one_location_share_grant",
                "section": "people",
                "grant_id": "grant_1",
            },
            "actions": ["revoke", "details"],
        }
    ]
    assert "You have 2 approved consent requests active right now" in result.text
    assert "Travel Planner can view your live location until" in result.text
    assert "6:53 PM PDT" in result.text
    assert "1:53 AM UTC" not in result.text
    assert "Request req_1" not in result.text
    assert "Kai can access portfolio summary" in result.text


@pytest.mark.asyncio
async def test_nav_agent_offers_revoke_for_location_grants_without_section(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:grant_1",
                    "counterpart_label": "Gautam Ahuja",
                    "scope": "cap.location.live.view",
                    "metadata": {
                        "request_source": "one_location_share_grant",
                        "grant_id": "grant_1",
                    },
                },
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
        )
    )

    assert result.directive is not None
    assert result.directive.payload["items"][0]["actions"] == ["revoke", "details"]


@pytest.mark.asyncio
async def test_nav_agent_treats_all_consent_requests_as_list_query(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return {"total": 0, "items": []}

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show me all my consent requests",
        )
    )

    assert result.text == "You do not have any approved consent requests right now."
    assert "You are Nav" not in result.text


@pytest.mark.asyncio
async def test_nav_agent_offers_revoke_for_shared_location_grants(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:grant_shared",
                    "counterpart_label": "Gautam Ahuja",
                    "scope": "cap.location.live.view",
                    "metadata": {
                        "request_source": "one_location_share_grant",
                        "section": "shared",
                        "grant_id": "grant_shared",
                    },
                },
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
        )
    )

    assert result.directive is not None
    assert result.directive.payload["items"][0]["actions"] == ["revoke", "details"]


@pytest.mark.asyncio
async def test_nav_agent_lists_revoked_consent_requests(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001
        assert user_id == "user_nav"
        assert kwargs["actor"] == "investor"
        assert kwargs["surface"] == "previous"
        return {
            "total": 1,
            "items": [
                {
                    "id": "one_location_grant:grant_1",
                    "counterpart_label": "JHUMMA KUMARI",
                    "scope": "cap.location.live.view",
                    "status": "revoked",
                    "revoked_at": "2026-07-04T01:53:37.924978+00:00",
                },
            ],
        }

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="what about revoked requests",
            timezone="America/Los_Angeles",
        )
    )

    assert result.directive is None
    assert "You have 1 previous consent request" in result.text
    assert "JHUMMA KUMARI had access to view your live location" in result.text
    assert "6:53 PM PDT" in result.text
    assert "You are Nav" not in result.text


@pytest.mark.asyncio
async def test_nav_agent_generic_response_does_not_echo_manifest_instruction():
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await NavAgent().handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="explain consent boundaries",
        )
    )

    assert "You are Nav" not in result.text
    assert "Do not provide finance analysis" not in result.text
    assert "I can help review consent requests" in result.text


@pytest.mark.asyncio
async def test_nav_agent_lists_empty_approved_consent_requests(monkeypatch):
    async def _list_center(self, user_id, **kwargs):  # noqa: ANN001,ARG001
        return {"total": 0, "items": []}

    monkeypatch.setattr(ConsentCenterService, "list_center", _list_center)
    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    agent = NavAgent()

    result = await agent.handle(
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="show all my consent requests approved",
        )
    )

    assert result.text == "You do not have any approved consent requests right now."


@pytest.mark.asyncio
async def test_nav_is_registered_without_replacing_location():
    import hushh_mcp.adk_bridge  # noqa: F401

    assert is_wired_specialist("agent_location") is True
    assert is_wired_specialist("agent_nav") is True

    token = issue_token("user_nav", "agent_nav", ConsentScope.AGENT_NAV_REVIEW).token
    result = await dispatch(
        "agent_nav",
        A2ATask(
            user_id="user_nav",
            consent_token=token,
            conversation_id="thread_nav",
            message="Explain this scope.",
        ),
    )

    assert result.model == "one+nav"
    assert "Explain this scope." in result.text


def test_nav_never_lexically_routes_to_connections() -> None:
    source = inspect.getsource(NavAgent.handle)
    assert "get_connections_a2a" not in source
    assert "_is_connections_query" not in source


async def test_pod_nav_reuses_shared_handler_with_scoped_control_plane_read(monkeypatch):
    from hushh_mcp.adk_bridge.contract import A2AAuthorityContext
    from hushh_mcp.adk_bridge.dispatch import bind_specialist_runtime
    from hushh_mcp.services import pod_consent_client
    from hushh_mcp.services.pod_consent_client import ConsentVerdict
    from hushh_mcp.services.pod_data_door import project_nav_state
    from hushh_mcp.services.pod_hub_client import PodHubClient
    from hushh_mcp.services.pod_specialist_runtime import build_pod_specialist_runtime

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", "pod-owner")

    async def verify(token, *, expected_scope):
        scopes = {"read": "pkm.read", "nav": "agent.nav.review"}
        return ConsentVerdict(scopes.get(token) == expected_scope, True, "owner", "pod-owner")

    monkeypatch.setattr(pod_consent_client, "verify_consent", verify)
    raw = {
        "active": {
            "total": 1,
            "items": [
                {
                    "id": "must-drop",
                    "scope": "cap.location.live.view",
                    "counterpart_label": "Example",
                    "consent_token": "must-drop",
                    "metadata": {"request_source": "test", "secret": "must-drop"},
                }
            ],
        },
        "previous": {"total": 0, "items": []},
        "credential": "must-drop",
    }
    projected = project_nav_state(raw)
    assert "must-drop" not in str(projected)
    reads = []

    def read(_self, name, scope_token):
        reads.append((name, scope_token))
        return projected

    monkeypatch.setattr(PodHubClient, "read_specialist", read)
    runtime = build_pod_specialist_runtime(
        user_id="owner",
        hushh_id="pod-owner",
        consent_token="read",  # noqa: S106
        provider="gemini",
        model="synthetic",
        runtime_mode="user_adc",
        credential=None,
        credential_transport="developer_api",
        vertex_project=None,
        vertex_location=None,
        data_door_grants={"nav": "nav"},
    )
    with bind_specialist_runtime(runtime):
        result = await dispatch(
            "agent_nav",
            A2ATask(
                user_id="owner",
                consent_token="nav",  # noqa: S106 -- inert scoped test token
                conversation_id="thread",
                message="Show all active consent grants",
                authority=A2AAuthorityContext(
                    "owner",
                    "owner",
                    "thread",
                    "first_party",
                    invocation_capabilities=("cap.one.invoke",),
                ),
            ),
        )
    assert "Example can view your live location" in result.text
    assert reads == [("nav", "nav")]


async def test_nav_read_only_view_does_not_refresh_identities_or_expire_location():
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock

    from hushh_mcp.services.one_location_center_contributor import OneLocationCenterContributor

    service = ConsentCenterService(read_only=True)
    identity = SimpleNamespace(get_many=AsyncMock(return_value={}), ensure_many=AsyncMock())
    service._identity = identity
    assert await service._hydrate_entry_identities([]) == []
    identity.get_many.assert_awaited_once_with([])
    identity.ensure_many.assert_not_called()

    location = SimpleNamespace(list_state=Mock(return_value={}))
    OneLocationCenterContributor(location, read_only=True).collect("owner")
    location.list_state.assert_called_once_with(user_id="owner", read_only=True)
