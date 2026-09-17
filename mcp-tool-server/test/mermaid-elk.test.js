import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withElkLayout,
  isFlowchartSource,
  mermaidDiagramType,
} from "../../shared/mermaid-elk.js";

// ─── Diagram type (drawio-dev's getMermaidDiagramType) ───────────

test("mermaidDiagramType reads the first content line's keyword", function ()
{
  assert.equal(mermaidDiagramType("flowchart TD\n  A --> B"), "flowchart");
  assert.equal(mermaidDiagramType("graph LR; A-->B"), "graph");
  assert.equal(mermaidDiagramType("sequenceDiagram\n  A->>B: hi"), "sequencediagram");
  assert.equal(mermaidDiagramType(""), "");
  assert.equal(mermaidDiagramType(null), "");
});

test("mermaidDiagramType skips blank lines, %% comments and frontmatter",
  function ()
{
  const text = "\n%% a comment\n---\ntitle: My chart\n---\n\nflowchart LR\n  A --> B";

  assert.equal(mermaidDiagramType(text), "flowchart");
  assert.equal(isFlowchartSource(text), true);
});

test("isFlowchartSource is false for other diagram types", function ()
{
  assert.equal(isFlowchartSource("sequenceDiagram\n  A->>B: hi"), false);
  assert.equal(isFlowchartSource("classDiagram\n  A <|-- B"), false);
  // The word "graph" inside a label must not make it a flowchart.
  assert.equal(isFlowchartSource("sequenceDiagram\n  A->>B: show graph"), false);
});

// ─── Selecting the ELK layout ────────────────────────────────────

test("no frontmatter gets a minimal config block", function ()
{
  const out = withElkLayout("flowchart TD\n  A --> B");

  assert.equal(out, "---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B");
});

test("existing frontmatter without config keeps its keys", function ()
{
  const out = withElkLayout("---\ntitle: My chart\n---\nflowchart TD\n  A --> B");

  assert.equal(out,
    "---\ntitle: My chart\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B");
});

test("an existing config block gets layout as its first child", function ()
{
  const out = withElkLayout(
    "---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B");

  assert.equal(out,
    "---\nconfig:\n  layout: elk\n  theme: dark\n---\nflowchart TD\n  A --> B");
});

test("an empty config block is indented one level deeper", function ()
{
  const out = withElkLayout("---\nconfig:\n---\nflowchart TD\n  A --> B");

  assert.equal(out, "---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B");
});

test("a source that already selects a layout is untouched", function ()
{
  const explicit = "---\nconfig:\n  layout: dagre\n---\nflowchart TD\n  A --> B";
  const legacy = '%%{init: {"flowchart": {"defaultRenderer": "elk"}}}%%\n' +
    "flowchart TD\n  A --> B";
  const already = "---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B";

  assert.equal(withElkLayout(explicit), explicit);
  assert.equal(withElkLayout(legacy), legacy);
  assert.equal(withElkLayout(already), already);
});

test("CRLF frontmatter is recognized, not duplicated", function ()
{
  const out = withElkLayout("---\r\ntitle: X\r\n---\r\nflowchart TD\r\n  A --> B");

  assert.equal(out.match(/---/g).length, 2);
  assert.match(out, /config:\nlayout: elk|config:\n  layout: elk/);
  assert.match(out, /title: X/);
});

test("null passes through", function ()
{
  assert.equal(withElkLayout(null), null);
});

// ─── The trigger draw.io actually uses ───────────────────────────

// EditorUi.isMermaidElkFlowchart: a flowchart whose source carries either the
// frontmatter layout key or the legacy directive. Our output must fire it.
function firesDrawioTrigger(data)
{
  return data != null &&
    (/defaultRenderer["']?\s*:\s*["']?elk/i.test(data) ||
      /(?:^|\n)\s*layout\s*:\s*["']?elk\b/i.test(data)) &&
    /(?:flowchart|graph)\b/i.test(data);
}

test("the written selector fires draw.io's ELK trigger", function ()
{
  const cases = [
    "flowchart TD\n  A --> B",
    "---\ntitle: My chart\n---\nflowchart LR\n  A --> B",
    "---\nconfig:\n  theme: dark\n---\ngraph TD\n  A --> B",
    "---\r\ntitle: X\r\n---\r\nflowchart TD\r\n  A --> B",
  ];

  for (const source of cases)
  {
    assert.equal(firesDrawioTrigger(source), false, "fixture already selects ELK");
    assert.equal(firesDrawioTrigger(withElkLayout(source)), true,
      "selector not recognized for: " + JSON.stringify(source));
  }
});
