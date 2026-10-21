import {fetchSyncPost, type APIFormData, type PutFileRequestInput} from "siyuan";
import {folderIdFromRoot, isInsideFolder, normalizeWorkspacePath, relativeFromRoot, type DirEntry} from "../model/path.ts";

interface KernelResponse {
    code: number;
    msg?: string;
    data?: unknown;
}

function failureMessage(response: KernelResponse, fallback: string): string {
    return response.msg || fallback;
}

export async function readFolder(root: string, path: string): Promise<DirEntry[]> {
    if (!isInsideFolder(root, path)) {
        throw new Error("blocked");
    }
    const response = await fetchSyncPost("/api/file/readDir", {path}) as KernelResponse;
    if (response.code !== 0 || !Array.isArray(response.data)) {
        throw new Error(failureMessage(response, "readDir failed"));
    }
    return response.data.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
            return [];
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.name !== "string" || typeof record.updated !== "number") {
            return [];
        }
        return [{
            name: record.name,
            isDir: record.isDir === true,
            isSymlink: record.isSymlink === true,
            updated: record.updated,
        }];
    });
}

export async function statInside(root: string, path: string): Promise<{created: number; size: number} | null> {
    const id = folderIdFromRoot(root);
    const relative = relativeFromRoot(root, path);
    if (!id || !relative) {
        return null;
    }
    const response = await fetchSyncPost("/api/asset/statAsset", {path: `assets/folder/${id}/${relative}`}) as KernelResponse;
    if (response.code !== 0 || !response.data || typeof response.data !== "object") {
        return null;
    }
    const record = response.data as Record<string, unknown>;
    if (typeof record.created !== "number" || typeof record.size !== "number") {
        return null;
    }
    return {created: record.created, size: record.size};
}

export async function putInside(root: string, path: string, file?: Blob): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized || !isInsideFolder(root, normalized)) {
        throw new Error("blocked");
    }
    const data = new FormData();
    data.append("path", file ? normalized : `${normalized}/`);
    data.append("isDir", file ? "false" : "true");
    if (file) {
        data.append("file", file, normalized.split("/").pop() || "file");
    }
    const response = await fetchSyncPost("/api/file/putFile", data as APIFormData<PutFileRequestInput>) as KernelResponse;
    if (response.code !== 0) {
        throw new Error(failureMessage(response, "putFile failed"));
    }
}

export async function removeInside(root: string, path: string): Promise<void> {
    const rootPath = normalizeWorkspacePath(root);
    const target = normalizeWorkspacePath(path);
    if (!rootPath || !target || target === rootPath || !isInsideFolder(rootPath, target)) {
        throw new Error("blocked");
    }
    const response = await fetchSyncPost("/api/file/removeFile", {path: target}) as KernelResponse;
    if (response.code !== 0) {
        throw new Error(failureMessage(response, "removeFile failed"));
    }
}

export async function renameInside(root: string, path: string, newPath: string): Promise<void> {
    const rootPath = normalizeWorkspacePath(root);
    const source = normalizeWorkspacePath(path);
    const target = normalizeWorkspacePath(newPath);
    if (!rootPath || !source || !target || source === rootPath || target === rootPath) {
        throw new Error("blocked");
    }
    if (!isInsideFolder(rootPath, source) || !isInsideFolder(rootPath, target)) {
        throw new Error("blocked");
    }
    const response = await fetchSyncPost("/api/file/renameFile", {path: source, newPath: target}) as KernelResponse;
    if (response.code !== 0) {
        throw new Error(failureMessage(response, "renameFile failed"));
    }
}

export async function readBoundedFile(options: {
    root: string;
    path: string;
    maxBytes: number;
    keepPartial: boolean;
    appId: string;
    signal?: AbortSignal;
}): Promise<{bytes: Uint8Array; truncated: boolean}> {
    if (!isInsideFolder(options.root, options.path)) {
        throw new Error("blocked");
    }
    const headers = new Headers({"Content-Type": "application/json"});
    if (options.appId) {
        headers.set("X-SiYuan-App-ID", options.appId);
    }
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        headers,
        body: JSON.stringify({path: options.path}),
        signal: options.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202 || contentType.includes("application/json") || !response.ok) {
        let message = "getFile failed";
        if (contentType.includes("application/json")) {
            try {
                const body = await response.json() as {msg?: unknown};
                if (typeof body.msg === "string" && body.msg) {
                    message = body.msg;
                }
            } catch {
                message = "getFile failed";
            }
        }
        throw new Error(message);
    }
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error("getFile failed");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) {
            break;
        }
        if (!value || value.byteLength === 0) {
            continue;
        }
        if (total + value.byteLength > options.maxBytes) {
            if (!options.keepPartial) {
                await reader.cancel();
                return {bytes: new Uint8Array(), truncated: true};
            }
            const remain = options.maxBytes - total;
            if (remain > 0) {
                chunks.push(value.subarray(0, remain));
                total += remain;
            }
            await reader.cancel();
            return {bytes: concatBytes(chunks, total), truncated: true};
        }
        chunks.push(value);
        total += value.byteLength;
    }
    return {bytes: concatBytes(chunks, total), truncated: false};
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
