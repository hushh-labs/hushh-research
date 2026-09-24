"""The pre-239 runtime can retire Plaid before its tables disappear."""

from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.kai.plaid import router
from hushh_mcp.services.account_service import AccountService


@pytest.mark.parametrize(
    "table", ["kai_plaid_items", "kai_plaid_link_sessions", "kai_plaid_refresh_runs"]
)
def test_cleanup_rechecks_schema_on_the_same_service_after_retirement(table):
    service = AccountService()
    conn = MagicMock()
    result = MagicMock()
    result.scalar.side_effect = [True, False]
    conn.execute.return_value = result
    params = {"user_id": "synthetic-owner"}
    service._delete_user_rows_if_table_exists(conn, table_name=table, params=params)
    service._delete_user_rows_if_table_exists(conn, table_name=table, params=params)
    deletes = [
        call for call in conn.execute.call_args_list if str(call.args[0]).startswith("DELETE")
    ]
    assert len(deletes) == 1
    assert deletes[0].args == (service._delete_by_user_queries[table], params)


def test_unrelated_cleanup_failure_is_not_swallowed():
    service = AccountService()
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("synthetic storage failure")
    with pytest.raises(RuntimeError, match="synthetic storage failure"):
        service._delete_user_rows_if_table_exists(
            conn, table_name="kai_plaid_items", params={"user_id": "synthetic-owner"}
        )


@pytest.mark.parametrize("route", router.routes, ids=lambda route: route.path)
def test_every_legacy_route_refuses_before_table_backed_dependencies(route):
    app = FastAPI()
    app.include_router(router, prefix="/api/kai")
    path = route.path
    for parameter in route.param_convertors:
        path = path.replace("{" + parameter + "}", "synthetic-id")
    with TestClient(app) as client:
        for method in route.methods:
            response = client.request(method, "/api/kai" + path, json={})
            assert response.status_code == 410
            assert response.json()["detail"]["code"] == "PLAID_SERVER_CUSTODY_RETIRED"


def test_real_postgres_cleanup_survives_migration_239_on_same_service():
    import os
    from pathlib import Path

    from sqlalchemy import create_engine, text

    url = os.getenv("PLAID_BRIDGE_REHEARSAL_URL")
    migration = os.getenv("PLAID_BRIDGE_MIGRATION_FILE")
    if not url or not migration:
        pytest.skip("Explicit disposable PostgreSQL rehearsal required")
    engine = create_engine(url)
    service = AccountService()
    tables = ["kai_plaid_refresh_runs", "kai_plaid_link_sessions", "kai_plaid_items"]
    try:
        with engine.begin() as conn:
            assert (
                conn.execute(text("SELECT current_database()"))
                .scalar()
                .startswith("hushh_rehearsal")
            )
            assert (
                conn.execute(text("SELECT to_regclass('public.kai_plaid_items')")).scalar() is None
            )
            for table in tables:
                conn.exec_driver_sql(f"CREATE TABLE {table} (user_id text, status text)")
                conn.exec_driver_sql(
                    f"INSERT INTO {table} VALUES ('owner-a', 'removed'), ('owner-b', 'removed')"
                )
                service._delete_user_rows_if_table_exists(
                    conn, table_name=table, params={"user_id": "owner-a"}
                )
                assert conn.exec_driver_sql(f"SELECT user_id FROM {table}").scalars().all() == [
                    "owner-b"
                ]
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            with conn.connection.driver_connection.cursor() as cursor:
                cursor.execute(Path(migration).read_text())
        with engine.begin() as conn:
            for table in tables:
                service._delete_user_rows_if_table_exists(
                    conn, table_name=table, params={"user_id": "owner-a"}
                )
                assert (
                    conn.execute(
                        text("SELECT to_regclass(:name)"), {"name": "public." + table}
                    ).scalar()
                    is None
                )
    finally:
        engine.dispose()
