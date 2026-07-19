import { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  active: boolean;
  className?: string;
};

/**
 * Compact scrolling voice meter: new samples enter on the right
 * and drift left (ticker / “running line”).
 */
export function VoiceWaveform({ stream, active, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active || !stream) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);

    const timeDomain = new Uint8Array(analyser.fftSize);
    const history: number[] = [];
    const maxSamples = 160;
    let raf = 0;
    let running = true;
    let lastPush = 0;
    const pushEveryMs = 28;

    const pushLevel = (now: number) => {
      if (now - lastPush < pushEveryMs) return;
      lastPush = now;

      analyser.getByteTimeDomainData(timeDomain);
      let sum = 0;
      for (let i = 0; i < timeDomain.length; i += 1) {
        const v = ((timeDomain[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / timeDomain.length);
      // Soft gate + curve so quiet speech still shows, peaks don’t fill the strip.
      const level = Math.min(1, Math.pow(rms * 3.2, 0.65));
      history.push(level);
      while (history.length > maxSamples) history.shift();
    };

    const draw = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(draw);
      pushLevel(now);

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW < 2 || cssH < 2) return;

      const pixelW = Math.floor(cssW * dpr);
      const pixelH = Math.floor(cssH * dpr);
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const barW = 2;
      const gap = 1.5;
      const step = barW + gap;
      const visible = Math.min(history.length, Math.floor(cssW / step));
      const midY = cssH / 2;
      const start = history.length - visible;

      for (let i = 0; i < visible; i += 1) {
        const level = history[start + i] ?? 0;
        const minH = 1.5;
        const h = Math.max(minH, level * (cssH * 0.92));
        // Right edge = newest → scroll right → left.
        const x = cssW - (visible - i) * step;
        const y = midY - h / 2;
        const alpha = 0.25 + level * 0.75;
        ctx.fillStyle = `rgba(60, 158, 255, ${alpha})`;
        ctx.fillRect(x, y, barW, h);
      }
    };

    void audioCtx.resume().then(() => {
      if (running) raf = requestAnimationFrame(draw);
    });

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* ignore */
      }
      void audioCtx.close();
    };
  }, [stream, active]);

  return (
    <canvas
      ref={canvasRef}
      className={`block h-full w-full ${className}`}
      aria-hidden
    />
  );
}
