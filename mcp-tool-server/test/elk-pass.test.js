import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutXml } from "../src/elk-pass.js";
import { getElkBridge } from "../src/elk-engine.js";
import { installMxGlobals, MxCell, MxGraphModel, MxGraph } from "../src/mx-model.js";

// The layout tests drive the real drawio-elk bundle (CDN, then the per-user
// cache). Without it there is nothing meaningful to assert, so they skip
// rather than fail on an offline machine.
let bridgeError = null;

try
{
  await getElkBridge();
}
catch (e)
{
  bridgeError = e;
}

const needsElk = bridgeError == null ? {} :
  { skip: "drawio-elk bundle unavailable: " + bridgeError.message };

function cellGeometry(xml, id)
{
  const cell = new RegExp('<mxCell id="' + id +
    '"[^>]*>\\s*<mxGeometry\\b([^>]*)').exec(xml);

  assert.ok(cell != null, "no geometry for cell " + id);

  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;

  while ((m = re.exec(cell[1])) !== null)
  {
    attrs[m[1]] = parseFloat(m[2]);
  }

  return attrs;
}

function overlaps(a, b)
{
  return a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

const FLOW = '<mxGraphModel adaptiveColors="auto"><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="a" value="Start" style="rounded=1;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="b" value="Check" style="rhombus;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="140" height="80" as="geometry"/></mxCell>' +
  '<mxCell id="c" value="End" style="rounded=1;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="40" width="140" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="e1" edge="1" parent="1" source="a" target="b">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="e2" edge="1" parent="1" source="b" target="c">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  "</root></mxGraphModel>";

// ─── No-ops (no ELK bundle needed) ───────────────────────────────

test("content without cells is returned untouched", async function ()
{
  const csvish = "name,type\nFoo,bar";

  assert.equal(await layoutXml(csvish), csvish);
  assert.equal(await layoutXml(""), "");
  assert.equal(await layoutXml(null), null);
});

// ─── Layout ──────────────────────────────────────────────────────

test("stacked vertices are laid out without overlap", needsElk, async function ()
{
  const before = ["a", "b", "c"].map(function (id) { return cellGeometry(FLOW, id); });

  assert.ok(overlaps(before[0], before[1]), "fixture should start overlapping");

  const after = await layoutXml(FLOW);
  const geos = ["a", "b", "c"].map(function (id) { return cellGeometry(after, id); });

  for (let i = 0; i < geos.length; i++)
  {
    for (let j = i + 1; j < geos.length; j++)
    {
      assert.equal(overlaps(geos[i], geos[j]), false,
        "cells " + i + " and " + j + " still overlap");
    }
  }

  // Vertical flow: each step sits below the previous one, same size as authored.
  assert.ok(geos[1].y > geos[0].y);
  assert.ok(geos[2].y > geos[1].y);
  assert.equal(geos[0].width, 140);
  assert.equal(geos[1].height, 80);
});

test("direction horizontal lays the flow out left to right", needsElk, async function ()
{
  const after = await layoutXml(FLOW, { direction: "horizontal" });
  const a = cellGeometry(after, "a");
  const c = cellGeometry(after, "c");

  assert.ok(c.x > a.x, "last step should sit right of the first");
  assert.equal(c.y, a.y);
});

test("edges get waypoints and the canonical orthogonal style", needsElk, async function ()
{
  const after = await layoutXml(FLOW);

  assert.match(after, /<mxCell id="e1"[^>]*edgeStyle=orthogonalEdgeStyle/);
  assert.match(after, /<mxCell id="e1"[\s\S]*?<Array as="points"><mxPoint /);
});

test("laying out twice changes nothing the second time", needsElk, async function ()
{
  const once = await layoutXml(FLOW);
  const twice = await layoutXml(once);

  assert.equal(twice, once);
});

test("cells the layout did not touch stay byte-identical", needsElk, async function ()
{
  const after = await layoutXml(FLOW);

  assert.ok(after.indexOf('<mxGraphModel adaptiveColors="auto">') === 0);
  assert.match(after, /<mxCell id="0"\/><mxCell id="1" parent="0"\/>/);
  // Styles are preserved verbatim on vertices - only edges are restyled.
  assert.match(after, /<mxCell id="b" value="Check" style="rhombus;html=1;"/);
});

test("children stay inside their container, below the title bar",
  needsElk, async function ()
{
  const xml = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
    '<mxCell id="g" value="Group" style="swimlane;html=1;startSize=30;" vertex="1" parent="1">' +
    '<mxGeometry x="40" y="40" width="300" height="200" as="geometry"/></mxCell>' +
    '<mxCell id="x" value="One" style="html=1;" vertex="1" parent="g">' +
    '<mxGeometry x="20" y="50" width="120" height="50" as="geometry"/></mxCell>' +
    '<mxCell id="y" value="Two" style="html=1;" vertex="1" parent="g">' +
    '<mxGeometry x="20" y="50" width="120" height="50" as="geometry"/></mxCell>' +
    '<mxCell id="e" edge="1" parent="g" source="x" target="y">' +
    '<mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";

  const after = await layoutXml(xml);
  const group = cellGeometry(after, "g");
  const x = cellGeometry(after, "x");
  const y = cellGeometry(after, "y");

  // Child geometry is relative to the container: below the 30px title bar,
  // and within the container's (resized) bounds.
  assert.ok(x.y >= 30, "child must clear the title bar, got y=" + x.y);
  assert.ok(x.y + x.height <= group.height);
  assert.ok(y.y + y.height <= group.height);
  assert.equal(overlaps(x, y), false);
});

test("<object>-wrapped cells are laid out by the wrapper's id",
  needsElk, async function ()
{
  const xml = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
    '<object label="One" owner="team" id="s1"><mxCell style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="140" height="60" as="geometry"/></mxCell></object>' +
    '<object label="Two" id="s2"><mxCell style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="140" height="60" as="geometry"/></mxCell></object>' +
    '<mxCell id="e" edge="1" parent="1" source="s1" target="s2">' +
    '<mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";

  const after = await layoutXml(xml);

  // The wrappers (and their metadata attributes) survive, the inner cells move.
  assert.match(after, /<object label="One" owner="team" id="s1">/);
  assert.match(after, /<object label="Two" id="s2">/);

  const geos = [...after.matchAll(/<mxGeometry x="(\d+(?:\.\d+)?)" y="(\d+(?:\.\d+)?)"/g)]
    .map(function (m) { return { x: parseFloat(m[1]), y: parseFloat(m[2]) }; });

  assert.equal(geos.length, 2);
  assert.notDeepEqual(geos[0], geos[1], "both cells are still stacked at 0,0");
});

test("every page of a multi-page file is laid out on its own",
  needsElk, async function ()
{
  const page = function (suffix)
  {
    return "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
      '<mxCell id="a' + suffix + '" value="A" style="html=1;" vertex="1" parent="1">' +
      '<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="b' + suffix + '" value="B" style="html=1;" vertex="1" parent="1">' +
      '<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="e' + suffix + '" edge="1" parent="1" source="a' + suffix +
      '" target="b' + suffix + '"><mxGeometry relative="1" as="geometry"/></mxCell>' +
      "</root></mxGraphModel>";
  };

  const xml = '<mxfile host="app.diagrams.net">' +
    '<diagram id="p1" name="One">' + page(1) + "</diagram>" +
    '<diagram id="p2" name="Two">' + page(2) + "</diagram></mxfile>";

  const after = await layoutXml(xml);

  assert.match(after, /<diagram id="p1" name="One">/);
  assert.match(after, /<diagram id="p2" name="Two">/);

  for (const suffix of [1, 2])
  {
    const a = cellGeometry(after, "a" + suffix);
    const b = cellGeometry(after, "b" + suffix);

    assert.equal(overlaps(a, b), false, "page " + suffix + " still overlaps");
  }
});

test("cells without geometry and dangling edges are handled",
  needsElk, async function ()
{
  const xml = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
    '<mxCell id="a" value="A" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="b" value="B" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="noGeo" value="C" style="html=1;" vertex="1" parent="1"/>' +
    '<mxCell id="e" edge="1" parent="1" source="a" target="b"/>' +
    '<mxCell id="dangling" edge="1" parent="1" source="a" target="ghost">' +
    '<mxGeometry relative="1" as="geometry"/></mxCell>' +
    "</root></mxGraphModel>";

  const after = await layoutXml(xml);

  // The geometry-less cell keeps its exact form - no geometry is invented.
  assert.match(after, /<mxCell id="noGeo" value="C" style="html=1;" vertex="1" parent="1"\/>/);
  // The dangling edge keeps its geometry and gains no waypoints.
  assert.doesNotMatch(after, /<mxCell id="dangling"[\s\S]*?<Array as="points">/);
  assert.equal(overlaps(cellGeometry(after, "a"), cellGeometry(after, "b")), false);
});

test("malformed or empty diagrams come back unchanged", needsElk, async function ()
{
  const truncated = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="x" vertex="1" parent="1">';
  const empty = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    "</root></mxGraphModel>";

  assert.equal(await layoutXml(truncated), truncated);
  assert.equal(await layoutXml(empty), empty);
});

// ─── Headless mxGraph shim ───────────────────────────────────────

function styleOf(style, isEdge)
{
  installMxGlobals();

  const root = new MxCell("0");
  const cell = new MxCell("c", null, style);

  cell.vertex = !isEdge;
  cell.edge = isEdge === true;
  cell.parent = root;
  root.children.push(cell);

  const graph = new MxGraph(new MxGraphModel(root), root);

  return graph.getCellStyle(cell);
}

test("getCellStyle resolves named styles, numbers and none", function ()
{
  // Named style from draw.io's default stylesheet - without it a swimlane
  // would lay out as a plain box.
  assert.equal(styleOf("swimlane;html=1;").shape, "swimlane");
  assert.equal(styleOf("swimlane;html=1;").startSize, 23);
  assert.equal(styleOf("swimlane;startSize=30;").startSize, 30);
  assert.equal(styleOf("rhombus;html=1;").perimeter, "rhombusPerimeter");

  // Numeric values are numbers, as mxStylesheet parses them.
  assert.strictEqual(styleOf("rounded=1;").rounded, 1);
  assert.strictEqual(styleOf("shape=cylinder3;").shape, "cylinder3");

  // "none" deletes the key, a leading ';' drops the defaults.
  assert.equal(styleOf("shape=none;").shape, undefined);
  assert.equal(styleOf(";html=1;").shape, undefined);

  // Defaults come from draw.io's stylesheet, per cell kind.
  assert.equal(styleOf("html=1;").shape, "label");
  assert.equal(styleOf("html=1;", true).shape, "connector");

  // An unknown named style resolves to nothing, like an unknown name in
  // mxStylesheet - and must not reach through to Object.prototype.
  assert.equal(styleOf("notAStyle;html=1;").shape, "label");
  assert.equal(styleOf("constructor;html=1;").shape, "label");
});
