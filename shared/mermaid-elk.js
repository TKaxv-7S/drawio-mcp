// Mermaid → ELK layout selector.
//
// draw.io renders a Mermaid flowchart through its layered ELK layout — the
// same geometry the Arrange > Layout menu produces — when the source selects
// it. `EditorUi.isMermaidElkFlowchart` (drawio-dev) is the trigger: it fires
// on a flowchart whose source carries either the YAML-frontmatter key
// `config: { layout: elk }` or the legacy `%%{init: {flowchart:
// {defaultRenderer: "elk"}}}%%` directive, and routes the parsed XML through
// `applyMermaidElkPostPass`. That happens wherever draw.io converts Mermaid:
// opening a `#create={type:"mermaid"}` URL, importing/editing in the editor,
// and the desktop CLI's `-f xml` conversion.
//
// So selecting ELK is a pure text transform on the Mermaid source, and this
// is its canonical implementation: `withElkLayout` writes the selector,
// `mermaidDiagramType` / `isFlowchartSource` decide whether it applies at all
// (ELK only means anything for flowcharts).
//
// Since Mermaid v10.5.0 the directive form is deprecated in favor of the
// frontmatter config block, so we emit `config: { layout: elk }`.
// drawio-mermaid maps `config.layout === 'elk'` to the same path the old
// directive triggered, and drawio-dev still recognizes BOTH (back-compat with
// already-saved diagrams).

/**
 * The Mermaid diagram type keyword of a source, lowercased ("flowchart",
 * "sequencediagram", "classdiagram", …), or "" when there is no content.
 * Verbatim port of drawio-dev's EditorUi.getMermaidDiagramType: blank lines
 * and %% comments are skipped, then a frontmatter block, then the first word
 * of the first content line selects the type.
 *
 * @param {string} text - Mermaid source
 * @returns {string}
 */
export function mermaidDiagramType(text)
{
  var lines = (text != null) ? text.split("\n") : [];
  var k = 0;

  var skipBlankAndComments = function()
  {
    while (k < lines.length && (lines[k].trim().length == 0 ||
      lines[k].substring(0, 2) == "%%"))
    {
      k++;
    }
  };

  skipBlankAndComments();

  if (k < lines.length && lines[k].trim() == "---")
  {
    do
    {
      k++;
    }
    while (k < lines.length && lines[k].trim() != "---");

    k++;
    skipBlankAndComments();
  }

  if (k >= lines.length)
  {
    return "";
  }

  var diagramType = lines[k].trim().toLowerCase();
  var sp = diagramType.indexOf(" ");

  return diagramType.substring(0, sp > 0 ? sp : diagramType.length);
}

/**
 * Whether this source is a flowchart — the only diagram type the ELK layout
 * applies to (`flowchart` and its older `graph` spelling). Sequence, class,
 * ER, gantt, … lay themselves out and ignore the selector.
 *
 * @param {string} text - Mermaid source
 * @returns {boolean}
 */
export function isFlowchartSource(text)
{
  var type = mermaidDiagramType(text);

  return type === "flowchart" || type === "graph";
}

/**
 * The same Mermaid source with the ELK layout selected, or unchanged when it
 * already selects a layout.
 *
 * Placement rules: the config key must live INSIDE the frontmatter (Mermaid
 * only honors frontmatter at the very start of the document). So:
 *  - no frontmatter         -> emit a minimal "--- config: layout: elk ---" block
 *  - frontmatter, no config -> append a config block before the closing ---
 *  - frontmatter + config   -> nest "layout: elk" as the first child of config
 * An explicit renderer/layout already present (old directive, or any layout
 * key in the frontmatter) is respected and left untouched.
 *
 * @param {string} text - Mermaid source
 * @returns {string}
 */
export function withElkLayout(text)
{
  if (text == null) return text;

  // Old %%{init ... defaultRenderer: "elk"}%% directive is still honored;
  // if present, leave the source untouched.
  if (/defaultRenderer/i.test(text)) return text;

  var fm = /^(---[ \t]*\r?\n)([\s\S]*?)(---[ \t]*\r?\n)/.exec(text);

  // No frontmatter: emit a minimal block carrying just the ELK layout config.
  if (fm == null)
  {
    return "---\nconfig:\n  layout: elk\n---\n" + text;
  }

  var open = fm[1], body = fm[2], close = fm[3];
  var rest = text.substring(fm[0].length);

  // Respect an explicit layout already declared in the frontmatter.
  if (/(?:^|\n)[ \t]*layout[ \t]*:/.test(body)) return text;

  // Existing config: block -> nest "layout: elk" as its first child, matching
  // the indentation of the block's existing children (falls back to one level
  // deeper than config: when the block is empty).
  var cfg = /(?:^|\n)([ \t]*)config[ \t]*:[ \t]*\r?\n/.exec(body);

  if (cfg != null)
  {
    var at = cfg.index + cfg[0].length;
    var child = /^([ \t]+)\S/.exec(body.substring(at));
    var indent = child ? child[1] : (cfg[1] + "  ");

    body = body.substring(0, at) + indent + "layout: elk\n" + body.substring(at);

    return open + body + close + rest;
  }

  // Frontmatter present but no config: block -> append one before the closer.
  return open + body + "config:\n  layout: elk\n" + close + rest;
}
