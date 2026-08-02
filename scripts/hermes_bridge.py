#!/usr/bin/env python3
"""Secret-safe JSON/stdin bridge for multi-clawd's Hermes adapter.

The bridge deliberately has no command-line token interface.  A caller selects
one Hermes profile/home with HERMES_HOME, sends exactly one JSON document on
stdin, and receives exactly one JSON document on stdout.

Only stable ``claude setup-token`` values are accepted.  A rotating Claude
grant (a native or config-dir ``.credentials.json``) is single-use on refresh,
so duplicating one into a second store guarantees that one of the copies dies.
For a *native* login that copy is unnecessary anyway: Hermes' own
``claude_code`` credential source already reads that exact file directly. A
*config-dir* login has no such fallback — as of Hermes Agent 0.19.1,
``claude_code`` only reads the native path, never an arbitrary config dir — so
it can only reach this bridge via its own setup token, never a duplicated
grant. Requests carrying refresh tokens or expiries are refused outright.

Planning reads the PROFILE-LOCAL auth store directly.  ``read_credential_pool``
falls back to the global-root ``auth.json`` when a profile has no entries for a
provider, so planning against it would copy unrelated global credentials into
the profile on the first sync.  It is used only to report the effective view
that Hermes itself would see, and is labelled as such.

Writes are the two Hermes files the adapter owns a slice of.  Each individual
write is atomic inside Hermes (``write_credential_pool`` merges the on-disk pool
under a lock; ``save_config`` writes YAML through a temp file + rename), but the
pair is NOT atomic.  The pool is written first and the config second, both are
idempotent, and both are verified by re-reading afterwards, so an interruption
between them leaves a state that a re-run repairs rather than one that needs a
rollback.  There is deliberately no rollback path: rewriting a user's whole
config.yaml to undo a strategy key is more dangerous than leaving a stale
strategy behind.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import stat
import sys
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROVIDER = "anthropic"
MANAGED_SOURCE = "manual:multi-clawd"
MANAGED_ID_PREFIX = "multi-clawd-"
STRATEGIES = ("fill_first", "round_robin", "random", "least_used")
DEFAULT_STRATEGY = "fill_first"
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_AUTH_STORE_BYTES = 8 * 1024 * 1024
MAX_ACCOUNT_ID_LENGTH = 64
MAX_CREDENTIALS = 64
ACCOUNT_ID_ALPHABET = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_-")
# Cleared whenever a managed row is written: a setup token never expires on a
# schedule, so a stale expiry copied from an older row would quarantine it.
STALE_EXPIRY_FIELDS = ("expires_at", "expires_at_ms", "last_refresh")
# Mirrors src/hermes-core.ts's parseClaudeSetupToken: ASCII-only, and shaped
# like the current `sk-ant-oat01-...` setup-token family. The version digits
# are intentionally unconstrained beyond "two or more" so a future
# `sk-ant-oat02-...` does not need both sides of the bridge updated in lockstep.
SETUP_TOKEN_RE = re.compile(r"^sk-ant-oat\d{2,}-[\x21-\x7e]+$")
API_KEY_PREFIX = "sk-ant-api"
# Hermes' own agent.credential_pool.STATUS_* values. Anything else on disk is
# either stale, from another tool, or attacker-controlled, so it is dropped
# rather than echoed — see safe_row().
KNOWN_ROW_STATUSES = frozenset({"ok", "exhausted", "dead"})


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


@dataclass(frozen=True)
class DesiredCredential:
    account_id: str
    id: str
    label: str
    access_token: str
    priority: int


def fail(code: str, message: str) -> None:
    raise BridgeError(code, message)


def record(value: Any, code: str = "malformed_request") -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(code, "request data is malformed")
    return value


def nonempty_string(value: Any, code: str, message: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        fail(code, message)
    return value.strip()


def stable_id(account_id: str) -> str:
    digest = hashlib.sha256(f"multi-clawd/hermes/{account_id}".encode()).hexdigest()
    return f"{MANAGED_ID_PREFIX}{digest[:16]}"


def selected_home(request: dict[str, Any]) -> Path:
    raw_home = os.environ.get("HERMES_HOME", "")
    if not raw_home.strip():
        fail("hermes_home_required", "HERMES_HOME must select the target Hermes home")
    env_home = Path(raw_home).expanduser()
    if not env_home.is_absolute():
        fail("invalid_hermes_home", "HERMES_HOME must be an absolute path")
    env_home = env_home.resolve(strict=False)

    supplied = [request.get(key) for key in ("targetHome", "hermesHome") if key in request]
    if len(supplied) > 1 and supplied[0] != supplied[1]:
        fail("target_home_mismatch", "payload target does not match HERMES_HOME")
    if supplied:
        raw_target = nonempty_string(
            supplied[0], "invalid_target_home", "payload target home is malformed"
        )
        target = Path(raw_target).expanduser()
        if not target.is_absolute() or target.resolve(strict=False) != env_home:
            fail("target_home_mismatch", "payload target does not match HERMES_HOME")
    return env_home


def assert_profile_exists(home: Path) -> None:
    """Never fabricate a named profile.

    Hermes' ``ensure_hermes_home()`` refuses to mkdir ``<root>/profiles/<name>``
    on purpose, so a deleted profile is not resurrected as an empty skeleton.
    The adapter honours that invariant instead of working around it.
    """
    if home.parent.name == "profiles" and not home.is_dir():
        fail(
            "hermes_profile_missing",
            "the named Hermes profile does not exist; create it with "
            "`hermes profile create <name>` before syncing",
        )


def request_operation(request: dict[str, Any]) -> str:
    operation = request.get("operation")
    alias = request.get("op")
    if operation is not None and alias is not None and operation != alias:
        fail("malformed_request", "request operation is ambiguous")
    operation = operation if operation is not None else alias
    if operation not in {"probe", "doctor", "apply"}:
        fail("unsupported_operation", "operation must be probe, doctor, or apply")
    return operation


def parse_desired(value: Any) -> list[DesiredCredential]:
    if not isinstance(value, list) or not value:
        fail("malformed_credentials", "credentials must be a non-empty array")
    if len(value) > MAX_CREDENTIALS:
        fail("malformed_credentials", "too many credentials were submitted")

    desired: list[DesiredCredential] = []
    seen_ids: set[str] = set()
    seen_priorities: set[int] = set()
    allowed = {"accountId", "id", "label", "source", "authType", "accessToken", "priority"}
    rotating = {"refreshToken", "expiresAtMs", "expiresAt", "refresh_token", "expires_at"}
    for value_row in value:
        row = record(value_row, "malformed_credentials")
        if rotating & set(row):
            fail(
                "rotating_grant_not_supported",
                "only stable Claude setup tokens can be imported; rotating grants are single-use — "
                "a native ~/.claude login is already read directly by Hermes' own claude_code "
                "credential source, and a configDir login needs its own setup token instead "
                "(claude_code cannot be pointed at a configDir)",
            )
        if set(row) - allowed:
            fail("malformed_credentials", "credential data contains unsupported fields")
        account_id = nonempty_string(
            row.get("accountId"), "malformed_credentials", "credential data is malformed"
        )
        if (
            len(account_id) > MAX_ACCOUNT_ID_LENGTH
            or not account_id[0].isalnum()
            or any(ch not in ACCOUNT_ID_ALPHABET for ch in account_id)
        ):
            fail("malformed_credentials", "credential account id is malformed")
        credential_id = nonempty_string(
            row.get("id"), "malformed_credentials", "credential data is malformed"
        )
        if credential_id != stable_id(account_id):
            fail("invalid_managed_id", "managed credential id is not deterministic for its account")
        if credential_id in seen_ids:
            fail("duplicate_managed_ids", "desired managed credential ids must be unique")
        seen_ids.add(credential_id)

        expected_label = f"multi-clawd:{account_id}"
        if row.get("label") != expected_label:
            fail("malformed_credentials", "managed credential label is malformed")
        if row.get("source") != MANAGED_SOURCE or row.get("authType") != "oauth":
            fail("malformed_credentials", "managed credential metadata is malformed")
        access_token = nonempty_string(
            row.get("accessToken"), "malformed_credentials", "credential data is malformed"
        )
        if access_token.startswith(API_KEY_PREFIX):
            fail(
                "malformed_credentials",
                "that looks like a Claude API key, not a setup token — setup tokens start with "
                "sk-ant-oat",
            )
        if not access_token.isascii() or not SETUP_TOKEN_RE.match(access_token):
            fail("malformed_credentials", "the submitted setup token is malformed")
        priority = row.get("priority")
        if (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or priority < 0
            or priority >= MAX_CREDENTIALS
        ):
            fail("malformed_credentials", "credential priority is malformed")
        if priority in seen_priorities:
            fail("malformed_credentials", "credential priorities must be unique")
        seen_priorities.add(priority)

        desired.append(
            DesiredCredential(
                account_id=account_id,
                id=credential_id,
                label=expected_label,
                access_token=access_token,
                priority=priority,
            )
        )
    return desired


def read_local_pool(home: Path) -> list[Any]:
    """Read this home's OWN anthropic pool rows — no global-root fallback.

    Hermes exposes no public profile-local reader, so the store is read here
    under a strict size/shape bound.  Unlike Hermes' internal loader this never
    degrades a corrupt store to an empty one: planning against ``[]`` when the
    file is really unreadable would look like "nothing is configured" and add
    duplicate rows.
    """
    path = home / "auth.json"
    try:
        info = path.stat()
    except FileNotFoundError:
        return []
    except OSError:
        fail("auth_store_unreadable", "the Hermes auth store could not be read")
    if not stat.S_ISREG(info.st_mode):
        fail("auth_store_unreadable", "the Hermes auth store is not a regular file")
    if info.st_size > MAX_AUTH_STORE_BYTES:
        fail("auth_store_unreadable", "the Hermes auth store is too large to plan against safely")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        fail(
            "auth_store_unreadable",
            "the Hermes auth store is unreadable or unparseable; repair it with Hermes first",
        )
    if not isinstance(data, dict):
        fail("auth_store_unreadable", "the Hermes auth store has an unexpected shape")
    pool = data.get("credential_pool")
    if pool is None:
        return []
    if not isinstance(pool, dict):
        fail("malformed_pool_rows", "the Hermes credential pool has an unexpected shape")
    rows = pool.get(PROVIDER)
    if rows is None:
        return []
    if not isinstance(rows, list):
        fail("malformed_pool_rows", "the Hermes anthropic credential pool is malformed")
    return rows


def is_managed_row(row_id: Any, source: Any) -> bool:
    return (isinstance(row_id, str) and row_id.startswith(MANAGED_ID_PREFIX)) or source == MANAGED_SOURCE


def pool_findings(rows: list[Any]) -> dict[str, dict[str, list[str]]]:
    """Split pool observations into what blocks a sync and what merely informs.

    Only multi-clawd's OWN rows can block: duplicate managed ids, and managed
    rows that are half-managed or unusable.  Everything else — several
    ``claude_code`` rows, a malformed row belonging to another tool — is a
    legitimate user state that is none of this adapter's business, so it is
    reported as a warning and never fails doctor or sync.

    Unrelated rows are identified by position only; their ids and labels can
    carry account identifiers and are never echoed.
    """
    duplicate_managed: dict[str, int] = {}
    malformed_managed: list[str] = []
    claude_code: list[str] = []
    malformed_unrelated: list[str] = []

    for index, row in enumerate(rows):
        marker = f"row:{index}"
        if not isinstance(row, dict):
            malformed_unrelated.append(marker)
            continue
        row_id = row.get("id")
        source = row.get("source")
        id_ok = isinstance(row_id, str) and bool(row_id.strip())
        source_ok = source is None or isinstance(source, str)
        if is_managed_row(row_id if id_ok else None, source if source_ok else None):
            label = row_id if id_ok else marker
            duplicate_managed[label] = duplicate_managed.get(label, 0) + 1
            has_managed_id = id_ok and row_id.startswith(MANAGED_ID_PREFIX)
            has_managed_source = source == MANAGED_SOURCE
            if (
                not id_ok
                or has_managed_id != has_managed_source
                or row.get("auth_type") != "oauth"
                or not isinstance(row.get("label"), str)
                or not isinstance(row.get("access_token"), str)
                or not row.get("access_token")
            ):
                malformed_managed.append(label)
        elif not id_ok or not source_ok:
            malformed_unrelated.append(marker)
        if source == "claude_code":
            claude_code.append(marker)

    return {
        "errors": {
            "duplicateManagedIds": sorted(
                row_id for row_id, count in duplicate_managed.items() if count > 1
            ),
            "malformedManagedRows": sorted(set(malformed_managed)),
        },
        "warnings": {
            "multipleClaudeCodeRows": sorted(claude_code) if len(claude_code) > 1 else [],
            "malformedUnrelatedRows": sorted(set(malformed_unrelated)),
        },
    }


def finding_counts(findings: dict[str, dict[str, list[str]]]) -> tuple[int, int]:
    errors = sum(len(rows) for rows in findings["errors"].values())
    warnings = sum(len(rows) for rows in findings["warnings"].values())
    return errors, warnings


def assert_pool_safe(findings: dict[str, dict[str, list[str]]]) -> None:
    errors = findings["errors"]
    if errors["duplicateManagedIds"]:
        fail("duplicate_managed_ids", "Hermes contains duplicate multi-clawd managed credential ids")
    if errors["malformedManagedRows"]:
        fail("malformed_managed_rows", "Hermes contains malformed multi-clawd managed rows")


def unrelated_row_malformed(row: dict[str, Any]) -> bool:
    row_id = row.get("id")
    source = row.get("source")
    id_ok = isinstance(row_id, str) and bool(row_id.strip())
    source_ok = source is None or isinstance(source, str)
    return not id_ok or not source_ok


def safe_row(row: Any, index: int) -> dict[str, Any]:
    """Render one pool row with no secret material and no unrelated identifiers.

    An unrelated row belongs to another tool, or to a hand-edited auth.json —
    every one of its fields (not just id/label) can carry an arbitrary
    attacker-chosen string, so nothing beyond its position is ever echoed for
    it. A managed row only reports the fixed values this adapter itself
    defines (its deterministic id/label, the constant source/authType, and a
    validated integer priority), plus lastStatus only when it is one of
    Hermes' own known status strings — never whatever happens to be on disk.
    """
    if not isinstance(row, dict):
        return {"index": index, "managed": False, "malformed": True}
    if not is_managed_row(row.get("id"), row.get("source")):
        result: dict[str, Any] = {"index": index, "managed": False}
        if unrelated_row_malformed(row):
            result["malformed"] = True
        return result
    priority = row.get("priority")
    last_status = row.get("last_status")
    result = {
        "index": index,
        "managed": True,
        "id": row.get("id"),
        "label": row.get("label"),
        "source": MANAGED_SOURCE,
        "authType": "oauth",
        "priority": priority if isinstance(priority, int) and not isinstance(priority, bool) else None,
        "lastStatus": last_status if last_status in KNOWN_ROW_STATUSES else None,
    }
    return {key: value for key, value in result.items() if value is not None}


def current_strategy(config: dict[str, Any]) -> str | None:
    strategies = config.get("credential_pool_strategies")
    if strategies is None:
        return None
    if not isinstance(strategies, dict):
        fail("malformed_config", "credential_pool_strategies must be a mapping")
    value = strategies.get(PROVIDER)
    if value is not None and not isinstance(value, str):
        fail("malformed_config", "anthropic credential pool strategy must be a string")
    return value


def effective_strategy(requested: str | None, current: str | None) -> str:
    """An omitted --strategy preserves whatever Hermes already has.

    A value this adapter does not recognise is still preserved rather than
    policed: it belongs to the user's Hermes install, not to multi-clawd.
    """
    if requested is not None:
        return requested
    if current is not None:
        return current
    return DEFAULT_STRATEGY


def build_new_row(credential: DesiredCredential) -> dict[str, Any]:
    from agent.credential_pool import PooledCredential

    return PooledCredential(
        provider=PROVIDER,
        id=credential.id,
        label=credential.label,
        auth_type="oauth",
        priority=credential.priority,
        source=MANAGED_SOURCE,
        access_token=credential.access_token,
    ).to_dict()


def merge_credential(existing: dict[str, Any], credential: DesiredCredential) -> dict[str, Any]:
    """Replace the managed fields, keep Hermes' runtime bookkeeping.

    Expiry fields are cleared: a setup token carries no expiry, and a value left
    over from an older row would make Hermes treat a perfectly good credential
    as expired.
    """
    updated = copy.deepcopy(existing)
    updated.update(
        {
            "id": credential.id,
            "label": credential.label,
            "source": MANAGED_SOURCE,
            "auth_type": "oauth",
            "priority": credential.priority,
            "access_token": credential.access_token,
        }
    )
    updated.pop("refresh_token", None)
    for field in STALE_EXPIRY_FIELDS:
        updated.pop(field, None)
    return updated


def equivalent(existing: dict[str, Any], desired: DesiredCredential) -> bool:
    return (
        existing.get("id") == desired.id
        and existing.get("label") == desired.label
        and existing.get("source") == MANAGED_SOURCE
        and existing.get("auth_type") == "oauth"
        and existing.get("priority") == desired.priority
        and existing.get("access_token") == desired.access_token
        and existing.get("refresh_token") is None
        and all(existing.get(field) is None for field in STALE_EXPIRY_FIELDS)
    )


def plan_rows(
    local_rows: list[Any], desired: list[DesiredCredential]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build the managed rows to send, from the profile-local rows only.

    Only these rows are handed to ``write_credential_pool``; it re-reads the
    on-disk pool under its lock and keeps every entry it does not receive, so
    unrelated credentials survive without ever being read, copied, or rewritten
    by this adapter.
    """
    by_id: dict[str, dict[str, Any]] = {}
    for row in local_rows:
        if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"] not in by_id:
            by_id[row["id"]] = row

    managed_rows: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for credential in desired:
        existing = by_id.get(credential.id)
        if existing is None:
            managed_rows.append(build_new_row(credential))
            action = "add"
        elif existing.get("source") != MANAGED_SOURCE:
            fail("managed_id_collision", "a managed credential id is owned by another source")
        elif equivalent(existing, credential):
            managed_rows.append(copy.deepcopy(existing))
            action = "noop"
        else:
            managed_rows.append(merge_credential(existing, credential))
            action = "update"
        actions.append(
            {
                "accountId": credential.account_id,
                "id": credential.id,
                "action": action,
                "priority": credential.priority,
            }
        )
    return managed_rows, actions


def config_is_safe_to_rewrite(home: Path, config: dict[str, Any]) -> bool:
    """Refuse to rewrite a config.yaml Hermes could not parse.

    ``read_raw_config()`` fails open to ``{}`` on a parse error. Saving that
    back would erase the user's whole configuration to persist one strategy
    key, so a file with real content that read as empty is treated as a hard
    stop rather than as an empty config.
    """
    if config:
        return True
    path = home / "config.yaml"
    try:
        if path.stat().st_size > MAX_AUTH_STORE_BYTES:
            return False
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return True
    except Exception:
        return False
    return not any(
        line.strip() and not line.lstrip().startswith("#") for line in text.splitlines()
    )


def verify_pool_write(home: Path, desired: list[DesiredCredential]) -> None:
    written = {
        row["id"]: row
        for row in read_local_pool(home)
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    for credential in desired:
        row = written.get(credential.id)
        if row is None or not equivalent(row, credential):
            fail(
                "pool_write_unverified",
                "Hermes accepted the credential write but the managed rows are not on disk; "
                "check the Hermes install and re-run",
            )


def verify_strategy_write(strategy: str) -> None:
    from hermes_cli.config import read_raw_config

    if current_strategy(read_raw_config()) != strategy:
        fail(
            "strategy_write_unverified",
            "the managed credentials were written but Hermes did not persist the pool "
            "strategy (a package-manager-managed install refuses config writes); set it "
            "with `hermes config set credential_pool_strategies.anthropic <strategy>`",
        )


def observed_state(home: Path, operation: str) -> dict[str, Any]:
    from hermes_cli.auth import read_credential_pool
    from hermes_cli.config import read_raw_config

    local_rows = read_local_pool(home)
    effective_rows = read_credential_pool(PROVIDER)
    if not isinstance(effective_rows, list):
        effective_rows = []
    config = read_raw_config()
    findings = pool_findings(local_rows)
    errors, warnings = finding_counts(findings)
    strategy = current_strategy(config)
    response: dict[str, Any] = {
        "ok": True,
        "operation": operation,
        "home": str(home),
        "provider": PROVIDER,
        "strategy": strategy,
        "effectiveStrategy": effective_strategy(None, strategy),
        # Rows this home actually owns — the only rows a sync ever plans against.
        "localRowCount": len(local_rows),
        "localRows": [safe_row(row, index) for index, row in enumerate(local_rows)],
        # What Hermes itself would resolve here, which for a profile with no
        # anthropic entries of its own is the global root's pool, read-only.
        "effectiveRowCount": len(effective_rows),
        "effectiveIncludesGlobalFallback": not local_rows and bool(effective_rows),
        "findings": findings,
        "errorCount": errors,
        "warningCount": warnings,
    }
    if operation == "doctor":
        response["healthy"] = errors == 0
    return response


def apply_response(home: Path, request: dict[str, Any]) -> dict[str, Any]:
    from hermes_cli.auth import write_credential_pool
    from hermes_cli.config import read_raw_config, save_config

    raw_strategy = request.get("strategy")
    if raw_strategy is not None and (
        not isinstance(raw_strategy, str) or raw_strategy not in STRATEGIES
    ):
        fail("invalid_strategy", "strategy is not supported by Hermes")
    dry_run = request.get("dryRun", False)
    if not isinstance(dry_run, bool):
        fail("malformed_request", "dryRun must be a boolean")
    desired = parse_desired(request.get("credentials"))

    # Complete every validation and build the whole plan before writing.
    local_rows = read_local_pool(home)
    config = read_raw_config()
    findings = pool_findings(local_rows)
    errors, warnings = finding_counts(findings)
    assert_pool_safe(findings)
    current = current_strategy(config)
    strategy = effective_strategy(raw_strategy, current)
    managed_rows, actions = plan_rows(local_rows, desired)
    strategy_changed = current != strategy
    pool_changed = any(action["action"] != "noop" for action in actions)
    would_write = strategy_changed or pool_changed

    if not dry_run and would_write:
        if strategy_changed and not config_is_safe_to_rewrite(home, config):
            fail(
                "config_unreadable",
                "Hermes config.yaml could not be parsed; refusing to overwrite it. "
                "Repair it, or re-run without --strategy",
            )
        # Pool first, config second: the pool write merges under Hermes' lock
        # and is idempotent, so an interruption before the config write leaves a
        # state a re-run repairs. See the module docstring.
        if pool_changed:
            write_credential_pool(PROVIDER, managed_rows)
            verify_pool_write(home, desired)
        if strategy_changed:
            new_config = copy.deepcopy(config)
            strategies = new_config.setdefault("credential_pool_strategies", {})
            if not isinstance(strategies, dict):
                fail("malformed_config", "credential_pool_strategies must be a mapping")
            strategies[PROVIDER] = strategy
            save_config(
                new_config,
                strip_defaults=False,
                preserve_keys={("credential_pool_strategies", PROVIDER)},
            )
            verify_strategy_write(strategy)

    resulting = read_local_pool(home) if (would_write and not dry_run) else local_rows
    return {
        "ok": True,
        "operation": "apply",
        "home": str(home),
        "provider": PROVIDER,
        "dryRun": dry_run,
        "wouldWrite": would_write,
        "wrote": bool(would_write and not dry_run),
        "strategy": strategy,
        "requestedStrategy": raw_strategy,
        "currentStrategy": current,
        "strategyChanged": strategy_changed,
        "actions": actions,
        "localRowCount": len(local_rows),
        "preservedRowCount": sum(
            1
            for row in local_rows
            if not isinstance(row, dict) or row.get("id") not in {item.id for item in desired}
        ),
        # Managed rows for accounts that are no longer configured. They are
        # preserved, never silently deleted — removing a credential is the
        # user's call, via Hermes.
        "orphanManagedRowCount": sum(
            1
            for row in local_rows
            if isinstance(row, dict)
            and is_managed_row(row.get("id"), row.get("source"))
            and row.get("id") not in {item.id for item in desired}
        ),
        "resultingRows": [safe_row(row, index) for index, row in enumerate(resulting)],
        "findings": findings,
        "errorCount": errors,
        "warningCount": warnings,
    }


def dispatch(request: Any) -> dict[str, Any]:
    request = record(request)
    home = selected_home(request)
    assert_profile_exists(home)
    operation = request_operation(request)
    if operation in {"probe", "doctor"}:
        return observed_state(home, operation)
    return apply_response(home, request)


def read_request() -> Any:
    data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not data or len(data) > MAX_REQUEST_BYTES:
        fail("malformed_request", "request JSON is missing or too large")
    try:
        return json.loads(data)
    except Exception:
        fail("malformed_json", "request JSON is malformed")


def main() -> int:
    if len(sys.argv) != 1:
        response = {
            "ok": False,
            "error": {"code": "argv_not_supported", "message": "bridge accepts requests only on stdin"},
        }
        print(json.dumps(response, separators=(",", ":")))
        return 2

    try:
        request = read_request()
        # Hermes APIs occasionally print warnings. Discard them so neither a
        # provider error nor a malformed local file can echo secret material.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            response = dispatch(request)
        status = 0
    except BridgeError as error:
        response = {"ok": False, "error": {"code": error.code, "message": error.safe_message}}
        status = 1
    except Exception:
        response = {
            "ok": False,
            "error": {"code": "internal_error", "message": "Hermes bridge operation failed safely"},
        }
        status = 1
    print(json.dumps(response, separators=(",", ":"), sort_keys=True))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
