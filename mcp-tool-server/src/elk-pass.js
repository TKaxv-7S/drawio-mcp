// Server-side ELK layout pass for open_drawio_xml (`postLayout: "elk"`).
//
// The app server runs ELK in the browser against the live mxGraph model of
// the rendered diagram. The tool server has no renderer — it just compresses
// XML into a #create= URL — so here we parse the mxGraphModel XML into the
// headless model from mx-model.js, drive the SAME drawio-elk bridge the
// editor and the app server use (ElkLayout, loaded from the CDN by
// elk-engine.js), and write the resulting geometries and edge styles back
// into the XML before it is compressed.
//
// Parsing is a deliberately small, targeted pass over `<mxCell>` /
// `<mxGeometry>` (draw.io XML is regular and the LLM is asked to emit
// well-formed XML with escaped attribute values), in the same spirit as
// libavoid-pass.js — but it keeps the whole cell tree, because a layout needs
// the parent/child structure and writes back far more than waypoints.
// Anything unexpected -> return the original XML unlaid-out, so a parse
// hiccup never produces a broken diagram.
//
// What the pass does and does not touch:
//   - vertices move (and containers resize around their laid-out children)
//   - edges get ELK's waypoints plus the canonical orthogonal edge style
//   - node sizes are PINNED (applierOptions.resizeParent false): there is no
//     renderer here to measure label text with, so the authored width/height
//     stay authoritative and ELK lays out with them — the same setting the
//     app server uses
//   - every cell the layout didn't change stays byte-identical in the output

import { getElkBridge } from "./elk-engine.js";
import {
  installMxGlobals, MxCell, MxGeometry, MxPoint, MxGraphModel, MxGraph,
} from "./mx-model.js";

// Public `direction` value -> drawio-elk menu preset (ElkLayout.MENU_PRESETS,
// the same names the editor's Arrange > Layout menu and the desktop CLI's
// --layout use). The app server resolves postLayout/direction to exactly
// these two.
const PRESETS = { vertical: "verticalFlow", horizontal: "horizontalFlow" };

// ─── XML parsing ─────────────────────────────────────────────────

// Parse double-quoted attributes from a tag's attribute string into a map.
function parseAttrs(s)
{
  var attrs = {};
  var re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  var m;

  while ((m = re.exec(s)) !== null)
  {
    attrs[m[1]] = m[2];
  }

  return attrs;
}

function unescapeXml(s)
{
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(s)
{
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v, fallback)
{
  var n = parseFloat(v);
  return isNaN(n) ? ((fallback != null) ? fallback : 0) : n;
}

// Trims float noise the applier's own rounding can still leave (-0).
function fmt(n)
{
  var v = Math.round(n * 100) / 100;
  return String(v === 0 ? 0 : v);
}

// Each <mxGraphModel> element is one page and lays out independently. A
// fragment with cells but no mxGraphModel wrapper is treated as one page.
function parseModelBlocks(xml)
{
  var blocks = [];
  var re = /<mxGraphModel\b[^>]*>([\s\S]*?)<\/mxGraphModel>/g;
  var m;

  while ((m = re.exec(xml)) !== null)
  {
    // Offset of the inner text: past the opening tag, before the closing one.
    blocks.push({
      start: m.index + m[0].length - m[1].length - "</mxGraphModel>".length,
      text: m[1],
    });
  }

  if (blocks.length === 0 && xml.indexOf("<mxCell") !== -1)
  {
    blocks.push({ start: 0, text: xml });
  }

  return blocks;
}

// <object>/<UserObject> wrappers carry the id (and the label) of the cell
// they wrap; the inner <mxCell> carries style/parent/terminals.
function parseWrappers(text)
{
  var wrappers = [];
  var re = /<(object|UserObject)\b([^>]*?)>([\s\S]*?)<\/\1>/g;
  var m;

  while ((m = re.exec(text)) !== null)
  {
    wrappers.push({
      start: m.index,
      end: m.index + m[0].length,
      attrs: parseAttrs(m[2]),
    });
  }

  return wrappers;
}

// All <mxCell> blocks (self-closing or with a body), with the offsets needed
// to splice a rebuilt block back into the source text.
function parseCells(text)
{
  var wrappers = parseWrappers(text);
  var cells = [];
  var re = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
  var m;

  while ((m = re.exec(text)) !== null)
  {
    var wrapper = null;

    for (var i = 0; i < wrappers.length; i++)
    {
      if (m.index > wrappers[i].start && m.index < wrappers[i].end)
      {
        wrapper = wrappers[i];
        break;
      }
    }

    var attrs = parseAttrs(m[1]);

    cells.push({
      start: m.index,
      end: m.index + m[0].length,
      rawAttrs: m[1],
      attrs: attrs,
      selfClosing: m[2] === "/>",
      body: m[3] || "",
      id: (attrs.id != null) ? attrs.id :
        ((wrapper != null) ? wrapper.attrs.id : null),
      label: (attrs.value != null) ? attrs.value :
        ((wrapper != null) ? wrapper.attrs.label : null),
    });
  }

  return cells;
}

// The first <mxGeometry> of a cell body, as a live MxGeometry. Unknown
// attributes and child elements ride along so the write-back restores them.
function parseGeometry(body)
{
  var m = /<mxGeometry\b([^>]*?)(\/>|>([\s\S]*?)<\/mxGeometry>)/.exec(body);

  if (m == null) return null;

  var attrs = parseAttrs(m[1]);
  var geo = new MxGeometry(num(attrs.x), num(attrs.y),
    num(attrs.width), num(attrs.height));

  geo.relative = (attrs.relative === "1" || attrs.relative === "true");
  geo.origAttrs = attrs;

  var inner = m[3] || "";
  var pm;

  var pointRe = /<mxPoint\b([^>]*?)\/?>/g;

  while ((pm = pointRe.exec(inner)) !== null)
  {
    var pa = parseAttrs(pm[1]);
    var point = new MxPoint(num(pa.x), num(pa.y));

    if (pa.as === "sourcePoint") geo.sourcePoint = point;
    else if (pa.as === "targetPoint") geo.targetPoint = point;
    else if (pa.as === "offset") geo.offset = point;
  }

  var am = /<Array\b[^>]*as="points"[^>]*>([\s\S]*?)<\/Array>/.exec(inner);

  if (am != null)
  {
    geo.points = [];
    var wpRe = /<mxPoint\b([^>]*?)\/?>/g;
    var wm;

    while ((wm = wpRe.exec(am[1])) !== null)
    {
      var wa = parseAttrs(wm[1]);
      geo.points.push(new MxPoint(num(wa.x), num(wa.y)));
    }
  }

  // Anything else inside the geometry (alternateBounds, …) is preserved
  // verbatim - the layout has no opinion on it.
  geo.extraXml = inner
    .replace(/<Array\b[^>]*as="points"[\s\S]*?<\/Array>/g, "")
    .replace(/<mxPoint\b[^>]*?\/?>/g, "")
    .trim();

  return geo;
}

// ─── Model construction ──────────────────────────────────────────

// Builds the headless model for one page. Returns null when the page has
// nothing to lay out.
function buildModel(cells)
{
  var byId = new Map();
  var i;

  for (i = 0; i < cells.length; i++)
  {
    var c = cells[i];

    if (c.id == null || byId.has(c.id)) continue;

    var cell = new MxCell(c.id,
      (c.label != null) ? unescapeXml(c.label) : null, c.attrs.style || null);

    cell.vertex = c.attrs.vertex === "1";
    cell.edge = c.attrs.edge === "1";
    cell.visible = c.attrs.visible !== "0";
    cell.geometry = parseGeometry(c.body);
    cell.source_ = c.attrs.source;
    cell.target_ = c.attrs.target;
    cell.parent_ = c.attrs.parent;
    cell.block = c;
    c.cell = cell;

    byId.set(c.id, cell);
  }

  // Wire the tree. The root is the cell with no parent attribute (draw.io
  // writes id="0"); its children are the layers.
  var root = null;
  var cellList = Array.from(byId.values());

  for (i = 0; i < cellList.length; i++)
  {
    if (cellList[i].parent_ == null && !cellList[i].vertex && !cellList[i].edge)
    {
      root = cellList[i];
      break;
    }
  }

  if (root == null) return null;

  for (i = 0; i < cellList.length; i++)
  {
    var child = cellList[i];

    if (child === root) continue;

    var parent = byId.get(child.parent_);

    // A dangling parent reference would drop the cell out of the tree
    // (draw.io's codec does the same); keep it on the root's first layer so
    // the layout still sees it.
    if (parent == null) parent = root;

    child.parent = parent;
    parent.children.push(child);
  }

  // Terminals, and the per-vertex edge lists mxGraphModel maintains.
  for (i = 0; i < cellList.length; i++)
  {
    var edge = cellList[i];

    if (!edge.edge) continue;

    edge.source = byId.get(edge.source_) || null;
    edge.target = byId.get(edge.target_) || null;

    if (edge.source != null) edge.source.edges.push(edge);
    if (edge.target != null && edge.target !== edge.source)
    {
      edge.target.edges.push(edge);
    }
  }

  // The layout parent: the first layer holding vertices (mxGraph's
  // defaultParent is the root's first child; a diagram whose content sits on
  // a later layer would otherwise lay out an empty parent).
  var layer = null;

  for (i = 0; i < root.children.length; i++)
  {
    var candidate = root.children[i];
    var vertices = candidate.children.filter(function(c)
    {
      return c.vertex;
    });

    if (vertices.length > 0) { layer = candidate; break; }
  }

  if (layer == null) return null;

  var model = new MxGraphModel(root);

  return new MxGraph(model, layer);
}

// ─── Write-back ──────────────────────────────────────────────────

function serializeGeometry(geo)
{
  var orig = geo.origAttrs || {};
  var attrs = [];
  var seen = { x: 1, y: 1, width: 1, height: 1, relative: 1, as: 1 };

  if (orig.x != null || geo.x !== 0) attrs.push('x="' + fmt(geo.x) + '"');
  if (orig.y != null || geo.y !== 0) attrs.push('y="' + fmt(geo.y) + '"');

  if (orig.width != null || geo.width > 0)
  {
    attrs.push('width="' + fmt(geo.width) + '"');
  }

  if (orig.height != null || geo.height > 0)
  {
    attrs.push('height="' + fmt(geo.height) + '"');
  }

  for (var k in orig)
  {
    if (!seen[k]) attrs.push(k + '="' + orig[k] + '"');
  }

  if (geo.relative) attrs.push('relative="1"');
  attrs.push('as="geometry"');

  var inner = "";

  if (geo.sourcePoint != null)
  {
    inner += '<mxPoint x="' + fmt(geo.sourcePoint.x) + '" y="' +
      fmt(geo.sourcePoint.y) + '" as="sourcePoint" />';
  }

  if (geo.targetPoint != null)
  {
    inner += '<mxPoint x="' + fmt(geo.targetPoint.x) + '" y="' +
      fmt(geo.targetPoint.y) + '" as="targetPoint" />';
  }

  if (geo.points != null && geo.points.length > 0)
  {
    inner += '<Array as="points">';

    for (var i = 0; i < geo.points.length; i++)
    {
      inner += '<mxPoint x="' + fmt(geo.points[i].x) + '" y="' +
        fmt(geo.points[i].y) + '" />';
    }

    inner += "</Array>";
  }

  if (geo.offset != null)
  {
    inner += '<mxPoint x="' + fmt(geo.offset.x) + '" y="' +
      fmt(geo.offset.y) + '" as="offset" />';
  }

  if (geo.extraXml) inner += geo.extraXml;

  return (inner === "")
    ? "<mxGeometry " + attrs.join(" ") + " />"
    : "<mxGeometry " + attrs.join(" ") + ">" + inner + "</mxGeometry>";
}

// Replace the style="..." attribute in a raw attribute string (or append it).
function withStyle(rawAttrs, newStyle)
{
  var escaped = escapeXml(newStyle);

  if (/\bstyle\s*=\s*"/.test(rawAttrs))
  {
    return rawAttrs.replace(/\bstyle\s*=\s*"[^"]*"/, 'style="' + escaped + '"');
  }

  return rawAttrs + ' style="' + escaped + '"';
}

// Rebuild one <mxCell> block from the laid-out cell, preserving everything
// the layout didn't touch.
function buildCellBlock(cell)
{
  var block = cell.block;
  var rawAttrs = block.rawAttrs;

  if (cell.style !== (block.attrs.style || null))
  {
    rawAttrs = withStyle(rawAttrs, cell.style || "");
  }

  if (cell.geometry == null)
  {
    return "<mxCell" + rawAttrs + (block.selfClosing ? "/>" :
      ">" + block.body + "</mxCell>");
  }

  var body = block.body
    .replace(/<mxGeometry\b[^>]*?\/>/g, "")
    .replace(/<mxGeometry\b[\s\S]*?<\/mxGeometry>/g, "");

  return "<mxCell" + rawAttrs + ">" + body + serializeGeometry(cell.geometry) +
    "</mxCell>";
}

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

  installMxGlobals();

  var preset = (bridge.ElkLayout.MENU_PRESETS || {})[PRESETS[direction]];

  if (preset == null) return xml;

  var blocks = parseModelBlocks(xml);
  var out = xml;

  // Back to front, so earlier offsets stay valid while splicing.
  for (var b = blocks.length - 1; b >= 0; b--)
  {
    var laid = layoutBlock(blocks[b].text, bridge, preset);

    if (laid == null) continue;

    out = out.substring(0, blocks[b].start) + laid +
      out.substring(blocks[b].start + blocks[b].text.length);
  }

  return out;
}

// Lays out one page. Returns the rewritten page text, or null when the page
// has nothing to lay out or anything about it is unexpected.
function layoutBlock(text, bridge, preset)
{
  try
  {
    var cells = parseCells(text);
    var graph = buildModel(cells);

    if (graph == null) return null;

    // Canonical edge treatment (strict orthogonalEdgeStyle connectors +
    // rounded corners), shared with the editor's Arrange > Layout default and
    // the app server's postLayout pass — the constants ship with the bundle.
    // resizeParent:false pins the authored node sizes: with no renderer there
    // is nothing to measure label text against, so ELK lays out with the
    // sizes the XML declares instead of growing boxes it can't size reliably
    // (the bridge couples includeVertexLabels to this).
    var elkOptions = { applierOptions: { resizeParent: false } };
    var canonical = bridge.ElkLayout.CANONICAL_EDGE;

    if (canonical != null)
    {
      elkOptions.edgeStyleMode = canonical.edgeStyleMode;
      elkOptions.corners = canonical.corners;
    }

    var layout = new bridge.ElkLayout(graph, preset.algorithm,
      Object.assign({}, preset.options), elkOptions);

    if (!layout.canExecuteSync()) return null;

    layout.executeSync(graph.getDefaultParent());

    var model = graph.getModel();
    var changed = new Set();

    model.changedGeometry.forEach(function(cell) { changed.add(cell); });
    model.changedStyle.forEach(function(cell) { changed.add(cell); });

    if (changed.size === 0) return null;

    // Splice back to front so the recorded offsets stay valid.
    var blocks = Array.from(changed)
      .filter(function(cell) { return cell.block != null; })
      .sort(function(a, b) { return b.block.start - a.block.start; });

    var out = text;

    for (var i = 0; i < blocks.length; i++)
    {
      var block = blocks[i].block;

      out = out.substring(0, block.start) + buildCellBlock(blocks[i]) +
        out.substring(block.end);
    }

    return out;
  }
  catch (e)
  {
    // Never break the diagram - fall back to the page as authored.
    return null;
  }
}
