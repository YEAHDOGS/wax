/**
 * @file The player: queue, transport, and the state the UI animates against.
 *
 * The engine (`audio-engine.js` / `.web.js`) owns the audio element. This owns
 * everything about *which* audio and *what the UI knows* — queue order,
 * shuffle, repeat, and the position value the scrubber reads.
 *
 * ## Why position is not React state
 *
 * A 60fps scrubber cannot be a `setState` per frame. Position lives in a
 * Reanimated shared value that the scrubber and meter read on the UI thread,
 * and only the coarse facts (which track, playing or not, duration) are React
 * state. That is the difference between a scrubber that glides and one that
 * stutters whenever a list re-renders.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';

import { API_BASE, api } from '../data/client.js';
import { AudioEngine } from './audio-engine.js';

const PlayerContext = createContext(null);

/** Repeat modes, cycled by the repeat button in that order. */
export const REPEAT = { OFF: 'off', ALL: 'all', ONE: 'one' };

export function PlayerProvider({ tracks = [], children }) {
  /** @type {React.MutableRefObject<?AudioEngine>} */
  const engine = useRef(null);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(REPEAT.OFF);
  const [volume, setVolumeState] = useState(1);

  /** Playback position in seconds, on the UI thread. Read by the scrubber. */
  const position = useSharedValue(0);
  /** How far the file has buffered, in seconds. */
  const buffered = useSharedValue(0);
  /** True while a drag is in progress, so engine updates stop fighting it. */
  const scrubbing = useSharedValue(false);

  const track = tracks[index] ?? null;

  // Shuffle is an order, not a coin flip per advance — otherwise "next" can
  // repeat a track you just heard, which reads as broken.
  const order = useMemo(() => {
    const indices = tracks.map((_, i) => i);
    if (!shuffle) return indices;
    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }, [tracks, shuffle]);

  /** Advance by `step` within the shuffle order, honouring repeat. */
  const step = useCallback(
    (delta) => {
      if (!tracks.length) return;
      const at = order.indexOf(index);
      let next = at + delta;
      if (next >= order.length) {
        if (repeat === REPEAT.OFF) return setPlaying(false);
        next = 0;
      }
      if (next < 0) next = order.length - 1;
      setIndex(order[next]);
    },
    [order, index, tracks.length, repeat],
  );

  // Build the engine once. Its `onState` is the only writer of playback state.
  useEffect(() => {
    const instance = new AudioEngine({
      apiBase: API_BASE,
      onState: (state) => {
        setPlaying(state.playing);
        setReady(state.ready);
        setAnalysing(state.analysing);
        setDuration(state.duration);
        buffered.value = state.buffered;
        if (!scrubbing.value) position.value = state.position;
      },
    });
    engine.current = instance;
    return () => instance.destroy();
  }, [buffered, position, scrubbing]);

  // Advance when a track finishes. Registered separately from construction so
  // it always closes over the current `repeat` and queue.
  useEffect(() => {
    if (!engine.current) return;
    engine.current.onEnded = () => {
      if (repeat === REPEAT.ONE) {
        engine.current.seek(0);
        engine.current.play();
      } else {
        step(1);
      }
    };
  }, [repeat, step]);

  // Load whenever the selected track changes.
  const previous = useRef(null);
  useEffect(() => {
    if (!engine.current || !track) return;
    if (previous.current === track.id) return;
    const wasPlaying = previous.current !== null && playing;
    previous.current = track.id;
    position.value = 0;
    engine.current.load(track.audio_url);
    if (wasPlaying) engine.current.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // Report the real duration back the first time we learn it, so the seed's
  // null `duration_sec` fills itself in through use.
  useEffect(() => {
    if (track && duration > 0 && !track.duration_sec) {
      api.setTrackDuration(track.id, duration);
    }
  }, [track, duration]);

  const play = useCallback(
    (at) => {
      if (typeof at === 'number' && at !== index) {
        setIndex(at);
        // The load effect starts playback; mark intent so it does.
        previous.current = null;
        setTimeout(() => engine.current?.play(), 0);
      } else {
        engine.current?.play();
      }
      const t = tracks[typeof at === 'number' ? at : index];
      if (t) api.recordPlay(t.id);
    },
    [index, tracks],
  );

  const pause = useCallback(() => engine.current?.pause(), []);

  const toggle = useCallback(() => {
    if (playing) engine.current?.pause();
    else play();
  }, [playing, play]);

  /**
   * Seek. Restarts the current track when pressed near the start, which is
   * what "previous" means on every physical transport ever made.
   */
  const seek = useCallback(
    (seconds) => {
      position.value = seconds;
      engine.current?.seek(seconds);
    },
    [position],
  );

  const next = useCallback(() => step(1), [step]);

  const previousTrack = useCallback(() => {
    if (position.value > 3) return seek(0);
    step(-1);
  }, [position, seek, step]);

  const setVolume = useCallback((value) => {
    setVolumeState(value);
    engine.current?.setVolume(value);
  }, []);

  const cycleRepeat = useCallback(
    () => setRepeat((r) => (r === REPEAT.OFF ? REPEAT.ALL : r === REPEAT.ALL ? REPEAT.ONE : REPEAT.OFF)),
    [],
  );

  /** Read a frame of frequency data, or null when no analyser is available. */
  const levels = useCallback(() => engine.current?.levels() ?? null, []);

  const value = useMemo(
    () => ({
      tracks, track, index, playing, duration, ready, analysing,
      position, buffered, scrubbing,
      shuffle, repeat, volume,
      play, pause, toggle, seek, next, previous: previousTrack,
      setShuffle, cycleRepeat, setVolume, levels,
    }),
    [tracks, track, index, playing, duration, ready, analysing, position, buffered,
     scrubbing, shuffle, repeat, volume, play, pause, toggle, seek, next,
     previousTrack, cycleRepeat, setVolume, levels],
  );

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

/** Read the player. */
export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayer must be used inside <PlayerProvider>.');
  return value;
}
