import { useState } from "react";

type Message = { role: "user" | "assistant"; text: string };

export default function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  function handleSend() {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, { role: "user", text: input }]);
    setInput("");
    // Phase 2 will wire this up to an actual AI response
  }

  return (
    <div className="w-screen h-screen rounded-2xl bg-neutral-900/90 backdrop-blur-xl border border-neutral-700 flex flex-col overflow-hidden text-neutral-100">
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {messages.length === 0 && (
          <p className="text-neutral-500 text-sm">
            Ask Clickr anything about your screen.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-sm px-3 py-2 rounded-lg max-w-[80%] ${
              m.role === "user" ? "bg-blue-600 ml-auto" : "bg-neutral-800"
            }`}
          >
            {m.text}
          </div>
        ))}
      </div>
      <div className="p-3 border-t border-neutral-800">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Ask Clickr..."
          className="w-full bg-neutral-800 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
          autoFocus
        />
      </div>
    </div>
  );
}