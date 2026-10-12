// Plays a short scripted scene (typing a question, opening the pricing window...) so the
// gallery can show those states without anyone clicking. Loaded only by app.html.
import { emit } from "./mocks/event";
import { demo } from "./mocks/params";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setNative(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function ask(text: string) {
  await sleep(1200);
  const ta = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='Ask Clickr']");
  if (!ta) return;
  setNative(ta, text);
  await sleep(400);
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

void (async () => {
  if (demo === "chat" || demo === "limit") await ask("What stands out in this spreadsheet?");
  if (demo === "pricing") {
    await sleep(1200);
    await emit("open-pricing-modal", null);
  }
  if (demo === "agentbar" || demo === "agentask" || demo === "cursor") await sleep(900);
  if (demo === "cursor") {
    await emit("agent-cursor", { kind: "move", x: 120, y: 90, label: "" });
    await sleep(900);
    await emit("agent-cursor", { kind: "move", x: 330, y: 170, label: "" });
    await sleep(900);
    await emit("agent-cursor", { kind: "click", x: 330, y: 170, label: "" });
    await emit("agent-cursor", { kind: "label", x: 0, y: 0, label: "Click “Export”" });
  }
  if (demo === "agentbar") await emit("agent-status", { text: "Clicking “Export” in Numbers…" });
  if (demo === "agentask") await emit("agent-approval", { text: "Send the email to jordan@example.com" });
})();
