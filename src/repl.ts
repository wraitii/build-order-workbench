import { watch } from "node:fs";
import { runSimulation } from "./sim";
import { toActivityLogLines, toEventLogLines, toResourceLogLines, toTextReport } from "./report";
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

interface Args {
    game: string;
    build: string;
    strict: boolean;
    debtFloor?: number;
    at?: number;
    eventLog: boolean;
    resourceLog: boolean;
    activityLogAt?: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        game: "data/aoe2-game.json",
        build: "data/aoe2-scout-build-order.dsl",
        strict: false,
        eventLog: false,
        resourceLog: false,
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
        } else if (cur === "--strict") {
            args.strict = true;
        } else if (cur === "--debt-floor" && next) {
            args.debtFloor = Number(next);
            i += 1;
        } else if (cur === "--at" && next) {
            args.at = Number(next);
            i += 1;
        } else if (cur === "--event-log") {
            args.eventLog = true;
        } else if (cur === "--resource-log") {
            args.resourceLog = true;
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

async function loadGame(path: string): Promise<GameData> {
    const game = await (Bun.file(path).json() as Promise<GameData>);
    normalizeGame(game);
    return game;
}

async function runOnce(args: Args): Promise<void> {
    const game = await loadGame(args.game);
    const build = parseBuildOrderDsl(await Bun.file(args.build).text(), createParseBuildOrderDslOptions({
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
        captureEventLog: args.eventLog,
    });

    const ts = new Date().toLocaleTimeString();
    console.log(`\n[${ts}] ${args.build}`);
    console.log(toTextReport(result));
    if (args.eventLog) {
        console.log("eventLog:");
        for (const line of toEventLogLines(result)) console.log(line);
    }
    if (args.resourceLog) {
        console.log("resourceLog:");
        for (const line of toResourceLogLines(result, 30)) console.log(line);
    }
    if (args.activityLogAt !== undefined) {
        console.log("activityLog:");
        for (const line of toActivityLogLines(result, 30, args.activityLogAt)) console.log(line);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));
    let timer: ReturnType<typeof setTimeout> | undefined;

    const rerun = async (): Promise<void> => {
        try {
            await runOnce(args);
        } catch (error) {
            console.error(error);
        }
    };

    await rerun();
    console.log(`\nwatching: ${args.build}`);

    watch(args.build, { persistent: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            void rerun();
        }, 100);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
