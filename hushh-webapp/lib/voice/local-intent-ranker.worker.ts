import * as ort from "onnxruntime-web";
import { strFromU8, unzipSync } from "fflate";

type Candidate = { actionId: string; text: string };
type WorkerRequest =
  | { type: "load"; modelBytes: ArrayBuffer; preprocessingVersion: string }
  | { type: "rank"; requestId: string; utterance: string; candidates: Candidate[] };

const HASH_FEATURE_DIMENSION = 256;
const MINILM_SEQUENCE_LENGTH = 128;
const MINILM_HIDDEN_SIZE = 384;
const MINILM_PAIR_FEATURE_SIZE = MINILM_HIDDEN_SIZE * 4;

type MiniLmTokenizer = {
  model: {
    vocab: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
};

let preprocessingVersion = "";
let hashSession: ort.InferenceSession | null = null;
let encoderSession: ort.InferenceSession | null = null;
let rankerSession: ort.InferenceSession | null = null;
let tokenizer: MiniLmTokenizer | null = null;
let actionIndex = new Set<string>();

function post(message: unknown): void {
  (globalThis as unknown as { postMessage: (value: unknown) => void }).postMessage(message);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function featureVector(value: string): Float32Array {
  const result = new Float32Array(HASH_FEATURE_DIMENSION);
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  for (const word of words) {
    let hash = 2166136261;
    for (let index = 0; index < word.length; index += 1) {
      hash ^= word.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = (hash >>> 0) % HASH_FEATURE_DIMENSION;
    result[bucket] = (result[bucket] ?? 0) + 1;
  }
  return result;
}

function makeHashFeatures(utterance: string, candidates: Candidate[]): Float32Array {
  const utteranceVector = featureVector(utterance);
  const result = new Float32Array(candidates.length * HASH_FEATURE_DIMENSION * 2);
  candidates.forEach((candidate, index) => {
    const candidateVector = featureVector(candidate.text);
    const offset = index * HASH_FEATURE_DIMENSION * 2;
    result.set(utteranceVector, offset);
    result.set(candidateVector, offset + HASH_FEATURE_DIMENSION);
  });
  return result;
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function isPunctuation(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

function isChineseCharacter(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function preTokenize(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current) parts.push(current);
    current = "";
  };
  for (const character of value) {
    if (isWhitespace(character) || isPunctuation(character) || isChineseCharacter(character)) {
      flush();
      if (!isWhitespace(character)) parts.push(character);
      continue;
    }
    current += character;
  }
  flush();
  return parts;
}

function wordPieceTokenize(value: string, model: MiniLmTokenizer["model"]): string[] {
  const vocab = model.vocab;
  const unknown = model.unk_token ?? "[UNK]";
  const prefix = model.continuing_subword_prefix ?? "##";
  const maxChars = model.max_input_chars_per_word ?? 100;
  if (value.length > maxChars) return [unknown];
  const pieces: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = value.length;
    let match: string | null = null;
    while (start < end) {
      const candidate = `${start > 0 ? prefix : ""}${value.slice(start, end)}`;
      if (vocab[candidate] !== undefined) {
        match = candidate;
        break;
      }
      end -= 1;
    }
    if (!match) return [unknown];
    pieces.push(match);
    start = end;
  }
  return pieces;
}

function encodeText(value: string, model: MiniLmTokenizer): {
  ids: BigInt64Array;
  mask: BigInt64Array;
  types: BigInt64Array;
} {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .toLocaleLowerCase();
  const tokens = preTokenize(normalized).flatMap((token) => wordPieceTokenize(token, model.model));
  const ids = new BigInt64Array(MINILM_SEQUENCE_LENGTH);
  const mask = new BigInt64Array(MINILM_SEQUENCE_LENGTH);
  const types = new BigInt64Array(MINILM_SEQUENCE_LENGTH);
  const pad = model.model.vocab["[PAD]"] ?? 0;
  const cls = model.model.vocab["[CLS]"] ?? 101;
  const sep = model.model.vocab["[SEP]"] ?? 102;
  ids.fill(BigInt(pad));
  const bounded = tokens.slice(0, MINILM_SEQUENCE_LENGTH - 2);
  const sequence = ["[CLS]", ...bounded, "[SEP]"];
  sequence.forEach((token, index) => {
    ids[index] = BigInt(model.model.vocab[token] ?? model.model.vocab["[UNK]"] ?? 100);
    mask[index] = 1n;
  });
  ids[0] = BigInt(cls);
  ids[sequence.length - 1] = BigInt(sep);
  return { ids, mask, types };
}

function makeMiniLmInputs(values: string[]): Record<string, ort.Tensor> {
  if (!tokenizer) throw new Error("local_intent_tokenizer_missing");
  const ids = new BigInt64Array(values.length * MINILM_SEQUENCE_LENGTH);
  const mask = new BigInt64Array(values.length * MINILM_SEQUENCE_LENGTH);
  const types = new BigInt64Array(values.length * MINILM_SEQUENCE_LENGTH);
  values.forEach((value, row) => {
    const encoded = encodeText(value, tokenizer!);
    ids.set(encoded.ids, row * MINILM_SEQUENCE_LENGTH);
    mask.set(encoded.mask, row * MINILM_SEQUENCE_LENGTH);
    types.set(encoded.types, row * MINILM_SEQUENCE_LENGTH);
  });
  return {
    input_ids: new ort.Tensor("int64", ids, [values.length, MINILM_SEQUENCE_LENGTH]),
    attention_mask: new ort.Tensor("int64", mask, [values.length, MINILM_SEQUENCE_LENGTH]),
    token_type_ids: new ort.Tensor("int64", types, [values.length, MINILM_SEQUENCE_LENGTH]),
  };
}

function meanPool(output: ort.Tensor, attentionMask: ort.Tensor, row: number): Float32Array {
  const hidden = output.data as Float32Array;
  const mask = attentionMask.data as BigInt64Array;
  const result = new Float32Array(MINILM_HIDDEN_SIZE);
  let count = 0;
  for (let token = 0; token < MINILM_SEQUENCE_LENGTH; token += 1) {
    if (mask[row * MINILM_SEQUENCE_LENGTH + token] === 0n) continue;
    count += 1;
    const sourceOffset = (row * MINILM_SEQUENCE_LENGTH + token) * MINILM_HIDDEN_SIZE;
    for (let dimension = 0; dimension < MINILM_HIDDEN_SIZE; dimension += 1) {
      result[dimension] = (result[dimension] ?? 0) + (hidden[sourceOffset + dimension] ?? 0);
    }
  }
  const scale = 1 / Math.max(count, 1);
  let norm = 0;
  for (let dimension = 0; dimension < result.length; dimension += 1) {
    result[dimension] = (result[dimension] ?? 0) * scale;
    norm += result[dimension]! * result[dimension]!;
  }
  const inverseNorm = 1 / Math.max(Math.sqrt(norm), 1e-9);
  for (let dimension = 0; dimension < result.length; dimension += 1) {
    result[dimension] = (result[dimension] ?? 0) * inverseNorm;
  }
  return result;
}

async function encodeMiniLm(values: string[]): Promise<Float32Array[]> {
  if (!encoderSession) throw new Error("local_intent_encoder_missing");
  const inputs = makeMiniLmInputs(values);
  const output = await encoderSession.run(inputs);
  const hidden = output[encoderSession.outputNames[0]!];
  if (!hidden) throw new Error("local_intent_encoder_output_missing");
  return values.map((_, row) => meanPool(hidden, inputs.attention_mask!, row));
}

function makePairFeatures(utterance: Float32Array, candidates: Float32Array[]): Float32Array {
  const result = new Float32Array(candidates.length * MINILM_PAIR_FEATURE_SIZE);
  candidates.forEach((candidate, index) => {
    const offset = index * MINILM_PAIR_FEATURE_SIZE;
    for (let dimension = 0; dimension < MINILM_HIDDEN_SIZE; dimension += 1) {
      const left = utterance[dimension] ?? 0;
      const right = candidate[dimension] ?? 0;
      result[offset + dimension] = left;
      result[offset + MINILM_HIDDEN_SIZE + dimension] = right;
      result[offset + MINILM_HIDDEN_SIZE * 2 + dimension] = Math.abs(left - right);
      result[offset + MINILM_HIDDEN_SIZE * 3 + dimension] = left * right;
    }
  });
  return result;
}

async function rankMiniLm(utterance: string, candidates: Candidate[]): Promise<{ actionId: string; confidence: number; margin: number } | null> {
  if (!encoderSession || !rankerSession || !tokenizer) throw new Error("local_intent_ranker_not_ready");
  const boundedCandidates = candidates.filter((candidate) => actionIndex.has(candidate.actionId));
  if (!boundedCandidates.length) return null;
  const embeddings = await encodeMiniLm([utterance, ...boundedCandidates.map((candidate) => candidate.text)]);
  const pair = makePairFeatures(embeddings[0]!, embeddings.slice(1));
  const inputName = rankerSession.inputNames[0];
  const outputName = rankerSession.outputNames[0];
  const output = await rankerSession.run({
    [inputName!]: new ort.Tensor("float32", pair, [boundedCandidates.length, MINILM_PAIR_FEATURE_SIZE]),
  });
  const values = output[outputName!]?.data;
  if (!(values instanceof Float32Array) || values.length < boundedCandidates.length) {
    throw new Error("local_intent_ranker_output_invalid");
  }
  const ranked = boundedCandidates
    .map((candidate, index) => ({ actionId: candidate.actionId, score: Number(values[index] ?? 0) }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const second = ranked[1];
  if (!top) return null;
  const confidence = 1 / (1 + Math.exp(-top.score));
  const secondConfidence = second ? 1 / (1 + Math.exp(-second.score)) : 0;
  return {
    actionId: top.actionId,
    confidence,
    margin: Math.max(0, confidence - secondConfidence),
  };
}

async function loadMiniLmPack(modelBytes: ArrayBuffer): Promise<void> {
  const files = unzipSync(new Uint8Array(modelBytes));
  const encoder = files["encoder.onnx"];
  const ranker = files["ranker.onnx"];
  const tokenizerBytes = files["tokenizer.json"];
  const actionIndexBytes = files["action-index.json"];
  if (!encoder || !ranker || !tokenizerBytes || !actionIndexBytes) {
    throw new Error("local_intent_model_pack_invalid");
  }
  const parsedTokenizer: unknown = JSON.parse(strFromU8(tokenizerBytes));
  const parsedActions: unknown = JSON.parse(strFromU8(actionIndexBytes));
  if (!parsedTokenizer || typeof parsedTokenizer !== "object" || !Array.isArray(parsedActions)) {
    throw new Error("local_intent_model_pack_invalid");
  }
  tokenizer = parsedTokenizer as MiniLmTokenizer;
  actionIndex = new Set(parsedActions.filter((value): value is string => typeof value === "string"));
  if (!actionIndex.size || !tokenizer.model?.vocab) throw new Error("local_intent_model_pack_invalid");
  encoderSession = await ort.InferenceSession.create(bytesToArrayBuffer(encoder), { executionProviders: ["wasm"] });
  rankerSession = await ort.InferenceSession.create(bytesToArrayBuffer(ranker), { executionProviders: ["wasm"] });
  if (!encoderSession.inputNames.includes("input_ids") || !encoderSession.inputNames.includes("attention_mask")) {
    throw new Error("local_intent_encoder_contract_invalid");
  }
  if (rankerSession.inputNames.length !== 1 || rankerSession.outputNames.length < 1) {
    throw new Error("local_intent_ranker_contract_invalid");
  }
}

async function handle(message: WorkerRequest): Promise<void> {
  if (message.type === "load") {
    preprocessingVersion = message.preprocessingVersion;
    if (preprocessingVersion === "catalog-ranker-hash-v1") {
      hashSession = await ort.InferenceSession.create(message.modelBytes, { executionProviders: ["wasm"] });
      if (hashSession.inputNames.length !== 1 || hashSession.outputNames.length < 1) {
        hashSession = null;
        throw new Error("local_intent_model_contract_invalid");
      }
    } else if (preprocessingVersion === "minilm-action-head-v1") {
      await loadMiniLmPack(message.modelBytes);
    } else {
      throw new Error("local_intent_preprocessing_unsupported");
    }
    post({ type: "ready" });
    return;
  }
  if (preprocessingVersion === "minilm-action-head-v1") {
    const result = await rankMiniLm(message.utterance, message.candidates);
    post({ type: "ranked", requestId: message.requestId, result });
    return;
  }
  if (!hashSession) throw new Error("local_intent_ranker_not_ready");
  const features = makeHashFeatures(message.utterance, message.candidates);
  const tensor = new ort.Tensor("float32", features, [message.candidates.length, HASH_FEATURE_DIMENSION * 2]);
  const outputs = await hashSession.run({ [hashSession.inputNames[0]!]: tensor });
  const scores = outputs[hashSession.outputNames[0]!]?.data;
  if (!(scores instanceof Float32Array) || scores.length < message.candidates.length) {
    throw new Error("local_intent_model_output_invalid");
  }
  const ranked = message.candidates
    .map((candidate, index) => ({ actionId: candidate.actionId, score: Number(scores[index] ?? 0) }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0];
  const second = ranked[1];
  if (!top) {
    post({ type: "ranked", requestId: message.requestId, result: null });
    return;
  }
  const confidence = 1 / (1 + Math.exp(-top.score));
  const secondConfidence = second ? 1 / (1 + Math.exp(-second.score)) : 0;
  post({
    type: "ranked",
    requestId: message.requestId,
    result: { actionId: top.actionId, confidence, margin: Math.max(0, confidence - secondConfidence) },
  });
}

(globalThis as unknown as { onmessage: (event: MessageEvent<WorkerRequest>) => void }).onmessage = (event) => {
  void handle(event.data).catch((error: unknown) => {
    post({
      type: "error",
      requestId: event.data.type === "rank" ? event.data.requestId : undefined,
      code: error instanceof Error ? error.message : "local_intent_inference_failed",
    });
  });
};
