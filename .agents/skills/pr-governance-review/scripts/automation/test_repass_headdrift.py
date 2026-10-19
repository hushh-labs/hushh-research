#!/usr/bin/env python3
"""Tests for the strengthened repass detection (head-drift + timestamp).

The live detect_repass() is GraphQL-coupled, so these tests validate the
DECISION RULE in isolation against synthetic PR states, locking in the
behavior that head-drift catches rebases/edited-records that the
timestamp-only detector missed (the 20+ wrongly-blocked PRs the audit found).
"""
from datetime import datetime, timedelta


def ts(x):
    return datetime.fromisoformat(x.replace("Z", "+00:00")) if x else None


def is_repass(head, reviewed_head, last_rev, last_act):
    """Mirror of the EITHER-signal rule in pr_train_autodrive.detect_repass."""
    timestamp_repass = bool(last_rev and last_act and last_act > last_rev)
    head_drift = bool(head and reviewed_head and head != reviewed_head)
    return timestamp_repass or head_drift


def run():
    T0 = "2026-06-01T00:00:00Z"
    T1 = "2026-06-02T00:00:00Z"  # newer
    cases = [
        # name, head, reviewed_head, last_rev, last_act, expected
        ("timestamp newer commit -> repass", "aaa", "aaa", ts(T0), ts(T1), True),
        ("no activity after review -> not repass", "aaa", "aaa", ts(T1), ts(T0), False),
        # HEAD-DRIFT cases — the bug the audit caught:
        ("rebase: head moved, old commitdate -> repass via head-drift", "bbb", "aaa", ts(T1), ts(T0), True),
        ("edited record (same submittedAt) but head moved -> repass", "ccc", "aaa", ts(T1), None, True),
        ("head unchanged + no newer activity -> not repass", "aaa", "aaa", ts(T1), ts(T0), False),
        # safety: missing data must not crash / false-fire
        ("no reviewed_head known, no timestamp -> not repass", "aaa", None, None, None, False),
        ("no head known -> fall back to timestamp only (repass)", None, "aaa", ts(T0), ts(T1), True),
        ("no head known + no timestamp -> not repass", None, "aaa", ts(T1), ts(T0), False),
    ]
    ok = True
    for name, head, rh, lr, la, exp in cases:
        got = is_repass(head, rh, lr, la)
        mark = "✓" if got == exp else "✗"
        if got != exp:
            ok = False
        print(f"  {mark} {name}: got={got} expect={exp}")
    print("\n", "ALL PASS" if ok else "FAILURES PRESENT")
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if run() else 1)
