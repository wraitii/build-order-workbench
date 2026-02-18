import { GameData, SimulationResult } from "./types";

export interface BuildOrderPreset {
    id: string;
    label: string;
    dsl: string;
}

const WITH_LLM = process.env.INCLUDE_LLM === "1";

let workbenchBundlePromise: Promise<string> | undefined;
let llmBundlePromise: Promise<string> | undefined;

function formatMap(map: Record<string, number>): string {
    return Object.entries(map)
        .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
        .join(", ");
}

function escapeHtml(input: string): string {
    return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

async function getLLMBundle(): Promise<string> {
    if (!llmBundlePromise) {
        llmBundlePromise = (async () => {
            const entrypoint = new URL("./llm_assistant.ts", import.meta.url).pathname;
            const buildResult = await Bun.build({
                entrypoints: [entrypoint],
                target: "browser",
                format: "esm",
                minify: true,
                sourcemap: "none",
            });
            const first = buildResult.outputs[0];
            if (!buildResult.success || !first) {
                throw new Error(buildResult.logs.map((l) => l.message).join("\n"));
            }
            const js = await first.text();
            return js.replaceAll("</script>", "<\\/script>");
        })();
    }
    return llmBundlePromise;
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

export async function toHtmlReport(
    result: SimulationResult,
    game: GameData,
    initialDsl: string,
    buildOrderPresets: BuildOrderPreset[] = [],
): Promise<string> {
    const escapedDsl = escapeHtml(initialDsl);
    const bootstrapJson = scriptSafeJson({ game, initialResult: result, buildOrderPresets });
    const [workbenchBundle, llmBundle] = await Promise.all([
        getWorkbenchBundle(),
        WITH_LLM ? getLLMBundle() : Promise.resolve(null),
    ]);

    const aiTriggerHtml = WITH_LLM
        ? `
          <button id="aiOpenBtn" class="ai-trigger">
            <span style="font-size:14px">✨</span>
            Local LLM
            <span id="aiTriggerDot" class="ai-dot ai-dot-idle"></span>
          </button>`
        : "";

    const aiModalHtml = WITH_LLM
        ? `
  <div id="aiModal" class="ai-modal-backdrop ai-hidden" role="dialog" aria-modal="true" aria-labelledby="aiModalTitle">
    <div class="ai-modal">
      <div class="ai-modal-header">
        <div class="ai-modal-title">
          <span style="font-size:16px">✨</span>
          <span id="aiModalTitle" style="font-weight:600;font-size:15px">Local LLM — Build Order Generator</span>
          <span id="aiStatusBadge" class="ai-badge ai-badge-idle">
            <span id="aiStatusDot" class="ai-dot ai-dot-idle"></span>
            <span id="aiStatusText">Not loaded</span>
          </span>
        </div>
        <button id="aiModalClose" class="btn" style="padding:4px 10px;line-height:1;font-size:16px">✕</button>
      </div>
      <div class="ai-modal-body">
        <p style="margin:0 0 6px;font-size:13px;color:var(--muted)">Runs <strong>LFM2.5-1.2B</strong> fully in your browser via WebGPU — no server, no API key.<br>Downloads ~600 MB on first load.
        <br/>⚠️ <em>Tech demo.</em> Output quality is hit-or-miss (mostly miss) — don't expect it to really work, but it's pretty cool that it runs at all. Inspired by <a href="https://huggingface.co/spaces/webml-community/GPT-OSS-WebGPU" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">GPT-OSS-WebGPU</a>.</p>
        <div id="aiLoadSection">
          <button id="aiLoadBtn" class="btn btn-primary">Load model</button>
        </div>
        <div id="aiProgressSection" style="display:none">
          <div class="ai-progress"><div id="aiProgressBar" class="ai-progress-bar" style="width:0%"></div></div>
          <div id="aiProgressLabel" style="font-size:12px;color:var(--muted);margin-top:6px;text-align:center">Starting…</div>
        </div>
        <textarea id="aiPrompt" disabled class="ai-textarea" placeholder="Paste your DSL here, or describe your strategy from scratch…"></textarea>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="aiGenBtn" class="btn btn-primary" disabled><span id="aiGenLabel">Generate DSL</span></button>
          <button id="aiStopBtn" class="btn btn-stop" style="display:none">Stop</button>
          <button id="aiApplyBtn" class="btn" style="display:none">Apply to editor ↵</button>
        </div>
        <pre id="aiOutput" class="ai-output" style="display:none"></pre>
      </div>
    </div>
  </div>`
        : "";

    const llmScriptHtml = llmBundle ? `\n  <script type="module">${llmBundle}</script>` : "";

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
    .source-note { margin-top: 10px; font-size: 12px; color: var(--muted); }
    .source-note a { color: var(--accent); text-decoration: none; }
    .source-note a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); text-align: left; padding: 6px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 500; font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    .muted { color: var(--muted); }
    .btn { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 500; transition: border-color .15s; }
    .btn:hover { border-color: var(--accent); color: var(--accent); }
    .btn:active { background: var(--accent-dim); }
    .dsl-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .dsl-select { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 10px; font-size: 13px; color: var(--ink); }
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
    .score-val { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
    .health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .health-chip { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    .health-chip-label { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
    .health-chip-val { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .health-chip-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .health-chip-debt { font-size: 11px; color: #9e2a2a; margin-top: 2px; }
    .res-table-wrap { max-height: 220px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; }
    details > summary { cursor: pointer; font-size: 12px; color: var(--muted); margin-bottom: 6px; user-select: none; }
    @media (max-width: 680px) { table { font-size: 12px; } .tl-time { min-width: 90px; font-size: 13px; } }
    /* ── AI trigger ─────────────────────────────────────────────────────────── */
    .ai-trigger { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 5px 12px; cursor: pointer; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; transition: border-color .15s, color .15s; }
    .ai-trigger:hover { border-color: var(--accent); color: var(--accent); }
    /* ── AI modal ───────────────────────────────────────────────────────────── */
    .ai-modal-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(2px); }
    .ai-hidden { display: none !important; }
    .ai-modal { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; width: 100%; max-width: 620px; height: 82vh; max-height: 820px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
    .ai-modal-header { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .ai-modal-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .ai-modal-body { padding: 16px 18px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px; }
    /* ── Status badge ───────────────────────────────────────────────────────── */
    .ai-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border-radius: 999px; padding: 3px 9px; font-weight: 500; white-space: nowrap; flex-shrink: 0; }
    .ai-badge-idle { background: #f0f0f0; color: var(--muted); }
    .ai-badge-loading { background: #fef3c7; color: #92400e; }
    .ai-badge-ready { background: var(--accent-dim); color: var(--accent); }
    .ai-badge-generating { background: #dbeafe; color: #1d4ed8; }
    .ai-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .ai-dot-idle { background: var(--muted); }
    .ai-dot-loading { background: #d97706; animation: ai-pulse 1s ease-in-out infinite; }
    .ai-dot-ready { background: var(--accent); }
    .ai-dot-generating { background: #2563eb; animation: ai-pulse .7s ease-in-out infinite; }
    @keyframes ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    /* ── Progress bar ───────────────────────────────────────────────────────── */
    .ai-progress { width: 100%; height: 5px; background: var(--line); border-radius: 3px; overflow: hidden; }
    .ai-progress-bar { height: 100%; background: var(--accent); transition: width .4s ease; border-radius: 3px; }
    /* ── Button variants ────────────────────────────────────────────────────── */
    .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn-primary:hover { background: #266d52; border-color: #266d52; color: #fff; }
    .btn-primary:disabled { background: #9dc5b8; border-color: #9dc5b8; cursor: not-allowed; color: #fff; }
    .btn-stop { background: #fee2e2; color: #9e2a2a; border-color: #fca5a5; }
    .btn-stop:hover { background: #fecaca; border-color: #f87171; color: #7f1d1d; }
    /* ── AI textarea + output ───────────────────────────────────────────────── */
    .ai-textarea { width: 100%; min-height: 120px; flex: 1; resize: none; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: #fff; color: var(--ink); line-height: 1.5; }
    .ai-textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .ai-textarea:disabled { background: #f7f6f2; color: var(--muted); cursor: not-allowed; }
    .ai-output { margin: 0; padding: 10px 12px; background: #fff; border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; min-height: 48px; flex: 1; overflow-y: auto; line-height: 1.55; }
    @keyframes ai-spin { to { transform: rotate(360deg); } }
    .ai-spin { display: inline-block; animation: ai-spin .7s linear infinite; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1 style="margin:0 0 4px">Build Order Workbench</h1>
      <p style="margin:8px 0 0;font-size:13px;color:var(--muted);line-height:1.6">
        Write a build order in the editor below using a custom scripting language, hit Run, and get a live simulation with a timeline, resource tracking, and scoring. Good for stress-testing timing assumptions without launching a game.
        <br>Data source from <a href="https://www.aoe2database.com" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">aoe2database.com</a>.
      </p>
    </section>

    <section class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <h2 style="margin:0">Build Order Editor</h2>
          <button onclick="document.getElementById('helpModal').classList.remove('ai-hidden')" style="border:none;background:none;padding:0;cursor:pointer;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:.3px">? help</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <select id="buildPresetSelect" class="dsl-select"></select>${aiTriggerHtml}
        </div>
      </div>
      <textarea id="dslInput">${escapedDsl}</textarea>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
        <button id="runBtn" class="btn btn-primary">Run</button>
        <span id="runStatus" class="muted">ready</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted)">cmd/ctrl+enter to run</span>
      </div>
      <div id="errorBox"></div>
    </section>

    <section class="card" id="scoresCard">
      <h2>Scores</h2>
      <table>
        <thead><tr><th>Criterion</th><th>Value</th></tr></thead>
        <tbody id="scoresBody"></tbody>
      </table>
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
        <div id="gatherStats" class="tl-stats" style="margin-top:-4px;margin-bottom:0;font-size:12px"></div>
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

    <section class="card">
      <h2>Health Metrics</h2>
      <div id="healthContent"></div>
    </section>
  </main>

  <div id="helpModal" class="ai-modal-backdrop ai-hidden" onclick="if(event.target===this)this.classList.add('ai-hidden')">
    <div class="ai-modal" style="max-width:700px">
      <div class="ai-modal-header">
        <span style="font-weight:600;font-size:15px">DSL Reference</span>
        <button onclick="document.getElementById('helpModal').classList.add('ai-hidden')" class="btn" style="padding:4px 10px;line-height:1;font-size:16px">✕</button>
      </div>
      <div class="ai-modal-body" style="font-size:13px;line-height:1.6;gap:14px">

        <div>
          <div style="font-weight:600;margin-bottom:6px;color:var(--ink)">Header — declare before commands</div>
          <pre style="margin:0;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre;overflow-x:auto">evaluation &lt;MM:SS&gt;                    # required — how long to simulate
debt-floor &lt;N&gt;                         # allow debt down to N (default -30)
start with &lt;entity&gt;[, &lt;entity&gt;...]    # starting units/buildings
starting-resource &lt;resource&gt; &lt;amount&gt;  # override a starting resource</pre>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:6px;color:var(--ink)">Commands</div>
          <pre style="margin:0;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre;overflow-x:auto">queue &lt;action&gt; [xN] [using &lt;actor&gt;[, ...]] [from &lt;node&gt;...]
auto-queue &lt;action&gt; [using &lt;actorType&gt;] [from &lt;node&gt;...]
stop-auto-queue &lt;action&gt; [using &lt;actorType&gt;]
assign &lt;actorType&gt; &lt;N | xN | all&gt; [from &lt;node&gt;...] to &lt;node&gt;...
spawn-assign &lt;entityType&gt; to &lt;node&gt;   # auto-assign new entities on spawn</pre>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:6px;color:var(--ink)">Timing &amp; conditions — prefix any command</div>
          <pre style="margin:0;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre;overflow-x:auto">at &lt;MM:SS&gt; &lt;command&gt;
after &lt;label&gt; &lt;command&gt;                         # after a named event
after &lt;entityType&gt; &lt;N&gt; &lt;command&gt;               # after Nth entity is ready
after completed|clicked &lt;action&gt; &lt;command&gt;      # fires once
after depleted|exhausted &lt;node&gt; &lt;command&gt;       # fires once when node empties
on completed|clicked &lt;action&gt; &lt;command&gt;         # fires every time
on depleted|exhausted &lt;node&gt; &lt;command&gt;          # fires every time</pre>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:6px;color:var(--ink)">Scoring &amp; misc</div>
          <pre style="margin:0;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:8px;font-size:12px;white-space:pre;overflow-x:auto">score time completed|clicked &lt;action&gt; [xN]       # lower time = better score
human-delay &lt;action&gt; &lt;chance&gt; &lt;minSec&gt; &lt;maxSec&gt; # simulate reaction time
# anything after a hash is a comment</pre>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:4px;color:var(--ink)">Tips</div>
          <ul style="margin:0;padding-left:18px;color:var(--muted)">
            <li><strong>Actor selectors</strong> — <code>villager</code> (any idle one), <code>villager 3</code> / <code>villager-3</code> (the 3rd villager specifically), <code>villager x2</code> (two of them), <code>villager all</code> (everyone of that type)</li>
            <li><strong>Filtering actors by where they are</strong> — append <code>from &lt;node&gt;...</code> to restrict to actors currently on those nodes. E.g. <code>assign villager x3 from sheep boar_lured to forest</code> pulls 3 villagers who are on sheep <em>or</em> boar_lured and sends them to wood. <code>idle</code> matches anyone not currently gathering.</li>
            <li><strong>Node selectors</strong> — resource names (<code>food</code>, <code>wood</code>, <code>gold</code>…) match any node of that type; node ids (<code>sheep</code>, <code>forest</code>, <code>boar_lured</code>…) match a specific node prototype</li>
            <li><strong><code>after &lt;label&gt;</code></strong> — fires once after a command with that label completes. The label defaults to the action or node id, so <code>after build_stable</code> waits for the stable to finish building.</li>
            <li>Cmd/Ctrl+Enter runs the simulation from the editor</li>
          </ul>
        </div>

      </div>
    </div>
  </div>

${aiModalHtml}
  <script>document.addEventListener('keydown',function(e){if(e.key==='Escape')document.getElementById('helpModal').classList.add('ai-hidden');});</script>
  <script>window.__WORKBENCH_BOOTSTRAP__ = ${bootstrapJson};</script>
  <script>${workbenchBundle}</script>${llmScriptHtml}
</body>
</html>`;
}
