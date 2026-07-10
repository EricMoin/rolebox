import { NOTIFICATION_CHANNEL_KINDS } from "../types.ts";
import type { NotificationMessage } from "../types.ts";
import type { NotificationChannel } from "../channels.ts";
import { createSubLogger } from "../../logger.ts";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const logger = createSubLogger("notification");

export class CustomCommandChannel implements NotificationChannel {
  readonly kind = NOTIFICATION_CHANNEL_KINDS.CustomCommand;
  private command: string;
  private passAsStdin: boolean;
  private additionalEnv: Record<string, string> | undefined;

  constructor(
    command: string,
    passAsStdin: boolean | undefined,
    env: Record<string, string> | undefined,
  ) {
    this.command = command;
    this.passAsStdin = passAsStdin ?? false;
    this.additionalEnv = env;
  }

  async send(message: NotificationMessage): Promise<void> {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/c", this.command] : ["-c", this.command];

    const baseEnv: Record<string, string> = {
      NOTICE_TITLE: message.title,
      NOTICE_BODY: message.body,
      NOTICE_SESSION_ID: message.sessionId,
      NOTICE_EVENT_TYPE: message.eventType,
      NOTICE_AGENT: message.agent ?? "",
      NOTICE_ROLE_NAME: message.roleName ?? "",
      NOTICE_TIMESTAMP: message.timestamp,
    };

    const mergedEnv = {
      ...process.env,
      ...baseEnv,
      ...this.additionalEnv,
    } as Record<string, string>;

    try {
      if (this.passAsStdin) {
        await this.runWithStdin(shell, shellArgs, mergedEnv, message);
      } else {
        await execFileAsync(shell, shellArgs, {
          env: mergedEnv,
          timeout: 10_000,
        });
      }
    } catch (err) {
      logger.warn("custom command failed", { err });
    }
  }

  private runWithStdin(
    shell: string,
    shellArgs: string[],
    env: Record<string, string>,
    message: NotificationMessage,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = execFile(shell, shellArgs, { env, timeout: 10_000 });

      if (child.stdin) {
        const input = JSON.stringify(message);
        child.stdin.write(input);
        child.stdin.end();
      }

      child.on("exit", (code) => {
        if (code !== 0) {
          logger.warn("custom command exited with non-zero code", { code, command: this.command });
        }
        resolve();
      });

      child.on("error", () => {
        logger.warn("custom command process error", { command: this.command });
        resolve();
      });
    });
  }

  async dispose(): Promise<void> {}
}
