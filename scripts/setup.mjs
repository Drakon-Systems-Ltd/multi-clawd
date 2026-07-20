#!/usr/bin/env node
/**
 * multi-clawd interactive setup wizard.
 *
 *   npm run setup            (from a source checkout)
 *   node scripts/setup.mjs   (from an installed copy)
 *   ... --dry-run            (show what would change, write nothing)
 *
 * Walks a user through the standard multi-account shape and merges the result
 * into ~/.openclaw/openclaw.json non-destructively (backup first, accounts
 * merged by id, an existing pool is never overwritten, re-runs are no-ops):
 *
 *   - main account (claw1): your existing `claude` login in the DEFAULT
 *     config dir (~/.claude) — nothing to set up, it is used as-is.
 *   - second account (claw2): its own ISOLATED config dir (e.g. ~/.claw2),
 *     a fully separate Claude "app", so the two logins can never touch each
 *     other. Its token comes from a secret manager ref (preferred), a token
 *     file, or the dir's own stored login.
 *   - pool (clawd): one backend id fronting both accounts with near-limit
 *     rotation — route chains at clawd/<model>.
 *
 * The wizard never sees or stores a token value. All scaffolding logic is
 * pure and unit-tested in src/setup-core.ts; this file owns prompts and IO.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

let core;
try {
  core = await import(resolve(__dirname, "..", "dist", "setup-core.js"));
} catch {
  console.error("setup: dist/setup-core.js is missing — run `npm run build` first (source checkout) or reinstall the plugin.");
  process.exit(1);
}
const { buildMainAccount, buildSecondAccount, buildPool, validateSecondConfigDir, planFromExisting, mergeSetupIntoConfig } = core;

// Line-queued prompts: interactive AND pipe-safe. With piped stdin, readline
// emits every buffered line immediately — a plain question() would capture one
// and drop the rest, hanging later prompts. Queue them all; EOF yields "" so
// remaining prompts fall back to their defaults.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pendingLines = [];
const waiters = [];
let stdinClosed = false;
rl.on("line", (l) => {
  const w = waiters.shift();
  if (w) w(l);
  else pendingLines.push(l);
});
rl.on("close", () => {
  stdinClosed = true;
  for (const w of waiters.splice(0)) w("");
});
const readAnswer = (prompt) => {
  process.stdout.write(prompt);
  if (pendingLines.length > 0) {
    const l = pendingLines.shift();
    process.stdout.write(`${l}\n`);
    return Promise.resolve(l);
  }
  if (stdinClosed) {
    process.stdout.write("\n");
    return Promise.resolve("");
  }
  return new Promise((r) => waiters.push(r));
};
const ask = async (q, dflt) => {
  const a = (await readAnswer(dflt !== undefined ? `${q} [${dflt}] ` : `${q} `)).trim();
  return a || dflt || "";
};
const yes = async (q, dflt = true) => {
  const a = (await readAnswer(`${q} ${dflt ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  if (!a) return dflt;
  return a.startsWith("y");
};

console.log(`
multi-clawd setup — two Claude accounts, one failover pool
==========================================================
How it works:
  • Your MAIN account is the \`claude\` login already on this machine
    (default config dir ~/.claude). The wizard leaves it exactly as-is.
  • A SECOND account lives in its own isolated config dir (a separate
    Claude "app") — the two logins can never overwrite each other.
  • A POOL (one backend id, e.g. "clawd") fronts both: each launch runs on
    the first account that is not nearly maxed out.
This wizard edits ~/.openclaw/openclaw.json (backup taken first). It never
sees, stores, or prints a token value.${DRY_RUN ? "\n  (dry-run: nothing will be written)" : ""}
`);

// ── preflight ────────────────────────────────────────────────────────────────
try {
  execFileSync("claude", ["--version"], { stdio: "pipe" });
} catch {
  console.error("preflight: the `claude` CLI is not on PATH. Install Claude Code first: npm install -g @anthropic-ai/claude-code");
  process.exit(1);
}
let existingRaw = "{}";
if (existsSync(CONFIG_PATH)) existingRaw = readFileSync(CONFIG_PATH, "utf8");
let existing;
try {
  existing = JSON.parse(existingRaw);
} catch {
  console.error(`preflight: ${CONFIG_PATH} exists but is not valid JSON — fix it before running setup.`);
  process.exit(1);
}
const state = planFromExisting(existing);
if (state.accountIds.length > 0) {
  console.log(`Found existing multi-clawd accounts: ${state.accountIds.join(", ")} — re-running is safe (merge by id, no duplicates).\n`);
}

// ── main account ─────────────────────────────────────────────────────────────
const accounts = [];
if (await yes("Add your MAIN account (the machine's existing `claude` login) to the pool?")) {
  const id = await ask("  id for the main account:", "claw1");
  accounts.push(buildMainAccount({ id, label: await ask("  label:", "Main Claude") }));
}

// ── second account ───────────────────────────────────────────────────────────
if (await yes("Set up a SECOND Claude account (its own isolated config dir)?")) {
  const id = await ask("  id for the second account:", "claw2");
  let configDir;
  for (;;) {
    configDir = await ask("  isolated config dir:", `~/.${id}`);
    const err = validateSecondConfigDir(configDir);
    if (!err) break;
    console.log(`  ✗ ${err}`);
  }
  console.log(`
  Now log the SECOND account in (you, in your own terminal — the wizard
  cannot and must not do this for you):

      CLAUDE_CONFIG_DIR=${configDir} claude setup-token

  Sign in as the SECOND account (not your main one!) and note where you put
  the printed setup-token. Options for where the plugin reads it from:`);
  console.log(`
    1) secret manager ref (RECOMMENDED — no plaintext on disk)
       e.g. 1Password: store the token as an item field, then give the
       reference like op://Vault/Item/field
    2) token file
       e.g. save it to ${configDir}/oauth-token and chmod 600 it
    3) none — rely on the login stored inside ${configDir} itself
`);
  const choice = await ask("  token source (1/2/3):", "1");
  let tokenSource;
  if (choice === "1") {
    const provider = await ask("  gateway secret provider name:", "onepassword");
    let refId;
    for (;;) {
      refId = await ask("  secret reference (e.g. op://Vault/Item/field):");
      if (refId) break;
      if (stdinClosed) {
        console.error("setup: a secret reference is required for token source 1 — aborting (nothing written).");
        process.exit(1);
      }
      console.log("  ✗ the reference is required (it is NOT the token itself — just the pointer to it)");
    }
    tokenSource = { kind: "ref", ref: { source: "exec", provider, id: refId } };
  } else if (choice === "2") {
    tokenSource = { kind: "file", path: await ask("  token file path:", `${configDir}/oauth-token`) };
  } else {
    tokenSource = { kind: "dir-login" };
  }
  accounts.push(buildSecondAccount({ id, label: await ask("  label:", "Second Claude"), configDir, tokenSource }));
}

if (accounts.length === 0 && state.accountIds.length === 0) {
  console.log("Nothing to set up — no accounts chosen. Bye.");
  process.exit(0);
}

// ── pool ─────────────────────────────────────────────────────────────────────
const poolMemberIds = [...new Set([...accounts.map((a) => a.id), ...state.accountIds])];
let pool;
const modelRungs = [];
if (state.hasPool) {
  console.log("A pool already exists — leaving it untouched.");
} else if (poolMemberIds.length >= 1 && (await yes(`Create the failover pool over [${poolMemberIds.join(", ")}]?`))) {
  pool = buildPool(poolMemberIds, { id: await ask("  pool id:", "clawd") });
  modelRungs.push(`${pool.id}/claude-fable-5`);
}

// ── merge + write ────────────────────────────────────────────────────────────
const { config, changes } = mergeSetupIntoConfig(existing, { accounts, pool, modelRungs });
console.log("\nPlanned changes:");
if (changes.length === 0) console.log("  (none — config already matches)");
for (const c of changes) console.log(`  • ${c}`);

if (DRY_RUN || changes.length === 0) {
  console.log(DRY_RUN ? "\ndry-run: nothing written." : "");
  rl.close();
  process.exit(0);
}

if (!(await yes(`\nWrite these to ${CONFIG_PATH}? (backup taken first)`))) {
  console.log("Aborted — nothing written.");
  rl.close();
  process.exit(0);
}
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
if (existsSync(CONFIG_PATH)) {
  const backup = `${CONFIG_PATH}.bak-setup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(CONFIG_PATH, backup);
  console.log(`backup: ${backup}`);
}
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${CONFIG_PATH}`);

// ── next steps ───────────────────────────────────────────────────────────────
console.log(`
Done. Finish with:

  openclaw gateway restart
  node ${join(__dirname, "doctor.mjs")}     # expect READY

If the plugin was installed BEFORE these config keys existed, the gateway may
refuse the config against the old manifest — run the doctor's preflight for
the strip → force-install → re-add plan:

  node ${join(__dirname, "doctor.mjs")} --preflight
`);
rl.close();
