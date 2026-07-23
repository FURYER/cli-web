import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { AskAnswerFile, AskAnswerImage, AskQuestionAnswer } from "./ask-question.js";
import { isPathInsideRoot, MAX_MEDIA_BYTES } from "./media.js";
import { WORKSPACE_META_DIR } from "./paths.js";

/** Match Composer MAX_IMAGES. */
export const MAX_ASK_IMAGES = 12;
export const MAX_ASK_FILES = 12;
/** Per-attachment cap (board uses MAX_MEDIA_BYTES; ask answers stay tighter). */
export const MAX_ASK_ATTACHMENT_BYTES = Math.min(25 * 1024 * 1024, MAX_MEDIA_BYTES);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeFileName(name: string): string {
  const base = basename(name.trim() || "file");
  return base.replace(/[^\w.\-()+@]/g, "_") || "file";
}

function sanitizeCallId(callId: string): string {
  const cleaned = callId.trim().replace(/[^\w.\-]/g, "_");
  return cleaned.slice(0, 80) || randomUUID();
}

function extensionForMime(mimeType: string, fallbackName?: string): string {
  const fromName = fallbackName ? extname(fallbackName) : "";
  if (fromName) return fromName;
  const mime = mimeType.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
  if (mime === "application/json") return ".json";
  return "";
}

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("image/");
}

function decodeBase64(data: string): Buffer {
  const trimmed = data.trim();
  if (!trimmed) throw new Error("Empty attachment data");
  const buf = Buffer.from(trimmed, "base64");
  if (!buf.length) throw new Error("Empty attachment data");
  if (buf.length > MAX_ASK_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment too large (max ${Math.round(MAX_ASK_ATTACHMENT_BYTES / (1024 * 1024))}MB)`,
    );
  }
  return buf;
}

function parseImage(raw: unknown, index: number): AskAnswerImage {
  const row = asRecord(raw);
  if (!row) throw new Error(`Invalid image at index ${index}`);
  const mimeType =
    typeof row.mimeType === "string" && row.mimeType.trim()
      ? row.mimeType.trim()
      : "";
  if (!mimeType || !isImageMime(mimeType)) {
    throw new Error(`Invalid image mimeType at index ${index}`);
  }
  const data = typeof row.data === "string" ? row.data : "";
  if (!data.trim()) throw new Error(`Image data required at index ${index}`);
  decodeBase64(data);
  return { mimeType, data };
}

function parseFile(raw: unknown, index: number): AskAnswerFile {
  const row = asRecord(raw);
  if (!row) throw new Error(`Invalid file at index ${index}`);
  const name =
    typeof row.name === "string" && row.name.trim() ? row.name.trim() : `file-${index + 1}`;
  const mimeType =
    typeof row.mimeType === "string" && row.mimeType.trim()
      ? row.mimeType.trim()
      : "application/octet-stream";
  if (isImageMime(mimeType)) {
    throw new Error(`Use images[] for image attachments (file index ${index})`);
  }
  const data = typeof row.data === "string" ? row.data : "";
  if (!data.trim()) throw new Error(`File data required at index ${index}`);
  decodeBase64(data);
  return { name, mimeType, data };
}

/**
 * Validate client answer payload (options + optional attachments).
 * Throws on invalid shape / mime / size / count.
 */
export function validateAskQuestionAnswers(
  answers: unknown,
): AskQuestionAnswer[] {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("answers are required");
  }

  let totalImages = 0;
  let totalFiles = 0;
  const out: AskQuestionAnswer[] = [];

  for (const [index, item] of answers.entries()) {
    const row = asRecord(item);
    if (!row) throw new Error(`Invalid answer at index ${index}`);
    const questionId =
      typeof row.questionId === "string" && row.questionId.trim()
        ? row.questionId.trim()
        : "";
    if (!questionId) throw new Error(`questionId required at index ${index}`);

    const selectedOptionIds = Array.isArray(row.selectedOptionIds)
      ? row.selectedOptionIds.filter(
          (id): id is string => typeof id === "string" && Boolean(id.trim()),
        )
      : [];
    const freeformText =
      typeof row.freeformText === "string" && row.freeformText.trim()
        ? row.freeformText.trim()
        : undefined;

    const imagesRaw = row.images;
    const filesRaw = row.files;
    const images: AskAnswerImage[] = [];
    const files: AskAnswerFile[] = [];

    if (imagesRaw != null) {
      if (!Array.isArray(imagesRaw)) {
        throw new Error(`answers[${index}].images must be an array`);
      }
      for (const [imgIndex, img] of imagesRaw.entries()) {
        images.push(parseImage(img, imgIndex));
      }
    }
    if (filesRaw != null) {
      if (!Array.isArray(filesRaw)) {
        throw new Error(`answers[${index}].files must be an array`);
      }
      for (const [fileIndex, file] of filesRaw.entries()) {
        files.push(parseFile(file, fileIndex));
      }
    }

    totalImages += images.length;
    totalFiles += files.length;
    if (totalImages > MAX_ASK_IMAGES) {
      throw new Error(`Too many images (max ${MAX_ASK_IMAGES})`);
    }
    if (totalFiles > MAX_ASK_FILES) {
      throw new Error(`Too many files (max ${MAX_ASK_FILES})`);
    }

    out.push({
      questionId,
      selectedOptionIds,
      ...(freeformText ? { freeformText } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    });
  }

  return out;
}

async function writeUpload(
  workspace: string,
  callId: string,
  fileName: string,
  buf: Buffer,
): Promise<{ abs: string; relativePath: string }> {
  const safeCall = sanitizeCallId(callId);
  const root = join(workspace, WORKSPACE_META_DIR, "ask-uploads");
  const dir = join(root, safeCall);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, fileName);
  if (!isPathInsideRoot(root, abs)) {
    throw new Error("Invalid ask upload path");
  }
  await writeFile(abs, buf);
  const relativePath = relative(workspace, abs).replace(/\\/g, "/");
  return { abs, relativePath };
}

/**
 * Save ask_user answer attachments under `.webcli/ask-uploads/<callId>/…`
 * and attach workspace-relative `path` on each image/file.
 * File `data` is stripped after save; image `data` is kept for chat UI thumbs.
 */
export async function persistAskAnswerAttachments(
  workspace: string,
  callId: string,
  answers: AskQuestionAnswer[],
): Promise<AskQuestionAnswer[]> {
  const ws = workspace.trim();
  if (!ws) throw new Error("Session workspace is required");

  let imageSeq = 0;
  let fileSeq = 0;
  const out: AskQuestionAnswer[] = [];

  for (const answer of answers) {
    const images: AskAnswerImage[] = [];
    for (const img of answer.images ?? []) {
      if (!img.data) continue;
      const buf = decodeBase64(img.data);
      const ext = extensionForMime(img.mimeType) || ".bin";
      const fileName = `img-${imageSeq++}-${randomUUID().slice(0, 8)}${ext}`;
      const { relativePath } = await writeUpload(ws, callId, fileName, buf);
      images.push({
        mimeType: img.mimeType,
        data: img.data,
        path: relativePath,
      });
    }

    const files: AskAnswerFile[] = [];
    for (const file of answer.files ?? []) {
      if (!file.data) continue;
      const buf = decodeBase64(file.data);
      const safe = sanitizeFileName(file.name);
      const ext = extensionForMime(file.mimeType, safe);
      const base = ext && !safe.toLowerCase().endsWith(ext.toLowerCase()) ? `${safe}${ext}` : safe;
      const fileName = `file-${fileSeq++}-${randomUUID().slice(0, 8)}-${base}`;
      const { relativePath } = await writeUpload(ws, callId, fileName, buf);
      files.push({
        name: file.name.trim() || safe,
        mimeType: file.mimeType,
        path: relativePath,
        size: buf.length,
      });
    }

    out.push({
      questionId: answer.questionId,
      selectedOptionIds: answer.selectedOptionIds,
      ...(answer.freeformText ? { freeformText: answer.freeformText } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    });
  }

  return out;
}

/** Agent-facing copy: paths + metadata, no base64 payloads. */
export function askAnswersForAgent(answers: AskQuestionAnswer[]): AskQuestionAnswer[] {
  return answers.map((answer) => ({
    questionId: answer.questionId,
    selectedOptionIds: answer.selectedOptionIds,
    ...(answer.freeformText ? { freeformText: answer.freeformText } : {}),
    ...(answer.images?.length
      ? {
          images: answer.images.map((img) => ({
            mimeType: img.mimeType,
            ...(img.path ? { path: img.path } : {}),
          })),
        }
      : {}),
    ...(answer.files?.length
      ? {
          files: answer.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            ...(file.path ? { path: file.path } : {}),
            ...(typeof file.size === "number" ? { size: file.size } : {}),
          })),
        }
      : {}),
  }));
}

export function countAskAttachments(answers: AskQuestionAnswer[]): {
  images: number;
  files: number;
} {
  let images = 0;
  let files = 0;
  for (const answer of answers) {
    images += answer.images?.length ?? 0;
    files += answer.files?.length ?? 0;
  }
  return { images, files };
}
