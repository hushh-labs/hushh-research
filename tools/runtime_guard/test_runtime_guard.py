from pathlib import Path
import subprocess


def test_runtime_guard():
    process = subprocess.run(
        ["python", "tools/runtime_guard/verify_startup.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/runtime_verification_report.md")

    assert report_path.exists()