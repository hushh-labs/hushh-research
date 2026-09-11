#!/usr/bin/env bash
set -euo pipefail

# Build deployment-only model artifacts. The output directory must be a
# caller-owned temporary or CI workspace; no model weights are written to git.
output_dir="${1:?usage: build-one-voice-model-packs.sh OUTPUT_DIR}"
mkdir -p "$output_dir"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/one-voice-packs.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

sherpa_archive="$work_dir/sherpa-onnx-wasm.tar.bz2"
sherpa_url="https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-en-asr-zipformer.tar.bz2"
readonly sherpa_archive_sha256="21559527d65f7674a45834870e4f51b0af14be27d4de1043aa6f576d9b426acc"
curl --fail --location --retry 3 --max-time 900 "$sherpa_url" --output "$sherpa_archive"
actual_sherpa_archive_sha256="$(shasum -a 256 "$sherpa_archive" | awk '{print $1}' 2>/dev/null || sha256sum "$sherpa_archive" | awk '{print $1}')"
if [[ "$actual_sherpa_archive_sha256" != "$sherpa_archive_sha256" ]]; then
  echo "Pinned sherpa-onnx release checksum mismatch." >&2
  exit 1
fi
mkdir -p "$work_dir/sherpa"
tar -xjf "$sherpa_archive" -C "$work_dir/sherpa"
model_files=()
while IFS= read -r model_file; do
  model_files+=("$model_file")
done < <(find "$work_dir/sherpa" -type f -name '*.data' -print)
if [[ "${#model_files[@]}" -ne 1 ]]; then
  echo "Expected exactly one sherpa-onnx .data model, found ${#model_files[@]}." >&2
  exit 1
fi
cp "${model_files[0]}" "$output_dir/one-voice-en-asr-sherpa-onnx-v1.data"

uv run --python 3.13 \
  --with numpy \
  --with onnx \
  --with onnxruntime \
  --with tokenizers \
  --no-project \
  python scripts/voice/train-one-voice-minilm-ranker.py \
  --dataset hushh-webapp/contracts/kai/one-voice-local-intent-data.v1.json \
  --gateway hushh-webapp/contracts/kai/kai-action-gateway.vnext.json \
  --output "$output_dir/one-voice-en-intent-minilm-v1.pack.zip"

python3 scripts/voice/verify-one-voice-model-pack.py \
  "$output_dir/one-voice-en-intent-minilm-v1.pack.zip"

asr_bytes="$(wc -c < "$output_dir/one-voice-en-asr-sherpa-onnx-v1.data" | tr -d ' ')"
ranker_bytes="$(wc -c < "$output_dir/one-voice-en-intent-minilm-v1.pack.zip" | tr -d ' ')"
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}
printf '{"asr_bytes":%s,"asr_sha256":"%s","ranker_bytes":%s,"ranker_sha256":"%s"}\n' \
  "$asr_bytes" \
  "$(sha256_file "$output_dir/one-voice-en-asr-sherpa-onnx-v1.data")" \
  "$ranker_bytes" \
  "$(sha256_file "$output_dir/one-voice-en-intent-minilm-v1.pack.zip")"
