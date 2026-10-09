"""Protect the mandatory Back navigation CI boundary without optional dependencies."""
from pathlib import Path
import json
import re
import unittest

def job_block(workflow, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)
    if not match:
        raise ValueError(f"Missing job: {name}")
    return match.group(1)


ROOT = Path(__file__).resolve().parents[2]


def validate(workflow):
    back = job_block(workflow, "back-navigation-contracts")
    if re.search(r"^\s+(if|needs|continue-on-error):", back, re.M):
        raise ValueError("Back must run independently with failures enforced")
    if not re.search(r"^\s+- run: npm run verify:back-contracts\s*$", back, re.M):
        raise ValueError("Back verifier missing or failure suppressed")
    if not re.search(r"^\s+- run: npm ci --prefer-offline --no-audit --progress=false\s*$", back, re.M):
        raise ValueError("Back must install its peer dependencies with the canonical web recipe")
    for name in ("preflight-gate", "ci-status"):
        gate = job_block(workflow, name)
        needs = re.search(r"^    needs:\n((?:      - [^\n]+\n)+)", gate, re.M)
        if not needs or "      - back-navigation-contracts\n" not in needs.group(1):
            raise ValueError(f"Back not required by {name}")
        if 'needs[\'back-navigation-contracts\'].result }}" != "success"' not in gate:
            raise ValueError(f"Back skips must fail {name}")


class BackGateTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/ci.yml").read_text()

    def test_back_is_mandatory(self):
        validate(self.workflow)

    def test_verifier_is_read_only_and_runs_behavioral_regressions(self):
        scripts = json.loads((ROOT / "hushh-webapp/package.json").read_text())["scripts"]
        self.assertEqual(scripts["verify:back-contracts"], "node ./scripts/architecture/verify-back-navigation.mjs && node --test ./scripts/architecture/back-navigation.test.mjs && npm run test:back-hierarchy")
        behavior = scripts["test:back-hierarchy"]
        for required in ("back-hierarchy.contract.test.ts", "top-shell-back.test.ts", "android-back.test.ts", "app-edge-back-gesture.test.tsx", "pkm-natural-panel.test.tsx", "one-location-agent-page.test.tsx", "profile-pane.test.ts", "wallet-card-browser.test.tsx", "wallet-card-workspace.test.tsx"):
            self.assertIn(required, behavior)
        for forbidden in ("passWithNoTests", "||", "--exclude", "--testNamePattern", "--grep"):
            self.assertNotIn(forbidden, behavior)

    def test_skip_and_failure_suppression_are_rejected(self):
        for rule in ("if: false", "needs: [paths]", "continue-on-error: true"):
            with self.assertRaises(ValueError):
                validate(self.workflow.replace("  back-navigation-contracts:\n", f"  back-navigation-contracts:\n    {rule}\n"))
        with self.assertRaises(ValueError):
            validate(self.workflow.replace("- run: npm run verify:back-contracts", "- run: npm run verify:back-contracts || true"))

    def test_legacy_install_cannot_drop_the_dom_regression_dependencies(self):
        for weakened in ("npm ci --legacy-peer-deps", "npm ci --omit=dev"):
            with self.assertRaises(ValueError):
                validate(self.workflow.replace("npm ci --prefer-offline --no-audit --progress=false", weakened))

    def test_each_aggregate_gate_rejects_removed_dependency_and_skip_check(self):
        for name in ("preflight-gate", "ci-status"):
            gate = job_block(self.workflow, name)
            for weakened in (gate.replace("      - back-navigation-contracts\n", ""), gate.replace("needs['back-navigation-contracts'].result", "needs.other.result")):
                with self.assertRaises(ValueError):
                    validate(self.workflow.replace(gate, weakened))


if __name__ == "__main__":
    unittest.main()
