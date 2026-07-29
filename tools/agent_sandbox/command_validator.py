import yaml
from pathlib import Path


BASE_DIR = Path(__file__).parent
POLICY_FILE = BASE_DIR / "sandbox_policy.yaml"


def load_policy():
    with open(POLICY_FILE, "r") as file:
        return yaml.safe_load(file)


def validate_command(command):

    policy = load_policy()

    blocked = policy["blocked_commands"]

    for blocked_command in blocked:

        if blocked_command.lower() in command.lower():

            return {
                "allowed": False,
                "reason": blocked_command,
            }

    return {
        "allowed": True,
        "reason": None,
    }