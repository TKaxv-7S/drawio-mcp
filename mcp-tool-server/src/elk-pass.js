// Server-side ELK layout pass for open_drawio_xml (`postLayout: "elk"`).
//
// The app server runs ELK in the browser against the live mxGraph model of
// the rendered diagram. The tool server has no renderer — it just compresses
// XML into a #create= URL — so here we drive the SAME drawio-elk bridge the
// editor and the app server use (ElkLayout, loaded from the CDN by
// elk-engine.js) against the headless model that shared/mx-xml.js parses out
// of the XML, and let it write the new geometries and edge styles back.
//
// What the pass does and does not touch:
//   - vertices move (and containers resize around their laid-out children)
//   - edges get ELK's waypoints plus the canonical orthogonal edge style
//   - node sizes are PINNED (applierOptions.resizeParent false): there is no
//     renderer here to measure label text with, so the authored width/height
//     stay authoritative and ELK lays out with them — the same setting the
//     app server uses
//   - the cell hierarchy is NOT touched: filing edges at their nearest common
//     ancestor is the normalization pass's job (shared/normalize-model.js),
//     which runs before this pass, not a side effect of laying out
//   - every cell the layout didn't change stays byte-identical in the output

import { getElkBridge } from "./elk-engine.js";

// shared/mx-model.js + shared/mx-xml.js, copied into src/ by copy-shared —
// same local-copy-then-repo import as the other shared helpers, so an in-repo
// run works without the copy. Memoized.
let sharedPromise = null;

function loadShared()
{
  if (!sharedPromise)
  {
    sharedPromise = Promise.all([
      import("./mx-model.js").catch(function()
      {
        return import("../../shared/mx-model.js");
      }),
      import("./mx-xml.js").catch(function()
      {
        return import("../../shared/mx-xml.js");
      }),
    ]).then(function(mods)
    {
      return { model: mods[0], xml: mods[1] };
    });
  }

  return sharedPromise;
}

// Public `direction` value -> drawio-elk menu preset (ElkLayout.MENU_PRESETS,
// the same names the editor's Arrange > Layout menu and the desktop CLI's
// --layout use). The app server resolves postLayout/direction to exactly
// these two.
const PRESETS = { vertical: "verticalFlow", horizontal: "horizontalFlow" };

// ─── Layout ──────────────────────────────────────────────────────

/**
 * Lay out a draw.io XML document with ELK. Every page (`<mxGraphModel>`) is
 * laid out independently. Returns the XML with the new vertex positions and
 * routed edges, or the original XML when there is nothing to lay out.
 * Throws only when the ELK bundle itself can't be loaded — the caller
 * reports that to the LLM instead of silently returning an unlaid-out
 * diagram, since the whole point of the request was the layout.
 *
 * @param {string} xml
 * @param {{direction?: string}} [options] - flow direction, "vertical"
 *   (default) or "horizontal"
 * @returns {Promise<string>}
 */
export async function layoutXml(xml, options)
{
  if (typeof xml !== "string" || xml.indexOf("<mxCell") === -1) return xml;

  var direction = (options != null && options.direction === "horizontal")
    ? "horizontal" : "vertical";

  // Throws when neither the CDN nor the cache can provide the bundle.
  var bridge = await getElkBridge();
  var shared = await loadShared();

  shared.model.installMxGlobals();

  var preset = (bridge.ElkLayout.MENU_PRESETS || {})[PRESETS[direction]];

  if (preset == null) return xml;

  return shared.xml.transformPages(xml, function(graph)
  {
    layoutGraph(graph, bridge, preset);
  }).xml;
}

// Runs ELK over one page's model. Everything it writes is picked up by the
// caller's write-back; a page it can't lay out is left as authored (the
// transform's own error handling).
function layoutGraph(graph, bridge, preset)
{
  // Canonical edge treatment (strict orthogonalEdgeStyle connectors +
  // rounded corners), shared with the editor's Arrange > Layout default and
  // the app server's postLayout pass — the constants ship with the bundle.
  // resizeParent:false pins the authored node sizes: with no renderer there
  // is nothing to measure label text against, so ELK lays out with the sizes
  // the XML declares instead of growing boxes it can't size reliably (the
  // bridge couples includeVertexLabels to this).
  var elkOptions = { applierOptions: { resizeParent: false } };
  var canonical = bridge.ElkLayout.CANONICAL_EDGE;

  if (canonical != null)
  {
    elkOptions.edgeStyleMode = canonical.edgeStyleMode;
    elkOptions.corners = canonical.corners;
  }

  var layout = new bridge.ElkLayout(graph, preset.algorithm,
    Object.assign({}, preset.options), elkOptions);

  if (!layout.canExecuteSync())
  {
    throw new Error("no synchronous ELK engine");
  }

  layout.executeSync(graph.getDefaultParent());
}
