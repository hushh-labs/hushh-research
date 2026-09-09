#!/usr/bin/env python3
"""Automation-only coverage for the FluidAudio model-pack release gate."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "scripts/voice/package-fluid-audio-model-pack.py"
VERIFY = ROOT / "scripts/voice/verify-fluid-audio-model-pack.py"
NOTICE_ID = "fluid-audio-parakeet-eou-120m-coreml-v1"
SOURCE = (
    "https://huggingface.co/FluidInference/parakeet-realtime-eou-120m-coreml/"
    "tree/40a23f4c0b333aa17ad8c0f2ea47ec2347f2f355"
)


class FluidAudioModelPackTests(unittest.TestCase):
    def create_notice(self, path: Path, *, approved: bool) -> None:
        path.write_text(
            json.dumps(
                {
                    "protocol_version": "one.voice.model-notices.v1",
                    "artifacts": [
                        {
                            "notice_id": NOTICE_ID,
                            "source": SOURCE,
                            "license": "NVIDIA Open Model License",
                            "approval_state": "approved" if approved else "pending_legal_review",
                            "release_enabled": approved,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )

    def create_source_archive(self, path: Path, *, unsafe_member: bool = False) -> None:
        with zipfile.ZipFile(path, "w") as archive:
            root = "upstream/160ms"
            for bundle in (
                "streaming_encoder.mlmodelc",
                "decoder.mlmodelc",
                "joint_decision.mlmodelc",
            ):
                archive.writestr(f"{root}/{bundle}/model.bin", bundle)
            archive.writestr(f"{root}/vocab.json", "{}")
            if unsafe_member:
                archive.writestr("../outside", "not allowed")

    def command(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_packages_deterministically_and_verifies_approved_model(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            notices = root / "notices.json"
            source = root / "source.zip"
            output_a = root / "output-a.zip"
            output_b = root / "output-b.zip"
            self.create_notice(notices, approved=True)
            self.create_source_archive(source)
            for output in (output_a, output_b):
                result = self.command(
                    str(PACKAGE),
                    "--source-archive",
                    str(source),
                    "--notices",
                    str(notices),
                    "--version",
                    "1.0.0",
                    "--output",
                    str(output),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                hashlib.sha256(output_a.read_bytes()).hexdigest(),
                hashlib.sha256(output_b.read_bytes()).hexdigest(),
            )
            verified = self.command(
                str(VERIFY), str(output_a), "--notices", str(notices), "--version", "1.0.0"
            )
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual(json.loads(verified.stdout)["pack_id"], NOTICE_ID)

    def test_rejects_unapproved_notice_and_unsafe_source_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            notices = root / "notices.json"
            source = root / "source.zip"
            output = root / "output.zip"
            self.create_notice(notices, approved=False)
            self.create_source_archive(source)
            unapproved = self.command(
                str(PACKAGE),
                "--source-archive",
                str(source),
                "--notices",
                str(notices),
                "--version",
                "1.0.0",
                "--output",
                str(output),
            )
            self.assertNotEqual(unapproved.returncode, 0)

            self.create_notice(notices, approved=True)
            self.create_source_archive(source, unsafe_member=True)
            unsafe = self.command(
                str(PACKAGE),
                "--source-archive",
                str(source),
                "--notices",
                str(notices),
                "--version",
                "1.0.0",
                "--output",
                str(output),
            )
            self.assertNotEqual(unsafe.returncode, 0)


if __name__ == "__main__":
    unittest.main()
