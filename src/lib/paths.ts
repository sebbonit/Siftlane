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

export function pathBasename(path: string, remote = false) {
  const normalized = path.replace(/[\\/]+$/, "") || (remote ? "/" : path);
  if (normalized === "/" || normalized === "\\") return normalized;
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index < 0 ? normalized : normalized.slice(index + 1) || normalized;
}

export function normalizeBookmarkPath(path: string, remote: boolean) {
  const trimmed = path.trim();
  if (!trimmed) return remote ? "/" : trimmed;
  if (remote) {
    const segments = trimmed.split("/").filter((segment) => segment && segment !== ".");
    return `/${segments.join("/")}`;
  }
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return stripped || (trimmed.includes("\\") ? "\\" : "/");
}

/** Split a typed path into the directory to list and the incomplete name prefix. */
export function pathSuggestParts(path: string, remote: boolean) {
  const separator = remote ? "/" : path.includes("\\") ? "\\" : "/";
  const root = remote ? "/" : separator;
  if (!path) return { parent: root, prefix: "" };
  if (/[\\/]$/.test(path)) {
    const parent = path.replace(/[\\/]+$/, "") || root;
    return { parent, prefix: "" };
  }
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return { parent: root, prefix: path };
  if (index === 0) return { parent: root, prefix: path.slice(1) };
  return { parent: path.slice(0, index), prefix: path.slice(index + 1) };
}

