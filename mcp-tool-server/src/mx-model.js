// Headless mxGraph model for the server-side ELK layout pass.
//
// The drawio-elk bridge (ElkLayout / ElkAdapter / ElkApplier) is written
// against mxGraph: it walks a model, reads resolved cell styles and writes
// geometries and styles back. The editor and the app server hand it a real
// Graph; the tool server has no renderer, so this module provides the slice
// of mxGraph the bridge actually touches — nothing more:
//
//   model   getGeometry/setGeometry, getStyle/setStyle, isVertex/isEdge,
//           isVisible, getChildCount/getChildAt, getParent, getTerminal,
//           getEdgeCount/getEdgeAt/getEdges, beginUpdate/endUpdate
//   graph   getModel, getDefaultParent, getCellStyle, getLabel, resetEdge,
//           isCellMovable
//   globals mxPoint, mxConstants, mxUtils
//
// Deliberately NOT provided: `graph.view` (every bridge call site is guarded
// and falls back to geometry-based sizing, which is what we want — the XML's
// geometry is the authority, there is nothing rendered to measure) and
// `mxUtils.setStyle` (the bridge carries a faithful port and uses it when the
// global is absent, so there is one implementation instead of two).
//
// Style resolution mirrors mxStylesheet.getCellStyle EXACTLY, including its
// quirks — numeric values become numbers, `none` deletes the key — so a
// layout computed here matches what the editor computes for the same
// diagram. Bug-compatible beats better here.

// ─── mxGraph globals ─────────────────────────────────────────────

export function MxPoint(x, y)
{
  this.x = (x != null) ? x : 0;
  this.y = (y != null) ? y : 0;
}

MxPoint.prototype.clone = function()
{
  return new MxPoint(this.x, this.y);
};

// Only the keys the bridge reads. Values are mxConstants verbatim.
const MX_CONSTANTS = {
  NONE: "none",
  DEFAULT_STARTSIZE: 40,
  DEFAULT_FONTSIZE: 12,
  EDGESTYLE_ORTHOGONAL: "orthogonalEdgeStyle",
  SHAPE_RECTANGLE: "rectangle",
  SHAPE_CONNECTOR: "connector",
  STYLE_SHAPE: "shape",
  STYLE_PERIMETER: "perimeter",
  STYLE_EDGE: "edgeStyle",
  STYLE_CURVED: "curved",
  STYLE_ROUNDED: "rounded",
  STYLE_ORTHOGONAL: "orthogonal",
  STYLE_NOEDGESTYLE: "noEdgeStyle",
  STYLE_STARTSIZE: "startSize",
  STYLE_EXIT_X: "exitX",
  STYLE_EXIT_Y: "exitY",
  STYLE_ENTRY_X: "entryX",
  STYLE_ENTRY_Y: "entryY",
  STYLE_FONTSIZE: "fontSize",
  STYLE_FONTFAMILY: "fontFamily",
  STYLE_FONTSTYLE: "fontStyle",
  STYLE_ALIGN: "align",
  STYLE_VERTICAL_ALIGN: "verticalAlign",
  STYLE_LABEL_POSITION: "labelPosition",
  STYLE_VERTICAL_LABEL_POSITION: "verticalLabelPosition",
};

// mxUtils.isNumeric verbatim - decides which style values become numbers.
function isNumeric(n)
{
  return !isNaN(parseFloat(n)) && isFinite(n) &&
    (typeof n !== "string" || n.toLowerCase().indexOf("x") < 0);
}

function clone(obj)
{
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(clone);
  if (typeof obj.clone === "function") return obj.clone();

  var copy = {};

  for (var k in obj)
  {
    copy[k] = clone(obj[k]);
  }

  return copy;
}

// Estimated text bounds, in place of mxUtils.getSizeForString (which measures
// a rendered DOM node). Used by the adapter only to reserve room for labels,
// so an estimate is enough - but a better one than the bridge's own fallback
// (7px per character, one line, font size ignored), which is what runs when
// this is absent. Average glyph advance of the draw.io default font is close
// to 0.6em; line breaks and <br> count as lines.
function getSizeForString(text, fontSize, fontFamily, textWidth, fontStyle)
{
  var size = (fontSize != null && !isNaN(fontSize)) ?
    fontSize : MX_CONSTANTS.DEFAULT_FONTSIZE;
  var bold = (fontStyle != null && (parseInt(fontStyle) & 1) === 1);
  var lines = String(text == null ? "" : text).split(/<br\s*\/?>|\n/);
  var longest = 0;

  for (var i = 0; i < lines.length; i++)
  {
    longest = Math.max(longest, lines[i].replace(/<[^>]*>/g, "").length);
  }

  return {
    width: Math.ceil(longest * size * (bold ? 0.64 : 0.6)),
    height: Math.ceil(lines.length * size * 1.2),
  };
}

/**
 * Installs the mxGraph globals the drawio-elk bridge reads at runtime. Safe
 * to call repeatedly; existing globals (a real mxGraph, or a previous call)
 * are left alone.
 */
export function installMxGlobals()
{
  if (globalThis.mxPoint == null) globalThis.mxPoint = MxPoint;
  if (globalThis.mxConstants == null) globalThis.mxConstants = MX_CONSTANTS;

  if (globalThis.mxUtils == null)
  {
    globalThis.mxUtils = { clone: clone, getSizeForString: getSizeForString };
  }
}

// ─── Model ───────────────────────────────────────────────────────

export function MxGeometry(x, y, width, height)
{
  this.x = (x != null) ? x : 0;
  this.y = (y != null) ? y : 0;
  this.width = (width != null) ? width : 0;
  this.height = (height != null) ? height : 0;
  this.relative = false;
  this.points = null;
  this.offset = null;
  this.sourcePoint = null;
  this.targetPoint = null;
}

MxGeometry.prototype.clone = function()
{
  var geo = new MxGeometry(this.x, this.y, this.width, this.height);

  geo.relative = this.relative;
  geo.offset = (this.offset != null) ? this.offset.clone() : null;
  geo.sourcePoint = (this.sourcePoint != null) ? this.sourcePoint.clone() : null;
  geo.targetPoint = (this.targetPoint != null) ? this.targetPoint.clone() : null;
  geo.points = (this.points != null) ? this.points.map(function(p)
  {
    return p.clone();
  }) : null;
  // The source element's attributes and any child elements this pass doesn't
  // model (alternateBounds, …) ride along untouched, so the write-back can
  // restore them verbatim on a geometry the bridge cloned.
  geo.origAttrs = this.origAttrs;
  geo.extraXml = this.extraXml;

  return geo;
};

MxGeometry.prototype.getTerminalPoint = function(isSource)
{
  return isSource ? this.sourcePoint : this.targetPoint;
};

MxGeometry.prototype.setTerminalPoint = function(point, isSource)
{
  if (isSource) this.sourcePoint = point;
  else this.targetPoint = point;

  return point;
};

export function MxCell(id, value, style)
{
  this.id = id;
  this.value = (value != null) ? value : null;
  this.style = (style != null) ? style : null;
  this.vertex = false;
  this.edge = false;
  this.visible = true;
  this.parent = null;
  this.children = [];
  this.edges = [];
  this.source = null;
  this.target = null;
  this.geometry = null;
}

export function MxGraphModel(root)
{
  this.root = root;
  this.updateLevel = 0;
  // Cells whose geometry or style the layout changed - the write-back only
  // touches these, so everything else stays byte-identical in the XML.
  this.changedGeometry = new Set();
  this.changedStyle = new Set();
}

MxGraphModel.prototype.getGeometry = function(cell)
{
  return (cell != null) ? cell.geometry : null;
};

MxGraphModel.prototype.setGeometry = function(cell, geometry)
{
  if (cell != null)
  {
    cell.geometry = geometry;
    this.changedGeometry.add(cell);
  }

  return geometry;
};

MxGraphModel.prototype.getStyle = function(cell)
{
  return (cell != null) ? cell.style : null;
};

MxGraphModel.prototype.setStyle = function(cell, style)
{
  if (cell != null && cell.style !== style)
  {
    cell.style = style;
    this.changedStyle.add(cell);
  }

  return style;
};

MxGraphModel.prototype.isVertex = function(cell)
{
  return cell != null && cell.vertex === true;
};

MxGraphModel.prototype.isEdge = function(cell)
{
  return cell != null && cell.edge === true;
};

MxGraphModel.prototype.isVisible = function(cell)
{
  return cell != null && cell.visible !== false;
};

MxGraphModel.prototype.getChildCount = function(cell)
{
  return (cell != null && cell.children != null) ? cell.children.length : 0;
};

MxGraphModel.prototype.getChildAt = function(cell, index)
{
  return (cell != null && cell.children != null) ? cell.children[index] : null;
};

MxGraphModel.prototype.getParent = function(cell)
{
  return (cell != null) ? cell.parent : null;
};

MxGraphModel.prototype.getTerminal = function(edge, isSource)
{
  if (edge == null) return null;

  return isSource ? edge.source : edge.target;
};

MxGraphModel.prototype.getEdgeCount = function(cell)
{
  return (cell != null && cell.edges != null) ? cell.edges.length : 0;
};

MxGraphModel.prototype.getEdgeAt = function(cell, index)
{
  return (cell != null && cell.edges != null) ? cell.edges[index] : null;
};

// mxGraphModel.getEdges(cell, incoming, outgoing, includeLoops)
MxGraphModel.prototype.getEdges = function(cell, incoming, outgoing, includeLoops)
{
  incoming = (incoming != null) ? incoming : true;
  outgoing = (outgoing != null) ? outgoing : true;
  includeLoops = (includeLoops != null) ? includeLoops : true;

  var result = [];
  var count = this.getEdgeCount(cell);

  for (var i = 0; i < count; i++)
  {
    var edge = this.getEdgeAt(cell, i);
    var source = this.getTerminal(edge, true);
    var target = this.getTerminal(edge, false);

    if ((includeLoops && source === target) ||
      ((source !== target) && ((incoming && target === cell) ||
        (outgoing && source === cell))))
    {
      result.push(edge);
    }
  }

  return result;
};

// No events, no undo history: the bridge brackets its writes in these, and
// the write-back reads the finished model.
MxGraphModel.prototype.beginUpdate = function()
{
  this.updateLevel++;
};

MxGraphModel.prototype.endUpdate = function()
{
  this.updateLevel--;
};

// ─── Graph ───────────────────────────────────────────────────────

// draw.io's default stylesheet, reduced to the keys the bridge reads:
// `styles/default.xml` in drawio-dev, the same table the editor and the
// viewer (and therefore the app server's postLayout) resolve styles against.
// A style token without '=' is a named style - `swimlane;startSize=30;`
// resolves shape=swimlane through this map, and without it a swimlane would
// lay out as a plain box and its children would land under the title bar.
// Numbers are stored as numbers, matching mxStylesheetCodec's parseFloat.
const NAMED_STYLES = {
  defaultVertex: { shape: "label", perimeter: "rectanglePerimeter",
    fontSize: 12, fontFamily: "Helvetica" },
  defaultEdge: { shape: "connector", fontSize: 11, fontFamily: "Helvetica",
    rounded: 1 },
  edgeLabel: { fontSize: 11 },
  label: { fontStyle: 1, rounded: 1 },
  icon: { fontStyle: 0, rounded: 1, verticalLabelPosition: "bottom" },
  swimlane: { shape: "swimlane", fontSize: 12, fontStyle: 1, startSize: 23 },
  ellipse: { shape: "ellipse", perimeter: "ellipsePerimeter" },
  rhombus: { shape: "rhombus", perimeter: "rhombusPerimeter" },
  triangle: { shape: "triangle", perimeter: "trianglePerimeter" },
  line: { shape: "line" },
  image: { shape: "image", verticalLabelPosition: "bottom" },
  roundImage: { shape: "image", verticalLabelPosition: "bottom",
    perimeter: "ellipsePerimeter" },
  rhombusImage: { shape: "image", verticalLabelPosition: "bottom",
    perimeter: "rhombusPerimeter" },
  arrow: { shape: "arrow", edgeStyle: "none" },
  group: {},
  text: {},
};

export function MxGraph(model, defaultParent)
{
  this.model = model;
  this.defaultParent = defaultParent;
  this._styleCache = new Map();
}

MxGraph.prototype.getModel = function()
{
  return this.model;
};

MxGraph.prototype.getDefaultParent = function()
{
  return this.defaultParent;
};

/**
 * mxStylesheet.getCellStyle over the cell's style string: draw.io's default
 * vertex/edge style as the base, named styles merged in, `key=value` pairs
 * on top - numeric values parsed to numbers, `none` deleting the key. A
 * named style this table doesn't carry resolves to nothing, exactly as an
 * unknown name does in mxStylesheet.
 */
MxGraph.prototype.getCellStyle = function(cell)
{
  if (cell == null) return {};

  var name = this.model.getStyle(cell);
  var isEdge = this.model.isEdge(cell);
  var key = (isEdge ? "e:" : "v:") + (name || "");
  var cached = this._styleCache.get(key);

  if (cached != null) return cached;

  var style = {};
  var base = isEdge ? NAMED_STYLES.defaultEdge : NAMED_STYLES.defaultVertex;
  var k;

  // A leading ';' means "ignore the defaults" in mxStylesheet.
  if (name == null || name.length === 0 || name.charAt(0) !== ";")
  {
    for (k in base) style[k] = base[k];
  }

  var pairs = (name || "").split(";");

  for (var i = 0; i < pairs.length; i++)
  {
    var pos = pairs[i].indexOf("=");

    if (pos < 0)
    {
      var named = Object.prototype.hasOwnProperty.call(NAMED_STYLES, pairs[i])
        ? NAMED_STYLES[pairs[i]] : null;

      if (named != null)
      {
        for (k in named) style[k] = named[k];
      }

      continue;
    }

    var sKey = pairs[i].substring(0, pos);
    var value = pairs[i].substring(pos + 1);

    if (value === MX_CONSTANTS.NONE) delete style[sKey];
    else if (isNumeric(value)) style[sKey] = parseFloat(value);
    else style[sKey] = value;
  }

  this._styleCache.set(key, style);

  return style;
};

// The cell's label. `value` is always a plain string here: a cell wrapped in
// an <object>/<UserObject> element (draw.io's metadata form) carries its text
// in that element's label attribute, and the parser stores it on the cell.
MxGraph.prototype.getLabel = function(cell)
{
  if (cell == null || typeof cell.value !== "string") return "";

  return cell.value;
};

// mxGraph.resetEdge - drops the waypoints so the router re-computes them.
MxGraph.prototype.resetEdge = function(cell)
{
  var geo = this.model.getGeometry(cell);

  if (geo != null && geo.points != null && geo.points.length > 0)
  {
    geo = geo.clone();
    geo.points = [];
    this.model.setGeometry(cell, geo);
  }

  return cell;
};

// No locked cells server-side: every vertex is free to move.
MxGraph.prototype.isCellMovable = function()
{
  return true;
};
