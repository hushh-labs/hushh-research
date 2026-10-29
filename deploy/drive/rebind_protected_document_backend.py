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


def restoration_mode(
    mode: dict, *, project: str, target: str, verify_previous: bool
) -> dict:
    """Retain custody metadata while selecting the exact non-reader recovery."""
    from runpy import run_path

    if project != "hushh-pda" or verify_previous:
        raise ValueError("Restoration requires its separately qualified baseline")
    root = Path(__file__).resolve().parents[2]
    run_path(str(root / "deploy/account-deletion/compatibility_restoration.py"))[
        "qualify_source"
    ](target)
    return {**mode, "stored_enabled": mode["enabled"], "enabled": False}

def unchanged_mode(observed: dict, expected: dict) -> dict:
    """Compare stored policy with an independently qualified effective receipt."""
    fields = {"configured", "enabled"}
    if (
        not isinstance(observed, dict)
        or not isinstance(expected, dict)
        or set(observed) != fields
        or set(expected) not in (fields, fields | {"stored_enabled"})
        or any(type(value) is not bool for value in (*observed.values(), *expected.values()))
        or (observed["enabled"] and not observed["configured"])
        or ("stored_enabled" in expected and expected["enabled"] is not False)
        or observed
        != {
            "configured": expected["configured"],
            "enabled": expected.get("stored_enabled", expected["enabled"]),
        }
    ):
        raise ValueError("Protected document mode changed after release qualification")
    return dict(expected)


def retained_worker_mode(
    observed: dict, *, target: str, stage_run: str = "", activation_run: str = "",
    cold_release: bool = False,
) -> dict:
    """Requalify the existing release origin before selecting its effective mode."""
    import sys

    if (
        type(cold_release) is not bool
        or sum(map(bool, (stage_run, activation_run, cold_release))) != 1
        or (not cold_release and not re.fullmatch(r"[1-9][0-9]*", stage_run or activation_run))
        or not re.fullmatch(r"[0-9a-f]{40}", target)
    ):
        raise ValueError("Retained document origin is invalid")
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/ci"))
    import production_backend_successor_control as control
    import production_backend_successor_proof as proof

    owner = control.authority()
    anchor = control.record_anchor(proof.read_original())
    if anchor is not None:
        control.live(anchor)
    ports = {
        "api": owner.api,
        "governed": owner.governed_dispatch,
        "timestamp": owner._github_timestamp,
        "run_command": owner.retention.run_command,
        "timeout": 60,
    }
    if cold_release:
        import production_worker_basis as basis

        if anchor is None:
            expected = basis.load(target)["protected_documents"]
        else:
            sealed = anchor["sealed_boundary"]
            if sealed["checkpoint"]["plan"]["primary_sha"] != target:
                raise ValueError("Retained document cold origin belongs to another source")
            expected = sealed["document_mode"]
    elif stage_run:
        import production_staged_worker as worker
        import production_worker_basis as basis

        arguments = (
            {} if anchor is not None else {"healthy_release_run_id": basis.current_release_run_id()}
        )
        selected = worker.load_worker(stage_run, anchor, **ports, **arguments)["context"]
        if selected["source"] != target:
            raise ValueError("Retained document worker belongs to another source")
        expected = (
            selected["basis"]["protected_documents"]
            if "basis" in selected
            else anchor["sealed_boundary"]["document_mode"]
        )
    else:
        import production_activation_continuation as continuation

        if anchor is None:
            raise ValueError("Retained document activation has no operational origin")
        selected = continuation.load_original(
            activation_run,
            target,
            repository=proof.REPOSITORY,
            operational_anchor=anchor,
            **ports,
        )
        expected = selected["protected_documents"]["mode"]
    return unchanged_mode(observed, expected)
