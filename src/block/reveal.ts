import {getFrontend} from "siyuan";
import {localAssetPath} from "../model/local-path.ts";

interface ElectronShell {
    showItemInFolder?(path: string): void;
    openPath?(path: string): Promise<string>;
}

function electronShell(): ElectronShell | null {
    const requireModule = (globalThis as {require?: (id: string) => {shell?: ElectronShell}}).require;
    if (typeof requireModule !== "function") {
        return null;
    }
    try {
        const shell = requireModule("electron").shell;
        if (!shell) {
            return null;
        }
        return shell;
    } catch {
        return null;
    }
}

function desktopWorkspace(): {workspaceDir: string; shell: ElectronShell} | null {
    const frontend = getFrontend();
    if (frontend !== "desktop" && frontend !== "desktop-window") {
        return null;
    }
    const workspaceDir = window.siyuan?.config?.system?.workspaceDir;
    const shell = electronShell();
    if (!workspaceDir || !shell) {
        return null;
    }
    return {workspaceDir, shell};
}

export function canRevealInFolder(): boolean {
    return typeof desktopWorkspace()?.shell.showItemInFolder === "function";
}

export function revealInFolder(root: string, path: string): boolean {
    const desktop = desktopWorkspace();
    if (!desktop || typeof desktop.shell.showItemInFolder !== "function") {
        return false;
    }
    const localPath = localAssetPath(desktop.workspaceDir, root, path);
    if (!localPath) {
        return false;
    }
    desktop.shell.showItemInFolder(localPath);
    return true;
}

export async function openWithDefaultApp(root: string, path: string): Promise<boolean> {
    const desktop = desktopWorkspace();
    if (!desktop || typeof desktop.shell.openPath !== "function") {
        return false;
    }
    const localPath = localAssetPath(desktop.workspaceDir, root, path);
    if (!localPath) {
        return false;
    }
    try {
        const error = await desktop.shell.openPath(localPath);
        return error === "";
    } catch {
        return false;
    }
}
