import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

export function normalizeDocumentUri(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  try { return fileUri(fileURLToPath(uri)); }
  catch { return uri; }
}
