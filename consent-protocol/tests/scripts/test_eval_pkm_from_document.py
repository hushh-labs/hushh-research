"""The document evaluator has to be able to fail.

It replaces a 100-persona benchmark that measured whether the classifier obeyed
its contract on inputs chosen to exercise it. That answered a narrower question
than the one that matters: can this system hold a person.
"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from eval_pkm_from_document import evaluate  # noqa: E402


def verdicts(report) -> dict[str, str]:
    return {finding["id"]: finding["verdict"] for finding in report.findings}


def test_a_document_of_housed_facts_reports_coverage(tmp_path):
    # The positive control. Without one, a failing exit code proves nothing --
    # a gate that always fails is as useless as one that cannot fail.
    doc = tmp_path / "housed.md"
    doc.write_text(
        "# Identity\n"
        "Name: Test Person and their preferred name\n"
        "I have a degree in Computer Science from somewhere\n"
        "# Financial\n"
        "Approximately sixty thousand in loans at some interest rate\n",
        encoding="utf-8",
    )
    report = evaluate(doc)
    assert report.statements > 0
    assert report.housed == report.statements
    assert verdicts(report)["coverage"] == "pass"


def test_communication_preferences_are_reported_as_having_no_home(tmp_path):
    # The finding this evaluator exists to surface. A person's instructions for
    # how to work with them are durable, high-value context, and no canonical
    # domain is about them.
    doc = tmp_path / "prefs.md"
    doc.write_text(
        "# Communication style\n"
        "Use a founder and executive voice when talking to me\n"
        "I prefer direct and concise answers without any filler\n"
        "Do not overkill simple questions with long explanations\n",
        encoding="utf-8",
    )
    report = evaluate(doc)
    assert "how I want to be communicated with" in report.unhoused
    assert verdicts(report)["coverage"] == "fail"


def test_it_names_domains_that_hold_records_with_no_sharing_policy(tmp_path):
    doc = tmp_path / "unpoliced.md"
    doc.write_text(
        "# Health\n"
        "I have health insurance through a marketplace plan\n"
        "# Food\n"
        "I cook most of my meals and prefer simple recipes\n",
        encoding="utf-8",
    )
    report = evaluate(doc)
    assert "no-sharing-policy" in verdicts(report)


def test_an_empty_document_does_not_crash(tmp_path):
    doc = tmp_path / "empty.md"
    doc.write_text("# Nothing\n", encoding="utf-8")
    report = evaluate(doc)
    assert report.statements == 0
