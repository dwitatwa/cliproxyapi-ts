export interface ThinkingInfo {
  levels: string[];
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  type: string;
  display_name: string;
  version?: string;
  description?: string;
  context_length?: number;
  max_completion_tokens?: number;
  supported_parameters?: string[];
  thinking?: ThinkingInfo;
}

const commonCreated = 1772668800;
const commonOwnedBy = "openai";
const commonType = "openai";
const commonParams = ["tools"];

function model(
  id: string,
  displayName: string,
  version: string,
  thinkingLevels: string[],
  contextLength = 400000
): ModelInfo {
  return {
    id,
    object: "model",
    created: commonCreated,
    owned_by: commonOwnedBy,
    type: commonType,
    display_name: displayName,
    version,
    context_length: contextLength,
    max_completion_tokens: 128000,
    supported_parameters: commonParams,
    thinking: { levels: thinkingLevels }
  };
}

const freeModels: ModelInfo[] = [
  model("gpt-5", "GPT 5", "gpt-5-2025-08-07", ["minimal", "low", "medium", "high"]),
  model("gpt-5-codex", "GPT 5 Codex", "gpt-5-2025-09-15", ["low", "medium", "high"]),
  model("gpt-5-codex-mini", "GPT 5 Codex Mini", "gpt-5-2025-11-07", ["low", "medium", "high"]),
  model("gpt-5.1", "GPT 5.1", "gpt-5.1-2025-11-12", ["none", "low", "medium", "high"]),
  model("gpt-5.1-codex", "GPT 5.1 Codex", "gpt-5.1-2025-11-12", ["low", "medium", "high"]),
  model("gpt-5.1-codex-mini", "GPT 5.1 Codex Mini", "gpt-5.1-2025-11-12", ["low", "medium", "high"]),
  model("gpt-5.1-codex-max", "GPT 5.1 Codex Max", "gpt-5.1-max", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.2", "GPT 5.2", "gpt-5.2", ["none", "low", "medium", "high", "xhigh"]),
  model("gpt-5.2-codex", "GPT 5.2 Codex", "gpt-5.2", ["low", "medium", "high", "xhigh"])
];

const teamOnlyModels: ModelInfo[] = [
  model("gpt-5.3-codex", "GPT 5.3 Codex", "gpt-5.3", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4", "GPT 5.4", "gpt-5.4", ["low", "medium", "high", "xhigh"], 1050000)
];

const plusOnlyModels: ModelInfo[] = [
  model("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", "gpt-5.3", ["low", "medium", "high", "xhigh"], 128000)
];

export function getPlanModels(planType: string | undefined): ModelInfo[] {
  const normalized = (planType || "pro").trim().toLowerCase();
  const base = freeModels.map((item) => ({ ...item }));

  switch (normalized) {
    case "free":
      return base;
    case "team":
    case "business":
    case "go":
      return [...base, ...teamOnlyModels.map((item) => ({ ...item }))];
    case "plus":
    case "pro":
    default:
      return [
        ...base,
        ...teamOnlyModels.map((item) => ({ ...item })),
        ...plusOnlyModels.map((item) => ({ ...item }))
      ];
  }
}
