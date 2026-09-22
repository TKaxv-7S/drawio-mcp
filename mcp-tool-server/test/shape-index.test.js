import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadShapeIndex, parseShapeIndex } from "../src/shape-index.js";
import { cacheDir } from "../src/cdn-cache.js";

// The shape index goes through cdn-cache.js like the ELK bundle. These tests
// stand in a local HTTP server for the CDN and switch its behaviour per test:
// a normal 200/304 cycle, a stalled response the timeout must cut off, and a
// truncated body the validator must reject.

const INDEX = [
  { style: "rounded=0;", w: 120, h: 60, title: "Rectangle", tags: "rect box", type: "vertex" },
];
const BODY = JSON.stringify(INDEX);

let mode = "ok";
let requests = [];
let server;
let base;
let cache;

before(function(t, done)
{
  server = createServer(function(req, res)
  {
    requests.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"] || null });

    if (mode === "stall")
    {
      // Never answers - only the client timeout ends this request.
      return;
    }

    if (mode === "truncated")
    {
      res.writeHead(200, { "content-type": "application/json", etag: '"v2"' });
      res.end(BODY.slice(0, 10));
      return;
    }

    if (req.headers["if-none-match"] === '"v1"')
    {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
    res.end(BODY);
  });

  server.listen(0, "127.0.0.1", function()
  {
    base = "http://127.0.0.1:" + server.address().port;
    done();
  });
});

after(function()
{
  server.closeAllConnections();
  server.close();

  if (cache != null)
  {
    rmSync(cache, { recursive: true, force: true });
  }
});

// Every test starts from an empty per-user cache and a quiet server.
beforeEach(function()
{
  if (cache != null)
  {
    rmSync(cache, { recursive: true, force: true });
  }

  cache = mkdtempSync(join(tmpdir(), "drawio-shape-index-"));
  process.env.XDG_CACHE_HOME = cache;
  mode = "ok";
  requests = [];
});

function source(overrides)
{
  return Object.assign(
    { url: base + "/search-index.json", file: "test-shape-index.json", timeoutMs: 300 },
    overrides);
}

function cachedEntry()
{
  return JSON.parse(readFileSync(join(cacheDir(), "test-shape-index.json"), "utf8"));
}

test("downloads, parses and caches the index on first use", async function()
{
  const index = await loadShapeIndex(source());

  assert.deepEqual(index, INDEX);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ifNoneMatch, null);
  assert.equal(cachedEntry().etag, '"v1"');
  assert.equal(cachedEntry().src, BODY);
});

test("revalidates with If-None-Match and reuses the cached copy on 304", async function()
{
  await loadShapeIndex(source());
  requests = [];

  const index = await loadShapeIndex(source());

  assert.deepEqual(index, INDEX);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].ifNoneMatch, '"v1"');
});

test("falls back to the cached copy when the CDN stalls past the timeout", async function()
{
  await loadShapeIndex(source());
  mode = "stall";
  const started = Date.now();

  const index = await loadShapeIndex(source());

  assert.deepEqual(index, INDEX);
  assert.ok(Date.now() - started >= 250, "returned before the timeout elapsed");
  assert.ok(Date.now() - started < 5000, "did not return promptly after the timeout");
});

test("rejects when the CDN stalls and nothing is cached yet", async function()
{
  mode = "stall";

  await assert.rejects(loadShapeIndex(source()), function(e)
  {
    return e.name === "TimeoutError" || e.name === "AbortError";
  });
  assert.equal(existsSync(join(cacheDir(), "test-shape-index.json")), false);
});

test("keeps the cached copy when a fresh download is truncated", async function()
{
  await loadShapeIndex(source());
  mode = "truncated";

  const index = await loadShapeIndex(source());

  assert.deepEqual(index, INDEX);
  assert.equal(cachedEntry().etag, '"v1"', "a rejected download must not replace the cache");
});

test("never caches a truncated first download", async function()
{
  mode = "truncated";

  await assert.rejects(loadShapeIndex(source()), SyntaxError);
  assert.equal(existsSync(join(cacheDir(), "test-shape-index.json")), false);
});

test("reads a local path source straight off disk without caching", async function()
{
  const file = join(cache, "local-index.json");
  writeFileSync(file, BODY);

  const index = await loadShapeIndex({ url: file, file: "test-shape-index.json" });

  assert.deepEqual(index, INDEX);
  assert.equal(requests.length, 0);
  assert.equal(existsSync(join(cacheDir(), "test-shape-index.json")), false);
});

test("parseShapeIndex rejects anything but a non-empty array", function()
{
  assert.deepEqual(parseShapeIndex(BODY), INDEX);
  assert.throws(function() { parseShapeIndex("{}"); });
  assert.throws(function() { parseShapeIndex("[]"); });
  assert.throws(function() { parseShapeIndex("[{"); }, SyntaxError);
});
