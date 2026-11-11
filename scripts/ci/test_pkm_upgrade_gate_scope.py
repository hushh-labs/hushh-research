#!/usr/bin/env python3
"""Keep the PKM upgrade gate limited to PKM compatibility coverage."""

from __future__ import annotations

from pathlib import Path
import subprocess
import os


ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts/ci/pkm-upgrade-gate.sh"



def verify_release_sql_mode():
    wrapper = (ROOT / "scripts/ci/run-release-pkm-gate.sh").read_text()
    start = wrapper.index('if [[ "$rehearsal_mode" == --sql-only ]]; then')
    end = wrapper.index('\nBOOTSTRAP_FOCUS_PROFILE=', start)
    branch = wrapper[start:end]
    sql = (ROOT / "consent-protocol/db/verify/pkm_v7_zero_loss_rehearsal.sql").read_text()
    assert "BEGIN;" in sql and sql.rstrip().endswith("ROLLBACK;")
    for status in (0, 47):
        script = ('psql() { test "$*" = "--no-psqlrc -v ON_ERROR_STOP=1 -f consent-protocol/db/verify/pkm_v7_zero_loss_rehearsal.sql" || exit 98; return "$TEST_SQL_STATUS"; };\n'
                  'set -euo pipefail\nrehearsal_mode=--sql-only\n' + branch)
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                env={**os.environ, "TEST_SQL_STATUS": str(status)}, timeout=5)
        assert result.returncode == status, result.stderr

def main() -> int:
    verify_release_sql_mode()
    content = GATE.read_text(encoding="utf-8")
    excluded = (
        "cache-sync-mutation-cascade",
        "pkm-natural-language",
        "ria-onboarding-flow",
        "api-service-consent",
        "events-proxy",
        "test_ria_iam_",
        "test_consent_scope_upgrade",
        "test_kai_",
    )
    for name in excluded:
        assert name not in content, f"PKM upgrade gate must not own {name}"
    required = (
        "pkm-upgrade-orchestrator",
        "pkm-historical-rehearsal",
        "test_pkm_upgrade_service.py",
        "test_pkm_v7_recovery_migration.py",
    )
    for name in required:
        assert name in content, f"PKM upgrade gate is missing {name}"
    print("ok PKM upgrade gate is limited to compatibility coverage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
