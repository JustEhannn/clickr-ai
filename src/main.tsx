import "./main.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SettingsApp from "./SettingsApp";
import CursorApp from "./CursorApp";
import AgentBar from "./AgentBar";
import BugReportApp from "./BugReportApp";

// Tauri throws "undefined is not an object (evaluating 'listeners[eventId].handlerId')" when an
// event listener is removed twice, which happens routinely as windows close. It is harmless,
// so make removal a no-op instead of an uncaught error (which would look like a crash).
{
  const internals = (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener?: (...a: unknown[]) => void } })
    .__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (internals?.unregisterListener) {
    const original = internals.unregisterListener.bind(internals);
    internals.unregisterListener = (...args: unknown[]) => {
      try {
        original(...args);
      } catch {
        /* already removed */
      }
    };
  }
}

const windowParam = new URLSearchParams(window.location.search).get("window");

function Root() {
  if (windowParam === "settings") return <SettingsApp />;
  if (windowParam === "cursor") return <CursorApp />;
  if (windowParam === "agentbar") return <AgentBar />;
  if (windowParam === "bug") return <BugReportApp />;
  return <App />;
}

ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);