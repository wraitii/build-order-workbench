import { runSimulation } from "./sim";
import { BuildOrderPreset, toHtmlReport, toTextReport } from "./report";
import { GameData } from "./types";
import { createCivDslByName, createDslValidationSymbols, parseBuildOrderDsl } from "./dsl";
import { createDslSelectorAliases } from "./node_selectors";
import { normalizeGame } from "./sim_shared";

interface Args {
    game: string;
    build: string;
    report?: string;
    strict: boolean;
    debtFloor?: number;
    at?: number;
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
        }
    }

    return args;
}

async function loadJson<T>(path: string): Promise<T> {
    return Bun.file(path).json() as Promise<T>;
}

async function main(): Promise<void> {
    const args = parseArgs(Bun.argv.slice(2));

    const game = await loadJson<GameData>(args.game);
    normalizeGame(game);
    const buildDsl = await Bun.file(args.build).text();
    const build = parseBuildOrderDsl(buildDsl, {
        selectorAliases: createDslSelectorAliases(game.resources),
        symbols: createDslValidationSymbols(game),
        civDslByName: createCivDslByName(game),
    });

    const evaluationTime = args.at ?? build.evaluationTime;
    const debtFloor = args.strict ? 0 : (args.debtFloor ?? build.debtFloor ?? -30);

    const result = runSimulation(game, build, {
        strict: args.strict,
        evaluationTime,
        debtFloor,
    });

    console.log(toTextReport(result));

    if (args.report) {
        const presetPaths = [
            "data/aoe2-scout-build-order.dsl",
            "data/aoe2-mongol-scout-rush.dsl",
            "data/aoe2-archer-rush-build-order.dsl",
            "data/aoe2-maa-into-archer-old.dsl",
        ];
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

        await Bun.write(args.report, await toHtmlReport(result, game, buildDsl, presets));
        console.log(`wrote html report: ${args.report}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
