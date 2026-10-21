import {folderIdFromRoot, relativeFromRoot} from "./path.ts";

export function localAssetPath(workspaceDir: string, root: string, path: string): string | null {
    if (!workspaceDir.trim() || !folderIdFromRoot(root)) {
        return null;
    }
    const relative = relativeFromRoot(root, path);
    const id = folderIdFromRoot(root);
    if (relative === null || !id) {
        return null;
    }
    const separator = workspaceDir.includes("\\") ? "\\" : "/";
    const base = workspaceDir.replace(/[\\/]+$/, "");
    const tail = ["data", "assets", "folder", id, ...relative.split("/").filter(Boolean)];
    return [base, ...tail].join(separator);
}
