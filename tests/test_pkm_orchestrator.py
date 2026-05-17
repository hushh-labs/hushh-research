import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]

sys.path.append(
    str(
        ROOT_DIR / "agents" / "personal-memory-agent"
    )
)

from orchestration_engine.pkm_orchestrator import (
    PKMOrchestrator,
)


def test_pkm_memory_pipeline():

    orchestrator = PKMOrchestrator()

    memories = [
        {
            "memory_id": "m1",
            "vault_id": "v1",
            "content": "important memory",
            "timestamp":
                "2026-05-18T10:00:00",
            "interaction_count": 10,
            "emotional_weight": 9,
            "is_pinned": True,
            "related_memories": [],
        },
        {
            "memory_id": "m2",
            "vault_id": "v1",
            "content": "secondary memory",
            "timestamp":
                "2026-05-19T10:00:00",
            "interaction_count": 2,
            "emotional_weight": 2,
            "is_pinned": False,
            "related_memories": [],
        },
    ]

    result = (
        orchestrator.process_memories(
            memories
        )
    )

    assert (
        result["total_processed"] == 2
    )

    assert (
        "processed_memories"
        in result
    )

    assert (
        result["processed_memories"][0]
        ["importance_score"]
        >= 0
    )