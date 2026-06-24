import yaml
from pathlib import Path


BASE_DIR = Path(__file__).parent
POLICY_FILE = BASE_DIR / "sandbox_policy.yaml"


def load_policy():
    with open(POLICY_FILE, "r") as file:
        return yaml.safe_load(file)


def validate_tool_access(tool_name):

    policy = load_policy()

    restricted = policy["restricted_tools"]

    if tool_name in restricted:

        return {
            "allowed": False,
            "reason": tool_name,
        }

    return {
        "allowed": True,
        "reason": None,
    }