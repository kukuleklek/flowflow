import { useEffect, useLayoutEffect } from "react";

/**
 * useLayoutEffect in the browser, useEffect on the server. Neither runs during server rendering; this only silences
 * React 18's "useLayoutEffect does nothing on the server" warning (React 19 no longer prints it).
 */
export const useIsoLayoutEffect: typeof useLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
