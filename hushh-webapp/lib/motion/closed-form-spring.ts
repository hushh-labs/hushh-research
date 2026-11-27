/**
 * Refresh-rate-independent closed-form damped harmonic oscillator for 60Hz/120Hz UI physics.
 *
 * Parameterized by perceptual visual duration `visualDuration` (seconds) and `bounce` (0..0.35),
 * preserving C1 velocity continuity across interrupted gestures without main-thread React commits.
 */

export type ClosedFormSpringOptions = {
  /** Perceptual duration in seconds (e.g. 0.22..0.34). */
  visualDuration?: number;
  /** Perceptual bounce factor in [0, 0.35]. 0 is critically damped. */
  bounce?: number;
  /** Initial velocity in units per second (e.g. px/s). */
  initialVelocity?: number;
  /** Spatial rest threshold (e.g. 0.5..1.5 for px, 0.002 for unit progress). */
  restDelta?: number;
  /** Velocity rest threshold in units/s. */
  restSpeed?: number;
};

export type SpringSample = {
  value: number;
  velocity: number;
  done: boolean;
};

export function sampleClosedFormSpring(
  from: number,
  to: number,
  elapsedSeconds: number,
  options: ClosedFormSpringOptions = {},
): SpringSample {
  const T = Math.max(0.06, options.visualDuration ?? 0.28);
  const b = Math.max(0, Math.min(0.45, options.bounce ?? 0.06));
  const omega0 = (2 * Math.PI) / (1.2 * T);
  const zeta = Math.max(0.05, Math.min(1.2, 1 - b));
  const y0 = from - to;
  const v0 = Number.isFinite(options.initialVelocity) ? (options.initialVelocity as number) : 0;
  const restDelta = options.restDelta ?? 0.5;
  const restSpeed = options.restSpeed ?? 4;

  if (elapsedSeconds <= 0) {
    const alreadySettled = Math.abs(y0) <= restDelta && Math.abs(v0) <= restSpeed;
    return {
      value: alreadySettled ? to : from,
      velocity: alreadySettled ? 0 : v0,
      done: alreadySettled,
    };
  }

  const t = elapsedSeconds;
  let y = 0;
  let v = 0;

  if (zeta < 0.999) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * omega0 * t);
    const cosTerm = Math.cos(omegaD * t);
    const sinTerm = Math.sin(omegaD * t);
    const bCoeff = (v0 + zeta * omega0 * y0) / omegaD;
    y = envelope * (y0 * cosTerm + bCoeff * sinTerm);
    v =
      envelope *
      ((bCoeff * omegaD - zeta * omega0 * y0) * cosTerm -
        (y0 * omegaD + zeta * omega0 * bCoeff) * sinTerm);
  } else if (zeta <= 1.001) {
    const envelope = Math.exp(-omega0 * t);
    const bCoeff = v0 + omega0 * y0;
    y = envelope * (y0 + bCoeff * t);
    v = envelope * (bCoeff - omega0 * (y0 + bCoeff * t));
  } else {
    const root = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega0 * (zeta - root);
    const r2 = -omega0 * (zeta + root);
    const c2 = (v0 - r1 * y0) / (r2 - r1);
    const c1 = y0 - c2;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    y = c1 * e1 + c2 * e2;
    v = c1 * r1 * e1 + c2 * r2 * e2;
  }

  const done = (Math.abs(y) <= restDelta && Math.abs(v) <= restSpeed) || t >= T * 3.2;
  return {
    value: done ? to : to + y,
    velocity: done ? 0 : v,
    done,
  };
}

export type SpringDriverHandle = {
  cancel: () => void;
  getState: () => { value: number; velocity: number; running: boolean };
};

export function runClosedFormSpring(params: {
  from: number;
  to: number;
  options?: ClosedFormSpringOptions;
  onUpdate: (value: number, velocity: number) => void;
  onComplete?: () => void;
}): SpringDriverHandle {
  const { from, to, options, onUpdate, onComplete } = params;
  const reduced =
    typeof window === "undefined" ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  let currentValue = from;
  let currentVelocity = options?.initialVelocity ?? 0;
  let running = !reduced;
  let rafId = 0;

  if (reduced) {
    currentValue = to;
    currentVelocity = 0;
    onUpdate(to, 0);
    onComplete?.();
    return {
      cancel: () => undefined,
      getState: () => ({ value: currentValue, velocity: 0, running: false }),
    };
  }

  const startedAt = performance.now();

  const step = (now: number) => {
    if (!running) return;
    const elapsed = Math.max(0, (now - startedAt) / 1000);
    const sample = sampleClosedFormSpring(from, to, elapsed, options);
    currentValue = sample.value;
    currentVelocity = sample.velocity;
    onUpdate(sample.value, sample.velocity);
    if (sample.done) {
      running = false;
      onComplete?.();
      return;
    }
    rafId = window.requestAnimationFrame(step);
  };

  rafId = window.requestAnimationFrame(step);

  return {
    cancel: () => {
      if (!running) return;
      running = false;
      window.cancelAnimationFrame(rafId);
    },
    getState: () => ({ value: currentValue, velocity: currentVelocity, running }),
  };
}

/** Rolling 80ms pointer velocity estimator (returns px/second). */
export function createPointerVelocityTracker() {
  const samples: Array<{ x: number; t: number }> = [];

  return {
    reset(x: number, timeMs: number) {
      samples.length = 0;
      samples.push({ x, t: timeMs });
    },
    push(x: number, timeMs: number) {
      samples.push({ x, t: timeMs });
      const cutoff = timeMs - 90;
      while (samples.length > 2 && samples[0]!.t < cutoff) {
        samples.shift();
      }
    },
    velocityPxPerSec(nowMs?: number): number {
      if (samples.length < 2) return 0;
      const latest = samples[samples.length - 1]!;
      if (nowMs !== undefined && nowMs - latest.t > 90) return 0;
      const anchor = samples[0]!;
      const dt = (latest.t - anchor.t) / 1000;
      if (dt <= 0.002) return 0;
      return Math.max(-4200, Math.min(4200, (latest.x - anchor.x) / dt));
    },
  };
}
