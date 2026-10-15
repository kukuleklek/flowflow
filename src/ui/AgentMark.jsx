import { LogoMark } from "./Logo.jsx";

/** The Agent's identity IS the FlowFlow mark (USER-REQUESTS A6): the same ink tile with the lime and white waves as the
 *  header logo, at any size. `tone` is kept so old call sites still work; it no longer changes the look. */
export default function AgentMark({ size = 32, className = "" }) {
  return <LogoMark size={size} className={`shrink-0 ${className}`.trim()} />;
}
