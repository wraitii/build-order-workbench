import { runSimulation } from "./sim";
import {
    BuildOrderPreset,
    LLMBenchmarkDataset,
    toActivityLogLines,
    toEventLogLines,
    toGameObjectsHtml,
    toHtmlReport,
    toLLMBenchmarksHtml,
    toResourceLogLines,
    toTextReport,
} from "./report";
import { GameData } from "./types";
import {
    createActionDslLines,
    createCivDslByName,
    createDslValidationSymbols,
    createParseBuildOrderDslOptions,
    createRulesetDslByName,
    createSettingDslByName,
    parseBuildOrderDsl,
} from "./dsl";
import { createDslSelectorAliases } from "./node_selectors";
import { normalizeGame } from "./sim_shared";
import { readdir } from "node:fs/promises";

interface Args {
    game: string;
    build: string;
    report?: string;
    strict: boolean;
    debtFloor?: number;
    at?: number;
    eventLog?: string | true;
    resourceLog?: string | true;
    activityLogAt?: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        game: "data/aoe2-game.json",
        build: "data/aoe2-scout-build-order.dsl",
        strict: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const cur = argv[i];
        const next = argv[i + 1];

        if (cur === "--game" && next) {
            args.game = next;
            i += 1;
        } else if (cur === "--build" && next) {
            args.build = next;
            i += 1;
        } else if (cur === "--report" && next) {
            args.report = next;
            i += 1;
        } else if (cur === "--strict") {
            args.strict = true;
        } else if (cur === "--debt-floor" && next) {
            args.debtFloor = Number(next);
            i += 1;
        } else if (cur === "--at" && next) {
            args.at = Number(next);
            i += 1;
        } else if (cur === "--event-log") {
            if (next && !next.startsWith("--")) {
                args.eventLog = next;
                i += 1;
            } else {
                args.eventLog = true;
            }
        } else if (cur === "--resource-log") {
            if (next && !next.startsWith("--")) {
                args.resourceLog = next;
                i += 1;
            } else {
                args.resourceLog = true;
            }
        } else if (cur === "--activity-log-at" && next) {
            args.activityLogAt = parseCliTime(next, cur);
            i += 1;
        }
    }

    return args;
}

function parseCliTime(raw: string, flagName: string): number {
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    const match = raw.match(/^(\d+):(\d{1,2})$/);
    if (match) {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        if (seconds >= 60) throw new Error(`Invalid ${flagName} value '${raw}': seconds must be < 60.`);
        return minutes * 60 + seconds;
    }
    throw new Error(`Invalid ${flagName} value '${raw}': expected seconds or mm:ss.`);
}

async function loadJson<T>(path: string): Promise<T> {
    return Bun.file(path).json() as Promise<T>;
}

function deriveGameObjectsReportPath(reportPath: string): string {
    if (reportPath.toLowerCase().endsWith(".html")) {
        return reportPath.replace(/\.html$/i, "-game-objects.html");
    }
    return `${reportPath}-game-objects.html`;
}

function deriveLLMBenchmarksReportPath(reportPath: string): string {
    const slashIndex = reportPath.lastIndexOf("/");
    const dir = slashIndex >= 0 ? reportPath.slice(0, slashIndex + 1) : "";
    return `${dir}aoe2-llm-benchmarks.html`;
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));

    const game = await loadJson<GameData>(args.game);
    normalizeGame(game);
    const buildDsl = await Bun.file(args.build).text();
    const build = parseBuildOrderDsl(buildDsl, createParseBuildOrderDslOptions({
        selectorAliases: createDslSelectorAliases(game.resources),
        symbols: createDslValidationSymbols(game),
        baseDslLines: createActionDslLines(game),
        civDslByName: createCivDslByName(game),
        rulesetDslByName: createRulesetDslByName(game),
        settingDslByName: createSettingDslByName(game),
    }));

    const evaluationTime = args.at ?? build.evaluationTime;
    const debtFloor = args.strict ? 0 : (args.debtFloor ?? build.debtFloor ?? -30);

    const result = runSimulation(game, build, {
        strict: args.strict,
        evaluationTime,
        debtFloor,
        captureEventLog: Boolean(args.eventLog),
    });

    console.log(toTextReport(result));
    if (args.eventLog) {
        const lines = toEventLogLines(result);
        if (typeof args.eventLog === "string") {
            const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
            await Bun.write(args.eventLog, body);
            console.log(`wrote event log: ${args.eventLog}`);
        } else {
            console.log("eventLog:");
            for (const line of lines) console.log(line);
        }
    }
    if (args.resourceLog) {
        const lines = toResourceLogLines(result, 30);
        if (typeof args.resourceLog === "string") {
            const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
            await Bun.write(args.resourceLog, body);
            console.log(`wrote resource log: ${args.resourceLog}`);
        } else {
            console.log("resourceLog:");
            for (const line of lines) console.log(line);
        }
    }
    if (args.activityLogAt !== undefined) {
        const lines = toActivityLogLines(result, 30, args.activityLogAt);
        console.log("activityLog:");
        for (const line of lines) console.log(line);
    }

    if (args.report) {
        const presetPaths = (await readdir("data"))
            .filter((name) => name.toLowerCase().endsWith(".dsl"))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => `data/${name}`);
        const presets: BuildOrderPreset[] = [];
        for (const path of presetPaths) {
            const file = Bun.file(path);
            if (!(await file.exists())) continue;
            const dsl = await file.text();
            const base = path.split("/").pop() ?? path;
            const label = base
                .replace(/\.dsl$/i, "")
                .replace(/^aoe2-/, "")
                .replace(/-/g, " ");
            presets.push({ id: base, label, dsl });
        }

        const gameObjectsReport = deriveGameObjectsReportPath(args.report);
        const llmBenchmarksReport = deriveLLMBenchmarksReportPath(args.report);
        const llmBenchmarksDataFile = Bun.file("benchmarks/aoe2-llm/results.json");
        const llmPromptFile = Bun.file("benchmarks/aoe2-llm/prompt.txt");
        let llmBenchmarks: LLMBenchmarkDataset = {
            rows: [],
        };
        if (await llmBenchmarksDataFile.exists()) {
            llmBenchmarks = await llmBenchmarksDataFile.json() as LLMBenchmarkDataset;
        }
        if (!llmBenchmarks.prompt && await llmPromptFile.exists()) {
            llmBenchmarks.prompt = await llmPromptFile.text();
        }

        await Bun.write(
            args.report,
            await toHtmlReport(
                result,
                game,
                buildDsl,
                presets,
                gameObjectsReport.split("/").pop() ?? gameObjectsReport,
                llmBenchmarksReport.split("/").pop() ?? llmBenchmarksReport,
            ),
        );
        await Bun.write(gameObjectsReport, await toGameObjectsHtml(game, args.report.split("/").pop() ?? args.report));
        await Bun.write(
            llmBenchmarksReport,
            await toLLMBenchmarksHtml(
                llmBenchmarks,
                args.report.split("/").pop() ?? args.report,
                gameObjectsReport.split("/").pop() ?? gameObjectsReport,
            ),
        );
        console.log(`wrote html report: ${args.report}`);
        console.log(`wrote game objects report: ${gameObjectsReport}`);
        console.log(`wrote llm benchmarks report: ${llmBenchmarksReport}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
