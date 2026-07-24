from pathlib import Path
import subprocess


def test_agent_generation():
    process = subprocess.run(
        ["python", "tools/agent_scaffold/create_agent.py"],
        input="test-agent\n",
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    agent_path = Path("agents/test-agent")

    assert agent_path.exists()
    assert (agent_path / "README.md").exists()
    assert (agent_path / "manifest.py").exists()