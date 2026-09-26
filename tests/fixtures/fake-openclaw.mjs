#!/usr/bin/env node
// A scripted stand-in for the `openclaw` CLI's auth subcommands. Records
// argv + stdin to $FAKE_OPENCLAW_DIR/calls.jsonl; keeps the stored anthropic
// order in $FAKE_OPENCLAW_DIR/order.json; lists $FAKE_OPENCLAW_PROFILES.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_OPENCLAW_DIR;
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, input }) + "\n");
  const orderFile = join(dir, "order.json");
  const profiles = (process.env.FAKE_OPENCLAW_PROFILES ?? "").split(",").filter(Boolean);
  if (args[0] === "models" && args[1] === "auth" && args[2] === "list") {
    process.stdout.write(
      JSON.stringify({ provider: "anthropic", profiles: profiles.map((id) => ({ id, provider: "anthropic", type: "token" })) }),
    );
    return;
  }
  if (args[2] === "order" && args[3] === "get") {
    const order = existsSync(orderFile) ? JSON.parse(readFileSync(orderFile, "utf8")) : null;
    process.stdout.write(`Auth state store: somewhere\n${JSON.stringify({ provider: "anthropic", order })}`);
    return;
  }
  if (args[2] === "order" && args[3] === "set") {
    const ids = args.slice(8);
    const missing = ids.find((id) => !profiles.includes(id));
    if (missing) {
      process.stderr.write(`Error: Auth profile "${missing}" not found\n`);
      process.exit(1);
    }
    writeFileSync(orderFile, JSON.stringify(ids));
    return;
  }
  process.stderr.write(`fake-openclaw: unsupported ${args.join(" ")}\n`);
  process.exit(2);
});
