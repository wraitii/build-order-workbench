import { BuildOrderCommand, BuildOrderInput, HumanDelayBucket, TriggerCondition, TriggerExecutableCommand } from "./types";
import { DEFAULT_DSL_SELECTOR_ALIASES, parseDslSelectors } from "./node_selectors";

const TRIGGER_KEYWORDS = new Set(["completed", "depleted", "exhausted"]);

function parseNumber(token: string, lineNo: number): number {
  const n = Number(token);
  if (!Number.isFinite(n)) throw new Error(`Line ${lineNo}: invalid number '${token}'.`);
  return n;
}

function parseCommandPrefix(tokens: string[], lineNo: number): { at: number; rest: string[] } {
  if (tokens[0] === "at") {
    if (tokens.length < 3) throw new Error(`Line ${lineNo}: expected 'at <time> ...'.`);
    return { at: parseNumber(tokens[1] ?? "", lineNo), rest: tokens.slice(2) };
  }
  if (tokens[0] === "after") {
    if (tokens.length < 3) throw new Error(`Line ${lineNo}: expected 'after <condition> <directive...>'.`);
    // Shorthand: "after ..." defaults to time 0.
    return { at: 0, rest: tokens };
  }
  // Shorthand: bare directives default to time 0.
  return { at: 0, rest: tokens };
}

function parseCommaEntriesFromTokens(tokens: string[], lineNo: number, emptyError: string): { entries: string[]; consumed: number } {
  const entries: string[] = [];
  let currentParts: string[] = [];
  let consumed = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "x" || token.startsWith("x")) break;

    consumed += 1;
    const chunks = token.split(",");
    for (let j = 0; j < chunks.length; j += 1) {
      const chunk = chunks[j]?.trim() ?? "";
      if (chunk) currentParts.push(chunk);
      const endedByComma = j < chunks.length - 1;
      if (endedByComma) {
        const entry = currentParts.join(" ").trim();
        if (!entry) throw new Error(`Line ${lineNo}: ${emptyError}`);
        entries.push(entry);
        currentParts = [];
      }
    }
  }

  const trailing = currentParts.join(" ").trim();
  if (trailing) entries.push(trailing);
  return { entries, consumed };
}

function parseCommaEntries(payload: string, lineNo: number, emptyError: string): string[] {
  const entries = payload.split(",").map((x) => x.trim());
  if (entries.some((x) => x.length === 0)) throw new Error(`Line ${lineNo}: ${emptyError}`);
  return entries;
}

function normalizeActorSelector(entry: string, lineNo: number): string {
  const dashedId = entry.match(/^([^\s,]+)-(\d+)$/);
  if (dashedId) return entry;

  const splitId = entry.match(/^([^\s,]+)\s+(\d+)$/);
  if (splitId) return `${splitId[1]}-${splitId[2]}`;

  if (/\s/.test(entry)) {
    throw new Error(`Line ${lineNo}: invalid actor selector '${entry}'. Use '<type>', '<type> <n>', or '<type>-<n>'.`);
  }
  return entry;
}

function parseQueueUsingSelectors(tokens: string[], lineNo: number): { selectors: string[]; consumed: number } {
  const fromIdx = tokens.findIndex((t) => t === "from");
  const scope = fromIdx >= 0 ? tokens.slice(0, fromIdx) : tokens;
  const parsed = parseCommaEntriesFromTokens(scope, lineNo, "invalid empty selector in 'using' list.");
  if (parsed.entries.length === 0) throw new Error(`Line ${lineNo}: missing actor selector after 'using'.`);
  const selectors = parsed.entries.map((entry) => normalizeActorSelector(entry, lineNo));

  return { selectors, consumed: parsed.consumed };
}

function parseTriggerCondition(
  kind: string,
  target: string,
  lineNo: number,
  selectorAliases: Record<string, string>,
): TriggerCondition {
  if (kind === "completed") {
    return { kind: "completed", actionId: target };
  }
  if (kind === "depleted" || kind === "exhausted") {
    const selector = parseDslSelectors([target], selectorAliases)[0];
    if (!selector) throw new Error(`Line ${lineNo}: invalid trigger target '${target}'.`);
    return { kind, resourceNodeSelector: selector };
  }
  throw new Error(`Line ${lineNo}: unknown trigger '${kind}'. Use 'completed', 'depleted', or 'exhausted'.`);
}

function parseAfterCondition(
  rest: string[],
  lineNo: number,
  selectorAliases: Record<string, string>,
): { rest: string[]; afterLabel?: string; afterEntityId?: string; trigger?: TriggerCondition } {
  if (rest[0] !== "after") return { rest };
  if (!rest[1] || rest.length < 3) {
    throw new Error(`Line ${lineNo}: expected 'after <condition> <directive...>'.`);
  }

  if (TRIGGER_KEYWORDS.has(rest[1] ?? "")) {
    const triggerKind = rest[1] ?? "";
    const triggerTarget = rest[2] ?? "";
    if (!triggerTarget || rest.length < 4) {
      throw new Error(`Line ${lineNo}: expected 'after <completed|depleted|exhausted> <target> <directive...>'.`);
    }
    return {
      trigger: parseTriggerCondition(triggerKind, triggerTarget, lineNo, selectorAliases),
      rest: rest.slice(3),
    };
  }

  const dashedEntity = rest[1].match(/^([^\s,]+)-(\d+)$/);
  if (dashedEntity) {
    return { afterEntityId: rest[1], rest: rest.slice(2) };
  }
  if (rest[2] && /^\d+$/.test(rest[2])) {
    return { afterEntityId: `${rest[1]}-${rest[2]}`, rest: rest.slice(3) };
  }
  return { afterLabel: rest[1], rest: rest.slice(2) };
}

export interface ParseBuildOrderDslOptions {
  selectorAliases?: Record<string, string>;
}

export function parseBuildOrderDsl(input: string, options?: ParseBuildOrderDslOptions): BuildOrderInput {
  const selectorAliases = {
    ...DEFAULT_DSL_SELECTOR_ALIASES,
    ...(options?.selectorAliases ?? {}),
  };
  const commands: BuildOrderCommand[] = [];
  let evaluationTime: number | undefined;
  let debtFloor: number | undefined;
  let startingResources: Record<string, number> | undefined;
  let startingEntities: Record<string, number> | undefined;
  let humanDelays: Record<string, HumanDelayBucket[]> | undefined;

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
    if (tokens[0] === "starting-resource") {
      const resource = tokens[1];
      const amountToken = tokens[2];
      if (!resource || !amountToken || tokens.length !== 3) {
        throw new Error(`Line ${lineNo}: expected 'starting-resource <resource> <amount>'.`);
      }
      if (!startingResources) startingResources = {};
      startingResources[resource] = parseNumber(amountToken, lineNo);
      continue;
    }
    if (tokens[0] === "start" && tokens[1] === "with") {
      const payload = line.replace(/^start\s+with\s+/i, "").trim();
      if (!payload) throw new Error(`Line ${lineNo}: expected 'start with <entityType>[, <entityType>...]'.`);
      const entries = parseCommaEntries(payload, lineNo, "invalid empty item in 'start with' list.");
      if (!startingEntities) startingEntities = {};
      for (const entry of entries) {
        const m = entry.match(/^([^\s,]+)(?:\s+(\d+))?$/);
        if (!m) {
          throw new Error(`Line ${lineNo}: invalid start-with item '${entry}'. Use '<entityType>' or '<entityType> <count>'.`);
        }
        const entityType = m[1];
        if (!entityType) continue;
        const count = m[2] ? parseNumber(m[2], lineNo) : 1;
        startingEntities[entityType] = (startingEntities[entityType] ?? 0) + count;
      }
      continue;
    }
    if (tokens[0] === "human-delay") {
      const actionId = tokens[1];
      const chanceToken = tokens[2];
      const minToken = tokens[3];
      const maxToken = tokens[4];
      if (!actionId || !chanceToken || !minToken || !maxToken || tokens.length !== 5) {
        throw new Error(`Line ${lineNo}: expected 'human-delay <actionId> <chance> <minSec> <maxSec>'.`);
      }
      const chance = parseNumber(chanceToken, lineNo);
      const minSeconds = parseNumber(minToken, lineNo);
      const maxSeconds = parseNumber(maxToken, lineNo);
      if (chance < 0 || chance > 1) {
        throw new Error(`Line ${lineNo}: human-delay chance must be between 0 and 1.`);
      }
      if (minSeconds < 0 || maxSeconds < 0 || maxSeconds < minSeconds) {
        throw new Error(`Line ${lineNo}: human-delay requires 0 <= minSec <= maxSec.`);
      }
      if (!humanDelays) humanDelays = {};
      const buckets = humanDelays[actionId] ?? [];
      buckets.push({ chance, minSeconds, maxSeconds });
      const totalChance = buckets.reduce((sum, bucket) => sum + bucket.chance, 0);
      if (totalChance > 1 + 1e-9) {
        throw new Error(`Line ${lineNo}: human-delay total chance for '${actionId}' cannot exceed 1.`);
      }
      humanDelays[actionId] = buckets;
      continue;
    }

    const { at, rest: rawRest } = parseCommandPrefix(tokens, lineNo);
    const parsedAfter = parseAfterCondition(rawRest, lineNo, selectorAliases);
    let rest = parsedAfter.rest;
    const afterLabel = parsedAfter.afterLabel;
    const afterEntityId = parsedAfter.afterEntityId;
    let trigger: TriggerCondition | undefined = parsedAfter.trigger;
    if (rest.length === 0) {
      throw new Error(`Line ${lineNo}: expected directive after condition prefix.`);
    }
    if (rest[0] === "on") {
      const triggerKind = rest[1];
      const triggerTarget = rest[2];
      if (!triggerKind || !triggerTarget || rest.length < 4) {
        throw new Error(`Line ${lineNo}: expected 'on <completed|depleted|exhausted> <target> <directive...>'.`);
      }
      trigger = parseTriggerCondition(triggerKind, triggerTarget, lineNo, selectorAliases);
      rest = rest.slice(3);
    }

    const wrapCommand = (cmd: TriggerExecutableCommand): BuildOrderCommand => {
      if (!trigger) return cmd;
      const triggerCommand = { ...cmd };
      delete triggerCommand.at;
      delete triggerCommand.after;
      delete triggerCommand.afterEntityId;
      return {
        type: "onTrigger",
        at,
        ...(afterLabel !== undefined ? { after: afterLabel } : {}),
        ...(afterEntityId !== undefined ? { afterEntityId } : {}),
        trigger,
        command: triggerCommand,
      };
    };

    const op = rest[0];

    if (op === "queue") {
      if (!rest[1]) throw new Error(`Line ${lineNo}: missing action id.`);
      const actionId = rest[1];
      let count: number | undefined;
      let actorSelectors: string[] | undefined;
      let actorResourceNodeSelectors: string[] | undefined;

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
          const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
          actorSelectors = parsed.selectors;
          i += parsed.consumed;
          continue;
        }
        if (t === "from") {
          const selectors = parseDslSelectors(rest.slice(i + 1), selectorAliases);
          if (selectors.length === 0) throw new Error(`Line ${lineNo}: queue 'from' requires at least one selector.`);
          actorResourceNodeSelectors = selectors;
          i = rest.length;
          continue;
        }
        throw new Error(`Line ${lineNo}: unknown queue token '${t}'.`);
      }

      const cmd: Extract<BuildOrderCommand, { type: "queueAction" }> = { type: "queueAction", at, actionId };
      if (afterLabel !== undefined) cmd.after = afterLabel;
      if (afterEntityId !== undefined) cmd.afterEntityId = afterEntityId;
      if (count !== undefined) cmd.count = count;
      if (actorSelectors !== undefined) cmd.actorSelectors = actorSelectors;
      if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
      commands.push(wrapCommand(cmd));
      continue;
    }

    if (op === "assign") {
      const toIdx = rest.indexOf("to");
      if (toIdx < 0 || toIdx + 1 >= rest.length) throw new Error(`Line ${lineNo}: assign requires 'to <selectors...>'.`);
      if (rest[1] === "event" || (trigger && rest[1] === "to")) {
        const selectors = rest
          .slice(toIdx + 1)
          .map((raw) => (raw === "created" ? "id:created" : parseDslSelectors([raw], selectorAliases)[0] ?? ""));
        if (selectors.some((x) => !x)) throw new Error(`Line ${lineNo}: invalid selector in 'assign event ...'.`);
        const cmd: Extract<BuildOrderCommand, { type: "assignEventGather" }> = {
          type: "assignEventGather",
          at,
          ...(afterLabel !== undefined ? { after: afterLabel } : {}),
          ...(afterEntityId !== undefined ? { afterEntityId } : {}),
          resourceNodeSelectors: selectors,
        };
        commands.push(wrapCommand(cmd));
        continue;
      }

      const fromIdx = rest.indexOf("from");
      if (fromIdx >= 0 && fromIdx >= toIdx) {
        throw new Error(`Line ${lineNo}: 'from' must appear before 'to' in assign.`);
      }
      const selectors = parseDslSelectors(rest.slice(toIdx + 1), selectorAliases);
      const fromSelectors = fromIdx >= 0 ? parseDslSelectors(rest.slice(fromIdx + 1, toIdx), selectorAliases) : undefined;
      if (fromIdx >= 0 && (!fromSelectors || fromSelectors.length === 0)) {
        throw new Error(`Line ${lineNo}: assign 'from' requires at least one selector.`);
      }
      const actorType = rest[1];
      const amountToken = rest[2];
      if (!actorType || !amountToken) throw new Error(`Line ${lineNo}: expected 'assign <actorType> <xN|idNum|all> [from ...] to ...'.`);
      const cmd: Extract<BuildOrderCommand, { type: "assignGather" }> = {
        type: "assignGather",
        at,
        ...(afterLabel !== undefined ? { after: afterLabel } : {}),
        ...(afterEntityId !== undefined ? { afterEntityId } : {}),
        actorType,
        ...(fromSelectors !== undefined ? { actorResourceNodeSelectors: fromSelectors } : {}),
        resourceNodeSelectors: selectors,
      };
      if (amountToken.startsWith("x")) {
        const n = amountToken.slice(1);
        if (!n) throw new Error(`Line ${lineNo}: missing count after 'x'.`);
        cmd.count = parseNumber(n, lineNo);
      } else if (amountToken === "all") {
        cmd.all = true;
      } else if (/^\d+$/.test(amountToken)) {
        cmd.actorSelectors = [`${actorType}-${amountToken}`];
      } else {
        throw new Error(`Line ${lineNo}: assign amount must be 'x<count>', 'all', or '<idNum>'.`);
      }
      commands.push(wrapCommand(cmd));
      continue;
    }

    if (op === "auto-queue") {
      const actionId = rest[1];
      if (!actionId) throw new Error(`Line ${lineNo}: missing action id for auto-queue.`);
      let actorType: string | undefined;
      let actorResourceNodeSelectors: string[] | undefined;

      for (let i = 2; i < rest.length; i += 1) {
        const t = rest[i];
        if (!t) continue;

        if (t === "using") {
          const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
          if (parsed.selectors.length !== 1) {
            throw new Error(`Line ${lineNo}: auto-queue supports exactly one selector in 'using'.`);
          }
          const selector = parsed.selectors[0];
          if (!selector) throw new Error(`Line ${lineNo}: missing selector after 'using'.`);
          if (selector.match(/^(.*)-(\d+)$/)) {
            throw new Error(`Line ${lineNo}: auto-queue 'using' must be an actor type, not a specific ID.`);
          }
          actorType = selector;
          i += parsed.consumed;
          continue;
        }
        if (t === "from") {
          const selectors = parseDslSelectors(rest.slice(i + 1), selectorAliases);
          if (selectors.length === 0) throw new Error(`Line ${lineNo}: auto-queue 'from' requires at least one selector.`);
          actorResourceNodeSelectors = selectors;
          i = rest.length;
          continue;
        }
        throw new Error(`Line ${lineNo}: unknown auto-queue token '${t}'.`);
      }

      const cmd: Extract<BuildOrderCommand, { type: "autoQueue" }> = { type: "autoQueue", at, actionId };
      if (afterLabel !== undefined) cmd.after = afterLabel;
      if (afterEntityId !== undefined) cmd.afterEntityId = afterEntityId;
      if (actorType !== undefined) cmd.actorType = actorType;
      if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
      commands.push(wrapCommand(cmd));
      continue;
    }

    if (op === "stop-auto-queue") {
      const actionId = rest[1];
      if (!actionId) throw new Error(`Line ${lineNo}: missing action id for stop-auto-queue.`);
      let actorType: string | undefined;
      let actorResourceNodeSelectors: string[] | undefined;

      for (let i = 2; i < rest.length; i += 1) {
        const t = rest[i];
        if (!t) continue;
        if (t === "using") {
          const parsed = parseQueueUsingSelectors(rest.slice(i + 1), lineNo);
          if (parsed.selectors.length !== 1) {
            throw new Error(`Line ${lineNo}: stop-auto-queue supports exactly one selector in 'using'.`);
          }
          const selector = parsed.selectors[0];
          if (!selector) throw new Error(`Line ${lineNo}: missing selector after 'using'.`);
          if (selector.match(/^(.*)-(\d+)$/)) {
            throw new Error(`Line ${lineNo}: stop-auto-queue 'using' must be an actor type, not a specific ID.`);
          }
          actorType = selector;
          i += parsed.consumed;
          continue;
        }
        if (t === "from") {
          const selectors = parseDslSelectors(rest.slice(i + 1), selectorAliases);
          if (selectors.length === 0) throw new Error(`Line ${lineNo}: stop-auto-queue 'from' requires at least one selector.`);
          actorResourceNodeSelectors = selectors;
          i = rest.length;
          continue;
        }
        throw new Error(`Line ${lineNo}: unknown stop-auto-queue token '${t}'.`);
      }

      const cmd: Extract<BuildOrderCommand, { type: "stopAutoQueue" }> = { type: "stopAutoQueue", at, actionId };
      if (afterLabel !== undefined) cmd.after = afterLabel;
      if (afterEntityId !== undefined) cmd.afterEntityId = afterEntityId;
      if (actorType !== undefined) cmd.actorType = actorType;
      if (actorResourceNodeSelectors !== undefined) cmd.actorResourceNodeSelectors = actorResourceNodeSelectors;
      commands.push(wrapCommand(cmd));
      continue;
    }

    if (op === "spawn-assign") {
      const entityType = rest[1];
      const toIdx = rest.indexOf("to");
      const selector = toIdx >= 0 ? rest[toIdx + 1] : undefined;
      if (!entityType || toIdx < 0 || !selector || toIdx + 2 !== rest.length) {
        throw new Error(`Line ${lineNo}: expected 'spawn-assign <entityType> to <selector>'.`);
      }
      commands.push(wrapCommand({
        type: "setSpawnGather",
        at,
        ...(afterLabel !== undefined ? { after: afterLabel } : {}),
        ...(afterEntityId !== undefined ? { afterEntityId } : {}),
        entityType,
        resourceNodeSelectors: parseDslSelectors([selector], selectorAliases),
      }));
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
  if (startingResources !== undefined) out.startingResources = startingResources;
  if (startingEntities !== undefined) out.startingEntities = startingEntities;
  if (humanDelays !== undefined) out.humanDelays = humanDelays;
  return out;
}
