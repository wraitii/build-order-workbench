import { createActionDslLines, createCivDslByName, createDslValidationSymbols, createRulesetDslByName, createSettingDslByName, parseBuildOrderDsl } from "./dsl";
import { runSimulation } from "./sim";
import { EntityTimeline, GameData, ScoreCriterion, ScoreResult, SimulationResult } from "./types";
import { createDslSelectorAliases } from "./node_selectors";

interface BuildOrderPreset {
    id: string;
    label: string;
    dsl: string;
}

interface WorkbenchBootstrap {
    game: GameData;
    initialResult: SimulationResult;
    buildOrderPresets?: BuildOrderPreset[];
    iconDataUris?: Record<string, string>;
    initialDsl?: string;
    withLlm?: boolean;
}

declare global {
    interface Window {
        __WORKBENCH_BOOTSTRAP__?: WorkbenchBootstrap;
    }
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function formatMSS(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
}

function escapeHtml(str: string): string {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function mapToString(obj: Record<string, number>): string {
    return Object.entries(obj)
        .map(([k, v]) => `${k}: ${round2(Number(v))}`)
        .join(", ");
}

// ── URL sharing ───────────────────────────────────────────────────────────────

function uint8ToBase64url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64urlToUint8(str: string): Uint8Array {
    const b64 = str.replaceAll("-", "+").replaceAll("_", "/");
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function compressDsl(dsl: string): Promise<string> {
    const input = new TextEncoder().encode(dsl);
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(input);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return uint8ToBase64url(new Uint8Array(buf));
}

async function decompressDsl(encoded: string): Promise<string> {
    const input = base64urlToUint8(encoded);
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(input);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
}

// ── Local storage ─────────────────────────────────────────────────────────────

const STORAGE_CUSTOM_DSL = "workbench:custom_dsl";
const STORAGE_SAVED_BUILDS = "workbench:saved_builds";

interface SavedBuild {
    id: string;
    label: string;
    dsl: string;
}

function loadSavedBuilds(): SavedBuild[] {
    try { return JSON.parse(localStorage.getItem(STORAGE_SAVED_BUILDS) ?? "[]"); } catch { return []; }
}

function persistSavedBuilds(builds: SavedBuild[]): void {
    localStorage.setItem(STORAGE_SAVED_BUILDS, JSON.stringify(builds));
}

function loadCustomDsl(): string | null {
    return localStorage.getItem(STORAGE_CUSTOM_DSL);
}

function persistCustomDsl(dsl: string): void {
    localStorage.setItem(STORAGE_CUSTOM_DSL, dsl);
}

// ─────────────────────────────────────────────────────────────────────────────

function colorForSegment(kind: string, detail: string): string {
    if (kind === "idle") return "#d9d9d9";
    if (kind === "gather") {
        const key = detail.toLowerCase();
        if (key.includes("food")) return "#6aa84f";
        if (key.includes("wood")) return "#a67c52";
        if (key.includes("gold")) return "#d4af37";
        if (key.includes("stone")) return "#7f8c8d";
        return "#4f8b8b";
    }
    let h = 0;
    for (let i = 0; i < detail.length; i += 1) h = (h * 31 + detail.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 60% 62%)`;
}

const bootstrapEl = document.getElementById("__bootstrap__");
if (!bootstrapEl || !bootstrapEl.textContent) {
    throw new Error("Workbench bootstrap element is missing.");
}
const BOOTSTRAP = JSON.parse(bootstrapEl.textContent) as WorkbenchBootstrap;
// Make available for llm_assistant.ts
window.__WORKBENCH_BOOTSTRAP__ = BOOTSTRAP;

const GAME = BOOTSTRAP.game;
let sim = BOOTSTRAP.initialResult;

function iconUrl(slug: string): string {
    return BOOTSTRAP.iconDataUris?.[slug] ?? "";
}

function entityIconUrl(entityType: string): string {
    const def = GAME.entities[entityType];
    if (!def) return "";
    const prefix = def.kind === "unit" ? "u" : "b";
    return iconUrl(`${prefix}_${entityType}`);
}

function resourceIconUrl(resource: string): string {
    return iconUrl(`r_${resource}`);
}

function segmentIconUrl(kind: string, detail: string): string {
    if (kind === "gather") {
        const [resource = ""] = detail.split(":");
        return resourceIconUrl(resource);
    }
    if (kind === "action") {
        const action = GAME.actions[detail];
        if (action?.creates) {
            const entityType = Object.keys(action.creates)[0];
            if (entityType) return entityIconUrl(entityType);
        }
        if (detail.startsWith("build_")) {
            const built = detail.replace("build_", "");
            if (GAME.entities[built]) return entityIconUrl(built);
        }
        const techSlug = detail.replace(/^(research_|advance_)/, "");
        return iconUrl(`t_${techSlug}`);
    }
    return "";
}

function segmentLabel(kind: string, detail: string): string {
    if (kind === "action") return GAME.actions[detail]?.name ?? detail;
    return detail;
}

function iconImg(url: string, title = "", cssClass = "db-icon"): string {
    if (!url) return "";
    return `<img src="${escapeHtml(url)}" class="${cssClass}" alt="" title="${escapeHtml(title)}" onerror="this.style.display='none'">`;
}

function mustElement<T extends Element>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Workbench DOM is missing element '#${id}'.`);
    return el as unknown as T;
}

const runBtn = mustElement<HTMLButtonElement>("runBtn");
const shareBtn = mustElement<HTMLButtonElement>("shareBtn");
const runStatus = mustElement<HTMLElement>("runStatus");
const dslInput = mustElement<HTMLTextAreaElement>("dslInput");
const buildPresetSelect = mustElement<HTMLSelectElement>("buildPresetSelect");
const errorBox = mustElement<HTMLElement>("errorBox");

const gatherStats = mustElement<HTMLElement>("gatherStats");
const range = mustElement<HTMLInputElement>("timeRange");
const readout = mustElement<HTMLElement>("timeReadout");
const stats = mustElement<HTMLElement>("scrubStats");

const entityTimeline = mustElement<HTMLElement>("entityTimeline");
const pxPerSecond = mustElement<HTMLInputElement>("pxPerSecond");
const pxPerSecondReadout = mustElement<HTMLElement>("pxPerSecondReadout");

const violationsTitle = mustElement<HTMLElement>("violationsTitle");
const violationsBody = mustElement<HTMLElement>("violationsBody");
const scoresCard = mustElement<HTMLElement>("scoresCard");
const scoresBody = mustElement<HTMLElement>("scoresBody");
const healthContent = mustElement<HTMLElement>("healthContent");
const manageBtn = mustElement<HTMLButtonElement>("manageBtn");
const saveBuildName = mustElement<HTMLInputElement>("saveBuildName");
const saveBuildBtn = mustElement<HTMLButtonElement>("saveBuildBtn");
const savedBuildsList = mustElement<HTMLElement>("savedBuildsList");

function maxTime(): number {
    const entityMax = sim.entityCountTimeline?.[sim.entityCountTimeline.length - 1]?.time ?? 0;
    const resourceMax = sim.resourceTimeline?.[sim.resourceTimeline.length - 1]?.end ?? 0;
    return Math.max(entityMax, resourceMax);
}

function resourcesAt(t: number): Record<string, number> {
    if (!sim.resourceTimeline || sim.resourceTimeline.length === 0) return sim.initialResources ?? {};

    for (const seg of sim.resourceTimeline) {
        if (t >= seg.start && t <= seg.end) {
            const dt = t - seg.start;
            const out = { ...seg.startResources };
            const gatherRates = (seg.gatherRates ?? {}) as Record<string, number>;
            for (const [k, rate] of Object.entries(gatherRates)) out[k] = (out[k] ?? 0) + rate * dt;
            return out;
        }
    }

    const firstSeg = sim.resourceTimeline[0];
    if (firstSeg && t <= firstSeg.start) return { ...sim.initialResources };
    return { ...sim.resourcesAtEvaluation };
}

function gatherersAt(t: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const timeline of Object.values(sim.entityTimelines ?? {})) {
        for (const seg of timeline.segments ?? []) {
            if (t >= seg.start && t < seg.end) {
                if (seg.kind === "gather") {
                    const resource = seg.detail.split(":")[0] ?? seg.detail;
                    counts[resource] = (counts[resource] ?? 0) + 1;
                }
                break;
            }
        }
    }
    return counts;
}

function scoreCriterionLabel(c: ScoreCriterion): string {
    const cond = c.condition;
    const suffix = (c.count ?? 1) > 1 ? ` x${c.count}` : "";
    if (cond.kind === "clicked" || cond.kind === "completed") return `${cond.kind} ${cond.actionId}${suffix}`;
    return `${cond.kind} ${cond.resourceNodeSelector}${suffix}`;
}

function renderScores(): void {
    const scores: ScoreResult[] = sim.scores ?? [];
    if (scores.length === 0) {
        scoresBody.innerHTML = "<tr><td colspan=2 class='muted'>No score criteria configured</td></tr>";
        return;
    }
    scoresBody.innerHTML = scores
        .map((s: ScoreResult) => {
            const label = escapeHtml(scoreCriterionLabel(s.criterion));
            const val =
                s.value !== null
                    ? `<span class="score-val">${formatMSS(s.value)}</span>`
                    : `<span class="muted">—</span>`;
            return `<tr><td>${label}</td><td>${val}</td></tr>`;
        })
        .join("");
}

function renderHealth(): void {
    const resources: string[] = GAME.resources;
    const mTime = maxTime();
    const step = 5;

    const chipsHtml = resources
        .map((res: string) => {
            const gathered = sim.totalGathered[res] ?? 0;
            const debt = sim.peakDebt[res] ?? 0;
            const debtTime = sim.debtDuration[res] ?? 0;
            const avg = sim.avgFloat[res] ?? 0;
            const icon = iconImg(resourceIconUrl(res), res);
            const debtHtml =
                debt < -0.01
                    ? `<div class="health-chip-debt">peak debt: ${round2(debt)} (${formatMSS(debtTime)})</div>`
                    : "";
            return `<div class="health-chip">
  <div class="health-chip-label">${icon}${escapeHtml(res)}</div>
  <div class="health-chip-val">${round2(gathered)}</div>
  <div class="health-chip-sub">gathered total</div>
  <div class="health-chip-avg">avg float ${round2(avg)}</div>${debtHtml}
</div>`;
        })
        .join("");

    const graphsHtml = gatherableResources()
        .map((res: string) => {
            const icon = iconImg(resourceIconUrl(res), res);
            return `<div class="res-graph-item">
  <div class="res-graph-label">${icon}${escapeHtml(res)}</div>
  ${resourceGraph(res, mTime, step)}
</div>`;
        })
        .join("");

    healthContent.innerHTML = `<div class="health-grid">${chipsHtml}</div><div class="res-graphs">${graphsHtml}</div>`;
}

function renderTables(): void {
    const violations = sim.violations ?? [];

    violationsTitle.textContent = `Warnings (${violations.length})`;
    violationsBody.innerHTML =
        violations.length === 0
            ? "<tr><td colspan=3 class='muted'>None</td></tr>"
            : violations
                  .map(
                      (v) =>
                          `<tr><td>${Number(v.time).toFixed(2)}</td><td>${escapeHtml(v.code)}</td><td>${escapeHtml(v.message)}</td></tr>`,
                  )
                  .join("");

    renderScores();
    renderHealth();
}

// Resources that any node can actually produce — computed once per sim result.
function gatherableResources(): string[] {
    const seen = new Set<string>();
    for (const seg of sim.resourceTimeline ?? []) {
        for (const k of Object.keys(seg.gatherRates ?? {})) seen.add(k);
    }
    // Preserve GAME.resources ordering, skip anything with no gather rate (e.g. pop).
    return GAME.resources.filter((r: string) => seen.has(r));
}


function resourceGraph(resource: string, mTime: number, step: number): string {
    if (mTime <= 0) return "";
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= mTime + 0.001; t += step) {
        samples.push([t, resourcesAt(t)[resource] ?? 0]);
    }
    if (samples.length < 2) return "";

    const vw = 200,
        vh = 72;
    const padL = 30,
        padR = 4,
        padT = 4,
        padB = 16;
    const innerW = vw - padL - padR;
    const innerH = vh - padT - padB;

    const vals = samples.map(([, v]) => v);
    const vMax = Math.max(...vals, 1);
    const vMin = Math.min(...vals, 0);
    const vRange = vMax - vMin || 1;

    const toX = (t: number) => padL + (t / mTime) * innerW;
    const toY = (v: number) => padT + (1 - (v - vMin) / vRange) * innerH;

    const pts = samples.map(([t, v]) => `${round2(toX(t))},${round2(toY(v))}`).join(" ");

    const yTicks = [vMax, vMin]
        .map(
            (v) =>
                `<text x="${padL - 3}" y="${round2(toY(v) + 3)}" font-size="8" text-anchor="end" fill="currentColor" opacity="0.5">${Math.round(v)}</text>`,
        )
        .join("");

    const xStepCount = mTime > 600 ? 4 : 3;
    const xTicks = Array.from({ length: xStepCount + 1 }, (_, i) => {
        const t = (i / xStepCount) * mTime;
        return `<text x="${round2(toX(t))}" y="${vh - 2}" font-size="8" text-anchor="middle" fill="currentColor" opacity="0.5">${formatMSS(t)}</text>`;
    }).join("");

    const zeroLine =
        vMin < -0.5
            ? `<line x1="${padL}" y1="${round2(toY(0))}" x2="${vw - padR}" y2="${round2(toY(0))}" stroke="var(--error)" stroke-width="0.5" stroke-dasharray="2,2" opacity="0.5"/>`
            : "";

    const colors: Record<string, string> = { food: "#6aa84f", wood: "#a67c52", gold: "#d4af37", stone: "#7f8c8d" };
    const stroke = colors[resource] ?? "var(--accent)";

    return `<svg viewBox="0 0 ${vw} ${vh}" style="width:100%;height:${vh}px;overflow:visible;color:var(--ink)">
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="currentColor" stroke-width="0.5" opacity="0.12"/>
  <line x1="${padL}" y1="${padT + innerH}" x2="${vw - padR}" y2="${padT + innerH}" stroke="currentColor" stroke-width="0.5" opacity="0.12"/>
  ${yTicks}${xTicks}${zeroLine}
  <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

function renderScrub(t: number): void {
    readout.textContent = `${formatMSS(t)} / ${formatMSS(maxTime())}`;

    const res = resourcesAt(t);
    const gathered = gatherableResources();

    stats.innerHTML = (GAME.resources as string[])
        .map(
            (k: string) =>
                `<span class='res-stat'>${iconImg(resourceIconUrl(k), k)}<span>${Math.floor(Number(res[k] ?? 0))}</span></span>`,
        )
        .join("");

    const gatherers = gatherersAt(t);
    const villagerIcon = iconImg(entityIconUrl("villager"), "villager");
    gatherStats.innerHTML =
        villagerIcon +
        gathered
            .filter((k: string) => k in gatherers)
            .map(
                (k: string) =>
                    `<span class='res-stat'>${iconImg(resourceIconUrl(k), k)}<span>${gatherers[k]}</span></span>`,
            )
            .join("");
}

function buildTimeline(t: number, center = false): void {
    const mTime = maxTime();
    const scale = Number(pxPerSecond.value || 2);
    pxPerSecondReadout.textContent = `${round2(scale)} px/s`;
    const width = Math.max(720, Math.ceil(mTime * scale));
    const tickEvery = mTime > 1200 ? 120 : mTime > 600 ? 60 : mTime > 240 ? 30 : 10;

    const timelines: Record<string, EntityTimeline> = sim.entityTimelines ?? {};
    const entries: Array<{ entityId: string; timeline: EntityTimeline }> = Object.entries(timelines).map(
        ([entityId, timeline]) => ({ entityId, timeline }),
    );

    function entityStart(entry: (typeof entries)[number]): number {
        const starts = (entry.timeline.segments ?? []).map((seg) => Number(seg.start));
        if (starts.length === 0) return 0;
        return Math.min(...starts);
    }

    function isIdleOnly(entry: (typeof entries)[number]): boolean {
        const segs = entry.timeline.segments ?? [];
        return segs.length === 0 || segs.every((seg) => seg.kind === "idle");
    }

    const typeStartByType = new Map<string, number>();
    for (const entry of entries) {
        const cur = typeStartByType.get(entry.timeline.entityType);
        const start = entityStart(entry);
        if (cur === undefined || start < cur) typeStartByType.set(entry.timeline.entityType, start);
    }

    const sortFn = (a: (typeof entries)[number], b: (typeof entries)[number]) => {
        const typeStartA = typeStartByType.get(a.timeline.entityType) ?? 0;
        const typeStartB = typeStartByType.get(b.timeline.entityType) ?? 0;
        if (typeStartA !== typeStartB) return typeStartA - typeStartB;

        const typeNameCmp = a.timeline.entityType.localeCompare(b.timeline.entityType);
        if (typeNameCmp !== 0) return typeNameCmp;

        const entityStartA = entityStart(a);
        const entityStartB = entityStart(b);
        if (entityStartA !== entityStartB) return entityStartA - entityStartB;

        return a.entityId.localeCompare(b.entityId);
    };

    const activeEntries = entries.filter((e) => !isIdleOnly(e)).sort(sortFn);
    const idleEntries = entries.filter((e) => isIdleOnly(e)).sort(sortFn);
    const sortedEntries = [...activeEntries, ...idleEntries];

    const axisTicks: string[] = [];
    for (let x = 0; x <= mTime + 0.0001; x += tickEvery) {
        const left = round2(x * scale);
        axisTicks.push(`<div class='timeline-tick' style='left:${left}px'></div>`);
        axisTicks.push(`<div class='timeline-tick-label' style='left:${left}px'>${formatMSS(x)}</div>`);
    }

    const cursorLeft = round2(t * scale);
    const rowsHtml = sortedEntries
        .map((entry, i) => {
            const idle = activeEntries.length > 0 && i >= activeEntries.length;
            const segs = (entry.timeline.segments ?? []).map((seg) => {
                const left = round2(seg.start * scale);
                const w = Math.max(1, round2((seg.end - seg.start) * scale));
                const color = colorForSegment(seg.kind, seg.detail);
                const detailLabel = segmentLabel(seg.kind, seg.detail);
                const segIcon = w >= 20 ? iconImg(segmentIconUrl(seg.kind, seg.detail), "", "seg-icon") : "";
                const label = w >= 52 ? escapeHtml(detailLabel) : "";
                const title = escapeHtml(
                    `${entry.entityId} | ${seg.kind} ${detailLabel} | ${formatMSS(seg.start)}-${formatMSS(seg.end)}`,
                );
                return `<div class='timeline-seg' title='${title}' style='left:${left}px;width:${w}px;background:${color}'>${segIcon}${label}</div>`;
            });

            const labelTitle = escapeHtml(`${entry.entityId} (${entry.timeline.entityType})`);
            const entityIcon = iconImg(entityIconUrl(entry.timeline.entityType), entry.timeline.entityType);
            const rowClass = idle
                ? `timeline-row timeline-row--idle${i === activeEntries.length ? " timeline-row--idle-sep" : ""}`
                : "timeline-row";
            return `<div class='${rowClass}'><div class='timeline-label' title='${labelTitle}'>${entityIcon}${labelTitle}</div><div class='timeline-track' style='width:${width}px'><div class='timeline-cursor' style='left:${cursorLeft}px'></div>${segs.join("")}</div></div>`;
        })
        .join("");

    entityTimeline.innerHTML = `<div class='timeline-head'><div class='timeline-label-head'>entity</div><div class='timeline-axis' style='width:${width}px'><div class='timeline-cursor' style='left:${cursorLeft}px'></div>${axisTicks.join("")}</div></div>${rowsHtml}`;

    if (center) {
        entityTimeline.scrollLeft = Math.max(0, 180 + t * scale - entityTimeline.clientWidth / 2);
    }
}

function moveCursor(t: number, center = false): void {
    const scale = Number(pxPerSecond.value || 2);
    const left = `${round2(t * scale)}px`;
    for (const el of entityTimeline.querySelectorAll<HTMLElement>(".timeline-cursor")) {
        el.style.left = left;
    }
    if (center) {
        entityTimeline.scrollLeft = Math.max(0, 180 + t * scale - entityTimeline.clientWidth / 2);
    }
}

function syncTime(v: string | number): void {
    const t = Math.max(0, Math.min(maxTime(), Number(v) || 0));
    range.value = String(t);
    renderScrub(t);
    moveCursor(t, true);
}

function refreshAll(): void {
    const mTime = maxTime();
    range.max = String(mTime);
    renderTables();
    const t = Math.min(Number(range.value) || 0, mTime);
    range.value = String(t);
    buildTimeline(t);
    renderScrub(t);
}

function runFromDsl(): void {
    runBtn.disabled = true;
    runStatus.textContent = "running...";
    errorBox.textContent = "";

    try {
        const build = parseBuildOrderDsl(dslInput.value, {
            selectorAliases: createDslSelectorAliases(GAME.resources),
            symbols: createDslValidationSymbols(GAME),
            baseDslLines: createActionDslLines(GAME),
            civDslByName: createCivDslByName(GAME),
            rulesetDslByName: createRulesetDslByName(GAME),
            settingDslByName: createSettingDslByName(GAME),
        });
        sim = runSimulation(GAME, build, {
            strict: false,
            evaluationTime: build.evaluationTime,
            debtFloor: build.debtFloor ?? -30,
        });
        refreshAll();
        runStatus.textContent = "ok";
    } catch (err) {
        errorBox.textContent = String((err as Error)?.message ?? err);
        runStatus.textContent = "failed";
    } finally {
        runBtn.disabled = false;
    }
}

function syncPresetSelector(): void {
    const presets = BOOTSTRAP.buildOrderPresets ?? [];
    const current = dslInput.value.trim();
    const matched = presets.find((p) => p.dsl.trim() === current);
    buildPresetSelect.value = matched?.id ?? "";
}

function renderSavedBuilds(): void {
    const builds = loadSavedBuilds();
    if (builds.length === 0) {
        savedBuildsList.innerHTML = `<p class="muted" style="margin:0;font-size:13px">No saved builds yet.</p>`;
        return;
    }
    savedBuildsList.innerHTML = builds
        .map(
            (b) =>
                `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--line);border-radius:6px" data-id="${escapeHtml(b.id)}">` +
                `<span style="flex:1;font-size:13px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(b.label)}</span>` +
                `<button class="btn" data-action="load">Load</button>` +
                `<button class="btn" style="color:var(--error)" data-action="delete">Delete</button>` +
                `</div>`,
        )
        .join("");

    savedBuildsList.onclick = (ev) => {
        const btn = (ev.target as Element).closest<HTMLButtonElement>("[data-action]");
        if (!btn) return;
        const row = btn.closest<HTMLElement>("[data-id]");
        if (!row) return;
        const id = row.dataset.id!;
        if (btn.dataset.action === "load") {
            const build = loadSavedBuilds().find((b) => b.id === id);
            if (!build) return;
            dslInput.value = build.dsl;
            persistCustomDsl(build.dsl);
            syncPresetSelector();
            runFromDsl();
            document.getElementById("manageModal")!.classList.add("ai-hidden");
        } else if (btn.dataset.action === "delete") {
            persistSavedBuilds(loadSavedBuilds().filter((b) => b.id !== id));
            renderSavedBuilds();
        }
    };
}

function setupPresetSelector(): void {
    const presets: BuildOrderPreset[] = BOOTSTRAP.buildOrderPresets ?? [];

    const options = [`<option value="">Custom</option>`];
    if (presets.length > 0) {
        options.push(`<optgroup label="Presets">`);
        for (const preset of presets) {
            options.push(`<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`);
        }
        options.push(`</optgroup>`);
    }
    buildPresetSelect.innerHTML = options.join("");
    syncPresetSelector();

    buildPresetSelect.addEventListener("change", () => {
        const val = buildPresetSelect.value;
        if (val === "") {
            const saved = loadCustomDsl();
            if (saved !== null) {
                dslInput.value = saved;
                runFromDsl();
            }
            return;
        }
        const picked = presets.find((p: BuildOrderPreset) => p.id === val);
        if (!picked) return;
        dslInput.value = picked.dsl;
        runFromDsl();
    });

    dslInput.addEventListener("input", () => {
        syncPresetSelector();
        if (buildPresetSelect.value === "") {
            persistCustomDsl(dslInput.value);
        }
    });
}

// Set initial DSL content from bootstrap
if (BOOTSTRAP.initialDsl) {
    dslInput.value = BOOTSTRAP.initialDsl;
}

// Show AI elements if enabled
if (BOOTSTRAP.withLlm) {
    const aiTrigger = document.getElementById("aiOpenBtn");
    if (aiTrigger) aiTrigger.classList.add("visible");
}

runBtn.addEventListener("click", runFromDsl);
dslInput.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        runFromDsl();
    }
});
range.addEventListener("input", () => syncTime(range.value));
pxPerSecond.addEventListener("input", () => {
    const t = Math.max(0, Math.min(maxTime(), Number(range.value) || 0));
    buildTimeline(t, true);
    renderScrub(t);
});

entityTimeline.addEventListener("click", (ev) => {
    const clickable = (ev.target as Element).closest(".timeline-axis, .timeline-track");
    if (!clickable) return;
    const rect = clickable.getBoundingClientRect();
    const xInEl = ev.clientX - rect.left;
    const scale = Number(pxPerSecond.value || 2);
    syncTime(xInEl / scale);
});

shareBtn.addEventListener("click", async () => {
    const encoded = await compressDsl(dslInput.value);
    history.replaceState(null, "", `#z=${encoded}`);
    await navigator.clipboard.writeText(location.href);
    const prev = shareBtn.textContent;
    shareBtn.textContent = "Copied!";
    setTimeout(() => { shareBtn.textContent = prev; }, 2000);
});

manageBtn.addEventListener("click", () => {
    renderSavedBuilds();
    document.getElementById("manageModal")!.classList.remove("ai-hidden");
});

saveBuildName.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") saveBuildBtn.click();
});

saveBuildBtn.addEventListener("click", () => {
    const label = saveBuildName.value.trim();
    if (!label) { saveBuildName.focus(); return; }
    const builds = loadSavedBuilds();
    builds.push({ id: `custom_${Date.now()}`, label, dsl: dslInput.value });
    persistSavedBuilds(builds);
    saveBuildName.value = "";
    renderSavedBuilds();
});

(async () => {
    const match = /^#z=(.+)$/.exec(location.hash);
    let fromExternal = false;
    if (match) {
        try {
            dslInput.value = await decompressDsl(match[1]);
            fromExternal = true;
        } catch {
            // ignore malformed hash
        }
    }
    if (!fromExternal) {
        const customDsl = loadCustomDsl();
        if (customDsl !== null) {
            dslInput.value = customDsl;
            fromExternal = true;
        }
    }
    setupPresetSelector();
    if (fromExternal) {
        runFromDsl();
    } else {
        refreshAll();
    }
})();
