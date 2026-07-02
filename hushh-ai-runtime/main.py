import argparse
import json
import logging
import os
import sys
import threading
from contextlib import asynccontextmanager
from typing import List, Optional, Union

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import onnxruntime_genai as og

logging.basicConfig(level=logging.INFO, format="[ai-runtime] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# Global state
model: Optional[og.Model] = None
tokenizer: Optional[og.Tokenizer] = None
MODEL_READY = False
MODEL_LOADING_ERROR = None

# 1. PyInstaller DLL Pathing Fix
if getattr(sys, 'frozen', False):
    # Running as compiled PyInstaller executable
    base_path = sys._MEIPASS
else:
    # Running in a normal Python environment
    base_path = os.path.dirname(os.path.abspath(__file__))

qnn_dll_path = os.path.join(base_path, "QnnHtp.dll")

def load_model_background(model_dir: str):
    global model, tokenizer, MODEL_READY, MODEL_LOADING_ERROR
    logger.info(f"Background thread starting model load from: {model_dir}")
    try:
        # Pass QNN execution provider options if needed here
        model = og.Model(model_dir)
        tokenizer = og.Tokenizer(model)
        MODEL_READY = True
        logger.info("✅ Successfully loaded ONNX model and tokenizer into NPU memory.")
    except Exception as e:
        logger.error(f"❌ Failed to load ONNX model: {e}")
        MODEL_LOADING_ERROR = str(e)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup
    parser = argparse.ArgumentParser(description="Hushh AI Runtime")
    parser.add_argument("--model-dir", type=str, required=True)
    parser.add_argument("--port", type=int, default=8001)
    args, _ = parser.parse_known_args()
    
    if not os.path.exists(args.model_dir):
        logger.error(f"Model directory not found: {args.model_dir}")
        sys.exit(1)
        
    # 2. Prevent Cold Boot Penalty (Non-blocking load)
    thread = threading.Thread(target=load_model_background, args=(args.model_dir,), daemon=True)
    thread.start()
    
    yield
    # Teardown logic can go here

app = FastAPI(title="Hushh Local AI Runtime (ONNX/QNN)", lifespan=lifespan)

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 1024
    stream: Optional[bool] = False

def _generate_stream(prompt: str, max_tokens: int, temperature: float):
    global model, tokenizer
    
    input_tokens = tokenizer.encode(prompt)
    params = og.GeneratorParams(model)
    params.set_search_options(max_length=len(input_tokens) + max_tokens)
    if temperature > 0:
        params.set_search_options(temperature=temperature)
        
    params.input_ids = input_tokens
    
    try:
        # 3. Handle NPU "Device Busy" Exceptions Gracefully
        generator = og.Generator(model, params)
    except Exception as e:
        logger.error(f"NPU Generator Initialization Failed: {e}")
        yield f"data: {json.dumps({'error': 'npu_busy', 'fallback_available': True})}\n\n"
        yield "data: [DONE]\n\n"
        return
    
    try:
        while not generator.is_done():
            generator.compute_logits()
            generator.generate_next_token()
            
            new_token_id = generator.get_next_tokens()[0]
            new_text = tokenizer.decode([new_token_id])
            
            chunk = {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "choices": [{"delta": {"content": new_text}}]
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            
    except Exception as e:
        logger.error(f"Generation error: {e}")
        yield f"data: {json.dumps({'error': 'generation_failed', 'details': str(e)})}\n\n"
    finally:
        yield "data: [DONE]\n\n"

@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    if MODEL_LOADING_ERROR:
        return JSONResponse(status_code=500, content={"error": "model_failed_to_load", "details": MODEL_LOADING_ERROR})
    
    if not MODEL_READY:
        return JSONResponse(status_code=503, content={"status": "loading_weights", "message": "The ONNX model is currently loading into NPU memory. Please retry in a few seconds."})
        
    prompt_lines = []
    for msg in req.messages:
        prompt_lines.append(f"<|start_header_id|>{msg.role}<|end_header_id|>\n\n{msg.content}<|eot_id|>")
    prompt_lines.append("<|start_header_id|>assistant<|end_header_id|>\n\n")
    full_prompt = "".join(prompt_lines)
    
    logger.info(f"Processing inference prompt. Stream: {req.stream}")
    
    if req.stream:
        return StreamingResponse(
            _generate_stream(full_prompt, req.max_tokens, req.temperature),
            media_type="text/event-stream"
        )
    else:
        # Non-streaming fallback
        input_tokens = tokenizer.encode(full_prompt)
        params = og.GeneratorParams(model)
        params.set_search_options(max_length=len(input_tokens) + req.max_tokens)
        params.input_ids = input_tokens
        
        try:
            output_tokens = model.generate(params)
            response_text = tokenizer.decode(output_tokens[0][len(input_tokens):])
            return {
                "id": "chatcmpl-local",
                "object": "chat.completion",
                "choices": [{"message": {"role": "assistant", "content": response_text}}]
            }
        except Exception as e:
            logger.error(f"NPU Generation Failed: {e}")
            return JSONResponse(status_code=500, content={"error": "npu_busy", "fallback_available": True})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    args, _ = parser.parse_known_args()
    
    uvicorn.run("main:app", host="127.0.0.1", port=args.port)
