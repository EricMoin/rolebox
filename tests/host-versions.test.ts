/// <reference types="bun-types" />

/**
 * Unit tests for the pure logic behind `bun run check:hosts` and
 * `bun run update:hosts` (scripts/host-versions.ts): the tracked-package
 * channel table, version comparison with prerelease ordering, and the
 * devDependencies pin planner the updater uses to rewrite package.json.
 *
 * No network is touched here — the registry query lives behind the CLI modes
 * and is deliberately not exercised by this file.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REGISTRY_URL,
  HOST_FAMILIES,
  HOST_PACKAGES,
  VOCABULARY_GUARD_SLICES,
  classifyHostStatus,
  compareVersions,
  findUntrackedHosts,
  hostChannelFor,
  isValidVersion,
  packageMetadataUrl,
  planDevDependencyPins,
  registryBaseUrl,
} from "../scripts/host-versions.ts";

describe("host-version policy table", () => {
  it("tracks every row exactly once, inside a host family, with a known channel", () => {
    expect(HOST_PACKAGES.length).toBeGreaterThan(0);
    const names = HOST_PACKAGES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of HOST_PACKAGES) {
      expect(HOST_FAMILIES.some((scope) => entry.name.startsWith(scope + "/"))).toBe(true);
      expect(["next", "latest"]).toContain(entry.channel);
    }
  });

  it("keeps the dsh line on next and cordis, opencode and pi on latest", () => {
    // The dsh `latest` tag points at the older 0.0.1-rc.1 line, so the whole
    // dsh set must follow `next`; cordis is the mirror case (its `next` tag is
    // older than `latest`).
    const dsh = HOST_PACKAGES.filter((entry) => entry.name.startsWith("@deepseek-ai/dsh-"));
    expect(dsh.length).toBeGreaterThan(0);
    for (const entry of dsh) expect(entry.channel).toBe("next");
    expect(hostChannelFor("@deepseek-ai/cordis")).toBe("latest");
    expect(hostChannelFor("@opencode-ai/plugin")).toBe("latest");
    expect(hostChannelFor("@earendil-works/pi-coding-agent")).toBe("latest");
    expect(hostChannelFor("typescript")).toBeUndefined();
  });

  it("flags host devDependencies the table does not cover", () => {
    expect(findUntrackedHosts(["@opencode-ai/plugin", "@deepseek-ai/dsh-llm", "typescript"])).toEqual([]);
    expect(findUntrackedHosts(["@deepseek-ai/brand-new-host", "@earendil-works/pi-tui", "zod"])).toEqual([
      "@deepseek-ai/brand-new-host",
      "@earendil-works/pi-tui",
    ]);
  });

  it("names the vocabulary guard slices the updater reruns", () => {
    expect(VOCABULARY_GUARD_SLICES).toEqual([
      "tests/platform/dsh-event-vocabulary.test.ts",
      "tests/platform/pi-event-vocabulary.test.ts",
      "tests/opencode-liveness-relay.test.ts",
    ]);
  });
});

describe("version comparison", () => {
  it("orders prereleases by npm semantics", () => {
    expect(compareVersions("0.1.5-rc.2", "0.1.5-rc.1")).toBe(1);
    expect(compareVersions("0.1.5-rc.1", "0.1.5-rc.2")).toBe(-1);
    expect(compareVersions("4.0.2", "4.0.1-rc.4")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    // Numeric identifiers compare numerically, not as text: rc.10 > rc.2.
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("0.1.5-rc.2", "0.1.5-rc.2")).toBe(0);
  });

  it("classifies a resolved pin against its channel", () => {
    expect(classifyHostStatus("0.1.5-rc.1", "0.1.5-rc.2")).toBe("behind");
    expect(classifyHostStatus("1.17.10", "1.18.31")).toBe("behind");
    expect(classifyHostStatus("4.0.2", "4.0.2")).toBe("current");
    expect(classifyHostStatus("4.0.3", "4.0.2")).toBe("ahead");
    expect(classifyHostStatus(undefined, "1.0.0")).toBe("behind");
  });

  it("counts a bogus current version as behind, never current", () => {
    // A plain string equality would call an unparsable pin up to date; the
    // gate must treat it as unresolved and therefore behind.
    expect(classifyHostStatus("bogus", "1.18.31")).toBe("behind");
    // A caret range is not a resolved version either.
    expect(classifyHostStatus("^1.3.0", "1.18.31")).toBe("behind");
    // An unusable channel answer is reported as unknown (a hard error), not
    // as drift.
    expect(classifyHostStatus("1.0.0", "not-a-version")).toBe("unknown");
    expect(isValidVersion("bogus")).toBe(false);
    expect(isValidVersion("^1.3.0")).toBe(false);
    expect(isValidVersion(">=0.70.0")).toBe(false);
    expect(isValidVersion("1.2")).toBe(false);
    expect(isValidVersion("0.1.5-rc.2")).toBe(true);
    expect(isValidVersion("1.18.31")).toBe(true);
    expect(() => compareVersions("bogus", "1.0.0")).toThrow();
  });
});

describe("registry helpers", () => {
  it("defaults to the public registry and honours the override", () => {
    expect(registryBaseUrl({})).toBe(DEFAULT_REGISTRY_URL);
    expect(registryBaseUrl({ HOST_VERSIONS_REGISTRY_URL: "   " })).toBe(DEFAULT_REGISTRY_URL);
    expect(registryBaseUrl({ HOST_VERSIONS_REGISTRY_URL: "https://registry.example.test/" })).toBe(
      "https://registry.example.test",
    );
  });

  it("percent-encodes the scope in the metadata URL", () => {
    expect(packageMetadataUrl("@deepseek-ai/dsh-llm")).toBe(
      "https://registry.npmjs.org/%40deepseek-ai%2Fdsh-llm",
    );
  });
});

const PACKAGE_JSON_FIXTURE = `{
  "name": "rolebox",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@opencode-ai/plugin": "^1.3.0",
    "@earendil-works/pi-coding-agent": ">=0.70.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@opencode-ai/plugin": "^1.3.0",
    "@earendil-works/pi-coding-agent": "0.86.0",
    "typescript": "^5.7.0"
  }
}
`;

describe("devDependencies pin planning", () => {
  it("rewrites only the named devDependencies pins", () => {
    const plan = planDevDependencyPins(PACKAGE_JSON_FIXTURE, [
      { name: "@opencode-ai/plugin", version: "1.18.31" },
      { name: "@earendil-works/pi-coding-agent", version: "0.87.0" },
    ]);
    expect(plan.missing).toEqual([]);
    expect(plan.edits).toEqual([
      { name: "@opencode-ai/plugin", from: "^1.3.0", to: "1.18.31" },
      { name: "@earendil-works/pi-coding-agent", from: "0.86.0", to: "0.87.0" },
    ]);
    const after = JSON.parse(plan.text) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(after.devDependencies["@opencode-ai/plugin"]).toBe("1.18.31");
    expect(after.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.87.0");
    // Peer ranges are policy, not pins: they must survive untouched.
    expect(after.peerDependencies["@opencode-ai/plugin"]).toBe("^1.3.0");
    expect(after.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.70.0");
    expect(after.devDependencies["@deepseek-ai/cordis"]).toBe("4.0.2");
    expect(after.devDependencies["typescript"]).toBe("^5.7.0");
  });

  it("changes exactly one line when one devDependency is behind", () => {
    // The fixture lists "@deepseek-ai/cordis" in peerDependencies first: the
    // planner must hit the devDependencies entry, not the first match in the
    // file.
    const plan = planDevDependencyPins(PACKAGE_JSON_FIXTURE, [{ name: "@deepseek-ai/cordis", version: "4.0.3" }]);
    expect(plan.missing).toEqual([]);
    const before = PACKAGE_JSON_FIXTURE.split("\n");
    const after = plan.text.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, index) => line !== before[index])).toEqual([
      '    "@deepseek-ai/cordis": "4.0.3",',
    ]);
  });

  it("reports a pin that devDependencies does not declare", () => {
    const plan = planDevDependencyPins(PACKAGE_JSON_FIXTURE, [
      { name: "@deepseek-ai/dsh-llm", version: "0.1.5-rc.2" },
    ]);
    expect(plan.missing).toEqual(["@deepseek-ai/dsh-llm"]);
    expect(plan.edits).toEqual([]);
    expect(plan.text).toBe(PACKAGE_JSON_FIXTURE);
  });
});
