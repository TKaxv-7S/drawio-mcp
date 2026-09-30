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
