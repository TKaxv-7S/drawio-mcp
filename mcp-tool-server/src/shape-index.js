// The shape index behind search_shapes, loaded through the same
// ETag-revalidated per-user disk cache as the ELK bundle and the routing core
// (cdn-cache.js): a first call downloads it, later process starts revalidate
// and get a 304, and an unreachable CDN or a malformed download falls back to
// the last cached copy. The parse doubles as the cache's validator, so a
// truncated download is never cached and never returned.

import { loadCachedSource } from "./cdn-cache.js";

/**
 * Parse one candidate source of the index. Throws when it isn't a non-empty
 * array, which is what loadCachedSource needs from a validator.
 *
 * @param {string} src
 * @returns {Array<object>}
 */
export function parseShapeIndex(src)
{
  var index = JSON.parse(src);

  if (!Array.isArray(index) || index.length === 0)
  {
    throw new Error("shape index is not a non-empty array");
  }

  return index;
}

/**
 * The parsed shape index, freshest available (see loadCachedSource).
 * Rejects only when neither the CDN nor the cache can provide a usable copy.
 *
 * @param {{url: string, file: string, timeoutMs?: number}} source - SHAPE_INDEX
 * @returns {Promise<Array<object>>}
 */
export async function loadShapeIndex(source)
{
  // loadCachedSource validates every candidate it considers and may still
  // return an earlier one (a download that fails validation loses to the
  // cached copy), so remember each successful parse and hand back the one
  // matching the returned source rather than parsing ~4.8 MB a second time.
  var parsed = null;
  var parsedSrc = null;

  var src = await loadCachedSource(source, function(candidate)
  {
    var index = parseShapeIndex(candidate);
    parsed = index;
    parsedSrc = candidate;
  });

  return (src === parsedSrc) ? parsed : parseShapeIndex(src);
}
