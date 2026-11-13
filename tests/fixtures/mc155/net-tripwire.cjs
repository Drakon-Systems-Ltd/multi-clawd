"use strict";
// Loopback-only network tripwire for the #155 route evidence harness.
//
// Preloaded with `NODE_OPTIONS=--require <this file>` into the gateway child
// and everything it starts. Every attempt to reach a non-loopback host is
// REFUSED before a packet leaves and RECORDED (one JSON line) in
// MC155_TRIPWIRE_LOG. Each process that loads the file also records an
// `armed` line, so "the log has no blocked line" can be told apart from "the
// tripwire was never loaded".
//
// MC155_TRIPWIRE_DISABLED=1 exists ONLY for the harness's negative control: it
// loads the file without patching or recording, to prove that the arm check
// fails when the detector is off. The gateway child never gets that variable
// (the environment guard rejects it).
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const dns = require("node:dns");
const path = require("node:path");

const LOG = process.env.MC155_TRIPWIRE_LOG;
const DISABLED = process.env.MC155_TRIPWIRE_DISABLED === "1";

function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
  } catch {
    // The log is evidence, not control flow: a failed write must not change
    // what the process under test does. The arm check catches a missing log.
  }
}

function isLoopbackHost(host) {
  // Node treats a missing host as localhost.
  if (host === undefined || host === null || host === "") return true;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^::ffff:127(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

function blockedError(what) {
  const err = new Error(`mc155 tripwire: non-loopback ${what} refused`);
  err.code = "EMC155TRIPWIRE";
  return err;
}

/** { host, port } for a TCP connect, or null for a local IPC path. */
function connectTarget(args) {
  let first = args[0];
  // net.connect() hands Socket.prototype.connect its normalised [options, cb].
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return null;
    return { host: first.host, port: first.port };
  }
  if (typeof first === "number") {
    return { host: typeof args[1] === "string" ? args[1] : undefined, port: first };
  }
  if (typeof first === "string") {
    // A numeric string is a port; anything else is an IPC path.
    if (/^\d+$/.test(first)) {
      return { host: typeof args[1] === "string" ? args[1] : undefined, port: Number(first) };
    }
    return null;
  }
  return { host: undefined, port: undefined };
}

if (!DISABLED) {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function mc155Connect(...args) {
    const target = connectTarget(args);
    if (target && !isLoopbackHost(target.host)) {
      record({ event: "blocked-connect", host: String(target.host), port: target.port ?? null });
      const err = blockedError(`connect to ${target.host}:${target.port}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  const originalSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function mc155Send(...args) {
    // send(msg, [offset, length,] [port], [address], [callback]); msg may be a string.
    const address = args.slice(1).filter((a) => typeof a === "string").pop();
    if (address !== undefined && !isLoopbackHost(address)) {
      record({ event: "blocked-udp", host: address });
      const callback = args.find((a) => typeof a === "function");
      const err = blockedError(`udp send to ${address}`);
      if (callback) process.nextTick(() => callback(err));
      return;
    }
    return originalSend.apply(this, args);
  };
  const originalUdpConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function mc155UdpConnect(...args) {
    const address = args.find((a) => typeof a === "string");
    if (address !== undefined && !isLoopbackHost(address)) {
      record({ event: "blocked-udp", host: address });
      throw blockedError(`udp connect to ${address}`);
    }
    return originalUdpConnect.apply(this, args);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function mc155Lookup(hostname, ...rest) {
    if (!isLoopbackHost(hostname)) {
      record({ event: "blocked-lookup", host: String(hostname) });
      const callback = rest.find((a) => typeof a === "function");
      const err = blockedError(`dns lookup of ${hostname}`);
      if (callback) process.nextTick(() => callback(err));
      return {};
    }
    return originalLookup.call(dns, hostname, ...rest);
  };
  const originalPromisesLookup = dns.promises.lookup;
  dns.promises.lookup = function mc155PromisesLookup(hostname, ...rest) {
    if (!isLoopbackHost(hostname)) {
      record({ event: "blocked-lookup", host: String(hostname) });
      return Promise.reject(blockedError(`dns lookup of ${hostname}`));
    }
    return originalPromisesLookup.call(dns.promises, hostname, ...rest);
  };
  for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveSrv"]) {
    const original = dns[name];
    if (typeof original === "function") {
      dns[name] = function mc155Resolve(hostname, ...rest) {
        if (!isLoopbackHost(hostname)) {
          record({ event: "blocked-lookup", host: String(hostname) });
          const callback = rest.find((a) => typeof a === "function");
          const err = blockedError(`dns ${name} of ${hostname}`);
          if (callback) process.nextTick(() => callback(err));
          return {};
        }
        return original.call(dns, hostname, ...rest);
      };
    }
    const originalPromise = dns.promises[name];
    if (typeof originalPromise === "function") {
      dns.promises[name] = function mc155ResolvePromise(hostname, ...rest) {
        if (!isLoopbackHost(hostname)) {
          record({ event: "blocked-lookup", host: String(hostname) });
          return Promise.reject(blockedError(`dns ${name} of ${hostname}`));
        }
        return originalPromise.call(dns.promises, hostname, ...rest);
      };
    }
  }

  globalThis.__mc155TripwireArmed = true;
  record({ event: "armed", script: process.argv[1] ? path.basename(process.argv[1]) : null });
}

module.exports = { isLoopbackHost, connectTarget };
