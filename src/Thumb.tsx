import { useEffect, useState } from "react";
import { IS_WINDOWS } from "./platform";

// Browsers shrink a big screenshot to a ~56 px preview with a fast filter, which looks jagged on a
// 100% display (Retina Macs hide it). This builds a proper thumbnail: halve the size step by step
// (each step is a high-quality smooth resample) until it matches the on-screen size in real pixels.
const cache = new Map<string, string>();

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function makeThumb(src: string, maxW: number, maxH: number): Promise<string> {
  const dpr = window.devicePixelRatio || 1;
  const img = await load(src);
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const tw = Math.max(1, Math.round(img.naturalWidth * scale * dpr));
  const th = Math.max(1, Math.round(img.naturalHeight * scale * dpr));
  let source: CanvasImageSource = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  while (sw / 2 > tw && sh / 2 > th) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw / 2));
    c.height = Math.max(1, Math.round(sh / 2));
    const ctx = c.getContext("2d");
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    source = c;
    sw = c.width;
    sh = c.height;
  }
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, tw, th);
  return out.toDataURL("image/png");
}

/** An <img> that, on Windows, shows a crisp pre-scaled thumbnail instead of letting the browser squash the original. */
export default function Thumb({
  src,
  maxW,
  maxH,
  alt,
  className,
}: {
  src: string;
  maxW: number;
  maxH: number;
  alt: string;
  className?: string;
}) {
  const key = `${maxW}x${maxH}|${window.devicePixelRatio}|${src.length}|${src.slice(-64)}`;
  const [url, setUrl] = useState<string>(() => (IS_WINDOWS ? cache.get(key) ?? "" : src));

  useEffect(() => {
    if (!IS_WINDOWS) return;
    const hit = cache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let alive = true;
    makeThumb(src, maxW, maxH)
      .then((t) => {
        cache.set(key, t);
        if (alive) setUrl(t);
      })
      .catch(() => alive && setUrl(src));
    return () => {
      alive = false;
    };
  }, [key, src, maxW, maxH]);

  if (!url) return <span className={className} style={{ display: "inline-block", width: maxH, height: maxH }} />;
  // Displayed at its true size (thumbnail pixels / devicePixelRatio) so it is never resampled again.
  const dpr = window.devicePixelRatio || 1;
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      draggable={false}
      style={IS_WINDOWS ? { width: "auto", height: "auto", maxWidth: maxW, maxHeight: maxH, imageRendering: "auto" } : undefined}
      onLoad={(e) => {
        if (!IS_WINDOWS) return;
        const el = e.currentTarget;
        el.style.width = `${el.naturalWidth / dpr}px`;
        el.style.height = `${el.naturalHeight / dpr}px`;
      }}
    />
  );
}
