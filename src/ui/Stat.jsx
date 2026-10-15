/** A dl stat strip: natural-width cells divided by vertical hairlines; 11px label, 6px gap, 14/500 value. */
export function StatStrip({ className = "", children }) {
  return <dl className={`no-scrollbar flex items-center overflow-x-auto ${className}`}>{children}</dl>;
}
export function Stat({ label, children, className = "", valueClassName = "" }) {
  return (
    <div className={`shrink-0 border-l border-border px-4 first:border-l-0 first:pl-0 ${className}`}>
      <dt className="whitespace-nowrap text-label text-muted-foreground">{label}</dt>
      <dd className={`num mt-1.5 whitespace-nowrap text-sm font-medium leading-none text-foreground ${valueClassName}`}>{children}</dd>
    </div>
  );
}
