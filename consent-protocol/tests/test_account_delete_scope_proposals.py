"""Account deletion must clear scope proposals before connection requests.

connection_scope_proposals holds a plain (no ON DELETE) foreign key into
connection_requests, and proposal events hold one into proposals. Deleting the
requests first raises ForeignKeyViolation and fails the WHOLE account deletion
with a 500 — which is exactly what happened on UAT on 2026-08-08.
"""

from __future__ import annotations

import inspect

from hushh_mcp.services.account_service import AccountService


def _full_account_source() -> str:
    return inspect.getsource(AccountService._delete_full_account)


def test_scope_proposal_tables_have_registered_delete_queries() -> None:
    service = AccountService.__new__(AccountService)
    AccountService.__init__(service)
    for table in ("connection_scope_proposal_events", "connection_scope_proposals"):
        assert table in service._delete_by_user_queries, table


def test_scope_proposals_are_deleted_before_connection_requests() -> None:
    source = _full_account_source()
    # Find the deletion tuple (not the results-bookkeeping dict, which also
    # names these tables) and assert order inside it.
    loop_start = source.index("for table_name in (")
    loop = source[loop_start : source.index("):", loop_start)]
    assert '"connection_scope_proposal_events"' in loop
    events_at = loop.index('"connection_scope_proposal_events"')
    proposals_at = loop.index('"connection_scope_proposals"')
    requests_at = loop.index('"connection_requests"')
    assert events_at < proposals_at < requests_at, (
        "proposal events -> proposals -> requests is the only order the foreign keys allow"
    )


def test_proposal_cleanup_reaches_rows_owned_by_other_users() -> None:
    # The FK blocks deleting MY request while ANYONE's proposal references it,
    # so the cleanup must delete by referenced request, not only by ownership.
    service = AccountService.__new__(AccountService)
    AccountService.__init__(service)
    proposals_sql = str(service._delete_by_user_queries["connection_scope_proposals"])
    assert "connection_request_id IN" in proposals_sql
    events_sql = str(service._delete_by_user_queries["connection_scope_proposal_events"])
    assert "connection_scope_proposal_id IN" in events_sql
