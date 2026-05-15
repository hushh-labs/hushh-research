from core.router import detect_intent
from core.response_generator import generate_response
from core.analytics import analyze_productivity
from core.insights import generate_insights


def process_chat(query, collection, model):

    intent = detect_intent(query)

    query_embedding = model.encode(query).tolist()

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=5
    )

    documents = results.get("documents", [[]])[0]

    metadatas = results.get("metadatas", [[]])[0]

    combined_memories = []

    for doc, metadata in zip(documents, metadatas):

        combined_memories.append(
            {
                "document": doc,
                "metadata": metadata
            }
        )

    analytics = analyze_productivity(combined_memories)

    insights = generate_insights(analytics)

    return generate_response(
        intent,
        documents,
        insights
    )