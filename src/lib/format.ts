export function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  const amount = Number(bytes);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  if (amount < 1024) return `${Math.round(amount)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = amount / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatPermissions(value: number | null) {
  return value == null ? "—" : `0${(value & 0o777).toString(8).padStart(3, "0")}`;
}

export function formatPermissionsSymbolic(value: number | null) {
  if (value == null) return "—";
  const mode = value & 0o777;
  const bits = ["r", "w", "x"] as const;
  return [6, 3, 0]
    .map((shift) => bits.map((bit, index) => ((mode >> shift) & (4 >> index) ? bit : "-")).join(""))
    .join("");
}

export function permissionsOctal(value: number | null) {
  return value == null ? "" : (value & 0o777).toString(8).padStart(3, "0");
}

export function parsePermissionsOctal(value: string): number | null {
  if (!/^[0-7]{3,4}$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value.trim(), 8);
  return Number.isFinite(parsed) && parsed <= 0o7777 ? parsed : null;
}

export function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
