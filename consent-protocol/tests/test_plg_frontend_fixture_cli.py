"""Exercise real CLI dispatch with synthetic hosted/provider evidence."""

import json
import runpy
import sys

import pytest
from test_plg_frontend_fixture import ROOT, Native, accepted, candidate, document


def fixture():
    native, desired = Native(), document()
    observed = candidate.stage(native, desired, checkpoint=lambda _value: None, previous=None)
    run = {"id": 123, "run_attempt": 1, "head_sha": "a" * 40, "updated_at": "fixed"}
    source, backend = {"runId": 42}, {"runId": 55}
    intent = {
        "serviceDocument": desired,
        "previous": None,
        "buildEvidence": {"imageReference": observed["imageReference"]},
        "prepared": {"sourceValidation": source, "backendPair": {"acceptance": backend}},
    }
    stage = {"artifactId": 10, "artifactDigest": "sha256:" + "a" * 64, "document": intent}
    receipt = {
        "kind": accepted.KIND,
        "stageIntent": {key: stage[key] for key in ("artifactId", "artifactDigest")},
        "candidate": observed,
        "checks": {
            "kind": "plg-fixture-negative-owner-proxy-checks-v1",
            "privateIngress": True,
            "positiveOwnerPreferenceVerified": False,
            "customerSendingVerified": False,
            "preferences": {
                method: {"status": 401, "responseMatchesPrivateBackend": True, "noStore": True}
                for method in ("GET", "PUT")
            },
        },
        "predecessor": None,
        "customerSendingVerified": False,
        "productionTrafficAuthorized": False,
    }
    return run, source, backend, stage, receipt


@pytest.mark.parametrize("old_guard_order", [False, True])
def test_acceptance_cli_reaches_source_and_backend_scope_checks(
    monkeypatch, capsys, tmp_path, old_guard_order
):
    import qualification_acceptance

    run, source, backend, stage, receipt = fixture()
    calls = []

    class GitHub:
        def read(self, _path):
            return run

    class Backend:
        def pin(self):
            calls.append("backend")
            return backend

    def source_verify(*_args, **_kwargs):
        calls.append("source")
        return source

    monkeypatch.setattr(accepted.release.frontend_validation, "verify", source_verify)
    monkeypatch.setattr(qualification_acceptance, "verify", lambda *_args, **_kwargs: Backend())
    monkeypatch.setattr(
        sys,
        "argv",
        ["fixture-acceptance", "--environment", "dev", "--run-id", "123", "--historical"],
    )
    cli_path = ROOT / "deploy/plg/frontend_fixture_acceptance.py"
    if old_guard_order:
        text = cli_path.read_text()
        guard = 'if __name__ == "__main__":\n    try:\n        sys.exit(main())\n    except Exception:\n        print("Private frontend fixture acceptance unverified", file=sys.stderr)\n        sys.exit(1)\n'
        assert text.count(guard) == 1
        broken = text.replace(guard, "", 1).replace(
            "def _source_and_scope(", guard + "\n\ndef _source_and_scope(", 1
        )
        cli_path = tmp_path / "old_guard_order.py"
        cli_path.write_text(broken)

    def install_provider_ports(frame, event, _arg):
        if (
            event == "call"
            and frame.f_code.co_name == "main"
            and frame.f_code.co_filename == str(cli_path)
        ):
            namespace = frame.f_globals
            namespace["client_or"] = lambda _client: GitHub()
            namespace["completed"] = lambda *_args, **_kwargs: (run, {})
            namespace["stage_intent"] = lambda *_args, **_kwargs: stage
            namespace["artifact"] = lambda *_args: (
                {"id": 11, "digest": "sha256:" + "b" * 64},
                receipt,
            )
            namespace["verify_build"] = lambda *_args: None
        return install_provider_ports

    previous = sys.gettrace()
    sys.settrace(install_provider_ports)
    try:
        with pytest.raises(SystemExit) as result:
            runpy.run_path(str(cli_path), run_name="__main__")
    finally:
        sys.settrace(previous)
    output = capsys.readouterr()
    if old_guard_order:
        assert result.value.code == 1 and not calls
        assert "Private frontend fixture acceptance unverified" in output.err
    else:
        assert result.value.code == 0
        assert calls == ["source", "backend"]
        assert json.loads(output.out)["runId"] == 123
