/// <reference types="bun-types" />
import { describe, it, expect } from "bun:test";
import {
  createActiveAgentRef,
  type ActiveAgentRef,
} from "../src/platform/adapters/pi/active-agent.ts";

describe("createActiveAgentRef", () => {
  it("defaults to null (base agent)", () => {
    const ref = createActiveAgentRef();
    expect(ref.get()).toBeNull();
  });

  it("accepts an initial seed value", () => {
    const ref = createActiveAgentRef("emperor--jinyiwei");
    expect(ref.get()).toBe("emperor--jinyiwei");
  });

  it("set() updates the current value", () => {
    const ref = createActiveAgentRef();
    ref.set("emperor");
    expect(ref.get()).toBe("emperor");
  });

  it("set(null) clears back to the base agent", () => {
    const ref = createActiveAgentRef("emperor");
    ref.set(null);
    expect(ref.get()).toBeNull();
  });

  it("produces independent refs", () => {
    const a: ActiveAgentRef = createActiveAgentRef("a");
    const b: ActiveAgentRef = createActiveAgentRef("b");
    a.set("changed");
    expect(a.get()).toBe("changed");
    expect(b.get()).toBe("b");
  });
});
