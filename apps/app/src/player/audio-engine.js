/**
 * @file Native audio engine (iOS / Android), built on `expo-audio`.
 *
 * Implements the same interface as `audio-engine.web.js`; Metro picks that
 * file on web and this one everywhere else. Nothing above this layer knows
 * which is loaded.
 *
 * One difference is unavoidable: there is no `AnalyserNode` on native, so
 * {@link AudioEngine.levels} returns null and the meter draws nothing. That is
 * the honest outcome — a visualiser animating without audio data behind it
 * would be decoration pretending to be an instrument.
 */

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

// Keep playing when the phone is locked or the app is backgrounded, and ignore
// the silent switch: someone listening to a record on their phone means it.
setAudioModeAsync({
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'doNotMix',
}).catch(() => {});

export class AudioEngine {
  /**
   * @param {object} [options]
   * @param {?string} [options.apiBase]
   * @param {(state: object) => void} [options.onState]
   */
  constructor({ apiBase = null, onState = () => {} } = {}) {
    this.apiBase = apiBase;
    this.onState = onState;
    /** @type {?import('expo-audio').AudioPlayer} */
    this.player = null;
    this.onEnded = () => {};
  }

  /** @param {string} url */
  load(url) {
    // `replace` on an existing player avoids tearing down and rebuilding the
    // native audio session on every track change.
    if (this.player) {
      this.player.replace(url);
    } else {
      this.player = createAudioPlayer(url, { updateInterval: 250 });
      this.player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) this.onEnded();
        this.onState(this.state());
      });
    }
    this.onState(this.state());
  }

  async play() {
    this.player?.play();
  }

  pause() {
    this.player?.pause();
  }

  /** @param {number} seconds */
  seek(seconds) {
    this.player?.seekTo(Math.max(0, seconds));
  }

  /** @param {number} value 0–1. */
  setVolume(value) {
    if (this.player) this.player.volume = Math.max(0, Math.min(1, value));
  }

  /** @param {number} rate */
  setRate(rate) {
    this.player?.setPlaybackRate(rate);
  }

  /** @returns {{ playing: boolean, position: number, duration: number, buffered: number, ready: boolean, analysing: boolean }} */
  state() {
    const p = this.player;
    return {
      playing: Boolean(p?.playing),
      position: p?.currentTime ?? 0,
      duration: Number.isFinite(p?.duration) ? p.duration : 0,
      // Native does not report a buffered edge; the scrubber hides its buffer
      // bar when this equals the position rather than drawing a wrong one.
      buffered: p?.currentTime ?? 0,
      ready: Boolean(p?.isLoaded),
      analysing: false,
    };
  }

  /** No analyser on native. See the file header. @returns {null} */
  levels() {
    return null;
  }

  destroy() {
    this.player?.remove();
    this.player = null;
  }
}
