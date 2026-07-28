/**
 * THESIS: Wax is a record label whose catalog is the drops it catches. It
 * refuses the category page — a near-black SaaS hero with a glowing vinyl disc
 * and a gradient headline — which is exactly what the wax1 prototype was.
 *
 * OWN-WORLD: Reid Miles' Blue Note program. Four saturated inks owning
 * full-bleed fields over dense offset black and uncoated board; Archivo gothic
 * as architecture, Courier Prime on measured data only; square corners, hard
 * rules, halftone overprint, no shadow at rest.
 *
 * STORY: A collector sees that Wax spots a pressing the minute it exists —
 * one caught in 38 seconds, one already stamped SOLD OUT — and starts tracking
 * three artists free.
 *
 * FIRST VIEWPORT: Ink-black field. Left, the hook at display scale over a
 * vermilion action and a live ticker. Right, a 12-inch sleeve that re-presses
 * itself with each new catch.
 *
 * FORM: The Sleeve Program — 7th on my ordered list, assigned by seed
 * 79d50909. Staging: the 12-inch square module and catalog run, not the
 * offered diagonal spine.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Lockup } from './components/Lockup';
import { Sleeve, StaticSleeve } from './components/Sleeve';
import type { Face } from './components/Sleeve';
import { plans, pipeline, priceWatch, releases, spines } from './data/catalog';

const PRESS_INTERVAL = 7000;

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <TheMiss />
        <BackCover />
        <Crate />
        <PriceWatch />
        <Series />
      </main>
      <Foot />
    </>
  );
}

/* ------------------------------------------------------------------ nav -- */

function Nav() {
  return (
    <header className="nav f-ink">
      <a href="#top" aria-label="Wax, home">
        <Lockup />
      </a>
      <nav className="nav__links t-label">
        <a className="nav__link nav__link--secondary" href="#how">
          How it works
        </a>
        <a className="nav__link nav__link--secondary" href="#prices">
          Price watch
        </a>
        <a className="nav__link" href="#series">
          Pricing
        </a>
        <a className="nav__link mark" href="#start">
          Start free →
        </a>
      </nav>
    </header>
  );
}

/* --------------------------------------------------------- WAX 4001 hero -- */

function Hero() {
  // Two faces and a turn count that only rises. A re-press and a flip to the
  // detail are the same physical move; the next release is cut onto the face
  // that is about to rotate into view, so the swap is never seen.
  const [turn, setTurn] = useState(0);
  const [held, setHeld] = useState(false);
  const [age, setAge] = useState(releases[0].detectedIn);
  const [caught, setCaught] = useState(1);
  const [faces, setFaces] = useState<[Face, Face]>([
    { kind: 'front', release: releases[0] },
    { kind: 'front', release: releases[1] },
  ]);

  const live = faces[turn % 2];
  const release = live.release;

  useEffect(() => {
    if (held) return;
    const press = window.setInterval(() => {
      setTurn((t) => {
        const hidden = (t + 1) % 2;
        setFaces((f) => {
          const seen = f[t % 2].release;
          const nextIdx = (releases.findIndex((r) => r.cat === seen.cat) + 1) % releases.length;
          const next = [...f] as [Face, Face];
          next[hidden] = { kind: 'front', release: releases[nextIdx] };
          return next;
        });
        return t + 1;
      });
      setCaught((c) => c + 1);
    }, PRESS_INTERVAL);
    return () => window.clearInterval(press);
  }, [held]);

  // The detection clock restarts with each new pressing.
  useEffect(() => {
    setAge(release.detectedIn);
    const tick = window.setInterval(() => setAge((a) => a + 1), 1000);
    return () => window.clearInterval(tick);
  }, [release.cat]);

  function turnOver() {
    const hidden = (turn + 1) % 2;
    const next = [...faces] as [Face, Face];
    next[hidden] = held ? { kind: 'front', release } : { kind: 'detail', release };
    setFaces(next);
    setHeld(!held);
    setTurn((t) => t + 1);
  }

  // Only the face you can see carries a running clock.
  const shown: [Face, Face] = [
    withAge(faces[0], turn % 2 === 0 ? age : null),
    withAge(faces[1], turn % 2 === 1 ? age : null),
  ];

  return (
    <section className="band f-ink halftone" id="top">
      <div className="wrap hero">
        <div className="hero__hook">
          <p className="t-label mark">Real-time vinyl drop alerts</p>
          <h1 className="t-display">
            You will not
            <br />
            miss the pressing
          </h1>
          <p className="t-lead dim">
            Wax watches Discogs for the artists you follow and tells you the second a vinyl
            variant exists — push, email and text — while there are still copies to buy. Not a
            daily digest. Not a subreddit you had to be reading.
          </p>

          <div className="hero__actions" id="start">
            <a className="btn btn--primary" href="#series">
              Track your first 3 artists — free
            </a>
            <a className="btn btn--ghost" href="#how">
              How the watcher works
            </a>
          </div>

          <div className="hero__ticker">
            <p className="t-data live">
              <span className="live__dot" />
              Watching {(1284).toLocaleString()} artists
            </p>
            <p className="t-data dim">
              {caught} pressing{caught === 1 ? '' : 's'} caught this session
            </p>
            <p className="synthetic">Sample feed · synthetic data</p>
          </div>
        </div>

        <div className="hero__stage">
          <Sleeve
            faces={shown}
            turn={turn}
            onTurn={turnOver}
            actionLabel={
              held
                ? 'Resume the feed and show the sleeve front'
                : `Hold this pressing and read the detail for ${release.artist} — ${release.title}`
            }
          />
          <div className="hero__caption">
            <p className="t-data dim">
              {release.label} · {release.labelCat}
            </p>
            <p className="t-data live">
              {held ? 'Held — click the sleeve to resume' : `Dispatched in ${release.detectedIn}s`}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function withAge(face: Face, age: number | null): Face {
  return face.kind === 'front' ? { ...face, age } : face;
}

/* ---------------------------------------------------- WAX 4002 the miss -- */

function TheMiss() {
  return (
    <section className="band f-vermilion halftone">
      <div className="wrap miss">
        <div className="sleeve-holder">
          {/* A white-label sleeve carrying a vermilion overprint — the stamp
              needs board stock underneath it to read, and a plain label is
              what an unsold test pressing actually looks like. */}
          <StaticSleeve release={{ ...releases[3], ink: 'board' }} soldOut flippable={false} />
        </div>
        <div>
          <div className="opener">
            <span className="opener__cat">WAX 4002</span>
            <span className="opener__name">The reason this exists</span>
          </div>
          <h2 className="t-display">The pressing was gone before you heard about it</h2>
          <p className="t-lead" style={{ marginTop: 'var(--md)' }}>
            BT's <i>This Binary Universe</i> came to vinyl and was gone. Not because you were
            outbid, or too slow at checkout — because nobody told you it existed until the
            listing was already dead and the only copies left were resale.
          </p>
          <p className="t-body dim" style={{ marginTop: 'var(--md)' }}>
            That is the whole failure. A limited pressing does not sell out because it is
            popular; it sells out because 300 copies meet an audience that never got the news.
            Every collector has a record they would have bought at list price and now will not
            pay four times for. Wax exists so that list stops growing.
          </p>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------- WAX 4003 the back cover -- */

function BackCover() {
  return (
    <section className="band f-board" id="how">
      <div className="wrap">
        <div className="opener">
          <span className="opener__cat">WAX 4003</span>
          <span className="opener__name">Session credits · how it works</span>
        </div>
        <h2 className="t-display" style={{ maxWidth: '25ch' }}>
          Four passes, running while you are asleep
        </h2>
        <p className="t-body dim" style={{ marginTop: 'var(--sm)', marginBottom: 'var(--lg)' }}>
          Read this like the back of a sleeve. Each pass names what runs, what it reads, and
          what it hands to the next one.
        </p>

        <div className="credits">
          {pipeline.map((p) => (
            <article className="credit" key={p.n}>
              <p className="credit__n mark">
                {p.n} · {p.role}
              </p>
              <h3 className="t-headline">{p.title}</h3>
              <p className="credit__body dim">{p.body}</p>
              <ul className="credit__detail">
                {p.detail.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------- WAX 4004 crate -- */

function Crate() {
  return (
    <section className="band f-ink">
      <div className="wrap">
        <div className="opener">
          <span className="opener__cat">WAX 4004</span>
          <span className="opener__name">Your crate</span>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--md)',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <h2 className="t-display" style={{ maxWidth: '16ch' }}>
            Every copy you own, filed by variant
          </h2>
          <p className="t-body dim" style={{ maxWidth: '46ch' }}>
            Catalogue what you have with the pressing, the variant and what you paid, pulled
            from Discogs rather than typed in. Keep what you are still hunting on a want list
            with its price watched.
          </p>
        </div>

        <div className="crate" role="list" aria-label="Sample collection spines">
          {spines.map((s, n) => (
            <button
              className="spine"
              key={`${s.cat}-${n}`}
              role="listitem"
              style={
                {
                  '--s-ink': `var(--${s.ink})`,
                  '--s-text': s.ink === 'ultramarine' ? 'var(--stock)' : 'var(--ink)',
                } as CSSProperties
              }
            >
              <span className="spine__cat">{s.cat}</span>
              <span className="spine__text">
                {s.artist} — {s.title}
              </span>
            </button>
          ))}
        </div>
        <p className="synthetic" style={{ marginTop: 'var(--md)' }}>
          Sample crate · synthetic data
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------- WAX 4005 price watch -- */

function PriceWatch() {
  return (
    <section className="band f-chartreuse halftone" id="prices">
      <div className="wrap">
        <div className="opener">
          <span className="opener__cat">WAX 4005</span>
          <span className="opener__name">Listing price watch</span>
        </div>
        <h2 className="t-display" style={{ maxWidth: '28ch' }}>
          Learn what it is worth before you pay what they ask
        </h2>
        <p className="t-body dim" style={{ marginTop: 'var(--sm)', marginBottom: 'var(--lg)' }}>
          Wax tracks Discogs listings on everything you want. Set the number you would happily
          pay, and the alert comes when a listing crosses it — not when you happen to look.
        </p>

        <table className="watch">
          <thead>
            <tr>
              <th>Release</th>
              <th className="watch__hide">Cat.</th>
              <th className="watch__num">Low</th>
              <th className="watch__num">Now</th>
              <th className="watch__num watch__hide">High</th>
              <th className="watch__hide">Range</th>
              <th className="watch__num">Your target</th>
            </tr>
          </thead>
          <tbody>
            {priceWatch.map((r) => {
              const pct = (v: number) => ((v - r.low) / (r.high - r.low)) * 100;
              return (
                <tr key={r.cat}>
                  <td>
                    <span className="watch__title">{r.title}</span>
                    <br />
                    <span className="dim">{r.artist}</span>
                  </td>
                  <td className="watch__hide dim">{r.cat}</td>
                  <td className="watch__num">${r.low}</td>
                  <td className="watch__num">
                    <b>${r.now}</b>
                  </td>
                  <td className="watch__num watch__hide dim">${r.high}</td>
                  <td className="watch__hide">
                    <div className="bar" aria-hidden="true">
                      <span className="bar__now" style={{ left: `${pct(r.now)}%` }} />
                      <span className="bar__target" style={{ left: `${pct(r.target)}%` }} />
                    </div>
                  </td>
                  <td className="watch__num">
                    {r.dir === 'hit' ? (
                      <span className="watch__hit">Hit ${r.target}</span>
                    ) : (
                      <span>${r.target}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="synthetic" style={{ marginTop: 'var(--md)' }}>
          Sample listings · synthetic data
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- WAX 4006 series -- */

function Series() {
  return (
    <section className="band f-board" id="series">
      <div className="wrap">
        <div className="opener">
          <span className="opener__cat">WAX 4006</span>
          <span className="opener__name">The subscription series</span>
        </div>
        <h2 className="t-display" style={{ maxWidth: '26ch', marginBottom: 'var(--md)' }}>
          Prove the engine on three artists first
        </h2>

        <div className="series">
          {plans.map((p) => (
            <article className={`plan ${p.ink === 'vermilion' ? 'f-vermilion' : 'f-board'}`} key={p.cat}>
              <div className="plan__head">
                <p className="t-data dim">{p.cat}</p>
                <h3 className="t-label">{p.name}</h3>
                <p className="plan__price">
                  {p.price}
                  <span className="t-data dim">{p.per}</span>
                </p>
                <p className="t-body">{p.line}</p>
              </div>
              <div className="plan__body">
                <ul className="plan__features">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
              <div className="plan__foot">
                {p.note && <p className="t-data dim">{p.note}</p>}
                <button className={p.ink === 'vermilion' ? 'btn btn--primary' : 'btn btn--ghost'}>
                  {p.action}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SignUp() {
  const [artist, setArtist] = useState('');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'error' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const artistRef = useRef<HTMLInputElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!artist.trim()) {
      setState('error');
      setMessage('Name an artist to watch — Wax needs something to listen for.');
      artistRef.current?.focus();
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setState('error');
      setMessage('That address will not receive an alert. Check for a typo and try again.');
      return;
    }
    setState('done');
    setMessage(`Watching ${artist.trim()}. Two slots left on the free tier.`);
  }

  return (
    <form
      className="signup"
      onSubmit={submit}
      style={{ marginTop: 'var(--md)' }}
    >
      <div className="field">
        <label className="field__label" htmlFor="su-artist">
          First artist to watch
        </label>
        <input
          className="field__input"
          id="su-artist"
          ref={artistRef}
          value={artist}
          onChange={(e) => {
            setArtist(e.target.value);
            setState('idle');
          }}
          placeholder="BT"
          aria-invalid={state === 'error' && !artist.trim()}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="su-email">
          Where the alert goes
        </label>
        <input
          className="field__input"
          id="su-email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setState('idle');
          }}
          placeholder="you@example.com"
        />
      </div>
      <button className="btn btn--primary" type="submit">
        Start watching
      </button>
      <p
        className="field__note"
        data-state={state === 'error' ? 'error' : undefined}
        role="status"
        style={{ flexBasis: '100%' }}
      >
        {state === 'idle'
          ? 'Free for three artists, forever. No card.'
          : message}
      </p>
    </form>
  );
}

/* ---------------------------------------------------------------- foot -- */

function Foot() {
  return (
    <footer className="foot f-ink">
      <div className="wrap">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--md)',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <Lockup size="lg" />
          <p className="t-body dim" style={{ maxWidth: '38ch' }}>
            Built on Discogs data. Made by DOGS.
          </p>
        </div>

        {/* The committed action sits on the final panel. */}
        <SignUp />

        <div className="foot__index">
          {releases.map((r) => (
            <p className="foot__entry" key={r.cat}>
              <span>{r.cat}</span>
              <span>
                {r.artist} — {r.title}
              </span>
            </p>
          ))}
        </div>

        <div className="foot__base">
          <p className="t-data dim">© 2026 DOGS</p>
          <p className="t-data dim">Release data via the Discogs API</p>
          <p className="synthetic" style={{ marginLeft: 'auto' }}>
            All catalog entries shown are synthetic
          </p>
        </div>
      </div>
    </footer>
  );
}
