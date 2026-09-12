#!/usr/bin/env python3
"""Automated contract tests for the immutable One Voice model-pack registry."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / "scripts/voice/build-one-voice-model-pack-registry.py"
SHA = "a" * 40
BUCKET = "hushh-pda-uat-one-voice-model-packs"


class ModelPackRegistryTests(unittest.TestCase):
    def make_ranker(self, path: Path) -> None:
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "pack_id": "one-voice-en-intent-minilm-v1",
                        "version": "1.0.0-fixture",
                        "catalog_version": "kai-action-gateway.vnext",
                    }
                ),
            )

    def run_builder(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(BUILDER), *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def common_args(self, output: Path, asr: Path, ranker: Path) -> list[str]:
        return [
            "--output", str(output),
            "--bucket", BUCKET,
            "--source-sha", SHA,
            "--object-prefix", "one-voice/model-packs",
            "--asr-file", str(asr),
            "--asr-version", "1.13.7",
            "--asr-object", "one-voice/model-packs/source/asr.data",
            "--ranker-file", str(ranker),
            "--ranker-object", "one-voice/model-packs/source/ranker.zip",
        ]

    def test_registry_has_only_object_metadata_and_adds_approved_fluid_pack(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            asr = root / "asr.data"
            ranker = root / "ranker.zip"
            fluid = root / "fluid.zip"
            output = root / "registry.json"
            asr.write_bytes(b"asr")
            fluid.write_bytes(b"fluid")
            self.make_ranker(ranker)
            result = self.run_builder(
                *self.common_args(output, asr, ranker),
                "--fluid-audio-file", str(fluid),
                "--fluid-audio-version", "1.0.0",
                "--fluid-audio-object", "one-voice/model-packs/source/fluid.zip",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            registry = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(registry["protocol_version"], "one.voice.model-pack-registry.v1")
            self.assertNotIn("artifact_url", json.dumps(registry))
            fluid_pack = next(
                pack for pack in registry["active_packs"] if pack["runtime"] == "fluid_audio"
            )
            self.assertEqual(fluid_pack["pack_id"], "fluid-audio-parakeet-eou-120m-coreml-v1")
            self.assertTrue(fluid_pack["license_approved"])
            self.assertEqual(fluid_pack["source_sha"], SHA)

    def test_rejects_partial_fluid_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            asr = root / "asr.data"
            ranker = root / "ranker.zip"
            fluid = root / "fluid.zip"
            output = root / "registry.json"
            asr.write_bytes(b"asr")
            fluid.write_bytes(b"fluid")
            self.make_ranker(ranker)
            result = self.run_builder(
                *self.common_args(output, asr, ranker),
                "--fluid-audio-file", str(fluid),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("complete set", result.stderr)


if __name__ == "__main__":
    unittest.main()
