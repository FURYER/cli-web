import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import type {
  AskAnswerFile,
  AskAnswerImage,
  AskQuestionAnswer,
  AskQuestionItem,
  AuthMode,
} from "../lib/api";
import { iconProps } from "./icons";
import { VoiceCaptureButton } from "./VoiceCaptureButton";

type Props = {
  callId: string;
  title?: string;
  questions: AskQuestionItem[];
  status: "pending" | "answered" | "skipped";
  answers?: AskQuestionAnswer[];
  /** Aggregated images on the stored question message (answered state). */
  messageImages?: { mimeType: string; dataUrl: string }[];
  submitting?: boolean;
  auth?: AuthMode;
  onSubmit?: (answers: AskQuestionAnswer[]) => void;
  onSkip?: () => void;
};

const MAX_ASK_IMAGES = 12;
const MAX_ASK_FILES = 12;

type PendingImage = {
  kind: "image";
  preview: string;
  mimeType: string;
  data: string;
};

type PendingFile = {
  kind: "file";
  name: string;
  mimeType: string;
  data: string;
};

type PendingAttachment = PendingImage | PendingFile;

/** Options that only mean "I'll type my own" — redundant with the freeform field. */
function isRedundantOwnAnswerOption(label: string, id: string): boolean {
  const text = `${id} ${label}`.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    /^(custom|other|own|freeform|свободн)/i.test(text) ||
    /\b(свой|своя|сво[её]|другое|другой|напиши|написать|свой вариант|own answer|write your own|something else)\b/i.test(
      text,
    ) ||
    /^(свой|другое|other|custom)$/i.test(label.trim())
  );
}

function visibleOptions(question: AskQuestionItem) {
  return (question.options ?? []).filter(
    (option) => !isRedundantOwnAnswerOption(option.label, option.id),
  );
}

function labelFor(
  question: AskQuestionItem,
  selectedIds: string[],
  freeform?: string,
): string {
  const labels = selectedIds
    .map(
      (id) =>
        (question.options ?? []).find((option) => option.id === id)?.label ?? id,
    )
    .filter(Boolean);
  const parts = [...labels, freeform?.trim()].filter(Boolean);
  return parts.join(", ") || "—";
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function FreeformAnswerInput({
  value,
  disabled,
  onChange,
  onClear,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    // ~1 line base → grow up to ~4 lines.
    const next = Math.min(Math.max(el.scrollHeight, 36), 96);
    el.style.height = `${next}px`;
  }, [value]);

  return (
    <div className="relative min-w-0 flex-1">
      <label className="block">
        <span className="sr-only">Your own answer</span>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Or write your own…"
          className={`max-h-24 min-h-9 w-full resize-none overflow-y-auto rounded-lg bg-white/[0.03] py-2 text-sm leading-snug text-ink outline-none ring-1 placeholder:text-muted/70 disabled:opacity-50 ${
            value.trim() ? "pl-3 pr-9" : "px-3"
          } ${
            value.trim()
              ? "ring-accent/40"
              : "ring-line focus:ring-accent/30"
          }`}
        />
      </label>
      {value.trim() && !disabled ? (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
          title="Clear answer"
          aria-label="Clear answer"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function collectAnsweredMedia(answers: AskQuestionAnswer[] | undefined): {
  images: { src: string; mimeType: string }[];
  files: { name: string; mimeType: string; path?: string }[];
} {
  const images: { src: string; mimeType: string }[] = [];
  const files: { name: string; mimeType: string; path?: string }[] = [];
  for (const answer of answers ?? []) {
    for (const img of answer.images ?? []) {
      if (img.data) {
        images.push({
          src: `data:${img.mimeType};base64,${img.data}`,
          mimeType: img.mimeType,
        });
      }
    }
    for (const file of answer.files ?? []) {
      files.push({
        name: file.name,
        mimeType: file.mimeType,
        path: file.path,
      });
    }
  }
  return { images, files };
}

export function AskQuestionCard({
  title,
  questions,
  status,
  answers,
  messageImages,
  submitting,
  auth,
  onSubmit,
  onSkip,
}: Props) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const question of questions) initial[question.id] = [];
    return initial;
  });
  const [freeform, setFreeform] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const question of questions) initial[question.id] = "";
    return initial;
  });
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const answeredMap = useMemo(() => {
    const map = new Map<string, AskQuestionAnswer>();
    for (const answer of answers ?? []) map.set(answer.questionId, answer);
    return map;
  }, [answers]);

  const answeredMedia = useMemo(() => {
    const fromAnswers = collectAnsweredMedia(answers);
    if (fromAnswers.images.length > 0 || !messageImages?.length) {
      return fromAnswers;
    }
    return {
      images: messageImages.map((img) => ({
        src: img.dataUrl,
        mimeType: img.mimeType,
      })),
      files: fromAnswers.files,
    };
  }, [answers, messageImages]);

  const imageCount = attachments.filter((a) => a.kind === "image").length;
  const fileCount = attachments.filter((a) => a.kind === "file").length;
  const hasAttachments = attachments.length > 0;

  const canSubmit =
    status === "pending" &&
    !submitting &&
    questions.every((question) => {
      const opts = visibleOptions(question);
      const hasSelection = (selected[question.id]?.length ?? 0) > 0;
      const hasFreeform = Boolean(freeform[question.id]?.trim());
      // No preset choices → freeform/attachments optional; Continue always ok.
      if (opts.length === 0) return true;
      return hasSelection || hasFreeform || hasAttachments;
    });

  function updateFreeform(question: AskQuestionItem, value: string) {
    setFreeform((prev) => ({ ...prev, [question.id]: value }));
    // Single-choice: typing/voice own answer clears preset selection.
    if (!question.allowMultiple && value.trim()) {
      setSelected((prev) =>
        (prev[question.id]?.length ?? 0) > 0
          ? { ...prev, [question.id]: [] }
          : prev,
      );
    }
  }

  function toggleOption(question: AskQuestionItem, optionId: string) {
    if (question.allowMultiple) {
      setSelected((prev) => {
        const current = prev[question.id] ?? [];
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...prev, [question.id]: next };
      });
      return;
    }

    const current = selected[question.id] ?? [];
    const selecting = !current.includes(optionId);
    setSelected((prev) => ({
      ...prev,
      [question.id]: selecting ? [optionId] : [],
    }));
    // Selecting a preset drops freeform so it is not sent to the agent.
    if (selecting) {
      setFreeform((prev) =>
        prev[question.id] ? { ...prev, [question.id]: "" } : prev,
      );
    }
  }

  async function addFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    const nextImages: PendingImage[] = [];
    const nextFiles: PendingFile[] = [];
    for (const file of [...fileList]) {
      const data = await fileToBase64(file);
      if (file.type.startsWith("image/")) {
        const mimeType = file.type || "image/png";
        nextImages.push({
          kind: "image",
          mimeType,
          data,
          preview: `data:${mimeType};base64,${data}`,
        });
      } else {
        nextFiles.push({
          kind: "file",
          name: file.name || "file",
          mimeType: file.type || "application/octet-stream",
          data,
        });
      }
    }
    setAttachments((prev) => {
      const images = [
        ...prev.filter((a): a is PendingImage => a.kind === "image"),
        ...nextImages,
      ].slice(0, MAX_ASK_IMAGES);
      const files = [
        ...prev.filter((a): a is PendingFile => a.kind === "file"),
        ...nextFiles,
      ].slice(0, MAX_ASK_FILES);
      return [...images, ...files];
    });
  }

  function handleSubmit() {
    if (!canSubmit || !onSubmit) return;
    const images: AskAnswerImage[] = attachments
      .filter((a): a is PendingImage => a.kind === "image")
      .map((a) => ({ mimeType: a.mimeType, data: a.data }));
    const files: AskAnswerFile[] = attachments
      .filter((a): a is PendingFile => a.kind === "file")
      .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));

    onSubmit(
      questions.map((question, index) => {
        const text = freeform[question.id]?.trim();
        const ids = selected[question.id] ?? [];
        const attach =
          index === 0
            ? {
                ...(images.length ? { images } : {}),
                ...(files.length ? { files } : {}),
              }
            : {};
        // Single-choice: freeform and presets are mutually exclusive.
        if (!question.allowMultiple) {
          if (text) {
            return {
              questionId: question.id,
              selectedOptionIds: [],
              freeformText: text,
              ...attach,
            };
          }
          return {
            questionId: question.id,
            selectedOptionIds: ids,
            ...attach,
          };
        }
        return {
          questionId: question.id,
          selectedOptionIds: ids,
          ...(text ? { freeformText: text } : {}),
          ...attach,
        };
      }),
    );
  }

  return (
    <div className="w-full rounded-xl border border-line bg-elevated/80 px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {title?.trim() || "Question"}
        </p>
        {status !== "pending" ? (
          <span className="text-[11px] text-muted">
            {status === "answered" ? "Answered" : "Skipped"}
          </span>
        ) : null}
      </div>

      <div className="space-y-3">
        {questions.map((question) => {
          const chosen = selected[question.id] ?? [];
          const answered = answeredMap.get(question.id);
          const customValue = freeform[question.id] ?? "";
          const options = visibleOptions(question);
          return (
            <div key={question.id} className="space-y-1.5">
              <p className="text-sm leading-snug text-ink">{question.prompt}</p>
              {status === "pending" ? (
                <div className="flex flex-col gap-1.5">
                  {options.map((option) => {
                    const active = chosen.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => toggleOption(question, option.id)}
                        className={`rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          active
                            ? "bg-accent/20 text-ink ring-1 ring-accent/40"
                            : "bg-white/[0.03] text-ink/90 ring-1 ring-line hover:bg-white/[0.06]"
                        }`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                  <div className="mt-0.5 flex items-start gap-1.5">
                    <FreeformAnswerInput
                      value={customValue}
                      disabled={submitting}
                      onChange={(value) => updateFreeform(question, value)}
                      onClear={() => updateFreeform(question, "")}
                    />
                    {auth ? (
                      <VoiceCaptureButton
                        auth={auth}
                        disabled={submitting}
                        showWaveform={false}
                        className="shrink-0"
                        onTranscript={(piece) => {
                          const base = (freeform[question.id] ?? "").trimEnd();
                          updateFreeform(
                            question,
                            base ? `${base} ${piece}` : piece,
                          );
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  {labelFor(
                    question,
                    answered?.selectedOptionIds ?? [],
                    answered?.freeformText,
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {status === "pending" && attachments.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {attachments.map((item, index) =>
            item.kind === "image" ? (
              <div key={`img-${index}`} className="group relative">
                <img
                  src={item.preview}
                  alt=""
                  className="h-12 w-12 rounded-lg object-cover ring-1 ring-line"
                />
                <button
                  type="button"
                  disabled={submitting}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-panel text-[9px] text-muted ring-1 ring-line hover:text-ink disabled:opacity-40"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, i) => i !== index))
                  }
                  aria-label="Remove image"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div
                key={`file-${index}`}
                className="group relative flex max-w-[10rem] items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5 text-[11px] text-ink ring-1 ring-line"
              >
                <span className="truncate" title={item.name}>
                  {item.name}
                </span>
                <button
                  type="button"
                  disabled={submitting}
                  className="shrink-0 text-muted hover:text-ink disabled:opacity-40"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, i) => i !== index))
                  }
                  aria-label="Remove file"
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            ),
          )}
        </div>
      ) : null}

      {status !== "pending" &&
      (answeredMedia.images.length > 0 || answeredMedia.files.length > 0) ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {answeredMedia.images.map((img, index) => (
            <img
              key={`answered-img-${index}`}
              src={img.src}
              alt=""
              className="h-12 w-12 rounded-lg object-cover ring-1 ring-line"
            />
          ))}
          {answeredMedia.files.map((file, index) => (
            <span
              key={`answered-file-${index}`}
              className="max-w-[12rem] truncate rounded-lg bg-white/[0.03] px-2 py-1.5 text-[11px] text-muted ring-1 ring-line"
              title={file.path || file.name}
            >
              {file.name}
            </span>
          ))}
        </div>
      ) : null}

      {status === "pending" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-[var(--color-accent-ink)] disabled:opacity-40"
          >
            {submitting ? "Sending…" : "Continue"}
          </button>
          <button
            type="button"
            disabled={
              submitting ||
              (imageCount >= MAX_ASK_IMAGES && fileCount >= MAX_ASK_FILES)
            }
            onClick={() => fileInputRef.current?.click()}
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.04] hover:text-ink disabled:opacity-40"
            title="Attach photo or file"
            aria-label={
              hasAttachments
                ? `Attach (${attachments.length})`
                : "Attach photo or file"
            }
          >
            <Paperclip {...iconProps} />
            {hasAttachments ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,*/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {onSkip ? (
            <button
              type="button"
              disabled={submitting}
              onClick={onSkip}
              className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
            >
              Skip
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
