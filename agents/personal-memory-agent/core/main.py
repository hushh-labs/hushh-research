import uuid
from datetime import datetime

import chromadb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from core.analytics import analyze_productivity
from core.insights import generate_insights
from core.chat_agent import process_chat
from timeline_engine.timeline_router import process_timeline
from importance_engine.priority_router import process_priority_memories

# =========================================================
# FASTAPI INITIALIZATION
# =========================================================

app = FastAPI(
    title="Conversational Memory Query Agent",
    description="AI-powered conversational memory intelligence system",
    version="3.0.0"
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


class ChatInput(BaseModel):
    message: str


# =========================================================
# ROOT ENDPOINT
# =========================================================

@app.get("/")
def home():

    return {
        "message": "Conversational Memory Query Agent Running"
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
# GENERATE INSIGHTS
# =========================================================

@app.get("/generate-insights")
def get_insights():

    try:

        results = collection.get()

        documents = results.get("documents", [])

        metadatas = results.get("metadatas", [])

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

        return {
            "analytics": analytics,
            "insights": insights
        }

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )


# =========================================================
# CONVERSATIONAL CHAT AGENT
# =========================================================

@app.post("/chat")
def chat(chat_input: ChatInput):

    try:

        response = process_chat(
            chat_input.message,
            collection,
            model
        )

        return response

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
   # =========================================================
# MEMORY TIMELINE ENGINE
# =========================================================

@app.get("/memory-timeline")
def memory_timeline():

    try:

        results = collection.get()

        documents = results.get("documents", [])

        metadatas = results.get("metadatas", [])

        combined_memories = []

        for doc, metadata in zip(documents, metadatas):

            combined_memories.append(
                {
                    "document": doc,
                    "metadata": metadata
                }
            )

        timeline_results = process_timeline(
            combined_memories
        )

        return timeline_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# ADAPTIVE MEMORY IMPORTANCE ENGINE
# =========================================================

@app.get("/priority-memories")
def priority_memories():

    try:

        results = collection.get()

        documents = results.get("documents", [])

        metadatas = results.get("metadatas", [])

        combined_memories = []

        for doc, metadata in zip(documents, metadatas):

            combined_memories.append(
                {
                    "document": doc,
                    "metadata": metadata
                }
            )

        priority_results = process_priority_memories(
            combined_memories
        )

        return priority_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )