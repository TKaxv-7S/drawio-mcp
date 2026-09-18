import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const postinstall = new URL("../src/postinstall.js", import.meta.url).href;

for (const offline of [false, true])
{
  test(`postinstall drains pending work after ${offline ? "failed" : "successful"} fetch`, function ()
  {
    // A real child process verifies natural shutdown without relying on the
    // timing-dependent Windows crash or an external CDN. The pending callback
    // is lost if postinstall forces process.exit(), on either fetch path.
    const script = `
      globalThis.fetch = async function ()
      {
        setTimeout(() => process.stdout.write("drained"), 50);
        if (${offline}) throw new Error("offline");
        return {
          ok: true,
          text: async () => "AvoidRouting",
          headers: { get: () => null }
        };
      };
      await import(${JSON.stringify(postinstall)});
    `;
    const cache = mkdtempSync(join(tmpdir(), "drawio-postinstall-"));
    try
    {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script],
        { encoding: "utf8", timeout: 10000,
          env: { ...process.env, XDG_CACHE_HOME: cache } });

      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "drained");
    }
    finally
    {
      rmSync(cache, { recursive: true, force: true });
    }
  });
}
