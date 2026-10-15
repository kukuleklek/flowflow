/** FlowFlow's mark (public/flowflow-mark.svg): an ink tile with two flowing lines, the top one in the brand lime.
 *  The parts carry `tile` / `w1` / `w2` so a parent can restyle them with CSS (the Agent send button, `.ff-send`);
 *  anywhere else the presentation attributes below draw the real mark. */
export function LogoMark({ size = 28, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className || undefined} aria-hidden="true">
      <rect className="tile" width="64" height="64" rx="16" fill="rgb(var(--foreground-rgb))" />
      <path className="w1" d="M14 26c6-6 12-6 18 0s12 6 18 0" fill="none" stroke="rgb(var(--brand-solid-rgb))" strokeWidth="5" strokeLinecap="round" />
      <path className="w2" d="M14 40c6-6 12-6 18 0s12 6 18 0" fill="none" stroke="rgb(var(--background-rgb))" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

export default function Logo({ size = 26, word = true }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={size} />
      {word ? <span className="text-base font-semibold tracking-[-0.03em]">FlowFlow</span> : null}
    </span>
  );
}
