"""Mutation receipts must not reuse stale board snapshots."""
import argparse
import contextlib
import io
import json
import unittest
from unittest.mock import patch

import board_ops


class MutationReadbackTest(unittest.TestCase):
    def test_update_reads_live_state_despite_cached_issue(self):
        stale = {"number": 1, "title": "Task", "assignees": [], "projectItems": []}
        live = {**stale, "assignees": [{"login": "owner"}], "projectItems": [
            {"title": "Hussh Action Items", "status": {"name": "In Progress"}}
        ]}
        args = argparse.Namespace(repo="org/repo", issue=1, status="In Progress",
                                  start_date=None, target_date=None, labels=None,
                                  sync_current_sprint=False, hierarchy=None, fields=[])
        output = io.StringIO()
        with (patch.object(board_ops, "_cache_loaded", True),
              patch.object(board_ops, "_issue_json_cache", {("org/repo", 1): stale}),
              patch.object(board_ops, "_save_cache"),
              patch.object(board_ops, "update_task"),
              patch.object(board_ops, "run_gh_json", return_value=live) as read,
              contextlib.redirect_stdout(output)):
            board_ops.cmd_update_task(args)
        read.assert_called_once()
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt["assignees"], [{"login": "owner"}])
        self.assertEqual(receipt["projectItems"][0]["status"]["name"], "In Progress")


if __name__ == "__main__":
    unittest.main()
