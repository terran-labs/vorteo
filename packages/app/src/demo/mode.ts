import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";

export function isDemoSession(): boolean {
  return false;
}
export function readDemoInstallation(): ExecutionInstallation | null {
  return null;
}
export function demoStorageName(name: string): string {
  return name;
}
export function enterDemo(): void {
  throw new Error("Open Vorteo in a browser to try the demo.");
}
export function exitDemo(): void {}
export function resetDemo(): void {}
