// LiveDot.jsx: the olive status dot. pulse = the view's ONE ambient loop (chart "Live" only).
export default function LiveDot({ pulse = false, className = "" }) {
  return <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full bg-brand ${pulse ? "t-updating" : ""} ${className}`} />;
}
