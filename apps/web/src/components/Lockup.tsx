/**
 * The WAX lockup. Wax had no mark before this build; this is it.
 * A hard-ruled box, the word in expanded gothic, and the microtype a label
 * prints beside its name — parentage on one line, what it does on the other.
 */
export function Lockup({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={`lockup${size === 'lg' ? ' lockup--lg' : ''}`}>
      <span className="lockup__word">Wax</span>
      <span className="lockup__meta" aria-hidden="true">
        <span>by DOGS</span>
        {/* <span>DOGS</span> */}
      </span>
    </span>
  );
}
