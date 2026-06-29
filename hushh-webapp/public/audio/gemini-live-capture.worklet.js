/**
 * AudioWorklet capture processor for Gemini Live full-duplex voice.
 *
 * Runs on the audio rendering thread (off the main thread), replacing the
 * deprecated ScriptProcessorNode. It collects mono Float32 mic frames into a
 * fixed-size buffer and posts each full frame back to the main thread, where it
 * is downsampled to 16 kHz, encoded to PCM16, and streamed to the Live API.
 *
 * The processor stays silent (returns true, emits nothing downstream) so it
 * does not feed mic audio into the speakers.
 */

const FRAME_SIZE = 2048;

class GeminiLiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SIZE);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    const channel = input[0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i += 1) {
      this._buffer[this._offset] = channel[i];
      this._offset += 1;
      if (this._offset >= FRAME_SIZE) {
        // Transfer a copy so the worklet can keep filling without contention.
        const frame = this._buffer.slice(0);
        this.port.postMessage(frame, [frame.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("gemini-live-capture", GeminiLiveCaptureProcessor);
