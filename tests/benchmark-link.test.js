import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../benchmarks/link.mjs";

// bench:link attaches a run to the commit that contains the change. The
// default target stays HEAD-at-link-time; --commit names the feature commit
// explicitly so a link cannot land one commit off.

test("bench:link parseArgs defaults the commit to null and accepts --commit", () => {
  const base = parseArgs(["--uid", "abc"]);
  assert.equal(base.uid, "abc");
  assert.equal(base.commit, null); // HEAD at link time, exactly today's behavior
  assert.equal(parseArgs(["--uid", "abc", "--commit", "e4a126d"]).commit, "e4a126d");
  assert.equal(parseArgs(["--uid", "abc", "--commit=e4a126d"]).commit, "e4a126d");
  assert.equal(parseArgs(["--force"]).force, true); // unchanged flags stay unchanged
});

test("an unknown option is still rejected", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
});
