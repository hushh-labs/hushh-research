#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_LOCK = REPO_ROOT / "hushh-webapp" / "package-lock.json"
ROOT_NOTICES = REPO_ROOT / "THIRD_PARTY_NOTICES.md"
PROTOCOL_NOTICES = REPO_ROOT / "consent-protocol" / "THIRD_PARTY_NOTICES.md"

# Reviewed installed release license files, 2026-09-06. These are evidence pins,
# not license overrides: absent/changed files or versions remain UNKNOWN.
# Hash raw bytes (limiter's license uses CRLF).
REVIEWED_LICENSE_FILES = {
    ("khroma", "2.1.0"): (
        "license",
        "MIT",
        "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49",
    ),
    ("limiter", "1.1.5"): (
        "LICENSE.txt",
        "MIT",
        "a3aebd11ea5598ef12949bf793311bf155ab7727181e3d373bd0b47813d41111",
    ),
    ("google-crc32c", "1.8.0"): (
        "LICENSE",
        "Apache-2.0",
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    ),
    ("peewee", "4.0.4"): (
        "LICENSE",
        "MIT",
        "3740096125b08735a247b8dd08cd82e0ba984d3bebd9221d378576637e5240da",
    ),
}

# Exact published SDK payload matched to google/A2UI release source. This is
# repository-reviewed evidence, not an upstream metadata declaration. The root
# license's MIT appendix applies to eval/bin/transcrypt, outside this payload.
REVIEWED_SOURCE_DISTRIBUTIONS = {
    ("a2ui-agent-sdk", "0.2.4"): {
        "package": "a2ui",
        "license": "Apache-2.0",
        "source": "https://github.com/google/A2UI/tree/8e4b5c0bb1b4d29cb5a5b55f331ed52c4fdca40e/agent_sdks/python",
        "sdist_sha256": "6c92363ca028e5c75a541f913e4bb1e6aef0c217e5c7dc693bb12712069b1e23",
        "license_file": "scripts/licenses/evidence/a2ui-agent-sdk-0.2.4.LICENSE",
        "license_sha256": "8c8b5b632d56c4c1658296963c693db5396772a33caaddb9a22593c4155c437a",
        "payload_count": 38,
        "payload_sha256": "d9b34138c7ea8e6d7d2f9e97f16fcfb9e241453fe4364c0a96121232ec236ac1",
    },
}


def normalized_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def reviewed_license(name: str, version: str, path: Path) -> str:
    review = REVIEWED_LICENSE_FILES.get((normalized_name(name), version))
    if review is None or path.name != review[0]:
        return "UNKNOWN"
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return "UNKNOWN"
    return review[1] if digest == review[2] else "UNKNOWN"


def installed_web_license(package_path: str, name: str, version: str) -> str:
    review = REVIEWED_LICENSE_FILES.get((normalized_name(name), version))
    if review is None:
        return "UNKNOWN"
    directory = WEB_LOCK.parent / package_path
    try:
        meta = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "UNKNOWN"
    if (
        not isinstance(meta, dict)
        or meta.get("name") != name
        or meta.get("version") != version
    ):
        return "UNKNOWN"
    declarations = [meta.get("license")] if meta.get("license") else []
    legacy = meta.get("licenses", [])
    if not isinstance(legacy, list) or any(
        not isinstance(item, dict) for item in legacy
    ):
        return "UNKNOWN"
    declarations.extend(item.get("type") for item in legacy)
    if any(value != review[1] for value in declarations):
        return "UNKNOWN"
    return reviewed_license(name, version, directory / review[0])


def source_distribution_license(distribution, review: dict) -> str:
    """Fail closed unless the installed package and reviewed license match exactly."""
    try:
        license_bytes = (REPO_ROOT / review["license_file"]).read_bytes()
        if hashlib.sha256(license_bytes).hexdigest() != review["license_sha256"]:
            return "UNKNOWN"
        root = Path(distribution.locate_file(review["package"]))
        if root.is_symlink() or not root.is_dir():
            return "UNKNOWN"
        entries = list(root.rglob("*"))
        if any(path.is_symlink() for path in entries):
            return "UNKNOWN"
        files = sorted(
            (
                path
                for path in entries
                if path.is_file()
                and "__pycache__" not in path.parts
                and path.suffix != ".pyc"
            ),
            key=lambda path: path.relative_to(root).as_posix(),
        )
        if len(files) != review["payload_count"]:
            return "UNKNOWN"
        manifest = "".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}\n"
            for path in files
        )
        if (
            hashlib.sha256(manifest.encode("utf-8")).hexdigest()
            != review["payload_sha256"]
        ):
            return "UNKNOWN"
    except OSError:
        return "UNKNOWN"
    return review["license"]


def python_license_evidence() -> list[dict[str, str]]:
    """Read distribution metadata in uv's environment, without importing dependencies."""
    evidence = []
    for (name, version), review in REVIEWED_LICENSE_FILES.items():
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
        metadata = distribution.metadata
        if (
            normalized_name(metadata.get("Name", "")) != name
            or distribution.version != version
        ):
            continue
        declarations = [metadata.get("License-Expression"), metadata.get("License")]
        if any(value and value not in ("UNKNOWN", review[1]) for value in declarations):
            continue
        if review[0] not in (metadata.get_all("License-File") or []):
            continue
        files = distribution.files or []
        candidates = [
            distribution.locate_file(item)
            for item in files
            if str(item).endswith(
                (f".dist-info/licenses/{review[0]}", f".dist-info/{review[0]}")
            )
        ]
        if len(candidates) != 1:
            continue
        license_name = reviewed_license(name, version, Path(candidates[0]))
        if license_name != "UNKNOWN":
            evidence.append({"name": name, "version": version, "license": license_name})
    for (name, version), review in REVIEWED_SOURCE_DISTRIBUTIONS.items():
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
        metadata = distribution.metadata
        if (
            normalized_name(metadata.get("Name", "")) != name
            or distribution.version != version
        ):
            continue
        if any(
            metadata.get(key)
            and metadata.get(key) not in ("UNKNOWN", review["license"])
            for key in ("License-Expression", "License")
        ):
            continue
        license_name = source_distribution_license(distribution, review)
        if license_name != "UNKNOWN":
            evidence.append({"name": name, "version": version, "license": license_name})
    return evidence


def load_web_packages() -> list[dict[str, str]]:
    payload = json.loads(WEB_LOCK.read_text(encoding="utf-8"))
    packages = []
    for package_path, meta in (payload.get("packages") or {}).items():
        if not package_path:
            continue
        name = meta.get("name") or package_path.replace("node_modules/", "")
        license_name = meta.get("license") or "UNKNOWN"
        version = meta.get("version") or "UNKNOWN"
        if license_name == "UNKNOWN":
            license_name = installed_web_license(package_path, name, version)
        packages.append({"name": name, "version": version, "license": license_name})
    packages.sort(key=lambda item: item["name"].lower())
    return packages


def load_vendored_packages() -> list[dict[str, str]]:
    inventory = (
        REPO_ROOT
        / ".codex/skills/agent-orchestration-governance/references/platform-source-inventory.json"
    )
    imports = json.loads(inventory.read_text(encoding="utf-8")).get("imports", {})
    return [
        {
            "name": name,
            "version": item.get("declared_version", "UNKNOWN"),
            "license": item.get("license", "UNVERIFIED"),
            "license_file": item.get("license_file", ""),
            "notice_file": item.get("notice_file", ""),
        }
        for name, item in sorted(imports.items())
    ]


def load_python_packages() -> list[dict[str, str]]:
    result = subprocess.run(
        [
            "uv",
            "run",
            "--directory",
            "consent-protocol",
            "pip-licenses",
            "--format=json",
            "--from=mixed",
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    evidence_result = subprocess.run(
        [
            "uv",
            "run",
            "--directory",
            "consent-protocol",
            "python",
            "../scripts/licenses/generate_third_party_notices.py",
            "--python-license-evidence",
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    evidence = {
        (item["name"], item["version"]): item["license"]
        for item in json.loads(evidence_result.stdout)
    }
    packages = [
        {
            "name": item.get("Name", "UNKNOWN"),
            "version": item.get("Version", "UNKNOWN"),
            "license": item.get("License", "UNKNOWN"),
        }
        for item in payload
    ]
    for package in packages:
        if package["license"] == "UNKNOWN":
            package["license"] = evidence.get(
                (normalized_name(package["name"]), package["version"]), "UNKNOWN"
            )
    packages.sort(key=lambda item: item["name"].lower())
    return packages


def render_summary(packages: list[dict[str, str]]) -> str:
    counts = Counter(item["license"] for item in packages)
    lines = []
    for license_name, count in sorted(
        counts.items(), key=lambda item: (item[0].lower(), item[1])
    ):
        lines.append(f"- `{license_name}`: {count}")
    return "\n".join(lines)


def render_package_list(packages: list[dict[str, str]]) -> str:
    lines = []
    for item in packages:
        line = f"- `{item['name']}` `{item['version']}` — {item['license']}"
        for field, label in (
            ("license_file", "License"),
            ("notice_file", "Upstream notice"),
        ):
            if item.get(field):
                line += f"; [{label}]({item[field]})"
        lines.append(line)
    return "\n".join(lines)


def write_markdown(
    path: Path, title: str, intro: str, sections: list[tuple[str, list[dict[str, str]]]]
) -> None:
    lines = [
        f"# {title}",
        "",
        intro,
        "",
        "This file is generated from repo lockfiles, exact-version installed license evidence, the installed Python environment, and the governed imported-resource inventory.",
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
            ("Vendored engineering resources", load_vendored_packages()),
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
    if sys.argv[1:] == ["--python-license-evidence"]:
        print(json.dumps(python_license_evidence()))
        raise SystemExit(0)
    raise SystemExit(main())
