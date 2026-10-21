export function markdownLabel(name: string): string {
    return name.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function fileAssetHref(id: string, relative: string, isDir: boolean): string {
    const encoded = relative.split("/").filter(Boolean).map((segment) => encodeURIComponent(segment)).join("/");
    const suffix = encoded ? `${encoded}${isDir ? "/" : ""}` : "";
    return `assets/folder/${id}/${suffix}`;
}

export function assetMarkdown(name: string, href: string, image: boolean): string {
    const label = markdownLabel(name);
    if (image) {
        return `![${label}](${href})`;
    }
    return `[${label}](${href})`;
}
