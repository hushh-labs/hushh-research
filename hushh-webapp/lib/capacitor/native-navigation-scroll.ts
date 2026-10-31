/** Public presentation metadata only. The existing scroll owner decides the
 * progress; this mailbox neither classifies gestures nor performs operations. */
export type NativeNavigationScrollBinding = {
  documentId: string;
  revision: number;
  interactionEpoch: number;
  privacyGeneration: number;
  scrollGeneration: number;
  travel: number;
};
export type NativeNavigationScroll = NativeNavigationScrollBinding & { sequence: number; progress: number };
export type NativeNavigationScrollReset = Omit<NativeNavigationScrollBinding, "travel"> & {
  active: boolean; snap: boolean;
};
export type NativeNavigationScrollPort = {
  setScroll(options: NativeNavigationScroll): Promise<{ applied: boolean }>;
};

/** At most one in-flight sample and one replaceable pending sample. A slow
 * bridge never queues every scroll frame, rerenders React or replays an action. */
export class NativeNavigationScrollDelivery {
  private binding: NativeNavigationScrollBinding | null = null;
  private pending: NativeNavigationScroll | null = null;
  private sequence = 0;
  private progress = 0;
  private inFlight = false;
  private stopped = false;
  constructor(private readonly port: NativeNavigationScrollPort, private readonly unavailable: () => void = () => undefined) {}

  update(binding: NativeNavigationScrollBinding | null) {
    if (this.stopped) return;
    this.binding = binding;
    this.pending = null;
    if (binding) this.publish(this.progress);
  }
  publish(progress: number) {
    if (this.stopped || !Number.isFinite(progress) || progress < 0 || progress > 1) return;
    this.progress = progress;
    if (!this.binding) return;
    this.pending = { ...this.binding, sequence: ++this.sequence, progress };
    void this.drain();
  }
  stop() { this.stopped = true; this.binding = null; this.pending = null; }

  private async drain() {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      while (this.pending && !this.stopped) {
        const sample = this.pending, binding = this.binding;
        this.pending = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Timeout cannot cancel an already-dispatched bridge call. Stop this
          // document's delivery and ask for acknowledged pinned presentation,
          // but retain the in-flight slot until the original call settles.
          timer = setTimeout(() => this.fail(), 3000);
          await this.port.setScroll(sample);
        } catch {
          if (this.binding === binding) this.fail();
        } finally { clearTimeout(timer); }
      }
    } finally { this.inFlight = false; }
  }
  private fail() {
    if (this.stopped) return;
    this.stop();
    this.unavailable();
  }
}
