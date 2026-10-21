export interface DirEntry {
    name: string;
    isDir: boolean;
    isSymlink: boolean;
    updated: number;
}

const FOLDER_ID = /^\d{14}-[a-z0-9]{7}$/;

/** 收成工作空间绝对路径。含 `..`、空输入或 NUL 时返回 null。 */
export function normalizeWorkspacePath(input: string): string | null {
    if (!input || input.includes("\0")) {
        return null;
    }
    const slash = input.replace(/\\/g, "/").trim();
    if (!slash.startsWith("/")) {
        return null;
    }
    const parts: string[] = [];
    for (const part of slash.split("/")) {
        if (!part || part === ".") {
            continue;
        }
        if (part === "..") {
            return null;
        }
        parts.push(part);
    }
    return `/${parts.join("/")}`;
}

export function isFolderId(id: string): boolean {
    return FOLDER_ID.test(id);
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 思源块 ID：本地时间 14 位，加 7 位小写字母或数字。 */
export function createFolderId(now = new Date(), suffix = randomIdSuffix()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${stamp}-${suffix}`;
}

function randomIdSuffix(): string {
    const bytes = new Uint8Array(7);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

export function rootPathForId(id: string): string | null {
    if (!isFolderId(id)) {
        return null;
    }
    return `/data/assets/folder/${id}`;
}

export function folderIdFromRoot(path: string): string | null {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) {
        return null;
    }
    const match = /^\/data\/assets\/folder\/(\d{14}-[a-z0-9]{7})$/.exec(normalized);
    return match?.[1] ?? null;
}

/** 只接受这个块自己的资源目录，以及它下面的路径。 */
export function isInsideFolder(root: string, candidate: string): boolean {
    const rootPath = normalizeWorkspacePath(root);
    const path = normalizeWorkspacePath(candidate);
    if (!rootPath || !path || !folderIdFromRoot(rootPath)) {
        return false;
    }
    return path === rootPath || path.startsWith(`${rootPath}/`);
}

export function relativeFromRoot(root: string, path: string): string | null {
    const rootPath = normalizeWorkspacePath(root);
    const candidate = normalizeWorkspacePath(path);
    if (!rootPath || !candidate || !isInsideFolder(rootPath, candidate)) {
        return null;
    }
    if (candidate === rootPath) {
        return "";
    }
    return candidate.slice(rootPath.length + 1);
}

function safeSegments(relative: string): string[] | null {
    if (!relative || relative.includes("\0")) {
        return null;
    }
    const slash = relative.replace(/\\/g, "/").trim();
    if (!slash || slash.startsWith("/")) {
        return null;
    }
    const parts = slash.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
        return null;
    }
    return parts;
}

export function normalizeRelative(relative: string): string | null {
    const parts = safeSegments(relative);
    return parts ? parts.join("/") : null;
}

export function resolveInsideFolder(root: string, relative: string): string | null {
    const relativePath = normalizeRelative(relative);
    const rootPath = normalizeWorkspacePath(root);
    if (!relativePath || !rootPath || !folderIdFromRoot(rootPath)) {
        return null;
    }
    return `${rootPath}/${relativePath}`;
}

export function isCreatableName(name: string): boolean {
    return safeSegments(name.trim())?.length === 1;
}

export function childPath(root: string, parent: string, name: string): string | null {
    if (!isCreatableName(name)) {
        return null;
    }
    const parentRelative = relativeFromRoot(root, parent);
    if (parentRelative === null) {
        return null;
    }
    const relative = parentRelative ? `${parentRelative}/${name.trim()}` : name.trim();
    return resolveInsideFolder(root, relative);
}

export function renamedPath(root: string, path: string, nextName: string): string | null {
    const relative = relativeFromRoot(root, path);
    if (!relative || !isCreatableName(nextName)) {
        return null;
    }
    const slash = relative.lastIndexOf("/");
    const parent = slash === -1 ? "" : relative.slice(0, slash);
    const next = parent ? `${parent}/${nextName.trim()}` : nextName.trim();
    return resolveInsideFolder(root, next);
}

export function joinRelative(current: string, relative: string): string | null {
    const extra = normalizeRelative(relative);
    if (!extra) {
        return null;
    }
    if (!current) {
        return extra;
    }
    const base = normalizeRelative(current);
    if (!base) {
        return null;
    }
    return `${base}/${extra}`;
}
