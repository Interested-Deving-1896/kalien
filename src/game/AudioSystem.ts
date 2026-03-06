const MUSIC_URL = "https://api.smol.xyz/song/a956a62b-6862-4276-816d-45d7cbda35f8.mp3";
const MUSIC_VOLUME = 0.2;
const DEFAULT_SFX_VOLUME = 0.5;

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private enabled = true;
  private volume = DEFAULT_SFX_VOLUME;

  private musicEl: HTMLAudioElement | null = null;
  private muted = false;
  private musicRequested = false;
  private musicRestartRequested = false;
  private musicPrimed = false;
  private musicPrimePromise: Promise<void> | null = null;

  enable(): void {
    const ctx = this.ensureContext();
    if (!ctx) {
      return;
    }

    if (this.ctx?.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }

    void this.primeMusic();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.enable();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  playShoot(): void {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = "square";
    osc.frequency.setValueAtTime(880, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(110, this.ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(this.volume * 0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.15);
  }

  playExplosion(size: "small" | "medium" | "large" = "medium"): void {
    if (!this.enabled || !this.ctx) return;
    const duration = size === "large" ? 0.4 : size === "medium" ? 0.3 : 0.2;
    const noiseBuffer = this.createNoiseBuffer(duration);
    const source = this.ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(this.volume * (size === "large" ? 0.5 : 0.35), this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }

  playThrust(): void {
    if (!this.enabled || !this.ctx) return;
    const noiseBuffer = this.createNoiseBuffer(0.08);
    const source = this.ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, this.ctx.currentTime);
    filter.Q.value = 1;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(this.volume * 0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.08);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }

  playSaucer(small: boolean): void {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = "sawtooth";
    const baseFreq = small ? 600 : 250;
    osc.frequency.setValueAtTime(baseFreq, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(baseFreq * 1.2, this.ctx.currentTime + 0.1);
    osc.frequency.linearRampToValueAtTime(baseFreq, this.ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(this.volume * 0.15, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.2);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.2);
  }

  playExtraLife(): void {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.08);
      gain.gain.setValueAtTime(this.volume * 0.25, ctx.currentTime + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.08 + 0.2);
      osc.start(ctx.currentTime + i * 0.08);
      osc.stop(ctx.currentTime + i * 0.08 + 0.2);
    });
  }

  /** Start (or restart) the background music track. */
  playMusic(): void {
    this.musicRequested = true;
    this.musicRestartRequested = true;
    this.syncMusicPlayback();
  }

  /** Resume background music from current position. */
  resumeMusic(): void {
    this.musicRequested = true;
    this.syncMusicPlayback();
  }

  /** Pause background music (keeps position). */
  pauseMusic(): void {
    this.musicRequested = false;
    this.musicEl?.pause();
  }

  /** Stop music and reset to beginning. */
  stopMusic(): void {
    this.musicRequested = false;
    this.musicRestartRequested = false;
    if (this.musicEl) {
      this.musicEl.pause();
      this.musicEl.currentTime = 0;
    }
  }

  /** Toggle mute for both SFX and music. Returns new muted state. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    this.enabled = !this.muted;
    if (this.musicEl) {
      this.musicEl.muted = this.muted;
    }
    if (!this.muted && this.musicRequested) {
      this.syncMusicPlayback();
    }
    return this.muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") {
      return null;
    }

    if (!this.ctx) {
      this.ctx = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      )();
    }

    return this.ctx;
  }

  private ensureMusicElement(): HTMLAudioElement | null {
    if (typeof Audio === "undefined") {
      return null;
    }

    if (!this.musicEl) {
      this.musicEl = new Audio(MUSIC_URL);
      this.musicEl.loop = true;
      this.musicEl.preload = "auto";
      this.musicEl.volume = MUSIC_VOLUME;
    }

    return this.musicEl;
  }

  private syncMusicPlayback(): void {
    const musicEl = this.ensureMusicElement();
    if (!musicEl) {
      return;
    }

    musicEl.volume = MUSIC_VOLUME;
    musicEl.muted = this.muted;

    if (this.musicRestartRequested) {
      musicEl.currentTime = 0;
      this.musicRestartRequested = false;
    }

    if (!this.musicRequested) {
      musicEl.pause();
      return;
    }

    void musicEl.play().catch(() => {});
  }

  private async primeMusic(): Promise<void> {
    const musicEl = this.ensureMusicElement();
    if (!musicEl || this.musicPrimed) {
      return;
    }
    if (this.musicPrimePromise) {
      await this.musicPrimePromise;
      return;
    }

    const wasRequested = this.musicRequested;
    const previousTime = musicEl.currentTime;
    musicEl.volume = MUSIC_VOLUME;
    musicEl.muted = true;

    this.musicPrimePromise = musicEl
      .play()
      .then(() => {
        this.musicPrimed = true;
        return undefined;
      })
      .catch(() => {
        // Retry on the next trusted user interaction if autoplay is still blocked.
        return undefined;
      })
      .finally(() => {
        if (!this.musicRequested) {
          musicEl.pause();
          if (!wasRequested) {
            musicEl.currentTime = previousTime;
          }
        } else if (this.musicRestartRequested) {
          musicEl.currentTime = 0;
          this.musicRestartRequested = false;
        }

        musicEl.muted = this.muted;
        musicEl.volume = MUSIC_VOLUME;

        if (this.musicRequested) {
          void musicEl.play().catch(() => {});
        }

        this.musicPrimePromise = null;
      });

    await this.musicPrimePromise;
  }

  private createNoiseBuffer(duration: number): AudioBuffer {
    if (!this.ctx) throw new Error("AudioContext not initialized");
    const bufferSize = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
