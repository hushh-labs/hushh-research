# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bind one phone-qualified backend to the existing document rollback report."""

from __future__ import annotations

import json
import re
import tempfile
from collections.abc import Callable
from pathlib import Path


def rebind_backend(
    report_path: Path,
    qualification_path: Path,
    *,
    project: str,
    ancestor: str,
    cloud: Callable[..., str],
    revision_source: Callable[[dict], dict],
    reader_supported: Callable[[str, str], bool],
) -> None:
    """Recheck immutable cloud identity; never extend bootstrap exemptions."""
    report = json.loads(report_path.read_text())
    qualified = json.loads(qualification_path.read_text())
    if not isinstance(report, dict) or not isinstance(qualified, dict):
        raise ValueError("Document backend binding evidence is invalid")
    previous = report.get("previous")
    if (
        project != "hushh-pda"
        or report.get("project") != project
        or report.get("configured") is not True
        or not re.fullmatch(r"[0-9a-f]{40}", ancestor)
        or report.get("readerAncestor") != ancestor
        or not isinstance(previous, dict)
        or not isinstance(previous.get("consent-protocol"), dict)
        or type(qualified.get("schema_version")) is not int
        or qualified.get("schema_version") != 1
        or qualified.get("qualification") != "passed"
        or qualified.get("project") != project
        or qualified.get("region") != "us-central1"
    ):
        raise ValueError("Document backend binding evidence does not match")
    revision = qualified.get("revision")
    source = qualified.get("source")
    image = qualified.get("image")
    if (
        not isinstance(revision, str)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", revision)
        or not isinstance(source, str)
        or not re.fullmatch(r"[0-9a-f]{40}", source)
        or not isinstance(image, str)
        or not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image)
    ):
        raise ValueError("Document backend revision identity is invalid")
    actual = json.loads(
        cloud(
            "run",
            "revisions",
            "describe",
            revision,
            f"--project={project}",
            "--region=us-central1",
            "--format=json",
        )
    )
    metadata = actual.get("metadata") or {}
    if (
        metadata.get("name") != revision
        or metadata.get("labels", {}).get("serving.knative.dev/service")
        != "consent-protocol"
        or revision_source(actual) != {"sha": source, "image": image}
        or not reader_supported(source, ancestor)
    ):
        raise ValueError("Document backend revision compatibility was not proved")
    report["previous"] = {
        **previous,
        "consent-protocol": {
            "revision": revision,
            "sha": source,
            "image": image,
            "readerCompatible": True,
        },
    }
    _replace_report(report_path, report)


def _replace_report(report_path: Path, report: dict) -> None:
    """Keep the previous receipt intact if serialization or replacement fails."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=report_path.parent,
            prefix=report_path.name + ".",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            json.dump(report, output, indent=2, sort_keys=True)
            output.write("\n")
        temporary.replace(report_path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
