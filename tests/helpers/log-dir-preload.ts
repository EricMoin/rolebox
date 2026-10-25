// Redirect test logs before the production logger is imported. Explicit destinations win.
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ROLEBOX_LOG_DIR && !process.env.ROLEBOX_LOG_FILE) {
  process.env.ROLEBOX_LOG_DIR = join(process.env.RUNNER_TEMP || tmpdir(), "rolebox-test-logs", "pid-" + process.pid);
}
