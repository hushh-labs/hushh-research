"""Private evidence stays in a 0700 workdir outside git; public outputs carry counts,
enums and keyed ids only. A canary planted in labels and document text never
reaches report.md, report.public.json or logs."""

import hashlib
import json
import logging

import pytest

from hushh_eval.drive_packets import cli
from hushh_eval.drive_packets.privacy import (
    PrivacyError,
    PrivateWorkdir,
    assert_public_text,
    public_payload,
)

TEXT_CANARY = "ZEBRA-CANARY-TEXT-4471"
LABEL_CANARY = "OKAPI-CANARY-LABEL-9902"


def test_workdir_inside_a_git_worktree_is_refused(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    with pytest.raises(PrivacyError, match="workdir_inside_git_worktree"):
        PrivateWorkdir(repo / "eval")


def test_workdir_must_be_0700(tmp_path):
    loose = tmp_path / "loose"
    loose.mkdir(mode=0o755)
    loose.chmod(0o755)
    with pytest.raises(PrivacyError, match="workdir_mode_not_0700"):
        PrivateWorkdir(loose)
    created = PrivateWorkdir(tmp_path / "private")
    assert oct(created.path.stat().st_mode & 0o777) == "0o700"


def test_public_payload_accepts_counts_and_rejects_free_text():
    assert public_payload({"files": 3, "status": "insufficient", "rate": 0.5}) == {
        "files": 3,
        "status": "insufficient",
        "rate": 0.5,
    }
    for leak in ({"issuer": "Example Bank"}, {"note": "account ending 1234"}, {"Title": 1}):
        with pytest.raises(PrivacyError):
            public_payload(leak)
    with pytest.raises(PrivacyError, match="canary_leak"):
        assert_public_text("all good " + TEXT_CANARY.lower(), canaries=[TEXT_CANARY])


def canary_dataset(root):
    text = (
        f"{TEXT_CANARY} Example Bank\nMonthly statement\nAccount ending 4471\n"
        "Statement period September 1, 2026 to September 30, 2026\n"
    ).encode()
    (root / "doc.txt").write_bytes(text)
    manifest = {
        "schema_version": "drive-pipeline-eval-v1",
        "version": "canary-v1",
        "corpus_kind": "synthetic",
        "reference": {"source": "test", "label_version": "t", "independent_of_model": True},
        "sampling": {
            "representative_independent_holdout": False,
            "source": "test",
            "fixed_sample_size": 0,
        },
        "cases": [
            {
                "id": "dev-1",
                "partition": "dev",
                "correlation_group": "g1",
                "request": {"purpose": "statements"},
                "documents": [
                    {
                        "ref": "d1",
                        "path": "doc.txt",
                        "sha256": hashlib.sha256(text).hexdigest(),
                        "mime_type": "text/plain",
                        "source_version": "1",
                        "relevance": "include",
                        "facts": {
                            "issuer": LABEL_CANARY,
                            "period_start": "2026-09-01",
                            "period_end": "2026-09-30",
                        },
                    }
                ],
                "expected_packet": {"status": "ready", "selected_refs": ["d1"], "coverage": {}},
            }
        ],
    }
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path


def test_canary_never_reaches_reports_or_logs(tmp_path, monkeypatch, capsys, caplog):
    data = tmp_path / "data"
    data.mkdir()
    manifest = canary_dataset(data)
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setenv("DPE_CANARIES", f"{TEXT_CANARY},{LABEL_CANARY}")
    workdir = tmp_path / "work"
    common = ["--workdir", str(workdir), "--batch-id", "C1"]
    caplog.set_level(logging.DEBUG)
    steps = [
        [
            "plan-batch",
            "--seed",
            "1",
            "--n-clusters",
            "1",
            "--n-loose",
            "1",
            "--fixture-manifest",
            str(manifest),
        ],
        ["run-batch"],
        ["judge", "--judge", "fake"],
        ["label", "--judge", "fake"],
        ["score"],
        ["report"],
    ]
    for step in steps:
        assert cli.main([step[0], *common, *step[1:]]) == 0
    batch = workdir / "batches" / "C1"
    public = (batch / "report.md").read_text() + (batch / "report.public.json").read_text()
    logs = capsys.readouterr().out + caplog.text
    for canary in (TEXT_CANARY, LABEL_CANARY):
        assert canary not in public
        assert canary not in logs
    # Positive control: the canary is really inside the private evidence.
    assert TEXT_CANARY in (batch / "details.json").read_text()
    assert LABEL_CANARY in (batch / "labels.jsonl").read_text()


def test_generic_placeholder_values_do_not_block_reports_but_names_do():
    text = '{"metric": "fact_accuracy", "n_unknown": 3}'
    assert_public_text(text, private={"unknown"})
    with pytest.raises(PrivacyError, match="private_value_leak"):
        assert_public_text(text + " examplebank", private={"examplebank"})


def test_private_values_match_whole_words_only():
    text = '{"metric": "packet_completeness"}'
    assert_public_text(text, private={"complet"})
    with pytest.raises(PrivacyError, match="private_value_leak"):
        assert_public_text('{"note": "acme_trust"}', private={"acme_trust"})
