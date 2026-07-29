/**
 * @file Who is signed in, and everything they can see.
 *
 * One context holds both the session and the bootstrap payload, because in
 * this app they have exactly the same lifetime: signing in produces the data,
 * signing out destroys it, and there is no state where you have one without
 * the other. Splitting them would mean two providers that must always be
 * mounted and unmounted together — a coupling better expressed by not
 * splitting them.
 *
 * Screens read slices of it:
 *
 * ```js
 * const { user, alerts, refresh } = useSession();
 * ```
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, setToken } from '../data/client.js';

/** Where the bearer token is persisted between launches. */
const TOKEN_KEY = 'wax.session.token';

const SessionContext = createContext(null);

/**
 * @typedef {object} SessionValue
 * @property {'loading'|'signed-out'|'signed-in'} status
 * @property {?import('@wax/core').User}     user
 * @property {?import('@wax/core').Profile}  profile
 * @property {any[]}   alerts     The alert board, joined.
 * @property {object}  counts     Per-state alert counts.
 * @property {any[]}   crate
 * @property {any[]}   watches
 * @property {any[]}   priceWatch
 * @property {any[]}   tracks     The player's catalog.
 * @property {?object} profileView
 * @property {?string} error      Last sign-in failure, for the form to show.
 * @property {boolean} busy       A sign-in is in flight.
 * @property {(input: {email?: string, password?: string, test?: boolean}) => Promise<boolean>} signIn
 * @property {() => Promise<boolean>} signInAsTest
 * @property {() => Promise<void>}    signOut
 * @property {() => Promise<void>}    refresh  Re-fetch everything after a write.
 * @property {(patch: object) => void} patch   Optimistic local update.
 */

/** The empty payload, so screens never destructure `undefined`. */
const EMPTY = {
  alerts: [],
  counts: { all: 0, live: 0, caught: 0, sold_out: 0, watching: 0, missed: 0, unread: 0 },
  crate: [],
  watches: [],
  priceWatch: [],
  tracks: [],
  profileView: null,
};

/**
 * Normalise a bootstrap response into the flat shape the context exposes.
 * The API uses snake_case (it mirrors the SQL); the app uses camelCase. This
 * function is the only place the two meet.
 *
 * @param {any} payload
 */
const shape = (payload) => ({
  alerts: payload.alerts ?? [],
  counts: payload.counts ?? EMPTY.counts,
  crate: payload.crate ?? [],
  watches: payload.watches ?? [],
  priceWatch: payload.price_watch ?? [],
  tracks: payload.tracks ?? [],
  profileView: payload.profile_view ?? null,
});

export function SessionProvider({ children }) {
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * Pull the full payload and move to signed-in. Shared by launch, sign-in and
   * refresh so there is one code path that can put the app in that state.
   */
  const load = useCallback(async () => {
    const payload = await api.bootstrap();
    setUser(payload.user);
    setProfile(payload.profile);
    setData(shape(payload));
    setStatus('signed-in');
  }, []);

  // Restore a persisted session on launch. A dead or missing token is the
  // ordinary case for a first run, not an error worth surfacing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(TOKEN_KEY);
        if (!stored) throw new Error('no stored token');
        await api.session(stored);
        if (!cancelled) await load();
      } catch {
        if (cancelled) return;
        setToken(null);
        await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
        setStatus('signed-out');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * @param {{email?: string, password?: string, test?: boolean}} input
   * @returns {Promise<boolean>} Whether it worked.
   */
  const signIn = useCallback(
    async (input) => {
      setBusy(true);
      setError(null);
      try {
        const session = await api.login(input);
        await AsyncStorage.setItem(TOKEN_KEY, session.token).catch(() => {});
        await load();
        return true;
      } catch (err) {
        setError(err?.message ?? 'Sign-in failed.');
        setStatus('signed-out');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const signInAsTest = useCallback(() => signIn({ test: true }), [signIn]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
    setUser(null);
    setProfile(null);
    setData(EMPTY);
    setError(null);
    setStatus('signed-out');
  }, []);

  /** Re-fetch everything. Called after any write that changes more than one screen. */
  const refresh = useCallback(async () => {
    if (status !== 'signed-in') return;
    try {
      await load();
    } catch {
      // A failed refresh leaves the last good data on screen, which is more
      // useful than an error state over content that is merely slightly stale.
    }
  }, [status, load]);

  /**
   * Merge a partial update in without a round trip, so a tap lands instantly
   * and `refresh()` reconciles afterwards.
   * @param {Partial<typeof EMPTY>} next
   */
  const patch = useCallback((next) => setData((current) => ({ ...current, ...next })), []);

  const value = useMemo(
    () => ({ status, user, profile, ...data, error, busy, signIn, signInAsTest, signOut, refresh, patch }),
    [status, user, profile, data, error, busy, signIn, signInAsTest, signOut, refresh, patch],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Read the session.
 * @returns {SessionValue}
 */
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}
