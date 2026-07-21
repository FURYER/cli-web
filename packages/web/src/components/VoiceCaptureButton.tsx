import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import type { AuthMode } from "../lib/api";
import { transcribeAudio } from "../lib/api";
import { iconProps } from "./icons";
import { VoiceWaveform } from "./VoiceWaveform";

function mediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function pickRecorderMime(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

type Props = {
  auth: AuthMode;
  disabled?: boolean;
  onTranscript: (text: string) => void;
  className?: string;
  /** Waveform above the mic (default true). Hide when the control sits in a tight row. */
  showWaveform?: boolean;
};

/** Compact mic control that appends Whisper transcription via `onTranscript`. */
export function VoiceCaptureButton({
  auth,
  disabled,
  onTranscript,
  className = "",
  showWaveform = true,
}: Props) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSupported] = useState(() => mediaRecorderSupported());
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const voiceSessionRef = useRef(0);

  useEffect(() => {
    return () => {
      voiceSessionRef.current += 1;
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const cleanupStream = () => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setVoiceStream(null);
  };

  const stopRecording = async (opts?: { discard?: boolean }) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setListening(false);
      cleanupStream();
      return;
    }

    const session = voiceSessionRef.current;
    setListening(false);

    const blob = await new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const parts = chunksRef.current;
        chunksRef.current = [];
        if (!parts.length) {
          resolve(null);
          return;
        }
        resolve(new Blob(parts, { type: recorder.mimeType || "audio/webm" }));
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

    cleanupStream();

    if (opts?.discard || session !== voiceSessionRef.current) return;
    if (!blob || blob.size < 256) {
      setVoiceError("Recording too short");
      return;
    }

    setTranscribing(true);
    setVoiceError(null);
    try {
      const audio = await blobToBase64(blob);
      const result = await transcribeAudio(auth, {
        audio,
        mimeType: blob.type || "audio/webm",
      });
      if (session !== voiceSessionRef.current) return;
      const piece = result.transcription.trim();
      if (!piece) {
        setVoiceError("No speech detected");
        return;
      }
      onTranscript(piece);
    } catch (err) {
      if (session !== voiceSessionRef.current) return;
      setVoiceError(err instanceof Error ? err.message : String(err));
    } finally {
      if (session === voiceSessionRef.current) setTranscribing(false);
    }
  };

  const startRecording = async () => {
    if (!voiceSupported) {
      setVoiceError("Microphone not supported");
      return;
    }
    if (!window.isSecureContext) {
      setVoiceError("Voice needs HTTPS or localhost");
      return;
    }

    setVoiceError(null);
    voiceSessionRef.current += 1;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;
      setVoiceStream(stream);
      chunksRef.current = [];

      const mimeType = pickRecorderMime();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onerror = () => {
        setVoiceError("Recording failed");
        setListening(false);
        cleanupStream();
      };

      recorder.start(250);
      setListening(true);
    } catch {
      cleanupStream();
      setListening(false);
      setVoiceError("Microphone permission denied");
    }
  };

  const toggle = () => {
    if (transcribing || disabled) return;
    if (listening) void stopRecording();
    else void startRecording();
  };

  return (
    <div className={className}>
      {showWaveform && listening ? (
        <div className="mb-1.5 rounded-md border border-accent/30 bg-surface/80 px-2 py-1.5">
          <VoiceWaveform stream={voiceStream} active={listening} className="h-5 w-full" />
        </div>
      ) : null}
      <button
        type="button"
        disabled={disabled || !voiceSupported || transcribing}
        onClick={toggle}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
          listening
            ? "bg-accent/20 text-accent"
            : "text-muted hover:bg-elevated hover:text-ink"
        }`}
        title={
          !voiceSupported
            ? "Microphone not supported"
            : transcribing
              ? "Transcribing…"
              : listening
                ? "Stop & transcribe"
                : "Voice input"
        }
        aria-label={listening ? "Stop recording" : "Voice input"}
        aria-pressed={listening}
      >
        {listening ? <MicOff {...iconProps} /> : <Mic {...iconProps} />}
      </button>
      {transcribing ? (
        <span className="ml-1.5 text-[11px] text-muted">Transcribing…</span>
      ) : null}
      {voiceError ? (
        <p className="mt-1 text-[11px] text-red-300/90">{voiceError}</p>
      ) : null}
    </div>
  );
}
