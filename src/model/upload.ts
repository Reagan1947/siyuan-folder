import {normalizeRelative} from "./path.ts";

export interface UploadItem {
    relative: string;
    isDir: boolean;
    file?: Blob;
}

function compareUpload(left: UploadItem, right: UploadItem): number {
    if (left.isDir !== right.isDir) {
        return left.isDir ? -1 : 1;
    }
    const depth = left.relative.split("/").length - right.relative.split("/").length;
    if (depth !== 0) {
        return depth;
    }
    return left.relative.localeCompare(right.relative);
}

export function prepareUploadItems(items: readonly UploadItem[]): {items: UploadItem[]; rejected: boolean} {
    const directories = new Map<string, UploadItem>();
    const files: UploadItem[] = [];
    let rejected = false;
    const addDirectory = (relative: string) => {
        if (!directories.has(relative)) {
            directories.set(relative, {relative, isDir: true});
        }
        const parts = relative.split("/");
        for (let index = 1; index < parts.length; index += 1) {
            const parent = parts.slice(0, index).join("/");
            if (!directories.has(parent)) {
                directories.set(parent, {relative: parent, isDir: true});
            }
        }
    };
    for (const item of items) {
        const relative = normalizeRelative(item.relative);
        if (!relative) {
            rejected = true;
            continue;
        }
        if (item.isDir) {
            addDirectory(relative);
            continue;
        }
        const parts = relative.split("/");
        if (parts.length > 1) {
            addDirectory(parts.slice(0, -1).join("/"));
        }
        files.push({...item, relative});
    }
    return {items: [...directories.values(), ...files].sort(compareUpload), rejected};
}
