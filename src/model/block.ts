import {folderIdFromRoot, rootPathForId} from "./path.ts";

export const FOLDER_VIEWS = ["title", "card"] as const;
export type FolderView = typeof FOLDER_VIEWS[number];
export const FOLDER_BLOCK_TYPE = "folder";

export interface FolderDocument {
    root: string;
    href: string;
    view: FolderView;
    /** 面包屑根上显示的名称。空字符串表示还没设置，界面用「根目录」。 */
    name: string;
}

const ROOT_NAME_LIMIT = 200;

/** 根目录显示名。空输入表示恢复默认；过长会截断，换行或围栏行则拒绝。 */
export function sanitizeRootName(value: string): string {
    const name = value.trim().slice(0, ROOT_NAME_LIMIT);
    if (!name || name === ";;;" || /[\0\r\n]/.test(name)) {
        return "";
    }
    return name;
}

const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const HREF = /^assets\/folder\/(\d{14}-[a-z0-9]{7})\/$/;

export function parseView(value: string | undefined): FolderView {
    if (value === "card" || value === "title") {
        return value;
    }
    return "title";
}

export function parseFolderContent(content: string): FolderDocument | null {
    const lines = content
        .replaceAll("\u200b", "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const link = lines[0] ? LINK.exec(lines[0]) : null;
    if (!link) {
        return null;
    }
    const href = link[2];
    const id = HREF.exec(href)?.[1];
    const root = id ? rootPathForId(id) : null;
    if (!root || folderIdFromRoot(root) !== id) {
        return null;
    }
    return {root, href, view: parseView(lines[1]), name: sanitizeRootName(lines[2] ?? "")};
}

export function serializeFolderContent(document: FolderDocument): string {
    const body = `[folder](${document.href})\n${document.view}`;
    const name = sanitizeRootName(document.name);
    return name ? `${body}\n${name}` : body;
}

export function fenceInfo(pluginName: string, blockType: string): string {
    return `${encodeURIComponent(pluginName)}/${encodeURIComponent(blockType)}`;
}

export function folderMarkdown(pluginName: string, id: string): string | null {
    if (!rootPathForId(id)) {
        return null;
    }
    const body = serializeFolderContent({
        root: `/data/assets/folder/${id}`,
        href: `assets/folder/${id}/`,
        view: "title",
        name: "",
    });
    return `;;;${fenceInfo(pluginName, FOLDER_BLOCK_TYPE)}\n${body}\n;;;`;
}
