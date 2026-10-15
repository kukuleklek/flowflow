export type ClassValue = string | false | null | undefined;

/**
 * Tiny class-name joiner: keeps the truthy strings, in order. It does NOT resolve Tailwind conflicts. If your app uses
 * Tailwind and you pass classes that fight a component's defaults (another text colour, another height), re-export
 * your app's own `cn` (clsx + tailwind-merge, or the `cn` package) from this file instead.
 */
export function cn(...values: ClassValue[]): string {
  let out = "";
  for (const v of values) {
    if (v) out = out ? `${out} ${v}` : v;
  }
  return out;
}
