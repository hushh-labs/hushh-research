#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Check the release configuration boundary without building a simulator app."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UatPasskeyConfigurationTests(unittest.TestCase):
    def test_ci_rp_reaches_native_preparation_and_has_an_entitlement(self):
        script = (ROOT / 'scripts/ci/materialize-ios-uat-build-contract.sh').read_text()
        assignments = [line for line in script.splitlines() if line.startswith('put_env NEXT_PUBLIC_PASSKEY_RP_ID ')]
        self.assertEqual(len(assignments), 1)
        rp = assignments[0].split('"')[1]
        self.assertEqual(rp, 'uat.one.hushh.ai')
        output = subprocess.check_output([
            'node', '--input-type=module', '-e',
            'import {buildIosUatRuntimeEnv} from "./hushh-webapp/scripts/native/prepare-ios-uat-archive.mjs";'
            'console.log(JSON.stringify(buildIosUatRuntimeEnv({processEnv:{NEXT_PUBLIC_PASSKEY_RP_ID:process.argv[1]},uatValues:{NEXT_PUBLIC_PASSKEY_RP_ID:"one.hushh.ai"},localValues:{}})));',
            rp,
        ], cwd=ROOT, text=True)
        self.assertEqual(json.loads(output)['NEXT_PUBLIC_PASSKEY_RP_ID'], rp)
        self.assertIn(
            'put_env NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED "$LOCATION_COMMAND_RUNTIME_ENABLED"',
            script,
        )
        command_output = subprocess.check_output([
            'node', '--input-type=module', '-e',
            'import {buildIosUatRuntimeEnv} from "./hushh-webapp/scripts/native/prepare-ios-uat-archive.mjs";'
            'console.log(JSON.stringify(buildIosUatRuntimeEnv({processEnv:{NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED:"true"},uatValues:{},localValues:{}})));',
        ], cwd=ROOT, text=True)
        self.assertEqual(
            json.loads(command_output)['NEXT_PUBLIC_LOCATION_COMMAND_RUNTIME_ENABLED'],
            'true',
        )
        for name in ('App.entitlements', 'AppRelease.entitlements'):
            entitlements = (ROOT / 'hushh-webapp/ios/App/App' / name).read_text()
            self.assertIn('webcredentials:' + rp, entitlements)
            self.assertIn('webcredentials:one.hushh.ai', entitlements)


if __name__ == '__main__':
    unittest.main()
