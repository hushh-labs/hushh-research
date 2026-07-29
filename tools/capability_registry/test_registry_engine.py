from pathlib import Path
import subprocess
import sys


sys.path.append(str(Path(__file__).resolve().parents[2]))

from tools.capability_registry.registry_engine import (
    find_agents
)


def test_find_agents():
    result = find_agents("semantic-search")

    assert "search-agent" in result


def test_report_generation():
    process = subprocess.run(
        [
            "python",
            "tools/capability_registry/registry_engine.py"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path(
        "reports/agent_capability_registry.md"
    )

    assert report_path.exists()