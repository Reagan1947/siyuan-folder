export const IMAGE_BYTE_LIMIT = 20 * 1024 * 1024;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);

const IMAGE_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
    ico: "image/x-icon",
};

function extensionOf(name: string): string {
    const base = name.split("/").pop() ?? name;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) {
        return "";
    }
    return base.slice(dot + 1).toLowerCase();
}

export function isImageFile(name: string, isDir: boolean, isSymlink: boolean): boolean {
    if (isDir || isSymlink) {
        return false;
    }
    return IMAGE_EXT.has(extensionOf(name));
}

export function imageMime(name: string): string {
    return IMAGE_MIME[extensionOf(name)] ?? "application/octet-stream";
}
