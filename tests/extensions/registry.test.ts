import { describe, it, expect } from "bun:test";
import { ExtensionRegistry } from "../../src/extensions/registry";
import { clearExtensionModuleCache } from "../../src/extensions/loader";

describe("ExtensionRegistry", () => {
  it("loadExtensions is a no-op with undefined config", async () => {
    clearExtensionModuleCache();
    const registry = new ExtensionRegistry();
    await registry.loadExtensions(undefined, "/tmp");
    await registry.loadExtensions(null, "/tmp");
  });

  it("loadExtensions is a no-op with empty config", async () => {
    clearExtensionModuleCache();
    const registry = new ExtensionRegistry();
    await registry.loadExtensions({}, "/tmp");
  });

  it("getLoadedStrategies returns empty map initially", () => {
    const registry = new ExtensionRegistry();
    expect(registry.getLoadedStrategies().size).toBe(0);
  });

  it("getLoadedPatterns returns empty map initially", () => {
    const registry = new ExtensionRegistry();
    expect(registry.getLoadedPatterns().size).toBe(0);
  });

  it("dispose does not throw", async () => {
    const registry = new ExtensionRegistry();
    await registry.dispose();
  });
});
