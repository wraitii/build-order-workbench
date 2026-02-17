import { GameData, SimulationResult } from "./types";

let workbenchBundlePromise: Promise<string> | undefined;

function formatMap(map: Record<string, number>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
    .join(", ");
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scriptSafeJson(input: unknown): string {
  return JSON.stringify(input).replaceAll("</script>", "<\\/script>");
}

async function getWorkbenchBundle(): Promise<string> {
  if (!workbenchBundlePromise) {
    workbenchBundlePromise = (async () => {
      const entrypoint = new URL("./workbench.ts", import.meta.url).pathname;
      const buildResult = await Bun.build({
        entrypoints: [entrypoint],
        target: "browser",
        format: "iife",
        minify: true,
        sourcemap: "none",
      });

      const firstOutput = buildResult.outputs[0];
      if (!buildResult.success || !firstOutput) {
        const logs = buildResult.logs.map((log) => log.message).join("\n");
        throw new Error(`Failed to build workbench bundle.\n${logs}`);
      }

      const js = await firstOutput.text();
      return js.replaceAll("</script>", "<\\/script>");
    })();
  }

  return workbenchBundlePromise;
}

export function toTextReport(result: SimulationResult): string {
  const lines: string[] = [];
  lines.push(`scenarioScore: ${result.scenarioScore.toFixed(1)}`);
  lines.push(`resources: ${formatMap(result.resourcesAtEvaluation)}`);
  lines.push(`entities: ${formatMap(result.entitiesByType)}`);
  lines.push(`maxDebt: ${result.maxDebt.toFixed(2)}`);
  lines.push(`totalDelays: ${result.totalDelays.toFixed(2)}s`);
  lines.push(`completedActions: ${result.completedActions}`);
  lines.push(`violations: ${result.violations.length}`);

  if (result.violations.length > 0) {
    lines.push("violationDetails:");
    for (const v of result.violations) {
      lines.push(`  - t=${v.time.toFixed(2)} [${v.code}] ${v.message}`);
    }
  }

  return lines.join("\n");
}

export async function toHtmlReport(result: SimulationResult, game: GameData, initialDsl: string): Promise<string> {
  const escapedDsl = escapeHtml(initialDsl);
  const bootstrapJson = scriptSafeJson({ game, initialResult: result });
  const workbenchBundle = await getWorkbenchBundle();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Build Order Workbench</title>
  <style>
    :root {
      --bg: #f0ede3;
      --panel: #faf8f2;
      --ink: #1a1f1f;
      --muted: #6b7280;
      --accent: #2f7a5f;
      --accent-dim: #d4ede4;
      --line: #ddd8c8;
      --error: #9e2a2a;
      --tl-bg: #ffffff;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; color: var(--ink); background: var(--bg); }
    main { max-width: 1200px; margin: 0 auto; padding: 20px 16px; display: flex; flex-direction: column; gap: 12px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
    h1 { margin: 0 0 10px; font-size: 22px; font-weight: 700; letter-spacing: -.3px; }
    h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { background: var(--accent-dim); color: var(--accent); border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); text-align: left; padding: 6px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 500; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    .muted { color: var(--muted); }
    .btn { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 500; transition: border-color .15s; }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn:active { background: var(--accent-dim); }
    .dsl-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    #dslInput { width: 100%; min-height: 260px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: #fff; color: var(--ink); line-height: 1.5; }
    #dslInput:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    #errorBox { color: var(--error); white-space: pre-wrap; margin-top: 8px; font-size: 13px; }
    /* Timeline card */
    .tl-controls { margin-bottom: 12px; }
    .tl-scrubber { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .tl-time { font-size: 15px; font-variant-numeric: tabular-nums; font-weight: 600; min-width: 120px; color: var(--ink); letter-spacing: .3px; }
    .tl-range { flex: 1; min-width: 0; accent-color: var(--accent); }
    .tl-scale { display: flex; align-items: center; gap: 5px; white-space: nowrap; color: var(--muted); font-size: 12px; }
    .tl-scale input[type="range"] { width: 70px; accent-color: var(--muted); }
    .tl-stats { font-size: 13px; color: var(--muted); margin-bottom: 8px; min-height: 1.4em; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
    .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .legend-item { display: inline-flex; gap: 5px; align-items: center; font-size: 11px; color: var(--muted); }
    .legend-swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid #0002; flex-shrink: 0; }
    .db-icon { width: 16px; height: 16px; object-fit: contain; vertical-align: middle; margin-right: 2px; flex-shrink: 0; border-radius: 4px; }
    .seg-icon { width: 14px; height: 14px; object-fit: contain; flex-shrink: 0; border-radius: 4px; }
    .res-stat { display: inline-flex; align-items: center; gap: 2px; margin-right: 10px; }
    .res-stat:last-child { margin-right: 0; }
    /* Timeline */
    .timeline-wrap { border: 1px solid var(--line); border-radius: 10px; overflow: auto; background: var(--tl-bg); }
    .timeline-head { position: sticky; top: 0; z-index: 4; display: flex; min-width: max-content; background: #f9f7f0; border-bottom: 1px solid var(--line); }
    .timeline-label-head { width: 180px; min-width: 180px; flex-shrink: 0; padding: 5px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); border-right: 1px solid var(--line); }
    .timeline-axis { position: relative; height: 28px; flex-shrink: 0; cursor: crosshair; user-select: none; }
    .timeline-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: #0001; pointer-events: none; }
    .timeline-tick-label { position: absolute; top: 7px; transform: translateX(3px); font-size: 10px; color: var(--muted); pointer-events: none; font-variant-numeric: tabular-nums; }
    .timeline-row { display: flex; min-width: max-content; border-bottom: 1px solid #0000000e; }
    .timeline-row:last-child { border-bottom: none; }
    .timeline-label { width: 180px; min-width: 180px; flex-shrink: 0; padding: 4px 8px; font-size: 11px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); display: flex; align-items: center; }
    .timeline-track { position: relative; height: 26px; flex-shrink: 0; cursor: crosshair; user-select: none; background-image: repeating-linear-gradient(to right, #00000009 0, #00000009 1px, transparent 1px, transparent 20px); }
    .timeline-seg { position: absolute; top: 2px; height: 22px; border-radius: 4px; border: 1px solid #0002; box-sizing: border-box; overflow: hidden; display: flex; align-items: center; gap: 2px; padding: 0 3px; font-size: 10px; white-space: nowrap; pointer-events: auto; cursor: default; }
    .timeline-cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent); opacity: 0.6; z-index: 3; pointer-events: none; }
    @media (max-width: 680px) { table { font-size: 12px; } .tl-time { min-width: 90px; font-size: 13px; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Build Order Workbench</h1>
      <div class="tags">
        <span class="tag">offline html</span>
        <span class="tag">cmd/ctrl+enter to run</span>
      </div>
    </section>

    <section class="card">
      <h2>DSL Editor</h2>
      <div class="dsl-controls">
        <button id="runBtn" class="btn">Run</button>
        <span id="runStatus" class="muted">ready</span>
      </div>
      <textarea id="dslInput">${escapedDsl}</textarea>
      <div id="errorBox"></div>
    </section>

    <section class="card">
      <h2>Entity Timeline</h2>
      <div class="tl-controls">
        <div class="tl-scrubber">
          <span id="timeReadout" class="tl-time">0:00 / 0:00</span>
          <input id="timeRange" type="range" min="0" max="0" step="0.5" value="0" class="tl-range" />
          <span class="tl-scale">
            <label for="pxPerSecond">zoom</label>
            <input id="pxPerSecond" type="range" min="1" max="10" step="1" value="2" />
            <span id="pxPerSecondReadout"></span>
          </span>
        </div>
        <div id="scrubStats" class="tl-stats"></div>
        <div id="timelineLegend" class="legend"></div>
      </div>
      <div id="entityTimeline" class="timeline-wrap"></div>
    </section>

    <section class="card">
      <h2 id="violationsTitle">Warnings</h2>
      <table>
        <thead><tr><th>Time</th><th>Code</th><th>Message</th></tr></thead>
        <tbody id="violationsBody"></tbody>
      </table>
    </section>
  </main>

  <script>window.__WORKBENCH_BOOTSTRAP__ = ${bootstrapJson};</script>
  <script>${workbenchBundle}</script>
</body>
</html>`;
}
