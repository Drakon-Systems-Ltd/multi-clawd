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
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

let core, wds;
try {
  core = await import(resolve(__dirname, "..", "dist", "setup-core.js"));
  wds = await import(resolve(__dirname, "..", "dist", "watchdog-schedule.js"));
} catch {
  console.error("setup: built dist/ modules are missing — run `npm run build` first (source checkout) or reinstall the plugin.");
  process.exit(1);
}
const { buildMainAccount, buildSecondAccount, buildPool, validateSecondConfigDir, planFromExisting, mergeSetupIntoConfig, existingAccountDefaults, looksLikeSecretRef } = core;

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
  // Existing-aware: this account may already be fully configured. Pressing
  // Enter through prompts must NEVER overwrite a working account, so the
  // default here is to keep it exactly as it is.
  const prior = existingAccountDefaults(existing, id);
  if (prior?.hasCredentials) {
    console.log(
      `  "${id}" is already configured${prior.label ? ` (${prior.label}` : " ("}${prior.configDir ? `, dir ${prior.configDir})` : ")"}.`,
    );
    if (await yes("  Keep its existing credentials and config unchanged?", true)) {
      accounts.push({ id });
      console.log("  ✅ keeping as-is");
    } else {
      await secondAccountFlow(id, prior);
    }
  } else {
    await secondAccountFlow(id, prior);
  }
}

async function secondAccountFlow(id, prior) {
  let configDir;
  for (;;) {
    configDir = await ask("  isolated config dir:", prior?.configDir ?? `~/.${id}`);
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
      if (!refId) {
        if (stdinClosed) {
          console.error("setup: a secret reference is required for token source 1 — aborting (nothing written).");
          process.exit(1);
        }
        console.log("  ✗ the reference is required (it is NOT the token itself — just the pointer to it; answer 3 above for no token)");
        continue;
      }
      if (!looksLikeSecretRef(refId)) {
        console.log(`  ⚠ "${refId}" doesn't look like a secret reference (expected something URI-like, e.g. op://Vault/Item/field)`);
        if (!(await yes("  Use it anyway?", false))) continue;
      }
      break;
    }
    tokenSource = { kind: "ref", ref: { source: "exec", provider, id: refId } };
  } else if (choice === "2") {
    tokenSource = { kind: "file", path: await ask("  token file path:", `${configDir}/oauth-token`) };
  } else {
    tokenSource = { kind: "dir-login" };
  }
  accounts.push(buildSecondAccount({ id, label: await ask("  label:", prior?.label ?? "Second Claude"), configDir, tokenSource }));
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

let wroteConfig = false;
if (DRY_RUN) {
  if (changes.length > 0) console.log("\ndry-run: config not written.");
} else if (changes.length > 0) {
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
  wroteConfig = true;
}

// ── eviction watchdog: create, or repair an orphaned unit ────────────────────
// The unit points at a script INSIDE an install dir, and installs move
// (path→registry migration, uninstall/reinstall) — an orphaned unit fires
// every 5 min against a missing file, silently. The wizard owns this now.
await watchdogStep();

async function watchdogStep() {
  const platform = process.platform;
  console.log("\nEviction watchdog (openclaw#107408 mitigation — see README):");
  if (platform !== "darwin" && platform !== "linux") {
    console.log("  (auto-scheduling not supported on this platform — see README for manual setup)");
    return;
  }
  // Units point at the STABLE LAUNCHER, never at an install path: the npm
  // install dir is regenerated on every update (orphaning any unit that
  // points into it), and under npx our own __dirname is an ephemeral cache.
  // The launcher lives in the state dir and finds the install at runtime.
  const { WATCHDOG_LAUNCHER } = await import(resolve(__dirname, "_shared.mjs"));
  const scriptPath = WATCHDOG_LAUNCHER;
  const refreshLauncher = () => {
    mkdirSync(dirname(WATCHDOG_LAUNCHER), { recursive: true });
    writeFileSync(WATCHDOG_LAUNCHER, wds.renderWatchdogLauncher());
  };
  const scanDir =
    platform === "darwin"
      ? join(homedir(), "Library", "LaunchAgents")
      : join(homedir(), ".config", "systemd", "user");
  let found;
  try {
    for (const f of readdirSync(scanDir)) {
      // Only real unit files — backups like *.plist.bak-... are inert; never
      // detect (or "repair") one of those instead of the live unit.
      if (!/\.(plist|service|timer)$/.test(f)) continue;
      const p = join(scanDir, f);
      let text;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const target = wds.extractWatchdogTarget(text);
      if (target) {
        found = { file: p, target, text };
        break;
      }
    }
  } catch {
    /* scan dir missing — treated as absent */
  }
  const state = wds.classifyWatchdogUnit(found?.target, existsSync);
  if (state === "ok" && !wds.isFragileWatchdogTarget(found.target)) {
    if (found.target === WATCHDOG_LAUNCHER && !DRY_RUN) refreshLauncher();
    console.log(`  ✅ already scheduled and healthy → ${found.target}`);
    return;
  }
  if (state === "ok") {
    // Exists today, but points INTO the npm install — orphans on next update.
    console.log(
      `  ⚠ ${found.file}\n    points INTO the npm install dir:\n    ${found.target}\n    That directory is regenerated on every update — the unit will orphan.`,
    );
    if (DRY_RUN) {
      console.log(`  dry-run: would move it to the stable launcher ${scriptPath}`);
      return;
    }
    if (!(await yes("  Move it to the stable launcher (survives every update)?"))) return;
    refreshLauncher();
    writeFileSync(found.file, found.text.split(found.target).join(scriptPath));
    reloadWatchdogUnit(platform, found.file);
    console.log(`  ✅ now → ${scriptPath}`);
    return;
  }
  if (state === "orphaned") {
    console.log(
      `  ⚠ ${found.file}\n    points at a MISSING script: ${found.target}\n    (an old install dir — the watchdog has been failing silently)`,
    );
    if (DRY_RUN) {
      console.log(`  dry-run: would repoint it at the stable launcher ${scriptPath}`);
      return;
    }
    if (!(await yes("  Repoint it at the stable launcher (survives every update)?"))) return;
    refreshLauncher();
    writeFileSync(found.file, found.text.split(found.target).join(scriptPath));
    reloadWatchdogUnit(platform, found.file);
    console.log(`  ✅ repointed → ${scriptPath}`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  dry-run: not scheduled — would offer to schedule it → ${scriptPath}`);
    return;
  }
  if (!(await yes("  Not scheduled. Schedule it now (runs every 5 min)?"))) return;
  refreshLauncher();
  const unitFiles = wds.renderWatchdogUnit({ platform, nodePath: process.execPath, scriptPath });
  for (const uf of unitFiles) {
    const abs = join(homedir(), uf.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, uf.content);
    console.log(`  wrote ${abs}`);
  }
  if (platform === "darwin") {
    reloadWatchdogUnit(platform, join(homedir(), unitFiles[0].path));
  } else {
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      execFileSync("systemctl", ["--user", "enable", "--now", `${wds.WATCHDOG_SYSTEMD_NAME}.timer`]);
      console.log("  ✅ timer enabled");
    } catch {
      console.log(
        `  ⚠ units written but enabling failed — run: systemctl --user enable --now ${wds.WATCHDOG_SYSTEMD_NAME}.timer`,
      );
    }
  }
}

function reloadWatchdogUnit(platform, file) {
  if (platform === "darwin") {
    try {
      execFileSync("launchctl", ["unload", file], { stdio: "ignore" });
    } catch {
      /* was not loaded */
    }
    try {
      // launchctl can print "Load failed" to stderr and still exit 0 — merge
      // the streams and check the text, not just the exit code.
      const out = execFileSync("/bin/sh", ["-c", `launchctl load "${file}" 2>&1 || true`], {
        encoding: "utf8",
      });
      if (/load failed|bootstrap failed/i.test(out)) throw new Error(out.trim());
      console.log("  ✅ launchd agent (re)loaded");
    } catch {
      console.log(`  ⚠ plist written but load failed — run: launchctl load ${file}`);
    }
  } else {
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"]);
      console.log("  ✅ systemd reloaded");
    } catch {
      console.log("  ⚠ run: systemctl --user daemon-reload");
    }
  }
}

if (DRY_RUN || !wroteConfig) {
  console.log(DRY_RUN ? "\ndry-run: nothing written." : "");
  rl.close();
  process.exit(0);
}

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
