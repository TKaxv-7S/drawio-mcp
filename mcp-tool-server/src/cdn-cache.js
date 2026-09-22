// Local cache for browser sources loaded from the draw.io CDN, with
// revalidation.
//
// Two artifacts ship with draw.io releases on the viewer.diagrams.net CDN and
// are consumed here verbatim: the shared libavoid routing core (the edge
// router behind `routing: "libavoid"`) and the drawio-elk bundle (the ELK
// engine + mxGraph bridge behind `postLayout: "elk"`) — the same files the
// app server loads with a <script src> and the editor bundles. The third
// source is this repository's own shape-search/search-index.json (behind
// `search_shapes`), served by jsDelivr straight from the main branch.
// loadCachedSource() keeps a per-user copy of one on disk and revalidates it
// with a conditional GET (If-None-Match against the stored ETag) once per
// call:
//
//   200 -> validate the download, atomically update the cache, use it
//   304 -> use the cached copy (no download)
//   fetch error / timeout / non-OK -> use the cached copy if present
//   nothing cached and the fetch failed -> throw (the caller falls back to
//   the vendored copy, or reports the pass as unavailable)
//
// npm's postinstall primes the routing core (src/postinstall.js) so the first
// routing call doesn't pay the download; offline and --ignore-scripts
// installs simply prime it on first use instead. The ELK bundle is ~900 KB
// and only needed when a layout is actually requested, so it is NOT primed —
// it downloads once on the first layout call and is cached from then on.
// Each source and its ETag live in ONE JSON artifact updated by a single
// atomic rename, so concurrent processes can never pair one version's body
// with another's ETag. A cached copy that fails validation is discarded and
// refetched in full.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

const DEFAULT_TIMEOUT_MS = 5000;

// The cached sources. `file` holds BOTH the body and its ETag, so the pair is
// updated by a single atomic rename — separate files could be torn by two
// processes racing across a release boundary (old body paired with the new
// ETag 304s against a stale source until the NEXT release).
export const ROUTING_CORE = {
  url: "https://viewer.diagrams.net/js/libavoid-js/libavoid-routing.js",
  file: "libavoid-routing.json",
};

export const ELK_BUNDLE = {
  // Overridable for testing a drawio-elk build before it ships on the CDN:
  // an http(s) URL is fetched (and cached), any other value is read as a
  // local file path (never cached — a local build changes under us).
  url: process.env.DRAWIO_ELK_URL ||
    "https://viewer.diagrams.net/js/elk/drawio-elk.min.js",
  file: "drawio-elk.json",
  // ~900 KB, downloaded once per release - more headroom than the tiny
  // routing core needs.
  timeoutMs: 20000,
};

export const SHAPE_INDEX = {
  // Overridable with DRAWIO_SHAPE_INDEX_URL, same rules as DRAWIO_ELK_URL: an
  // http(s) URL is fetched (and cached), any other value is a local file path.
  url: process.env.DRAWIO_SHAPE_INDEX_URL ||
    "https://cdn.jsdelivr.net/gh/jgraph/drawio-mcp@main/shape-search/search-index.json",
  file: "shape-index.json",
  // ~4.8 MB of JSON, ~400 KB brotli on the wire, refreshed with every draw.io
  // release. Five times the ELK bundle: on a 100 KB/s link the transfer
  // alone takes ~4 s, so the routing core's 5 s default would fail exactly
  // the users on slow links, and keep failing on every retry.
  timeoutMs: 20000,
};

// ~/Library/Caches on macOS, XDG on Linux, LOCALAPPDATA on Windows. XDG
// wins everywhere when set (also makes the cache relocatable in tests).
export function cacheDir()
{
  var base;

  if (process.env.XDG_CACHE_HOME)
  {
    base = process.env.XDG_CACHE_HOME;
  }
  else if (platform() === "darwin")
  {
    base = join(homedir(), "Library", "Caches");
  }
  else if (platform() === "win32")
  {
    base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  else
  {
    base = join(homedir(), ".cache");
  }

  return join(base, "drawio-mcp");
}

function readCached(source)
{
  try
  {
    var entry = JSON.parse(readFileSync(join(cacheDir(), source.file), "utf8"));

    if (typeof entry.src !== "string")
    {
      return null;
    }

    return { src: entry.src,
      etag: (typeof entry.etag === "string" && entry.etag !== "") ? entry.etag : null };
  }
  catch (e)
  {
    return null;
  }
}

function writeCache(source, src, etag)
{
  var dir = cacheDir();
  mkdirSync(dir, { recursive: true });

  // Atomic against concurrent processes: write a temp file, then rename.
  var tmp = join(dir, source.file + "." + process.pid + ".tmp");
  writeFileSync(tmp, JSON.stringify({ etag: etag, src: src }));

  try
  {
    renameSync(tmp, join(dir, source.file));
  }
  catch (e)
  {
    // Don't orphan the temp file (e.g. Windows EPERM on a held target).
    try { rmSync(tmp); } catch (e2) {}
    throw e;
  }
}

function dropCache(source)
{
  try { rmSync(join(cacheDir(), source.file)); } catch (e) {}
}

/**
 * The source of one CDN artifact, freshest available: CDN-revalidated cache,
 * then plain cache, else throws. A non-http(s) `source.url` is read straight
 * off disk (local dev build) and never cached. `validate(src)` must throw
 * when the source is unusable - a rejected download is neither cached nor
 * returned, and a cached copy that fails validation is discarded and
 * refetched in full.
 *
 * @param {{url: string, file: string, timeoutMs?: number}} source - ROUTING_CORE, ELK_BUNDLE or SHAPE_INDEX
 * @param {function(string)} validate
 * @returns {Promise<string>}
 */
export async function loadCachedSource(source, validate)
{
  if (!/^https?:\/\//i.test(source.url))
  {
    var local = readFileSync(source.url, "utf8");
    validate(local);
    return local;
  }

  var cached = readCached(source);

  if (cached != null)
  {
    try
    {
      validate(cached.src);
    }
    catch (e)
    {
      dropCache(source);
      cached = null;
    }
  }

  var headers = {};

  if (cached != null && cached.etag != null)
  {
    headers["If-None-Match"] = cached.etag;
  }

  try
  {
    var res = await fetch(source.url,
      { headers: headers,
        signal: AbortSignal.timeout(source.timeoutMs || DEFAULT_TIMEOUT_MS) });

    if (res.status === 304 && cached != null)
    {
      return cached.src;
    }

    if (res.ok)
    {
      var src = await res.text();
      validate(src);

      try
      {
        writeCache(source, src, res.headers.get("etag"));
      }
      catch (e)
      {
        // Read-only cache dir - the download is still usable this process.
      }

      return src;
    }

    throw new Error("HTTP " + res.status);
  }
  catch (e)
  {
    if (cached != null)
    {
      return cached.src;
    }

    throw e;
  }
}
