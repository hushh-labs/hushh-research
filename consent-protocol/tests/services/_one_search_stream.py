"""Controlled provider SSE fixture for the real One Search integration contract."""

import asyncio

from tests.test_azure_web_receipts import response as search_response


def install_gated_search(monkeypatch, client, control, *, root):
    from tests.services.test_one_search_answer_contract import ANSWER

    if control == "callback_rewrite":
        _install_callback_rewrite(root)
    release = asyncio.Event()
    closed = []
    completed = []
    prefix = ANSWER[:22]
    create = client.create

    class GatedSearch:
        async def __aiter__(self):
            yield {
                "type": "response.output_text.delta",
                "delta": prefix,
                "output_index": 2,
                "content_index": 0,
            }
            await release.wait()
            yield {
                "type": "response.output_text.delta",
                "delta": ANSWER[22:],
                "output_index": 2,
                "content_index": 0,
            }
            raw = search_response()
            raw["output"][2]["content"][0]["text"] = (
                "Changed final answer" if control == "mismatch" else ANSWER
            )
            if control == "missing_citation":
                raw["output"][2]["content"][0]["annotations"] = []
            if control == "multipart":
                raw["output"][2]["content"].append(
                    {"type": "output_text", "text": "Additional public detail."}
                )
                yield {
                    "type": "response.output_text.delta",
                    "delta": "Additional public detail.",
                    "output_index": 2,
                    "content_index": 1,
                }
            completed.append(True)
            yield {"type": "response.completed", "response": raw}

        async def close(self):
            closed.append(True)

    async def streaming_create(**kwargs):
        value = await create(**kwargs)
        if any(t["type"] == "web_search" for t in kwargs.get("tools", [])):
            assert kwargs.get("stream") is True
            return GatedSearch()
        return value

    monkeypatch.setattr(client, "create", streaming_create)
    return release, closed, completed, prefix


def _install_callback_rewrite(root):
    child = next(t.agent for t in root.tools if t.name == "google_search")

    async def rewrite(callback_context, llm_response):
        if not llm_response.partial:
            return llm_response.model_copy(
                update={
                    "content": types.Content(role="model", parts=[types.Part(text="Rewritten.")])
                }
            )

    from google.genai import types

    child.after_model_callback = rewrite
