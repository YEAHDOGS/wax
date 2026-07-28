import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Release } from '../data/catalog';

/**
 * The sleeve. The system's defining object and its whole navigation metaphor:
 * the front is the hook, the back is the data, and turning it over is a real
 * rotation in space — the gesture a collector already makes.
 *
 * Two faces, and a turn count that only ever increases, so a re-press and a
 * flip-to-detail are the same physical move. The caller decides what is on the
 * face about to rotate into view; that is how a new release gets cut onto a
 * sleeve mid-turn without ever showing the swap.
 *
 * Sleeve art is authored, not photographed: an ink field, the artist set
 * narrow and running up the left edge, the title at architectural scale, and
 * a press block cropped by the sleeve edge. Type is the image.
 */

export type Face =
  | { kind: 'front'; release: Release; age?: number | null; soldOut?: boolean }
  | { kind: 'detail'; release: Release };

interface SleeveProps {
  faces: [Face, Face];
  /** Half-turns taken. Even shows face 0, odd shows face 1. */
  turn: number;
  onTurn?: () => void;
  actionLabel?: string;
}

export function Sleeve({ faces, turn, onTurn, actionLabel }: SleeveProps) {
  return (
    <div className="sleeve" style={{ '--turn': turn } as CSSProperties}>
      <div className="sleeve__turn">
        <SleeveFace face={faces[0]} back={false} hidden={turn % 2 !== 0} />
        <SleeveFace face={faces[1]} back hidden={turn % 2 === 0} />
      </div>

      {onTurn && (
        <button type="button" className="sleeve__grab" onClick={onTurn}>
          <span className="visually-hidden">{actionLabel ?? 'Turn the sleeve over'}</span>
        </button>
      )}
    </div>
  );
}

/** A sleeve that turns itself over when clicked. For static, non-cycling use. */
export function StaticSleeve({
  release,
  soldOut = false,
  flippable = true,
}: {
  release: Release;
  soldOut?: boolean;
  flippable?: boolean;
}) {
  const [turn, setTurn] = useState(0);
  return (
    <Sleeve
      faces={[
        { kind: 'front', release, soldOut },
        { kind: 'detail', release },
      ]}
      turn={turn}
      onTurn={flippable ? () => setTurn((t) => t + 1) : undefined}
      actionLabel={
        turn % 2 === 0
          ? `Show release details for ${release.artist} — ${release.title}`
          : 'Show the sleeve front'
      }
    />
  );
}

function SleeveFace({ face, back, hidden }: { face: Face; back: boolean; hidden: boolean }) {
  const cls = `sleeve__face${back ? ' sleeve__face--back' : ''}`;
  // Faces rotated out of view are removed from the accessibility tree, so a
  // screen reader never reads both sides of the same sleeve at once.
  const shared = { 'aria-hidden': hidden, inert: hidden };

  if (face.kind === 'detail') {
    const r = face.release;
    return (
      <div {...shared} className={`${cls} f-board`}>
        <div className="sleeve__back">
          <p className="t-label">{r.cat} · Release detail</p>
          <h3 className="t-headline">
            {r.artist} — {r.title}
          </h3>
          <dl style={{ marginTop: 'auto' }}>
            <Credit term="Label" value={r.label} />
            <Credit term="Cat. no." value={r.labelCat} />
            <Credit term="Format" value={r.format} />
            <Credit term="Variant" value={r.variant} />
            <Credit term="Pressing" value={`${r.pressing.toLocaleString()} copies`} />
            <Credit term="Street date" value={r.street} />
            <Credit term="List price" value={r.price} />
            <Credit term="Detected" value={`${r.detectedIn}s after listing`} />
            <Credit
              term="Sold through"
              value={r.soldOutIn === null ? 'Still available' : `${r.soldOutIn} min`}
            />
          </dl>
        </div>
      </div>
    );
  }

  const r = face.release;
  return (
    <div {...shared} className={`${cls} f-${r.ink} halftone`}>
      {/* The impression: ink field, then the type strikes into it. */}
      <div className="sleeve__ink" key={r.cat} />
      <div className="sleeve__block" aria-hidden="true" />
      <p className="sleeve__spineword" aria-hidden="true">
        {r.artist}
      </p>
      <h3 className="sleeve__title">{r.title}</h3>
      <p className="sleeve__variant">{r.variant}</p>

      <div className="sleeve__corners">
        <span>{r.cat}</span>
        <span>Stereo</span>
        <span />
        <span>{r.format.split(' / ')[0]}</span>
        <span>
          {face.age != null ? (
            <>
              Detected <b>{formatAge(face.age)}</b> ago
            </>
          ) : (
            r.labelCat
          )}
        </span>
        <span>{r.pressing.toLocaleString()} copies</span>
      </div>

      {face.soldOut && (
        <div className="overprint" aria-hidden="true">
          <p className="overprint__stamp">Sold Out</p>
        </div>
      )}
    </div>
  );
}

function Credit({ term, value }: { term: string; value: string }) {
  return (
    <div className="sleeve__creditrow">
      <dt>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
