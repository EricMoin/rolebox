import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function installationRoot(executable: string): string {
  for (let path = dirname(executable); dirname(path) !== path; path = dirname(path)) {
    if (basename(path).endsWith(".app")) return path;
  }
  return dirname(executable);
}

export function graphWorkerSoftware(workspace: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): {
  readPaths: string[];
  env: Record<string, string>;
} {
  const playwright = env.PLAYWRIGHT_BROWSERS_PATH || join(home, "Library", "Caches", "ms-playwright");
  const puppeteer = resolve(workspace, env.PUPPETEER_CACHE_DIR || join(home, ".cache", "puppeteer"));
  const readPaths = ["/Applications", join(home, "Applications"), puppeteer];
  const environment: Record<string, string> = {
    PLAYWRIGHT_BROWSERS_PATH: playwright === "0" ? "0" : resolve(workspace, playwright),
    PUPPETEER_CACHE_DIR: puppeteer,
  };
  if (playwright !== "0") readPaths.push(environment.PLAYWRIGHT_BROWSERS_PATH!);
  if (env.PUPPETEER_EXECUTABLE_PATH) {
    const executable = resolve(workspace, env.PUPPETEER_EXECUTABLE_PATH);
    environment.PUPPETEER_EXECUTABLE_PATH = executable;
    readPaths.push(installationRoot(executable));
  }
  return { readPaths, env: environment };
}
