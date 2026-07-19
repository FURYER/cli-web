"""
Long-lived faster-whisper worker for cli-web.

Protocol (stdin/stdout, one JSON object per line):
  → {"id":"1","cmd":"ping"}
  ← {"id":"1","ok":true,"ready":true,"model":"...","device":"..."}

  → {"id":"2","cmd":"transcribe","path":"C:/tmp/a.webm","language":"ru"}
  ← {"id":"2","ok":true,"transcription":"...","language":"ru"}

  → {"id":"3","cmd":"shutdown"}
  ← {"id":"3","ok":true}
"""

from __future__ import annotations

import json
import os
import sys
import traceback


def configure_stdio() -> None:
    # Windows defaults to cp1251; Node reads the pipe as UTF-8 → Cyrillic becomes �.
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass


def log(msg: str) -> None:
    data = (msg + "\n").encode("utf-8", errors="replace")
    sys.stderr.buffer.write(data)
    sys.stderr.buffer.flush()


def configure_hub() -> None:
    """Hugging Face hub: default to hf-mirror (reachable when huggingface.co is blocked)."""
    endpoint = (os.environ.get("HF_ENDPOINT") or os.environ.get("WHISPER_HF_ENDPOINT") or "").strip()
    if not endpoint:
        endpoint = "https://hf-mirror.com"
        os.environ["HF_ENDPOINT"] = endpoint
    # Official hub if someone set the mirror empty via WHISPER_HF_ENDPOINT=off
    if endpoint.lower() in ("off", "0", "false", "official", "huggingface"):
        endpoint = "https://huggingface.co"
        os.environ["HF_ENDPOINT"] = endpoint
    log(f"HF_ENDPOINT={os.environ.get('HF_ENDPOINT')}")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("https_proxy") or os.environ.get("http_proxy")
    if proxy:
        log(f"HTTP(S)_PROXY is set ({proxy.split('@')[-1] if '@' in proxy else proxy})")


def prepare_cuda_dlls() -> None:
    """On Windows, register CUDA 12 bin dirs so cublas64_12.dll can load."""
    if sys.platform != "win32":
        return
    if not hasattr(os, "add_dll_directory"):
        return

    candidates: list[str] = []
    for key in (
        "CUDA_PATH",
        "CUDA_HOME",
        "CUDA_PATH_V12_9",
        "CUDA_PATH_V12_8",
        "CUDA_PATH_V12_6",
        "CUDA_PATH_V12_4",
        "CUDA_PATH_V12_3",
        "CUDA_PATH_V12_2",
        "CUDA_PATH_V12_1",
        "CUDA_PATH_V12_0",
    ):
        root = (os.environ.get(key) or "").strip().strip('"')
        if root:
            candidates.append(os.path.join(root, "bin"))

    toolkit = r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if os.path.isdir(toolkit):
        try:
            versions = sorted(
                (n for n in os.listdir(toolkit) if n.lower().startswith("v12")),
                reverse=True,
            )
        except OSError:
            versions = []
        for ver in versions:
            candidates.append(os.path.join(toolkit, ver, "bin"))

    # Optional pip wheels: nvidia-cublas-cu12, etc.
    try:
        import site
        import glob

        for sp in site.getsitepackages() + ([site.getusersitepackages()] if site.getusersitepackages() else []):
            if not sp:
                continue
            for pattern in (
                os.path.join(sp, "nvidia", "cublas", "bin"),
                os.path.join(sp, "nvidia", "cudnn", "bin"),
                os.path.join(sp, "nvidia", "cuda_runtime", "bin"),
            ):
                candidates.append(pattern)
            for match in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
                candidates.append(match)
    except Exception:  # noqa: BLE001
        pass

    extra = (os.environ.get("WHISPER_CUDA_BIN") or "").strip().strip('"')
    if extra:
        candidates.insert(0, extra)

    seen: set[str] = set()
    registered = 0
    for raw in candidates:
        path = os.path.normpath(raw)
        key = path.lower()
        if not path or key in seen or not os.path.isdir(path):
            continue
        seen.add(key)
        try:
            os.add_dll_directory(path)
            registered += 1
            marker = os.path.join(path, "cublas64_12.dll")
            if os.path.isfile(marker):
                log(f"CUDA DLLs: {path} (found cublas64_12.dll)")
            else:
                log(f"CUDA DLLs: {path}")
        except OSError as exc:
            log(f"CUDA DLLs skip {path}: {exc}")

    if registered == 0:
        log(
            "CUDA DLLs: none found. For GPU Whisper install CUDA Toolkit 12.x "
            "from https://developer.nvidia.com/cuda-downloads "
            "(or set WHISPER_DEVICE=cpu)."
        )


def load_model(model_size: str):
    from faster_whisper import WhisperModel

    configure_hub()
    prepare_cuda_dlls()

    prefer = (os.environ.get("WHISPER_DEVICE") or "auto").strip().lower()
    download_root = (os.environ.get("WHISPER_DOWNLOAD_ROOT") or "").strip() or None
    attempts = []
    if prefer == "cpu":
        attempts = [("cpu", "int8")]
    elif prefer == "cuda":
        attempts = [("cuda", "float16"), ("cuda", "int8")]
    else:
        attempts = [("cuda", "float16"), ("cuda", "int8"), ("cpu", "int8")]

    last_err = None
    for device, compute_type in attempts:
        try:
            log(
                f"Loading Whisper model={model_size} device={device} "
                f"compute={compute_type}"
                + (f" download_root={download_root}" if download_root else "")
            )
            kwargs = {"device": device, "compute_type": compute_type}
            if download_root:
                kwargs["download_root"] = download_root
            model = WhisperModel(model_size, **kwargs)
            log(f"Whisper ready model={model_size} device={device}")
            return model, device
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            msg = str(exc)
            log(f"Whisper load failed ({device}/{compute_type}): {exc}")
            if device == "cuda" and (
                "cublas" in msg.lower()
                or "cudnn" in msg.lower()
                or "cuda" in msg.lower()
                and "not found" in msg.lower()
            ):
                log(
                    "Hint: install NVIDIA CUDA Toolkit 12.x, reboot/reopen terminal, "
                    "ensure cublas64_12.dll is under CUDA\\v12.*\\bin. "
                    "Temp workaround: WHISPER_DEVICE=cpu in .env"
                )

    raise RuntimeError(f"Could not load Whisper model: {last_err}")


def reply(payload: dict) -> None:
    # ensure_ascii=True → \uXXXX escapes; safe across any pipe code page.
    data = (json.dumps(payload, ensure_ascii=True) + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main() -> int:
    configure_stdio()
    model_size = (os.environ.get("WHISPER_MODEL") or "large-v3").strip() or "large-v3"
    default_lang = (os.environ.get("WHISPER_LANGUAGE") or "ru").strip() or None
    if default_lang in ("auto", "detect", ""):
        default_lang = None

    try:
        model, device = load_model(model_size)
    except Exception as exc:  # noqa: BLE001
        reply({"ok": False, "error": str(exc), "fatal": True})
        return 1

    reply(
        {
            "ok": True,
            "event": "ready",
            "model": model_size,
            "device": device,
        }
    )

    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")

            if cmd == "ping":
                reply(
                    {
                        "id": req_id,
                        "ok": True,
                        "ready": True,
                        "model": model_size,
                        "device": device,
                    }
                )
                continue

            if cmd == "shutdown":
                reply({"id": req_id, "ok": True})
                return 0

            if cmd == "transcribe":
                path = req.get("path")
                if not path or not isinstance(path, str):
                    reply({"id": req_id, "ok": False, "error": "path required"})
                    continue
                language = req.get("language")
                if language in (None, "", "auto", "detect"):
                    language = default_lang

                segments, info = model.transcribe(
                    path,
                    language=language,
                    vad_filter=True,
                    beam_size=5,
                )
                text = " ".join(seg.text.strip() for seg in segments if seg.text).strip()
                detected = getattr(info, "language", language)
                reply(
                    {
                        "id": req_id,
                        "ok": True,
                        "transcription": text,
                        "language": detected,
                    }
                )
                continue

            reply({"id": req_id, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as exc:  # noqa: BLE001
            log(traceback.format_exc())
            reply({"id": req_id, "ok": False, "error": str(exc)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
