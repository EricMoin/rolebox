import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

const browser = spawn(process.argv[2]!, [
  "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${join(process.env.TMPDIR!, "profile")}`, "--remote-debugging-pipe",
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const writer = browser.stdio[3] as Writable;
const reader = browser.stdio[4] as Readable;
const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
let nextId = 0;
let buffer = "";
let stderr = "";
browser.stderr!.on("data", chunk => { stderr += chunk.toString(); });
const exited = new Promise<void>((resolve, reject) => {
  browser.on("error", reject);
  browser.on("exit", code => code === 0 ? resolve() : reject(new Error(`Browser exited ${code}: ${stderr}`)));
});
reader.on("data", chunk => {
  buffer += chunk.toString();
  for (let end; (end = buffer.indexOf("\0")) >= 0;) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
});
function send(method: string, params = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    writer.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.evaluate", { expression: "document.write('<title>worker-browser-ok</title><h1>Browser works</h1>')" }, sessionId);
  const { result } = await send("Runtime.evaluate", { expression: "document.title" }, sessionId);
  const { data } = await send("Page.captureScreenshot", {}, sessionId);
  writeFileSync("screenshot.png", Buffer.from(data, "base64"));
  console.log(result.value);
  await send("Browser.close");
  await exited;
  console.log("browser-closed");
} finally {
  if (browser.exitCode === null) browser.kill("SIGKILL");
}
