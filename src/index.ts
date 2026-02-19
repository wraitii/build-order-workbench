import { runSimulation } from "./sim";
import { BuildOrderPreset, toEventLogLines, toGameObjectsHtml, toHtmlReport, toTextReport } from "./report";
import { GameData } from "./types";
import { createActionDslLines, createCivDslByName, createDslValidationSymbols, createRulesetDslByName, createSettingDslByName, parseBuildOrderDsl } from "./dsl";
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
        }
    }

    return args;
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

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));

    const game = await loadJson<GameData>(args.game);
    normalizeGame(game);
    const buildDsl = await Bun.file(args.build).text();
    const build = parseBuildOrderDsl(buildDsl, {
        selectorAliases: createDslSelectorAliases(game.resources),
        symbols: createDslValidationSymbols(game),
        baseDslLines: createActionDslLines(game),
        civDslByName: createCivDslByName(game),
        rulesetDslByName: createRulesetDslByName(game),
        settingDslByName: createSettingDslByName(game),
    });

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

        await Bun.write(args.report, await toHtmlReport(result, game, buildDsl, presets, gameObjectsReport.split("/").pop() ?? gameObjectsReport));
        await Bun.write(gameObjectsReport, await toGameObjectsHtml(game, args.report.split("/").pop() ?? args.report));
        console.log(`wrote html report: ${args.report}`);
        console.log(`wrote game objects report: ${gameObjectsReport}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
