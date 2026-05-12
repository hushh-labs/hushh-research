from pathlib import Path
import subprocess


def test_permission_engine():
    process = subprocess.run(
        [
            "python",
            "tools/agent_security/permission_engine.py"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/permission_enforcement_report.md")

    assert report_path.exists()