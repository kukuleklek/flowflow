"use client";

import type { RefObject } from "react";
import { useIsoLayoutEffect } from "./iso-layout-effect";
import { parseCssTime } from "./motion-logic";
import { prefersReducedMotion } from "./use-motion";

/**
 * Under reduced motion the pill does not travel; it appears at the new tab with the short opacity cross-fade
 * (--rm-fade-dur, --ease-in-out). Web Animations, so the CSS reduced-motion safety net leaves it alone.
 */
function fadeIn(el: HTMLElement): void {
  if (typeof el.animate !== "function") return;
  const root = getComputedStyle(document.documentElement);
  const duration = parseCssTime(root.getPropertyValue("--rm-fade-dur"), 150);
  const easing = root.getPropertyValue("--ease-in-out").trim() || "ease-in-out";
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing });
}

/**
 * 16 Tabs sliding: writes the active tab's offsetLeft / offsetWidth (and its top / height) onto the pill; CSS owns
 * the tween. First paint and resizes snap without a transition. The active tab is found with `activeSelector`
 * (aria-selected / aria-current / Radix data-state), and attribute changes inside the list move the pill.
 * `from`: optional selector for where the pill should appear to come from on mount (a remounted control, e.g. a
 * segmented "A | B" bar across a route change), then it slides to the active tab.
 */
export function useSlidingPill(
  listRef: RefObject<HTMLElement | null>,
  pillRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  from?: string | null,
): void {
  useIsoLayoutEffect(() => {
    const list = listRef.current;
    const pill = pillRef.current;
    if (!list || !pill) return;

    const write = (tab: HTMLElement) => {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      pill.style.top = `${tab.offsetTop}px`;
      pill.style.height = `${tab.offsetHeight}px`;
    };
    const snap = (tab: HTMLElement) => {
      const prev = pill.style.transition;
      pill.style.transition = "none";
      write(tab);
      void pill.offsetWidth;
      pill.style.transition = prev;
    };
    let current: HTMLElement | null = null;
    const move = (animate: boolean) => {
      const tab = list.querySelector<HTMLElement>(activeSelector);
      if (!tab) {
        pill.style.opacity = "0";
        return;
      }
      pill.style.opacity = "";
      const changed = tab !== current;
      current = tab;
      if (animate && prefersReducedMotion()) {
        snap(tab);
        if (changed) fadeIn(pill);
      } else if (animate) write(tab);
      else snap(tab);
    };

    const origin = from ? list.querySelector<HTMLElement>(from) : null;
    // Until this runs (static HTML before hydration) CSS styles the active tab itself; see .t-tabs in css/motion.css.
    pill.setAttribute("data-ready", "");
    let raf = 0;
    if (origin) {
      snap(origin);
      raf = window.requestAnimationFrame(() => move(true));
    } else {
      move(false);
    }

    const mo = new MutationObserver(() => move(true));
    mo.observe(list, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "aria-current", "data-state"],
    });
    let firstResize = true;
    const ro = new ResizeObserver(() => {
      if (firstResize) {
        firstResize = false;
        return;
      }
      move(false);
    });
    ro.observe(list);
    return () => {
      window.cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
    };
  }, [listRef, pillRef, activeSelector, from]);
}
