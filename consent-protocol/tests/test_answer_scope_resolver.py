"""The boundary around the scope-resolver gene.

The gene's judgement is its own; these tests guard what the host code is
allowed to do with it -- which is only ever to narrow, and to fail loudly
rather than guess.
"""

import pytest

from hushh_mcp.services.answer_scope_resolver import (
    ANSWER_SCOPE_SCHEMA,
    AnswerScopeResolver,
    AnswerScopeResolverError,
)

CANDIDATES = ["attr.travel.trips", "attr.preferences.food", "attr.financial.holdings"]


def resolver(payload):
    async def runner(_prompt):
        if isinstance(payload, Exception):
            raise payload
        return payload

    return AnswerScopeResolver(runner=runner)


class TestNarrowingOnly:
    async def test_returns_what_the_gene_chose(self):
        result = await resolver({"scopes": ["attr.travel.trips"]}).propose_scopes(
            question="How much did you spend on travel?", candidate_scopes=CANDIDATES
        )
        assert result == ["attr.travel.trips"]

    async def test_drops_a_handle_that_was_never_offered(self):
        # The gene may only choose from what it was shown. An invented or
        # "corrected" handle must not reach the owner's approval screen.
        result = await resolver(
            {"scopes": ["attr.travel.trips", "attr.secrets.items", "attr.travel.trip"]}
        ).propose_scopes(question="travel?", candidate_scopes=CANDIDATES)
        assert result == ["attr.travel.trips"]

    async def test_an_empty_choice_is_a_real_answer(self):
        # Returning nothing is correct when nothing fits, and must not be
        # turned into a guess.
        result = await resolver({"scopes": []}).propose_scopes(
            question="what is the weather?", candidate_scopes=CANDIDATES
        )
        assert result == []

    async def test_duplicates_collapse_and_order_is_the_genes(self):
        result = await resolver(
            {"scopes": ["attr.preferences.food", "attr.travel.trips", "attr.preferences.food"]}
        ).propose_scopes(question="q", candidate_scopes=CANDIDATES)
        assert result == ["attr.preferences.food", "attr.travel.trips"]

    async def test_no_candidates_means_no_model_call(self):
        called = False

        async def runner(_prompt):
            nonlocal called
            called = True
            return {"scopes": ["attr.travel.trips"]}

        result = await AnswerScopeResolver(runner=runner).propose_scopes(
            question="q", candidate_scopes=[]
        )
        assert result == []
        assert called is False


class TestFailureIsNotAGuess:
    async def test_malformed_output_is_rejected_whole(self):
        with pytest.raises(AnswerScopeResolverError):
            await resolver({"scopes": "attr.travel.trips"}).propose_scopes(
                question="q", candidate_scopes=CANDIDATES
            )

    async def test_missing_key_is_rejected_whole(self):
        with pytest.raises(AnswerScopeResolverError):
            await resolver({}).propose_scopes(question="q", candidate_scopes=CANDIDATES)

    async def test_a_model_failure_raises_so_the_caller_records_a_skip(self):
        with pytest.raises(AnswerScopeResolverError):
            await resolver(TimeoutError("model timed out")).propose_scopes(
                question="q", candidate_scopes=CANDIDATES
            )


class TestPromptBoundary:
    async def test_the_gene_sees_handles_and_labels_but_never_a_value(self):
        seen: list[str] = []

        async def runner(prompt):
            seen.append(prompt)
            return {"scopes": []}

        await AnswerScopeResolver(runner=runner).propose_scopes(
            question="How much did you spend on travel?",
            candidate_scopes=CANDIDATES,
            candidate_labels={"attr.travel.trips": "Travel"},
        )
        prompt = seen[0]
        assert "attr.travel.trips -- Travel" in prompt
        assert "How much did you spend on travel?" in prompt
        # Nothing about what the scopes contain is ever shown.
        assert "Bengaluru" not in prompt


def test_schema_constrains_the_response_to_a_scope_list():
    assert ANSWER_SCOPE_SCHEMA["required"] == ["scopes"]
    assert ANSWER_SCOPE_SCHEMA["properties"]["scopes"]["type"] == "ARRAY"
    assert ANSWER_SCOPE_SCHEMA["properties"]["scopes"]["items"]["type"] == "STRING"
