#!/usr/bin/env python3
"""Run the functional Chromium half of an already-selected browser pack.

Pack/path ownership stays in web-targeted-check.sh. Historical npm commands keep
all engines and presentation checks for explicit diagnostics.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "hushh-webapp"
# Named presentation contracts, not a permissive exclusion of failing behavior.
PRESENTATION = (
    r"@motion-performance|100 KB paste|provider icons share the Google scale|"
    r"welcome starters keep foreground text|starter suggestions retain compact spacing|"
    r"pointerdown grows a clipped ripple|wallet workspace.*(?:geometry|typography)|"
    r"the agent mark stays visible in the header"
)
SUPPORTED_PROJECTS = {"chromium", "mobile-chrome"}
KNOWN_PROJECTS = {*SUPPORTED_PROJECTS, "webkit", "firefox"}



def commands(body: str) -> list[list[str]]:
    lexer = shlex.shlex(body, posix=True, punctuation_chars=";&")
    lexer.whitespace_split = True
    result: list[list[str]] = [[]]
    for token in lexer:
        if token == "&&":
            result.append([])
        elif token in {";", "&", "||"}:
            raise ValueError("Unrecognized browser pack command")
        else:
            result[-1].append(token)
    return [row for row in result if row]


def plan(script: str, scripts: dict[str, str], layout_specs: list[str]) -> list[list[str]]:
    """Normalize existing pack commands; keep action filters and core exclusions."""
    seen: set[tuple[str, ...]] = set()
    result: list[list[str]] = []
    for row in commands(scripts[script]):
        if "playwright" not in row:
            # The broad pack's generated visual-fixture freshness is a local
            # development check. Functional fixtures construct their own runtime.
            if row[-2:] == ["run", "verify:people-layout-fixture"]:
                continue
            raise ValueError(f"Unsupported browser command in {script}")
        index = row.index("playwright")
        if row[index + 1:index + 2] != ["test"]:
            raise ValueError("Only Playwright test execution is admitted")
        args = row[index + 2:]
        specs, options = [], []
        projects: list[str] = []
        invert = [PRESENTATION]
        i = 0
        while i < len(args):
            token = args[i]
            if token.startswith("e2e/"):
                specs.append(token)
            elif token.startswith("--project="):
                project = token.split("=", 1)[1]
                if project not in KNOWN_PROJECTS:
                    raise ValueError(f"Unrecognized browser project: {project}")
                if project not in projects:
                    projects.append(project)
            elif token == "--project":
                i += 1
                project = args[i]
                if project not in KNOWN_PROJECTS:
                    raise ValueError(f"Unrecognized browser project: {project}")
                if project not in projects:
                    projects.append(project)
            elif token == "--grep-invert":
                i += 1
                if args[i] != "100 KB paste":
                    invert.append(args[i])
            else:
                options.append(token)
            i += 1
        if not projects:
            projects = ["chromium"]
        if script == "test:layout-contracts" and layout_specs:
            specs = [name for name in layout_specs if name in specs]
        if not specs:
            continue
        for name in specs:
            if not name.startswith("e2e/") or not (WEB / name).is_file():
                raise ValueError(f"Unresolved browser contract: {name}")
        for project in projects:
            if project not in SUPPORTED_PROJECTS:
                continue
            unique = []
            filters = (project, *options, *invert)
            for name in specs:
                identity = (name, *filters)
                if identity not in seen:
                    seen.add(identity)
                    unique.append(name)
            if unique:
                result.append([*unique, f"--project={project}", *options,
                               "--grep-invert", "|".join(f"(?:{part})" for part in invert)])
    if not result:
        raise ValueError(f"No functional browser commands resolved for {script}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("script")
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    scripts = json.loads((WEB / "package.json").read_text())["scripts"]
    level = os.environ.get("CI_VALIDATION_LEVEL", "diagnostic")
    if level not in {"focused", "release"}:
        raise ValueError("Functional runner requires an explicit validation level")
    specs = os.environ.get("WEB_TARGETED_LAYOUT_SPECS", "").split()
    selected = plan(args.script, scripts, specs)
    if args.plan:
        print(json.dumps(selected))
        return 0
    env = {**os.environ, "CI": "1"}
    for row in commands(scripts[args.script]):
        for token in row:
            if token.startswith("PLAYWRIGHT_START_SERVER="):
                env["PLAYWRIGHT_START_SERVER"] = token.split("=", 1)[1]
    if args.script == "test:layout-contracts" and any(
        "e2e/one-location-people-rows.layout.spec.ts" in row for row in selected
    ):
        prepared = subprocess.run(["npm", "run", "verify:people-layout-fixture"],
                                  cwd=WEB, env=env, check=False)
        if prepared.returncode:
            return prepared.returncode
    for command in selected:
        print("Functional browser:", shlex.join(command), flush=True)
        proc = subprocess.run([str(WEB / "node_modules/.bin/playwright"), "test", *command],
                              cwd=WEB, env=env, check=False)
        if proc.returncode:
            return proc.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
