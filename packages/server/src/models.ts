import { Cursor } from "@cursor/sdk";
import { requireAgentApiKey } from "./paths.js";

export type ModelOption = {
  id: string;
  displayName: string;
  description?: string;
};

function requireApiKey(): string {
  return requireAgentApiKey();
}

function cleanDisplayName(id: string, raw?: string): string {
  let displayName = (raw || id).trim();
  const wrapped = `(${id})`;
  if (displayName.endsWith(wrapped)) {
    displayName = displayName.slice(0, -wrapped.length).trim() || id;
  }
  return displayName;
}

export async function listModels(): Promise<ModelOption[]> {
  const models = await Cursor.models.list({ apiKey: requireApiKey() });
  const seenIds = new Set<string>(["auto"]);
  const seenLabels = new Set<string>(["auto"]);
  const options: ModelOption[] = [
    { id: "auto", displayName: "Auto", description: "Server picks the best model" },
  ];

  for (const model of models) {
    const id = model.id?.trim();
    if (!id) continue;
    const idKey = id.toLowerCase();
    if (seenIds.has(idKey)) continue;

    const displayName = cleanDisplayName(id, model.displayName);
    const labelKey = displayName.toLowerCase();
    // Skip API aliases that are just another "Auto".
    if (seenLabels.has(labelKey)) continue;

    seenIds.add(idKey);
    seenLabels.add(labelKey);
    options.push({
      id,
      displayName,
      description: model.description,
    });
  }
  return options;
}
