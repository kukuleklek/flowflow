import { type HTMLAttributes, version } from "react";

// React 19 knows the boolean `inert` prop and renders `inert=""`. React 18 does not know it: it drops a boolean
// `true` (with a warning) and only passes a string through, so there the attribute must be given as "".
const LEGACY_INERT = Number.parseInt(version, 10) < 19;

/**
 * The value to put in an `inert` prop so the attribute is rendered on React 18 and 19 alike. Typed as `true` for JSX
 * (it is "" at runtime on React 18).
 */
export const INERT = (LEGACY_INERT ? "" : true) as unknown as true;

/**
 * Spread onto an element whose subtree must leave the tab order and the accessibility tree while `on`
 * (a closed accordion panel). Returns no props when `on` is false. Typed loosely so it also compiles against
 * @types/react 18, which does not declare `inert`.
 */
export function inertProps(on: boolean): HTMLAttributes<HTMLElement> {
  return on ? ({ inert: INERT } as unknown as HTMLAttributes<HTMLElement>) : {};
}
