/**
 * Pure decisions for the `multi-clawd update` CLI command: what state is the
 * install in, and what should the update flow do about it. All IO (registry
 * lookup, openclaw invocation, prompts) lives in scripts/cli.mjs.
 */

/** Numeric semver-triplet compare; missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type UpdateAction = "install" | "update" | "up-to-date" | "unknown";

export function decideUpdateAction(opts: {
  installed: string | undefined;
  latest: string | undefined;
}): UpdateAction {
  if (opts.installed === undefined) return "install";
  if (opts.latest === undefined) return "unknown";
  return compareVersions(opts.installed, opts.latest) < 0 ? "update" : "up-to-date";
}

/**
 * Version skew between the two halves of an install.
 *
 * multi-clawd ships as TWO artifacts from one package: the global CLI (the
 * `multi-clawd` command, which owns `doctor`/`setup`/`explain`) and the
 * OpenClaw plugin (which actually serves turns). `update` upgrades the plugin
 * only, so the CLI can silently fall behind — and because the diagnostics live
 * in the CLI, a stale CLI then reports stale findings about a perfectly
 * current plugin. That trap is why this exists: skew must never be silent.
 */
export type CliSkew = "aligned" | "cli-behind" | "cli-ahead" | "plugin-missing";

export function classifyCliSkew(opts: {
  cliVersion: string;
  pluginVersion: string | undefined;
}): CliSkew {
  if (opts.pluginVersion === undefined) return "plugin-missing";
  const d = compareVersions(opts.cliVersion, opts.pluginVersion);
  if (d === 0) return "aligned";
  return d < 0 ? "cli-behind" : "cli-ahead";
}

/**
 * How this CLI was invoked, which decides what "update yourself" even means.
 * Derived from the package's own directory so it stays a pure function.
 */
export type CliInstallKind = "global" | "npx" | "source";

export function detectCliInstallKind(cliDir: string): CliInstallKind {
  // npm's npx cache: ~/.npm/_npx/<hash>/node_modules/<pkg>
  if (/[/\\]_npx[/\\]/.test(cliDir)) return "npx";
  if (/[/\\]node_modules[/\\]/.test(cliDir)) return "global";
  return "source";
}

/** The exact command that brings a stale CLI up to date, for this install kind. */
export function cliUpdateCommand(kind: CliInstallKind, pkg: string): string {
  switch (kind) {
    case "global":
      return `npm i -g ${pkg}@latest`;
    case "npx":
      return `npx ${pkg}@latest <command>`;
    case "source":
      return "git pull && npm run build";
  }
}

/**
 * One-line advice about skew, or undefined when there is nothing to say.
 * Deliberately explicit about the CONSEQUENCE, not just the numbers — the
 * version pair alone is what confused us in the first place.
 */
export function formatCliSkew(opts: {
  cliVersion: string;
  pluginVersion: string | undefined;
  installKind: CliInstallKind;
  pkg: string;
}): string | undefined {
  const skew = classifyCliSkew(opts);
  const fix = cliUpdateCommand(opts.installKind, opts.pkg);
  switch (skew) {
    case "aligned":
      return undefined;
    case "plugin-missing":
      return undefined; // `update` already reports "not installed" plainly.
    case "cli-behind":
      return (
        `CLI v${opts.cliVersion} is older than the installed plugin v${opts.pluginVersion} — ` +
        `\`doctor\`/\`setup\` run from the CLI, so this one reports on the plugin using ` +
        `older logic. Fix: ${fix}`
      );
    case "cli-ahead":
      return (
        `CLI v${opts.cliVersion} is newer than the installed plugin v${opts.pluginVersion} — ` +
        `the plugin serving your turns is behind. Fix: multi-clawd update`
      );
  }
}

/**
 * How long a registry answer is reused before doctor asks npm again. Doctor is
 * run interactively and must stay fast; the question ("has a newer version
 * been published?") does not change minute to minute.
 */
export const REGISTRY_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

export function registryCacheIsFresh(
  checkedAt: number | undefined,
  nowMs: number,
  ttlMs: number = REGISTRY_CHECK_TTL_MS,
): boolean {
  if (typeof checkedAt !== "number") return false;
  // A cache stamped in the future is a clock change, not a valid answer.
  return checkedAt <= nowMs && nowMs - checkedAt < ttlMs;
}

/**
 * Whether the INSTALLED PLUGIN is behind what npm publishes, and what to say.
 *
 * This exists because of a trap found on 1 Aug 2026: our installer pins the
 * plugin (`plugins install --pin --force`, correctly — OpenClaw's own security
 * audit raises a HIGH finding for unpinned install specs), and OpenClaw then
 * resolves registry metadata FOR THE PINNED SPEC. `openclaw plugins update
 * --all` therefore compares 1.6.0 against 1.6.0, reports "multi-clawd is up to
 * date (1.6.0)" and returns — while 1.7.1 sat on npm. OpenClaw has an honest
 * "pinned to X; registry default resolves to Y" message, but it is built
 * inside the `dryRun` branch, so it never fires on a real update run.
 *
 * Net effect: neither command a person actually runs would ever surface a new
 * version — `plugins update --all` reassures them wrongly, and doctor did no
 * registry lookup at all. Doctor is the honest place to close that.
 *
 * Returns undefined when the registry could not be reached: an unreachable
 * network is not a finding, and doctor must stay quiet offline.
 */
export function formatRegistryLag(opts: {
  installed: string | undefined;
  latest: string | undefined;
  pkg?: string;
}): { level: "ok" | "warn"; text: string } | undefined {
  if (!opts.installed || !opts.latest) return undefined;
  if (compareVersions(opts.installed, opts.latest) >= 0) {
    return { level: "ok", text: `plugin v${opts.installed} is the latest published version` };
  }
  return {
    level: "warn",
    text:
      `plugin v${opts.installed} — npm publishes v${opts.latest}. The install is pinned, so ` +
      `\`openclaw plugins update --all\` reports it up to date and will not move it. ` +
      `Fix: multi-clawd update`,
  };
}

export function formatUpdateBanner(opts: {
  installed: string | undefined;
  latest: string | undefined;
}): string {
  const action = decideUpdateAction(opts);
  switch (action) {
    case "install":
      return `not installed — latest is v${opts.latest}`;
    case "update":
      return `update available: v${opts.installed} → v${opts.latest}`;
    case "up-to-date":
      return `up to date (v${opts.installed})`;
    case "unknown":
      return `installed v${opts.installed} — could not reach the registry to check for updates`;
  }
}
