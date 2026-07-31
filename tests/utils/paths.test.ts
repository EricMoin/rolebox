import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import os from "node:os";
import { SKILL_MD } from "../../src/constants.ts";
import {
  functionPath,
  skillDirPath,
  skillFilePath,
  subagentDir,
  globalFunctionsPath,
  agentFilePath,
  agentsDir,
  platformAgentsDir,
  platformAgentFilePath,
  toPosixPath,
} from "../../src/utils/paths.ts";

const FAKE_HOME = "/Users/fakeuser";

let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  homedirSpy = spyOn(os, "homedir").mockReturnValue(FAKE_HOME);
});

afterEach(() => {
  homedirSpy.mockRestore();
});

describe("paths", () => {
  it("functionPath joins baseDir with name.md", () => {
    expect(functionPath("/roles", "my-func")).toBe(
      join("/roles", "my-func.md"),
    );
  });

  it("skillDirPath joins baseDir/name/SKILL.md", () => {
    expect(skillDirPath("/roles", "my-skill")).toBe(
      join("/roles", "my-skill", SKILL_MD),
    );
  });

  it("skillDirPath uses the SKILL_MD constant", () => {
    expect(skillDirPath("/a", "b")).toBe(join("/a", "b", "SKILL.md"));
  });

  it("skillFilePath joins baseDir with name.md", () => {
    expect(skillFilePath("/roles", "my-skill")).toBe(
      join("/roles", "my-skill.md"),
    );
  });

  it("subagentDir joins roleDir/subagents/slug", () => {
    expect(subagentDir("/roles/mydir", "my-slug")).toBe(
      join("/roles/mydir", "subagents", "my-slug"),
    );
  });

  it("globalFunctionsPath joins configDir with functions", () => {
    expect(globalFunctionsPath("/config")).toBe(join("/config", "functions"));
  });

  it("agentFilePath joins homedir/.claude/agents/agentId.md", () => {
    expect(agentFilePath("my-agent")).toBe(
      join(FAKE_HOME, ".claude", "agents", "my-agent.md"),
    );
  });

  it("agentsDir returns homedir/.claude/agents", () => {
    expect(agentsDir()).toBe(join(FAKE_HOME, ".claude", "agents"));
  });

  it('platformAgentsDir("pi") returns homedir/.pi/agent/skills', () => {
    expect(platformAgentsDir("pi")).toBe(
      join(FAKE_HOME, ".pi", "agent", "skills"),
    );
  });

  it("platformAgentsDir() with no arg calls agentsDir()", () => {
    expect(platformAgentsDir()).toBe(join(FAKE_HOME, ".claude", "agents"));
  });

  it('platformAgentsDir("opencode") falls back to agentsDir()', () => {
    expect(platformAgentsDir("opencode")).toBe(
      join(FAKE_HOME, ".claude", "agents"),
    );
  });

  it('platformAgentFilePath with "pi" returns .pi/agent/skills/{agentId}/SKILL.md', () => {
    expect(platformAgentFilePath("my-agent", "pi")).toBe(
      join(FAKE_HOME, ".pi", "agent", "skills", "my-agent", "SKILL.md"),
    );
  });

  it("platformAgentFilePath() with no platformId falls back to agentFilePath", () => {
    expect(platformAgentFilePath("my-agent")).toBe(
      join(FAKE_HOME, ".claude", "agents", "my-agent.md"),
    );
  });

  it('platformAgentFilePath("opencode") falls back to agentFilePath', () => {
    expect(platformAgentFilePath("my-agent", "opencode")).toBe(
      join(FAKE_HOME, ".claude", "agents", "my-agent.md"),
    );
  });

  it("platformAgentsDir and platformAgentFilePath both use homedir mock", () => {
    // Verify the mock is consistently applied across both functions
    expect(platformAgentsDir("pi")).toBe(
      join(FAKE_HOME, ".pi", "agent", "skills"),
    );
    expect(platformAgentFilePath("x", "pi")).toBe(
      join(FAKE_HOME, ".pi", "agent", "skills", "x", "SKILL.md"),
    );
  });
});

describe("toPosixPath", () => {
  it("converts Windows backslashes to forward slashes", () => {
    expect(toPosixPath("a\\b")).toBe("a/b");
  });

  it("leaves forward-slash paths unchanged", () => {
    expect(toPosixPath("a/b")).toBe("a/b");
  });

  it("converts Windows drive paths", () => {
    expect(toPosixPath("C:\\x\\y")).toBe("C:/x/y");
  });
});
