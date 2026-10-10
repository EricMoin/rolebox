/// <reference types="bun-types" />

/**
 * The computer-use facts as the SYSTEM DESCRIPTORS declare them.
 *
 * The plan builders live in `src/computer/drivers/`, but which system gets
 * which driver — and which system is told rolebox cannot drive it — is a system
 * fact, so it is asserted here through `getSystem()`/`detectSystem()` rather
 * than through the builders directly.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  SYSTEM_REGISTRY,
  detectSystem,
  getSystem,
  setPlatformForTest,
  type SystemDescriptor,
  type SystemId,
} from "../../../src/platform/system/index.ts";
import type { ComputerPlan, ComputerPlanOrRefusal } from "../../../src/platform/system/types.ts";

function descriptor(id: SystemId): SystemDescriptor {
  const found = SYSTEM_REGISTRY.find(system => system.id === id);
  if (!found) throw new Error(`No system descriptor declared for ${id}`);
  return found;
}

function planOf(built: ComputerPlanOrRefusal): ComputerPlan {
  if (typeof built === "string") throw new Error(`expected a plan, got the refusal: ${built}`);
  return built;
}

afterEach(() => setPlatformForTest(undefined));

describe("descriptor computer-use facts", () => {
  it("declares computer-use facts for every system", () => {
    for (const system of SYSTEM_REGISTRY) {
      expect(system.computerUse).toBeDefined();
      expect(typeof system.computerUse.supported).toBe("boolean");
    }
  });

  it("supports darwin, linux and win32, and refuses the posix fallback", () => {
    for (const id of ["darwin", "linux", "win32"] as const) {
      const facts = descriptor(id).computerUse;
      expect(facts.supported).toBe(true);
      if (facts.supported) {
        expect(facts.requiredBinaries.length).toBeGreaterThan(0);
        expect(facts.installHint.length).toBeGreaterThan(0);
      }
    }
    const posix = descriptor("posix").computerUse;
    expect(posix.supported).toBe(false);
    if (!posix.supported) {
      expect(posix.refusal).toContain("posix");
      expect(posix.refusal).toContain("macOS");
      expect(posix.refusal).toContain("Windows");
    }
  });

  it("answers an unlisted platform with the posix refusal, under its own id", () => {
    const unlisted = detectSystem("aix");
    expect(unlisted.id).toBe("posix");
    expect(unlisted.computerUse.supported).toBe(false);
    expect(detectSystem("freebsd").computerUse).toBe(unlisted.computerUse);
  });

  it("builds the plan of the system it describes, whatever host runs the test", () => {
    // Each system's facts are bound once and the `supported` test narrows THAT
    // binding: a test on a repeated `descriptor(...).computerUse` call does not
    // reach the plan call below it.
    const darwinFacts = descriptor("darwin").computerUse;
    const darwinPlan = planOf(darwinFacts.supported
      ? darwinFacts.capturePlan({ path: "/tmp/x.png" }, {})
      : "");
    const linuxFacts = descriptor("linux").computerUse;
    const linuxPlan = planOf(linuxFacts.supported
      ? linuxFacts.capturePlan({ path: "/tmp/x.png" }, {})
      : "");
    const windowsFacts = descriptor("win32").computerUse;
    const windowsPlan = planOf(windowsFacts.supported
      ? windowsFacts.capturePlan({ path: "C:\\x.png" }, {})
      : "");

    expect(darwinPlan.argv[0]).toBe("/usr/sbin/screencapture");
    expect(linuxPlan.argv[0]).toBe("/bin/sh");
    expect(windowsPlan.argv[0]).toBe("powershell");

    // Selecting another system never rewrites a descriptor's own facts.
    setPlatformForTest("linux");
    expect(getSystem().id).toBe("linux");
    const darwinStill = descriptor("darwin").computerUse;
    expect(planOf(darwinStill.supported
      ? darwinStill.capturePlan({ path: "/tmp/x.png" }, {})
      : "").argv[0]).toBe("/usr/sbin/screencapture");
    const active = getSystem().computerUse;
    expect(planOf(active.supported
      ? active.capturePlan({ path: "/tmp/x.png" }, { XDG_SESSION_TYPE: "x11" })
      : "").driver).toBe("import");
  });

  it("hands the same facts object to every lookup, so a plan cannot drift", () => {
    expect(detectSystem("darwin").computerUse).toBe(descriptor("darwin").computerUse);
    setPlatformForTest("win32");
    expect(getSystem().computerUse).toBe(descriptor("win32").computerUse);
    setPlatformForTest("aix");
    expect(getSystem().computerUse).toBe(descriptor("posix").computerUse);
  });

  it("keeps the input plans of each system independent of the others", () => {
    const request = { action: "click", x: 1, y: 2, button: "left", clicks: 1 } as const;
    const darwinInputFacts = descriptor("darwin").computerUse;
    const darwin = planOf(darwinInputFacts.supported
      ? darwinInputFacts.inputPlan(request, {})
      : "");
    const linuxInputFacts = descriptor("linux").computerUse;
    const linux = planOf(linuxInputFacts.supported
      ? linuxInputFacts.inputPlan(request, { XDG_SESSION_TYPE: "x11" })
      : "");
    const windowsInputFacts = descriptor("win32").computerUse;
    const windows = planOf(windowsInputFacts.supported
      ? windowsInputFacts.inputPlan(request, {})
      : "");
    expect(darwin.argv[0]).toBe("/usr/bin/osascript");
    expect(linux.argv[0]).toBe("xdotool");
    expect(windows.argv[0]).toBe("powershell");
  });
});
