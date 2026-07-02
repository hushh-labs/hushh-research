import argparse
import json
import logging
import os
import sys
from typing import List, Optional, Union

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import onnxruntime_genai as og

logging.basicConfig(level=logging.INFO, format="[ai-runtime] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Hushh Local AI Runtime (ONNX/QNN)")

# Global model and tokenizer state
model: Optional[og.Model] = None
tokenizer: Optional[og.Tokenizer] = None

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 1024
    stream: Optional[bool] = False

@app.on_event("startup")
async def startup_event():
    global model, tokenizer
    parser = argparse.ArgumentParser(description="Hushh AI Runtime")
    parser.add_argument("--model-dir", type=str, required=True, help="Path to the ONNX model directory (must contain .onnx, .bin, tokenizer.json, etc.)")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on")
    
    # We parse known args so uvicorn's args don't crash the script if passed
    args, _ = parser.parse_known_args()
    
    model_dir = args.model_dir
    if not os.path.exists(model_dir):
        logger.error(f"Model directory not found: {model_dir}")
        sys.exit(1)
        
    logger.info(f"Loading ONNX model from: {model_dir}")
    try:
        # Load the model and tokenizer from the downloaded folder
        model = og.Model(model_dir)
        tokenizer = og.Tokenizer(model)
        logger.info("Successfully loaded model and tokenizer into memory.")
    except Exception as e:
        logger.error(f"Failed to load ONNX model: {e}")
        sys.exit(1)

def _generate_stream(prompt: str, max_tokens: int, temperature: float):
    global model, tokenizer
    
    # 1. Tokenize the prompt
    input_tokens = tokenizer.encode(prompt)
    
    # 2. Setup Generator Params
    params = og.GeneratorParams(model)
    params.set_search_options(max_length=len(input_tokens) + max_tokens)
    if temperature > 0:
        params.set_search_options(temperature=temperature)
    
    # 3. Target QNN (Qualcomm Neural Network) if available, otherwise CPU/DirectML
    # QNN HTP (Hexagon Tensor Processor) is the specific NPU backend for Snapdragon.
    try:
        # We explicitly request the QNN execution provider
        # (This will failover gracefully to CPU if the DLLs are missing or not supported on this device)
        params.try_graph_capture_with_max_batch_size(1) 
    except Exception as e:
        logger.warning(f"Graph capture failed (normal for some EPs): {e}")

    params.input_ids = input_tokens
    
    # 4. Create the generator
    generator = og.Generator(model, params)
    
    try:
        while not generator.is_done():
            generator.compute_logits()
            generator.generate_next_token()
            
            # Extract the single new token
            new_token_id = generator.get_next_tokens()[0]
            
            # Decode just that token
            # Note: decoding single tokens can sometimes buffer incomplete UTF-8 bytes,
            # but og.Tokenizer.decode() usually handles basic ascii chunks fine.
            new_text = tokenizer.decode([new_token_id])
            
            # Yield in OpenAI SSE format
            chunk = {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "choices": [{"delta": {"content": new_text}}]
            }
            yield f"data: {json.dumps(chunk)}\n\n"
            
    except Exception as e:
        logger.error(f"Generation error: {e}")
    finally:
        yield "data: [DONE]\n\n"
        # generator is automatically destroyed/cleaned up by Python GC

@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    if not model or not tokenizer:
        raise HTTPException(status_code=500, detail="Model is not loaded.")
        
    # Convert messages to a simple prompt string (very basic ChatML / Llama 3 formatting)
    # A robust implementation would use tokenizer.apply_chat_template() if available,
    # but for now we manually format basic Llama 3 structural tags.
    prompt_lines = []
    for msg in req.messages:
        prompt_lines.append(f"<|start_header_id|>{msg.role}<|end_header_id|>\n\n{msg.content}<|eot_id|>")
    prompt_lines.append("<|start_header_id|>assistant<|end_header_id|>\n\n")
    
    full_prompt = "".join(prompt_lines)
    
    logger.info(f"Incoming prompt ({len(req.messages)} messages). Stream: {req.stream}")
    
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
        
        output_tokens = model.generate(params)
        # model.generate returns a list of lists (batch size 1)
        response_text = tokenizer.decode(output_tokens[0][len(input_tokens):])
        
        return {
            "id": "chatcmpl-local",
            "object": "chat.completion",
            "choices": [{"message": {"role": "assistant", "content": response_text}}]
        }

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    args, _ = parser.parse_known_args()
    
    uvicorn.run("main:app", host="127.0.0.1", port=args.port)
