"""Exact-source and installed-schema boundaries for production restoration."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


def _reviewed_record():
    policy = '{"version": 1}\n'
    record = {
        "schemaVersion": 1,
        "project": "hushh-pda",
        "region": "us-central1",
        "sourceSha": "a" * 40,
        "baselineSha": "b" * 40,
        "previousSha": "c" * 40,
        "providerContractVersion": 2,
        "migrations": "none",
        "replacementAccounts": 0,
        "services": ["consent-protocol", "hushh-webapp"],
        "authorityPolicySha256": hashlib.sha256(policy.encode()).hexdigest(),
        "requiredAbsentTables": ["account_phone_transfers", "account_phone_auth_fences"],
        "requiredEmptyTables": [
            "document_delivery_contracts",
            "document_delivery_financial_bindings",
            "document_delivery_cleanup",
        ],
    }
    return policy, record


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "source",
        "policy",
        "writable",
        "database",
        "contract",
        "phone",
        "generation",
        "documents",
    ],
)
def test_production_restoration_requires_exact_source_and_read_only_compatible_schema(
    monkeypatch, tmp_path, failure
):
    spec = importlib.util.spec_from_file_location(
        "restoration_contract", ROOT / "deploy/account-deletion/compatibility_restoration.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    policy, record = _reviewed_record()
    path = tmp_path / "reviewed.json"
    path.write_text(json.dumps(record))
    monkeypatch.setattr(module, "RECORD", path)
    monkeypatch.setattr(
        module,
        "git",
        lambda *args: (
            ('{"version": 0}' if failure == "policy" else policy) if args[0] == "show" else ""
        ),
    )
    answers = iter(
        [
            ("off" if failure == "writable" else "on",),
            ("postgres" if failure == "database" else "hushh_vault",),
            (1 if failure == "contract" else 2, True),
            ("account_phone_transfers" if failure == "phone" else None,),
            (None,),
            (failure == "generation",),
            (failure == "documents",),
            (False,),
            (False,),
        ]
    )
    statements = []

    class Cursor:
        def execute(self, statement, parameters=None):
            statements.append(statement)

        def fetchone(self):
            return next(answers)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    connection = SimpleNamespace(cursor=Cursor)

    def qualify():
        approved = module.qualify_source("d" * 40 if failure == "source" else "a" * 40)
        return module.qualify_schema(connection, approved, require_empty_documents=True)

    if failure:
        with pytest.raises(module.Refused):
            qualify()
    else:
        assert qualify() == {
            "providerContractVersion": 2,
            "replacementAccounts": 0,
            "documentsChecked": True,
        }
    assert all(
        str(statement).startswith(("SELECT", "SHOW", "Composed([SQL('SELECT"))
        for statement in statements
    )
