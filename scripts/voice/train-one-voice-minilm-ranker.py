#!/usr/bin/env python3
"""Train and package the generated One Voice MiniLM semantic ranker.

The public ``all-MiniLM-L6-v2`` encoder is frozen. This command trains the
small Hushh-specific pairwise ranking head from the generated action catalog,
merges no user data, and emits a self-contained ZIP model pack containing:

* ``encoder.onnx`` - the quantized MiniLM sentence encoder;
* ``ranker.onnx`` - the quantized app-specific pairwise ranking head;
* ``tokenizer.json`` - matching public tokenizer;
* ``action-index.json`` - generated action-id order;
* ``manifest.json`` - reproducibility and runtime metadata.

The pack is deployment input. Keep it outside the repo and publish it through
the signed model-pack workflow. No application records or user transcripts are
accepted by this command.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic
from tokenizers import Tokenizer


MODEL_REPO = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
MODEL_URL = (
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/"
    f"{MODEL_REVISION}/onnx/model_qint8_arm64.onnx"
)
TOKENIZER_URL = (
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/"
    f"{MODEL_REVISION}/tokenizer.json"
)
GATEWAY_PATH = Path("hushh-webapp/contracts/kai/kai-action-gateway.vnext.json")
PREPROCESSING_VERSION = "minilm-action-head-v1"
ENTRYPOINT = "one_voice_intent_ranker_v2"
RANKER_RELEASE_VERSION = "1.0.0"
MAX_SEQUENCE_LENGTH = 128
PAIR_FEATURE_DIMENSION = 4 * 384


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "hussh-one-voice-builder/1"})
    with urllib.request.urlopen(request, timeout=180) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"expected object: {path}")
    return payload


def encode(tokenizer: Tokenizer, utterances: list[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    tokenizer.enable_truncation(max_length=MAX_SEQUENCE_LENGTH)
    tokenizer.enable_padding(length=MAX_SEQUENCE_LENGTH, pad_id=0, pad_token="[PAD]")
    encoded = tokenizer.encode_batch(utterances)
    return (
        np.asarray([item.ids for item in encoded], dtype=np.int64),
        np.asarray([item.attention_mask for item in encoded], dtype=np.int64),
        np.asarray([item.type_ids for item in encoded], dtype=np.int64),
    )


def mean_pool(last_hidden_state: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    mask = attention_mask.astype(np.float32)[..., None]
    pooled = (last_hidden_state * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.maximum(norms, 1e-9)


def run_encoder(
    session: ort.InferenceSession,
    input_ids: np.ndarray,
    attention_mask: np.ndarray,
    token_type_ids: np.ndarray,
    batch_size: int = 32,
) -> np.ndarray:
    input_names = {item.name for item in session.get_inputs()}
    output_name = session.get_outputs()[0].name
    batches: list[np.ndarray] = []
    for start in range(0, len(input_ids), batch_size):
        finish = start + batch_size
        inputs: dict[str, np.ndarray] = {
            "input_ids": input_ids[start:finish],
            "attention_mask": attention_mask[start:finish],
        }
        if "token_type_ids" in input_names:
            inputs["token_type_ids"] = token_type_ids[start:finish]
        output = session.run([output_name], inputs)[0]
        batches.append(mean_pool(output, attention_mask[start:finish]))
    return np.concatenate(batches, axis=0) if batches else np.empty((0, 384), dtype=np.float32)


def action_text(action: dict[str, Any]) -> str:
    return " ".join(
        [
            str(action.get("action_id", "")),
            str(action.get("label", "")),
            str(action.get("meaning", "")),
            *(str(value) for value in action.get("aliases", [])),
            *(str(value) for value in action.get("search_keywords", [])),
        ]
    )


def build_pair_examples(
    dataset: dict[str, Any],
    action_texts: dict[str, str],
) -> tuple[list[str], list[str], np.ndarray, list[str]]:
    left: list[str] = []
    right: list[str] = []
    labels: list[float] = []
    seen_actions: set[str] = set()
    for example in dataset.get("positive_examples", []):
        if not isinstance(example, dict):
            continue
        utterance = example.get("utterance")
        action_id = example.get("action_id")
        if not isinstance(utterance, str) or action_id not in action_texts:
            continue
        left.append(utterance)
        right.append(action_texts[action_id])
        labels.append(1.0)
        seen_actions.add(action_id)
    for pair in dataset.get("hard_negative_pairs", []):
        if not isinstance(pair, dict):
            continue
        utterance = pair.get("utterance")
        action_id = pair.get("negative_action_id")
        if not isinstance(utterance, str) or action_id not in action_texts:
            continue
        left.append(utterance)
        right.append(action_texts[action_id])
        labels.append(0.0)
    if not left:
        raise ValueError("dataset did not produce pair examples")
    return left, right, np.asarray(labels, dtype=np.float32), sorted(seen_actions)


def pair_features(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    return np.concatenate([left, right, np.abs(left - right), left * right], axis=1).astype(np.float32)


def train_pair_head(features: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, float]:
    weights = np.zeros(features.shape[1], dtype=np.float32)
    bias = 0.0
    learning_rate = 0.2
    regularization = 0.0001
    for _ in range(500):
        logits = np.clip(features @ weights + bias, -30, 30)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        error = probabilities - labels
        weights -= learning_rate * ((features.T @ error) / len(labels) + regularization * weights)
        bias -= learning_rate * float(error.mean())
        learning_rate *= 0.997
    return weights.astype(np.float32), float(bias)


def build_ranker_graph(output: Path, weights: np.ndarray, bias: float) -> None:
    graph = helper.make_graph(
        [
            helper.make_node("MatMul", ["pair_features", "weights"], ["weighted_score"]),
            helper.make_node("Add", ["weighted_score", "bias"], ["score"]),
        ],
        "one_voice_pair_ranker",
        [helper.make_tensor_value_info("pair_features", TensorProto.FLOAT, ["batch_size", PAIR_FEATURE_DIMENSION])],
        [helper.make_tensor_value_info("score", TensorProto.FLOAT, ["batch_size", 1])],
        initializer=[
            numpy_helper.from_array(weights.reshape(PAIR_FEATURE_DIMENSION, 1), name="weights"),
            numpy_helper.from_array(np.asarray([bias], dtype=np.float32), name="bias"),
        ],
    )
    model = helper.make_model(
        graph,
        producer_name="hussh-one-voice",
        opset_imports=[helper.make_operatorsetid("", 17)],
    )
    onnx.checker.check_model(model)
    onnx.save(model, str(output))


def evaluate(features: np.ndarray, labels: np.ndarray, weights: np.ndarray, bias: float) -> dict[str, float]:
    probabilities = 1.0 / (1.0 + np.exp(-np.clip(features @ weights + bias, -30, 30)))
    predictions = probabilities >= 0.5
    return {
        "pair_accuracy": float((predictions == labels.astype(bool)).mean()),
        "positive_count": float(labels.sum()),
        "negative_count": float((labels == 0).sum()),
    }


def package_pack(
    destination: Path,
    encoder_path: Path,
    ranker_path: Path,
    tokenizer_path: Path,
    action_ids: list[str],
    dataset_path: Path,
    metrics: dict[str, float],
) -> None:
    dataset_sha256 = sha256(dataset_path)
    pack_manifest = {
        "schema_version": "one-voice-model-pack.v1",
        "pack_id": "one-voice-en-intent-minilm-v1",
        # The data digest makes every generated pack addressable and keeps a
        # prior model available for rollback when authored examples change.
        "version": f"{RANKER_RELEASE_VERSION}-{dataset_sha256[:12]}",
        "runtime": "onnxruntime_web",
        "entrypoint": ENTRYPOINT,
        "preprocessing_version": PREPROCESSING_VERSION,
        "language": "en",
        "model": MODEL_REPO,
        "model_revision": MODEL_REVISION,
        "encoder_sha256": sha256(encoder_path),
        "ranker_sha256": sha256(ranker_path),
        "tokenizer_sha256": sha256(tokenizer_path),
        "catalog_version": "kai-action-gateway.vnext",
        "catalog_action_count": len(action_ids),
        "training_data_sha256": dataset_sha256,
        "metrics": metrics,
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        def write_member(name: str, content: bytes) -> None:
            # ZIP file timestamps otherwise inherit the download/build clock,
            # changing the signed artifact hash even when model bytes and
            # generated training data are identical.
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)

        write_member("encoder.onnx", encoder_path.read_bytes())
        write_member("ranker.onnx", ranker_path.read_bytes())
        write_member("tokenizer.json", tokenizer_path.read_bytes())
        write_member("action-index.json", json.dumps(action_ids, separators=(",", ":")).encode())
        write_member("manifest.json", (json.dumps(pack_manifest, indent=2, sort_keys=True) + "\n").encode())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--gateway", type=Path, default=GATEWAY_PATH)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backbone", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--work-dir", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset = load_json(args.dataset)
    gateway = load_json(args.gateway)
    actions = gateway.get("actions")
    if not isinstance(actions, list):
        raise ValueError("gateway has no actions")
    action_texts = {
        str(action["action_id"]): action_text(action)
        for action in actions
        if isinstance(action, dict) and action.get("action_id")
    }
    left, right, labels, action_ids = build_pair_examples(dataset, action_texts)

    owned_work_dir = args.work_dir is None
    work_dir = args.work_dir or Path(tempfile.mkdtemp(prefix="one-voice-minilm-"))
    work_dir.mkdir(parents=True, exist_ok=True)
    backbone = args.backbone or work_dir / "encoder.onnx"
    tokenizer_path = args.tokenizer or work_dir / "tokenizer.json"
    if not backbone.exists():
        download(MODEL_URL, backbone)
    if not tokenizer_path.exists():
        download(TOKENIZER_URL, tokenizer_path)

    tokenizer = Tokenizer.from_file(str(tokenizer_path))
    unique_texts = sorted(set(left + right))
    unique_ids, unique_mask, unique_types = encode(tokenizer, unique_texts)
    encoder_session = ort.InferenceSession(str(backbone), providers=["CPUExecutionProvider"])
    unique_embeddings = run_encoder(encoder_session, unique_ids, unique_mask, unique_types)
    text_embeddings = {
        text: unique_embeddings[index]
        for index, text in enumerate(unique_texts)
    }
    left_embeddings = np.asarray([text_embeddings[text] for text in left], dtype=np.float32)
    right_embeddings = np.asarray([text_embeddings[text] for text in right], dtype=np.float32)
    features = pair_features(left_embeddings, right_embeddings)
    weights, bias = train_pair_head(features, labels)
    metrics = evaluate(features, labels, weights, bias)
    print(json.dumps({"actions": len(action_ids), "metrics": metrics}, sort_keys=True))
    if metrics["pair_accuracy"] < 0.80:
        raise SystemExit("MiniLM ranker quality gate failed")

    ranker_fp32 = work_dir / "ranker-fp32.onnx"
    ranker_qint8 = work_dir / "ranker-qint8.onnx"
    build_ranker_graph(ranker_fp32, weights, bias)
    quantize_dynamic(
        str(ranker_fp32),
        str(ranker_qint8),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
    )
    ranker_session = ort.InferenceSession(str(ranker_qint8), providers=["CPUExecutionProvider"])
    output = ranker_session.run(None, {"pair_features": features[:2]})[0]
    if output.shape != (2, 1):
        raise SystemExit(f"ranker output contract failed: {output.shape}")
    package_pack(args.output, backbone, ranker_qint8, tokenizer_path, action_ids, args.dataset, metrics)
    print(json.dumps({"pack": str(args.output), "sha256": sha256(args.output), "bytes": args.output.stat().st_size}, sort_keys=True))
    if owned_work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
