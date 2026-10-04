#!/usr/bin/env python3
"""Focused production Places release-gate checks."""

from __future__ import annotations

import importlib.util
import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


def _module():
    path = Path(__file__).with_name("verify-prod-places-readiness.py")
    spec = importlib.util.spec_from_file_location("prod_places_readiness", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_disabled_api_fails_before_key_access() -> None:
    module = _module()
    calls: list[tuple[str, ...]] = []

    def gcloud(*args: str) -> str:
        calls.append(args)
        return "maps-backend.googleapis.com\n"

    with (
        patch.object(module, "_gcloud", side_effect=gcloud),
        patch.object(module.subprocess, "run") as curl,
    ):
        output = io.StringIO()
        with redirect_stderr(output):
            assert module.main(["--project", "hushh-pda"]) == 1
        curl.assert_not_called()
    assert len(calls) == 1
    assert "places.googleapis.com" in output.getvalue()


def test_rejected_backend_key_fails_without_logging_key() -> None:
    module = _module()
    key = "test-sensitive-backend-key"
    with (
        patch.object(
            module,
            "_gcloud",
            side_effect=[
                "places.googleapis.com\nmaps-backend.googleapis.com\n",
                key,
            ],
        ),
        patch.object(
            module.subprocess,
            "run",
            return_value=CompletedProcess([], 0, '{"error":"rejected"}\n403', ""),
        ),
    ):
        output = io.StringIO()
        with redirect_stderr(output):
            assert module.main(["--project", "hushh-pda"]) == 1
    assert "HTTP 403" in output.getvalue()
    assert key not in output.getvalue()


def test_key_probe_accepts_real_place_shape() -> None:
    module = _module()
    with (
        patch.object(
            module,
            "_gcloud",
            side_effect=[
                "places.googleapis.com\nmaps-backend.googleapis.com\n",
                "test-backend-key",
            ],
        ),
        patch.object(
            module.subprocess,
            "run",
            return_value=CompletedProcess(
                [], 0, '{"places":[{"id":"ChIJ123"}]}\n200', ""
            ),
        ) as curl,
    ):
        output = io.StringIO()
        with redirect_stdout(output):
            assert module.main(["--project", "hushh-pda"]) == 0
    probe_args = curl.call_args.args[0]
    assert "test-backend-key" not in " ".join(probe_args)
    assert "test-backend-key" in curl.call_args.kwargs["input"]
    assert "test-backend-key" not in output.getvalue()


def test_production_workflow_keeps_feature_rollback_available() -> None:
    workflow = (
        Path(__file__).resolve().parents[2] / ".github/workflows/deploy-production.yml"
    ).read_text(encoding="utf-8")
    assert (
        "if: steps.scope.outputs.deploy_backend == 'true' && vars.ONE_PLACES_DIRECTORY_ENABLED_PROD != 'false'"
        in workflow
    )
    assert (
        "--one-places-directory-enabled \"${{ vars.ONE_PLACES_DIRECTORY_ENABLED_PROD || 'true' }}\""
        in workflow
    )
    assert (
        "--consent-center-summary-v2-enabled \"${{ vars.CONSENT_CENTER_SUMMARY_V2_ENABLED || 'true' }}\""
        in workflow
    )


def main() -> int:
    for test in (
        test_disabled_api_fails_before_key_access,
        test_rejected_backend_key_fails_without_logging_key,
        test_key_probe_accepts_real_place_shape,
        test_production_workflow_keeps_feature_rollback_available,
    ):
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
