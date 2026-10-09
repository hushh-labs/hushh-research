"""Protect the mandatory Search CI boundary using only Python's standard library."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


def job_block(workflow, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [\w-]+:|\Z)", workflow, re.M | re.S)
    if not match:
        raise ValueError(f"Missing job: {name}")
    return match.group(1)


def validate(workflow):
    search = job_block(workflow, "search-web-contracts")
    if re.search(r"^\s+(if|needs|continue-on-error):", search, re.M):
        raise ValueError("Search must run independently with failures enforced")
    if not re.search(r"^\s+- run: npm run verify:search-contracts\s*$", search, re.M):
        raise ValueError("Search verifier missing or failure suppressed")
    gate = job_block(workflow, "ci-status")
    needs = re.search(r"^    needs:\n((?:      - [^\n]+\n)+)", gate, re.M)
    if not needs or "      - search-web-contracts\n" not in needs.group(1):
        raise ValueError("Search not required by aggregate gate")
    if 'needs[\'search-web-contracts\'].result }}" != "success"' not in gate:
        raise ValueError("Search skips must fail the aggregate gate")


class SearchGateTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/ci.yml").read_text()

    def test_required_search_runs(self):
        validate(self.workflow)

    def test_path_filter_dependency_and_ignored_failures_cannot_skip_search(self):
        for rule in ("if: false", "needs: [paths]", "continue-on-error: true"):
            broken = self.workflow.replace("  search-web-contracts:\n", f"  search-web-contracts:\n    {rule}\n")
            with self.assertRaises(ValueError):
                validate(broken)
        broken = self.workflow.replace("- run: npm run verify:search-contracts", "- run: npm run verify:search-contracts || true")
        with self.assertRaises(ValueError):
            validate(broken)
        broken = self.workflow.replace("      - run: npm run verify:search-contracts", "      - if: false\n        run: npm run verify:search-contracts")
        with self.assertRaises(ValueError):
            validate(broken)

    def test_removed_requirement_and_skip_rejection_fail(self):
        gate = job_block(self.workflow, "ci-status")
        broken = self.workflow.replace(gate, gate.replace("      - search-web-contracts\n", ""))
        with self.assertRaises(ValueError):
            validate(broken)
        broken = self.workflow.replace(gate, gate.replace("needs['search-web-contracts'].result", "needs.other.result"))
        with self.assertRaises(ValueError):
            validate(broken)


if __name__ == "__main__":
    unittest.main()
