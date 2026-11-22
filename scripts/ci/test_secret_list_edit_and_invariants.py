"""Unit tests for secret list edit safety and invariant cutover checks (#9731)."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module(relative_path: str, module_name: str):
    path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def secret_edit_mod():
    return _load_module("scripts/ops/secret_list_edit.py", "secret_list_edit")


@pytest.fixture
def invariants_mod():
    return _load_module(
        "scripts/ops/verify_secret_list_invariants.py", "verify_secret_list_invariants"
    )


SYNTHETIC_POOL = [f"+1202555010{i}" for i in range(10)]
LEGACY_59_ENTRIES = [f"+198989898{79 + i:02d}" for i in range(40)] + [
    "+18005550199",
    "+18665550199",
    "+18885550199",
    "+13125550199",
    "+14155550199",
    "+12125550199",
    "+16175550199",
    "+12065550199",
    "+13035550199",
    "+16145550199",
    "+15035550199",
    "+14045550199",
    "+917023488011",
    "+917023488012",
    "+917023488013",
    "+917023488014",
    "+918080469407",
]


class TestSecretListEditSyntheticAllowlist:
    def test_declared_phone_secrets_identifies_phone_lists(self, secret_edit_mod):
        declared = secret_edit_mod.get_declared_phone_allowlist_secrets()
        assert "HUSHH_UAT_PHONE_TEST_NUMBERS" in declared
        assert "HUSHH_PROD_PHONE_TEST_NUMBERS" in declared
        assert "RIA_CLAIM_TEST_EMAILS" not in declared

    def test_refuses_non_phone_secret(self, secret_edit_mod, monkeypatch):
        test_args = [
            "secret_list_edit.py",
            "--secret",
            "RIA_CLAIM_TEST_EMAILS",
            "--project",
            "hushh-pda-uat",
            "--replace-synthetic-allowlist",
            *SYNTHETIC_POOL,
        ]
        monkeypatch.setattr("sys.argv", test_args)
        monkeypatch.setattr(
            secret_edit_mod, "read_version", lambda s, p, v: "test@example.com"
        )

        with pytest.raises(SystemExit) as exc:
            secret_edit_mod.main()
        assert "restricted to phone allowlist secrets" in str(exc.value)

    def test_refuses_fewer_than_10_entries(self, secret_edit_mod, monkeypatch):
        test_args = [
            "secret_list_edit.py",
            "--secret",
            "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "--project",
            "hushh-pda-uat",
            "--replace-synthetic-allowlist",
            *SYNTHETIC_POOL[:5],
        ]
        monkeypatch.setattr("sys.argv", test_args)
        monkeypatch.setattr(
            secret_edit_mod, "read_version", lambda s, p, v: ",".join(LEGACY_59_ENTRIES)
        )

        with pytest.raises(SystemExit) as exc:
            secret_edit_mod.main()
        assert "must contain at least 10 entries" in str(exc.value)

    def test_refuses_routable_phone_numbers(self, secret_edit_mod, monkeypatch):
        routable_pool = SYNTHETIC_POOL[:9] + ["+19898989879"]
        test_args = [
            "secret_list_edit.py",
            "--secret",
            "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "--project",
            "hushh-pda-uat",
            "--replace-synthetic-allowlist",
            *routable_pool,
        ]
        monkeypatch.setattr("sys.argv", test_args)
        monkeypatch.setattr(
            secret_edit_mod, "read_version", lambda s, p, v: ",".join(LEGACY_59_ENTRIES)
        )

        with pytest.raises(SystemExit) as exc:
            secret_edit_mod.main()
        assert "must match ^\\+1[2-9]\\d{2}55501\\d{2}" in str(exc.value)

    def test_dry_run_accepts_valid_10_synthetic_numbers(
        self, secret_edit_mod, monkeypatch, capsys
    ):
        test_args = [
            "secret_list_edit.py",
            "--secret",
            "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "--project",
            "hushh-pda-uat",
            "--replace-synthetic-allowlist",
            *SYNTHETIC_POOL,
        ]
        monkeypatch.setattr("sys.argv", test_args)
        monkeypatch.setattr(
            secret_edit_mod, "read_version", lambda s, p, v: ",".join(LEGACY_59_ENTRIES)
        )

        rc = secret_edit_mod.main()
        assert rc == 0
        captured = capsys.readouterr()
        assert "result (synthetic replacement)  10 entries" in captured.out
        assert "Dry run" in captured.out


class TestVerifySecretListInvariantsCutover:
    def test_is_synthetic_cutover_true_for_legacy_to_synthetic(self, invariants_mod):
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "HUSHH_UAT_PHONE_TEST_NUMBERS",
                SYNTHETIC_POOL,
                LEGACY_59_ENTRIES,
                min_entries=10,
            )
            is True
        )
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "HUSHH_PROD_PHONE_TEST_NUMBERS",
                SYNTHETIC_POOL,
                LEGACY_59_ENTRIES,
                min_entries=10,
            )
            is True
        )

    def test_is_synthetic_cutover_false_for_non_phone_secret(self, invariants_mod):
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "RIA_CLAIM_TEST_NUMBERS",
                SYNTHETIC_POOL,
                LEGACY_59_ENTRIES,
                min_entries=5,
            )
            is False
        )

    def test_is_synthetic_cutover_false_for_below_floor_accidental_wipe(
        self, invariants_mod
    ):
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "HUSHH_UAT_PHONE_TEST_NUMBERS",
                SYNTHETIC_POOL[:2],
                LEGACY_59_ENTRIES,
                min_entries=10,
            )
            is False
        )

    def test_is_synthetic_cutover_false_for_routable_replacement(self, invariants_mod):
        routable_pool = SYNTHETIC_POOL[:9] + ["+19898989879"]
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "HUSHH_UAT_PHONE_TEST_NUMBERS",
                routable_pool,
                LEGACY_59_ENTRIES,
                min_entries=10,
            )
            is False
        )

    def test_is_synthetic_cutover_false_when_prev_was_already_synthetic(
        self, invariants_mod
    ):
        # Once cutover is complete, subsequent shrinking between synthetic versions must not bypass
        shrunk_pool = SYNTHETIC_POOL[:8]
        assert (
            invariants_mod.is_synthetic_phone_cutover(
                "HUSHH_UAT_PHONE_TEST_NUMBERS",
                shrunk_pool,
                SYNTHETIC_POOL,
                min_entries=5,
            )
            is False
        )

    def test_check_list_passes_on_authorized_synthetic_cutover(
        self, invariants_mod, monkeypatch
    ):
        spec = {
            "name": "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "project": "hushh-pda-uat",
            "min_entries": 10,
            "max_shrink": 2,
        }
        monkeypatch.setattr(invariants_mod, "versions", lambda s, p: ["10", "9"])
        monkeypatch.setattr(
            invariants_mod,
            "read",
            lambda s, p, v: (
                "\n".join(SYNTHETIC_POOL) if v == "10" else "\n".join(LEGACY_59_ENTRIES)
            ),
        )

        result = invariants_mod.check_list(spec)
        assert result.status == "healthy"
        assert len(result.failures) == 0
        assert "authorized synthetic cutover" in (result.summary or "")

    def test_check_list_fails_on_accidental_wipe_below_floor(
        self, invariants_mod, monkeypatch
    ):
        spec = {
            "name": "HUSHH_UAT_PHONE_TEST_NUMBERS",
            "project": "hushh-pda-uat",
            "min_entries": 10,
            "max_shrink": 2,
        }
        monkeypatch.setattr(invariants_mod, "versions", lambda s, p: ["10", "9"])
        monkeypatch.setattr(
            invariants_mod,
            "read",
            lambda s, p, v: (
                "+12025550100" if v == "10" else "\n".join(LEGACY_59_ENTRIES)
            ),
        )

        result = invariants_mod.check_list(spec)
        assert result.status == "failed"
        assert any("below the floor of 10" in f for f in result.failures)

    def test_check_list_fails_on_non_phone_list_shrink(
        self, invariants_mod, monkeypatch
    ):
        spec = {
            "name": "RIA_CLAIM_TEST_EMAILS",
            "project": "hushh-pda-uat",
            "min_entries": 1,
            "max_shrink": 2,
        }
        monkeypatch.setattr(invariants_mod, "versions", lambda s, p: ["3", "2"])
        monkeypatch.setattr(
            invariants_mod,
            "read",
            lambda s, p, v: (
                "one@example.com"
                if v == "3"
                else "one@example.com,two@example.com,three@example.com,four@example.com,five@example.com"
            ),
        )

        result = invariants_mod.check_list(spec)
        assert result.status == "failed"
        assert any(
            "entries present in v2 are gone from v3" in f for f in result.failures
        )
