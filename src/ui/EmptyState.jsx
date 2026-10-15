// EmptyState.jsx: name it, say why, give the next action. Left-aligned, no illustration.
export default function EmptyState({ title, reason = null, action = null, className = "" }) {
  return (
    <div className={`t-swap-in py-10 ${className}`}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {reason ? <p className="mt-1 text-xs text-muted-foreground">{reason}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
