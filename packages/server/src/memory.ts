import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export type MemoryEntry = {
  id: string;
  key: string;
  value: string;
  tags: string[];
  updatedAt: string;
};

type MemoryStore = {
  entries: MemoryEntry[];
};

function memoryFile(): string {
  return join(dataDir(), "memory.json");
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

async function readStore(): Promise<MemoryStore> {
  try {
    const text = await readFile(memoryFile(), "utf8");
    const parsed = JSON.parse(text) as MemoryStore;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return {
      entries: parsed.entries.filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          typeof e.key === "string" &&
          typeof e.value === "string",
      ),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("Failed to load memory.json:", err);
    return { entries: [] };
  }
}

async function writeStore(store: MemoryStore): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(memoryFile(), JSON.stringify(store, null, 2), "utf8");
}

export async function listMemory(tag?: string): Promise<MemoryEntry[]> {
  const store = await readStore();
  const needle = tag?.trim().toLowerCase();
  if (!needle) return store.entries;
  return store.entries.filter((e) =>
    (e.tags || []).some((t) => t.toLowerCase() === needle),
  );
}

export async function getMemory(key: string): Promise<MemoryEntry | null> {
  const k = normalizeKey(key);
  if (!k) return null;
  const store = await readStore();
  return store.entries.find((e) => normalizeKey(e.key) === k) ?? null;
}

export async function setMemory(input: {
  key: string;
  value: string;
  tags?: string[];
}): Promise<MemoryEntry> {
  const key = input.key.trim();
  if (!key) throw new Error("key is required");
  const value = String(input.value ?? "");
  const tags = (input.tags || [])
    .map((t) => t.trim())
    .filter(Boolean);

  const store = await readStore();
  const existing = store.entries.find(
    (e) => normalizeKey(e.key) === normalizeKey(key),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.key = key;
    existing.value = value;
    existing.tags = tags;
    existing.updatedAt = now;
    await writeStore(store);
    return existing;
  }

  const entry: MemoryEntry = {
    id: randomUUID(),
    key,
    value,
    tags,
    updatedAt: now,
  };
  store.entries.push(entry);
  await writeStore(store);
  return entry;
}

export async function deleteMemory(key: string): Promise<boolean> {
  const k = normalizeKey(key);
  if (!k) return false;
  const store = await readStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => normalizeKey(e.key) !== k);
  if (store.entries.length === before) return false;
  await writeStore(store);
  return true;
}
