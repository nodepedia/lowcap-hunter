import test from "node:test";
import assert from "node:assert/strict";
import { mergeWallets, gmgnImport } from "../src/sync-wallets.js";

test("dedupes duplicates in input and updates on re-find", () => {
  const a = "6bnQ7Ea1eSHVNKpkzPFUVZtL14ZDQ3cerfTYLpRJowWf", b = "BKRguFtHn5pSA8TbSHq8zVxnmyHTxrfF3EfBGfQycLcW";
  const first = mergeWallets([], [{ address: b, tier: "A" }, { address: ` ${b} `, tier: "A", score: 1 }, { address: a, tier: "S" }], "t1");
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((w) => w.address), [a, b]);
  const second = mergeWallets(first, [{ address: b, tier: "S", score: 9 }, { address: b, tier: "S", score: 10 }], "t2");
  assert.equal(second.length, 2);
  const wb = second.find((w) => w.address === b);
  assert.equal(wb.tier, "S"); assert.equal(wb.score, 10);
  assert.equal(wb.firstSeenAt, "t1"); assert.equal(wb.lastSeenAt, "t2");
  assert.equal(gmgnImport(second, "S").length, 2);
});
