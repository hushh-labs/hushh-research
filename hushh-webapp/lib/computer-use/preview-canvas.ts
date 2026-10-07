import type { ComputerUseFrame } from "./contracts";

/** One decoded frame at a time; no URLs, React frame state, persistence or telemetry. */
export function createComputerUseCanvas(
  canvas: HTMLCanvasElement,
  accepts: (frame: ComputerUseFrame) => boolean,
): { paint: (frame: ComputerUseFrame) => Promise<void>; clear: () => void; close: () => void } {
  let generation = 0;
  let decoding = false;
  let latest: ComputerUseFrame | null = null;
  let sequence = -1;
  let epoch = -1;
  let closed = false;

  const clear = () => {
    generation += 1;
    latest = null;
    sequence = -1;
    epoch = -1;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const paint = async (frame: ComputerUseFrame): Promise<void> => {
    if (closed || !accepts(frame)) return;
    if (frame.controlEpoch === epoch && frame.sequence <= sequence) return;
    latest = frame;
    if (decoding) return;
    decoding = true;
    try {
      while (latest && !closed) {
        const pending = latest;
        latest = null;
        if (pending.controlEpoch === epoch && pending.sequence <= sequence) continue;
        const observed = generation;
        // A fresh bounded copy lets the transport release its buffer while the
        // decoder is active. Never create a browser-visible object URL.
        const image = await createImageBitmap(new Blob([new Uint8Array(pending.png)], { type: "image/png" }));
        try {
          if (closed || generation !== observed || !accepts(pending)) continue;
          if (image.width !== pending.width || image.height !== pending.height) continue;
          canvas.width = pending.width;
          canvas.height = pending.height;
          canvas.getContext("2d")?.drawImage(image, 0, 0);
          sequence = pending.sequence;
          epoch = pending.controlEpoch;
        } finally {
          image.close();
        }
      }
    } finally {
      decoding = false;
    }
  };

  return { paint, clear, close: () => { closed = true; clear(); } };
}

export function computerUsePoint(
  canvas: HTMLCanvasElement, clientX: number, clientY: number,
): { x: number; y: number } | null {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height || clientX < bounds.left || clientY < bounds.top
    || clientX >= bounds.right || clientY >= bounds.bottom) return null;
  return {
    x: Math.min(canvas.width - 1, Math.floor((clientX - bounds.left) * canvas.width / bounds.width)),
    y: Math.min(canvas.height - 1, Math.floor((clientY - bounds.top) * canvas.height / bounds.height)),
  };
}
