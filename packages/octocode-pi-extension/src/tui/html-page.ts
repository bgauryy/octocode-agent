/**
 * html-page — the shared shell for Octocode's LOCAL HTML surfaces.
 *
 * Some data reads better in a browser than a terminal (plans as diagrams,
 * diffs, worker timelines). Writers generate these files under the Octocode
 * home and serve them over the shared loopback server (see local-server.ts):
 * every change rewrites the file and the page meta-refreshes, so the browser
 * tab live-updates while the user keeps talking in the terminal.
 *
 * Mermaid loads from the jsdelivr CDN when requested; offline the diagram
 * block degrades to its readable source text while the rest of the page still
 * renders. All dynamic text MUST pass through escapeHtml.
 */

/** Escape text for safe interpolation into HTML content or attributes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface OctocodePageOptions {
  title: string;
  /** Pre-escaped body HTML (callers own escaping of their dynamic text). */
  bodyHtml: string;
  /** Auto-reload period. The page shows a "live" hint when set. */
  refreshSeconds?: number;
  /** Load + initialize mermaid (dark theme) for `<pre class="mermaid">` blocks. */
  mermaid?: boolean;
}

/**
 * Render a complete standalone HTML document in the Octocode brand look
 * (octocode-dark palette: teal accent, lavender links, gold highlights).
 */
export function renderOctocodePage(opts: OctocodePageOptions): string {
  const refresh = opts.refreshSeconds
    ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSeconds))}">`
    : '';
  const mermaid = opts.mermaid
    ? `<script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: true, theme: 'dark', themeVariables: { primaryColor: '#1c2128', primaryTextColor: '#C9D1D9', lineColor: '#8B949E' } });
    </script>`
    : '';
  const live = opts.refreshSeconds ? ` · live (refreshes every ${opts.refreshSeconds}s)` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { --bg:#0D1117; --panel:#161B22; --line:#30363D; --ink:#C9D1D9; --muted:#8B949E; --teal:#5EEAD4; --lav:#A5B4FC; --gold:#F2C14E; --red:#FF6B6B; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--ink); font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size:1.2rem; color:var(--teal); margin:0 0 .25rem; }
  h1 .mark { color:var(--lav); }
  .sub { color:var(--muted); font-size:.85rem; margin-bottom:1.5rem; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem 1.25rem; margin-bottom:1rem; }
  h2 { font-size:.8rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:0 0 .75rem; }
  ul.steps { list-style:none; margin:0; padding:0; }
  ul.steps li { padding:.3rem 0; border-bottom:1px solid var(--line); }
  ul.steps li:last-child { border-bottom:none; }
  .done { color:var(--muted); text-decoration:line-through; }
  .doing { color:var(--gold); font-weight:600; }
  .todo { color:var(--ink); }
  .blocked { color:var(--muted); font-style:italic; }
  .glyph { display:inline-block; width:1.4em; }
  .deps { color:var(--muted); font-size:.8rem; }
  pre { overflow-x:auto; }
  pre.mermaid { background:transparent; display:flex; justify-content:center; }
  /* Embedded RFC document: render as a real doc, not a status panel. */
  section.rfc h2 .rfc-status { color:var(--gold); font-size:.75rem; letter-spacing:.04em; margin-left:.5rem; }
  .rfc-body { color:var(--ink); }
  .rfc-body h1, .rfc-body h2, .rfc-body h3, .rfc-body h4 { color:var(--teal); text-transform:none; letter-spacing:normal; margin:1.2rem 0 .5rem; }
  .rfc-body h1 { font-size:1.15rem; } .rfc-body h2 { font-size:1rem; } .rfc-body h3 { font-size:.9rem; }
  .rfc-body a { color:var(--lav); }
  .rfc-body code { background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; font-size:.85em; }
  .rfc-body pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:.75rem; }
  .rfc-body pre code { border:none; padding:0; }
  .rfc-body table { border-collapse:collapse; width:100%; margin:.5rem 0; font-size:.9rem; }
  .rfc-body th, .rfc-body td { border:1px solid var(--line); padding:.35rem .6rem; text-align:left; }
  .rfc-body blockquote { border-left:3px solid var(--line); margin:.5rem 0; padding:.1rem 0 .1rem .8rem; color:var(--muted); }
  /* Phase timeline */
  ol.phase-timeline { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:.4rem; }
  ol.phase-timeline .ph { display:inline-flex; align-items:center; gap:.4rem; font-size:.82rem;
    padding:.4rem .7rem; border-radius:8px; border:1px solid var(--line); color:var(--muted); background:var(--bg); }
  ol.phase-timeline .ph .ph-g { font-family:ui-monospace,monospace; }
  ol.phase-timeline .ph.done { color:var(--muted); }
  ol.phase-timeline .ph.now { color:var(--gold); border-color:var(--gold); font-weight:600;
    box-shadow:0 0 0 3px color-mix(in srgb, var(--gold) 18%, transparent); }
  ol.phase-timeline .ph.todo { opacity:.65; }
  /* Decisions */
  ul.decisions { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.5rem; }
  ul.decisions li { display:flex; flex-direction:column; gap:.15rem; padding:.5rem .7rem;
    border:1px solid var(--line); border-radius:8px; background:var(--bg); }
  ul.decisions .dq { color:var(--muted); font-size:.82rem; }
  ul.decisions .da { color:var(--lav); }
  details pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:1rem; color:var(--muted); }
  summary { cursor:pointer; color:var(--lav); font-size:.85rem; }
  footer { color:var(--muted); font-size:.75rem; margin-top:1.5rem; }
</style>
${mermaid}
</head>
<body>
<main>
<h1><span class="mark">🔍🐙</span> ${escapeHtml(opts.title)}</h1>
<div class="sub">generated by Octocode${live}</div>
${opts.bodyHtml}
<footer>Served locally by Octocode — safe to close; reopen with the same command any time.</footer>
</main>
</body>
</html>
`;
}
