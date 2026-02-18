import { parseBuildOrderDsl } from "./dsl";
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

// Explicit slug overrides — add entries when the auto-generated name doesn't match aoe2database.com.
// Entity overrides: key = entity id, value = icon slug (without extension)
const ENTITY_ICON_SLUGS: Record<string, string> = {
    villager: "u_male_villager",
};

// Resource-node overrides: key = node prototype id, value = icon slug
const NODE_ICON_SLUGS: Record<string, string> = {
    sheep: "u_sheep",
    boar: "u_boar",
    boar_lured: "u_boar",
    wild_deer: "u_deer",
    deer: "u_deer",
    berries: "u_bush",
};

// Action overrides: key = action id, value = icon slug
const ACTION_ICON_SLUGS: Record<string, string> = {
    lure_boar: "u_boar",
    lure_deer: "u_deer",
};

// Resource overrides: key = resource id, value = icon slug
const RESOURCE_ICON_SLUGS: Record<string, string> = {
    pop: "b_town_center",
};

function iconUrl(slug: string): string {
    return BOOTSTRAP.iconDataUris?.[slug] ?? "";
}

function entityIconUrl(entityType: string): string {
    const slug = ENTITY_ICON_SLUGS[entityType];
    if (slug) return iconUrl(slug);
    const def = GAME.entities[entityType];
    if (!def) return "";
    const prefix = def.kind === "unit" ? "u" : "b";
    return iconUrl(`${prefix}_${entityType}`);
}

function resourceIconUrl(resource: string): string {
    const slug = RESOURCE_ICON_SLUGS[resource];
    return iconUrl(slug ?? `r_${resource}`);
}

function segmentIconUrl(kind: string, detail: string): string {
    if (kind === "gather") {
        const [resource = "", nodeId] = detail.split(":");
        const nodeSlug = nodeId && NODE_ICON_SLUGS[nodeId];
        return nodeSlug ? iconUrl(nodeSlug) : resourceIconUrl(resource);
    }
    if (kind === "action") {
        const actionSlug = ACTION_ICON_SLUGS[detail];
        if (actionSlug) return iconUrl(actionSlug);
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
    scoresCard.style.display = scores.length === 0 ? "none" : "";
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
    const timeline = sim.resourceTimeline ?? [];
    const resources: string[] = GAME.resources;
    const mTime = maxTime();
    const step = 5;

    const totalGathered: Record<string, number> = {};
    const negativeResDuration: Record<string, number> = {};
    const negativeResMax: Record<string, number> = {};

    for (const seg of timeline) {
        const dt = seg.end - seg.start;
        const gatherRates = (seg.gatherRates ?? {}) as Record<string, number>;
        for (const [res, rate] of Object.entries(gatherRates)) {
            if (rate > 0) totalGathered[res] = (totalGathered[res] ?? 0) + rate * dt;
        }
        for (const res of resources) {
            const startVal = seg.startResources[res] ?? 0;
            if (startVal < 0) {
                negativeResMax[res] = Math.min(negativeResMax[res] ?? 0, startVal);
                const rate = gatherRates[res] ?? 0;
                const debtDuration = rate > 0 ? Math.min(dt, -startVal / rate) : dt;
                negativeResDuration[res] = (negativeResDuration[res] ?? 0) + debtDuration;
            }
        }
    }

    const avgs = timeWeightedAverages(mTime);

    const chipsHtml = resources
        .map((res: string) => {
            const gathered = totalGathered[res] ?? 0;
            const debt = negativeResMax[res] ?? 0;
            const debtTime = negativeResDuration[res] ?? 0;
            const avg = avgs[res] ?? 0;
            const icon = iconImg(resourceIconUrl(res), res);
            const debtHtml =
                debt < -0.01
                    ? `<div class="health-chip-debt">peak debt: ${round2(debt)} (${formatMSS(debtTime)})</div>`
                    : "";
            return `<div class="health-chip">
  <div class="health-chip-label">${icon}${escapeHtml(res)}</div>
  <div class="health-chip-val">${round2(gathered)}</div>
  <div class="health-chip-sub">gathered total</div>
  <div class="health-chip-avg">avg balance ${round2(avg)}</div>${debtHtml}
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

function timeWeightedAverages(mTime: number): Record<string, number> {
    if (mTime <= 0) return {};
    const sums: Record<string, number> = {};
    for (const seg of sim.resourceTimeline ?? []) {
        const dt = seg.end - seg.start;
        if (dt <= 0) continue;
        const rates = (seg.gatherRates ?? {}) as Record<string, number>;
        for (const res of GAME.resources as string[]) {
            const v0 = seg.startResources[res] ?? 0;
            const rate = rates[res] ?? 0;
            sums[res] = (sums[res] ?? 0) + v0 * dt + 0.5 * rate * dt * dt;
        }
    }
    const result: Record<string, number> = {};
    for (const res of GAME.resources as string[]) {
        result[res] = (sums[res] ?? 0) / mTime;
    }
    return result;
}

function resourceGraph(resource: string, mTime: number, step: number): string {
    if (mTime <= 0) return "";
    const samples: Array<[number, number]> = [];
    for (let t = 0; t <= mTime + 0.001; t += step) {
        samples.push([t, resourcesAt(t)[resource] ?? 0]);
    }
    if (samples.length < 2) return "";

    const vw = 200, vh = 72;
    const padL = 30, padR = 4, padT = 4, padB = 16;
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
        .map((v) => `<text x="${padL - 3}" y="${round2(toY(v) + 3)}" font-size="8" text-anchor="end" fill="currentColor" opacity="0.5">${Math.round(v)}</text>`)
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
    gatherStats.innerHTML = villagerIcon + gathered
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
                const segIcon = w >= 20 ? iconImg(segmentIconUrl(seg.kind, seg.detail), "", "seg-icon") : "";
                const label = w >= 52 ? escapeHtml(seg.detail) : "";
                const title = escapeHtml(
                    `${entry.entityId} | ${seg.kind} ${seg.detail} | ${formatMSS(seg.start)}-${formatMSS(seg.end)}`,
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

function setupPresetSelector(): void {
    const presets: BuildOrderPreset[] = BOOTSTRAP.buildOrderPresets ?? [];
    const options = [];
    for (const preset of presets) {
        options.push(`<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`);
    }
    buildPresetSelect.innerHTML = options.join("");

    const initial = dslInput.value.trim();
    const matched = presets.find((p: BuildOrderPreset) => p.dsl.trim() === initial);
    buildPresetSelect.value = matched?.id ?? "";

    buildPresetSelect.addEventListener("change", () => {
        const picked = presets.find((p: BuildOrderPreset) => p.id === buildPresetSelect.value);
        if (!picked) return;
        dslInput.value = picked.dsl;
        runFromDsl();
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

setupPresetSelector();
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

refreshAll();
