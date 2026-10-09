"""Protect the combined UI authority gate and its required regression owners."""
from pathlib import Path
import json
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


def job_block(workflow, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)
    if not match:
        raise ValueError(f"Missing job: {name}")
    return match.group(1)


def validate(workflow):
    ui = job_block(workflow, "ui-contracts")
    if "fetch-depth: 2" not in ui or "UI_CONTRACT_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}" not in ui:
        raise ValueError("UI review inheritance requires the pinned target base and its history")
    if "fetch-depth: 2" not in job_block(workflow, "web-core-check"):
        raise ValueError("Web Core must retain the target base for the same UI check")
    if re.search(r"^\s+(if|needs|continue-on-error):", ui, re.M):
        raise ValueError("UI contracts must run independently with failures enforced")
    if not re.search(r"^\s+- run: npm run verify:ui-contracts\s*$", ui, re.M):
        raise ValueError("Combined read-only verifier missing or failure suppressed")
    if not re.search(r"^\s+- run: npm ci --ignore-scripts --no-audit --progress=false\s*\n\s+working-directory: hushh-webapp/scripts/architecture/ui-contract-tools\s*$", ui, re.M):
        raise ValueError("Fast UI gate must use the isolated locked parser install")
    for name in ("preflight-gate", "ci-status"):
        gate = job_block(workflow, name)
        needs = re.search(r"^    needs:\n((?:      - [^\n]+\n)+)", gate, re.M)
        if not needs or "      - ui-contracts\n" not in needs.group(1):
            raise ValueError(f"UI not required by {name}")
        if 'needs[\'ui-contracts\'].result }}" != "success"' not in gate:
            raise ValueError(f"UI skips must fail {name}")
    status = job_block(workflow, "ci-status")
    for lane in ("WEB_CORE", "WEB_FULL_SUITE"):
        if f'[ "${lane}" != "success" ]' not in status:
            raise ValueError(f"Frontend changes must require {lane} regressions")


def validate_runner(source):
    for call in (r"verifyBackNavigation\(root,\s*false,\s*index\)", r"syncSearchContracts\(root,\s*true,\s*index\)"):
        if not re.search(call, source):
            raise ValueError("Both existing owners must execute in read-only mode")
    for verifier in ("generate-surface-map.mjs", "generate-kai-action-gateway.mjs", "verify-siri-action-contract.mjs", "generate-route-orchestration-index.mjs", "back-navigation.test.mjs", "search-contracts.test.mjs"):
        if verifier not in source:
            raise ValueError(f"Missing UI verifier: {verifier}")


class UiGateTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/ci.yml").read_text()

    def test_combined_gate_is_mandatory(self):
        validate(self.workflow)
        self.assertNotIn("  back-navigation-contracts:", self.workflow)
        self.assertNotIn("  search-web-contracts:", self.workflow)

    def test_skip_and_failure_suppression_are_rejected(self):
        for old, new in (("fetch-depth: 2", "fetch-depth: 1"), ("UI_CONTRACT_BASE_SHA:", "UNPINNED_BASE:")):
            with self.assertRaises(ValueError):
                validate(self.workflow.replace(old, new))
        for rule in ("if: false", "needs: [paths]", "continue-on-error: true"):
            with self.assertRaises(ValueError):
                validate(self.workflow.replace("  ui-contracts:\n", f"  ui-contracts:\n    {rule}\n"))
        with self.assertRaises(ValueError):
            validate(self.workflow.replace("npm run verify:ui-contracts", "npm run verify:ui-contracts || true"))

    def test_each_aggregate_rejects_removed_dependency_and_skip_check(self):
        for name in ("preflight-gate", "ci-status"):
            gate = job_block(self.workflow, name)
            for weakened in (gate.replace("      - ui-contracts\n", ""), gate.replace("needs['ui-contracts'].result", "needs.other.result")):
                with self.assertRaises(ValueError):
                    validate(self.workflow.replace(gate, weakened))

    def test_behavioral_owners_cannot_be_skipped(self):
        for lane in ("WEB_CORE", "WEB_FULL_SUITE"):
            with self.assertRaises(ValueError):
                validate(self.workflow.replace(f'[ "${lane}" != "success" ]', '[ "other" != "success" ]'))
        core = (ROOT / "scripts/ci/web-core-check.sh").read_text()
        self.assertIn("npm run verify:ui-contracts", core)
        self.assertIn("npm run test:ui-contract-validators", core)
        scripts = json.loads((ROOT / "hushh-webapp/package.json").read_text())["scripts"]
        self.assertEqual(scripts["verify:ui-contracts"], "node ./scripts/architecture/verify-ui-contracts.mjs")
        self.assertEqual(scripts["build:ui-contracts"], "npm run build:back-contracts && npm run build:search-contracts")
        self.assertIn("back-navigation.test.mjs", scripts["test:ui-contract-validators"])
        self.assertIn("search-contracts.test.mjs", scripts["test:ui-contract-validators"])
        self.assertEqual(scripts["verify:back-contracts"], "node ./scripts/architecture/verify-back-navigation.mjs && node --test ./scripts/architecture/back-navigation.test.mjs && npm run test:back-hierarchy")
        behavior = scripts["test:back-hierarchy"]
        for required in ("back-hierarchy.contract.test.ts", "top-shell-back.test.ts", "android-back.test.ts", "app-edge-back-gesture.test.tsx", "pkm-natural-panel.test.tsx", "one-location-agent-page.test.tsx", "profile-pane.test.ts", "wallet-card-browser.test.tsx", "wallet-card-workspace.test.tsx"):
            self.assertIn(required, behavior)
        for forbidden in ("passWithNoTests", "||", "--exclude", "--testNamePattern", "--grep"):
            self.assertNotIn(forbidden, behavior)

    def test_tooling_tracks_the_existing_parser_without_app_dependencies(self):
        web = json.loads((ROOT / "hushh-webapp/package-lock.json").read_text())
        tools_dir = ROOT / "hushh-webapp/scripts/architecture/ui-contract-tools"
        tools = json.loads((tools_dir / "package.json").read_text())
        lock = json.loads((tools_dir / "package-lock.json").read_text())
        parser = web["packages"]["node_modules/typescript"]
        self.assertEqual(tools["dependencies"], {"typescript": parser["version"]})
        self.assertEqual(set(lock["packages"]), {"", "node_modules/typescript"})
        self.assertEqual(lock["packages"]["node_modules/typescript"]["integrity"], parser["integrity"])

    def test_fast_runner_cannot_stamp_or_drop_existing_owners(self):
        source = (ROOT / "hushh-webapp/scripts/architecture/verify-ui-contracts.mjs").read_text()
        validate_runner(source)
        for old, new in (("verifyBackNavigation(root, false, index)", "verifyBackNavigation(root, true, index)"), ("syncSearchContracts(root, true, index)", "syncSearchContracts(root, false, index)"), ("generate-kai-action-gateway.mjs", "missing.mjs")):
            with self.assertRaises(ValueError):
                validate_runner(source.replace(old, new))


if __name__ == "__main__":
    unittest.main()
