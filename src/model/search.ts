import {childPath, type DirEntry, relativeFromRoot} from "./path.ts";
import {visibleEntries} from "./entries.ts";

export const SEARCH_MAX_DEPTH = 6;
export const SEARCH_MAX_HITS = 200;

export interface SearchHit {
    path: string;
    relative: string;
    name: string;
    isDir: boolean;
    isSymlink: boolean;
    updated: number;
}

export async function searchFolderNames(
    root: string,
    query: string,
    read: (path: string) => Promise<readonly DirEntry[]>,
): Promise<{hits: SearchHit[]; limited: boolean}> {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return {hits: [], limited: false};
    }
    const hits: SearchHit[] = [];
    let hitLimit = false;
    let depthLimit = false;

    const walk = async (path: string, depth: number): Promise<void> => {
        if (hitLimit) {
            return;
        }
        if (depth > SEARCH_MAX_DEPTH) {
            depthLimit = true;
            return;
        }
        const entries = visibleEntries(await read(path));
        for (const entry of entries) {
            if (hitLimit) {
                return;
            }
            const child = childPath(root, path, entry.name);
            const relative = child ? relativeFromRoot(root, child) : null;
            if (!child || !relative) {
                continue;
            }
            if (entry.name.toLowerCase().includes(needle)) {
                hits.push({
                    path: child,
                    relative,
                    name: entry.name,
                    isDir: entry.isDir,
                    isSymlink: entry.isSymlink,
                    updated: entry.updated,
                });
                if (hits.length >= SEARCH_MAX_HITS) {
                    hitLimit = true;
                    return;
                }
            }
            if (entry.isDir && !entry.isSymlink) {
                if (depth + 1 > SEARCH_MAX_DEPTH) {
                    depthLimit = true;
                    continue;
                }
                await walk(child, depth + 1);
            }
        }
    };

    await walk(root, 0);
    return {hits, limited: hitLimit || depthLimit};
}
