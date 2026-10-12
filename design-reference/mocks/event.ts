// In-memory stand-in for Tauri's event bus.
type Handler = (e: { event: string; payload: any }) => void;
const handlers = new Map<string, Set<Handler>>();

export function listen<T = any>(event: string, cb: (e: { event: string; payload: T }) => void): Promise<() => void> {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(cb as Handler);
  return Promise.resolve(() => handlers.get(event)?.delete(cb as Handler));
}
export function emit(event: string, payload?: unknown): Promise<void> {
  handlers.get(event)?.forEach((h) => h({ event, payload }));
  return Promise.resolve();
}
export const once = listen;
