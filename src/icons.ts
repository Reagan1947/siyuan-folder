/** 界面上用到的 Material Design Icons。路径在构建时从 `@iconify-json/mdi` 填入。 */
export const MDI_ICON = {
    folder: "folder-outline",
    file: "file-outline",
    folderUpload: "folder-upload-outline",
    folderPlus: "folder-plus-outline",
    viewList: "view-list",
    viewGrid: "view-grid-outline",
    rename: "pencil-outline",
    delete: "trash-can-outline",
    link: "link-variant",
    reveal: "folder-open-outline",
} as const;

export type MdiIconName = keyof typeof MDI_ICON;

interface MdiIconData {
    body: string;
    width?: number;
    height?: number;
}

interface MdiSet {
    width: number;
    height: number;
    icons: Record<string, MdiIconData>;
}

declare const __MDI__: MdiSet;

let icons: MdiSet | null = null;

function iconSet(): MdiSet {
    icons ??= __MDI__;
    return icons;
}

function iconData(name: MdiIconName): {body: string; width: number; height: number} {
    const id = MDI_ICON[name];
    const icon = iconSet().icons[id];
    if (!icon) {
        throw new Error(`Missing mdi icon ${id}`);
    }
    return {
        body: icon.body,
        width: icon.width ?? iconSet().width,
        height: icon.height ?? iconSet().height,
    };
}

export function mdiMarkup(name: MdiIconName, className?: string): string {
    const icon = iconData(name);
    const classAttr = className ? ` class="${className}"` : "";
    return `<svg${classAttr} width="1em" height="1em" viewBox="0 0 ${icon.width} ${icon.height}" aria-hidden="true">${icon.body}</svg>`;
}

export function mdiSvg(name: MdiIconName, className = "sy-folder-block__glyph"): SVGSVGElement {
    return svgElement(mdiMarkup(name, className), `Missing mdi icon ${MDI_ICON[name]}`);
}

/** Material Symbols `upload_file`，outline + sharp。 */
const UPLOAD_FILE_ICON = {
    viewBox: "0 -960 960 960",
    body: `<path d="M440-200h80v-167l64 64 56-57-160-160-160 160 57 56 63-63v167ZM160-80v-800h400l240 240v560H160Zm360-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z"/>`,
};

export function uploadFileSvg(className = "sy-folder-block__glyph"): SVGSVGElement {
    return svgElement(
        `<svg class="${className}" width="1em" height="1em" viewBox="${UPLOAD_FILE_ICON.viewBox}" aria-hidden="true">${UPLOAD_FILE_ICON.body}</svg>`,
        "Missing upload file icon",
    );
}

function svgElement(markup: string, missing: string): SVGSVGElement {
    const template = document.createElement("template");
    template.innerHTML = markup;
    const svg = template.content.firstElementChild;
    if (!(svg instanceof SVGSVGElement)) {
        throw new Error(missing);
    }
    return svg;
}
