import uuid
from datetime import datetime

import chromadb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from core.analytics import analyze_productivity
from core.insights import generate_insights
from forecast_engine.forecast_router import process_forecast
from core.chat_agent import process_chat
from timeline_engine.timeline_router import process_timeline
from importance_engine.priority_router import process_priority_memories
from reflection_engine.reflection_router import process_reflections
from relationship_engine.relationship_router import process_relationships
from planning_engine.planning_router import process_goal
from evolution_engine.evolution_router import process_evolution
from metacognition_engine.metacognition_router import process_metacognition
from multiagent_engine.coordination_router import process_multiagent_coordination
from executive_engine.executive_router import process_executive_reasoning

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

class GoalInput(BaseModel):
    goal: str


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
    # =========================================================
# AUTONOMOUS MEMORY REFLECTION ENGINE
# =========================================================

@app.get("/memory-reflections")
def memory_reflections():

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

        reflection_results = process_reflections(
            combined_memories
        )

        return reflection_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    
    # =========================================================
# PREDICTIVE MEMORY FORECASTING ENGINE
# =========================================================

@app.get("/memory-forecast")
def memory_forecast():

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

        forecast_results = process_forecast(
            combined_memories
        )

        return forecast_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# CONTEXTUAL MEMORY RELATIONSHIP GRAPH ENGINE
# =========================================================

@app.get("/memory-relationships")
def memory_relationships():

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

        relationship_results = process_relationships(
            combined_memories
        )

        return relationship_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# GOAL-DRIVEN AUTONOMOUS PLANNING ENGINE
# =========================================================

@app.post("/generate-plan")
def generate_plan(goal_input: GoalInput):

    try:

        planning_results = process_goal(
            goal_input.goal
        )

        return planning_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# ADAPTIVE MEMORY EVOLUTION ENGINE
# =========================================================

@app.get("/memory-evolution")
def memory_evolution():

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

        evolution_results = process_evolution(
            combined_memories
        )

        return evolution_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# META-COGNITIVE SELF-EVALUATION ENGINE
# =========================================================

@app.get("/meta-cognition")
def meta_cognition():

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

        metacognition_results = process_metacognition(
            combined_memories
        )

        return metacognition_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# COLLABORATIVE MULTI-AGENT COORDINATION ENGINE
# =========================================================

@app.get("/multi-agent-coordination")
def multi_agent_coordination():

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

        coordination_results = process_multiagent_coordination(
            combined_memories
        )

        return coordination_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
    # =========================================================
# HIERARCHICAL EXECUTIVE DECISION ENGINE
# =========================================================

@app.get("/executive-decision")
def executive_decision():

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

        executive_results = process_executive_reasoning(
            combined_memories
        )

        return executive_results

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )