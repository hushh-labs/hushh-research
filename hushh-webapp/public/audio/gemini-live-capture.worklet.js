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
    // This sequence belongs to the short-lived AudioWorklet node, never to a
    // user or transcript. It lets the main thread prove that a tail marker
    // follows every PCM message from this capture source.
    this._frameSequence = 0;
    this._tailDrain = null;
    this._captureStopped = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (
        !message ||
        message.type !== "location_command_tail_drain" ||
        typeof message.turnId !== "string" ||
        !message.turnId.trim() ||
        this._captureStopped ||
        this._tailDrain
      ) {
        return;
      }
      // The render thread applies this control message at a quantum boundary.
      // `process()` flushes the in-progress partial frame and posts the marker
      // after all preceding PCM, then this node emits no more capture data.
      this._tailDrain = { turnId: message.turnId };
    };
  }

  _postFrame(frame) {
    this._frameSequence += 1;
    this.port.postMessage(
      { type: "pcm", frame, sequence: this._frameSequence },
      [frame.buffer],
    );
  }

  _flushTailDrain() {
    const tailDrain = this._tailDrain;
    if (!tailDrain) return;
    if (this._offset > 0) {
      const tail = this._buffer.slice(0, this._offset);
      this._offset = 0;
      this._postFrame(tail);
    }
    // Messages from one AudioWorklet MessagePort are delivered in order. The
    // main thread must wait for this marker before it sends the command's
    // terminal activity-end, otherwise a release could silently clip the
    // partial buffer that existed at the render boundary.
    this.port.postMessage({
      type: "location_command_tail_drained",
      turnId: tailDrain.turnId,
      finalSequence: this._frameSequence,
    });
    this._tailDrain = null;
    this._captureStopped = true;
  }

  process(inputs) {
    if (this._captureStopped) {
      return true;
    }
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this._buffer[this._offset] = channel[i];
        this._offset += 1;
        if (this._offset >= FRAME_SIZE) {
          // Transfer a copy so the worklet can keep filling without contention.
          const frame = this._buffer.slice(0);
          this._postFrame(frame);
          this._offset = 0;
        }
      }
    }
    // Do this after processing the current render quantum so no frame captured
    // before the control boundary is lost. The next quantum sees
    // `_captureStopped` and produces no additional PCM.
    this._flushTailDrain();
    return true;
  }
}

registerProcessor("gemini-live-capture", GeminiLiveCaptureProcessor);
