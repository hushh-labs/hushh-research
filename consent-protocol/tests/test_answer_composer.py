"""The boundary around the answer-writing gene.

The gene writes the answer; this module may only refuse it. The property that
matters most is that a failure produces an honest `projection`, never
something the requester would read as a written answer.
"""

import pytest

from hushh_mcp.services.answer_composer import (
    ANSWER_COMPOSE_SCHEMA,
    MAX_ANSWER_CHARS,
    AnswerComposer,
    AnswerComposerError,
)

PROJECTION = {"attr.travel.trips": {"trips": [{"city": "Tokyo", "amount": 1200}]}}


def composer(payload):
    async def runner(_prompt):
        if isinstance(payload, Exception):
            raise payload
        return payload

    return AnswerComposer(runner=runner)


class TestTheAnswerIsReturnedAsWritten:
    async def test_passes_the_gene_s_answer_through_unchanged(self):
        written = await composer(
            {"answer": "They spent $1,200 on travel, all of it in Tokyo.", "covers": ["trips"]}
        ).compose(question="How much on travel?", projection=PROJECTION)
        assert written["answer"] == "They spent $1,200 on travel, all of it in Tokyo."
        assert written["covers"] == ["trips"]

    async def test_gaps_survive_so_a_partial_answer_says_so(self):
        written = await composer(
            {"answer": "Only Q1 is covered.", "gaps": ["No data after March"]}
        ).compose(question="q", projection=PROJECTION)
        assert written["gaps"] == ["No data after March"]


class TestFailureIsNotAnAnswer:
    async def test_an_empty_answer_is_rejected_whole(self):
        with pytest.raises(AnswerComposerError):
            await composer({"answer": "   "}).compose(question="q", projection=PROJECTION)

    async def test_a_missing_answer_is_rejected_whole(self):
        with pytest.raises(AnswerComposerError):
            await composer({"covers": ["trips"]}).compose(question="q", projection=PROJECTION)

    async def test_an_overlong_answer_is_refused_rather_than_truncated(self):
        # Truncating would hand the requester a sentence that stops mid-fact.
        with pytest.raises(AnswerComposerError):
            await composer({"answer": "x" * (MAX_ANSWER_CHARS + 1)}).compose(
                question="q", projection=PROJECTION
            )

    async def test_a_model_failure_raises_so_the_caller_records_a_projection(self):
        with pytest.raises(AnswerComposerError):
            await composer(TimeoutError("model timed out")).compose(
                question="q", projection=PROJECTION
            )

    async def test_nothing_approved_means_nothing_to_answer_from(self):
        with pytest.raises(AnswerComposerError):
            await composer({"answer": "anything"}).compose(question="q", projection={})


class TestPromptBoundary:
    async def test_the_answer_is_written_from_the_person_s_memory_document(self):
        # The whole point of this lane: the answer comes from the person's own
        # living memory, sliced to what they approved -- not from a file fetch.
        seen: list[str] = []

        async def runner(prompt):
            seen.append(prompt)
            return {"answer": "ok"}

        memory = (
            "# Memory\n\n## Account\n\n| Detail | Value |\n| --- | --- |\n"
            "| Name | Ankit Kumar Singh |\n| Initial | A |\n"
            "| Picture | https://example.test/a.png |\n\n"
            "## Travel\n\n| Detail | Value |\n| --- | --- |\n| Trips 0 City | Tokyo |\n"
        )
        await AnswerComposer(runner=runner).compose(
            question="How much on travel?",
            projection={"memory": memory, "values": PROJECTION},
            period={"start": "2026-01-01", "end": "2026-12-31"},
        )
        prompt = seen[0]
        assert "How much on travel?" in prompt
        assert "2026-01-01 to 2026-12-31" in prompt
        # Who the person is travels with the answer.
        assert "Ankit Kumar Singh" in prompt
        assert "| Initial | A |" in prompt
        assert "https://example.test/a.png" in prompt
        # And the approved values, structured, so figures can be cited exactly.
        assert "Tokyo" in prompt
        assert "limited to what they approved" in prompt

    async def test_a_bare_projection_still_works(self):
        # Older callers send values with no memory document; that is handled
        # rather than refused.
        seen: list[str] = []

        async def runner(prompt):
            seen.append(prompt)
            return {"answer": "ok"}

        await AnswerComposer(runner=runner).compose(
            question="How much on travel?", projection=PROJECTION
        )
        assert "Tokyo" in seen[0]

    async def test_an_empty_memory_and_empty_values_is_nothing_to_answer_from(self):
        with pytest.raises(AnswerComposerError):
            await composer({"answer": "x"}).compose(
                question="q", projection={"memory": "", "values": {}}
            )


def test_schema_requires_an_answer_string():
    assert ANSWER_COMPOSE_SCHEMA["required"] == ["answer"]
    assert ANSWER_COMPOSE_SCHEMA["properties"]["answer"]["type"] == "STRING"
