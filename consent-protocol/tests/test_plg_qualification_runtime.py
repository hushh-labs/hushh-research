"""Transactional bootstrap DDL, ownership and read-only runtime proof contracts."""

import importlib
from contextlib import nullcontext
from pathlib import Path

import pytest

from tests.helpers.plg_runtime import Connection, RuntimeConnection

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def schema(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return importlib.import_module("qualification_schema")


@pytest.mark.parametrize(
    "privileges",
    [(False, False, True, True), (True, True, True, True), (True, False, False, True)],
)
def test_runtime_verification_requires_bootstrap_ddl_without_ledger_writes_and_with_sequence_permission(
    schema, monkeypatch, privileges
):
    monkeypatch.setattr(schema.runtime, "verify", lambda _connection: {})

    class GrantsConnection(Connection):
        def fetchone(self):
            return privileges if "has_schema_privilege" in self.query else (True,)

    connection = GrantsConnection()
    with pytest.raises(
        ValueError, match="qualification_runtime_ddl_ledger_or_read_grants_unverified"
    ):
        schema.verify_runtime_grants(connection)
    assert all(query.startswith("SELECT") for query, _ in connection.calls)


def test_bootstrap_ddl_install_is_one_pristine_transaction_with_exact_dependencies(
    schema, monkeypatch
):
    runtime = schema.runtime
    connection = RuntimeConnection(runtime)
    monkeypatch.setattr(
        schema.runtime,
        "_dml_grants",
        lambda c: c.execute("GRANT SELECT ON public.synthetic TO runtime"),
    )
    runtime.install(connection)
    statements = [query for query, _ in connection.calls]
    assert statements.count("BEGIN") == statements.count("COMMIT") == 1
    assert len([q for q in statements if q.startswith("ALTER TABLE")]) == 5
    assert len([q for q in statements if q.startswith("GRANT SELECT ON TABLE public.")]) == 5
    assert not any("CREATE ROLE" in q or "SET ROLE" in q or "MEMBER" in q for q in statements)
    connection.readonly = True
    proof = runtime.verify(connection)
    runtime.validate_proof(proof)
    assert proof["schemaPrivilegeScope"] == "schema-wide"
    assert proof["schemaPrivileges"] == ["USAGE", "CREATE"]
    assert {o["kind"] for o in proof["ownedObjects"]} >= {
        "toast",
        "toast-index",
        "sequence",
        "row-type",
        "array-type",
    }
    connection.readonly = False
    count = len([q for q, _ in connection.calls if q.startswith("GRANT")])
    with pytest.raises(ValueError, match="pristine_install"):
        runtime.install(connection)
    assert len([q for q, _ in connection.calls if q.startswith("GRANT")]) == count


@pytest.mark.parametrize("defect", [None, "admin-read", "admin-post"])
def test_bootstrap_preserves_only_existing_administrator_select_after_membership_restore(
    schema, monkeypatch, defect
):
    connection = RuntimeConnection(schema.runtime, defect=defect)
    monkeypatch.setattr(schema.runtime, "_dml_grants", lambda _c: None)
    if defect:
        code = (
            "existing_admin_read_required" if defect == "admin-read" else "admin_read_not_preserved"
        )
        with pytest.raises(ValueError, match=code):
            schema.runtime.install(connection)
        assert connection.calls[-1][0] == "ROLLBACK" and not connection.admin_select
        if defect == "admin-read":
            assert not any(q.startswith(("GRANT", "ALTER")) for q, _ in connection.calls)
    else:
        schema.runtime.install(connection)
        connection.temporary_owners = False
        assert connection.admin_select == set(schema.runtime.TABLES)
        query, parameters = next(
            (q, p) for q, p in connection.calls if "preserved_admin_select" in q
        )
        connection.execute(query, parameters)
        assert connection.fetchone() == (True, True, True)


@pytest.mark.parametrize(
    "defect",
    [
        "partial",
        "sequence-link",
        "missing-type",
        "unrelated-owner",
        "ledger-dml",
        "other-object",
        "authority",
        "membership",
    ],
)
def test_bootstrap_install_refuses_unknown_or_privileged_state_before_any_grant(
    schema, monkeypatch, defect
):
    connection = RuntimeConnection(schema.runtime, defect=defect)
    monkeypatch.setattr(schema.runtime, "_dml_grants", lambda _c: pytest.fail("grant began"))
    with pytest.raises(ValueError):
        schema.runtime.install(connection)
    assert not any(q.startswith(("GRANT", "ALTER")) for q, _ in connection.calls)


def test_bootstrap_post_drift_rolls_back_without_replaying_or_hiding_extra_ownership(
    schema, monkeypatch
):
    connection = RuntimeConnection(schema.runtime, defect="post-drift")
    initial = connection.objects[:]
    monkeypatch.setattr(schema.runtime, "_dml_grants", lambda _c: None)
    with pytest.raises(ValueError, match="bootstrap_ownership"):
        schema.runtime.install(connection)
    assert connection.calls[-1][0] == "ROLLBACK"
    assert connection.objects == initial and connection.create is False and not connection.extra


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "partial",
        "sequence-link",
        "missing-type",
        "unrelated-owner",
        "ledger-dml",
        "other-object",
        "membership",
        "readonly",
        "socket",
    ],
)
def test_runtime_metadata_verification_never_mutates_or_accepts_unowned_dependencies(
    schema, defect
):
    connection = RuntimeConnection(schema.runtime, installed=True, defect=defect)
    if defect is None:
        schema.runtime.validate_proof(schema.runtime.verify(connection))
    else:
        with pytest.raises(ValueError):
            schema.runtime.verify(connection)
    assert all(q.startswith(("SELECT", "SHOW", "\nSELECT", "\nWITH")) for q, _ in connection.calls)


def test_reconciliation_runs_full_source_boundary_before_one_install_and_never_initializes(
    schema, monkeypatch, tmp_path
):
    connection, order = Connection(), []
    monkeypatch.setattr(schema, "reviewed_source", lambda *_a: None)
    monkeypatch.setattr(schema, "schema_lock", lambda _c: nullcontext())
    monkeypatch.setattr(
        schema, "_source_preflight", lambda *_a: order.append("canonical-source") or {}
    )
    monkeypatch.setattr(schema, "runtime_grants", lambda _c: order.append("install"))
    monkeypatch.setattr(
        schema, "_runtime_boundary", lambda *_a: order.append("runtime-proof") or {}
    )
    monkeypatch.setattr(schema, "initialize", lambda *_a: pytest.fail("initializer replayed"))
    schema.reconcile_bootstrap(
        connection, schema.Target("uat"), tmp_path, "synthetic_admin", "secret"
    )
    assert order == ["canonical-source", "install", "runtime-proof"]
    order.clear()
    monkeypatch.setattr(
        schema, "_source_preflight", lambda *_a: (_ for _ in ()).throw(ValueError("source blocked"))
    )
    with pytest.raises(ValueError, match="source blocked"):
        schema.reconcile_bootstrap(
            connection, schema.Target("uat"), tmp_path, "synthetic_admin", "secret"
        )
    assert not order
