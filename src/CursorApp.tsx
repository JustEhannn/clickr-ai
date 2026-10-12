import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import cursorImg from "./assets/agent-cursor.png";
import { IS_WINDOWS } from "./platform";

type CursorEvent = {
  kind: "move" | "click" | "label";
  x: number;
  y: number;
  label: string;
  /** Windows: where the glide starts and how long it takes (the real pointer follows the same curve). */
  fromX?: number;
  fromY?: number;
  ms?: number;
};

const SIZE = 34;
// The arrow's tip sits a couple of pixels inside the image's top-left corner.
const HOT = { x: 2, y: 2 };

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Transparent, click-through overlay that shows where the agent is clicking. */
export default function CursorApp() {
  const [pos, setPos] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState("");
  const [ripple, setRipple] = useState(0);
  const [pressed, setPressed] = useState(false);
  const labelTimer = useRef<number | undefined>(undefined);
  const elRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(pos);
  const raf = useRef(0);

  const place = (x: number, y: number) => {
    posRef.current = { x, y };
    if (elRef.current) elRef.current.style.transform = `translate(${x - HOT.x}px, ${y - HOT.y}px)`;
  };

  // Windows: a frame-by-frame glide on the same eased curve and duration the real pointer uses,
  // so the highlight and the actual pointer travel together and arrive together.
  const glide = (fromX: number, fromY: number, toX: number, toY: number, ms: number) => {
    cancelAnimationFrame(raf.current);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / Math.max(ms, 1), 1);
      const e = easeInOutCubic(t);
      place(fromX + (toX - fromX) * e, fromY + (toY - fromY) * e);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    if (IS_WINDOWS) {
      // First glide starts from wherever the real pointer is.
      void invoke<[number, number] | null>("agent_pointer_pos")
        .then((p) => {
          if (p) {
            place(p[0], p[1]);
            setPos({ x: p[0], y: p[1] });
          }
        })
        .catch(() => {});
    }
    const un = listen<CursorEvent>("agent-cursor", ({ payload }) => {
      setVisible(true);
      if (payload.kind === "move" && IS_WINDOWS && payload.ms) {
        const from = payload.fromX !== undefined && payload.fromY !== undefined
          ? { x: payload.fromX, y: payload.fromY }
          : posRef.current;
        glide(from.x, from.y, payload.x, payload.y, payload.ms);
      } else if (payload.kind !== "label") {
        setPos({ x: payload.x, y: payload.y });
        place(payload.x, payload.y);
      }
      if (payload.kind === "click") {
        setRipple((n) => n + 1);
        setPressed(true);
        window.setTimeout(() => setPressed(false), 170);
      }
      if (payload.kind === "label") {
        setLabel(payload.label);
        window.clearTimeout(labelTimer.current);
        labelTimer.current = window.setTimeout(() => setLabel(""), 1600);
      }
    });
    return () => {
      cancelAnimationFrame(raf.current);
      void un.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="agent-cursor-layer">
      <div
        ref={elRef}
        className={`agent-cursor ${visible ? "visible" : ""} ${IS_WINDOWS ? "glide-js" : ""} ${pressed ? "pressed" : ""}`}
        style={{ transform: `translate(${pos.x - HOT.x}px, ${pos.y - HOT.y}px)` }}
      >
        {ripple > 0 && <span key={ripple} className="agent-cursor-ripple" style={{ left: HOT.x, top: HOT.y }} />}
        <img src={cursorImg} width={SIZE} alt="" draggable={false} />
        {label && <span className="agent-cursor-label">{label}</span>}
      </div>
    </div>
  );
}
