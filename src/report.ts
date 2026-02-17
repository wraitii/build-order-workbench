import { GameData, SimulationResult } from "./types";

function formatMap(map: Record<string, number>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
    .join(", ");
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

export function toHtmlReport(result: SimulationResult, game: GameData, initialDsl: string): string {
  const escapedDsl = initialDsl
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  const gameJson = JSON.stringify(game).replaceAll("</script>", "<\\/script>");
  const resultJson = JSON.stringify(result).replaceAll("</script>", "<\\/script>");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Build Order Workbench</title>
  <style>
    :root {
      --bg: #f5f2e8;
      --panel: #fffaf0;
      --ink: #172121;
      --muted: #556;
      --accent: #2f7a5f;
      --line: #e3d8c0;
      --error: #9e2a2a;
    }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: radial-gradient(circle at top right, #fef4d8, var(--bg)); }
    main { max-width: 1120px; margin: 24px auto; padding: 0 16px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
    h1 { margin: 8px 0 14px; font-size: 26px; }
    h2 { margin: 8px 0 10px; }
    .labels { display: flex; gap: 8px; flex-wrap: wrap; }
    .label { background: var(--accent); color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 13px; letter-spacing: .2px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); text-align: left; padding: 6px 8px; vertical-align: top; }
    th { color: var(--muted); }
    .muted { color: var(--muted); }
    .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
    .btn { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
    input[type="range"] { width: min(100%, 680px); }
    .legend { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
    .legend-item { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; }
    .legend-swatch { width: 12px; height: 12px; border-radius: 3px; border: 1px solid #0003; }
    .timeline-wrap { border: 1px solid var(--line); border-radius: 10px; overflow: auto; background: #fff; }
    .timeline-head { position: sticky; top: 0; z-index: 4; display: flex; background: #fffdf7; border-bottom: 1px solid var(--line); }
    .timeline-label-head { width: 180px; min-width: 180px; padding: 6px 8px; font-size: 12px; color: var(--muted); border-right: 1px solid var(--line); }
    .timeline-axis { position: relative; height: 28px; min-width: 720px; }
    .timeline-tick { position: absolute; top: 0; bottom: 0; width: 1px; background: #0001; }
    .timeline-tick-label { position: absolute; top: 6px; transform: translateX(3px); font-size: 11px; color: var(--muted); }
    .timeline-row { display: flex; border-bottom: 1px solid var(--line); }
    .timeline-row:last-child { border-bottom: none; }
    .timeline-label { width: 180px; min-width: 180px; padding: 6px 8px; font-size: 12px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .timeline-track { position: relative; height: 26px; min-width: 720px; background-image: linear-gradient(to right, #00000008 1px, transparent 1px); background-size: 20px 100%; }
    .timeline-seg { position: absolute; top: 4px; height: 18px; border-radius: 4px; border: 1px solid #0002; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 16px; padding: 0 4px; }
    .timeline-cursor { position: absolute; top: 0; bottom: 0; width: 2px; background: #111; opacity: 0.8; z-index: 3; }
    #dslInput { width: 100%; min-height: 280px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
    #errorBox { color: var(--error); white-space: pre-wrap; margin-top: 8px; }
    @media (max-width: 680px) { table { font-size: 12px; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Build Order Workbench</h1>
      <div class="labels">
        <span class="label">offline html</span>
        <span class="label">cmd/ctrl+enter to run</span>
      </div>
    </section>

    <section class="card">
      <h2>DSL</h2>
      <div class="controls">
        <button id="runBtn" class="btn">Run Simulation</button>
        <span id="runStatus" class="muted">ready</span>
      </div>
      <textarea id="dslInput">${escapedDsl}</textarea>
      <div id="errorBox"></div>
    </section>

    <section class="card">
      <div class="labels"><span id="scoreLabel" class="label">score -</span></div>
      <p><strong>Resources @T:</strong> <span id="resourcesLine"></span></p>
      <p><strong>Entities @T:</strong> <span id="entitiesLine"></span></p>
      <p class="muted" id="metaLine"></p>
    </section>

    <section class="card">
      <h2>Timeline Scrubber</h2>
      <div class="controls">
        <label for="timeRange"><strong>Time:</strong></label>
        <input id="timeRange" type="range" min="0" max="0" step="0.5" value="0" />
        <input id="timeInput" type="number" min="0" step="0.5" value="0" />
        <span id="timeReadout" class="muted"></span>
      </div>
      <div id="scrubStats"></div>
    </section>

    <section class="card">
      <h2>Entity Timeline</h2>
      <div class="controls">
        <label for="pxPerSecond"><strong>Scale:</strong></label>
        <input id="pxPerSecond" type="range" min="2" max="24" step="1" value="8" />
        <span id="pxPerSecondReadout" class="muted"></span>
      </div>
      <div id="timelineLegend" class="legend"></div>
      <div id="entityTimeline" class="timeline-wrap"></div>
    </section>

    <section class="card">
      <h2 id="violationsTitle">Violations</h2>
      <table>
        <thead><tr><th>Time</th><th>Code</th><th>Message</th></tr></thead>
        <tbody id="violationsBody"></tbody>
      </table>
    </section>

    <section class="card">
      <h2>Commands</h2>
      <table>
        <thead><tr><th>#</th><th>Type</th><th>Requested</th><th>Started</th><th>Delay</th><th>Status</th><th>Message</th></tr></thead>
        <tbody id="commandsBody"></tbody>
      </table>
    </section>
  </main>

  <script>
    const GAME = ${gameJson};
    const INITIAL_RESULT = ${resultJson};
    const EPS = 1e-9;

    function cloneResources(input) {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Number(v)]));
    }

    function addResources(base, delta) {
      for (const [resource, value] of Object.entries(delta)) {
        base[resource] = (base[resource] ?? 0) + Number(value);
      }
    }

    function splitEntityId(entityId) {
      const m = String(entityId).match(/^(.*?)-(\\d+)$/);
      if (!m) return { prefix: String(entityId), num: Number.POSITIVE_INFINITY };
      return { prefix: m[1], num: Number(m[2]) };
    }

    function compareEntityIdNatural(a, b) {
      const pa = splitEntityId(a);
      const pb = splitEntityId(b);
      if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
      if (pa.num !== pb.num) return pa.num - pb.num;
      return String(a).localeCompare(String(b));
    }

    function normalizeCommandTimes(commands) {
      let last = 0;
      return commands.map((c) => {
        const at = c.at ?? last;
        last = at;
        return { ...c, at };
      });
    }

    function countEntitiesByType(entities) {
      const out = {};
      for (const ent of entities) {
        out[ent.entityType] = (out[ent.entityType] ?? 0) + 1;
      }
      return out;
    }

    function applyNumericModifiers(base, keys, mods) {
      let value = base;
      for (const mod of mods) {
        if (!keys.includes(mod.selector)) continue;
        if (mod.op === "mul") value *= mod.value;
        else if (mod.op === "add") value += mod.value;
        else if (mod.op === "set") value = mod.value;
      }
      return value;
    }

    function resourceNodeStockKeys(node) {
      return ["gather.stock.node." + node.prototypeId, ...node.tags.map((t) => "gather.stock.tag." + t)];
    }

    function resourceNodeRateKeys(node, entityType) {
      return [
        "gather.rate.node." + node.prototypeId,
        "gather.rate.entity." + entityType,
        ...node.tags.map((t) => "gather.rate.tag." + t),
      ];
    }

    function instantiateResourceNode(state, prototype) {
      state.resourceNodeCounter += 1;
      const id = prototype.id + "-" + state.resourceNodeCounter;
      const node = {
        id,
        prototypeId: prototype.id,
        name: prototype.name + " " + state.resourceNodeCounter,
        produces: prototype.produces,
        rateByEntityType: { ...prototype.rateByEntityType },
        tags: [...(prototype.tags ?? [])],
      };
      if (prototype.maxWorkers !== undefined) node.maxWorkers = prototype.maxWorkers;
      if (prototype.stock !== undefined) {
        node.remainingStock = Math.max(0, applyNumericModifiers(prototype.stock, resourceNodeStockKeys(node), state.activeModifiers));
      }
      state.resourceNodes.push(node);
      state.resourceNodeById[node.id] = node;
    }

    function applyStockModifierToExistingNodes(state, mod) {
      if (!String(mod.selector).startsWith("gather.stock.")) return;
      for (const node of state.resourceNodes) {
        if (node.remainingStock === undefined) continue;
        node.remainingStock = Math.max(0, applyNumericModifiers(node.remainingStock, resourceNodeStockKeys(node), [mod]));
      }
    }

    function recordEntityCountPoint(state) {
      const point = { time: state.now, entitiesByType: countEntitiesByType(state.entities) };
      const last = state.entityCountTimeline[state.entityCountTimeline.length - 1];
      if (last && Math.abs(last.time - point.time) < EPS) state.entityCountTimeline[state.entityCountTimeline.length - 1] = point;
      else state.entityCountTimeline.push(point);
    }

    function switchEntityActivity(state, entityId, kind, detail) {
      const current = state.currentActivities[entityId];
      if (current && current.kind === kind && current.detail === detail) return;
      if (current && current.start < state.now - EPS) {
        state.entityTimelines[entityId]?.segments.push({ ...current, end: state.now });
      }
      state.currentActivities[entityId] = { start: state.now, kind, detail };
    }

    function computeEconomySnapshot(state) {
      const resourceRates = {};
      const grouped = {};

      for (const ent of state.entities) {
        if (ent.busyUntil > state.now + EPS || !ent.resourceNodeId) continue;
        const node = state.resourceNodeById[ent.resourceNodeId];
        if (!node) continue;
        if (node.remainingStock !== undefined && node.remainingStock <= EPS) continue;

        const baseRate = node.rateByEntityType[ent.entityType] ?? 0;
        if (baseRate <= 0) continue;

        const effectiveRate = applyNumericModifiers(baseRate, resourceNodeRateKeys(node, ent.entityType), state.activeModifiers);
        if (effectiveRate <= 0) continue;

        const bucket = grouped[node.id] ?? { target: node, rate: 0, workers: [] };
        bucket.rate += effectiveRate;
        bucket.workers.push(ent.id);
        grouped[node.id] = bucket;
      }

      let nextDepletionTime;
      const targetEconomy = Object.values(grouped);
      for (const item of targetEconomy) {
        resourceRates[item.target.produces] = (resourceRates[item.target.produces] ?? 0) + item.rate;
        if (item.target.remainingStock !== undefined && item.rate > 0) {
          const t = state.now + item.target.remainingStock / item.rate;
          if (nextDepletionTime === undefined || t < nextDepletionTime) nextDepletionTime = t;
        }
      }

      return { resourceRates, targetEconomy, nextDepletionTime };
    }

    function handleDepletedNodes(state) {
      for (const node of state.resourceNodes) {
        if (node.remainingStock === undefined || node.remainingStock > EPS) continue;
        for (const ent of state.entities) {
          if (ent.resourceNodeId !== node.id) continue;
          delete ent.resourceNodeId;
          if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "idle", "idle");
        }
      }
    }

    function findNextEventTime(events, now) {
      let next;
      for (const e of events) {
        if (e.time <= now + EPS) continue;
        if (next === undefined || e.time < next) next = e.time;
      }
      return next;
    }

    function splitSelector(selector) {
      const idx = selector.indexOf(":");
      if (idx < 0) return { kind: "id", value: selector };
      return { kind: selector.slice(0, idx), value: selector.slice(idx + 1) };
    }

    function matchesSelector(node, selector) {
      const { kind, value } = splitSelector(selector);
      if (kind === "id") return node.id === value;
      if (kind === "proto") return node.prototypeId === value;
      if (kind === "tag") return node.tags.includes(value);
      if (kind === "res") return node.produces === value;
      return false;
    }

    function resolveNodeTargets(state, resourceNodeIds, resourceNodeSelectors) {
      const out = [];
      const seen = new Set();

      for (const id of resourceNodeIds ?? []) {
        const node = state.resourceNodeById[id];
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);
        out.push(node);
      }

      if (resourceNodeSelectors && resourceNodeSelectors.length > 0) {
        const nodes = [...state.resourceNodes].sort((a, b) => compareEntityIdNatural(a.id, b.id));
        for (const node of nodes) {
          if (seen.has(node.id)) continue;
          if (resourceNodeSelectors.some((selector) => matchesSelector(node, selector))) {
            seen.add(node.id);
            out.push(node);
          }
        }
      }

      return out;
    }

    function pickGatherNode(entType, targets, assignedCount) {
      return targets.find((t) => {
        if ((t.rateByEntityType[entType] ?? 0) <= 0) return false;
        if (t.remainingStock !== undefined && t.remainingStock <= EPS) return false;
        if (t.maxWorkers !== undefined && (assignedCount[t.id] ?? 0) >= t.maxWorkers) return false;
        return true;
      });
    }

    function assignEntityToGatherTargets(state, entityId, resourceNodeIds, resourceNodeSelectors) {
      const ent = state.entities.find((e) => e.id === entityId);
      if (!ent) return false;

      const targets = resolveNodeTargets(state, resourceNodeIds, resourceNodeSelectors);
      if (targets.length === 0) return false;

      const assignedCount = {};
      for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
      }

      const node = pickGatherNode(ent.entityType, targets, assignedCount);
      if (!node) return false;

      ent.resourceNodeId = node.id;
      if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "gather", node.produces + ":" + node.prototypeId);
      return true;
    }

    function parseNumber(token, lineNo) {
      const n = Number(token);
      if (!Number.isFinite(n)) throw new Error("Line " + lineNo + ": invalid number '" + token + "'.");
      return n;
    }

    function parseSelectors(tokens) {
      return tokens.map((raw) => {
        if (raw.includes(":")) return raw;
        if (raw === "food" || raw === "wood" || raw === "gold" || raw === "stone") return "res:" + raw;
        if (raw === "farm") return "tag:farm";
        return "proto:" + raw;
      });
    }

    function parseBuildOrderDsl(input) {
      const commands = [];
      let evaluationTime;
      let debtFloor;

      const lines = input.split(/\\r?\\n/);
      for (let idx = 0; idx < lines.length; idx += 1) {
        const lineNo = idx + 1;
        const line = (lines[idx] ?? "").replace(/#.*/, "").trim();
        if (!line) continue;

        const tokens = line.split(/\\s+/);
        if (tokens[0] === "evaluation") {
          if (!tokens[1]) throw new Error("Line " + lineNo + ": missing evaluation time.");
          evaluationTime = parseNumber(tokens[1], lineNo);
          continue;
        }
        if (tokens[0] === "debt-floor") {
          if (!tokens[1]) throw new Error("Line " + lineNo + ": missing debt floor value.");
          debtFloor = parseNumber(tokens[1], lineNo);
          continue;
        }

        if (tokens[0] !== "at" || tokens.length < 3) throw new Error("Line " + lineNo + ": expected 'at <time> ...'.");

        const at = parseNumber(tokens[1], lineNo);
        const rest = tokens.slice(2);
        const op = rest[0];

        if (op === "queue") {
          if (!rest[1]) throw new Error("Line " + lineNo + ": missing action id.");
          const cmd = { type: "queueAction", at, actionId: rest[1] };
          for (let i = 2; i < rest.length; i += 1) {
            const t = rest[i];
            if (!t) continue;
            if (t === "x") {
              const n = rest[i + 1];
              if (!n) throw new Error("Line " + lineNo + ": missing count after 'x'.");
              cmd.count = parseNumber(n, lineNo);
              i += 1;
              continue;
            }
            if (t.startsWith("x")) {
              cmd.count = parseNumber(t.slice(1), lineNo);
              continue;
            }
            if (t === "using") {
              const a = rest[i + 1];
              if (!a) throw new Error("Line " + lineNo + ": missing actor type after 'using'.");
              cmd.actorType = a;
              i += 1;
              continue;
            }
            throw new Error("Line " + lineNo + ": unknown queue token '" + t + "'.");
          }
          commands.push(cmd);
          continue;
        }

        if (op === "assign") {
          const actorType = rest[1];
          const countToken = rest[2];
          const toIdx = rest.indexOf("to");
          if (!actorType || !countToken || toIdx < 0 || toIdx + 1 >= rest.length) throw new Error("Line " + lineNo + ": expected 'assign <actorType> <count> to ...'.");
          commands.push({ type: "assignGather", at, actorType, count: parseNumber(countToken, lineNo), resourceNodeSelectors: parseSelectors(rest.slice(toIdx + 1)) });
          continue;
        }

        if (op === "auto-queue") {
          const actionId = rest[1];
          if (!actionId) throw new Error("Line " + lineNo + ": missing action id for auto-queue.");
          const cmd = { type: "autoQueue", at, actionId };
          for (let i = 2; i < rest.length; i += 1) {
            const t = rest[i];
            if (!t) continue;
            if (t === "using") {
              const a = rest[i + 1];
              if (!a) throw new Error("Line " + lineNo + ": missing actor type after 'using'.");
              cmd.actorType = a;
              i += 1;
              continue;
            }
            if (t === "every") {
              const n = rest[i + 1];
              if (!n) throw new Error("Line " + lineNo + ": missing seconds after 'every'.");
              cmd.retryEvery = parseNumber(n, lineNo);
              i += 1;
              continue;
            }
            if (t === "until") {
              const n = rest[i + 1];
              if (!n) throw new Error("Line " + lineNo + ": missing seconds after 'until'.");
              cmd.until = parseNumber(n, lineNo);
              i += 1;
              continue;
            }
            if (t === "max") {
              const n = rest[i + 1];
              if (!n) throw new Error("Line " + lineNo + ": missing count after 'max'.");
              cmd.maxRuns = parseNumber(n, lineNo);
              i += 1;
              continue;
            }
            throw new Error("Line " + lineNo + ": unknown auto-queue token '" + t + "'.");
          }
          commands.push(cmd);
          continue;
        }

        if (op === "spawn-assign") {
          const entityType = rest[1];
          const toIdx = rest.indexOf("to");
          if (!entityType || toIdx < 0 || toIdx + 1 >= rest.length) throw new Error("Line " + lineNo + ": expected 'spawn-assign <entityType> to <selectors...>'.");
          commands.push({ type: "setSpawnGather", at, entityType, resourceNodeSelectors: parseSelectors(rest.slice(toIdx + 1)) });
          continue;
        }

        if (op === "shift") {
          const actorType = rest[1];
          const countToken = rest[2];
          const fromIdx = rest.indexOf("from");
          const toIdx = rest.indexOf("to");
          if (!actorType || !countToken || fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx + 1) throw new Error("Line " + lineNo + ": expected 'shift <actorType> <count> from <selectors...> to <selectors...>'.");
          commands.push({
            type: "shiftGather",
            at,
            actorType,
            count: parseNumber(countToken, lineNo),
            fromResourceNodeSelectors: parseSelectors(rest.slice(fromIdx + 1, toIdx)),
            resourceNodeSelectors: parseSelectors(rest.slice(toIdx + 1)),
          });
          continue;
        }

        throw new Error("Line " + lineNo + ": unknown directive '" + op + "'.");
      }

      if (evaluationTime === undefined) throw new Error("DSL requires 'evaluation <seconds>'.");
      const out = { evaluationTime, commands };
      if (debtFloor !== undefined) out.debtFloor = debtFloor;
      return out;
    }

    function canAfford(resources, costs, debtFloor) {
      for (const [resource, cost] of Object.entries(costs)) {
        if ((resources[resource] ?? 0) - cost < debtFloor) return false;
      }
      return true;
    }

    function timeToAffordWithCurrentRates(resources, costs, rates, debtFloor) {
      let required = 0;
      for (const [resource, cost] of Object.entries(costs)) {
        const deficit = cost - ((resources[resource] ?? 0) - debtFloor);
        if (deficit <= 0) continue;
        const rate = rates[resource] ?? 0;
        if (rate <= 0) return Infinity;
        required = Math.max(required, deficit / rate);
      }
      return required;
    }

    function chargeCosts(state, costs) {
      for (const [resource, cost] of Object.entries(costs)) {
        state.resources[resource] = (state.resources[resource] ?? 0) - cost;
        state.maxDebt = Math.min(state.maxDebt, state.resources[resource]);
      }
    }

    function pickIdleActors(state, actorTypes, actorCount, actorTypeOverride, actorIds) {
      if (actorIds && actorIds.length > 0) {
        return state.entities
          .filter((e) => actorIds.includes(e.id) && e.busyUntil <= state.now + EPS)
          .sort((a, b) => compareEntityIdNatural(a.id, b.id))
          .slice(0, actorCount)
          .map((e) => e.id);
      }

      const allowed = actorTypeOverride ? [actorTypeOverride] : actorTypes;
      return state.entities
        .filter((e) => allowed.includes(e.entityType) && e.busyUntil <= state.now + EPS)
        .sort((a, b) => compareEntityIdNatural(a.id, b.id))
        .slice(0, actorCount)
        .map((e) => e.id);
    }

    function tryScheduleActionNow(state, game, options, cmd) {
      const action = game.actions[cmd.actionId];
      if (!action) return { status: "invalid", message: "Action '" + cmd.actionId + "' not found." };

      const actorCount = action.actorCount ?? 1;
      const actorIds = pickIdleActors(state, action.actorTypes, actorCount, cmd.actorType, cmd.actorIds);
      if (actorIds.length < actorCount) return { status: "blocked", reason: "NO_ACTORS" };

      const costs = action.costs ?? {};
      if (!canAfford(state.resources, costs, options.debtFloor)) return { status: "blocked", reason: "INSUFFICIENT_RESOURCES" };

      chargeCosts(state, costs);

      const duration = applyNumericModifiers(action.duration, ["action.duration." + action.id], state.activeModifiers);
      for (const id of actorIds) {
        const ent = state.entities.find((e) => e.id === id);
        if (!ent) continue;
        ent.busyUntil = state.now + duration;
        switchEntityActivity(state, id, "action", action.id);
      }

      state.events.push({ time: state.now + duration, actionId: action.id, actors: actorIds });
      return { status: "scheduled" };
    }

    function onEventComplete(state, game, actionId, actors) {
      const action = game.actions[actionId];
      if (!action) return;

      if (action.resourceDeltaOnComplete) addResources(state.resources, action.resourceDeltaOnComplete);

      if (action.modifiersOnComplete) {
        for (const mod of action.modifiersOnComplete) {
          state.activeModifiers.push(mod);
          applyStockModifierToExistingNodes(state, mod);
        }
      }

      if (action.creates) {
        for (const [entityType, count] of Object.entries(action.creates)) {
          for (let i = 0; i < count; i += 1) {
            state.idCounter += 1;
            const id = entityType + "-" + state.idCounter;
            state.entities.push({ id, entityType, busyUntil: state.now });
            state.entityTimelines[id] = { entityType, segments: [] };
            state.currentActivities[id] = { start: state.now, kind: "idle", detail: "idle" };

            const spawnRule = state.spawnGatherRules[entityType];
            if (spawnRule) assignEntityToGatherTargets(state, id, spawnRule.resourceNodeIds, spawnRule.resourceNodeSelectors);
          }
        }
        recordEntityCountPoint(state);
      }

      if (action.createsResourceNodes) {
        for (const spec of action.createsResourceNodes) {
          const proto = game.resourceNodePrototypes[spec.prototypeId];
          if (!proto) continue;
          const count = spec.count ?? 1;
          for (let i = 0; i < count; i += 1) instantiateResourceNode(state, proto);
        }
      }

      for (const actorId of actors) {
        const ent = state.entities.find((e) => e.id === actorId);
        if (!ent) continue;
        ent.busyUntil = Math.max(ent.busyUntil, state.now);
        if (ent.resourceNodeId) {
          const node = state.resourceNodeById[ent.resourceNodeId];
          switchEntityActivity(state, ent.id, node ? "gather" : "idle", node ? node.produces + ":" + node.prototypeId : "idle");
        } else {
          switchEntityActivity(state, ent.id, "idle", "idle");
        }
      }

      state.completedActions += 1;
    }

    function advanceTime(state, targetTime, game) {
      if (targetTime <= state.now + EPS) return;

      while (state.now + EPS < targetTime) {
        const nextEventTime = findNextEventTime(state.events, state.now) ?? Infinity;
        const econ = computeEconomySnapshot(state);
        const stepTo = Math.min(targetTime, nextEventTime, econ.nextDepletionTime ?? Infinity);
        const dt = stepTo - state.now;

        if (dt > EPS) {
          state.resourceTimeline.push({
            start: state.now,
            end: stepTo,
            startResources: cloneResources(state.resources),
            gatherRates: cloneResources(econ.resourceRates),
          });

          for (const [resource, rate] of Object.entries(econ.resourceRates)) {
            state.resources[resource] = (state.resources[resource] ?? 0) + rate * dt;
          }
          for (const item of econ.targetEconomy) {
            if (item.target.remainingStock === undefined) continue;
            item.target.remainingStock = Math.max(0, item.target.remainingStock - item.rate * dt);
          }

          state.now = stepTo;
          handleDepletedNodes(state);
        } else {
          state.now = stepTo;
        }

        if (Math.abs(state.now - nextEventTime) <= EPS) {
          const due = state.events.filter((e) => Math.abs(e.time - state.now) <= EPS);
          state.events = state.events.filter((e) => Math.abs(e.time - state.now) > EPS);
          for (const ev of due) onEventComplete(state, game, ev.actionId, ev.actors);
        }
      }
    }

    function scheduleAction(state, game, cmd, options, commandIndex) {
      const requestedAt = cmd.at ?? state.now;
      const action = game.actions[cmd.actionId];
      if (!action) {
        const msg = "Action '" + cmd.actionId + "' not found.";
        state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
        state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: msg });
        return;
      }

      const iterations = cmd.count ?? 1;
      for (let i = 0; i < iterations; i += 1) {
        let startedAt;
        let blocked = false;

        while (true) {
          const result = tryScheduleActionNow(state, game, options, cmd);
          if (result.status === "scheduled") {
            startedAt = state.now;
            break;
          }

          if (result.status === "invalid") {
            state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: result.message });
            state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
            return;
          }

          if (options.strict && result.reason === "INSUFFICIENT_RESOURCES") {
            state.violations.push({ time: state.now, code: "INSUFFICIENT_RESOURCES", message: "Insufficient resources for '" + action.id + "' at " + state.now.toFixed(2) + "s." });
            blocked = true;
            break;
          }

          const econ = computeEconomySnapshot(state);
          const nextEventTime = state.events.filter((e) => e.time > state.now + EPS).sort((a, b) => a.time - b.time)[0]?.time ?? Infinity;
          const dtToAfford =
            result.reason === "INSUFFICIENT_RESOURCES"
              ? timeToAffordWithCurrentRates(state.resources, action.costs ?? {}, econ.resourceRates, options.debtFloor)
              : Infinity;
          const next = Math.min(nextEventTime, state.now + dtToAfford, econ.nextDepletionTime ?? Infinity);

          if (!Number.isFinite(next) || next <= state.now + EPS) {
            const code = result.reason === "NO_ACTORS" ? "NO_ACTORS" : "RESOURCE_STALL";
            state.violations.push({
              time: state.now,
              code,
              message: code === "NO_ACTORS" ? "No available actors to perform '" + action.id + "'." : "Stalled waiting for resources for '" + action.id + "'.",
            });
            blocked = true;
            break;
          }

          advanceTime(state, next, game);
          processAutoQueue(state, game, options);
        }

        if (startedAt !== undefined) {
          state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, startedAt, delayedBy: startedAt - requestedAt, status: "scheduled" });
        } else {
          state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: "Could not schedule iteration " + (i + 1) + "/" + iterations + "." });
        }

        if (blocked && startedAt === undefined) break;
      }
    }

    function assignGather(state, cmd, commandIndex) {
      const requestedAt = cmd.at ?? state.now;
      const targets = resolveNodeTargets(state, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
      if (targets.length === 0) {
        const msg = "No valid resource nodes for assignGather.";
        state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
        state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
        return;
      }

      const candidates = state.entities
        .filter((e) => e.entityType === cmd.actorType)
        .sort((a, b) => (a.busyUntil !== b.busyUntil ? a.busyUntil - b.busyUntil : compareEntityIdNatural(a.id, b.id)));

      const picked = candidates.slice(0, cmd.count);
      if (picked.length < cmd.count) {
        const msg = "assignGather requested " + cmd.count + " '" + cmd.actorType + "', found " + picked.length + ".";
        state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
        state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
        return;
      }

      const assignedCount = {};
      for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
      }

      for (const ent of picked) {
        const node = pickGatherNode(ent.entityType, targets, assignedCount);
        if (!node) {
          const msg = "No gather slot available for '" + ent.id + "' on requested resource nodes.";
          state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
          state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
          return;
        }

        ent.resourceNodeId = node.id;
        assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
        if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "gather", node.produces + ":" + node.prototypeId);
      }

      state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, startedAt: state.now, delayedBy: state.now - requestedAt, status: "scheduled" });
    }

    function shiftGather(state, cmd, commandIndex) {
      const requestedAt = cmd.at ?? state.now;
      const toTargets = resolveNodeTargets(state, cmd.resourceNodeIds, cmd.resourceNodeSelectors);
      if (toTargets.length === 0) {
        const msg = "No valid destination nodes for shiftGather.";
        state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
        state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
        return;
      }

      const fromSet = new Set(resolveNodeTargets(state, cmd.fromResourceNodeIds, cmd.fromResourceNodeSelectors).map((n) => n.id));
      const candidates = state.entities
        .filter((e) => e.entityType === cmd.actorType)
        .filter((e) => (fromSet.size === 0 ? Boolean(e.resourceNodeId) : e.resourceNodeId ? fromSet.has(e.resourceNodeId) : false))
        .sort((a, b) => compareEntityIdNatural(a.id, b.id));

      const picked = candidates.slice(0, cmd.count);
      if (picked.length < cmd.count) {
        const msg = "shiftGather requested " + cmd.count + " '" + cmd.actorType + "', found " + picked.length + ".";
        state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
        state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
        return;
      }

      const assignedCount = {};
      for (const e of state.entities) {
        if (e.resourceNodeId) assignedCount[e.resourceNodeId] = (assignedCount[e.resourceNodeId] ?? 0) + 1;
      }

      for (const ent of picked) {
        if (ent.resourceNodeId) assignedCount[ent.resourceNodeId] = Math.max(0, (assignedCount[ent.resourceNodeId] ?? 1) - 1);
        const node = pickGatherNode(ent.entityType, toTargets, assignedCount);
        if (!node) {
          const msg = "No destination gather slot available for '" + ent.id + "'.";
          state.violations.push({ time: state.now, code: "INVALID_ASSIGNMENT", message: msg });
          state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, status: "failed", message: msg });
          return;
        }

        ent.resourceNodeId = node.id;
        assignedCount[node.id] = (assignedCount[node.id] ?? 0) + 1;
        if (ent.busyUntil <= state.now + EPS) switchEntityActivity(state, ent.id, "gather", node.produces + ":" + node.prototypeId);
      }

      state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, startedAt: state.now, delayedBy: state.now - requestedAt, status: "scheduled" });
    }

    function registerAutoQueue(state, cmd, commandIndex) {
      const requestedAt = cmd.at ?? state.now;
      const rule = { actionId: cmd.actionId, retryEvery: Math.max(0.1, cmd.retryEvery ?? 1), runs: 0, nextAttemptAt: state.now };
      if (cmd.actorType !== undefined) rule.actorType = cmd.actorType;
      if (cmd.actorIds !== undefined) rule.actorIds = cmd.actorIds;
      if (cmd.until !== undefined) rule.until = cmd.until;
      if (cmd.maxRuns !== undefined) rule.maxRuns = cmd.maxRuns;
      state.autoQueueRules.push(rule);
      state.commandResults.push({ index: commandIndex, type: cmd.type, requestedAt, startedAt: state.now, delayedBy: 0, status: "scheduled" });
    }

    function processAutoQueue(state, game, options) {
      let changed = false;
      do {
        changed = false;
        for (const rule of state.autoQueueRules) {
          if (rule.until !== undefined && state.now > rule.until + EPS) continue;
          if (rule.maxRuns !== undefined && rule.runs >= rule.maxRuns) continue;
          if (state.now + EPS < rule.nextAttemptAt) continue;

          const queueCmd = { actionId: rule.actionId };
          if (rule.actorType !== undefined) queueCmd.actorType = rule.actorType;
          if (rule.actorIds !== undefined) queueCmd.actorIds = rule.actorIds;

          const result = tryScheduleActionNow(state, game, options, queueCmd);
          if (result.status === "scheduled") {
            rule.runs += 1;
            rule.nextAttemptAt = state.now;
            changed = true;
            continue;
          }
          if (result.status === "invalid") {
            state.violations.push({ time: state.now, code: "ACTION_NOT_FOUND", message: result.message });
            rule.nextAttemptAt = Number.POSITIVE_INFINITY;
            continue;
          }
          rule.nextAttemptAt = state.now + rule.retryEvery;
        }
      } while (changed);
    }

    function processAutomation(state, game, options) {
      processAutoQueue(state, game, options);
    }

    function nextAutomationTime(state) {
      let next = Number.POSITIVE_INFINITY;
      for (const rule of state.autoQueueRules) {
        if (Number.isFinite(rule.nextAttemptAt)) next = Math.min(next, rule.nextAttemptAt);
      }
      return next;
    }

    function advanceWithAutomation(state, targetTime, game, options) {
      while (state.now + EPS < targetTime) {
        processAutomation(state, game, options);
        const nextAuto = nextAutomationTime(state);
        const stepTarget = Math.min(targetTime, nextAuto);

        if (stepTarget <= state.now + EPS) {
          const bumped = Math.min(targetTime, state.now + 0.1);
          if (bumped <= state.now + EPS) break;
          advanceTime(state, bumped, game);
          continue;
        }
        advanceTime(state, stepTarget, game);
      }
    }

    function computeScenarioScore(core) {
      const scheduled = core.commandResults.filter((c) => c.status === "scheduled");
      const avgDelay = scheduled.reduce((sum, c) => sum + (c.delayedBy ?? 0), 0) / Math.max(1, scheduled.length);

      const violationPenalty = core.violations.length * 10;
      const debtPenalty = Math.max(0, -core.maxDebt) * 0.4;
      const delayPenalty = avgDelay * 0.5;

      return Math.max(0, Math.min(100, 100 - violationPenalty - debtPenalty - delayPenalty));
    }

    function runSimulation(game, buildOrder, options) {
      const state = {
        now: 0,
        initialResources: cloneResources(game.startingResources),
        resources: cloneResources(game.startingResources),
        entities: [],
        resourceNodes: [],
        resourceNodeById: {},
        events: [],
        violations: [],
        commandResults: [],
        completedActions: 0,
        maxDebt: 0,
        idCounter: 0,
        resourceNodeCounter: 0,
        activeModifiers: [...(game.startingModifiers ?? [])],
        resourceTimeline: [],
        entityCountTimeline: [],
        entityTimelines: {},
        currentActivities: {},
        autoQueueRules: [],
        spawnGatherRules: {},
      };

      for (const se of game.startingEntities) {
        for (let i = 0; i < se.count; i += 1) {
          state.idCounter += 1;
          const id = se.entityType + "-" + state.idCounter;
          state.entities.push({ id, entityType: se.entityType, busyUntil: 0 });
          state.entityTimelines[id] = { entityType: se.entityType, segments: [] };
          state.currentActivities[id] = { start: 0, kind: "idle", detail: "idle" };
        }
      }

      for (const sg of game.startingResourceNodes) {
        const proto = game.resourceNodePrototypes[sg.prototypeId];
        if (!proto) continue;
        const count = sg.count ?? 1;
        for (let i = 0; i < count; i += 1) instantiateResourceNode(state, proto);
      }

      recordEntityCountPoint(state);

      const commands = normalizeCommandTimes(buildOrder.commands).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      for (const [i, cmd] of commands.entries()) {
        advanceWithAutomation(state, cmd.at ?? state.now, game, options);

        if (cmd.type === "queueAction") scheduleAction(state, game, cmd, options, i);
        else if (cmd.type === "assignGather") assignGather(state, cmd, i);
        else if (cmd.type === "autoQueue") registerAutoQueue(state, cmd, i);
        else if (cmd.type === "setSpawnGather") {
          const requestedAt = cmd.at ?? state.now;
          const rule = {};
          if (cmd.resourceNodeIds !== undefined) rule.resourceNodeIds = cmd.resourceNodeIds;
          if (cmd.resourceNodeSelectors !== undefined) rule.resourceNodeSelectors = cmd.resourceNodeSelectors;
          state.spawnGatherRules[cmd.entityType] = rule;
          state.commandResults.push({ index: i, type: cmd.type, requestedAt, startedAt: state.now, delayedBy: state.now - requestedAt, status: "scheduled" });
        } else if (cmd.type === "shiftGather") shiftGather(state, cmd, i);

        processAutomation(state, game, options);
      }

      advanceWithAutomation(state, options.evaluationTime, game, options);

      for (const [entityId, current] of Object.entries(state.currentActivities)) {
        if (current.start < options.evaluationTime) {
          state.entityTimelines[entityId]?.segments.push({ ...current, end: options.evaluationTime });
        }
      }

      const core = {
        initialResources: state.initialResources,
        resourcesAtEvaluation: state.resources,
        entitiesByType: countEntitiesByType(state.entities),
        maxDebt: state.maxDebt,
        totalDelays: state.commandResults.reduce((sum, c) => sum + (c.delayedBy ?? 0), 0),
        completedActions: state.completedActions,
        violations: state.violations,
        commandResults: state.commandResults,
        resourceTimeline: state.resourceTimeline,
        entityCountTimeline: state.entityCountTimeline,
        entityTimelines: state.entityTimelines,
      };

      return { ...core, scenarioScore: computeScenarioScore(core) };
    }

    function round2(n) {
      return Math.round(n * 100) / 100;
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function mapToString(obj) {
      return Object.entries(obj)
        .map(([k, v]) => k + ": " + round2(Number(v)))
        .join(", ");
    }

    function colorForSegment(kind, detail) {
      if (kind === "idle") return "#d9d9d9";
      if (kind === "gather") {
        const key = String(detail).toLowerCase();
        if (key.includes("food")) return "#6aa84f";
        if (key.includes("wood")) return "#a67c52";
        if (key.includes("gold")) return "#d4af37";
        if (key.includes("stone")) return "#7f8c8d";
        return "#4f8b8b";
      }
      let h = 0;
      for (let i = 0; i < String(detail).length; i += 1) h = (h * 31 + String(detail).charCodeAt(i)) >>> 0;
      return "hsl(" + (h % 360) + " 60% 62%)";
    }

    let sim = INITIAL_RESULT;

    const runBtn = document.getElementById("runBtn");
    const runStatus = document.getElementById("runStatus");
    const dslInput = document.getElementById("dslInput");
    const errorBox = document.getElementById("errorBox");

    const scoreLabel = document.getElementById("scoreLabel");
    const resourcesLine = document.getElementById("resourcesLine");
    const entitiesLine = document.getElementById("entitiesLine");
    const metaLine = document.getElementById("metaLine");

    const range = document.getElementById("timeRange");
    const input = document.getElementById("timeInput");
    const readout = document.getElementById("timeReadout");
    const stats = document.getElementById("scrubStats");

    const entityTimeline = document.getElementById("entityTimeline");
    const timelineLegend = document.getElementById("timelineLegend");
    const pxPerSecond = document.getElementById("pxPerSecond");
    const pxPerSecondReadout = document.getElementById("pxPerSecondReadout");

    const violationsTitle = document.getElementById("violationsTitle");
    const violationsBody = document.getElementById("violationsBody");
    const commandsBody = document.getElementById("commandsBody");

    function resourcesAt(t) {
      if (!sim.resourceTimeline || sim.resourceTimeline.length === 0) return sim.initialResources ?? {};

      for (const seg of sim.resourceTimeline) {
        if (t >= seg.start && t <= seg.end) {
          const dt = t - seg.start;
          const out = { ...seg.startResources };
          for (const [k, rate] of Object.entries(seg.gatherRates ?? {})) out[k] = (out[k] ?? 0) + rate * dt;
          return out;
        }
      }

      if (t <= sim.resourceTimeline[0].start) return { ...sim.initialResources };
      return { ...sim.resourcesAtEvaluation };
    }

    function renderSummary() {
      scoreLabel.textContent = "score " + Number(sim.scenarioScore).toFixed(1);
      resourcesLine.textContent = mapToString(sim.resourcesAtEvaluation ?? {});
      entitiesLine.textContent = mapToString(sim.entitiesByType ?? {});
      metaLine.textContent =
        "maxDebt: " + Number(sim.maxDebt).toFixed(2) +
        " | totalDelays: " + Number(sim.totalDelays).toFixed(2) +
        "s | completedActions: " + sim.completedActions;
    }

    function renderTables() {
      const violations = sim.violations ?? [];
      const commandResults = sim.commandResults ?? [];

      violationsTitle.textContent = "Violations (" + violations.length + ")";
      violationsBody.innerHTML =
        violations.length === 0
          ? "<tr><td colspan=3 class='muted'>None</td></tr>"
          : violations
              .map((v) => "<tr><td>" + Number(v.time).toFixed(2) + "</td><td>" + escapeHtml(v.code) + "</td><td>" + escapeHtml(v.message) + "</td></tr>")
              .join("");

      commandsBody.innerHTML = commandResults
        .map(
          (c) =>
            "<tr><td>" + c.index + "</td><td>" + escapeHtml(c.type) + "</td><td>" + Number(c.requestedAt).toFixed(2) + "</td><td>" +
            (c.startedAt === undefined ? "-" : Number(c.startedAt).toFixed(2)) + "</td><td>" +
            (c.delayedBy === undefined ? "-" : Number(c.delayedBy).toFixed(2)) + "</td><td>" +
            escapeHtml(c.status) + "</td><td>" + escapeHtml(c.message ?? "") + "</td></tr>",
        )
        .join("");
    }

    function renderScrub(t) {
      const maxTime = Math.max(sim.entityCountTimeline?.[sim.entityCountTimeline.length - 1]?.time ?? 0, sim.resourceTimeline?.[sim.resourceTimeline.length - 1]?.end ?? 0);
      readout.textContent = "t = " + round2(t) + "s / " + round2(maxTime) + "s";
      stats.innerHTML = "<p><strong>Resources:</strong> " + escapeHtml(mapToString(resourcesAt(t))) + "</p>";
    }

    function renderTimeline(t, center = false) {
      const maxTime = Math.max(sim.entityCountTimeline?.[sim.entityCountTimeline.length - 1]?.time ?? 0, sim.resourceTimeline?.[sim.resourceTimeline.length - 1]?.end ?? 0);
      const scale = Number(pxPerSecond.value || 8);
      pxPerSecondReadout.textContent = round2(scale) + " px/s";
      const width = Math.max(720, Math.ceil(maxTime * scale));
      const tickEvery = maxTime > 1200 ? 120 : maxTime > 600 ? 60 : maxTime > 240 ? 30 : 10;

      const entries = Object.entries(sim.entityTimelines ?? {})
        .map(([entityId, timeline]) => ({ entityId, timeline }))
        .sort((a, b) => compareEntityIdNatural(a.entityId, b.entityId));

      const legends = new Map();
      for (const e of entries) {
        for (const seg of e.timeline.segments ?? []) {
          const key = seg.kind + ":" + seg.detail;
          if (!legends.has(key)) legends.set(key, { kind: seg.kind, detail: seg.detail, color: colorForSegment(seg.kind, seg.detail) });
        }
      }

      timelineLegend.innerHTML = Array.from(legends.values())
        .slice(0, 18)
        .map((item) => "<span class='legend-item'><span class='legend-swatch' style='background:" + item.color + "'></span>" + escapeHtml(item.kind + " " + item.detail) + "</span>")
        .join("");

      const axisTicks = [];
      for (let x = 0; x <= maxTime + 0.0001; x += tickEvery) {
        const left = round2(x * scale);
        axisTicks.push("<div class='timeline-tick' style='left:" + left + "px'></div>");
        axisTicks.push("<div class='timeline-tick-label' style='left:" + left + "px'>" + Math.round(x) + "s</div>");
      }

      const cursorLeft = round2(t * scale);
      const rowsHtml = entries
        .map((entry) => {
          const segs = (entry.timeline.segments ?? []).map((seg) => {
            const left = round2(seg.start * scale);
            const w = Math.max(1, round2((seg.end - seg.start) * scale));
            const color = colorForSegment(seg.kind, seg.detail);
            const label = w >= 36 ? escapeHtml(seg.detail) : "";
            const title = escapeHtml(entry.entityId + " | " + seg.kind + " " + seg.detail + " | " + round2(seg.start) + "s-" + round2(seg.end) + "s");
            return "<div class='timeline-seg' title='" + title + "' style='left:" + left + "px;width:" + w + "px;background:" + color + "'>" + label + "</div>";
          });

          return "<div class='timeline-row'><div class='timeline-label' title='" + escapeHtml(entry.entityId + " (" + entry.timeline.entityType + ")") + "'>" +
            escapeHtml(entry.entityId + " (" + entry.timeline.entityType + ")") +
            "</div><div class='timeline-track' style='width:" + width + "px'><div class='timeline-cursor' style='left:" + cursorLeft + "px'></div>" + segs.join("") + "</div></div>";
        })
        .join("");

      entityTimeline.innerHTML =
        "<div class='timeline-head'><div class='timeline-label-head'>entity</div><div class='timeline-axis' style='width:" + width + "px'><div class='timeline-cursor' style='left:" + cursorLeft + "px'></div>" +
        axisTicks.join("") + "</div></div>" + rowsHtml;

      if (center) {
        const cursorX = 180 + t * scale;
        entityTimeline.scrollLeft = Math.max(0, cursorX - entityTimeline.clientWidth / 2);
      }
    }

    function syncTime(v) {
      const maxTime = Math.max(sim.entityCountTimeline?.[sim.entityCountTimeline.length - 1]?.time ?? 0, sim.resourceTimeline?.[sim.resourceTimeline.length - 1]?.end ?? 0);
      const t = Math.max(0, Math.min(maxTime, Number(v) || 0));
      range.value = String(t);
      input.value = String(t);
      renderScrub(t);
      renderTimeline(t, true);
    }

    function refreshAll() {
      const maxTime = Math.max(sim.entityCountTimeline?.[sim.entityCountTimeline.length - 1]?.time ?? 0, sim.resourceTimeline?.[sim.resourceTimeline.length - 1]?.end ?? 0);
      range.max = String(maxTime);
      input.max = String(maxTime);
      renderSummary();
      renderTables();
      syncTime(Math.min(Number(range.value) || 0, maxTime));
    }

    function runFromDsl() {
      runBtn.disabled = true;
      runStatus.textContent = "running...";
      errorBox.textContent = "";
      try {
        const build = parseBuildOrderDsl(dslInput.value);
        const result = runSimulation(GAME, build, {
          strict: false,
          evaluationTime: build.evaluationTime,
          debtFloor: build.debtFloor ?? -30,
        });
        sim = result;
        refreshAll();
        runStatus.textContent = "ok";
      } catch (err) {
        errorBox.textContent = String(err?.message ?? err);
        runStatus.textContent = "failed";
      } finally {
        runBtn.disabled = false;
      }
    }

    runBtn.addEventListener("click", runFromDsl);
    dslInput.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        runFromDsl();
      }
    });
    range.addEventListener("input", () => syncTime(range.value));
    input.addEventListener("input", () => syncTime(input.value));
    pxPerSecond.addEventListener("input", () => syncTime(range.value));

    refreshAll();
  </script>
</body>
</html>`;
}
