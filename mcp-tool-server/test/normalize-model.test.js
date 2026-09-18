import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDiagram } from "../../shared/normalize-model.js";

// A container tree like the one in jgraph/drawio-mcp#64:
//   layer 1
//     user
//     aws > vpc > { pubsub > alb , privsub > ecs }
// Every edge is parked on the layer, which is what our XML reference asks
// the model for and what draw.io renders correctly.
function fixture(edges)
{
  return '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="user" value="User" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="40" y="220" width="110" height="60" as="geometry"/></mxCell>' +
    '<mxCell id="aws" value="AWS" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="220" y="40" width="600" height="420" as="geometry"/></mxCell>' +
    '<mxCell id="vpc" value="VPC" style="html=1;" vertex="1" parent="aws">' +
    '<mxGeometry x="40" y="70" width="520" height="310" as="geometry"/></mxCell>' +
    '<mxCell id="pubsub" value="Public" style="html=1;" vertex="1" parent="vpc">' +
    '<mxGeometry x="30" y="70" width="210" height="190" as="geometry"/></mxCell>' +
    '<mxCell id="alb" value="ALB" style="html=1;" vertex="1" parent="pubsub">' +
    '<mxGeometry x="35" y="70" width="140" height="55" as="geometry"/></mxCell>' +
    '<mxCell id="privsub" value="Private" style="html=1;" vertex="1" parent="vpc">' +
    '<mxGeometry x="280" y="70" width="210" height="190" as="geometry"/></mxCell>' +
    '<mxCell id="ecs" value="ECS" style="html=1;" vertex="1" parent="privsub">' +
    '<mxGeometry x="35" y="70" width="140" height="55" as="geometry"/></mxCell>' +
    edges + "</root></mxGraphModel>";
}

function edge(id, source, target, parent, body)
{
  return '<mxCell id="' + id + '" style="html=1;" edge="1" parent="' + parent +
    '" source="' + source + '" target="' + target + '">' +
    (body != null ? body : '<mxGeometry relative="1" as="geometry"/>') +
    "</mxCell>";
}

function parentOf(xml, id)
{
  const m = new RegExp('<mxCell id="' + id + '"[^>]*\\bparent="([^"]*)"').exec(xml);

  assert.ok(m != null, "no cell " + id);

  return m[1];
}

test("an edge inside one container moves to that container", function ()
{
  const xml = fixture(edge("e2", "alb", "ecs", "1"));
  const result = normalizeDiagram(xml);

  assert.equal(result.changed, 1);
  assert.equal(parentOf(result.xml, "e2"), "vpc");
});

test("an edge crossing into a container stays on the layer", function ()
{
  const xml = fixture(edge("e1", "user", "alb", "1"));
  const result = normalizeDiagram(xml);

  assert.equal(result.changed, 0);
  assert.equal(result.xml, xml, "nothing to do, nothing rewritten");
});

test("the nearest common ancestor wins, not the outermost", function ()
{
  // Both terminals sit in pubsub -> the edge belongs to pubsub, not vpc.
  const xml = fixture(
    '<mxCell id="alb2" value="ALB2" style="html=1;" vertex="1" parent="pubsub">' +
    '<mxGeometry x="35" y="10" width="140" height="40" as="geometry"/></mxCell>' +
    edge("e", "alb", "alb2", "1"));

  assert.equal(parentOf(normalizeDiagram(xml).xml, "e"), "pubsub");
});

test("a self-loop goes to the parent of its terminal", function ()
{
  const xml = fixture(edge("loop", "alb", "alb", "1"));

  assert.equal(parentOf(normalizeDiagram(xml).xml, "loop"), "pubsub");
});

test("an edge misfiled inside a container moves out, waypoints and all",
  function ()
{
  // Parked on pubsub (origin 220+40+30 = 290 / 40+70+70 = 180) but connecting
  // out to the layer: it belongs on the layer, and its waypoints have to move
  // from pubsub's frame into the layer's.
  const xml = fixture(edge("e", "user", "alb", "pubsub",
    '<mxGeometry relative="1" as="geometry">' +
    '<Array as="points"><mxPoint x="10" y="20"/></Array></mxGeometry>'));

  const out = normalizeDiagram(xml).xml;

  assert.equal(parentOf(out, "e"), "1");
  assert.match(out, /<mxPoint x="300" y="200" \/>/);
});

test("normalizing is idempotent and byte-exact", function ()
{
  const xml = fixture(edge("e2", "alb", "ecs", "1"));
  const once = normalizeDiagram(xml);
  const twice = normalizeDiagram(once.xml);

  assert.equal(twice.changed, 0);
  assert.equal(twice.xml, once.xml);
});

test("only the reparented cell is rewritten", function ()
{
  const xml = fixture(edge("e2", "alb", "ecs", "1"));
  const out = normalizeDiagram(xml).xml;

  // Every other cell survives verbatim, and the edge keeps everything but
  // its parent - including the geometry element the pass had no reason to
  // touch.
  assert.match(out, /<mxCell id="alb" value="ALB" style="html=1;" vertex="1" parent="pubsub">/);
  assert.match(out,
    /<mxCell id="e2" style="html=1;" edge="1" parent="vpc" source="alb" target="ecs"><mxGeometry relative="1" as="geometry"\/><\/mxCell>/);
});

test("an <object>-wrapped edge is filed through its wrapper id", function ()
{
  const xml = fixture(
    '<object label="calls" id="e2"><mxCell style="html=1;" edge="1" parent="1" ' +
    'source="alb" target="ecs"><mxGeometry relative="1" as="geometry"/></mxCell></object>');

  const out = normalizeDiagram(xml).xml;

  assert.match(out, /<object label="calls" id="e2">/);
  assert.match(out, /<mxCell style="html=1;" edge="1" parent="vpc"/);
});

test("top-level edges and edges between layers' children are left alone",
  function ()
{
  const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="a" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>' +
    '<mxCell id="b" style="html=1;" vertex="1" parent="1">' +
    '<mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>' +
    edge("e", "a", "b", "1") + "</root></mxGraphModel>";

  const result = normalizeDiagram(xml);

  assert.equal(result.changed, 0);
  assert.equal(result.xml, xml);
});

test("every page of a multi-page file is normalized", function ()
{
  const page = fixture(edge("e2", "alb", "ecs", "1"));
  const xml = '<mxfile host="app.diagrams.net">' +
    '<diagram id="p1" name="One">' + page + "</diagram>" +
    '<diagram id="p2" name="Two">' + page + "</diagram></mxfile>";

  const result = normalizeDiagram(xml);

  assert.equal(result.changed, 2);
  assert.equal((result.xml.match(/id="e2"[^>]*parent="vpc"/g) || []).length, 2);
  assert.match(result.xml, /<diagram id="p2" name="Two">/);
});

// ─── Edges written without a geometry ────────────────────────────

test("an edge without a geometry gets the standard relative one", function ()
{
  // draw.io renders such an edge not at all - it is a silent loss.
  const xml = fixture('<mxCell id="e" style="html=1;" edge="1" parent="vpc" ' +
    'source="alb" target="ecs"/>');

  const out = normalizeDiagram(xml).xml;

  assert.match(out, /<mxCell id="e"[^>]*><mxGeometry relative="1" as="geometry" \/><\/mxCell>/);
});

test("a geometry-less edge is reparented and given a geometry at once",
  function ()
{
  const xml = fixture('<mxCell id="e" style="html=1;" edge="1" parent="1" ' +
    'source="alb" target="ecs"/>');

  const out = normalizeDiagram(xml).xml;

  assert.equal(parentOf(out, "e"), "vpc");
  assert.match(out, /<mxCell id="e"[^>]*><mxGeometry relative="1" as="geometry" \/><\/mxCell>/);
});

// ─── Containers that clip their children ─────────────────────────

function geometryOf(xml, id)
{
  const m = new RegExp('<mxCell id="' + id +
    '"[^>]*>\\s*<mxGeometry\\b([^>]*)').exec(xml);

  assert.ok(m != null, "no geometry for " + id);

  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let hit;

  while ((hit = re.exec(m[1])) !== null)
  {
    const value = parseFloat(hit[2]);

    if (!isNaN(value)) attrs[hit[1]] = value;
  }

  return attrs;
}

test("a container grows around a child that reaches past it", function ()
{
  // pubsub is 210x190; the child ends at y = 150 + 90 = 240.
  const xml = fixture(
    '<mxCell id="tall" value="Tall" style="html=1;" vertex="1" parent="pubsub">' +
    '<mxGeometry x="10" y="150" width="120" height="90" as="geometry"/></mxCell>');

  const out = normalizeDiagram(xml).xml;
  const geo = geometryOf(out, "pubsub");

  assert.equal(geo.height, 240);
  assert.equal(geo.width, 210, "width was already enough");
  assert.equal(geo.x, 30, "the container is not moved");
  assert.equal(geo.y, 70);
  // The child itself stays exactly where the author put it.
  assert.deepEqual(geometryOf(out, "tall"),
    { x: 10, y: 150, width: 120, height: 90 });
});

test("a container with room to spare is left alone", function ()
{
  const xml = fixture(
    '<mxCell id="small" value="Small" style="html=1;" vertex="1" parent="pubsub">' +
    '<mxGeometry x="10" y="10" width="40" height="20" as="geometry"/></mxCell>');

  const result = normalizeDiagram(xml);

  assert.equal(result.changed, 0, "no shrinking, no rewrite");
  assert.equal(result.xml, xml);
});

test("content that isn't a diagram comes back untouched", function ()
{
  const truncated = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="x" vertex="1" parent="1">';

  assert.equal(normalizeDiagram("name,type\nFoo,bar").xml, "name,type\nFoo,bar");
  assert.equal(normalizeDiagram(truncated).xml, truncated);
  assert.equal(normalizeDiagram("").xml, "");
  assert.equal(normalizeDiagram(null).xml, null);
});
