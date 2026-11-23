import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listProfiles, resetProfileListCache } from "../src/model-profiles.js";

test("listProfiles keeps sorted profiles and skips non-profile files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-plist-par-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, data] of [
    ["b.json", { schema: 1, catalogId: "mB", createdAt: "2", tasks: { code: {} } }],
    ["a.json", { schema: 1, catalogId: "mA", createdAt: "1", tasks: { recall: {} } }],
    ["c.json", { schema: 2, catalogId: "mC", createdAt: "3", tasks: {} }],
  ]) await writeFile(path.join(dir, name), JSON.stringify(data));
  resetProfileListCache();
  const profiles = await listProfiles(dir);
  assert.deepEqual(profiles.map((p) => p.catalogId), ["mA", "mB"], "sorted, schema-invalid skipped");
  assert.deepEqual(profiles[0].tasks, ["recall"]);
  await writeFile(path.join(dir, "d.json"), JSON.stringify({ schema: 1, catalogId: "mD", createdAt: "4", tasks: {} }));
  assert.equal((await listProfiles(dir)).length, 3, "a file change refreshes the list");
});
