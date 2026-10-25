import { createHash } from 'node:crypto';

export const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const show = value => escapeHtml(typeof value === 'string' ? value : JSON.stringify(value));
const scriptHash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
const themeScript = `(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();`;
const themeCss = `
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}`;
const css = `${themeCss}
*{box-sizing:border-box}
body{margin:0;background:var(--cp-bg);color:var(--cp-text);font:16px/1.55 "Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:1200px;margin:auto;padding:32px 24px 64px}
h1{font-size:32px;line-height:1.2;margin:8px 0}h2{font-size:24px}h3{font-size:19px}
p{max-width:95ch}a{color:var(--cp-link)}code,pre{font-family:Consolas,"Courier New",Courier,monospace}
code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--cp-surface-soft);padding:16px;border-radius:.625rem}
button{font:inherit;cursor:pointer;border:1px solid var(--cp-border-strong);border-radius:.625rem;padding:8px 16px;background:var(--cp-surface);color:var(--cp-text)}
button:hover{border-color:var(--cp-accent)}button:focus-visible,a:focus-visible{outline:3px solid var(--cp-accent);outline-offset:3px}
nav{display:flex;gap:8px;margin:24px 0}nav [aria-selected="true"]{background:var(--cp-accent);color:var(--cp-accent-fg);border-color:var(--cp-accent)}
.card{background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px;padding:24px;margin:16px 0}
.muted{color:var(--cp-text-muted)}.eyebrow{color:var(--cp-accent);font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:13px}
.notice{border-left:4px solid var(--cp-accent);padding:12px 16px;background:var(--cp-accent-soft);border-radius:.625rem}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--cp-border);overflow-wrap:anywhere;min-width:120px}
th{color:var(--cp-text-muted)}td code{font-size:13px}dl{display:grid;grid-template-columns:160px 1fr;gap:8px}dt{color:var(--cp-text-muted)}dd{margin:0;overflow-wrap:anywhere}
.badge{display:inline-block;padding:4px 8px;border:1px solid var(--cp-border);border-radius:.625rem;font-size:12px;font-weight:600;background:var(--cp-surface-soft)}
.step-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.step-head h3{margin:0}
.steps{list-style:none;padding:0;counter-reset:steps}.steps>li{counter-increment:steps}.step-head:before{content:counter(steps);color:var(--cp-accent);font-size:24px;font-weight:600}
svg{width:100%;min-width:800px;height:auto}.diagram-node{fill:var(--cp-surface-soft);stroke:var(--cp-accent);stroke-width:2}.diagram-text{fill:var(--cp-text);font:16px "Segoe UI",Aptos,Calibri,sans-serif;text-anchor:middle}.diagram-edge{stroke:var(--cp-text-muted);stroke-width:2;fill:none}.diagram-label{fill:var(--cp-text-muted);font:13px "Segoe UI",Aptos,Calibri,sans-serif;text-anchor:middle}.diagram-label-bg{fill:var(--cp-surface)}.arrow-head{fill:var(--cp-text-muted)}
[hidden]{display:none}.check{font-size:14px;color:var(--cp-text-muted)}#copy-status{min-height:24px}
@media(max-width:700px){main{padding:16px}h1{font-size:26px}.card{padding:16px}dl{grid-template-columns:1fr}dd{margin-bottom:12px}}
@media print{body{background:var(--cp-surface)}main{max-width:none;padding:0}nav,button,.check,#copy-status{display:none}.panel[hidden]{display:block!important}.card{break-inside:avoid}pre{white-space:pre-wrap}svg{min-width:0}}
`;
export const handoverUiScript = `(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab, false));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (i + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); select(tabs[next], true); }
    });
  });
  select(tabs[0], false);
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const code = document.getElementById(button.dataset.copy);
      const status = document.getElementById('copy-status');
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(code.textContent);
        status.textContent = 'Copied. Replace placeholders and review this step before running it.';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        status.textContent = 'Clipboard access is unavailable. Command selected: copy it manually.';
      }
    });
  }
})();`;

export function handoverArchitecture(input) {
  const gateway = Boolean(input.azure.gateway), key = Boolean(input.backend.apiKey);
  const host = input.recipe === 'functions-sdk-v1' ? 'Functions SDK (preview)'
    : input.recipe === 'app-service-container-v1' ? 'App Service container' : 'Container Apps';
  const nodes = [
    { id: 'caller', x: 20, y: 160, label: 'MCP client' },
    ...(gateway ? [{ id: 'gateway', x: 260, y: 160, label: 'APIM HTTP gateway' }] : []),
    { id: 'host', x: gateway ? 500 : 380, y: 160, label: host },
    { id: 'backend', x: 800, y: 160, label: 'REST backend' },
    { id: 'entra', x: 380, y: 20, label: 'Microsoft Entra ID' },
    { id: 'supply', x: 140, y: 320, label: input.azure.storage ? 'Storage + identity' : 'ACR + pull identity' },
    ...(key ? [{ id: 'vault', x: 650, y: 320, label: 'Key Vault + identity' }] : []),
  ].map(node => ({ ...node, width: 190, height: 80 }));
  const edges = [
    { id: 'call', from: 'caller', to: gateway ? 'gateway' : 'host', label: 'Delegated token', axis: 'horizontal' },
    ...(gateway ? [{ id: 'gateway-call', from: 'gateway', to: 'host', label: 'Caller + gateway tokens', axis: 'horizontal' }] : []),
    { id: 'backend-call', from: 'host', to: 'backend', label: key ? `API key (${input.backend.apiKey.headerName ? 'header' : 'query'})` : 'Anonymous GET', axis: 'horizontal' },
    { id: 'auth', from: 'entra', to: 'host', label: 'JWT validation', axis: 'vertical' },
    { id: 'supply-link', from: 'supply', to: 'host', label: 'Platform prerequisite', axis: 'up' },
    ...(key ? [{ id: 'secret', from: 'vault', to: 'host', label: 'Startup secret reference', axis: 'up' }] : []),
  ].map(edge => {
    const a = nodes.find(n => n.id === edge.from), b = nodes.find(n => n.id === edge.to);
    const start = edge.axis === 'horizontal' ? [a.x + a.width, a.y + 40]
      : edge.axis === 'up' ? [a.x + 95, a.y] : [a.x + 95, a.y + 80];
    const end = edge.axis === 'horizontal' ? [b.x, b.y + 40]
      : edge.axis === 'up' ? [b.x + (edge.from === 'vault' ? 150 : 40), b.y + 80] : [b.x + 95, b.y];
    return { ...edge, start, end };
  });
  return { nodes, edges, meaning: 'Configured architecture, not deployment or runtime evidence. Caller/gateway tokens are never forwarded to the REST backend.' };
}

export function architectureSvg(architecture) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1010 430" role="img" aria-labelledby="architecture-title architecture-description">
<title id="architecture-title">Configured MCP architecture</title><desc id="architecture-description">${escapeHtml(architecture.meaning)}</desc>
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path class="arrow-head" d="M0,0 L0,6 L9,3 z"/></marker></defs>
${architecture.edges.map(e => `<path class="diagram-edge" marker-end="url(#arrow)" d="M${e.start.join(',')} L${e.end.join(',')}"/>
<rect class="diagram-label-bg" x="${(e.start[0] + e.end[0]) / 2 - (e.label.length * 7 + 12) / 2}" y="${(e.axis === 'horizontal' ? 145 : (e.start[1] + e.end[1]) / 2 - 12) - 15}" width="${e.label.length * 7 + 12}" height="20" rx="4"/>
<text class="diagram-label" x="${(e.start[0] + e.end[0]) / 2}" y="${e.axis === 'horizontal' ? 145 : (e.start[1] + e.end[1]) / 2 - 12}">${escapeHtml(e.label)}</text>`).join('\n')}
${architecture.nodes.map(n => `<rect class="diagram-node" x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10"/>
<text class="diagram-text" x="${n.x + n.width / 2}" y="${n.y + 46}">${escapeHtml(n.label)}</text>`).join('\n')}
</svg>`;
}
export function architectureExcalidraw(architecture) {
  const base = (id, type, x, y, width, height) => ({ id, type, x, y, width, height,
    angle: 0, strokeColor: '#b11f4b', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: 0, link: null, locked: false });
  const text = (id, x, y, width, value, containerId = null) => ({ ...base(id, 'text', x, y, width, 40),
    strokeColor: '#000000', text: value, originalText: value, fontSize: 16, fontFamily: 2,
    textAlign: 'center', verticalAlign: 'middle', containerId, lineHeight: 1.25, autoResize: true });
  const elements = architecture.nodes.flatMap(n => [
    { ...base(n.id, 'rectangle', n.x, n.y, n.width, n.height), roundness: { type: 3 },
      boundElements: [{ id: `${n.id}-label`, type: 'text' },
        ...architecture.edges.filter(e => e.from === n.id || e.to === n.id).map(e => ({ id: e.id, type: 'arrow' }))] },
    text(`${n.id}-label`, n.x + 5, n.y + 20, n.width - 10, n.label, n.id),
  ]);
  for (const e of architecture.edges) {
    const dx = e.end[0] - e.start[0], dy = e.end[1] - e.start[1];
    elements.push({ ...base(e.id, 'arrow', ...e.start, Math.abs(dx), Math.abs(dy)),
      points: [[0, 0], [dx, dy]], startBinding: { elementId: e.from, focus: 0, gap: 1 },
      endBinding: { elementId: e.to, focus: 0, gap: 1 }, startArrowhead: null, endArrowhead: 'arrow' });
    elements.push(text(`${e.id}-label`, (e.start[0] + e.end[0]) / 2 - 130,
      e.axis === 'horizontal' ? 115 : (e.start[1] + e.end[1]) / 2 - 48, 260, e.label));
  }
  elements.push(text('meaning', 10, 440, 990, 'Configured architecture only. No caller/gateway token forwarding to REST.'));
  return { type: 'excalidraw', version: 2, source: 'copilot-mcp-toolkit', elements,
    appState: { viewBackgroundColor: '#ffffff' }, files: {} };
}
export const standaloneArchitectureSvg = architecture => architectureSvg(architecture)
  .replace('<defs>', `<style>${themeCss}\n.diagram-node{fill:var(--cp-surface-soft);stroke:var(--cp-accent);stroke-width:2}.diagram-text{fill:var(--cp-text);font:16px "Segoe UI",Aptos,Calibri,sans-serif;text-anchor:middle}.diagram-edge{stroke:var(--cp-text-muted);stroke-width:2;fill:none}.diagram-label{fill:var(--cp-text-muted);font:13px "Segoe UI",Aptos,Calibri,sans-serif;text-anchor:middle}.diagram-label-bg{fill:var(--cp-surface)}.arrow-head{fill:var(--cp-text-muted)}</style><defs>`);

const table = (headings, rows) => `<div class="scroll"><table><thead><tr>${headings.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
export function renderHandover(report) {
  const csp = `default-src 'none'; script-src ${scriptHash(themeScript)} ${scriptHash(handoverUiScript)}; style-src ${scriptHash(css)}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const summary = report.summary;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>${escapeHtml(summary.name)} - MCP Deployment Handover</title>
<script>${themeScript}</script><style>${css}</style></head>
<body><main><header><div class="eyebrow">MCP Deployment Handover</div><h1>${escapeHtml(summary.name)}</h1>
<p class="muted">${escapeHtml(summary.recipe)} | Snapshot cut-off: ${escapeHtml(report.snapshotAt)}</p>
<p class="notice">Private local handover. Configuration and owner reports are not verified deployment. Historical observations are not current health or permission to repeat a call. No credentials, automatic execution or external assets.</p></header>
<nav role="tablist" aria-label="Handover views"><button id="summary-tab" role="tab" aria-selected="true" aria-controls="summary">Deployment summary</button><button id="repeat-tab" role="tab" aria-selected="false" aria-controls="repeat">Recreate in another environment</button></nav>
<noscript><p>Both sections are shown below. Copy commands manually; nothing executes in this page.</p></noscript>
<div id="copy-status" role="status" aria-live="polite"></div>
<section id="summary" class="panel" role="tabpanel" aria-labelledby="summary-tab">
<div class="card"><h2>Configuration</h2><dl>
${Object.entries({ Endpoint: summary.endpoint ?? 'Not supplied; use actual deployment readback', 'Endpoint provenance': summary.endpointProvenance,
    Tenant: summary.azure.tenantId, Subscription: summary.azure.subscriptionId, 'Resource group': summary.azure.resourceGroup,
    Authentication: 'Entra delegated caller validation', Backend: summary.backend.origin,
    'Backend authentication': summary.backend.auth, 'Image registry': summary.azure.registry?.server ?? 'Not applicable (Functions source deployment)' })
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${show(v)}</dd>`).join('')}
</dl><details><summary>Exact authentication configuration (not verification)</summary><pre>${show(JSON.stringify(summary.authentication, null, 2))}</pre></details></div>
<div class="card"><h2>Architecture</h2><p class="muted">${escapeHtml(report.architecture.meaning)}</p><div class="scroll">${architectureSvg(report.architecture)}</div>
<p><a href="architecture.excalidraw" download>Editable Excalidraw source</a> | <a href="architecture.svg" download>SVG diagram</a>. Open the source in your approved Excalidraw editor; this report uploads nothing.</p></div>
<div class="card"><h2>Milestones and outstanding work</h2>
${table(['Milestone', 'Status', 'Provenance / recorded at', 'Detail'], report.milestones.map(m => [show(m.name), `<span class="badge">${show(m.status)}</span>`, show(`${m.provenance}${m.observedAt ? ` / ${m.observedAt}` : ''}`), show(m.note ?? '')]))}
<p class="muted">A user-reported pass is not independent verification. Deferred and pending work stays incomplete. Historical evidence below has its own narrower scope.</p>
${report.waiting ? `<p class="notice">Waiting: ${show(report.waiting.phase)} / ${show(report.waiting.reason)}. Resume only when: ${show(report.waiting.resumeWhen)}.</p>` : ''}
${report.operatorActivity.length ? `<h3>Operator activity (not service-attested)</h3>${table(['Operation', 'Target', 'Status', 'Recorded at'],
    report.operatorActivity.map(o => [show(o.kind), show(o.target), show(o.status), show(o.observedAt)]))}` : ''}
</div>
<div class="card"><h2>Historical toolkit evidence</h2>
${table(['Observation', 'Outcome', 'Recorded at', 'Meaning'], report.evidence.map(e => [show(e.kind), show(e.status), show(e.observedAt ?? 'Not recorded'), show(e.meaning)]))}
<p class="muted">Integrity hashes are not signatures or live service attestations. Proofs remain consumed. No raw logs, token caches, captures or replay approvals are included.</p></div>
<div class="card"><h2>Resource inventory</h2>
${table(['Resource', 'Exact configured ID', 'Disposition', 'Provenance'], report.resources.map(r => [show(r.label), `<code>${show(r.resourceId)}</code>`, show(r.disposition), show(`${r.provenance}${r.observedAt ? ` / ${r.observedAt}` : ''}`)]))}
<p class="muted">Planned-create is not installed. Configured-reuse is not observed existence. Created/changed/reused reports require operator input; the handover never infers them from a template.</p></div>
<div class="card"><h2>Tools</h2>${table(['Name', 'Description', 'Backend route'], summary.tools.map(t => [show(t.name), show(t.description), show(t.path)]))}
<p class="muted">These are generated tool definitions, not a fresh tools/list capture.</p></div>
<div class="card"><h2>Ownership, cost and files</h2><p class="muted">Owner-supplied notes, not independent pricing or operational verification.</p><p>${show(report.operationsNote)}</p><p>${show(report.costNote)}</p>
<ul>${report.downloads.map(d => `<li><a href="${escapeHtml(d.path)}">${escapeHtml(d.label)}</a></li>`).join('')}</ul>
<p class="muted">Keep this folder together. Artifact hashes and provenance are in handover-manifest.json. The diagram and HTML are views, not execution authority.</p></div>
</section>
<section id="repeat" class="panel" role="tabpanel" aria-labelledby="repeat-tab">
<div class="card"><h2>Source is not destination</h2><p class="notice">Original settings below are reference-only. Copy the recipe into a new private workspace and explicitly choose every destination value. Do not edit sealed source, copy credentials, reuse approvals or replay consumed proofs.</p>
<p>Commands are PowerShell examples. Replace every &lt;PLACEHOLDER&gt; before use. Review the prerequisites and obtain each operation's separate approval. The supplied script only runs a local source-generation plan.</p>
<p><a href="scripts/review-source.ps1" download>Download local source-review script</a></p></div>
<div class="card"><h2>What must change?</h2>
${table(['File / field', 'Original reference value', 'Destination action'], report.destinationEdits.map(e => [`<code>${show(e.file)}<br>${show(e.field)}</code>`, `<code>${show(e.original)}</code>`, show(e.instruction)]))}</div>
<p class="muted">Checkboxes are temporary reading aids, not saved evidence, approvals or verified status.</p>
<ol class="steps">${report.steps.map((s, i) => `<li class="card"><div class="step-head"><h3>${escapeHtml(s.title)}</h3><span class="badge">${escapeHtml(s.kind)}</span></div>
<p>${escapeHtml(s.instruction).replaceAll('\n', '<br>')}</p>
${s.command ? `<pre><code id="command-${i}">${escapeHtml(s.command)}</code></pre><button type="button" data-copy="command-${i}" aria-label="Copy command for ${escapeHtml(s.title)}">Copy command</button>` : ''}
<p><strong>Expected result:</strong> ${escapeHtml(s.expected)}</p><label class="check"><input type="checkbox"> I have reviewed this step (not verification)</label></li>`).join('')}</ol>
</section><footer class="muted">Toolkit build: <code>${escapeHtml(report.producerBuild)}</code><br>No live operation was performed to generate this handover.</footer>
</main><script>${handoverUiScript}</script></body></html>\n`;
}
