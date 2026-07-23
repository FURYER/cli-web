import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export type SecretEntry = {
  id: string;
  key: string;
  value: string;
  updatedAt: string;
};

export type SecretMeta = {
  id: string;
  key: string;
  updatedAt: string;
};

type SecretsPayload = {
  entries: SecretEntry[];
};

type EncryptedFile = {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

function secretsFile(): string {
  return join(dataDir(), "secrets.json");
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function accessToken(): string {
  const token = process.env.ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("ACCESS_TOKEN is required to encrypt/decrypt secrets");
  }
  return token;
}

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(accessToken(), salt, 32);
}

function encryptPayload(payload: SecretsPayload): EncryptedFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptPayload(file: EncryptedFile): SecretsPayload {
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const data = Buffer.from(file.data, "base64");
  const key = deriveKey(salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8")) as SecretsPayload;
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
}

async function readPayload(): Promise<SecretsPayload> {
  try {
    const text = await readFile(secretsFile(), "utf8");
    const file = JSON.parse(text) as EncryptedFile;
    if (!file || file.v !== 1 || !file.data) return { entries: [] };
    return decryptPayload(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { entries: [] };
    throw err;
  }
}

async function writePayload(payload: SecretsPayload): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const file = encryptPayload(payload);
  await writeFile(secretsFile(), JSON.stringify(file, null, 2), "utf8");
}

export async function listSecrets(): Promise<SecretMeta[]> {
  const payload = await readPayload();
  return payload.entries.map(({ id, key, updatedAt }) => ({
    id,
    key,
    updatedAt,
  }));
}

export async function getSecret(key: string): Promise<SecretEntry | null> {
  const k = normalizeKey(key);
  if (!k) return null;
  const payload = await readPayload();
  return payload.entries.find((e) => normalizeKey(e.key) === k) ?? null;
}

export async function setSecret(input: {
  key: string;
  value: string;
}): Promise<SecretMeta> {
  const key = input.key.trim();
  if (!key) throw new Error("key is required");
  const value = String(input.value ?? "");
  if (!value) throw new Error("value is required");

  const payload = await readPayload();
  const existing = payload.entries.find(
    (e) => normalizeKey(e.key) === normalizeKey(key),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.key = key;
    existing.value = value;
    existing.updatedAt = now;
    await writePayload(payload);
    return { id: existing.id, key: existing.key, updatedAt: existing.updatedAt };
  }

  const entry: SecretEntry = {
    id: randomUUID(),
    key,
    value,
    updatedAt: now,
  };
  payload.entries.push(entry);
  await writePayload(payload);
  return { id: entry.id, key: entry.key, updatedAt: entry.updatedAt };
}

export async function deleteSecret(key: string): Promise<boolean> {
  const k = normalizeKey(key);
  if (!k) return false;
  const payload = await readPayload();
  const before = payload.entries.length;
  payload.entries = payload.entries.filter((e) => normalizeKey(e.key) !== k);
  if (payload.entries.length === before) return false;
  await writePayload(payload);
  return true;
}
