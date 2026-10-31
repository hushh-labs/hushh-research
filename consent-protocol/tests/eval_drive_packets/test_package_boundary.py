"""The eval package stays outside the runtime: never imported by hushh_mcp or api,
excluded from the runtime image, and without any command that writes or dispatches."""

import re
from pathlib import Path

from hushh_eval.drive_packets import cli

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "hushh_eval" / "drive_packets"


def test_runtime_never_imports_the_eval_package():
    offenders = [
        str(path.relative_to(ROOT))
        for folder in ("hushh_mcp", "api")
        for path in (ROOT / folder).rglob("*.py")
        if "hushh_eval" in path.read_text(errors="ignore")
    ]
    assert offenders == []


def test_runtime_image_excludes_the_eval_package():
    lines = {line.strip() for line in (ROOT / ".dockerignore").read_text().splitlines()}
    assert "hushh_eval/" in lines


def test_cli_exposes_the_seven_commands_and_no_mutating_flags():
    parser = cli.parser()
    subparsers = next(action for action in parser._actions if action.dest == "command")
    assert set(subparsers.choices) == set(cli.COMMANDS)
    forbidden = re.compile(
        r"job|dispatch|workflow|write|mutate|insert|delete|grant|share|pay|deploy-uat"
    )
    options = [
        option
        for command in subparsers.choices.values()
        for action in command._actions
        for option in action.option_strings
    ]
    assert options and not [option for option in options if forbidden.search(option)]


def test_cli_import_and_help_do_not_read_a_hosted_profile(monkeypatch):
    import importlib.util

    def refuse_profile(*_args, **_kwargs):
        raise AssertionError("Fixture commands must not depend on hosted configuration")

    monkeypatch.setattr("hushh_mcp.managed_ai_config.load_profile", refuse_profile)
    spec = importlib.util.spec_from_file_location("eval_import_fixture", cli.__file__)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.parser().format_help()


def test_package_source_has_no_write_or_dispatch_paths():
    source = "\n".join(path.read_text() for path in PACKAGE.glob("*.py"))
    for pattern in (
        r"INSERT\s+INTO",
        r"UPDATE\s+\w+\s+SET",
        r"DELETE\s+FROM",
        r"\"run\",\s*\"jobs\"",
        r"\"run\",\s*\"deploy\"",
        r"\"workflow\",\s*\"run\"",
        r"workflow\s+run",
    ):
        assert not re.search(pattern, source, re.IGNORECASE), pattern
