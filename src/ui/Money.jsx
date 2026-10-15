/** "$1,000.00" with the cents one step quieter (the hero number). Size and weight come from the caller. */
export function MoneyHero({ text, className = "" }) {
  const s = String(text);
  const i = s.lastIndexOf(".");
  return (
    <span className={`num ${className}`}>
      {i > 0 ? <>{s.slice(0, i)}<span className="num-dim">{s.slice(i)}</span></> : s}
    </span>
  );
}

export default MoneyHero;
