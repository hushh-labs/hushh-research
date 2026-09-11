#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


_SPEC = importlib.util.spec_from_file_location(
    "verify_one_voice_local_runtime_readiness",
    Path(__file__).with_name("verify-one-voice-local-runtime-readiness.py"),
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError("cannot load verify-one-voice-local-runtime-readiness.py")
subject = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = subject
_SPEC.loader.exec_module(subject)


SHA = "a" * 40


def pack(*, runtime: str, task: str, **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "pack_id": f"one-voice-{task}",
        "runtime": runtime,
        "tasks": [task],
        "source_sha": SHA,
        "catalog_version": "agent-manifest-v2-1",
        "checksum": "b" * 64,
        "artifact_url": "https://models.example.test/pack?X-Goog-Expires=900&X-Goog-Signature=test",
    }
    value.update(overrides)
    return value


class VerifyOneVoiceLocalRuntimeReadinessTests(unittest.TestCase):
    def payload(self) -> dict[str, object]:
        return {
            "available_packs": [
                pack(runtime="sherpa_onnx_web", task="stt"),
                pack(runtime="onnxruntime_web", task="intent"),
            ]
        }

    def test_accepts_matching_asr_and_ranker_packs(self) -> None:
        result = subject.verify_capability(self.payload(), SHA)
        self.assertEqual(result["source_sha"], SHA)
        self.assertEqual(result["catalog_version"], "agent-manifest-v2-1")

    def test_rejects_stale_or_missing_required_pack(self) -> None:
        with self.assertRaisesRegex(subject.LocalRuntimeReadinessError, "does not match"):
            subject.verify_capability(
                {"available_packs": [pack(runtime="sherpa_onnx_web", task="stt", source_sha="c" * 40), pack(runtime="onnxruntime_web", task="intent")]},
                SHA,
            )
        with self.assertRaisesRegex(subject.LocalRuntimeReadinessError, "lacks"):
            subject.verify_capability(
                {"available_packs": [pack(runtime="sherpa_onnx_web", task="stt")]}, SHA
            )

    def test_rejects_registry_metadata_and_catalog_drift(self) -> None:
        leaking = self.payload()
        leaking["bucket"] = "private-model-bucket"
        with self.assertRaisesRegex(subject.LocalRuntimeReadinessError, "private"):
            subject.verify_capability(leaking, SHA)
        drift = self.payload()
        drift["available_packs"][1]["catalog_version"] = "other"
        with self.assertRaisesRegex(subject.LocalRuntimeReadinessError, "different"):
            subject.verify_capability(drift, SHA)


if __name__ == "__main__":
    unittest.main()
