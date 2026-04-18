#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import json
import subprocess
from collections import Counter
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_LOCK = REPO_ROOT / "hushh-webapp" / "package-lock.json"
ROOT_NOTICES = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
PROTOCOL_NOTICES = REPO_ROOT / "consent-protocol" / "THIRD_PARTY_NOTICES.md"


def load_web_packages() -> list[dict[str, str]]:
    payload = json.loads(WEB_LOCK.read_text(encoding="utf-8"))
    packages = []
    for package_path, meta in (payload.get("packages") or {}).items():
        if not package_path:
            continue
        name = meta.get("name") or package_path.replace("node_modules/", "")
        license_name = meta.get("license") or "UNKNOWN"
        version = meta.get("version") or "UNKNOWN"
        packages.append({"name": name, "version": version, "license": license_name})
    packages.sort(key=lambda item: item["name"].lower())
    return packages


def load_python_packages() -> list[dict[str, str]]:
    result = subprocess.run(
        ["uv", "run", "--directory", "consent-protocol", "pip-licenses", "--format=json", "--from=mixed"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    packages = [
        {
            "name": item.get("Name", "UNKNOWN"),
            "version": item.get("Version", "UNKNOWN"),
            "license": item.get("License", "UNKNOWN"),
        }
        for item in payload
    ]
    packages.sort(key=lambda item: item["name"].lower())
    return packages


def render_summary(packages: list[dict[str, str]]) -> str:
    counts = Counter(item["license"] for item in packages)
    lines = []
    for license_name, count in sorted(counts.items(), key=lambda item: (item[0].lower(), item[1])):
        lines.append(f"- `{license_name}`: {count}")
    return "\n".join(lines)


def render_package_list(packages: list[dict[str, str]]) -> str:
    return "\n".join(
        f"- `{item['name']}` `{item['version']}` — {item['license']}" for item in packages
    )


def write_markdown(path: Path, title: str, intro: str, sections: list[tuple[str, list[dict[str, str]]]]) -> None:
    lines = [
        f"# {title}",
        "",
        intro,
        "",
        "This file is generated from the repo lockfiles and installed Python environment.",
        "Regenerate it with `python3 scripts/licenses/generate_third_party_notices.py`.",
        "",
    ]

    for heading, packages in sections:
        lines.extend(
            [
                f"## {heading}",
                "",
                f"Package count: {len(packages)}",
                "",
                "### License summary",
                "",
                render_summary(packages),
                "",
                "### Package inventory",
                "",
                render_package_list(packages),
                "",
            ]
        )

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    web_packages = load_web_packages()
    python_packages = load_python_packages()

    write_markdown(
        ROOT_NOTICES,
        "Third-Party Notices",
        "Third-party dependency inventory for the hushh-research monorepo.",
        [
            ("Frontend npm packages", web_packages),
            ("Backend Python packages", python_packages),
        ],
    )

    write_markdown(
        PROTOCOL_NOTICES,
        "Third-Party Notices",
        "Third-party dependency inventory for the Hushh Consent Protocol.",
        [("Python packages", python_packages)],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
