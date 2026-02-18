import { GameData, SimulationResult } from "./types";
import { readdir } from "fs/promises";

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
    const entries = await Promise.all(
        files
            .filter(f => f.endsWith(".png"))
            .map(async f => {
                const slug = f.slice(0, -4);
                const bytes = await Bun.file(`${aoe2Dir}/${f}`).arrayBuffer();
                return [slug, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`] as const;
            })
    );
    return Object.fromEntries(entries);
}

export async function toHtmlReport(
    result: SimulationResult,
    game: GameData,
    initialDsl: string,
    buildOrderPresets: BuildOrderPreset[] = [],
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
