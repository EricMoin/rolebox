/**
 * TEMPORARY structural stand-in for the `react` module type surface.
 *
 * The dsh web-UI slot integration (this directory) needs React types for the
 * dock component (`role-switch-dock.tsx`) and the JSX intrinsic-element
 * vocabulary. `react` / `@types/react` are NOT yet devDependencies of this
 * repo — subtask 3 of the dsh web-UI slot integration installs them together
 * with the `@deepseek-ai/*` client packages — so this stub provides just the
 * surface this directory uses, duck-typed against the documented
 * `react@18` / `@types/react@18.3` shapes (the dsh client packages peer on
 * `react ^18.2.0`).
 *
 * DELECTION CONTRACT (important):
 *   - DELETE THIS FILE as part of subtask 3, the moment `react` +
 *     `@types/react` land in package.json devDependencies. The real types
 *     supersede it; keeping the stub would produce duplicate-identifier
 *     conflicts when the ambient `declare module "react"` merges with the
 *     real module declarations.
 *   - Until then this file is the single source of the react type surface for
 *     this directory; extend it here if the dock needs more of react.
 *
 * The `JSX.IntrinsicElements` index signature is intentionally loose (every
 * attribute `unknown`) — it is a structural stand-in, not a faithful copy of
 * react's DOM typings; the real @types/react install replaces it.
 *
 * @module
 */

declare module "react" {
  /** `useState` — hook state (structural copy of @types/react's signature). */
  export function useState<S>(
    initial: S | (() => S),
  ): [S, (value: S | ((previous: S) => S)) => void];
  /** `useEffect` — side-effect hook (structural copy; deps optional). */
  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ): void;
  /** `createElement` — element factory (structural copy). */
  export function createElement(
    type: unknown,
    props: object | null,
    ...children: unknown[]
  ): unknown;
  /** `Fragment` — the fragment element type. */
  export const Fragment: unique symbol;
  /** `ReactNode` — the composed children type. */
  export type ReactNode = unknown;
}

/** Global JSX vocabulary (preserve-mode transform resolves it globally). */
declare namespace JSX {
  interface IntrinsicElements {
    [elem: string]: { [attr: string]: unknown };
  }
}
