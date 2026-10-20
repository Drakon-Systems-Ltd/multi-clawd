import { constants, copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Locate JSON object properties without reserializing the operator's config. */
export function jsonSpans(source, offset = 0) {
  let at = offset;
  const ws = () => { while (/\s/.test(source[at] ?? "")) at++; };
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === "\\") { at += 2; continue; }
      if (source[at++] === '"') return { value: JSON.parse(source.slice(start, at)), start, end: at };
    }
    throw new Error("unterminated JSON string");
  }
  function value() {
    ws();
    const start = at;
    if (source[at] === "{") {
      at++; ws(); const properties = [];
      while (source[at] !== "}") {
        const key = string(); ws();
        if (source[at++] !== ":") throw new Error("invalid JSON object");
        const child = value(); ws();
        const end = at;
        properties.push({ key: key.value, keyStart: key.start, start: child.start, end: child.end, propertyEnd: end });
        if (source[at] !== ",") break;
        at++; ws();
      }
      if (source[at++] !== "}") throw new Error("invalid JSON object");
      return { start, end: at, properties };
    }
    if (source[at] === "[") {
      at++; ws(); const items = [];
      while (source[at] !== "]") {
        items.push(value()); ws();
        if (source[at] !== ",") break;
        at++; ws();
      }
      if (source[at++] !== "]") throw new Error("invalid JSON array");
      return { start, end: at, items };
    }
    if (source[at] === '"') return string();
    while (at < source.length && !/[\s,}\]]/.test(source[at])) at++;
    return { start, end: at };
  }
  const root = value(); ws();
  if (offset === 0 && at !== source.length) throw new Error("trailing JSON content");
  return root;
}

const property = (node, key) => {
  if (!node?.properties) throw new Error("expected JSON object");
  const matches = node.properties.filter((p) => p.key === key);
  if (matches.length > 1) throw new Error(`duplicate ${key} property`);
  return matches[0];
};
const child = (source, node, key) => {
  const p = property(node, key);
  return p && jsonSpans(source, p.start);
};

export function editAccountDisabled(source, id, disabled) {
  const original = JSON.parse(source);
  let node = jsonSpans(source);
  for (const key of ["plugins", "entries", "multi-clawd", "config", "accounts"]) {
    node = child(source, node, key);
    if (!node) throw new Error(`missing plugins.entries["multi-clawd"].config.accounts`);
  }
  if (!node.items) throw new Error("accounts must be an array");
  const accounts = original?.plugins?.entries?.["multi-clawd"]?.config?.accounts;
  const matches = accounts?.map((a, i) => a?.id === id ? i : -1).filter((i) => i >= 0) ?? [];
  if (matches.length === 0) throw new Error(`unknown account id "${id}"`);
  if (matches.length !== 1) throw new Error(`duplicate account id "${id}"`);
  const account = node.items[matches[0]];
  const flag = property(account, "disabled");
  if (flag && typeof accounts[matches[0]].disabled !== "boolean") throw new Error("disabled must be a boolean");
  let edited;
  if (flag) {
    edited = source.slice(0, flag.start) + String(disabled) + source.slice(flag.end);
  } else if (disabled) {
    const indent = source.slice(source.lastIndexOf("\n", account.start - 1) + 1, account.start);
    const space = source.slice(account.start + 1, account.end - 1);
    const multiline = space.includes("\n");
    const addition = account.properties.length
      ? `,${multiline ? `\n${indent}  ` : " "}"disabled": true`
      : `"disabled": true`;
    edited = source.slice(0, account.end - 1) + addition + source.slice(account.end - 1);
  } else {
    return { edited: source, changed: false };
  }
  const expected = structuredClone(original);
  expected.plugins.entries["multi-clawd"].config.accounts[matches[0]].disabled = disabled;
  if (JSON.stringify(JSON.parse(edited)) !== JSON.stringify(expected)) throw new Error("targeted edit changed other config values");
  return { edited, changed: edited !== source };
}

export function changeAccount(id, disabled, dryRun = false, configFile = join(homedir(), ".openclaw", "openclaw.json")) {
  const source = readFileSync(configFile, "utf8");
  const { edited, changed } = editAccountDisabled(source, id, disabled);
  if (dryRun || !changed) return { changed, dryRun };
  if (readFileSync(configFile, "utf8") !== source) throw new Error("config changed during edit; retry");
  const backup = `${configFile}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(configFile, backup, constants.COPYFILE_EXCL);
  const temporary = `${configFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, edited, { mode: statSync(configFile).mode & 0o777 });
    if (readFileSync(configFile, "utf8") !== source) throw new Error("config changed during edit; retry");
    renameSync(temporary, configFile);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { changed, dryRun, backup };
}
