/**
 * A bounded lane pool for the gate's independent model measurements.
 *
 * Each lane claims the next unmeasured model, so the pool only bounds
 * concurrency: results keep input order (not completion order), a worker's
 * rejection rejects the whole pool, and the width is clamped to the item
 * count so a single model never spins up extra lanes. Model measurement
 * itself stays untouched: every model keeps its own engine, its own recorded
 * load config and its own cache write.
 */
export async function runPool(items, worker, width = 1) {
  const list = Array.from(items);
  const lanes = Math.max(1, Math.min(Number(width) || 1, list.length));
  const results = new Array(list.length);
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
