"""Issued background URLs survive release and manual rollback decisions."""

import json

import pytest

from tests.helpers.deployment_cli import cloudrun_revision
from tests.test_protected_document_release_contract import reader_repository as reader_repository


@pytest.fixture
def background_repository(monkeypatch, tmp_path, reader_repository):
    module, old, reader, git = reader_repository
    for relative in module.BACKGROUND_READER_FILES:
        source = tmp_path / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("background reader contract v2")
    git("add", ".")
    git("commit", "-qm", "Background reader implementation")
    background = git("rev-parse", "HEAD")
    monkeypatch.setattr(module, "BACKGROUND_READER_ANCESTOR", background)
    assert module.background_reader_supported(background)
    assert not module.background_reader_supported(reader)
    return module, old, reader, background, git


@pytest.mark.parametrize("manual", [False, True])
def test_v1_rollback_rechecks_background_obligations_and_current_writers(
    monkeypatch, background_repository, manual
):
    module, _old, reader, background, _git = background_repository
    previous = {
        service: {"revision": service + "-old", "sha": reader} for service in module.SERVICES
    }
    backend = cloudrun_revision(
        name="consent-protocol-current", service="consent-protocol", sha=reader
    )
    monkeypatch.setattr(module, "_previous_sources", lambda _project: (previous, backend))
    empty = True
    checks = []

    def inventory(project, *, background_only=False):
        assert project == "hushh-pda-uat" and background_only
        checks.append(empty)
        return empty

    monkeypatch.setattr(module, "_database_empty", inventory)
    report = module.verify_readers(
        {"configured": True, "enabled": True},
        project="hushh-pda-uat",
        target=background,
        ancestor=reader,
    )
    assert report["bootstrapEmpty"] is False
    target = cloudrun_revision(name="hushh-webapp-old", service="hushh-webapp", sha=reader)
    monkeypatch.setattr(module, "_cloud", lambda *_args: json.dumps(target))

    def rollback():
        if manual:
            module.assert_manual_rollback(
                project="hushh-pda-uat",
                service="hushh-webapp",
                revision="hushh-webapp-old",
                ancestor=reader,
            )
        else:
            module.assert_rollback(
                report, project="hushh-pda-uat", service="hushh-webapp", revision="hushh-webapp-old"
            )

    rollback()
    empty = False
    with pytest.raises(ValueError, match="issued background document readers"):
        rollback()
    assert checks == [True, False]
    # The old intake switch does not fence v2 consent. Even an empty database
    # cannot authorize downgrading the web/worker while the v2 API can issue.
    empty = True
    backend["metadata"]["labels"]["deploy-sha"] = background
    backend["spec"]["containers"][0]["env"] = [
        {"name": "PROTECTED_DOCUMENT_DELIVERY_ENABLED", "value": "false"}
    ]
    with pytest.raises(ValueError, match="forward recovery"):
        rollback()
    # Forward recovery must remain possible after a partially promoted release.
    previous["consent-protocol"]["sha"] = background
    empty = False
    recovered = module.verify_readers(
        {"configured": True, "enabled": True},
        project="hushh-pda-uat",
        target=background,
        ancestor=reader,
    )
    assert recovered["targetSha"] == background
    monkeypatch.setattr(module, "_assert_background_downgrade_safe", lambda *_args: None)
    # Negative control: deleting only the new fence revives the broken decision.
    with pytest.raises(pytest.fail.Exception):
        with pytest.raises(ValueError):
            rollback()


def test_background_capability_requires_remaining_entrypoints_and_forward_compatibility(
    monkeypatch, tmp_path, background_repository
):
    module, _old, reader, background, git = background_repository
    monkeypatch.setattr(module, "_previous_sources", lambda _project: ({}, None))
    monkeypatch.setattr(module, "_database_empty", lambda _project, **_kwargs: False)
    with pytest.raises(ValueError, match="issued background document readers"):
        module.verify_readers(
            {"configured": True, "enabled": True},
            project="hushh-pda-uat",
            target=reader,
            ancestor=reader,
        )
    for path in module.BACKGROUND_READER_FILES:
        file = tmp_path / path
        content = file.read_text()
        file.unlink()
        git("add", ".")
        git("commit", "-qm", "Remove background entrypoint")
        assert not module.background_reader_supported(git("rev-parse", "HEAD"))
        file.write_text(content)
    assert module.background_reader_supported(background)
