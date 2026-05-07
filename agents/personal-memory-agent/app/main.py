import uuid
from datetime import datetime

import chromadb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

# =========================================================
# FASTAPI INITIALIZATION
# =========================================================

app = FastAPI(
    title="Personal Memory Intelligence Agent",
    description="AI-powered semantic memory retrieval system",
    version="1.0.0"
)

# =========================================================
# CHROMADB SETUP
# =========================================================

client = chromadb.PersistentClient(path="./data/memory_store")

collection = client.get_or_create_collection(
    name="personal_memories"
)

# =========================================================
# EMBEDDING MODEL
# =========================================================

model = SentenceTransformer("all-MiniLM-L6-v2")

# =========================================================
# REQUEST MODELS
# =========================================================

class MemoryInput(BaseModel):
    text: str
    category: str


class QueryInput(BaseModel):
    question: str


# =========================================================
# ROOT ENDPOINT
# =========================================================

@app.get("/")
def home():

    return {
        "message": "Personal Memory Intelligence Agent Running Successfully"
    }


# =========================================================
# STORE MEMORY
# =========================================================

@app.post("/store-memory")
def store_memory(memory: MemoryInput):

    try:

        memory_id = str(uuid.uuid4())

        embedding = model.encode(memory.text).tolist()

        collection.add(
            ids=[memory_id],
            embeddings=[embedding],
            documents=[memory.text],
            metadatas=[
                {
                    "category": memory.category,
                    "timestamp": str(datetime.utcnow())
                }
            ]
        )

        return {
            "status": "success",
            "memory_id": memory_id,
            "stored_memory": memory.text
        }

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )


# =========================================================
# SEARCH MEMORY
# =========================================================

@app.post("/search-memory")
def search_memory(query: QueryInput):

    try:

        query_embedding = model.encode(query.question).tolist()

        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=5
        )

        formatted_results = []

        documents = results.get("documents", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]

        for doc, metadata in zip(documents, metadatas):

            formatted_results.append(
                {
                    "memory": doc,
                    "category": metadata.get("category"),
                    "timestamp": metadata.get("timestamp")
                }
            )

        return {
            "question": query.question,
            "results": formatted_results
        }

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )


# =========================================================
# MEMORY COUNT
# =========================================================

@app.get("/memory-count")
def memory_count():

    try:

        count = collection.count()

        return {
            "total_memories": count
        }

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )