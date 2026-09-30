import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { routeXml } from "../src/libavoid-pass.js";
import { ROUTING_CORE } from "../src/cdn-cache.js";

// Route with the vendored core instead of the CDN / per-user cache, so the
// tests run offline and against a known routing core. The wasm is vendored.
ROUTING_CORE.url = fileURLToPath(
  new URL("../vendor/libavoid/libavoid-routing.js", import.meta.url));

// Source and target side by side at height y, a tall obstacle between them.
function vertex(id, x, y, w, h)
{
  return '<mxCell id="' + id + '" value="' + id + '" vertex="1" parent="1">' +
    '<mxGeometry x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
    '" as="geometry"/></mxCell>';
}

const EDGE = '<mxCell id="edge" edge="1" parent="1" source="source" ' +
  'target="target" style="exitX=1;exitY=0.5;entryX=0;entryY=0.5;">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>';

function root(cells)
{
  return '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' + cells +
    "</root>";
}

function scene(y)
{
  return '<mxGraphModel adaptiveColors="auto">' + root(
    vertex("source", 20, y, 100, 60) +
    vertex("target", 500, y, 100, 60) +
    vertex("obstacle", 250, y - 30, 120, 120) + EDGE) + "</mxGraphModel>";
}

function mxfile(first, second)
{
  return '<mxfile host="test">\n' +
    '<diagram id="first" name="A &amp; B">' + first + "</diagram>\n" +
    '<diagram id="second" name="Second">' + second + "</diagram>\n" +
    "</mxfile>";
}

// The waypoints written onto an edge, as [x, y] pairs.
function points(xml, id)
{
  const start = xml.indexOf('<mxCell id="' + id + '"');
  const cell = xml.substring(start, xml.indexOf("</mxCell>", start));
  const array = /<Array as="points">([\s\S]*?)<\/Array>/.exec(cell);

  assert.ok(array != null, "edge " + id + " has no waypoints");

  return [...array[1].matchAll(/<mxPoint x="([^"]*)" y="([^"]*)"/g)]
    .map(function (m) { return [Number(m[1]), Number(m[2])]; });
}

// ─── No-ops ──────────────────────────────────────────────────────

test("content without edges is returned untouched", async function ()
{
  const inputs = [null, "", "name,type\nFoo,bar",
    "<mxGraphModel>" + root(vertex("a", 0, 0, 80, 40)) + "</mxGraphModel>"];

  for (const input of inputs)
  {
    assert.equal(await routeXml(input), input);
  }
});

// ─── Routing ─────────────────────────────────────────────────────

test("the connector detours around the obstacle, vertices stay put",
  async function ()
{
  const before = scene(100);
  const after = await routeXml(before);

  for (const v of before.match(/<mxCell id="(source|target|obstacle)"[\s\S]*?<\/mxCell>/g))
  {
    assert.ok(after.includes(v), "a vertex changed during edge routing");
  }

  assert.match(after, /<mxCell id="edge"[^>]*edgeStyle=orthogonalEdgeStyle;[^>]*libavoidRouting=1;/);

  // Source port -> waypoints -> target port, every segment orthogonal and
  // clear of the obstacle (250..370 x 70..190).
  const route = [[120, 130], ...points(after, "edge"), [500, 130]];

  assert.ok(route.length > 3, "no detour");

  for (let i = 1; i < route.length; i++)
  {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];

    assert.ok(ax === bx || ay === by, "segment " + i + " is not orthogonal");
    assert.ok(Math.max(ax, bx) <= 250 || Math.min(ax, bx) >= 370 ||
      Math.max(ay, by) <= 70 || Math.min(ay, by) >= 190,
      "segment " + i + " crosses the obstacle");
  }
});

test("an edge label's offset survives routing", async function ()
{
  const xml = scene(100).replace('<mxGeometry relative="1" as="geometry"/>',
    '<mxGeometry x="-0.5" y="10" relative="1" as="geometry">' +
    '<mxPoint x="5" y="-5" as="offset"/></mxGeometry>');
  const after = await routeXml(xml);

  assert.match(after, /<mxGeometry x="-0.5" y="10" relative="1" as="geometry"><Array as="points">/);
  assert.match(after, /<mxPoint x="5" y="-5" as="offset" \/><\/mxGeometry>/);
});

test("entities in a routed edge's style are written back escaped once",
  async function ()
{
  const xml = scene(100).replace('entryY=0.5;"', 'entryY=0.5;fontFamily=A &amp; B;"');
  const after = await routeXml(xml);

  assert.match(after, /<mxCell id="edge"[^>]*style="exitX=1;exitY=0.5;entryX=0;entryY=0.5;fontFamily=A &amp; B;edgeStyle=orthogonalEdgeStyle;/);
  assert.ok(!after.includes("&amp;amp;"), "the style was escaped twice");
  assert.deepEqual(points(after, "edge"), points(await routeXml(scene(100)), "edge"));
});

// ─── Pages (#73) ─────────────────────────────────────────────────

test("pages reusing cell ids route exactly as they do alone", async function ()
{
  const first = scene(100);
  const second = scene(500);

  assert.equal(await routeXml(mxfile(first, second)),
    mxfile(await routeXml(first), await routeXml(second)));
});

test("a shape on another page is not an obstacle", async function ()
{
  const first = scene(100);
  // Straddles the route the first page's edge takes around its obstacle.
  const second = "<mxGraphModel>" +
    root(vertex("foreign", 160, 190, 320, 40)) + "</mxGraphModel>";

  assert.equal(await routeXml(mxfile(first, second)),
    mxfile(await routeXml(first), second));
});

test("compressed and empty pages are left byte-identical", async function ()
{
  const first = scene(100);
  const compressed = deflateRawSync(encodeURIComponent(scene(500)))
    .toString("base64");
  const empty = '<diagram id="empty" name="Empty"/></mxfile>';

  assert.equal(
    await routeXml(mxfile(first, compressed).replace("</mxfile>", empty)),
    mxfile(await routeXml(first), compressed).replace("</mxfile>", empty));
});

test("a bare cell fragment routes like its model", async function ()
{
  const fragment = scene(100).replace(/<\/?mxGraphModel[^>]*>/g, "");

  assert.deepEqual(points(await routeXml(fragment), "edge"),
    points(await routeXml(scene(100)), "edge"));
});

// ─── Wrapped cells ───────────────────────────────────────────────

test("shapes wrapped in <object> are obstacles and terminals", async function ()
{
  function wrap(xml, id)
  {
    return xml.replace(new RegExp('<mxCell id="' + id + '" value="' + id +
      '"([^>]*>[\\s\\S]*?</mxCell>)'), '<object id="' + id + '" label="' + id +
      '"><mxCell$1</object>');
  }

  const wrapped = wrap(wrap(scene(100), "obstacle"), "target");

  assert.match(wrapped, /<object id="obstacle" label="obstacle"><mxCell vertex="1"/);
  assert.deepEqual(points(await routeXml(wrapped), "edge"),
    points(await routeXml(scene(100)), "edge"));
});

test("children of a wrapped container are placed in its frame", async function ()
{
  // The target sits inside a container at (480, 70) - in the container's
  // frame, the same absolute position as in the flat scene.
  const nested = scene(100).replace(vertex("target", 500, 100, 100, 60),
    '<object id="box" label="Box"><mxCell style="container=1;" vertex="1" ' +
    'parent="1"><mxGeometry x="480" y="70" width="140" height="120" ' +
    'as="geometry"/></mxCell></object>' +
    vertex("target", 20, 30, 100, 60).replace('parent="1"', 'parent="box"'));

  assert.match(nested, /<mxCell id="target" value="target" vertex="1" parent="box">/);
  assert.deepEqual(points(await routeXml(nested), "edge"),
    points(await routeXml(scene(100)), "edge"));
});

// ─── Determinism ─────────────────────────────────────────────────

// A pinned wire between two vertices: exit/entry as [x, y] fractions.
function wire(id, source, target, exit, entry)
{
  return '<mxCell id="' + id + '" edge="1" parent="1" source="' + source +
    '" target="' + target + '" style="exitX=' + exit[0] + ";exitY=" +
    exit[1] + ";entryX=" + entry[0] + ";entryY=" + entry[1] + ';">' +
    '<mxGeometry relative="1" as="geometry"/></mxCell>';
}

// Page 1 of drawio-dev's templates/engineering/electrical_2.xml as the
// router sees it: the components' bounds and the pinned wires, in the
// template's cell order. Its many shared sides give libavoid lots of
// coordinate ties to break.
function circuit()
{
  const L = [0, 0.5], R = [1, 0.5];

  return '<mxGraphModel adaptiveColors="auto">' + root(
    vertex("s1", 180, 290, 100, 60) + vertex("n2", 350, 200, 100, 20) +
    vertex("n3", 590, 200, 100, 20) + vertex("n4", 350, 370, 100, 20) +
    vertex("n5", 590, 370, 100, 20) + vertex("n6", 470, 290, 100, 20) +
    vertex("r1", 362, 200, 40, 20) + vertex("r2", 362, 370, 40, 20) +
    vertex("r5", 500, 260, 40, 20) + vertex("r3", 650, 200, 40, 20) +
    vertex("r4", 650, 370, 40, 20) + vertex("is1", 280, 270, 80, 80) +
    vertex("is2", 480, 150, 80, 80) + vertex("is3", 480, 350, 80, 80) +
    wire("w1", "s1", "n2", R, R) + wire("w2", "s1", "n3", R, R) +
    wire("w3", "n2", "n6", L, L) + wire("w4", "n2", "n4", L, R) +
    wire("w5", "n3", "n5", L, R) + wire("w6", "n4", "s1", L, L) +
    wire("w7", "n5", "s1", L, L)) + "</mxGraphModel>";
}

test("a page routes the same whatever the process routed before",
  async function ()
{
  // libavoid breaks coordinate ties by object ADDRESS, so a solve's routes
  // depend on the heap it starts from; the routing core must leave the
  // wasm heap exactly as it found it. It used to leak the route copies
  // this build's displayRoute()/at() return, which moved every later
  // solve's allocations: this page came back different from call to call.
  const first = await routeXml(circuit());

  for (let i = 1; i <= 4; i++)
  {
    await routeXml(scene(100));
    assert.equal(await routeXml(circuit()), first,
      "routing call " + i + " came out different");
  }
});

// ─── Unroutable connectors ───────────────────────────────────────

test("connectors sharing one connection point each get a route",
  async function ()
{
  // Two pins at one point broke libavoid's visibility sweep and left the
  // connector registered second without a route; ends on the same anchor
  // now share one pin.
  const R = [1, 0.5], L = [0, 0.5];
  const xml = '<mxGraphModel adaptiveColors="auto">' + root(
    vertex("hub", 0, 100, 100, 60) + vertex("up", 300, 0, 100, 20) +
    vertex("down", 300, 250, 100, 20) +
    wire("first", "hub", "up", R, L) + wire("second", "hub", "down", R, L)) +
    "</mxGraphModel>";
  const after = await routeXml(xml);

  assert.deepEqual(points(after, "first"), [[200, 130], [200, 10]]);
  assert.deepEqual(points(after, "second"), [[200, 130], [200, 260]]);
});

test("a pin facing a gap narrower than the clearance is still routed",
  async function ()
{
  // The target's right-hand pin faces a marker 30px away: at the default
  // 16px buffer the channel needs 32px, so the connector is retried at a
  // smaller clearance instead of being left unrouted.
  const R = [1, 0.5];
  const xml = '<mxGraphModel adaptiveColors="auto">' + root(
    vertex("source", 0, 100, 100, 20) + vertex("target", 300, 300, 100, 20) +
    vertex("marker", 430, 280, 60, 60) +
    wire("edge", "source", "target", R, R)) + "</mxGraphModel>";
  const route = points(await routeXml(xml), "edge");
  const [lastX, lastY] = route[route.length - 1];

  // Into the gap beside the target, level with its pin.
  assert.ok(lastX > 400 && lastX < 430, "last bend at x=" + lastX);
  assert.equal(lastY, 310);
});

test("an edge that cannot be routed keeps its authored geometry",
  async function ()
{
  // The target is walled in on all four sides: no route exists at any
  // clearance, and libavoid answers with a straight line between the end
  // vertices, which must not be written over the author's waypoints.
  const edge = '<mxCell id="edge" edge="1" parent="1" source="source" ' +
    'target="target" style="exitX=1;exitY=0.5;entryX=0;entryY=0.5;">' +
    '<mxGeometry relative="1" as="geometry"><Array as="points">' +
    '<mxPoint x="200" y="20"/></Array></mxGeometry></mxCell>';
  const xml = '<mxGraphModel adaptiveColors="auto">' + root(
    vertex("source", 0, 100, 100, 60) + vertex("target", 300, 100, 100, 60) +
    vertex("north", 240, 40, 220, 20) + vertex("south", 240, 200, 220, 20) +
    vertex("west", 240, 60, 20, 140) + vertex("east", 440, 60, 20, 140) +
    edge) + "</mxGraphModel>";

  assert.ok((await routeXml(xml)).includes(edge), "the edge was rewritten");
});

// ─── Rotated shapes ──────────────────────────────────────────────

// A vertex with a style, e.g. "rotation=-90;".
function styled(id, x, y, w, h, style)
{
  return vertex(id, x, y, w, h).replace('vertex="1"',
    'style="' + style + '" vertex="1"');
}

// An edge with the given style between two vertices.
function link(id, source, target, style)
{
  return '<mxCell id="' + id + '" edge="1" parent="1" source="' + source +
    '" target="' + target + '" style="' + style + '">' +
    '<mxGeometry relative="1" as="geometry"/></mxCell>';
}

function model(cells)
{
  return '<mxGraphModel adaptiveColors="auto">' + root(cells) + "</mxGraphModel>";
}

test("a rotated terminal's connection point is where the shape draws it",
  async function ()
{
  // 100x20 turned -90 degrees: drawn 20x100 at (240,160), and its right-hand
  // connection point (exitX=1) drawn at the TOP (250,160), leaving upwards.
  const xml = model(styled("res", 200, 200, 100, 20, "rotation=-90;") +
    vertex("target", 400, 0, 100, 40) +
    link("edge", "res", "target", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;"));

  assert.deepEqual(points(await routeXml(xml), "edge"), [[250, 20]]);
});

test("a rotated shape is avoided where it is drawn", async function ()
{
  // A 200x20 wall turned 90 degrees stands 20x200 at (220,20)..(240,220):
  // the route must pass beyond it, not beside its unrotated outline.
  const xml = model(vertex("a", 0, 100, 60, 40) + vertex("b", 400, 100, 60, 40) +
    styled("wall", 130, 110, 200, 20, "rotation=90;") +
    link("edge", "a", "b", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;"));
  const route = [[60, 120], ...points(await routeXml(xml), "edge"), [400, 120]];

  for (let i = 1; i < route.length; i++)
  {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];

    assert.ok(Math.max(ax, bx) <= 220 || Math.min(ax, bx) >= 240 ||
      Math.max(ay, by) <= 20 || Math.min(ay, by) >= 220,
      "segment " + i + " crosses the rotated wall");
  }
});

test("a flip moves a connection point only off the perimeter", async function ()
{
  // draw.io projects a connection point onto the perimeter by default,
  // which undoes a flip; with exitPerimeter=0 the flipped shape draws
  // exitX=1 on its LEFT side.
  function scene(perimeter)
  {
    return model(styled("s", 300, 100, 100, 40, "flipH=1;") +
      vertex("t", 0, 300, 100, 40) +
      link("edge", "s", "t", "exitX=1;exitY=0.5;" + perimeter +
        "entryX=0.5;entryY=0;"));
  }

  assert.deepEqual(points(await routeXml(scene("exitPerimeter=0;")), "edge"),
    [[50, 120]]);
  assert.deepEqual(points(await routeXml(scene("")), "edge"),
    [[420, 120], [420, 280], [50, 280]]);
});
