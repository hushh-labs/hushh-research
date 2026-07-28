#!/usr/bin/env python3
"""Advisory gene/operon/organ fitness report for maintained source files.

This is the measurement stage of the bacterial-software ratchet. It reports
size, dependency-direction, and import-initialization risks but exits zero for
repository findings. Existing debt becomes blocking only after a clean,
reviewed baseline and a successful compatibility-preserving pilot exist.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[4]
CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".mjs", ".sh"}
EXCLUDED_PARTS = {
    ".next",
    ".venv",
    "__pycache__",
    "DerivedData",
    "node_modules",
}
MODULE_LINE_BUDGET = 500
CLASS_LINE_BUDGET = 250
FUNCTION_LINE_BUDGET = 80
TOP_LEVEL_RUNTIME_CALLS = {
    "Client",
    "configure",
    "create_client",
    "getenv",
    "load_dotenv",
}


@dataclass(frozen=True)
class Finding:
    kind: str
    path: str
    detail: str
    value: int | None = None
    limit: int | None = None
    symbol: str | None = None

    @property
    def key(self) -> str:
        return "|".join(
            [
                self.kind,
                self.path,
                self.symbol or "",
                self.detail,
            ]
        )


def _git_paths(*args: str) -> list[Path]:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [REPO_ROOT / line for line in result.stdout.splitlines() if line]


def maintained_code_paths() -> list[Path]:
    paths = _git_paths("ls-files") + _git_paths(
        "ls-files", "--others", "--exclude-standard"
    )
    unique: dict[str, Path] = {}
    for path in paths:
        if path.suffix not in CODE_EXTENSIONS or not path.exists():
            continue
        if any(part in EXCLUDED_PARTS for part in path.parts):
            continue
        unique[str(path)] = path
    return sorted(unique.values())


def _span(node: ast.AST) -> int:
    start = getattr(node, "lineno", 1)
    end = getattr(node, "end_lineno", start)
    return max(1, end - start + 1)


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _import_names(tree: ast.AST) -> Iterable[str]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            yield node.module


def _layer_violations(path: Path, imports: Iterable[str]) -> list[Finding]:
    rel = path.relative_to(REPO_ROOT).as_posix()
    findings: list[Finding] = []
    is_operon = "/hushh_mcp/operons/" in f"/{rel}"
    is_agent_tool = "/hushh_mcp/agents/" in f"/{rel}" and path.name == "tools.py"
    for imported in imports:
        normalized = imported.replace(".", "/")
        forbidden = None
        if is_operon and any(
            marker in normalized
            for marker in (
                "hushh_mcp/agents",
                "hushh_mcp/tools",
                "hushh_mcp/services",
                "db",
            )
        ):
            forbidden = "operon imports agent, tool, concrete service, or database code"
        elif is_agent_tool and any(
            marker in normalized
            for marker in ("hushh_mcp/services", "db")
        ):
            forbidden = "agent tool imports a concrete service or database module"
        if forbidden:
            findings.append(
                Finding(
                    kind="dependency_direction",
                    path=rel,
                    symbol=imported,
                    detail=forbidden,
                )
            )
    return findings


def analyze_python(path: Path, text: str) -> list[Finding]:
    rel = path.relative_to(REPO_ROOT).as_posix()
    try:
        tree = ast.parse(text, filename=rel)
    except SyntaxError as exc:
        return [
            Finding(
                kind="parse_error",
                path=rel,
                detail=f"cannot inspect Python AST: {exc.msg}",
                value=exc.lineno,
            )
        ]

    findings = _layer_violations(path, _import_names(tree))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            size = _span(node)
            if size > FUNCTION_LINE_BUDGET:
                findings.append(
                    Finding(
                        kind="function_size",
                        path=rel,
                        symbol=node.name,
                        detail="function exceeds the advisory gene budget",
                        value=size,
                        limit=FUNCTION_LINE_BUDGET,
                    )
                )
        elif isinstance(node, ast.ClassDef):
            size = _span(node)
            if size > CLASS_LINE_BUDGET:
                findings.append(
                    Finding(
                        kind="class_size",
                        path=rel,
                        symbol=node.name,
                        detail="class exceeds the advisory operon budget",
                        value=size,
                        limit=CLASS_LINE_BUDGET,
                    )
                )

    for node in tree.body:
        value = node.value if isinstance(node, (ast.Expr, ast.Assign, ast.AnnAssign)) else None
        if isinstance(value, ast.Call) and _call_name(value) in TOP_LEVEL_RUNTIME_CALLS:
            findings.append(
                Finding(
                    kind="import_initialization",
                    path=rel,
                    symbol=_call_name(value),
                    detail="top-level runtime initialization weakens import safety",
                    value=getattr(node, "lineno", None),
                )
            )
    return findings


def analyze_path(path: Path) -> list[Finding]:
    text = path.read_text(encoding="utf-8", errors="replace")
    rel = path.relative_to(REPO_ROOT).as_posix()
    findings: list[Finding] = []
    lines = len(text.splitlines())
    if lines > MODULE_LINE_BUDGET:
        findings.append(
            Finding(
                kind="module_size",
                path=rel,
                detail="module exceeds the advisory operon budget",
                value=lines,
                limit=MODULE_LINE_BUDGET,
            )
        )
    if path.suffix == ".py":
        findings.extend(analyze_python(path, text))
    return findings


def build_report(paths: Iterable[Path] | None = None) -> dict:
    inspected = list(paths if paths is not None else maintained_code_paths())
    findings = [finding for path in inspected for finding in analyze_path(path)]
    findings.sort(
        key=lambda item: (
            item.kind,
            -(item.value or 0),
            item.path,
            item.symbol or "",
        )
    )
    return {
        "status": "advisory",
        "doctrine": "docs/vision/bacterial-software-architecture.md",
        "budgets": {
            "module_lines": MODULE_LINE_BUDGET,
            "class_lines": CLASS_LINE_BUDGET,
            "function_lines": FUNCTION_LINE_BUDGET,
        },
        "inspected_files": len(inspected),
        "finding_count": len(findings),
        "findings": [asdict(finding) | {"key": finding.key} for finding in findings],
    }


def _rank(item: dict) -> tuple[float, str, str]:
    ratio = (
        (item.get("value") or 0) / max(item.get("limit") or 1, 1)
        if item.get("limit")
        else 0
    )
    return (-ratio, item.get("path", ""), item.get("symbol") or "")


def _representative_findings(findings: list[dict], limit: int) -> list[dict]:
    by_kind: dict[str, list[dict]] = {}
    for finding in findings:
        by_kind.setdefault(finding["kind"], []).append(finding)
    for items in by_kind.values():
        items.sort(key=_rank)

    selected: list[dict] = []
    while len(selected) < limit and any(by_kind.values()):
        for kind in sorted(by_kind):
            if by_kind[kind] and len(selected) < limit:
                selected.append(by_kind[kind].pop(0))
    return selected


def ratchet_regressions(current: dict, baseline: dict) -> list[dict]:
    baseline_findings = {
        item["key"]: item for item in baseline.get("findings", [])
    }
    regressions = []
    for item in current.get("findings", []):
        previous = baseline_findings.get(item["key"])
        if previous is None:
            regressions.append(item | {"ratchet_reason": "new finding"})
            continue
        current_value = item.get("value")
        previous_value = previous.get("value")
        if (
            isinstance(current_value, int)
            and isinstance(previous_value, int)
            and current_value > previous_value
        ):
            regressions.append(item | {"ratchet_reason": "finding worsened"})
    return regressions


def render_text(report: dict, limit: int) -> str:
    lines = [
        "Bacterial architecture fitness",
        f"Status: {report['status']}",
        f"Inspected files: {report['inspected_files']}",
        f"Advisory findings: {report['finding_count']}",
        "Budgets: "
        f"module={report['budgets']['module_lines']}, "
        f"class={report['budgets']['class_lines']}, "
        f"function={report['budgets']['function_lines']}",
    ]
    selected = _representative_findings(report["findings"], limit)
    for finding in selected:
        symbol = f"::{finding['symbol']}" if finding["symbol"] else ""
        metric = (
            f" ({finding['value']}>{finding['limit']})"
            if finding["value"] is not None and finding["limit"] is not None
            else ""
        )
        lines.append(
            f"- {finding['kind']}: {finding['path']}{symbol}{metric} — {finding['detail']}"
        )
    if report["finding_count"] > len(selected):
        lines.append(f"- … {report['finding_count'] - len(selected)} more advisory findings")
    return "\n".join(lines)


def self_test() -> int:
    fixture = """
from hushh_mcp.services.example import ExampleService

client = Client()

def oversized():
    pass
"""
    tree = ast.parse(fixture)
    imports = list(_import_names(tree))
    if imports != ["hushh_mcp.services.example"]:
        print("architecture fitness self-test failed: import parsing", file=sys.stderr)
        return 1
    calls = [
        _call_name(node.value)
        for node in tree.body
        if isinstance(node, (ast.Expr, ast.Assign)) and isinstance(node.value, ast.Call)
    ]
    if calls != ["Client"]:
        print("architecture fitness self-test failed: import initialization", file=sys.stderr)
        return 1
    baseline = {
        "findings": [
            {
                "key": "module_size|a.py||module exceeds the advisory operon budget",
                "value": 600,
            }
        ]
    }
    current = {
        "findings": [
            {
                "key": "module_size|a.py||module exceeds the advisory operon budget",
                "value": 601,
            }
        ]
    }
    if len(ratchet_regressions(current, baseline)) != 1:
        print("architecture fitness self-test failed: ratchet comparison", file=sys.stderr)
        return 1
    print("Architecture fitness self-test passed")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit stable JSON")
    parser.add_argument("--limit", type=int, default=20, help="text finding limit")
    parser.add_argument(
        "--baseline",
        type=Path,
        help="fail on new or worsened findings relative to a reviewed JSON report",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    report = build_report()
    if args.baseline:
        baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        regressions = ratchet_regressions(report, baseline)
        report["status"] = "regressed" if regressions else "ratchet-pass"
        report["regression_count"] = len(regressions)
        report["regressions"] = regressions
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_text(report, max(0, args.limit)))
    return 1 if report["status"] == "regressed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
