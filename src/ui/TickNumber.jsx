import { useRef } from "react";
import { AnimatedNumber } from "./kit/index.ts";

/** A live figure whose unchanged leading characters stay still; only the tail that changed pops in
 *  (AnimatedNumber: 500ms, last two characters +70/+140ms). Works because Geist digits are tabular. */
export default function TickNumber({ value, className = "" }) {
  const v = String(value ?? "");
  const prev = useRef(v);
  const split = useRef({ head: "", tail: v });
  if (prev.current !== v) {
    const a = prev.current;
    let i = 0;
    while (i < a.length && i < v.length && a[i] === v[i]) i++;
    if (i >= v.length) i = Math.max(0, v.length - 1);
    split.current = { head: v.slice(0, i), tail: v.slice(i) };
    prev.current = v;
  }
  return (
    <span className={`tabular-nums ${className}`}>
      {split.current.head ? <span>{split.current.head}</span> : null}
      <AnimatedNumber value={split.current.tail} />
    </span>
  );
}
