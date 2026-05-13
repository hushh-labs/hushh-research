from pathlib import Path
import subprocess


def test_recovery_system():
    process = subprocess.run(
        ["python", "tools/recovery_system/recovery_manager.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/recovery_audit_report.md")

    assert report_path.exists()