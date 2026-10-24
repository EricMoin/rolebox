import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSmokeHost, readSmokeModelConfig, resolveSmokeHostAnchor } from "../scripts/team-smoke/host.ts";
import { executeDshWorkerCommand, type DshSandboxPolicyService, type DshSandboxService } from "../src/platform/adapters/dsh/graph-worker.ts";
import type {} from "@deepseek-ai/dsh-fs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function layers(...texts: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), "team-smoke-config-"));
  roots.push(root);
  return texts.map((text, index) => {
    const path = join(root, `${index}.yml`);
    writeFileSync(path, text);
    return path;
  });
}

const base = `- insert:
    - id: api-key
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
    - id: pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
    - id: default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: example-provider
        model: example-model
`;

describe("team smoke host model configuration", () => {
  it("consumes model row overrides without mounting unrelated executable configuration", () => {
    const config = readSmokeModelConfig(layers(base, `- id: default-model
  config:
    provider: example-provider
    model: alternate-model
    reasoningEffort: high
- id: api-key
  config:
    models: [alternate-model]
- insert:
    - id: unrelated-ui
      name: example-ui
      config:
        callback: !!js 'throw new Error("must never execute")'
`));
    expect({ ...config.agentOptions, reasoningEffort: String(config.agentOptions.reasoningEffort) })
      .toEqual({ provider: "example-provider", model: "alternate-model", reasoningEffort: "high" });
    expect(config.adapters).toEqual([{ name: "@deepseek-ai/dsh-llm-deepseek-api-key", config: { models: ["alternate-model"] } }]);
  });

  it("retains explicitly configured pi-ai providers", () => {
    const config = readSmokeModelConfig(layers(base, `- id: pi-ai
  config:
    providers:
      example-provider:
        models:
          - id: example-model
`));
    expect(config.adapters.map(adapter => adapter.name)).toEqual([
      "@deepseek-ai/dsh-llm-deepseek-api-key", "@deepseek-ai/dsh-llm-pi-ai",
    ]);
  });

  it("honors disabled model adapters and refuses absent executable routes", () => {
    expect(() => readSmokeModelConfig(layers(base, "- id: api-key\n  disabled: true\n")))
      .toThrow("no supported API-key or pi-ai adapter");
  });

  it("refuses executable model tags and does not include their contents in the error", () => {
    const paths = layers(base, `- id: default-model
  config:
    provider: example-provider
    model: !!js 'sensitive-fixture-value'
`);
    expect(() => readSmokeModelConfig(paths)).toThrow("plain YAML values without executable tags");
    try { readSmokeModelConfig(paths); } catch (error) {
      expect(String(error)).not.toContain("sensitive-fixture-value");
    }
  });

  it("does not quote malformed configuration in parser diagnostics", () => {
    const paths = layers("[sensitive-fixture-value: invalid");
    expect(() => readSmokeModelConfig(paths)).toThrow("could not be parsed");
    try { readSmokeModelConfig(paths); } catch (error) {
      expect(String(error)).not.toContain("sensitive-fixture-value");
    }
  });
});

const hostAnchor = (() => {
  try { return resolveSmokeHostAnchor(process.env.ROLEBOX_DSH_HOST_ANCHOR); }
  catch { return undefined; }
})();
const repositoryInTemporaryRoot = process.platform === "win32" || ["/tmp", tmpdir()].some(directory => {
  const path = relative(realpathSync(directory), realpathSync(process.cwd()));
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
});

describe("team smoke host with installed DSH services", () => {
  it.skipIf(!hostAnchor || repositoryInTemporaryRoot)("uses the project cwd and confines graph commands with the real host sandbox", async () => {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".team-smoke-host-test-")));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    mkdirSync(join(root, "roles"));
    writeFileSync(join(root, "roles", "protected.txt"), "original");
    writeFileSync(join(workspace, "fixture.txt"), "workspace fixture");
    const host = await createSmokeHost({ root, hostAnchor, dshHome: root,
      profileConfigPaths: layers(base.replace("provider: example-provider", "provider: deepseek-official")) });
    try {
      const sandbox = host.ctx.get("sandbox") as DshSandboxService | undefined;
      const sandboxPolicy = host.ctx.get("sandboxPolicy") as DshSandboxPolicyService | undefined;
      expect(sandbox).toBeDefined();
      expect(sandboxPolicy?.resolve({})).toMatchObject({ mode: "workspace-write", workspaceRoot: workspace });
      expect(await host.ctx.fs.readText(await host.ctx.fs.resolve("fixture.txt"))).toBe("workspace fixture");
      const result = await executeDshWorkerCommand({ sandbox, sandboxPolicy, workspace,
        command: "printf success > result.txt", timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0);
      expect(result.mode).toBe("workspace-write");
      expect(result.enforcement).not.toBe("unconfined");
      expect(readFileSync(join(workspace, "result.txt"), "utf8")).toBe("success");
      const denied = await executeDshWorkerCommand({ sandbox, sandboxPolicy, workspace,
        command: "printf forbidden > ../roles/protected.txt", timeoutMs: 10_000 });
      expect(denied.exitCode).not.toBe(0);
      await expect(host.ctx.fs.writeText(await host.ctx.fs.resolve("../roles/protected.txt"), "forbidden")).rejects.toThrow();
      expect(readFileSync(join(root, "roles", "protected.txt"), "utf8")).toBe("original");
    } finally { await host.dispose(); }
  });

  it.skipIf(!hostAnchor)("supports a bootstrap root without a workspace subdirectory", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "team-smoke-bootstrap-")));
    roots.push(root);
    const host = await createSmokeHost({ root, hostAnchor, dshHome: root,
      profileConfigPaths: layers(base.replace("provider: example-provider", "provider: deepseek-official")) });
    try {
      const sandboxPolicy = host.ctx.get("sandboxPolicy") as DshSandboxPolicyService;
      expect(sandboxPolicy.resolve({})).toMatchObject({ mode: "workspace-write", workspaceRoot: root });
      const target = await host.ctx.fs.resolve("fixture.txt");
      await host.ctx.fs.writeText(target, "bootstrap fixture");
      expect(readFileSync(join(root, "fixture.txt"), "utf8")).toBe("bootstrap fixture");
    } finally { await host.dispose(); }
  });
});
