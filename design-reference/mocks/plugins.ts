export const check = async () => null;
export type Update = unknown;
export const enable = async () => {};
export const disable = async () => {};
export const isEnabled = async () => false;
export const isPermissionGranted = async () => true;
export const requestPermission = async () => "granted";
export const sendNotification = () => {};
export const openUrl = async (u: string) => { window.open(u, "_blank"); };
