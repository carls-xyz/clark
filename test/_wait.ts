import assert from "node:assert/strict";

/** Attend une condition plutôt qu'une durée fixe : une machine chargée ne fait pas échouer le test. */
export const waitFor = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition jamais atteinte");
};
