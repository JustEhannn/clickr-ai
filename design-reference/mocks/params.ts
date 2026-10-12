// Demo switches, read from the page address: ?tier=free|pro|pro_plus  &demo=chat|pricing|perm|tour|history|limit
const q = new URLSearchParams(window.location.search);
export const tier = q.get("tier") || "pro_plus";
export const demo = q.get("demo") || "";
