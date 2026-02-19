import { GameData } from "./types";

interface GameObjectsBootstrap {
    game: GameData;
    iconDataUris?: Record<string, string>;
    timelineHref?: string;
}

function escapeHtml(str: string): string {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function mustElement<T extends Element>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Game objects DOM is missing element '#${id}'.`);
    return el as unknown as T;
}

const bootstrapEl = mustElement<HTMLScriptElement>("__bootstrap__");
if (!bootstrapEl.textContent) throw new Error("Game objects bootstrap element is empty.");
const BOOTSTRAP = JSON.parse(bootstrapEl.textContent) as GameObjectsBootstrap;
const GAME = BOOTSTRAP.game;

function iconUrl(slug: string): string {
    return BOOTSTRAP.iconDataUris?.[slug] ?? "";
}

function entityIconUrl(entityType: string): string {
    const def = GAME.entities[entityType];
    if (!def) return "";
    return iconUrl(`${def.kind === "unit" ? "u" : "b"}_${entityType}`);
}

function resourceIconUrl(resource: string): string {
    return iconUrl(`r_${resource}`);
}

function actionIconUrl(actionId: string): string {
    const action = GAME.actions[actionId];
    if (action?.creates) {
        const entityType = Object.keys(action.creates)[0];
        if (entityType) return entityIconUrl(entityType);
    }
    if (actionId.startsWith("build_")) {
        const built = actionId.replace("build_", "");
        if (GAME.entities[built]) return entityIconUrl(built);
    }
    const techSlug = actionId.replace(/^(research_|advance_)/, "");
    return iconUrl(`t_${techSlug}`);
}

function nodeIconUrl(nodeId: string, produces: string): string {
    void nodeId;
    return resourceIconUrl(produces);
}

function iconImg(url: string, title = ""): string {
    if (!url) return "";
    return `<img src="${escapeHtml(url)}" class="db-icon" alt="" title="${escapeHtml(title)}" onerror="this.style.display='none'">`;
}

function csv(values: string[]): string {
    if (values.length === 0) return "<span class='muted'>-</span>";
    return escapeHtml(values.join(", "));
}

function dslLinesHtml(lines?: string[]): string {
    if (!lines || lines.length === 0) return "<span class='muted'>-</span>";
    return `<pre style='margin:0;white-space:pre-wrap;font-size:0.85em'>${escapeHtml(lines.join("\n"))}</pre>`;
}

function actionCostsHtml(costs?: Record<string, number>): string {
    if (!costs || Object.keys(costs).length === 0) return "<span class='muted'>-</span>";
    const orderedKeys = [
        ...(GAME.resources ?? []).filter((resource) => Object.hasOwn(costs, resource)),
        ...Object.keys(costs)
            .filter((resource) => !(GAME.resources ?? []).includes(resource))
            .sort((a, b) => a.localeCompare(b)),
    ];
    return orderedKeys
        .map((resource) => {
            const amount = costs[resource];
            return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;white-space:nowrap">
                ${iconImg(resourceIconUrl(resource), resource)}
                <code>${escapeHtml(String(amount))}</code>
                <span class="muted" style="font-size:11px">${escapeHtml(resource)}</span>
            </span>`;
        })
        .join("");
}

function render(): void {
    mustElement<HTMLAnchorElement>("timelineLink").href = BOOTSTRAP.timelineHref ?? "#";

    const actionsBody = mustElement<HTMLElement>("actionsBody");
    const actionRows = Object.entries(GAME.actions)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, action]) => {
            const hasDsl = Boolean(action.dslLines?.length);
            const mainRow = `<tr>
                <td>${iconImg(actionIconUrl(id), id)}</td>
                <td><code>${escapeHtml(id)}</code></td>
                <td>${escapeHtml(action.name)}</td>
                <td>${csv(action.actorTypes ?? [])}</td>
                <td>${escapeHtml(String(action.duration))}s</td>
                <td>${actionCostsHtml(action.costs)}</td>
            </tr>`;
            const dslRow = hasDsl
                ? `<tr style="border-top:none;"><td/><td colspan="5" style="padding:0px 8px 10px;">${dslLinesHtml(action.dslLines)}</td></tr>`
                : "";
            return `${mainRow}${dslRow}`;
        });
    actionsBody.innerHTML = actionRows.join("") || "<tr><td colspan='6' class='muted'>No actions</td></tr>";

    const unitsBody = mustElement<HTMLElement>("unitsBody");
    const buildingsBody = mustElement<HTMLElement>("buildingsBody");
    const entityEntries = Object.entries(GAME.entities).sort((a, b) => a[0].localeCompare(b[0]));
    const unitRows = entityEntries
        .filter(([, entity]) => entity.kind === "unit")
        .map(
            ([id, entity]) => `<tr>
            <td>${iconImg(entityIconUrl(id), id)}</td>
            <td><code>${escapeHtml(id)}</code></td>
            <td>${escapeHtml(entity.name)}</td>
            <td>${csv(entity.actions ?? [])}</td>
        </tr>`,
        );
    const buildingRows = entityEntries
        .filter(([, entity]) => entity.kind === "building")
        .map(
            ([id, entity]) => `<tr>
            <td>${iconImg(entityIconUrl(id), id)}</td>
            <td><code>${escapeHtml(id)}</code></td>
            <td>${escapeHtml(entity.name)}</td>
            <td>${csv(entity.actions ?? [])}</td>
        </tr>`,
        );
    unitsBody.innerHTML = unitRows.join("") || "<tr><td colspan='4' class='muted'>No units</td></tr>";
    buildingsBody.innerHTML = buildingRows.join("") || "<tr><td colspan='4' class='muted'>No buildings</td></tr>";

    const nodesBody = mustElement<HTMLElement>("nodesBody");
    const nodeRows = Object.entries(GAME.resourceNodePrototypes)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
            ([id, node]) => `<tr>
            <td>${iconImg(nodeIconUrl(id, node.produces), id)}</td>
            <td><code>${escapeHtml(id)}</code></td>
            <td>${escapeHtml(node.name)}</td>
            <td><code>${escapeHtml(node.produces)}</code></td>
            <td>${node.maxWorkers ?? "-"}</td>
            <td>${csv(node.tags ?? [])}</td>
        </tr>`,
        );
    nodesBody.innerHTML = nodeRows.join("") || "<tr><td colspan='6' class='muted'>No resource nodes</td></tr>";

    const resourcesBody = mustElement<HTMLElement>("resourcesBody");
    const resourceRows = (GAME.resources ?? [])
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map(
            (resource) => `<tr>
            <td>${iconImg(resourceIconUrl(resource), resource)}</td>
            <td><code>${escapeHtml(resource)}</code></td>
        </tr>`,
        );
    resourcesBody.innerHTML = resourceRows.join("") || "<tr><td colspan='2' class='muted'>No resources</td></tr>";

    const civsBody = mustElement<HTMLElement>("civsBody");
    const civRows = (GAME.civilizations ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
            (civ) => `<tr>
            <td>${escapeHtml(civ.name)}</td>
            <td>${dslLinesHtml(civ.dslLines)}</td>
        </tr>`,
        );
    civsBody.innerHTML = civRows.join("") || "<tr><td colspan='2' class='muted'>No civilizations</td></tr>";

    const rulesetBody = mustElement<HTMLElement>("rulesetBody");
    const ruleset = GAME.ruleset;
    rulesetBody.innerHTML = ruleset
        ? `<tr><td>${escapeHtml(ruleset.name)}</td><td>${dslLinesHtml(ruleset.dslLines)}</td></tr>`
        : "<tr><td colspan='2' class='muted'>No ruleset</td></tr>";

    const settingsBody = mustElement<HTMLElement>("settingsBody");
    const settings = Object.entries(GAME.settings ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
    const settingRows = settings.map(
        ([name, setting]) => `<tr>
        <td>${escapeHtml(name)}</td>
        <td>${dslLinesHtml(setting.dslLines)}</td>
    </tr>`,
    );
    settingsBody.innerHTML = settingRows.join("") || "<tr><td colspan='2' class='muted'>No settings</td></tr>";
}

render();
