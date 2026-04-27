class AudioManager {
  private ctx: AudioContext | null = null;
  private enabled = true;

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
    }
  }

  toggle(enabled: boolean) {
    this.enabled = enabled;
  }

  private playTone(freq: number, type: OscillatorType, duration: number, vol = 0.1) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  playTap() {
    this.playTone(600, 'sine', 0.1, 0.05);
  }

  playToss() {
    if (!this.enabled) return;
    this.init();
    let time = 0;
    const interval = setInterval(() => {
      this.playTone(800 + Math.random()*200, 'square', 0.05, 0.02);
      time += 100;
      if (time > 2000) clearInterval(interval);
    }, 100);
  }

  playTossWin() {
    this.playTone(800, 'sine', 0.1, 0.1);
    setTimeout(() => this.playTone(1200, 'sine', 0.2, 0.1), 100);
  }

  playScore() {
    this.playTone(800, 'square', 0.1, 0.05);
    setTimeout(() => this.playTone(1200, 'square', 0.15, 0.05), 100);
  }

  playOut() {
    this.playTone(300, 'sawtooth', 0.2, 0.1);
    setTimeout(() => this.playTone(200, 'sawtooth', 0.4, 0.1), 150);
  }

  playWin() {
    [400, 500, 600, 800].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'square', 0.2, 0.1), i * 150);
    });
  }

  playLose() {
    [400, 350, 300, 200].forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'triangle', 0.3, 0.1), i * 200);
    });
  }
}

export const audio = new AudioManager();
