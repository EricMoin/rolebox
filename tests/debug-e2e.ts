import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, cpSync } from "node:fs";
import path from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { bootstrapRoles } from "../src/resolver/bootstrap.ts";

const examplesDir = path.join(import.meta.dir, "..", "examples");

it("debug researcher subagent prompt", async () => {
  const tmpDir = mkdtempSync(path.join(osTmpdir(), "rolebox-debug-"));
  const roleboxDir = path.join(tmpDir, "rolebox");
  mkdirSync(roleboxDir, { recursive: true });
  
  cpSync(path.join(examplesDir, "team-lead"), path.join(roleboxDir, "team-lead"), { recursive: true });

  const roleFunctionsMap = new Map();
  const roleGraphMap = new Map();
  const result = await bootstrapRoles({
    roleboxDir,
    globalSkillsDir: path.join(tmpDir, "skills"),
    configDir: tmpDir,
    builtinDir: path.join(import.meta.dir, "..", "functions"),
    roleFunctionsMap,
    roleGraphMap,
  });

  console.log(`Resolved roles: ${result.resolvedRoles.length}`);
  
  for (const role of result.resolvedRoles) {
    console.log(`Role: ${role.id}`);
    console.log(`  Skills: [${role.skills.map(s => s.name).join(", ")}]`);
    console.log(`  Has subagents: ${role.subagents.length}`);
    
    for (const sub of role.subagents) {
      console.log(`  Subagent: ${sub.id}`);
      console.log(`    config.skills: ${JSON.stringify(sub.config.skills)}`);
      console.log(`    resolved skills: [${sub.skills.map(s => s.name).join(", ")}]`);
      console.log(`    Has <available_skills>: ${sub.prompt.includes("<available_skills>")}`);
      console.log(`    Prompt (first 200): ${sub.prompt.substring(0, 200)}`);
      console.log(`    Full prompt:`);
      console.log(sub.prompt);
    }
  }

  rmSync(tmpDir, { recursive: true, force: true });
});
