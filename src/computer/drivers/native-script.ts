import { readFileSync } from "node:fs";

// Source runs read editable helpers; package builds inline each platform's manifest.
export function loadNativeScript(file: URL): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd();
}
