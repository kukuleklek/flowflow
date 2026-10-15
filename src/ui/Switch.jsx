// Switch.jsx: the kit toggle (27), ink when on. The thumb animates only after the first press.
import { useState } from "react";
export default function Switch({ checked, onChange, label, className = "", ...rest }) {
  const [init, setInit] = useState(false);
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      data-on={checked ? "true" : "false"} data-size="default"
      onClick={() => { setInit(true); onChange(!checked); }}
      className={`t-toggle ff-hit relative inline-block h-5 w-[34px] shrink-0 rounded-full transition-colors ${checked ? "bg-foreground" : "bg-input"} ${init ? "is-init" : ""} ${className}`}
      {...rest}
    >
      <span className="t-toggle-thumb absolute left-0.5 top-0.5 block size-4 rounded-full bg-card shadow-[0_1px_2px_rgb(9_9_11/0.25)]" />
    </button>
  );
}
