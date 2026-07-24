from pathlib import Path
import subprocess


def test_event_audit():
    process = subprocess.run(
        ["python", "tools/event_audit/track_events.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/agent_event_audit_report.md")

    assert report_path.exists()