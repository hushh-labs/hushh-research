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
    async def test_the_gene_sees_the_question_the_period_and_only_approved_values(self):
        seen: list[str] = []

        async def runner(prompt):
            seen.append(prompt)
            return {"answer": "ok"}

        await AnswerComposer(runner=runner).compose(
            question="How much on travel?",
            projection=PROJECTION,
            period={"start": "2026-01-01", "end": "2026-12-31"},
        )
        prompt = seen[0]
        assert "How much on travel?" in prompt
        assert "2026-01-01 to 2026-12-31" in prompt
        assert "Tokyo" in prompt
        # It is told these are the only inputs it has.
        assert "the only information you have" in prompt


def test_schema_requires_an_answer_string():
    assert ANSWER_COMPOSE_SCHEMA["required"] == ["answer"]
    assert ANSWER_COMPOSE_SCHEMA["properties"]["answer"]["type"] == "STRING"
