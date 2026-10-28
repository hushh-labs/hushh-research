"""Tests for the Main-lock capacity reader runtime bootstrap."""

import tempfile
import unittest
from pathlib import Path

import prepare_capacity_python as subject


class CapacityPythonTests(unittest.TestCase):
    def test_requirements_derive_versions_and_wheel_hashes_from_main_lock(self):
        text = subject.locked_requirements(
            (subject.ROOT / "consent-protocol/uv.lock").read_bytes()
        )
        self.assertEqual(len(text.strip().splitlines()), 2)
        self.assertIn("pathspec==", text)
        self.assertIn("pyyaml==", text)
        self.assertIn("--hash=sha256:", text)

    def test_missing_or_ambiguous_lock_rejected(self):
        for content in (
            b"package = []",
            b'[[package]]\nname="pyyaml"\nversion="6.0.3"\nwheels=[]',
        ):
            with self.subTest(content=content), self.assertRaises(ValueError):
                subject.locked_requirements(content)

    def test_bootstrap_is_bounded_isolated_and_hash_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "isolated"
            calls = []

            def run(args, **kwargs):
                calls.append((args, kwargs))
                if args[1:3] == ["-m", "venv"]:
                    dest.mkdir()

            actual = subject.prepare(dest, run=run)
            self.assertEqual(Path(actual).parent.parent, dest)
            install = calls[1]
            self.assertIn("--require-hashes", install[0])
            self.assertIn("--only-binary=:all:", install[0])
            self.assertIn("--no-deps", install[0])
            self.assertEqual(install[1]["timeout"], 120)
            self.assertTrue((dest / "capacity-requirements.txt").is_file())
            with self.assertRaises(ValueError):
                subject.prepare(dest, run=run)


if __name__ == "__main__":
    unittest.main()
