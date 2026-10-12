const noop = async () => undefined;
const fakeWindow: any = new Proxy(
  { label: "main", onMoved: async () => () => {}, onCloseRequested: async () => () => {}, outerPosition: async () => ({ x: 0, y: 0 }), isVisible: async () => true },
  { get: (t: any, k: string) => (k in t ? t[k] : noop) },
);
export const getCurrentWindow = () => fakeWindow;
export const availableMonitors = async () => [];
export class PhysicalPosition { constructor(public x: number, public y: number) {} }
export class LogicalSize { constructor(public width: number, public height: number) {} }
export class LogicalPosition { constructor(public x: number, public y: number) {} }
