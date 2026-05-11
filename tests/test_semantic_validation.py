import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from scripts.check_semantic_search_health import validate_embeddings


def test_valid_embeddings():
    sample_data = [
        {
            "id": "doc_1",
            "embedding": [0.1, 0.2, 0.3],
            "metadata": {"title": "Test"}
        }
    ]

    issues = validate_embeddings(sample_data)

    assert len(issues) == 0