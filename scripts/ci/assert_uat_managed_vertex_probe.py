#!/usr/bin/env python3
"""Decide a cross-project UAT Vertex receipt from the current candidate execution.

The caller already verified the exact candidate image and Azure's live 200
response. Only explicit provider resource exhaustion may leave Vertex unverified
for the UAT Drive Azure rollout; all other failed probes remain release blockers.
"""

from __future__ import annotations

import json
import os


def evaluate(environ: dict[str, str]) -> str:
    try:
        verdict = json.loads(
            environ["PROBE_LINE"].split("managed_vertex_probe_result", 1)[1].strip()
        )
    except (KeyError, IndexError, json.JSONDecodeError):
        raise ValueError("Required UAT runtime probe verdict is missing") from None
    if not isinstance(verdict, dict):
        raise ValueError("Required UAT runtime probe verdict is invalid")

    probes = verdict.get("probes")
    if (
        not environ.get("EXPECTED_CONFIG_HASH")
        or verdict.get("config_hash") != environ["EXPECTED_CONFIG_HASH"]
        or verdict.get("one_chat_project") != environ["EXPECTED_CHAT_PROJECT"]
        or verdict.get("check") != "managed_vertex_runtime"
        or not isinstance(probes, list)
        or not probes
        or any(not isinstance(probe, dict) for probe in probes)
    ):
        raise ValueError("Required UAT runtime probe has an invalid profile or receipt")
    voice_enabled = environ["VOICE_ENABLED"] == "true"
    if voice_enabled and (
        verdict.get("one_voice_project") != environ["EXPECTED_CHAT_PROJECT"]
        or verdict.get("live_model") != environ["EXPECTED_VOICE_MODEL"]
        or verdict.get("live_location") != environ["EXPECTED_VOICE_LOCATION"]
    ):
        raise ValueError("One voice Vertex target does not match deployment")

    healthy = (
        environ["EXECUTE_STATUS"] == "0"
        and verdict.get("ok") is True
        and verdict.get("classification") == "dependency_ok"
        and verdict.get("candidate_models_exercised") is True
        and verdict.get("drive_document_requests_probe_ok") is True
        and (not voice_enabled or verdict.get("one_voice_probe_ok") is True)
        and all(probe.get("ok") is True and probe.get("classification") == "dependency_ok"
                for probe in probes)
    )
    if healthy:
        return "healthy"

    failed = [probe for probe in probes if probe.get("ok") is False]
    chat = [probe for probe in probes if str(probe.get("probe", "")).startswith("drive_document_requests:")]
    voice = [probe for probe in probes if str(probe.get("probe", "")).startswith("one_voice_live:")]
    exhausted = (
        environ["AZURE_UAT_RESOURCE_EXHAUSTION"] == "true"
        and environ["EXECUTE_STATUS"] != "0"
        and verdict.get("ok") is False
        and verdict.get("classification") == "provider_unavailable"
        and verdict.get("candidate_models_exercised") is False
        and len(chat) == 1
        and verdict.get("drive_document_requests_probe_ok") is chat[0].get("ok")
        and (not voice_enabled or (
            len(voice) == 1 and verdict.get("one_voice_probe_ok") is voice[0].get("ok")
        ))
        and bool(failed)
        and all(
            (probe.get("ok") is True and probe.get("classification") == "dependency_ok")
            or (probe.get("ok") is False
                and probe.get("classification") == "provider_unavailable"
                and probe.get("resource_exhausted") is True)
            for probe in probes
        )
    )
    if exhausted:
        return "resource_exhausted"
    raise ValueError("Required UAT runtime probe did not fully pass")


if __name__ == "__main__":
    try:
        print(evaluate(dict(os.environ)))
    except ValueError as error:
        raise SystemExit(str(error)) from None
