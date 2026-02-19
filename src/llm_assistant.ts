import { env, pipeline, TextStreamer, InterruptableStoppingCriteria } from "@huggingface/transformers";
import type { GameData, SimulationResult } from "./types";

const onnxWasm = env.backends?.onnx?.wasm as any;
if (onnxWasm) {
    onnxWasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/";
    onnxWasm.numThreads = 1;
}

interface BuildOrderPreset {
    id: string;
    label: string;
    dsl: string;
}

declare global {
    interface Window {
        __WORKBENCH_BOOTSTRAP__?: {
            game: GameData;
            initialResult: SimulationResult;
            buildOrderPresets?: BuildOrderPreset[];
            iconDataUris?: Record<string, string>;
            initialDsl?: string;
            withLlm?: boolean;
        };
    }
}

const MODEL_ID = "LiquidAI/LFM2.5-1.2B-Instruct-ONNX";

function buildSystemPrompt(): string {
    if (!window.__WORKBENCH_BOOTSTRAP__) return "";
    const { game: g, buildOrderPresets = [] } = window.__WORKBENCH_BOOTSTRAP__;

    const lines = [
        "You are a build order DSL scribe assistant. Your goal is to write correct DSL output for build orders.",
        "When given an existing build order: fix any DSL syntax errors and fill in any missing steps.",
        "Resources: " + g.resources.join(", "),
        "Entities: " + Object.keys(g.entities).join(", "),
        "Actions: " + Object.keys(g.actions).join(", "),
        "\nDSL syntax:",
        "  evaluation <MM:SS>",
        "  stop after clicked|completed|depleted|exhausted <target> [x<n>]",
        "  start with <entity>[x<n>], ...",
        "  auto-queue <action> using <entity>[, <entity>]",
        "  queue <action> [x<n>] using <entity>[, ...]",
        "  assign <entity> [x<n>] to <resource-node>",
        "  after <entity> <n> <command>",
        "  after [every] clicked|completed <action> <command>",
        "  after [every] depleted|exhausted <node> <command>",
        "  on clicked <action> <command>",
        "  on completed <action> <command>",
        "  on depleted <node> <command>",
        "  score time clicked <action>",
        "  score time completed <action>",
    ];

    lines.push("Your answer should contain ONLY the dsl file, nothing else.");

    const out = lines.join("\n");

    const examples = [];
    if (buildOrderPresets.length > 0) {
        examples.push("\nExample build orders:");
        for (const preset of buildOrderPresets) {
            examples.push(`\n--- ${preset.label} ---\n${preset.dsl}`);
        }
    }

    // PGM move of duplicating the prompt.
    return out + "\n" + examples.join("\n") + out;
}

let gen: any = null;
const stopping = new InterruptableStoppingCriteria();

const $ = (id: string) => document.getElementById(id) as HTMLElement;

// ── Modal open / close ────────────────────────────────────────────────────────

function openModal() {
    $("aiModal").classList.remove("ai-hidden");
    document.body.style.overflow = "hidden";

    // Always sync the prompt with the current editor content so the model
    // sees the latest DSL and can fix errors / fill blanks.
    const currentDsl = ($("dslInput") as HTMLTextAreaElement).value.trim();
    const prompt = $("aiPrompt") as HTMLTextAreaElement;
    prompt.value = currentDsl;

    if (gen) prompt.focus();
}

function closeModal() {
    $("aiModal").classList.add("ai-hidden");
    document.body.style.overflow = "";
}

$("aiOpenBtn").onclick = openModal;
$("aiModalClose").onclick = closeModal;
$("aiModal").addEventListener("click", (e) => {
    if (e.target === $("aiModal")) closeModal();
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("aiModal").classList.contains("ai-hidden")) closeModal();
});

// ── State machine ─────────────────────────────────────────────────────────────

type AiState = "idle" | "loading" | "ready" | "generating";

const statusLabels: Record<AiState, string> = {
    idle: "Not loaded",
    loading: "Downloading…",
    ready: "Ready",
    generating: "Generating…",
};

function setUiState(state: AiState, progressPct?: number) {
    // Header badge
    $("aiStatusBadge").className = `ai-badge ai-badge-${state}`;
    $("aiStatusDot").className = `ai-dot ai-dot-${state}`;
    $("aiStatusText").textContent = statusLabels[state];

    // Trigger button dot
    $("aiTriggerDot").className = `ai-dot ai-dot-${state}`;

    // Load section ↔ progress section
    $("aiLoadSection").style.display = state === "idle" ? "" : "none";
    $("aiProgressSection").style.display = state === "loading" ? "" : "none";
    if (state === "loading" && progressPct !== undefined) {
        ($("aiProgressBar") as HTMLElement).style.width = `${progressPct}%`;
        $("aiProgressLabel").textContent = `Downloading… ${progressPct}%`;
    }

    // Prompt textarea
    ($("aiPrompt") as HTMLTextAreaElement).disabled = state === "idle" || state === "loading";

    // Generate button + label
    ($("aiGenBtn") as HTMLButtonElement).disabled = state !== "ready";
    $("aiGenLabel").innerHTML = state === "generating" ? '<span class="ai-spin">⟳</span> Generating…' : "Generate DSL";

    // Stop button
    $("aiStopBtn").style.display = state === "generating" ? "" : "none";

    // Apply button: hide whenever we enter a new state (re-shown after done)
    if (state !== "ready") $("aiApplyBtn").style.display = "none";
}

// ── Load model ────────────────────────────────────────────────────────────────

($("aiLoadBtn") as HTMLButtonElement).onclick = async () => {
    setUiState("loading", 0);
    const fileProgress = new Map<string, number>();

    gen = await pipeline("text-generation", MODEL_ID, {
        dtype: "q4",
        device: "webgpu",
        progress_callback: (p: any) => {
            if (p.status === "progress" && typeof p.loaded === "number") {
                fileProgress.set(p.file, p.loaded);
                const total = Array.from(fileProgress.values()).reduce((a, b) => a + b, 0);
                const pct = Math.min(Math.round((total / 650_000_000) * 100), 99);
                setUiState("loading", pct);
            }
        },
    });

    setUiState("ready");
    ($("aiPrompt") as HTMLTextAreaElement).focus();
};

// ── Generate ──────────────────────────────────────────────────────────────────

($("aiGenBtn") as HTMLButtonElement).onclick = async () => {
    $("aiOutput").textContent = "";
    $("aiOutput").style.display = "";
    setUiState("generating");
    stopping.reset();

    const streamer = new TextStreamer(gen.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (tok: string) => {
            $("aiOutput").textContent += tok;
            $("aiOutput").scrollTop = $("aiOutput").scrollHeight;
        },
    });

    await gen(
        [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: ($("aiPrompt") as HTMLTextAreaElement).value },
        ],
        {
            max_new_tokens: 1024,
            do_sample: true,
            streamer,
            stopping_criteria: stopping,
        },
    );

    setUiState("ready");
    $("aiApplyBtn").style.display = "";
};

// ── Stop ──────────────────────────────────────────────────────────────────────

($("aiStopBtn") as HTMLButtonElement).onclick = () => {
    stopping.interrupt();
};

// ── Apply to editor ───────────────────────────────────────────────────────────

($("aiApplyBtn") as HTMLButtonElement).onclick = () => {
    ($("dslInput") as HTMLTextAreaElement).value = $("aiOutput").textContent?.trim() ?? "";
    closeModal();
};
