import assert from "node:assert/strict";
import { sessionResource } from "../src/lib/sessionResource";

let user: string | null = "alex";
const calls: Array<{
  resolve: (value: string[]) => void;
  reject: (error: Error) => void;
}> = [];
const resource = sessionResource(
  () => user,
  () =>
    new Promise<string[]>((resolve, reject) => calls.push({ resolve, reject })),
);
const first = resource.load();
assert.equal(
  resource.load(true),
  first,
  "Opening should share the warm-up request",
);
assert.equal(calls.length, 1);
calls[0].resolve(["first"]);
await first;
assert.deepEqual(resource.read(), ["first"]);
await resource.load();
assert.equal(
  calls.length,
  1,
  "A fresh prefetch must not issue another request",
);

const refresh = resource.load(true);
assert.deepEqual(
  resource.read(),
  ["first"],
  "The existing inbox must stay available while refreshing",
);
resource.invalidate();
resource.invalidate();
assert.equal(
  resource.load(true),
  refresh,
  "Events must share the pending refresh",
);
calls[1].resolve(["stale"]);
await Promise.resolve();
assert.equal(calls.length, 3, "A burst during a request needs one follow-up");
assert.deepEqual(
  resource.read(),
  ["first"],
  "An outdated response must not overwrite the cache",
);
calls[2].resolve(["fresh"]);
await refresh;
assert.deepEqual(resource.read(), ["fresh"]);

const failing = resource.load(true);
calls[3].reject(new Error("offline"));
await assert.rejects(failing);
assert.deepEqual(
  resource.read(),
  ["fresh"],
  "An outage must retain already loaded entries",
);

const oldAccount = resource.load(true);
user = "sam";
assert.equal(
  resource.read(),
  null,
  "Account changes must clear the previous inbox",
);
const nextAccount = resource.load();
calls[4].resolve(["alex private update"]);
await assert.rejects(oldAccount, /Account changed/);
assert.equal(resource.read(), null);
calls[5].resolve(["sam update"]);
await nextAccount;
resource.update((value) => value.map((v) => `${v} read`));
assert.deepEqual(
  resource.read(),
  ["sam update read"],
  "Successful acknowledgements must survive reopening",
);

const ending = resource.load(true);
resource.clear();
user = null;
calls[6].resolve(["late update"]);
await assert.rejects(ending, /Account changed/);
assert.equal(resource.read(), null);
await assert.rejects(resource.load(), /Signed out/);
console.log(
  "PASS notification cache: warm-up sharing, instant cached reads, burst coalescing, stale response protection, outages, account isolation, read status and sign-out.",
);
