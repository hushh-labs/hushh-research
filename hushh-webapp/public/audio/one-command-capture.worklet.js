/* Bounded mono capture. Finalization includes every frame before the finish message. */
class OneCommandCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.count = 0;
    this.closed = false;
    this.port.onmessage = (event) => {
      if (event.data !== "finish" || this.closed) return;
      this.closed = true;
      const samples = new Float32Array(this.count);
      let offset = 0;
      for (const frame of this.frames) { samples.set(frame, offset); offset += frame.length; }
      this.frames = [];
      const length = Math.min(960000, Math.floor(this.count * 16000 / sampleRate));
      const wav = new ArrayBuffer(44 + length * 2);
      const view = new DataView(wav);
      const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
      text(0, "RIFF"); view.setUint32(4, 36 + length * 2, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
      view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, length * 2, true);
      for (let i = 0; i < length; i++) {
        const start = Math.floor(i * sampleRate / 16000);
        const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * sampleRate / 16000)));
        let sum = 0;
        for (let j = start; j < end; j++) sum += samples[j];
        const value = Math.max(-1, Math.min(1, sum / (end - start)));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      this.port.postMessage(wav, [wav]);
    };
  }
  process(inputs) {
    if (this.closed) return false;
    const input = inputs[0]?.[0];
    if (input && this.count < sampleRate * 60) {
      const frame = input.slice(0, Math.min(input.length, sampleRate * 60 - this.count));
      this.frames.push(frame);
      this.count += frame.length;
    }
    return true;
  }
}
registerProcessor("one-command-capture", OneCommandCapture);
