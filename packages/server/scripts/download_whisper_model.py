#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pre-download the faster-whisper model (uses HF mirror by default)."""

from __future__ import annotations

import os
import sys


def main() -> int:
    os.environ.setdefault("PYTHONUTF8", "1")
    endpoint = (os.environ.get("HF_ENDPOINT") or os.environ.get("WHISPER_HF_ENDPOINT") or "").strip()
    if not endpoint or endpoint.lower() in ("off", "0", "false"):
        # Default mirror — huggingface.co is often unreachable without VPN/proxy
        endpoint = "https://hf-mirror.com"
    if endpoint.lower() in ("official", "huggingface"):
        endpoint = "https://huggingface.co"
    os.environ["HF_ENDPOINT"] = endpoint

    model = (os.environ.get("WHISPER_MODEL") or "large-v3").strip() or "large-v3"
    print(f"HF_ENDPOINT={endpoint}", flush=True)
    print(f"Downloading Whisper model={model} (first run can take a long time)...", flush=True)

    from faster_whisper import WhisperModel

    # CPU int8 is enough to trigger download + cache; server will reload as needed.
    WhisperModel(model, device="cpu", compute_type="int8")
    print("Done. Model is cached; restart WebCLI / promote release and try voice again.", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
