export function joinPath(base: string, name: string, remote: boolean) {
  const separator = remote ? "/" : base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${name}`;
}

export function parentPath(path: string, remote: boolean) {
  const normalized = path.replace(/[\\/]+$/, "");
  const separator = remote ? "/" : normalized.includes("\\") ? "\\" : "/";
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) return remote ? "/" : normalized.slice(0, Math.max(1, index + 1));
  return normalized.slice(0, index) || separator;
}
