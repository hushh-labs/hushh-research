"""Credential-free embedding leaf, invoked by absolute script path, never -m."""

from __future__ import annotations

import json
import sys
from contextlib import nullcontext

try:
    import resource
except ImportError:  # Windows has no POSIX resource-limit module.
    resource = None

if __package__:
    from .document_index_limits import CHUNK_CHARACTERS, INDEX_TEXT_BYTES, MAX_CHUNKS
    from .drive_document_parser import ParsedText
    from .embedding_client_leaf import MODEL_REVISION, EmbeddingAdmissionTimings, EmbeddingClient
else:
    from document_index_limits import CHUNK_CHARACTERS, INDEX_TEXT_BYTES, MAX_CHUNKS
    from drive_document_parser import ParsedText
    from embedding_client_leaf import MODEL_REVISION, EmbeddingAdmissionTimings, EmbeddingClient

PROFILE = "drive-parser-v1:e5-" + MODEL_REVISION
PUBLIC_ADMISSION_QUERY = "synthetic statement"


class InvalidQuery(ValueError):
    pass


def query_payload(client: EmbeddingClient, query: str) -> dict:
    if not isinstance(query, str) or not query.strip() or len(query.encode()) > 2048:
        raise InvalidQuery("invalid query")
    if len(client._load().tokenizer.encode("query: " + query, add_special_tokens=True)) > 480:
        raise InvalidQuery("query too long")
    return {"profile": PROFILE, "embedding": client.embed_query(query)}


def prepare_payload(client: EmbeddingClient, parsed: ParsedText) -> dict:
    tokenizer = client._load().tokenizer
    spans: list[tuple[str, int, int, int]] = []
    global_start = 0
    truncated = parsed.truncated
    for page_number, page in enumerate(parsed.pages, start=1):
        start = 0
        while start < len(page):
            if len(spans) == MAX_CHUNKS:
                truncated = True
                break
            end = min(len(page), start + CHUNK_CHARACTERS)
            while (
                len(tokenizer.encode("passage: " + page[start:end], add_special_tokens=True)) > 480
            ):
                if end == start + 1:
                    raise ValueError("invalid tokenizer")
                end = start + max(1, (end - start) // 2)
            value = page[start:end]
            if value.strip():
                spans.append((value, global_start + start, global_start + end, page_number))
            start = end
        if start < len(page):
            break
        global_start += len(page)
    if not spans:
        raise ValueError("no_extractable_text")
    vectors = client.embed_passages([span[0] for span in spans])
    if len(vectors) != len(spans):
        raise ValueError("invalid embeddings")
    return {
        "profile": PROFILE,
        "chunks": [
            {"text": text, "embedding": vector, "start": start, "end": end, "page": page}
            for (text, start, end, page), vector in zip(spans, vectors, strict=True)
        ],
        "truncated": truncated,
    }


def main() -> None:
    # Do not run an untrusted-content embedding child where the POSIX resource
    # boundary is absent. The parent's wall-clock timeout is not equivalent.
    if resource is None:
        sys.stdout.write(json.dumps({"error": "processor_unavailable"}))
        return
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (80, 80))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (8 * 1024 * 1024 * 1024,) * 2)
    try:
        value = json.loads(sys.stdin.buffer.read(INDEX_TEXT_BYTES * 6 + 4097))
        if len(sys.argv) != 2 or sys.argv[1] not in {"embed", "query", "admit"}:
            raise ValueError("invalid operation")
        admission = sys.argv[1] == "admit"
        # Timing is authorized only for this exact public payload, never for a
        # person's query or an extra field smuggled into the startup operation.
        if admission and value != {"query": PUBLIC_ADMISSION_QUERY}:
            raise InvalidQuery("invalid admission")
        timings = EmbeddingAdmissionTimings() if admission else None
        with timings.measure("torch_setup") if timings else nullcontext():
            import torch

            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
        client = EmbeddingClient(local_files_only=True, admission_timings=timings)
        if sys.argv[1] in {"query", "admit"}:
            result = query_payload(client, value["query"])
            if timings is not None:
                result["admission_timings"] = timings.values
            sys.stdout.write(json.dumps(result))
            return
        pages = value["pages"]
        if (
            not isinstance(pages, list)
            or not 1 <= len(pages) <= 100
            or any(not isinstance(page, str) for page in pages)
            or sum(len(page.encode()) for page in pages) > INDEX_TEXT_BYTES
            or type(value["truncated"]) is not bool
        ):
            raise ValueError("invalid input")
        result = prepare_payload(client, ParsedText(tuple(pages), value["truncated"]))
    except InvalidQuery:
        result = {"error": "invalid_argument"}
    except Exception:
        result = {"error": "processor_unavailable"}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
