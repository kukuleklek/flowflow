// SectionHead.jsx: h2 + mono meta, no icon.
export default function SectionHead({ title, meta = null, as: H = "h2", className = "", children = null }) {
  return (
    <div className={`flex items-baseline gap-2 ${className}`}>
      <H className="text-h2">{title}</H>
      {meta != null ? <span className="font-mono text-[11px] text-muted-foreground">{meta}</span> : null}
      {children}
    </div>
  );
}
