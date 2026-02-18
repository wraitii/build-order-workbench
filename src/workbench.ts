import { parseBuildOrderDsl } from "./dsl";
import { runSimulation } from "./sim";
import { EntityTimeline, GameData, ScoreCriterion, ScoreResult, SimulationResult } from "./types";
import { createDslSelectorAliases } from "./node_selectors";

interface BuildOrderPreset {
    id: string;
    label: string;
    dsl: string;
}

declare global {
    interface Window {
        __WORKBENCH_BOOTSTRAP__?: {
            game: GameData;
            initialResult: SimulationResult;
            buildOrderPresets?: BuildOrderPreset[];
        };
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

const bootstrap = window.__WORKBENCH_BOOTSTRAP__;
if (!bootstrap) {
    throw new Error("Workbench bootstrap data is missing.");
}
const BOOTSTRAP = bootstrap;

const GAME = BOOTSTRAP.game;
let sim = BOOTSTRAP.initialResult;

const BASE_ICON = "https://www.aoe2database.com/images";

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
    berries: "u_bush",
};

function entityIconUrl(entityType: string): string {
    const slug = ENTITY_ICON_SLUGS[entityType];
    if (slug) return `${BASE_ICON}/${slug}.png`;
    const def = GAME.entities[entityType];
    if (!def) return "";
    const prefix = def.kind === "unit" ? "u" : "b";
    return `${BASE_ICON}/${prefix}_${entityType}.png`;
}

function resourceIconUrl(resource: string): string {
    return `${BASE_ICON}/r_${resource}.png`;
}

function segmentIconUrl(kind: string, detail: string): string {
    if (kind === "gather") {
        const [resource = "", nodeId] = detail.split(":");
        const nodeSlug = nodeId && NODE_ICON_SLUGS[nodeId];
        return nodeSlug ? `${BASE_ICON}/${nodeSlug}.png` : resourceIconUrl(resource);
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
        return `${BASE_ICON}/t_${techSlug}.png`;
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

const range = mustElement<HTMLInputElement>("timeRange");
const readout = mustElement<HTMLElement>("timeReadout");
const stats = mustElement<HTMLElement>("scrubStats");

const entityTimeline = mustElement<HTMLElement>("entityTimeline");
const timelineLegend = mustElement<HTMLElement>("timelineLegend");
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

    const chipsHtml = resources
        .map((res: string) => {
            const gathered = totalGathered[res] ?? 0;
            const debt = negativeResMax[res] ?? 0;
            const debtTime = negativeResDuration[res] ?? 0;
            const icon = iconImg(resourceIconUrl(res), res);
            const debtHtml =
                debt < -0.01
                    ? `<div class="health-chip-debt">peak debt: ${round2(debt)} (${formatMSS(debtTime)})</div>`
                    : "";
            return `<div class="health-chip">
  <div class="health-chip-label">${icon}${escapeHtml(res)}</div>
  <div class="health-chip-val">${round2(gathered)}</div>
  <div class="health-chip-sub">gathered total</div>${debtHtml}
</div>`;
        })
        .join("");

    const mTime = maxTime();
    const step = 5;
    const headerCols = resources.map((r: string) => `<th>${escapeHtml(r)}</th>`).join("");
    const rows: string[] = [];
    for (let t = 0; t <= mTime + 0.001; t += step) {
        const res = resourcesAt(t);
        const cols = resources.map((r: string) => `<td>${round2(res[r] ?? 0)}</td>`).join("");
        rows.push(`<tr><td>${formatMSS(t)}</td>${cols}</tr>`);
    }

    healthContent.innerHTML = `<div class="health-grid">${chipsHtml}</div>
<details>
  <summary>Resources every ${step}s</summary>
  <div class="res-table-wrap">
    <table>
      <thead><tr><th>time</th>${headerCols}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </div>
</details>`;
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

function renderScrub(t: number): void {
    readout.textContent = `${formatMSS(t)} / ${formatMSS(maxTime())}`;
    const res = resourcesAt(t);
    const entries = Object.entries(res);
    stats.innerHTML =
        entries.length > 0
            ? entries
                  .map(
                      ([k, v]: [string, number]) =>
                          `<span class='res-stat'>${iconImg(resourceIconUrl(k), k)}<span>${escapeHtml(k)}: ${round2(Number(v))}</span></span>`,
                  )
                  .join("")
            : "";
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

    const typeStartByType = new Map<string, number>();
    for (const entry of entries) {
        const cur = typeStartByType.get(entry.timeline.entityType);
        const start = entityStart(entry);
        if (cur === undefined || start < cur) typeStartByType.set(entry.timeline.entityType, start);
    }

    entries.sort((a, b) => {
        const typeStartA = typeStartByType.get(a.timeline.entityType) ?? 0;
        const typeStartB = typeStartByType.get(b.timeline.entityType) ?? 0;
        if (typeStartA !== typeStartB) return typeStartA - typeStartB;

        const typeNameCmp = a.timeline.entityType.localeCompare(b.timeline.entityType);
        if (typeNameCmp !== 0) return typeNameCmp;

        const entityStartA = entityStart(a);
        const entityStartB = entityStart(b);
        if (entityStartA !== entityStartB) return entityStartA - entityStartB;

        return a.entityId.localeCompare(b.entityId);
    });

    const legends = new Map<string, { kind: string; detail: string; color: string }>();
    for (const e of entries) {
        for (const seg of e.timeline.segments ?? []) {
            const key = `${seg.kind}:${seg.detail}`;
            if (!legends.has(key))
                legends.set(key, { kind: seg.kind, detail: seg.detail, color: colorForSegment(seg.kind, seg.detail) });
        }
    }

    timelineLegend.innerHTML = Array.from(legends.values())
        .slice(0, 18)
        .map((item) => {
            const icon = iconImg(segmentIconUrl(item.kind, item.detail));
            return `<span class='legend-item'><span class='legend-swatch' style='background:${item.color}'></span>${icon}${escapeHtml(`${item.kind} ${item.detail}`)}</span>`;
        })
        .join("");

    const axisTicks: string[] = [];
    for (let x = 0; x <= mTime + 0.0001; x += tickEvery) {
        const left = round2(x * scale);
        axisTicks.push(`<div class='timeline-tick' style='left:${left}px'></div>`);
        axisTicks.push(`<div class='timeline-tick-label' style='left:${left}px'>${formatMSS(x)}</div>`);
    }

    const cursorLeft = round2(t * scale);
    const rowsHtml = entries
        .map((entry) => {
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
            return `<div class='timeline-row'><div class='timeline-label' title='${labelTitle}'>${entityIcon}${labelTitle}</div><div class='timeline-track' style='width:${width}px'><div class='timeline-cursor' style='left:${cursorLeft}px'></div>${segs.join("")}</div></div>`;
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
    const options = ["<option value=''>custom</option>"];
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
