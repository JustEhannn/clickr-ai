import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import cursorImg from "./assets/agent-cursor.png";

type CursorEvent = { kind: "move" | "click" | "label"; x: number; y: number; label: string };

const SIZE = 34;
// The arrow's tip sits a couple of pixels inside the image's top-left corner.
const HOT = { x: 2, y: 2 };

/** Transparent, click-through overlay that shows where the agent is clicking. */
export default function CursorApp() {
  const [pos, setPos] = useState({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const [visible, setVisible] = useState(false);
  const [label, setLabel] = useState("");
  const [ripple, setRipple] = useState(0);
  const labelTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const un = listen<CursorEvent>("agent-cursor", ({ payload }) => {
      setVisible(true);
      if (payload.kind !== "label") setPos({ x: payload.x, y: payload.y });
      if (payload.kind === "click") setRipple((n) => n + 1);
      if (payload.kind === "label") {
        setLabel(payload.label);
        window.clearTimeout(labelTimer.current);
        labelTimer.current = window.setTimeout(() => setLabel(""), 1600);
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  return (
    <div className="agent-cursor-layer">
      <div
        className={`agent-cursor ${visible ? "visible" : ""}`}
        style={{ transform: `translate(${pos.x - HOT.x}px, ${pos.y - HOT.y}px)` }}
      >
        {ripple > 0 && <span key={ripple} className="agent-cursor-ripple" style={{ left: HOT.x, top: HOT.y }} />}
        <img src={cursorImg} width={SIZE} alt="" draggable={false} />
        {label && <span className="agent-cursor-label">{label}</span>}
      </div>
    </div>
  );
}
