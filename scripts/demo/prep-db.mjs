/**
 * Video DB prep (used by scripts/demo/record-video.mjs). Takes a freshly seeded scratch DB (`pnpm seed -- --db <file>`)
 * and makes it ready for live takes:
 *  - removes the three seeded requests the video re-creates live over MCP (reins.dev $12.98, statista $59, fiverr $450),
 *    so the month total ends at the plan's "$117.97 of $410" again after the takes
 *  - rolls every agent back to mandate v1: the seed gives Research Scout v2 and v3, but the video saves "version two"
 *    (always allow statista) and "version three" (tighten after fiverr) live. Requests are re-pointed at v1.
 *  - marks the workspace as connected (fake PayPal) with a fake vault id, so AUTO_APPROVE pays through the vaulted
 *    strategy (Orders v2 with payment_source.paypal.vault_id) instead of waiting for a buyer
 *  - gives each seed agent a fresh `rk_live_` key (seed keys are discarded) and returns the raw keys
 * Refuses any path that is not under the given scratch directory, so the dev DB (apps/web/.local/reins.db) is never touched.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // same as packages/core/src/keys.ts

function newKey() {
  let body = "";
  for (const b of randomBytes(32)) body += ALPHABET[b % ALPHABET.length];
  const key = `rk_live_${body}`;
  return { key, hash: createHash("sha256").update(key, "utf8").digest("hex"), prefix: key.slice(0, 12) };
}

export const LIVE_TAKES = [
  ["namecheap.com", 1298],
  ["statista.com", 5900],
  ["fiverr.com", 45000],
];

export function prepVideoDb(dbFile, scratchRoot) {
  const abs = path.resolve(dbFile);
  if (!abs.startsWith(path.resolve(scratchRoot) + path.sep)) throw new Error(`refusing to prep a DB outside ${scratchRoot}: ${abs}`);
  const sql = (q) => execFileSync("/usr/bin/sqlite3", [abs, q], { encoding: "utf8" }).trim();
  const thisMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  const where = LIVE_TAKES.map(([m, c]) => `(merchant='${m}' and amount_cents=${c})`).join(" or ");
  const ids = `select id from requests where created_at >= ${thisMonth} and (${where})`;
  const n = Number(sql(`select count(*) from (${ids})`));
  if (n !== LIVE_TAKES.length) throw new Error(`expected ${LIVE_TAKES.length} seed rows to replace, found ${n} (seed changed?)`);
  sql(`pragma foreign_keys=off;
    delete from request_messages where request_id in (${ids});
    delete from decisions where request_id in (${ids});
    delete from payments where request_id in (${ids});
    delete from requests where id in (${ids});
    update requests set mandate_id = (select m1.id from mandates m1 join mandates m2 on m1.agent_id = m2.agent_id and m1.version = 1 where m2.id = requests.mandate_id)
      where mandate_id in (select id from mandates where version > 1);
    delete from mandates where version > 1;
    insert or ignore into workspace(id) values (1);
    update workspace set paypal_env='fake', payment_mode='vaulted', vault_id='VAULT-FAKE-VIDEO', connected_at=${Date.now()} where id=1;`);
  const keys = {};
  for (const line of sql("select id || '|' || name from agents").split("\n")) {
    const [id, name] = line.split("|");
    const k = newKey();
    sql(`update agents set key_hash='${k.hash}', key_prefix='${k.prefix}' where id='${id}'`);
    keys[name] = k.key;
  }
  return keys;
}
