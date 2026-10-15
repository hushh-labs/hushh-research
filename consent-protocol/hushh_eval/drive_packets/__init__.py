"""Batch evaluation of Drive packets on synthetic fixtures or one owner's real Drive.

Read-only by construction: one read-only database connection, GET-only Drive
access, no Cloud Run jobs, no workflow dispatch and no writes to any environment.
Run it as ``python -m hushh_eval.drive_packets <command>``; see README.md.
"""

PACKAGE_VERSION = "dpe-1"
