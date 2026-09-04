#!/usr/bin/env python3
"""Keep the PKM upgrade gate limited to PKM compatibility coverage."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts/ci/pkm-upgrade-gate.sh"


def main() -> int:
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
