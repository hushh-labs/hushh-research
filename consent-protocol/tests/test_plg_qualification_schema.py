"""Trust and uncertain-outcome boundaries for the fixed synthetic initializer."""

import copy
import importlib
import json
import re
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.helpers.plg_runtime import Connection

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def schema(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT / "deploy/plg"))
    return importlib.import_module("qualification_schema")


def test_immutable_overlay_blob_change_is_refused(schema, monkeypatch):
    monkeypatch.setattr(schema.release_source, "_git", lambda *_a: b"unreviewed SQL")
    with pytest.raises(ValueError, match="qualification_overlay_source_changed"):
        schema.foundation.overlay_sql()


def test_foundation_rejects_changed_base_or_overlay_sequence(schema):
    foundation = schema.foundation
    original = foundation.binding() | {"observedConsentAudit": {}, "compatibilityNotes": []}
    for change in ("reorder", "extra", "transaction", "base-order"):
        record = copy.deepcopy(original)
        if change == "reorder":
            record["compatibleOverlays"].reverse()
        elif change == "extra":
            record["compatibleOverlays"].append({"path": "arbitrary.sql"})
        elif change == "base-order":
            record["legacyFoundation"]["fragments"].reverse()
        else:
            record["compatibleOverlays"][0]["transactional"] = True
        with pytest.raises(ValueError, match="qualification_foundation_contract_mismatch"):
            foundation.validate_contract(record)


def test_foreign_source_checkout_fails_before_database_work(schema, monkeypatch, tmp_path):
    monkeypatch.setattr(schema, "source_boundary", lambda: None)
    monkeypatch.setattr(schema.foundation, "load_contract", lambda: ({}, "digest"))
    monkeypatch.setattr(schema.release_source, "_git", lambda *_a: b"0" * 40)
    connection = Connection()
    with pytest.raises(ValueError, match="qualification_initializer_checkout_mismatch"):
        schema.initialize(
            connection, schema.Target("uat"), tmp_path, "synthetic_admin", "synthetic"
        )
    assert connection.calls == []


@pytest.mark.parametrize("system_id", ["7583196663345094671", "unrelated-cluster"])
def test_production_or_foreign_cluster_is_refused(schema, system_id):
    connection = Connection(system_id=system_id)
    with pytest.raises(ValueError, match="qualification_schema_cluster_or_owner_mismatch"):
        schema.identity(connection, schema.Target("uat"), "synthetic_admin")


def test_unrecorded_cluster_fails_before_server_inspection(schema, monkeypatch):
    monkeypatch.setattr(schema.foundation, "CLUSTERS", {})
    connection = Connection()
    with pytest.raises(ValueError, match="qualification_cluster_attestation_missing"):
        schema.identity(connection, schema.Target("uat"), "synthetic_admin")
    assert connection.calls == []


@pytest.mark.parametrize("environment,version", [("dev", 150019), ("uat", 150018)])
def test_recorded_cluster_binds_each_fixed_socket(schema, environment, version):
    target = schema.Target(environment)
    entry = schema.foundation.CLUSTERS[environment]
    connection = Connection(system_id=entry["systemIdentifier"])
    connection.get_dsn_parameters = lambda: {
        "host": "127.0.0.1",
        "port": str(target.proxy_port),
        "dbname": "plg_qualification",
        "user": "synthetic_admin",
    }
    schema.identity(connection, target, "synthetic_admin")
    assert entry["postgresMajor"] == 15 and entry["observedServerVersionNum"] == version
    assert all(query.startswith("SELECT") for query, _ in connection.calls)


@pytest.mark.parametrize("role", ["plg_qualification_migrator", "plg_qualification_runtime"])
def test_owned_name_with_privilege_drift_is_not_admitted(schema, role):
    class ChangedRole(Connection):
        def fetchone(self):
            row = super().fetchone()
            if self.query.startswith("SELECT rolcanlogin") and self.calls[-1][1] == (role,):
                return row[:1] + (True,) + row[2:]
            return row

    connection = ChangedRole()
    with pytest.raises(ValueError, match="qualification_existing_role_unowned_or_privileged"):
        schema.identity(connection, schema.Target("uat"), "synthetic_admin")
    assert all(query.startswith("SELECT") for query, _ in connection.calls)


@pytest.mark.parametrize(
    "populated,authority,code",
    [
        (True, True, "qualification_schema_start_not_empty"),
        (False, False, "qualification_existing_admin_and_owner_membership_required"),
    ],
)
def test_partial_schema_or_missing_existing_authority_never_starts_initializer(
    schema,
    monkeypatch,
    tmp_path,
    populated,
    authority,
    code,
):
    connection = Connection(populated=populated, authority=authority)
    monkeypatch.setattr(schema, "reviewed_source", lambda *_a: ({}, "digest"))
    monkeypatch.setattr(schema, "run_source", lambda *_a, **_k: pytest.fail("DDL started"))
    with pytest.raises(ValueError, match=code):
        schema.initialize(
            connection, schema.Target("uat"), tmp_path, "synthetic_admin", "synthetic"
        )
    assert connection.calls[-1][0] == "SELECT pg_advisory_unlock(%s,%s)"


def test_concurrent_index_requires_autocommit_before_any_schema_work(schema):
    connection = Connection()
    connection.autocommit = False
    with pytest.raises(ValueError, match="qualification_schema_autocommit_required"):
        schema.empty_start(connection)
    assert connection.calls == []


def test_initializer_precedes_only_reviewed_overlays_without_fabricated_ledger(
    schema,
    monkeypatch,
    tmp_path,
):
    connection, order = Connection(), []
    monkeypatch.setattr(schema, "reviewed_source", lambda *_a: ({}, "digest"))
    monkeypatch.setattr(schema, "schema_lock", lambda *_a: nullcontext())
    monkeypatch.setattr(
        schema,
        "run_source",
        lambda *_a, **k: order.append("vault" if k["vault"] else "initializer"),
    )
    monkeypatch.setattr(
        schema.base,
        "fragments",
        lambda: tuple((name, name.encode()) for name, _ in schema.base.FRAGMENTS),
    )
    monkeypatch.setattr(
        schema.foundation,
        "overlay_sql",
        lambda: tuple((name, name.encode()) for name, _digest in schema.foundation.OVERLAYS),
    )
    execute = connection.execute

    def record(query, parameters=None):
        if str(query).startswith("kai_gmail_"):
            order.append(str(query))
        if str(query).endswith(".sql"):
            assert connection.autocommit is True
            order.append(query[:3])
        execute(query, parameters)

    connection.execute = record
    monkeypatch.setattr(schema, "runtime_grants", lambda *_a: order.append("grants"))
    monkeypatch.setattr(schema, "_source_preflight", lambda *_a: order.append("source-preflight"))
    monkeypatch.setattr(schema, "_runtime_boundary", lambda *_a: order.append("runtime-proof"))
    schema.initialize(connection, schema.Target("uat"), tmp_path, "synthetic_admin", "synthetic")
    assert order == [
        "vault",
        *(name for name, _ in schema.base.FRAGMENTS),
        "initializer",
        "407",
        "408",
        "418",
        "419",
        "423",
        "source-preflight",
        "grants",
        "runtime-proof",
    ]
    assert not any("INSERT" in query or "DELETE" in query for query, _ in connection.calls)


def test_child_environment_cannot_inherit_shared_routing_or_provider_credentials(
    schema, monkeypatch
):
    monkeypatch.setenv("DB_UNIX_SOCKET", "/cloudsql/hushh-pda:production")
    monkeypatch.setenv("DATABASE_URL", "synthetic-production-url")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "synthetic-provider-key")
    monkeypatch.setenv("PYTHONPATH", "synthetic-injected-module")
    monkeypatch.setenv("BACKEND_RUNTIME_CONFIG_JSON", '{"db_name":"hushh_vault"}')
    environment = schema.child_environment(
        schema.Target("uat"), "synthetic_admin", "p@ss/#", initializer=True
    )
    assert environment["DB_PASSWORD"] == "p%40ss%2F%23"
    assert environment["DB_HOST"] == "127.0.0.1" and environment["DB_PORT"] == "6547"
    assert environment["DB_NAME"] == "plg_qualification" and environment["DB_UNIX_SOCKET"] == ""
    assert environment["PYTHON_DOTENV_DISABLED"] == "1"
    assert environment["BACKEND_RUNTIME_CONFIG_JSON"] == "{}"
    assert not {"DATABASE_URL", "GOOGLE_APPLICATION_CREDENTIALS", "PYTHONPATH"} & environment.keys()


def test_canonical_failure_is_not_retried_and_never_logs_credentials(schema, monkeypatch, tmp_path):
    calls = []

    def failed(command, **kwargs):
        calls.append(command)
        assert "synthetic-password" not in str(command)
        assert kwargs["stdout"] == subprocess.DEVNULL and kwargs["stderr"] == subprocess.DEVNULL
        return SimpleNamespace(returncode=1)

    monkeypatch.setattr(schema.subprocess, "run", failed)
    with pytest.raises(
        ValueError, match="qualification_canonical_initializer_operation_unverified"
    ):
        schema.run_source(
            tmp_path,
            schema.Target("uat"),
            "synthetic_admin",
            "synthetic-password",
            initializer=True,
        )
    assert len(calls) == 1


def test_isolated_child_refuses_dotenv_admission_before_loading_any_source(schema, tmp_path):
    destination = tmp_path / "source-was-loaded"
    script = tmp_path / "inert-source.py"
    script.write_text("from pathlib import Path\nPath(" + repr(str(destination)) + ").touch()\n")
    environment = schema.child_environment(
        schema.Target("uat"), "synthetic_admin", "synthetic", initializer=True
    )
    environment["PYTHON_DOTENV_DISABLED"] = "0"
    result = subprocess.run(  # noqa: S603 -- fixed inert test source, no network or database.
        [sys.executable, "-I", "-c", schema.SOURCE_CHILD, str(script)],
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode != 0 and not destination.exists()
    assert "qualification_source_dotenv_version_required" in result.stderr


@pytest.mark.parametrize("vault", [False, True])
def test_canonical_child_handles_unicode_under_isolated_redirected_execution(
    schema, tmp_path, vault
):
    """Windows cp1252 failed before DDL even though the parent used UTF-8."""
    script = tmp_path / "consent-protocol/db/migrate.py"
    script.parent.mkdir(parents=True)
    script.write_text(
        "import sys\nassert sys.flags.utf8_mode == 1\n"
        'assert sys.argv[1:] in (["--init","--release-environment","production"],'
        '["--table","vault_keys","--release-environment","production"])\nprint(\'\\u2705\')\n',
        encoding="utf-8",
    )
    schema.run_source(
        tmp_path,
        schema.Target("dev"),
        "synthetic_admin",
        "synthetic",
        initializer=True,
        vault=vault,
    )


def test_disabled_dotenv_cannot_fill_missing_provider_material(schema, monkeypatch, tmp_path):
    from dotenv import load_dotenv

    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    dotenv_path = tmp_path / ".env.local"
    dotenv_path.write_text("GOOGLE_APPLICATION_CREDENTIALS=synthetic-provider-material\n")
    assert load_dotenv(dotenv_path) is False
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in schema.os.environ


@pytest.mark.parametrize(
    "mutation",
    ["none", "invalid-shape", "missing-confirmation", "changed-literal", "merged-function"],
)
def test_memory_index_checks_complete_definition_without_triggering_ddl(
    schema, monkeypatch, mutation
):
    source = (
        ROOT / "consent-protocol/db/migrations/407_plg_memory_revision_index.sql"
    ).read_bytes()
    monkeypatch.setattr(schema.foundation, "overlay_sql", lambda: (("407", source),))
    predicate = source.decode().split("WHERE ", 1)[1].strip().removesuffix(";")
    if mutation == "missing-confirmation":
        predicate = predicate.split(
            "AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id')", 1
        )[0]
    elif mutation == "changed-literal":
        predicate = predicate.replace("owner_confirmed", "owner_ confirmed")
    elif mutation == "merged-function":
        predicate = predicate.replace("NULLIF(BTRIM", "NULLIFBTRIM")
    row = (
        mutation != "invalid-shape",
        "(metadata ->> 'data_version'::text)",
        predicate,
        "schema-only-definition",
    )

    class IndexConnection(Connection):
        def fetchone(self):
            return row

    connection = IndexConnection()
    if mutation == "none":
        assert schema.memory_index(connection) == "schema-only-definition"
    else:
        with pytest.raises(ValueError, match="qualification_memory_index"):
            schema.memory_index(connection)
    assert len(connection.calls) == 1 and connection.calls[0][0].startswith("SELECT")


def test_uncertain_write_preserves_intent_and_refuses_blind_retry(schema, monkeypatch, tmp_path):
    output, connections = tmp_path / "attempt.json", []
    monkeypatch.setattr(schema, "reviewed_source", lambda *_a: ({}, "digest"))
    monkeypatch.setenv("PLG_QUALIFICATION_ADMIN_USER", "synthetic_admin")
    monkeypatch.setenv("PLG_QUALIFICATION_ADMIN_PASSWORD", "synthetic-password")
    monkeypatch.setattr(
        schema, "connect", lambda *_a, **_k: connections.append(True) or Connection()
    )

    def unknown(*_a):
        raise TimeoutError("synthetic-password must not reach evidence")

    monkeypatch.setattr(schema, "initialize", unknown)
    with pytest.raises(ValueError, match="qualification_schema_operation_unverified"):
        schema.execute(schema.Target("uat"), tmp_path, output, action="initialize")
    assert json.loads(output.read_text())["status"] == "needs-reconciliation"
    assert json.loads(output.read_text())["safeErrorClass"] == "TimeoutError"
    assert "refusalCode" not in json.loads(output.read_text())
    assert "synthetic-password" not in output.read_text()
    with pytest.raises(FileExistsError):
        schema.execute(schema.Target("uat"), tmp_path, output, action="initialize")
    assert len(connections) == 1


@pytest.mark.parametrize("case", ["valid", "blob", "fragment", "order"])
def test_base_statements_are_all_verified_before_any_write(schema, monkeypatch, case):
    content = (ROOT / schema.base.PATH).read_text(encoding="utf-8").encode()
    if case == "blob":
        content += b"\nCREATE TABLE extra();\n"
    elif case == "fragment":
        content = content.replace(b"google_sub TEXT,", b"google_sub INTEGER,", 1)
        monkeypatch.setattr(schema.base, "SHA256", schema.hashlib.sha256(content).hexdigest())
    elif case == "order":
        monkeypatch.setattr(schema.base, "FRAGMENTS", tuple(reversed(schema.base.FRAGMENTS)))
    monkeypatch.setattr(schema.base.release_source, "_git", lambda *_: content)
    connection, phases = Connection(), []
    if case == "valid":
        schema.base.install(connection, lambda **kwargs: phases.append(kwargs["vault"]))
        assert phases == [True, False] and len(connection.calls) == 3
        assert all(
            query.startswith("CREATE TABLE IF NOT EXISTS kai_gmail_")
            for query, _ in connection.calls
        )
    else:
        with pytest.raises(ValueError, match="qualification_base_"):
            schema.base.install(connection, lambda **kwargs: phases.append(kwargs["vault"]))
        assert phases == [] and connection.calls == []


@pytest.mark.parametrize("case", ["valid", "extra", "identity", "value", "boolean"])
def test_public_source_catalog_accepts_only_fixed_stable_identities_and_values(schema, case):
    definition = schema.foundation.CATALOGS["investor_profiles"]
    rows = copy.deepcopy(definition["rows"])
    assert len(rows) == 24
    source = (
        ROOT / "consent-protocol/db/migrations/057_marketplace_investor_admission.sql"
    ).read_text(encoding="utf-8")
    assert {row[0] for row in rows} == set(re.findall(r"^\s*'([0-9]{10})',\s*$", source, re.M))
    if case == "extra":
        rows.append(rows[0])
    elif case == "identity":
        rows[0][0] = "synthetic-unknown-public-profile"
    elif case == "value":
        rows[0][-1] += 1
    elif case == "boolean":
        rows[0][4] = 1
    cursor = SimpleNamespace(execute=lambda *_: None, fetchall=lambda: rows)
    if case == "valid":
        schema.foundation.inspect_catalog(cursor, "investor_profiles")
    else:
        with pytest.raises(ValueError, match="qualification_source_catalog_changed"):
            schema.foundation.inspect_catalog(cursor, "investor_profiles")


@pytest.mark.parametrize("arguments", [(False, True), ("--full", False), (True, "arbitrary")])
def test_base_child_cannot_select_a_noncanonical_phase(schema, arguments):
    with pytest.raises(ValueError, match="qualification_source_phase_invalid"):
        schema.base.arguments(*arguments)
