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
