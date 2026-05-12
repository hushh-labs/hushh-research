from pathlib import Path
import subprocess


def test_repository_health_checker():
    process = subprocess.run(
        [
            "python",
            "tools/repo_health/health_checker.py"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/repository_health_report.md")

    assert report_path.exists()