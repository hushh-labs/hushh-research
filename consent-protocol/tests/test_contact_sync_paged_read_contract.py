from __future__ import annotations

import inspect
from types import SimpleNamespace

from api.routes.one import connections as connection_routes
from api.routes.one import location as location_routes
from hushh_mcp.services.connections_service import ConnectionsService
from hushh_mcp.services.one_location_agent_service import OneLocationAgentService
from hushh_mcp.services.one_location_circle_service import OneLocationCircleService


def test_connections_page_is_bounded_stable_and_page_local_for_5000_rows():
    service = ConnectionsService.__new__(ConnectionsService)
    captured: dict = {}

    def execute_many(sql, params):
        captured.update(sql=sql, params=params)
        return [
            {
                "connection_id": "cx-0101",
                "user_id": "user-b",
                "display_name": "Alex",
                "total_count": 5000,
                "connected_from_contacts": True,
                "is_ria": True,
            },
            {
                "connection_id": "cx-0102",
                "user_id": "user-c",
                "display_name": "Alex",
                "total_count": 5000,
                "connected_from_contacts": False,
                "is_ria": True,
            },
        ]

    service._execute_many = execute_many
    result = service.list_connections_page(
        "viewer", page=2, limit=100, query="alex", audience="ria"
    )

    assert captured["params"]["offset"] == 100
    assert captured["params"]["limit"] == 100
    assert captured["params"]["audience"] == "ria"
    assert result["totalCount"] == 5000
    assert result["hasMore"] is True
    assert [item["userId"] for item in result["items"]] == ["user-b", "user-c"]
    assert result["items"][0]["connectedFromContacts"] is True
    sql = captured["sql"]
    assert sql.index("ria_filter") < sql.index("OFFSET :offset")
    assert "ORDER BY normalized_name, user_id, connection_id" in sql
    assert "contact_origin.connection_id = page_rows.connection_id" in sql


def test_directory_relationship_reads_are_limited_to_the_returned_page():
    source = inspect.getsource(ConnectionsService.search_directory)
    assert "page_user_ids" in source
    assert "addressee_user_id = ANY(CAST(:page_user_ids AS TEXT[]))" in source
    assert "requester_user_id = ANY(CAST(:page_user_ids AS TEXT[]))" in source
    assert "user_a_id = ANY(CAST(:page_user_ids AS TEXT[]))" in source
    assert "user_b_id = ANY(CAST(:page_user_ids AS TEXT[]))" in source


class _CircleDb:
    def __init__(self, rows):
        self.rows = rows
        self.calls: list[tuple[str, dict]] = []

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params or {}))
        return SimpleNamespace(data=self.rows)


def test_circle_member_page_bounds_5000_shape_and_keeps_provenance_on_page_two():
    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = _CircleDb(
        [
            {
                "authorized": True,
                "total_count": 5000,
                "user_id": "member-101",
                "display_name": "Alex",
                "role": "member",
                "phone_verified": True,
                "relationship": "connected",
                "connected_from_contacts": True,
            }
        ]
    )

    result = service.list_circle_members_page(
        user_id="viewer",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        query="alex",
        page=2,
        limit=5000,
    )

    sql, params = service._db.calls[0]
    assert params["limit"] == 100
    assert params["offset"] == 100
    assert result["totalCount"] == 5000
    assert result["items"][0]["connectedFromContacts"] is True
    assert sql.index("WHERE :query") < sql.index("OFFSET :offset")
    assert "ORDER BY normalized_name, user_id" in sql


def test_eligible_page_filters_and_orders_before_its_bound():
    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = _CircleDb([{"authorized": True, "total_count": 5000, "connection_id": None}])
    result = service.list_eligible_direct_connections_page(
        actor_user_id="viewer",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        query="alex",
        page=50,
        limit=100,
    )
    sql, params = service._db.calls[0]
    assert params["offset"] == 4900
    assert result == {"items": [], "page": 50, "hasMore": True, "totalCount": 5000}
    assert sql.index("WHERE :query") < sql.index("OFFSET :offset")
    assert "ORDER BY normalized_name, user_id, connection_id" in sql


def test_trusted_summary_mode_never_calls_complete_circle_detail():
    source = inspect.getsource(OneLocationCircleService.ensure_trusted_system_circle)
    reconcile = inspect.getsource(OneLocationCircleService._reconcile_trusted_members)
    assert "if summary_only:" in source
    assert "get_circle_overview" in source
    assert source.index("if summary_only:") < source.index("return self.get_circle(")
    assert "SELECT COUNT(*)::BIGINT AS added_count FROM inserted" in reconcile
    assert "RETURNING user_id" not in reconcile


def test_circle_overview_and_member_page_are_distinct_from_complete_detail():
    overview = inspect.getsource(OneLocationCircleService.get_circle_overview)
    members = inspect.getsource(OneLocationCircleService.list_circle_members_page)
    detail = inspect.getsource(OneLocationCircleService.get_circle)
    assert 'circle["members"]' not in overview
    assert "OFFSET :offset LIMIT :limit" in members
    assert 'circle["members"]' in detail


def test_location_recipient_page_reuses_authority_and_bounds_5000_shape():
    service = OneLocationAgentService.__new__(OneLocationAgentService)
    captured: dict = {}

    def execute_many(sql, params):
        captured.update(sql=sql, params=params)
        return [
            {
                "user_id": "contact-101",
                "display_name": "Alex",
                "phone_verified": True,
                "total_count": 5000,
                "connected_from_contacts": True,
            }
        ]

    service._execute_many = execute_many
    service._apply_kai_circle_recommendations = lambda **kw: kw["recipients"]
    result = service.list_verified_recipients_page(
        owner_user_id="viewer", query="alex", page=2, limit=5000
    )
    assert captured["params"]["limit"] == 100
    assert captured["params"]["offset"] == 100
    assert result["totalCount"] == 5000
    assert result["items"][0]["connectedFromContacts"] is True
    sql = captured["sql"]
    assert "origin.origin_kind <> 'named_circle'" in sql
    assert "circle.system_kind IS DISTINCT FROM 'trusted'" in sql
    assert sql.index("WHERE :query") < sql.index("OFFSET :offset")
    assert "ORDER BY normalized_name, user_id" in sql


def test_location_recipient_route_preserves_no_param_legacy_and_adds_page_mode():
    source = inspect.getsource(location_routes.list_verified_location_recipients)
    assert 'return {"recipients": service.list_verified_recipients' in source
    assert "list_verified_recipients_page" in source
    assert "all(value is None for value in (page, limit, query))" in source
    assert 'response.headers["Cache-Control"] = "private, no-store"' in source


def test_location_recipient_search_cannot_query_hidden_domain_or_full_phone():
    service = OneLocationAgentService.__new__(OneLocationAgentService)
    captured_sql: list[str] = []

    def execute_many(sql, params):
        captured_sql.append(sql)
        if params["query"] not in {"alex", "priya", "3210"}:
            return [{"total_count": 0, "user_id": None}]
        return [
            {
                "user_id": "contact",
                "display_name": "Priya" if params["query"] == "priya" else None,
                "email": "alex@private.example",
                "phone_number": "+91 98765 43210",
                "phone_verified": True,
                "total_count": 1,
            }
        ]

    service._execute_many = execute_many
    service._apply_kai_circle_recommendations = lambda **kw: kw["recipients"]

    assert (
        service.list_verified_recipients_page(owner_user_id="viewer", query="private.example")[
            "items"
        ]
        == []
    )
    assert (
        service.list_verified_recipients_page(owner_user_id="viewer", query="919876543210")["items"]
        == []
    )
    assert (
        service.list_verified_recipients_page(owner_user_id="viewer", query="alex")["items"][0][
            "displayName"
        ]
        == "alex"
    )
    assert (
        service.list_verified_recipients_page(owner_user_id="viewer", query="priya")["items"][0][
            "displayName"
        ]
        == "Priya"
    )
    assert service.list_verified_recipients_page(owner_user_id="viewer", query="3210")["items"][0][
        "maskedPhone"
    ].endswith("3210")
    sql = captured_sql[0]
    assert "SPLIT_PART(identity.email, '@', 1)" in sql
    assert "REGEXP_REPLACE(identity.phone_number, '[^0-9]'" in sql
    assert "NULLIF(identity.email" not in sql
    assert "NULLIF(identity.phone_number" not in sql


class _VisibleCircleSearchDb:
    def __init__(self, *, kind: str):
        self.kind = kind
        self.sql = ""

    def execute_raw(self, sql, params=None):
        self.sql = sql
        query = (params or {}).get("query")
        matched = query in {"alex", "priya"}
        common = {
            "authorized": True,
            "total_count": 1 if matched else 0,
            "display_name": "Priya" if query == "priya" else None,
            "email": "alex@private.example",
            "connected_from_contacts": False,
        }
        if not matched:
            return SimpleNamespace(data=[{**common, "user_id": None, "connection_id": None}])
        if self.kind == "member":
            return SimpleNamespace(
                data=[
                    {
                        **common,
                        "user_id": "member",
                        "role": "member",
                        "phone_verified": True,
                        "relationship": "none",
                    }
                ]
            )
        return SimpleNamespace(
            data=[
                {
                    **common,
                    "user_id": "connection",
                    "connection_id": "cx",
                }
            ]
        )


def test_circle_member_search_uses_only_visible_name_or_email_handle():
    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = _VisibleCircleSearchDb(kind="member")
    hidden = service.list_circle_members_page(
        user_id="viewer", circle_id="550e8400-e29b-41d4-a716-446655440000", query="private.example"
    )
    handle = service.list_circle_members_page(
        user_id="viewer", circle_id="550e8400-e29b-41d4-a716-446655440000", query="alex"
    )
    name = service.list_circle_members_page(
        user_id="viewer", circle_id="550e8400-e29b-41d4-a716-446655440000", query="priya"
    )
    assert hidden["items"] == []
    assert handle["items"][0]["displayName"] == "alex"
    assert name["items"][0]["displayName"] == "Priya"
    assert "SPLIT_PART(identity.email, '@', 1)" in service._db.sql
    assert "NULLIF(identity.email" not in service._db.sql
    assert "identity.phone_number" not in service._db.sql


def test_eligible_search_uses_only_visible_name_or_email_handle():
    service = OneLocationCircleService.__new__(OneLocationCircleService)
    service._db = _VisibleCircleSearchDb(kind="eligible")
    hidden = service.list_eligible_direct_connections_page(
        actor_user_id="viewer",
        circle_id="550e8400-e29b-41d4-a716-446655440000",
        query="private.example",
    )
    handle = service.list_eligible_direct_connections_page(
        actor_user_id="viewer", circle_id="550e8400-e29b-41d4-a716-446655440000", query="alex"
    )
    assert hidden["items"] == []
    assert handle["items"][0]["displayName"] == "alex"
    assert "SPLIT_PART(identity.email, '@', 1)" in service._db.sql
    assert "NULLIF(identity.email" not in service._db.sql
    assert "identity.phone_number" not in service._db.sql


def test_viewer_relative_paged_reads_are_private_and_not_cacheable():
    connections_source = inspect.getsource(connection_routes.list_connections)
    eligible_source = inspect.getsource(location_routes.list_named_circle_eligible_connections)
    marker = 'response.headers["Cache-Control"] = "private, no-store"'
    assert marker in connections_source
    assert marker in eligible_source
