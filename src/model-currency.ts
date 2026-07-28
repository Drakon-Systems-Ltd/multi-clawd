/**
 * "A new Claude model exists and your chain doesn't mention it."
 *
 * Deliberately NOT "we picked a better model for you". Which model belongs at
 * the top of a chain is a cost, quality and behaviour decision that only the
 * operator can make — the Opus 5 / Fable 5 choice went either way on defensible
 * grounds. A credential-handling plugin that silently rewired routing would be
 * surprising in exactly the way this project must never be. So: detect, tell,
 * offer the one-line change, and stop.
 *
 * The honesty problem is "new". Model ids do not sort into a meaningful
 * recency order across families (`claude-opus-5` vs `claude-fable-5` vs
 * `claude-sonnet-5`), so any "newer than yours" claim would be invention. What
 * IS verifiable is *new to this machine*: an id present in the catalog now that
 * was not present the last time we looked. That is a fact, and it fires exactly
 * once per genuinely new model.
 */
import { isModernClaudeModelId } from "./models.js";

export interface KnownModelsState {
  /** Catalog model ids observed on a previous run. */
  ids: string[];
  /** Epoch ms of the last observation. */
  updatedAt?: number;
}

export interface ModelCurrencyResult {
  /** Claude ids in the catalog now that were absent from the stored set. */
  newIds: string[];
  /** Of those, the ones no chain reference mentions — the ones worth raising. */
  unusedNewIds: string[];
  /** The state to persist for next time. */
  nextState: KnownModelsState;
  /** True on the very first run, when everything looks "new" and nothing should alert. */
  firstRun: boolean;
}

/** Bare model id from a possibly provider-prefixed reference. */
function modelIdOf(ref: string): string {
  const i = ref.indexOf("/");
  return i < 0 ? ref : ref.slice(i + 1);
}

/**
 * Diff the live catalog against what this machine saw last time.
 *
 * @param stored     previously observed ids (undefined/empty ⇒ first run)
 * @param catalogIds model ids currently offered by the catalog
 * @param chainRefs  every model reference in the effective chain (any prefix)
 * @param nowMs      clock, injected so this stays pure and testable
 *
 * On the FIRST run every id is unseen; alerting then would dump the entire
 * catalog into the operator's chat for no reason. So the first run only
 * records the baseline — the feature starts speaking on the second run, when
 * "new" actually means new.
 */
export function diffCatalogModels(
  stored: KnownModelsState | undefined,
  catalogIds: readonly string[],
  chainRefs: readonly string[],
  nowMs: number,
): ModelCurrencyResult {
  const claudeIds = [...new Set(catalogIds.filter(isModernClaudeModelId))].sort();
  const nextState: KnownModelsState = { ids: claudeIds, updatedAt: nowMs };

  const firstRun = !stored || !Array.isArray(stored.ids) || stored.ids.length === 0;
  if (firstRun) return { newIds: [], unusedNewIds: [], nextState, firstRun: true };

  const seen = new Set(stored.ids);
  const newIds = claudeIds.filter((id) => !seen.has(id));

  const referenced = new Set(chainRefs.map(modelIdOf));
  const unusedNewIds = newIds.filter((id) => !referenced.has(id));

  return { newIds, unusedNewIds, nextState, firstRun: false };
}

/**
 * Operator-facing text for newly available models, or undefined when there is
 * nothing to say. Phrased as an offer with the exact edit, never as a
 * recommendation — we do not know their budget or their taste.
 */
export function formatNewModelNotice(
  unusedNewIds: readonly string[],
  poolId: string,
): string | undefined {
  if (unusedNewIds.length === 0) return undefined;
  const list = unusedNewIds.map((id) => `${poolId}/${id}`).join(", ");
  const subject = unusedNewIds.length === 1 ? "A new Claude model is" : "New Claude models are";
  return (
    `${subject} available on your accounts but not referenced in your chain: ${list}. ` +
    `Whether it belongs as your primary, a fallback, or nowhere is your call — ` +
    `run \`multi-clawd chain\` to see your current routing.`
  );
}
