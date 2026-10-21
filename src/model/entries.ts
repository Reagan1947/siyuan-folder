import {type DirEntry} from "./path.ts";

export const ENTRY_LIMIT = 5000;

export type SortKey = "name" | "created" | "size";
export type SortDirection = "asc" | "desc";

export interface SortedEntry {
    name: string;
    isDir: boolean;
    created: number | null;
    size: number | null;
}

export function compareEntries(left: DirEntry, right: DirEntry): number {
    if (left.isDir !== right.isDir) {
        return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
}

/** 文件夹保持在文件前面。创建时间和大小未知的项排在同组末尾。 */
export function compareSorted(left: SortedEntry, right: SortedEntry, key: SortKey, direction: SortDirection): number {
    if (left.isDir !== right.isDir) {
        return left.isDir ? -1 : 1;
    }
    if (key === "name") {
        const byName = left.name.localeCompare(right.name);
        return direction === "asc" ? byName : -byName;
    }
    const leftValue = sortMetric(left, key);
    const rightValue = sortMetric(right, key);
    if (leftValue === null || rightValue === null) {
        if (leftValue === null && rightValue === null) {
            return left.name.localeCompare(right.name);
        }
        return leftValue === null ? 1 : -1;
    }
    if (leftValue !== rightValue) {
        const delta = leftValue < rightValue ? -1 : 1;
        return direction === "asc" ? delta : -delta;
    }
    return left.name.localeCompare(right.name);
}

function sortMetric(entry: SortedEntry, key: SortKey): number | null {
    if (key === "created") {
        return entry.created;
    }
    return entry.isDir ? null : entry.size;
}

export function sortEntries<T extends SortedEntry>(entries: readonly T[], key: SortKey, direction: SortDirection): T[] {
    return [...entries].sort((left, right) => compareSorted(left, right, key, direction));
}

/** 先删更深的路径，避免先删掉父目录后子项删除失败。 */
export function deletionOrder<T extends {relative: string; path: string}>(rows: readonly T[]): T[] {
    return [...rows].sort((left, right) => {
        const depth = right.relative.split("/").length - left.relative.split("/").length;
        if (depth !== 0) {
            return depth;
        }
        return right.path.length - left.path.length;
    });
}

export function visibleEntries(entries: readonly DirEntry[]): DirEntry[] {
    const visible = entries.filter((entry) => {
        return Boolean(entry.name)
            && !entry.name.startsWith(".")
            && !entry.name.includes("/")
            && !entry.name.includes("\\")
            && entry.name !== "."
            && entry.name !== "..";
    });
    visible.sort(compareEntries);
    return visible;
}

export type ListingDelta =
    | {type: "unchanged"}
    | {type: "replaced"}
    | {type: "times"; names: string[]};

export function listingDelta(previous: readonly DirEntry[], next: readonly DirEntry[]): ListingDelta {
    if (previous.length !== next.length) {
        return {type: "replaced"};
    }
    const names: string[] = [];
    for (let index = 0; index < previous.length; index += 1) {
        const left = previous[index];
        const right = next[index];
        if (left.name !== right.name || left.isDir !== right.isDir || left.isSymlink !== right.isSymlink) {
            return {type: "replaced"};
        }
        if (left.updated !== right.updated) {
            names.push(right.name);
        }
    }
    return names.length === 0 ? {type: "unchanged"} : {type: "times", names};
}
