/** Label for revealing a path in the OS file manager. */
export function fileManagerRevealLabel() {
  const platform = navigator.platform.toLowerCase();
  const agent = navigator.userAgent.toLowerCase();
  if (platform.includes("mac") || agent.includes("mac os")) return "Reveal in Finder";
  if (platform.includes("win") || agent.includes("windows")) return "Show in Explorer";
  return "Show in File Manager";
}
