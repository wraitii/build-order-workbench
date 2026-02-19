import { GameData, SimulationResult } from "./types";
import { compareEntityIdNatural, EPS } from "./sim_shared";
import { readdir } from "fs/promises";
import { formatMMSS } from "./time_format";

export interface BuildOrderPreset {
    id: string;
    label: string;
    dsl: string;
}

const WITH_LLM = process.env.INCLUDE_LLM === "1";

let workbenchBundlePromise: Promise<string> | undefined;
let llmBundlePromise: Promise<string> | undefined;
let gameObjectsBundlePromise: Promise<string> | undefined;

function formatMap(map: Record<string, number>): string {
    return Object.entries(map)
        .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
        .join(", ");
}

const INTERNAL_REPORT_RESOURCES = new Set([
    "feudal",
    "dark_age_buildings",
    "feudal_age_buildings",
    "mill_built",
    "barracks_built",
]);

function stripInternalResources(map: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.entries(map).filter(([k]) => !INTERNAL_REPORT_RESOURCES.has(k)));
}

function formatIntMap(map: Record<string, number>): string {
    return Object.entries(map)
        .map(([k, v]) => `${k}: ${Math.round(v)}`)
        .join(", ");
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

async function getGameObjectsBundle(): Promise<string> {
    if (!gameObjectsBundlePromise) {
        gameObjectsBundlePromise = (async () => {
            const entrypoint = new URL("./game_objects.ts", import.meta.url).pathname;
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
                throw new Error(`Failed to build game objects bundle.\n${logs}`);
            }
            const js = await firstOutput.text();
            return js.replaceAll("</script>", "<\\/script>");
        })();
    }
    return gameObjectsBundlePromise;
}

export function toTextReport(result: SimulationResult): string {
    const lines: string[] = [];
    lines.push(`resources: ${formatMap(stripInternalResources(result.resourcesAtEvaluation))}`);
    lines.push(`gathered: ${formatMap(stripInternalResources(result.totalGathered))}`);
    lines.push(`avgFloat: ${formatMap(stripInternalResources(result.avgFloat))}`);
    lines.push(`entities: ${formatIntMap(result.entitiesByType)}`);
    lines.push(`tcIdleTime: ${formatMMSS(result.tcIdleTime)} (${result.tcIdleTime.toFixed(2)}s)`);
    lines.push(
        `totalVillagerIdleTime: ${formatMMSS(result.totalVillagerIdleTime)} (${result.totalVillagerIdleTime.toFixed(2)}s)`,
    );
    lines.push(`maxDebt: ${result.maxDebt.toFixed(2)}`);
    lines.push(`completedActions: ${result.completedActions}`);
    if (result.scores.length > 0) {
        const scoreLines = result.scores.map((s) => {
            const c = s.criterion;
            const cond = c.condition;
            const suffix = (c.count ?? 1) > 1 ? ` x${c.count}` : "";
            const label =
                cond.kind === "clicked" || cond.kind === "completed"
                    ? `${cond.kind} ${cond.actionId}${suffix}`
                    : `${cond.kind} ${cond.resourceNodeSelector}${suffix}`;
            const val = s.value !== null ? formatMMSS(s.value) : "—";
            return `  ${label}: ${val}`;
        });
        lines.push(`scores:\n${scoreLines.join("\n")}`);
    }
    lines.push(`warnings: ${result.violations.length}`);

    if (result.violations.length > 0) {
        lines.push("warningDetails:");
        for (const v of result.violations) {
            lines.push(`  - t=${formatMMSS(v.time)} [${v.code}] ${v.message}`);
        }
    }

    return lines.join("\n");
}

export function toEventLogLines(result: SimulationResult): string[] {
    return result.eventLogs.map((entry) => `${formatMMSS(entry.time)} [${entry.entityId}] switched to ${entry.to}`);
}

function resourcesAtTime(result: SimulationResult, t: number): Record<string, number> {
    if (!result.resourceTimeline || result.resourceTimeline.length === 0) return { ...result.initialResources };

    for (const seg of result.resourceTimeline) {
        if (t >= seg.start && t <= seg.end) {
            const dt = t - seg.start;
            const out = { ...seg.startResources };
            const gatherRates = (seg.gatherRates ?? {}) as Record<string, number>;
            for (const [k, rate] of Object.entries(gatherRates)) out[k] = (out[k] ?? 0) + rate * dt;
            return out;
        }
    }

    const firstSeg = result.resourceTimeline[0];
    if (firstSeg && t <= firstSeg.start) return { ...result.initialResources };
    return { ...result.resourcesAtEvaluation };
}

export function toResourceLogLines(result: SimulationResult, intervalSeconds = 30): string[] {
    const endTime = result.resourceTimeline[result.resourceTimeline.length - 1]?.end ?? 0;
    const safeInterval = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 30;

    const times: number[] = [];
    for (let t = 0; t <= endTime + 1e-9; t += safeInterval) {
        times.push(t);
    }
    const last = times[times.length - 1];
    if (last === undefined || Math.abs(last - endTime) > 1e-9) {
        times.push(endTime);
    }

    return times.map((time) => `${formatMMSS(time)} ${formatIntMap(resourcesAtTime(result, time))}`);
}

function activityAtTime(result: SimulationResult, entityId: string, t: number): string | null {
    const timeline = result.entityTimelines[entityId];
    if (!timeline) return null;
    for (let i = timeline.segments.length - 1; i >= 0; i -= 1) {
        const seg = timeline.segments[i];
        if (!seg) continue;
        if (t + EPS < seg.start) continue;
        if (t > seg.end + EPS) continue;
        if (seg.kind === "idle") return "idle";
        return `${seg.kind}:${seg.detail}`;
    }
    return null;
}

export function toActivityLogLines(result: SimulationResult, intervalSeconds = 30, atTime?: number): string[] {
    const endTime = result.resourceTimeline[result.resourceTimeline.length - 1]?.end ?? 0;
    const entityIds = Object.keys(result.entityTimelines).sort(compareEntityIdNatural);
    const times: number[] = [];

    if (atTime !== undefined) {
        times.push(Math.max(0, Math.min(endTime, atTime)));
    } else {
        const safeInterval = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 30;
        for (let t = 0; t <= endTime + EPS; t += safeInterval) {
            times.push(t);
        }
        const last = times[times.length - 1];
        if (last === undefined || Math.abs(last - endTime) > EPS) {
            times.push(endTime);
        }
    }

    return times.map((time) => {
        const entries: string[] = [];
        for (const entityId of entityIds) {
            const activity = activityAtTime(result, entityId, time);
            if (activity === null) continue;
            entries.push(`${entityId}: ${activity}`);
        }
        return `${formatMMSS(time)} ${entries.join(", ")}`;
    });
}

async function getBgDataUri(): Promise<string> {
    const imgPath = new URL("../public/forging.png", import.meta.url).pathname;
    const bytes = await Bun.file(imgPath).arrayBuffer();
    const b64 = Buffer.from(bytes).toString("base64");
    return `data:image/png;base64,${b64}`;
}

async function getFaviconDataUri(): Promise<string> {
    const imgPath = new URL("../public/favicon.png", import.meta.url).pathname;
    const bytes = await Bun.file(imgPath).arrayBuffer();
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function getIconDataUris(): Promise<Record<string, string>> {
    const aoe2Dir = new URL("../public/aoe2", import.meta.url).pathname;
    const files = await readdir(aoe2Dir);
    const priority = [".webp", ".jpg", ".jpeg", ".png"] as const;
    const mimeByExt: Record<string, string> = {
        ".webp": "image/webp",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
    };

    const bySlug = new Map<string, { file: string; ext: string }>();
    for (const file of files) {
        const lower = file.toLowerCase();
        const ext = priority.find((candidate) => lower.endsWith(candidate));
        if (!ext) continue;
        const slug = file.slice(0, -ext.length);
        const current = bySlug.get(slug);
        if (!current || priority.indexOf(ext) < priority.indexOf(current.ext as (typeof priority)[number])) {
            bySlug.set(slug, { file, ext });
        }
    }

    const entries = await Promise.all(
        Array.from(bySlug.entries()).map(async ([slug, selected]) => {
            const bytes = await Bun.file(`${aoe2Dir}/${selected.file}`).arrayBuffer();
            const mime = mimeByExt[selected.ext] ?? "application/octet-stream";
            return [slug, `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`] as const;
        }),
    );
    return Object.fromEntries(entries);
}

export async function toHtmlReport(
    result: SimulationResult,
    game: GameData,
    initialDsl: string,
    buildOrderPresets: BuildOrderPreset[] = [],
    gameObjectsHref = "#",
): Promise<string> {
    const [workbenchBundle, llmBundle, bgDataUri, faviconDataUri, iconDataUris, htmlTemplate, css] = await Promise.all([
        getWorkbenchBundle(),
        WITH_LLM ? getLLMBundle() : Promise.resolve(null),
        getBgDataUri(),
        getFaviconDataUri(),
        getIconDataUris(),
        Bun.file(new URL("./workbench.html", import.meta.url).pathname).text(),
        Bun.file(new URL("./workbench.css", import.meta.url).pathname).text(),
    ]);

    const bootstrapJson = scriptSafeJson({
        game,
        initialResult: result,
        buildOrderPresets,
        iconDataUris,
        initialDsl,
        withLlm: WITH_LLM,
    });

    let html = htmlTemplate;

    // Use function replacements throughout to avoid $& / $' special-pattern pitfalls
    // in String.prototype.replace() when replacement content contains literal `$`.

    // Inline CSS + inject background image as CSS variable
    const cssBlock = `<style>${css}</style>\n  <style>:root { --bg-image: url('${bgDataUri}') }</style>`;
    html = html.replace('<link rel="stylesheet" href="./workbench.css" />', () => cssBlock);
    html = html.replace('href="./favicon.png"', () => `href="${faviconDataUri}"`);
    html = html.replace(/__GAME_OBJECTS_HREF__/g, () => gameObjectsHref);

    // Inline workbench JS bundle
    html = html.replace('<script src="./workbench.ts"></script>', () => `<script>${workbenchBundle}</script>`);

    // Inject bootstrap JSON
    html = html.replace(">null</script>", () => `>${bootstrapJson}</script>`);

    // Inject LLM bundle before </body> if enabled
    if (llmBundle) {
        html = html.replace("</body>", () => `  <script type="module">${llmBundle}</script>\n</body>`);
    }

    return html;
}

export async function toGameObjectsHtml(game: GameData, timelineHref: string): Promise<string> {
    const [gameObjectsBundle, bgDataUri, faviconDataUri, iconDataUris, htmlTemplate, css] = await Promise.all([
        getGameObjectsBundle(),
        getBgDataUri(),
        getFaviconDataUri(),
        getIconDataUris(),
        Bun.file(new URL("./game_objects.html", import.meta.url).pathname).text(),
        Bun.file(new URL("./workbench.css", import.meta.url).pathname).text(),
    ]);

    const bootstrapJson = scriptSafeJson({
        game,
        iconDataUris,
        timelineHref,
    });

    let html = htmlTemplate;
    const cssBlock = `<style>${css}</style>\n  <style>:root { --bg-image: url('${bgDataUri}') }</style>`;
    html = html.replace('<link rel="stylesheet" href="./workbench.css" />', () => cssBlock);
    html = html.replace('href="./favicon.png"', () => `href="${faviconDataUri}"`);
    html = html.replace('<script src="./game_objects.ts"></script>', () => `<script>${gameObjectsBundle}</script>`);
    html = html.replace(">null</script>", () => `>${bootstrapJson}</script>`);

    return html;
}
