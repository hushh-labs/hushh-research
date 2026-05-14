from pathlib import Path
import subprocess
import sys


sys.path.append(str(Path(__file__).resolve().parents[2]))

from tools.sandbox_runtime.sandbox_engine import (
    is_action_allowed
)


def test_allowed_action():
    assert is_action_allowed(
        "memory-agent",
        "read_memory"
    )


def test_blocked_action():
    assert not is_action_allowed(
        "memory-agent",
        "delete_database"
    )


def test_report_generation():
    process = subprocess.run(
        [
            "python",
            "tools/sandbox_runtime/sandbox_engine.py"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path(
        "reports/sandbox_violation_report.md"
    )

    assert report_path.exists()