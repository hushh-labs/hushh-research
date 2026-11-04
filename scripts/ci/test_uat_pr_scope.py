# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Verify PR scope and protected-source binding before shared UAT mutation."""

from types import SimpleNamespace
import unittest
from unittest.mock import patch

import uat_exact_ci as subject
import uat_release_prerequisites as prerequisites


class ApprovedUatScopeTest(unittest.TestCase):
    def test_landed_tree_must_be_the_reviewed_pr_delta_and_live_bases_must_match(self):
        base, head, landed, extra = (letter * 40 for letter in "abcd")
        pr = {"merged": True, "merge_commit_sha": landed, "head": {"sha": head},
              "base": {"ref": "uat", "repo": {"full_name": subject.REPOSITORY}}}
        api = SimpleNamespace(read=lambda path: pr)
        approval = f"{base}:{base}:42={head}"
        serving = {"backend": {"sha": base}, "frontend": {"sha": base}}
        identities = {
            ("rev-parse", f"{landed}^1"): base,
            ("merge-base", "--all", base, head): base,
            ("rev-parse", f"{base}^{{tree}}"): base,
            ("rev-parse", f"{head}^{{tree}}"): head,
            ("rev-parse", f"{landed}^{{tree}}"): head,
        }
        with patch.object(prerequisites, "git_identity", side_effect=lambda *args: identities[args]):
            prerequisites.verify_approved_scope(api, landed, base, approval,
                                                read_live=lambda scope: serving)
            with self.assertRaisesRegex(subject.Refused, "explicit candidate"):
                prerequisites.verify_approved_scope(api, landed, base, "")
            with self.assertRaisesRegex(subject.Refused, "approved head"):
                prerequisites.verify_approved_scope(api, landed, base, f"{base}:{base}:42={extra}")
            serving["frontend"]["sha"] = extra
            with self.assertRaisesRegex(subject.Refused, "serving revisions changed"):
                prerequisites.verify_approved_scope(api, landed, base, approval,
                                                    read_live=lambda scope: serving)
            identities["rev-parse", f"{landed}^{{tree}}"] = extra
            with self.assertRaisesRegex(subject.Refused, "outside the approved PR"):
                prerequisites.verify_approved_scope(api, landed, base, approval)

    def test_isolated_branch_requires_its_own_protected_tip(self):
        candidate = "a" * 40
        paths = []
        def read(path):
            paths.append(path)
            return {"protected": path.endswith("/uat-isolated"), "commit": {"sha": candidate}}
        api = SimpleNamespace(read=read)
        subject.require_protected_tip(api, candidate, "uat-isolated")
        with self.assertRaises(subject.Refused):
            subject.require_protected_tip(api, candidate, "uat")
        with self.assertRaises(subject.Refused):
            subject.require_protected_tip(api, candidate, "dev")
        self.assertEqual(len(paths), 2)


if __name__ == "__main__":
    unittest.main()
