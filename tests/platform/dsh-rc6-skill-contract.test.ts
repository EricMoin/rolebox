/// <reference types="bun-types" />

/**
 * rc.6 contract probes for `ctx.skills` against the REAL installed
 * `@deepseek-ai/dsh-skill` dist.
 *
 * This file imports the actual `@deepseek-ai/dsh-skill` package from
 * `node_modules` (the installed `0.1.5-rc.1`, the version rolebox runs) and
 * mounts it on a real `@deepseek-ai/cordis` Context — mirroring the async
 * mount in `tests/platform/dsh-rc6-contract.test.ts:100-110` and
 * `tests/dsh-cordis-e2e.test.ts:488` (`new Context()` then
 * `await ctx.plugin(Service, {})`).
 *
 * It is the executable counterpart to the skill-surface defect: rolebox's dsh
 * adapter has no mechanism to publish role skills into this registry, and the
 * proposed remedy (a global lazy `SkillProvider`) must satisfy the exact rc.6
 * `registerProvider` contract. Like the sibling rc.6 file, this suite probes
 * the harness directly and is intentionally independent of `src/` — it fails
 * if the installed rc.6 contract moves.
 *
 * Covered assertions (requirement -> rc.6 source):
 *   (a) `registerProvider` is FACTORY-style: it invokes `create(control)` and
 *       `control` is `{signal: AbortSignal, invalidate: fn}` — not a provider.
 *       `dsh-skill/lib/index.js:147-159`; `lib/types/index.d.ts:249`
 *       (`registerProvider(create: (control) => SkillProvider)`),
 *       `:190-195` (`SkillProviderControl`).
 *   (b) the return value is a callable disposer that removes the provider from
 *       a subsequent `list()`.
 *       `lib/index.js:164-178` (`this.layers.effect(...)` teardown calls
 *       `undo()`); `lib/types/index.d.ts:249-250`.
 *   (c) a candidate whose `name` breaks `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
 *       (`rolebox--x`, `a~b`) makes `list()` REJECT — the provider must
 *       pre-filter names.
 *       `lib/index.js:17` (grammar), `:29-31` (`isSkillName`), `:360` +
 *       `:454` (`validateCandidate` throws outside the provider-list
 *       try/catch).
 *   (d) a candidate with `invocation.modelInvocable:false` still appears in
 *       `list()` but is excluded by the exported `isModelInvocable`.
 *       `lib/index.js:37-39`, `:224-226,234-240`; `lib/types/index.d.ts:109`.
 *   (e) an arbitrary custom `source` string (`'rolebox'`) survives validation.
 *       `lib/index.js:459` (only `typeof === "string"` is checked);
 *       `lib/types/index.d.ts:24` (`SkillSource` ends in `(string & {})`).
 *   (f) `rank` decides duplicate names within one layer, lower wins —
 *       independent of registration order.
 *       `lib/index.js:314`, `:317-325` (first-wins after sort), `:518-520`
 *       (`compareIndexedCandidates`).
 *   (g) the provider receives ONLY `{cwd, signal}` — no `scope`/`agent`/
 *       `session` key leaks into the provider lookup contract.
 *       `lib/index.js:350` (`provider.list(options)`), `:298-313` (the same
 *       options object is threaded through); `lib/types/index.d.ts:88-100`.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry, isModelInvocable, isSkillName } from "@deepseek-ai/dsh-skill";
import type {
  SkillCandidate,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from "@deepseek-ai/dsh-skill";

/** Provider name used by every probe; candidates must echo it. */
const PROVIDER = "rolebox-probe";

/** Fibers created by `mountRegistry()`, disposed after each test. */
let fibers: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const fiber of fibers) fiber.dispose();
  fibers = [];
});

/**
 * Mount the real `SkillRegistry` service on a fresh cordis Context. Mirrors the
 * async mount in `tests/platform/dsh-rc6-contract.test.ts` (a `Service`
 * subclass loaded through `ctx.plugin`); returns the registry as `ctx.skills`
 * (the module augmentation in `dsh-skill/lib/types/index.d.ts:201-204`).
 */
async function mountRegistry() {
  const ctx = new Context();
  const fiber = await ctx.plugin(SkillRegistry as never, {} as never);
  fibers.push(fiber as unknown as { dispose(): void });
  return { ctx, skills: ctx.skills };
}

/**
 * Build a valid `SkillCandidate`. `provider` must equal the owning provider's
 * name — `validateCandidate` rejects a mismatch
 * (`dsh-skill/lib/index.js:462`).
 */
function candidate(
  provider: string,
  name: string,
  over: Partial<SkillCandidate> = {},
): SkillCandidate {
  return {
    name,
    description: `skill ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    // A named union member by default; (e) exercises a custom string.
    source: "project-dsh",
    provider,
    rank: 100,
    locator: { name },
    ...over,
  };
}

/** A minimal provider whose `get` is never exercised by the `list()` probes. */
function makeProvider(name: string, list: SkillProvider["list"]): SkillProvider {
  return {
    name,
    list,
    get: async () => undefined,
  };
}

describe("rc.6 contract: real @deepseek-ai/dsh-skill ctx.skills", () => {
  it("(a) registerProvider takes a factory and hands it {signal, invalidate}", async () => {
    const { skills } = await mountRegistry();
    // `dsh-skill/lib/index.js:147-159`: `create(control)` is invoked
    // synchronously; `control` is the registration lifecycle+invalidation
    // capability, NOT a provider.
    // `dsh-skill/lib/types/index.d.ts:249`.
    let calls = 0;
    let control: SkillProviderControl | undefined;
    const provider = makeProvider(PROVIDER, async () => []);
    const disposer = skills.registerProvider((c) => {
      calls += 1;
      control = c;
      return provider;
    });

    // Factory invoked exactly once, before registration returns.
    expect(calls).toBe(1);
    expect(control).toBeDefined();
    // `dsh-skill/lib/index.js:151-157` + `lib/types/index.d.ts:190-195`.
    expect(control!.signal).toBeInstanceOf(AbortSignal);
    expect(control!.signal.aborted).toBe(false);
    expect(typeof control!.invalidate).toBe("function");
    expect(() => control!.invalidate()).not.toThrow();
    // `dsh-skill/lib/index.js:164-178` returns the Cordis effect disposer.
    expect(typeof disposer).toBe("function");
  });

  it("(b) the returned disposer removes the provider from a subsequent list()", async () => {
    const { skills } = await mountRegistry();
    const provider = makeProvider(PROVIDER, async () => [
      candidate(PROVIDER, "alpha-skill"),
    ]);
    // `dsh-skill/lib/index.js:164-178`: the returned effect's teardown calls
    // `undo()`, which unregisters the provider (and the layer callback
    // invalidates the catalog cache, `:122-124`).
    const dispose = skills.registerProvider(() => provider);

    expect((await skills.list()).map((s) => s.name)).toEqual(["alpha-skill"]);

    dispose();

    expect((await skills.list()).map((s) => s.name)).toEqual([]);
  });

  it("(c) a non-kebab candidate name makes list() reject (pre-filter requirement)", async () => {
    // `dsh-skill/lib/index.js:17` grammar + `:29-31` `isSkillName`.
    expect(isSkillName("rolebox--x")).toBe(false);
    expect(isSkillName("a~b")).toBe(false);
    expect(isSkillName("rolebox-x")).toBe(true); // positive control

    for (const bad of ["rolebox--x", "a~b"]) {
      const { skills } = await mountRegistry();
      skills.registerProvider(() =>
        makeProvider(PROVIDER, async () => [candidate(PROVIDER, bad)]),
      );
      // `dsh-skill/lib/index.js:360` calls `validateCandidate`, which throws
      // at `:454`; that call sits OUTSIDE the provider-list try/catch
      // (`:349-355`), so the whole catalog call rejects rather than skipping.
      await expect(skills.list()).rejects.toThrow(/invalid skill name/);
    }
  });

  it("(d) modelInvocable:false stays in list() but is excluded by isModelInvocable", async () => {
    const { skills } = await mountRegistry();
    skills.registerProvider(() =>
      makeProvider(PROVIDER, async () => [
        candidate(PROVIDER, "hidden-skill", {
          invocation: { modelInvocable: false, userInvocable: true },
        }),
        candidate(PROVIDER, "shown-skill"),
      ]),
    );

    // `dsh-skill/lib/index.js:224-226,234-240`: list()/snapshot() are
    // invocation-neutral — the policy rides along, it is not applied here.
    const summaries = await skills.list();
    const hidden = summaries.find((s) => s.name === "hidden-skill");
    expect(hidden).toBeDefined();
    expect(hidden!.invocation).toEqual({
      modelInvocable: false,
      userInvocable: true,
    });

    // `dsh-skill/lib/index.js:37-39` + `lib/types/index.d.ts:109`.
    expect(isModelInvocable(hidden!)).toBe(false);
    // Positive control: the plain candidate is model-invocable.
    const shown = summaries.find((s) => s.name === "shown-skill");
    expect(isModelInvocable(shown!)).toBe(true);
  });

  it("(e) an arbitrary custom source string survives validation", async () => {
    const { skills } = await mountRegistry();
    skills.registerProvider(() =>
      makeProvider(PROVIDER, async () => [
        candidate(PROVIDER, "custom-skill", { source: "rolebox" }),
      ]),
    );

    const summaries = await skills.list();
    // `dsh-skill/lib/index.js:459` accepts any string for `source`;
    // `lib/types/index.d.ts:24` declares the union open with `(string & {})`.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.source).toBe("rolebox");
  });

  it("(f) rank decides duplicate names within one layer (lower wins)", async () => {
    const { skills } = await mountRegistry();
    // The HIGH-rank provider is registered FIRST, so registration order would
    // otherwise pick it; `rank` must still select the low-rank provider.
    // `dsh-skill/lib/index.js:314` sorts by `compareIndexedCandidates`
    // (`:518-520`: rank, then providerOrder, then localOrder), and `:317-325`
    // keeps the first (lowest-rank) entry for a duplicate name.
    const high = makeProvider("rolebox-probe-high", async () => [
      candidate("rolebox-probe-high", "dup-skill", {
        description: "rank-high",
        rank: 900,
      }),
    ]);
    const low = makeProvider("rolebox-probe-low", async () => [
      candidate("rolebox-probe-low", "dup-skill", {
        description: "rank-low",
        rank: 100,
      }),
    ]);
    skills.registerProvider(() => high);
    skills.registerProvider(() => low);

    const dupes = (await skills.list()).filter((s) => s.name === "dup-skill");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.description).toBe("rank-low");
  });

  it("(g) list() hands the provider only {cwd, signal} — no scope/agent/session", async () => {
    const { skills } = await mountRegistry();
    let seen: SkillLookupOptions | undefined;
    skills.registerProvider(() =>
      makeProvider(PROVIDER, async (options) => {
        seen = options;
        return [];
      }),
    );

    const controller = new AbortController();
    await skills.list({ cwd: "/tmp/rolebox-skill-probe", signal: controller.signal });

    // `dsh-skill/lib/index.js:350` passes the options object straight to
    // `provider.list(options)`; `:298-313` threads the same object through the
    // layer walk. `lib/types/index.d.ts:88-93` defines the provider contract
    // as `SkillLookupOptions` = {cwd?, signal?} — the `scope` used for layer
    // selection (`lib/index.js:299`) is never leaked to the provider.
    expect(seen).toBeDefined();
    expect(seen!.cwd).toBe("/tmp/rolebox-skill-probe");
    expect(seen!.signal).toBe(controller.signal);
    expect(Object.keys(seen!).sort()).toEqual(["cwd", "signal"]);
    expect("scope" in seen!).toBe(false);
    expect("agent" in seen!).toBe(false);
    expect("session" in seen!).toBe(false);
  });
});
