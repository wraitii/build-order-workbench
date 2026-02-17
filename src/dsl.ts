import { BuildOrderCommand, BuildOrderInput } from "./types";

function parseNumber(token: string, lineNo: number): number {
  const n = Number(token);
  if (!Number.isFinite(n)) throw new Error(`Line ${lineNo}: invalid number '${token}'.`);
  return n;
}

function parseSelectors(tokens: string[]): string[] {
  return tokens.map((raw) => {
    if (raw.includes(":")) return raw;
    if (raw === "food" || raw === "wood" || raw === "gold" || raw === "stone") return `res:${raw}`;
    if (raw === "farm") return "tag:farm";
    return `proto:${raw}`;
  });
}

function parseAtPrefix(tokens: string[], lineNo: number): { at: number; rest: string[] } {
  if (tokens[0] !== "at" || tokens.length < 3) throw new Error(`Line ${lineNo}: expected 'at <time> ...'.`);
  return { at: parseNumber(tokens[1] ?? "", lineNo), rest: tokens.slice(2) };
}

export function parseBuildOrderDsl(input: string): BuildOrderInput {
  const commands: BuildOrderCommand[] = [];
  let evaluationTime: number | undefined;
  let debtFloor: number | undefined;

  const lines = input.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = idx + 1;
    const raw = lines[idx] ?? "";
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    if (tokens[0] === "evaluation") {
      if (!tokens[1]) throw new Error(`Line ${lineNo}: missing evaluation time.`);
      evaluationTime = parseNumber(tokens[1], lineNo);
      continue;
    }
    if (tokens[0] === "debt-floor") {
      if (!tokens[1]) throw new Error(`Line ${lineNo}: missing debt floor value.`);
      debtFloor = parseNumber(tokens[1], lineNo);
      continue;
    }

    const { at, rest } = parseAtPrefix(tokens, lineNo);
    const op = rest[0];

    if (op === "queue") {
      if (!rest[1]) throw new Error(`Line ${lineNo}: missing action id.`);
      const actionId = rest[1];
      let count: number | undefined;
      let actorType: string | undefined;

      for (let i = 2; i < rest.length; i += 1) {
        const t = rest[i];
        if (!t) continue;

        if (t === "x") {
          const n = rest[i + 1];
          if (!n) throw new Error(`Line ${lineNo}: missing count after 'x'.`);
          count = parseNumber(n, lineNo);
          i += 1;
          continue;
        }
        if (t.startsWith("x")) {
          count = parseNumber(t.slice(1), lineNo);
          continue;
        }
        if (t === "using") {
          const a = rest[i + 1];
          if (!a) throw new Error(`Line ${lineNo}: missing actor type after 'using'.`);
          actorType = a;
          i += 1;
          continue;
        }
        throw new Error(`Line ${lineNo}: unknown queue token '${t}'.`);
      }

      const cmd: Extract<BuildOrderCommand, { type: "queueAction" }> = { type: "queueAction", at, actionId };
      if (count !== undefined) cmd.count = count;
      if (actorType !== undefined) cmd.actorType = actorType;
      commands.push(cmd);
      continue;
    }

    if (op === "assign") {
      const actorType = rest[1];
      const countToken = rest[2];
      if (!actorType || !countToken) throw new Error(`Line ${lineNo}: expected 'assign <actorType> <count> to ...'.`);
      const toIdx = rest.indexOf("to");
      if (toIdx < 0 || toIdx + 1 >= rest.length) throw new Error(`Line ${lineNo}: assign requires 'to <selectors...>'.`);
      const selectors = parseSelectors(rest.slice(toIdx + 1));
      commands.push({
        type: "assignGather",
        at,
        actorType,
        count: parseNumber(countToken, lineNo),
        resourceNodeSelectors: selectors,
      });
      continue;
    }

    if (op === "auto-queue") {
      const actionId = rest[1];
      if (!actionId) throw new Error(`Line ${lineNo}: missing action id for auto-queue.`);
      let actorType: string | undefined;
      let retryEvery: number | undefined;
      let until: number | undefined;
      let maxRuns: number | undefined;

      for (let i = 2; i < rest.length; i += 1) {
        const t = rest[i];
        if (!t) continue;

        if (t === "using") {
          const a = rest[i + 1];
          if (!a) throw new Error(`Line ${lineNo}: missing actor type after 'using'.`);
          actorType = a;
          i += 1;
          continue;
        }
        if (t === "every") {
          const n = rest[i + 1];
          if (!n) throw new Error(`Line ${lineNo}: missing seconds after 'every'.`);
          retryEvery = parseNumber(n, lineNo);
          i += 1;
          continue;
        }
        if (t === "until") {
          const n = rest[i + 1];
          if (!n) throw new Error(`Line ${lineNo}: missing seconds after 'until'.`);
          until = parseNumber(n, lineNo);
          i += 1;
          continue;
        }
        if (t === "max") {
          const n = rest[i + 1];
          if (!n) throw new Error(`Line ${lineNo}: missing count after 'max'.`);
          maxRuns = parseNumber(n, lineNo);
          i += 1;
          continue;
        }
        throw new Error(`Line ${lineNo}: unknown auto-queue token '${t}'.`);
      }

      const cmd: Extract<BuildOrderCommand, { type: "autoQueue" }> = { type: "autoQueue", at, actionId };
      if (actorType !== undefined) cmd.actorType = actorType;
      if (retryEvery !== undefined) cmd.retryEvery = retryEvery;
      if (until !== undefined) cmd.until = until;
      if (maxRuns !== undefined) cmd.maxRuns = maxRuns;
      commands.push(cmd);
      continue;
    }

    if (op === "spawn-assign") {
      const entityType = rest[1];
      const toIdx = rest.indexOf("to");
      if (!entityType || toIdx < 0 || toIdx + 1 >= rest.length) {
        throw new Error(`Line ${lineNo}: expected 'spawn-assign <entityType> to <selectors...>'.`);
      }
      commands.push({
        type: "setSpawnGather",
        at,
        entityType,
        resourceNodeSelectors: parseSelectors(rest.slice(toIdx + 1)),
      });
      continue;
    }

    if (op === "shift") {
      const actorType = rest[1];
      const countToken = rest[2];
      const fromIdx = rest.indexOf("from");
      const toIdx = rest.indexOf("to");
      if (!actorType || !countToken || fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx + 1) {
        throw new Error(`Line ${lineNo}: expected 'shift <actorType> <count> from <selectors...> to <selectors...>'.`);
      }
      const fromSelectors = parseSelectors(rest.slice(fromIdx + 1, toIdx));
      const toSelectors = parseSelectors(rest.slice(toIdx + 1));
      if (fromSelectors.length === 0 || toSelectors.length === 0) {
        throw new Error(`Line ${lineNo}: shift requires non-empty from/to selectors.`);
      }
      commands.push({
        type: "shiftGather",
        at,
        actorType,
        count: parseNumber(countToken, lineNo),
        fromResourceNodeSelectors: fromSelectors,
        resourceNodeSelectors: toSelectors,
      });
      continue;
    }

    throw new Error(`Line ${lineNo}: unknown directive '${op}'.`);
  }

  if (evaluationTime === undefined) {
    throw new Error("DSL requires 'evaluation <seconds>'.");
  }

  const out: BuildOrderInput = {
    evaluationTime,
    commands,
  };
  if (debtFloor !== undefined) out.debtFloor = debtFloor;
  return out;
}
