/**
 * Spawn the `openclaw` CLI with arguments as an argv array (no shell), an
 * optional stdin payload, and a hard timeout. Used by the gateway-side order
 * loop and by the `multi-clawd` CLI; tests inject a scripted runner instead.
 *
 * stdin carries the only secret this ever handles (a setup-token for
 * `paste-token`). It is written once and the pipe closed; nothing echoes it.
 */
import { spawn } from "node:child_process";
import type { OpenclawRunner, RunResult } from "./direct-sync.js";

const MAX_CAPTURE = 1024 * 1024;

export function createOpenclawRunner(command = "openclaw"): OpenclawRunner {
  return (args, opts) =>
    new Promise<RunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
      } catch (err) {
        resolve({ code: 127, stdout: "", stderr: String((err as Error).message) });
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ code: 124, stdout, stderr: `${stderr}\ntimed out` });
      }, opts?.timeoutMs ?? 60_000);
      timer.unref?.();
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
      });
      child.on("error", (err) => finish({ code: 127, stdout, stderr: `${stderr}\n${err.message}` }));
      child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
      child.stdin?.on("error", () => {
        /* child exited before reading stdin — its exit code reports why */
      });
      child.stdin?.end(opts?.input ?? "");
    });
}
