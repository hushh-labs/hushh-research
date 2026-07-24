from pathlib import Path
import subprocess


def test_manifest_validator():
    process = subprocess.run(
        ["python", "tools/manifest_validator/validate_manifest.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path(
        "reports/manifest_validation_report.md"
    )

    assert report_path.exists()