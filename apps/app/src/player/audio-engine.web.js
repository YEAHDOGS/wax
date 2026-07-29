/**
 * @file Web audio engine.
 *
 * An `HTMLAudioElement` for playback, plus an `AnalyserNode` for the meter.
 * Metro picks this file over `audio-engine.js` on web automatically; the
 * native engine implements the same eight methods and nothing above this layer
 * knows which one it is talking to.
 *
 * ## The analyser and CORS
 *
 * `createMediaElementSource` on a cross-origin element **taints the graph**:
 * the audio still plays, but the analyser reads zeroes forever and the meter
 * flatlines. Worse, setting `crossOrigin = 'anonymous'` on an element whose
 * origin sends no `Access-Control-Allow-Origin` makes the load fail outright —
 * so you cannot simply set it and hope.
 *
 * The rule this file follows: opt into CORS **only** for URLs served by our own
 * API, which is what `/api/stream` exists to provide. Anything else plays
 * without an analyser, and {@link AudioEngine.levels} returns null so the UI
 * can show something honest instead of a fake waveform.
 *
 * ## Autoplay policy
 *
 * An `AudioContext` created before a user gesture starts suspended. The
 * context is therefore created lazily on the first `play()` — which is always
 * inside a gesture — rather than in the constructor.
 */

/** Frequency bins the analyser reports. 64 bars is what the meter draws. */
const FFT_SIZE = 128;

/**
 * Whether a URL can be analysed — i.e. whether it will send CORS headers.
 *
 * Same-origin always can. A configured API base can, because `/api/stream`
 * sets the headers deliberately. Everything else cannot.
 *
 * @param {string} url
 * @param {?string} apiBase
 * @returns {boolean}
 */
function analysable(url, apiBase) {
  if (url.startsWith('/')) return true;
  if (apiBase && url.startsWith(apiBase)) return true;
  try {
    return new URL(url).origin === globalThis.location?.origin;
  } catch {
    return false;
  }
}

export class AudioEngine {
  /**
   * @param {object} [options]
   * @param {?string} [options.apiBase] Base URL of the Wax API, if remote.
   * @param {(state: object) => void} [options.onState] Called on every
   *   meaningful playback change: load, play, pause, time, end, error.
   */
  constructor({ apiBase = null, onState = () => {} } = {}) {
    this.apiBase = apiBase;
    this.onState = onState;

    /** @type {HTMLAudioElement} */
    this.el = new Audio();
    this.el.preload = 'metadata';

    /** @type {?AudioContext} */
    this.ctx = null;
    /** @type {?AnalyserNode} */
    this.analyser = null;
    /** @type {?MediaElementAudioSourceNode} */
    this.source = null;
    /** @type {?Uint8Array} */
    this.bins = null;

    /** Whether the *current* source is eligible for analysis. */
    this.canAnalyse = false;

    const emit = () => this.onState(this.state());
    // `timeupdate` fires about 4x a second — enough to keep a text clock
    // honest. The scrubber and meter animate off rAF instead, in the UI.
    for (const event of ['loadedmetadata', 'play', 'pause', 'ended', 'error', 'timeupdate', 'progress', 'waiting', 'playing']) {
      this.el.addEventListener(event, emit);
    }

    /** Called when a track finishes, so the queue can advance. */
    this.onEnded = () => {};
    this.el.addEventListener('ended', () => this.onEnded());
  }

  /**
   * Point the engine at a track.
   *
   * Does not start playback — `play()` does, and keeping them separate is what
   * lets the UI load a queue without making noise.
   *
   * @param {string} url
   */
  load(url) {
    this.canAnalyse = analysable(url, this.apiBase);
    // Must be set before `src`, or the element loads without the CORS request
    // and the analyser is tainted regardless.
    if (this.canAnalyse) this.el.crossOrigin = 'anonymous';
    else this.el.removeAttribute('crossorigin');
    this.el.src = url;
    this.el.load();
    this.onState(this.state());
  }

  /**
   * Build the analyser graph. Called on first play, inside a user gesture, so
   * the context starts running rather than suspended.
   */
  #connect() {
    if (this.ctx || !this.canAnalyse) return;
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      // Without smoothing the bars strobe; this is the value at which the
      // meter reads as a physical VU rather than as noise.
      this.analyser.smoothingTimeConstant = 0.78;
      this.source = this.ctx.createMediaElementSource(this.el);
      this.source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    } catch {
      // A browser that refuses the graph still has to play audio. Drop the
      // analyser and carry on.
      this.ctx = null;
      this.analyser = null;
      this.canAnalyse = false;
    }
  }

  /** Start or resume playback. Safe to call when already playing. */
  async play() {
    this.#connect();
    if (this.ctx?.state === 'suspended') await this.ctx.resume().catch(() => {});
    await this.el.play().catch(() => {});
  }

  /** Pause. Safe to call when already paused. */
  pause() {
    this.el.pause();
  }

  /**
   * Jump to a position.
   * @param {number} seconds
   */
  seek(seconds) {
    if (Number.isFinite(this.el.duration)) {
      this.el.currentTime = Math.max(0, Math.min(seconds, this.el.duration));
      this.onState(this.state());
    }
  }

  /**
   * @param {number} value 0–1.
   */
  setVolume(value) {
    this.el.volume = Math.max(0, Math.min(1, value));
  }

  /**
   * @param {number} rate
   */
  setRate(rate) {
    this.el.playbackRate = rate;
  }

  /**
   * Current playback state.
   *
   * `duration` is NaN until metadata loads, which is why it is normalised to 0
   * here rather than leaving every caller to guard it.
   *
   * @returns {{ playing: boolean, position: number, duration: number, buffered: number, ready: boolean, analysing: boolean }}
   */
  state() {
    const duration = Number.isFinite(this.el.duration) ? this.el.duration : 0;
    let buffered = 0;
    try {
      if (this.el.buffered.length) buffered = this.el.buffered.end(this.el.buffered.length - 1);
    } catch {
      // Firefox throws on `buffered.end` for an unloaded element.
    }
    return {
      playing: !this.el.paused && !this.el.ended,
      position: this.el.currentTime || 0,
      duration,
      buffered,
      ready: this.el.readyState >= 2,
      analysing: this.canAnalyse && Boolean(this.analyser),
    };
  }

  /**
   * A frame of frequency data, 0–1 per bin, or null when no analyser is
   * available.
   *
   * Null is meaningful: the meter draws nothing rather than inventing motion.
   * A visualiser that animates without audio behind it is a lie, and this
   * design system does not ship one.
   *
   * @returns {?number[]}
   */
  levels() {
    if (!this.analyser || !this.bins) return null;
    this.analyser.getByteFrequencyData(this.bins);
    // The top third of the spectrum is nearly always empty on music and makes
    // the meter look dead on the right. Drop it and use the rest.
    const used = Math.floor(this.bins.length * 0.66);
    const out = new Array(used);
    for (let i = 0; i < used; i += 1) out[i] = this.bins[i] / 255;
    return out;
  }

  /** Release everything. */
  destroy() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.ctx?.close().catch(() => {});
  }
}
