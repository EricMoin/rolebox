import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Removed source modules must not survive a rebuild in the published package.
rmSync(fileURLToPath(new URL("../dist/", import.meta.url)), { recursive: true, force: true });
