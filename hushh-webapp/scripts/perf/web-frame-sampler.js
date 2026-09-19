/*
 * Paste-in frame sampler for any web page, for the reference session against
 * Threads web in Safari on the same phone. Safari on the Mac -> Develop ->
 * <phone> -> the threads.com tab -> Console -> paste this file, then:
 *
 *   __frameSampler.start("feed-flick");   // do the gesture card step
 *   __frameSampler.stop();                // prints the same numbers the in-app probe reports
 *
 * Same arithmetic as lib/perf/frame-stats.ts (1ms histogram, p50/p95/p99,
 * frames over 50ms, time past the frame budget per second). Dependency-free
 * so it runs in a page we do not own. It records frame intervals only: no
 * text, no URLs, no element content, nothing about the account.
 */
(() => {
  const BINS = 128;
  let frames = 0, sum = 0, max = 0, over50 = 0, overBudgetMs = 0;
  const hist = new Uint32Array(BINS);
  let last = 0, raf = 0, startAt = 0, label = "", hz = 60, budget = 16.7;

  const pct = (p) => {
    if (!frames) return 0;
    const target = Math.max(1, Math.ceil((p / 100) * frames));
    let seen = 0;
    for (let b = 0; b < BINS; b += 1) { seen += hist[b]; if (seen >= target) return b; }
    return BINS - 1;
  };
  const tick = (now) => {
    if (last) {
      const d = now - last;
      frames += 1; sum += d; if (d > max) max = d; if (d > 50) over50 += 1;
      const over = d - budget; if (over > 0.5) overBudgetMs += over;
      hist[Math.min(BINS - 1, Math.floor(d))] += 1;
    }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  const probeHz = () => new Promise((resolve) => {
    let n = 0, t0 = 0;
    const step = (t) => { if (!t0) t0 = t; else n += 1; if (t - t0 < 1000) requestAnimationFrame(step); else resolve(n / ((t - t0) / 1000)); };
    requestAnimationFrame(step);
  });

  window.__frameSampler = {
    async start(name) {
      label = name || "window";
      const raw = await probeHz();
      hz = [30, 60, 90, 120].reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best), 60);
      budget = Math.round((1000 / hz) * 10) / 10;
      frames = 0; sum = 0; max = 0; over50 = 0; overBudgetMs = 0; hist.fill(0); last = 0;
      startAt = performance.now();
      raf = requestAnimationFrame(tick);
      console.log(`[frameSampler] recording "${label}" at ~${raw.toFixed(1)} Hz (budget ${budget} ms)`);
    },
    stop() {
      cancelAnimationFrame(raf);
      const seconds = Math.max(0.001, (performance.now() - startAt) / 1000);
      const out = {
        label, hz, budget_ms: budget, frames,
        mean_ms: frames ? Math.round((sum / frames) * 10) / 10 : 0,
        p50_ms: pct(50), p95_ms: pct(95), p99_ms: pct(99),
        max_ms: Math.round(max * 10) / 10,
        over_50_count: over50,
        raf_hitch_ms_per_s: Math.round((overBudgetMs / seconds) * 10) / 10,
        duration_s: Math.round(seconds * 10) / 10,
      };
      console.log(`[frameSampler] ${JSON.stringify(out)}`);
      return out;
    },
  };
  console.log("[frameSampler] ready: __frameSampler.start('<gesture>') ... __frameSampler.stop()");
})();
