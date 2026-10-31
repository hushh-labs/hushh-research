/**
 * AudioWorklet capture processor for One Live Voice.
 *
 * Runs on the audio rendering thread. Collects mono Float32 mic samples into
 * fixed 2048-sample frames and posts each full frame to the main thread
 * together with its RMS level, where lib/one-voice/audio/capture.ts
 * downsamples it to 16 kHz, encodes PCM16, and hands it to the live client.
 *
 * The processor has no outputs, so microphone audio never reaches the
 * speakers through this node. It keeps running (returns true) until the node
 * is disconnected or the context closes.
 *
 * FRAME_SIZE is mirrored by CAPTURE_FRAME_SIZE in lib/one-voice/audio/pcm.ts.
 */

const FRAME_SIZE = 2048;

class OneLiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SIZE);
    this._offset = 0;
    this._squares = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      this._buffer[this._offset] = sample;
      this._squares += sample * sample;
      this._offset += 1;
      if (this._offset >= FRAME_SIZE) {
        // Transfer a copy so the worklet keeps filling without contention.
        const frame = this._buffer.slice(0);
        const rms = Math.sqrt(this._squares / FRAME_SIZE);
        this.port.postMessage({ frame, rms }, [frame.buffer]);
        this._offset = 0;
        this._squares = 0;
      }
    }
    return true;
  }
}

registerProcessor("one-live-capture", OneLiveCaptureProcessor);
