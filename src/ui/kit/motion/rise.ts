import type { CSSProperties } from "react";
import { staggerIndex } from "./motion-logic";

/**
 * Props for a list row / block that rises in when it mounts (first load: staggered by index, capped; inserts later:
 * same entrance). Keyed rows are not remounted by polling, so updates never replay it.
 */
export function rise(i = 0): { className: string; style: CSSProperties } {
  return { className: "t-rise", style: { "--i": staggerIndex(i) } as CSSProperties };
}
