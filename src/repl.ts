import { watch } from "node:fs";
import { runSimulation } from "./sim";
import { toTextReport } from "./report";
import { GameData } from "./types";
import { parseBuildOrderDsl } from "./dsl";
import { createDslSelectorAliases } from "./node_selectors";

interface Args {
  game: string;
  build: string;
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

async function loadGame(path: string): Promise<GameData> {
  return Bun.file(path).json() as Promise<GameData>;
}

async function runOnce(args: Args): Promise<void> {
  const game = await loadGame(args.game);
  const build = parseBuildOrderDsl(await Bun.file(args.build).text(), {
    selectorAliases: createDslSelectorAliases(game.resources),
  });

  const evaluationTime = args.at ?? build.evaluationTime;
  const debtFloor = args.strict ? 0 : args.debtFloor ?? build.debtFloor ?? -30;

  const result = runSimulation(game, build, {
    strict: args.strict,
    evaluationTime,
    debtFloor,
  });

  const ts = new Date().toLocaleTimeString();
  console.log(`\n[${ts}] ${args.build}`);
  console.log(toTextReport(result));
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
