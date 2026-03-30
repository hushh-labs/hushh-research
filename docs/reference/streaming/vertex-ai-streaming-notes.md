# Vertex AI Streaming Notes


## Visual Context

Canonical visual owner: [Streaming Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

Reference notes for model-correct streaming behavior.

## Core Guidance

- Use Vertex streaming APIs for incremental output:
  - Python SDK: `generate_content_stream`
  - REST/SDK equivalents of `streamGenerateContent`
- Treat thought summaries as optional telemetry.
- For Gemini 3 family, use model-correct thinking controls (`thinking_level`).
- For extraction flows, require JSON output mode + schema.

## Reliability Rules

- Always keep app progress independent of thought availability.
- Parse stream chunks incrementally but assemble complete SSE frames before JSON parse.
- Fail fast on invalid envelope shape or event mismatch.
- Mark completion and error as terminal events and close listeners deterministically.

## Anti-Patterns

- Depending on thought events for state progression.
- Mixing multiple stream payload formats in one consumer.
- Parsing only single `data:` lines without multiline support.
- Building route-local stream parsers instead of shared runtime utilities.

## Official References

- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/generativeaionvertexai-gemini-controlled-generation-response-schema-2
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/generativeaionvertexai-gemini-controlled-generation-response-schema
