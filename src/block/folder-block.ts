import {Menu, confirm, getActiveEditor, openInputDialog, showMessage} from "siyuan";
import {putInside, readBoundedFile, readFolder, removeInside, renameInside, statInside} from "../api/assets.ts";
import {canRevealInFolder, openWithDefaultApp, revealInFolder} from "./reveal.ts";
import {
    type FolderDocument,
    type FolderView,
    FOLDER_VIEWS,
    parseFolderContent,
    sanitizeRootName,
    serializeFolderContent,
} from "../model/block.ts";
import {compareSorted, deletionOrder, ENTRY_LIMIT, listingDelta, visibleEntries, type SortDirection, type SortKey, type SortedEntry} from "../model/entries.ts";
import {assetMarkdown, fileAssetHref} from "../model/link.ts";
import {
    childPath,
    folderIdFromRoot,
    isInsideFolder,
    joinRelative,
    relativeFromRoot,
    renamedPath,
    resolveInsideFolder,
    type DirEntry,
} from "../model/path.ts";
import {IMAGE_BYTE_LIMIT, imageMime, isImageFile} from "../model/image.ts";
import {searchFolderNames, type SearchHit} from "../model/search.ts";
import {prepareUploadItems, type UploadItem} from "../model/upload.ts";
import {mdiMarkup, mdiSvg, uploadFileSvg, type MdiIconName} from "../icons.ts";
import {DirectoryPoller} from "../refresh/directory-poller.ts";
import {pollIntervalMs} from "../settings.ts";

const rememberedRelative = new WeakMap<HTMLElement, string>();

interface FolderMount {
    element: HTMLElement;
    content: string;
    setContent: (content: string) => boolean;
    label: (key: string) => string;
    appId: string;
}

interface RowEntry {
    name: string;
    path: string;
    relative: string;
    isDir: boolean;
    isSymlink: boolean;
    updated: number;
}

interface PickedFile {
    kind: "file";
    getFile: () => Promise<File>;
}

interface PickedDirectory {
    kind: "directory";
    name: string;
    entries: () => AsyncIterable<[string, PickedFile | PickedDirectory]>;
}

export function mountFolderBlock(options: FolderMount): () => void {
    const documentState = parseFolderContent(options.content);
    if (!documentState) {
        const error = document.createElement("div");
        error.className = "sy-folder-block sy-folder-block__error";
        error.textContent = options.label("invalidBlock");
        const raw = document.createElement("pre");
        raw.className = "sy-folder-block__raw";
        raw.textContent = options.content;
        options.element.replaceChildren(error, raw);
        return () => undefined;
    }
    const block = new FolderBlock(options, documentState);
    block.start();
    return () => block.destroy();
}

class FolderBlock {
    private readonly doc: FolderDocument;
    private relative = "";
    private entries: DirEntry[] = [];
    private truncated = false;
    private loaded = false;
    private listError = "";
    private searchError = "";
    private searchLimited = false;
    private query = "";
    private hits: SearchHit[] | null = null;
    private writing = "";
    private busy = false;
    private listing = false;
    private listQueued = false;
    private destroyed = false;
    private intersecting = false;
    private searchGeneration = 0;
    private mediaGeneration = 0;
    private searchTimer = 0;
    private poller: DirectoryPoller | null = null;
    private observer: IntersectionObserver | null = null;
    private mediaAbort = new AbortController();
    private revealable = false;
    private sortKey: SortKey = "name";
    private sortDirection: SortDirection = "asc";
    private readonly selected = new Set<string>();
    private deleting = false;

    private root!: HTMLDivElement;
    private breadcrumb!: HTMLElement;
    private viewGroup!: HTMLElement;
    private rowMenu: Menu | null = null;
    private menuGeneration = 0;
    private menuEntry: HTMLElement | null = null;
    private menuPath: string | null = null;
    private statGeneration = 0;
    private readonly statCache = new Map<string, {updated: number; created: number; size: number}>();
    private status!: HTMLElement;
    private body!: HTMLElement;
    private searchInput!: HTMLInputElement;
    private deleteSelectedButton!: HTMLButtonElement;
    private fileInput!: HTMLInputElement;
    private directoryInput!: HTMLInputElement;

    constructor(
        private readonly options: FolderMount,
        documentState: FolderDocument,
    ) {
        this.doc = documentState;
    }

    start(): void {
        const saved = rememberedRelative.get(this.options.element) ?? "";
        this.relative = saved && resolveInsideFolder(this.doc.root, saved) ? saved : "";
        this.revealable = canRevealInFolder();
        this.renderShell();
        if (typeof IntersectionObserver === "function") {
            this.observer = new IntersectionObserver((records) => {
                this.intersecting = records.some((record) => record.isIntersecting);
                if (this.visible()) {
                    void this.refreshListing();
                }
            });
            this.observer.observe(this.options.element);
        } else {
            this.intersecting = true;
            void this.refreshListing();
        }
        this.poller = new DirectoryPoller(
            () => this.refreshListing(),
            () => pollIntervalMs(),
            () => this.visible(),
        );
        this.poller.start();
        document.addEventListener("visibilitychange", this.onVisibility);
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.statGeneration += 1;
        this.rowMenu?.close();
        this.poller?.stop();
        this.observer?.disconnect();
        document.removeEventListener("visibilitychange", this.onVisibility);
        window.clearTimeout(this.searchTimer);
        this.mediaAbort.abort();
        this.revokeBodyUrls();
    }

    private readonly onVisibility = (): void => {
        if (this.visible()) {
            void this.refreshListing();
        }
    };

    private visible(): boolean {
        return !this.destroyed
            && this.intersecting
            && this.options.element.isConnected
            && document.visibilityState === "visible";
    }

    private currentPath(): string {
        if (!this.relative) {
            return this.doc.root;
        }
        return resolveInsideFolder(this.doc.root, this.relative) ?? this.doc.root;
    }

    private async refreshListing(): Promise<void> {
        if (this.destroyed || !this.visible()) {
            return;
        }
        if (this.listing) {
            this.listQueued = true;
            return;
        }
        this.listing = true;
        try {
            do {
                this.listQueued = false;
                await this.readCurrent();
            } while (this.listQueued && this.visible() && !this.destroyed);
        } finally {
            this.listing = false;
        }
    }

    private async readCurrent(): Promise<void> {
        if (this.deleting) {
            return;
        }
        const path = this.currentPath();
        if (!isInsideFolder(this.doc.root, path)) {
            this.listError = this.options.label("readFailed");
            this.renderStatus();
            return;
        }
        try {
            const entries = visibleEntries(await readFolder(this.doc.root, path));
            if (this.destroyed || this.deleting) {
                return;
            }
            if (path !== this.currentPath()) {
                this.listQueued = true;
                return;
            }
            const truncated = entries.length > ENTRY_LIMIT;
            const shown = entries.slice(0, ENTRY_LIMIT);
            const delta = listingDelta(this.entries, shown);
            const errorChanged = this.listError !== "" || this.truncated !== truncated;
            this.entries = shown;
            this.truncated = truncated;
            this.listError = "";
            this.loaded = true;
            if (this.query.trim()) {
                this.renderStatus();
                return;
            }
            if (delta.type === "times" && !errorChanged) {
                this.patchTimes(shown);
                this.renderStatus();
                return;
            }
            if (delta.type === "unchanged" && !errorChanged && this.body.childElementCount > 0) {
                this.renderStatus();
                return;
            }
            this.renderBody();
            this.renderStatus();
        } catch {
            if (this.destroyed) {
                return;
            }
            if (path !== this.currentPath()) {
                this.listQueued = true;
                return;
            }
            this.loaded = true;
            this.listError = this.options.label("readFailed");
            this.renderStatus();
        }
    }

    private renderShell(): void {
        const root = document.createElement("div");
        root.className = "sy-folder-block";
        root.dataset.view = this.doc.view;
        const toolbar = document.createElement("div");
        toolbar.className = "sy-folder-block__toolbar";
        this.breadcrumb = document.createElement("nav");
        this.breadcrumb.className = "sy-folder-block__crumbs";
        this.viewGroup = document.createElement("div");
        this.viewGroup.className = "sy-folder-block__views";
        this.viewGroup.setAttribute("role", "group");
        for (const view of FOLDER_VIEWS) {
            const button = iconButton(this.options.label(viewLabelKey(view)), "set-view", viewIcon(view));
            button.dataset.view = view;
            this.viewGroup.append(button);
        }
        const end = document.createElement("div");
        end.className = "sy-folder-block__toolbar-end";
        this.deleteSelectedButton = document.createElement("button");
        this.deleteSelectedButton.type = "button";
        this.deleteSelectedButton.className = "b3-button b3-button--text sy-folder-block__delete";
        this.deleteSelectedButton.dataset.action = "delete-selected";
        const deleteLabel = document.createElement("span");
        deleteLabel.dataset.role = "label";
        this.deleteSelectedButton.append(mdiSvg("delete"), deleteLabel);
        end.append(
            this.deleteSelectedButton,
            this.viewGroup,
            toolbarDivider(),
            iconButton(this.options.label("uploadFile"), "upload-file", uploadFileSvg()),
            iconButton(this.options.label("uploadFolder"), "upload-folder", mdiSvg("folderUpload")),
            toolbarDivider(),
            iconButton(this.options.label("newFolder"), "new-folder", mdiSvg("folderPlus")),
        );
        this.searchInput = document.createElement("input");
        this.searchInput.type = "search";
        this.searchInput.className = "b3-text-field sy-folder-block__search";
        this.searchInput.placeholder = this.options.label("search");
        this.searchInput.setAttribute("aria-label", this.options.label("search"));
        this.searchInput.addEventListener("input", this.onSearchInput);
        this.searchInput.addEventListener("keydown", stopKey);
        this.searchInput.addEventListener("keyup", stopKey);
        end.append(this.searchInput);
        toolbar.append(this.breadcrumb, end);
        this.status = document.createElement("div");
        this.status.className = "sy-folder-block__status";
        this.body = document.createElement("div");
        this.body.className = "sy-folder-block__body";
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.multiple = true;
        this.fileInput.hidden = true;
        this.fileInput.addEventListener("change", this.onFiles);
        this.directoryInput = document.createElement("input");
        this.directoryInput.type = "file";
        this.directoryInput.multiple = true;
        this.directoryInput.hidden = true;
        (this.directoryInput as HTMLInputElement & {webkitdirectory: boolean}).webkitdirectory = true;
        this.directoryInput.addEventListener("change", this.onDirectory);
        root.append(toolbar, this.status, this.body, this.fileInput, this.directoryInput);
        root.addEventListener("click", this.onClick);
        root.addEventListener("contextmenu", this.onContextMenu);
        this.root = root;
        this.options.element.replaceChildren(root);
        this.renderBreadcrumb();
        this.renderViewButtons();
        this.syncDeleteButton();
        this.renderStatus();
    }

    private renderBreadcrumb(): void {
        this.breadcrumb.replaceChildren();
        const root = actionButton(this.rootLabel(), "navigate", "sy-folder-block__crumb");
        root.dataset.relative = "";
        root.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.openRowMenu([{
                iconHTML: menuIcon("rename"),
                label: this.options.label("rename"),
                click: () => this.askRenameRoot(),
            }], event.clientX, event.clientY, root);
        });
        this.breadcrumb.append(root);
        if (!this.relative) {
            return;
        }
        let prefix = "";
        for (const part of this.relative.split("/")) {
            prefix = prefix ? `${prefix}/${part}` : part;
            this.breadcrumb.append(document.createTextNode(" / "));
            const item = actionButton(part, "navigate", "sy-folder-block__crumb");
            item.dataset.relative = prefix;
            this.breadcrumb.append(item);
        }
    }

    private renderViewButtons(): void {
        this.root.dataset.view = this.doc.view;
        for (const button of this.viewGroup.querySelectorAll<HTMLButtonElement>("[data-action='set-view']")) {
            const current = button.dataset.view === this.doc.view;
            button.classList.toggle("sy-folder-block__icon-button--current", current);
            button.setAttribute("aria-pressed", current ? "true" : "false");
        }
    }

    private renderStatus(): void {
        const messages: string[] = [];
        if (this.writing) {
            messages.push(this.writing);
        }
        if (this.listError) {
            messages.push(this.listError);
        }
        if (this.searchError) {
            messages.push(this.searchError);
        }
        if (!this.query.trim() && this.truncated) {
            messages.push(this.options.label("truncated"));
        }
        if (this.query.trim() && this.searchLimited) {
            messages.push(this.options.label("searchLimited"));
        }
        if (this.loaded && !this.query.trim() && !this.listError && !this.writing && this.entries.length === 0) {
            messages.push(this.options.label("empty"));
        }
        this.status.textContent = messages.join(" · ");
        this.status.hidden = messages.length === 0;
    }

    private renderBody(): void {
        this.mediaAbort.abort();
        this.mediaAbort = new AbortController();
        this.revokeBodyUrls();
        this.retainSelection(this.displayedRows());
        this.body.replaceChildren();
        if (this.query.trim()) {
            this.renderHits();
        } else if (this.doc.view === "card") {
            this.renderCards();
        } else {
            this.renderTitles();
        }
        this.syncDeleteButton();
        this.fillMedia();
        if (this.query.trim() || this.doc.view === "title" || this.sortKey !== "name") {
            this.fillStats();
        }
        this.restoreMenuEntry();
    }

    private renderTitles(): void {
        const list = document.createElement("div");
        list.className = "sy-folder-block__list";
        const rows = this.sortedRows(this.folderRows());
        if (rows.length > 0) {
            list.append(this.listHead(), ...rows.map((row) => this.titleRow(row)));
        }
        this.body.append(list);
    }

    private renderCards(): void {
        const rows = this.sortedRows(this.folderRows());
        if (rows.length > 0) {
            this.body.append(this.sortBar());
        }
        const list = document.createElement("div");
        list.className = "sy-folder-block__cards";
        for (const row of rows) {
            list.append(this.cardRow(row));
        }
        this.body.append(list);
    }

    private renderHits(): void {
        const list = document.createElement("div");
        list.className = "sy-folder-block__list";
        const rows = this.sortedRows(this.hitRows());
        if (rows.length > 0) {
            list.append(this.listHead(), ...rows.map((row) => this.titleRow(row)));
        }
        this.body.append(list);
    }

    private listHead(): HTMLElement {
        const head = document.createElement("div");
        head.className = "sy-folder-block__columns sy-folder-block__head";
        const check = document.createElement("span");
        check.className = "sy-folder-block__check";
        check.append(this.selectAllBox());
        head.append(check, ...this.sortButtons());
        return head;
    }

    private sortBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "sy-folder-block__sortbar";
        const label = document.createElement("span");
        label.className = "sy-folder-block__sort-label";
        label.textContent = `${this.options.label("sortBy")}:`;
        bar.append(label, ...this.sortButtons());
        return bar;
    }

    private sortButtons(): HTMLButtonElement[] {
        return (["name", "created", "size"] as const).map((key) => this.sortButton(key));
    }

    private sortButton(key: SortKey): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `sy-folder-block__sort sy-folder-block__sort--${key}`;
        button.dataset.action = "sort";
        button.dataset.sort = key;
        this.paintSortButton(button);
        return button;
    }

    private paintSortButton(button: HTMLButtonElement): void {
        const key = parseSortKey(button.dataset.sort);
        if (!key) {
            return;
        }
        const active = key === this.sortKey;
        button.classList.toggle("sy-folder-block__sort--current", active);
        const arrow = active ? (this.sortDirection === "asc" ? " ↑" : " ↓") : "";
        button.textContent = `${this.options.label(SORT_LABEL[key])}${arrow}`;
        if (active) {
            button.setAttribute("aria-sort", this.sortDirection === "asc" ? "ascending" : "descending");
        } else {
            button.removeAttribute("aria-sort");
        }
    }

    private paintSortHeaders(): void {
        for (const button of this.body.querySelectorAll<HTMLButtonElement>("[data-action='sort']")) {
            this.paintSortButton(button);
        }
    }

    private titleRow(row: RowEntry): HTMLElement {
        const item = document.createElement("div");
        item.className = "sy-folder-block__row sy-folder-block__columns";
        item.dataset.action = "open";
        markEntry(item, row);
        const open = this.openButton(row);
        open.className = "sy-folder-block__open";
        open.append(mdiSvg(row.isDir ? "folder" : "file"), nameSpan(row.name));
        if (row.isSymlink) {
            const symlink = document.createElement("span");
            symlink.className = "sy-folder-block__meta";
            symlink.textContent = this.options.label("symlink");
            open.append(symlink);
        }
        const created = document.createElement("span");
        created.className = "sy-folder-block__created";
        created.dataset.role = "created";
        const size = document.createElement("span");
        size.className = "sy-folder-block__size";
        size.dataset.role = "size";
        size.textContent = row.isDir ? "—" : "";
        item.append(this.entryCheck(row), open, created, size);
        return item;
    }

    private cardRow(row: RowEntry): HTMLElement {
        const item = document.createElement("div");
        item.className = "sy-folder-block__card";
        markEntry(item, row);
        const open = this.openButton(row);
        open.className = "sy-folder-block__card-open";
        if (isImageFile(row.name, row.isDir, row.isSymlink)) {
            open.append(mediaSlot(row));
        } else {
            open.append(mdiSvg(row.isDir ? "folder" : "file"));
        }
        open.append(nameSpan(row.name), metaSpan(row, this.options.label("symlink")));
        item.append(open);
        return item;
    }

    private entryCheck(row: RowEntry): HTMLLabelElement {
        const label = document.createElement("label");
        label.className = "sy-folder-block__check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "sy-folder-block__check-input";
        input.dataset.action = "select";
        input.disabled = row.isSymlink;
        input.checked = !row.isSymlink && this.selected.has(row.path);
        input.setAttribute("aria-label", fill(this.options.label("selectItem"), {name: row.name}));
        label.append(input);
        return label;
    }

    private selectAllBox(): HTMLInputElement {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "sy-folder-block__check-input";
        input.dataset.action = "select-all";
        input.setAttribute("aria-label", this.options.label("selectAll"));
        const rows = this.selectableRows();
        const selected = rows.filter((row) => this.selected.has(row.path)).length;
        input.checked = rows.length > 0 && selected === rows.length;
        input.indeterminate = selected > 0 && selected < rows.length;
        input.disabled = rows.length === 0;
        return input;
    }

    private openButton(row: RowEntry): HTMLButtonElement {
        const open = actionButton("", "open", "");
        bindRow(open, row);
        open.setAttribute("aria-label", row.name);
        return open;
    }

    private readonly onContextMenu = (event: MouseEvent): void => {
        const target = (event.target as Element | null)?.closest<HTMLElement>("[data-entry]");
        if (!target || !this.root.contains(target)) {
            return;
        }
        const row = this.rowFromElement(target);
        if (!row) {
            return;
        }
        const items = this.rowMenuItems(row);
        if (items.length === 0) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.openRowMenu(items, event.clientX, event.clientY, this.menuSurface(target));
    };

    private rowMenuItems(row: RowEntry): {iconHTML: string; label: string; click: () => void}[] {
        const items: {iconHTML: string; label: string; click: () => void}[] = [];
        if (!row.isSymlink) {
            items.push(
                {iconHTML: menuIcon("rename"), label: this.options.label("rename"), click: () => this.askRename(row)},
                {iconHTML: menuIcon("delete"), label: this.options.label("delete"), click: () => this.askDelete(row)},
            );
            if (!row.isDir) {
                items.push({iconHTML: menuIcon("link"), label: this.options.label("insertLink"), click: () => this.insertLink(row)});
            }
        }
        if (this.revealable) {
            items.push({
                iconHTML: menuIcon("reveal"),
                label: this.options.label("reveal"),
                click: () => {
                    if (!revealInFolder(this.doc.root, row.path)) {
                        showMessage(this.options.label("readFailed"), 4000, "error");
                    }
                },
            });
        }
        return items;
    }

    private openRowMenu(
        items: {iconHTML: string; label: string; click: () => void}[],
        x: number,
        y: number,
        anchor?: HTMLElement,
    ): void {
        const generation = ++this.menuGeneration;
        this.rowMenu?.close();
        const menu = new Menu("sy-folder-row", () => {
            if (this.menuGeneration !== generation) {
                return;
            }
            this.rowMenu = null;
            this.clearMenuEntry();
        });
        this.rowMenu = menu;
        this.pinMenuEntry(anchor ?? null);
        for (const item of items) {
            menu.addItem(item);
        }
        menu.open({x, y});
    }

    private menuSurface(entry: HTMLElement): HTMLElement {
        if (entry.classList.contains("sy-folder-block__row")) {
            return entry;
        }
        return entry.querySelector<HTMLElement>(".sy-folder-block__card-open") ?? entry;
    }

    private pinMenuEntry(element: HTMLElement | null): void {
        if (this.menuEntry && this.menuEntry !== element) {
            this.menuEntry.classList.remove("sy-folder-block--menu");
        }
        this.menuEntry = element;
        this.menuPath = element?.dataset.path ?? null;
        element?.classList.add("sy-folder-block--menu");
    }

    private clearMenuEntry(): void {
        this.menuEntry?.classList.remove("sy-folder-block--menu");
        this.menuEntry = null;
        this.menuPath = null;
    }

    private restoreMenuEntry(): void {
        if (!this.menuPath) {
            return;
        }
        const next = [...this.body.querySelectorAll<HTMLElement>("[data-entry]")]
            .find((node) => node.dataset.path === this.menuPath);
        const target = next ? this.menuSurface(next) : null;
        if (!target) {
            if (this.menuEntry?.isConnected) {
                this.menuEntry.classList.add("sy-folder-block--menu");
            }
            return;
        }
        if (this.menuEntry !== target) {
            this.menuEntry?.classList.remove("sy-folder-block--menu");
            this.menuEntry = target;
        }
        target.classList.add("sy-folder-block--menu");
    }

    private rowFromEntry(entry: DirEntry): RowEntry | null {
        const path = childPath(this.doc.root, this.currentPath(), entry.name);
        const relative = path ? relativeFromRoot(this.doc.root, path) : null;
        if (!path || !relative) {
            return null;
        }
        return {
            name: entry.name,
            path,
            relative,
            isDir: entry.isDir,
            isSymlink: entry.isSymlink,
            updated: entry.updated,
        };
    }

    private rowFromElement(element: HTMLElement): RowEntry | null {
        const path = element.dataset.path;
        const name = element.dataset.name;
        const relative = path ? relativeFromRoot(this.doc.root, path) : null;
        if (!path || !name || relative === null || !isInsideFolder(this.doc.root, path)) {
            return null;
        }
        return {
            name,
            path,
            relative,
            isDir: element.dataset.dir === "1",
            isSymlink: element.dataset.symlink === "1",
            updated: Number(element.dataset.updated ?? "0"),
        };
    }

    private displayedRows(): RowEntry[] {
        return this.query.trim() ? this.hitRows() : this.folderRows();
    }

    private folderRows(): RowEntry[] {
        return this.entries.flatMap((entry) => {
            const row = this.rowFromEntry(entry);
            return row ? [row] : [];
        });
    }

    private hitRows(): RowEntry[] {
        return (this.hits ?? []).map((hit) => ({
            name: hit.name,
            path: hit.path,
            relative: hit.relative,
            isDir: hit.isDir,
            isSymlink: hit.isSymlink,
            updated: hit.updated,
        }));
    }

    private selectableRows(): RowEntry[] {
        return this.displayedRows().filter((row) => !row.isSymlink);
    }

    private selectedRows(): RowEntry[] {
        return this.selectableRows().filter((row) => this.selected.has(row.path));
    }

    private retainSelection(rows: readonly RowEntry[]): void {
        const live = new Set(rows.map((row) => row.path));
        for (const path of this.selected) {
            if (!live.has(path)) {
                this.selected.delete(path);
            }
        }
    }

    private sortedRows(rows: readonly RowEntry[]): RowEntry[] {
        const ranked = rows.map((row) => ({row, sort: this.sortable(row)}));
        ranked.sort((left, right) => compareSorted(left.sort, right.sort, this.sortKey, this.sortDirection));
        return ranked.map((item) => item.row);
    }

    private sortable(row: RowEntry): SortedEntry {
        const cached = this.statCache.get(row.path);
        const fresh = cached && cached.updated === row.updated ? cached : null;
        return {
            name: row.name,
            isDir: row.isDir,
            created: fresh && fresh.created > 0 ? fresh.created : null,
            size: fresh && !row.isDir ? fresh.size : null,
        };
    }

    private setSort(value: string | undefined): void {
        const key = parseSortKey(value);
        if (!key) {
            return;
        }
        if (this.sortKey === key) {
            this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
        } else {
            this.sortKey = key;
            this.sortDirection = key === "name" ? "asc" : "desc";
        }
        this.reorderEntries();
        if (key !== "name") {
            this.fillStats();
        }
    }

    private reorderEntries(): void {
        const list = this.body.querySelector(".sy-folder-block__list, .sy-folder-block__cards");
        if (!list) {
            this.paintSortHeaders();
            return;
        }
        const ranked = [...list.querySelectorAll<HTMLElement>(":scope > [data-entry]")].flatMap((node) => {
            const row = this.rowFromElement(node);
            return row ? [{node, sort: this.sortable(row)}] : [];
        });
        ranked.sort((left, right) => compareSorted(left.sort, right.sort, this.sortKey, this.sortDirection));
        for (const item of ranked) {
            list.append(item.node);
        }
        this.paintSortHeaders();
    }

    private toggleSelected(target: HTMLElement): void {
        const input = target instanceof HTMLInputElement ? target : null;
        const entry = target.closest<HTMLElement>("[data-entry]");
        const row = entry ? this.rowFromElement(entry) : null;
        if (!input || !row || row.isSymlink) {
            return;
        }
        if (input.checked) {
            this.selected.add(row.path);
        } else {
            this.selected.delete(row.path);
        }
        this.syncSelectionControls();
    }

    private toggleSelectAll(target: HTMLElement): void {
        const input = target instanceof HTMLInputElement ? target : null;
        if (!input) {
            return;
        }
        for (const row of this.selectableRows()) {
            if (input.checked) {
                this.selected.add(row.path);
            } else {
                this.selected.delete(row.path);
            }
        }
        this.syncSelectionControls();
    }

    private syncSelectionControls(): void {
        for (const input of this.body.querySelectorAll<HTMLInputElement>("[data-action='select']")) {
            const entry = input.closest<HTMLElement>("[data-entry]");
            const path = entry?.dataset.path ?? "";
            input.checked = this.selected.has(path);
        }
        const rows = this.selectableRows();
        const selected = rows.filter((row) => this.selected.has(row.path)).length;
        const all = this.body.querySelector<HTMLInputElement>("[data-action='select-all']");
        if (all) {
            all.checked = rows.length > 0 && selected === rows.length;
            all.indeterminate = selected > 0 && selected < rows.length;
        }
        this.syncDeleteButton();
    }

    private syncDeleteButton(): void {
        const count = this.selectedRows().length;
        const label = fill(this.options.label("deleteSelected"), {count: String(count)});
        this.deleteSelectedButton.hidden = count === 0;
        this.deleteSelectedButton.disabled = count === 0 || this.deleting;
        this.deleteSelectedButton.setAttribute("aria-label", label);
        const text = this.deleteSelectedButton.querySelector("[data-role='label']");
        if (text) {
            text.textContent = label;
        }
    }

    private readonly onClick = (event: MouseEvent): void => {
        const target = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
        if (!target || !this.root.contains(target)) {
            return;
        }
        const action = target.dataset.action;
        if (action === "set-view") {
            const view = folderView(target.dataset.view);
            if (view) {
                this.setView(view);
            }
            return;
        }
        if (action === "navigate") {
            if (event.detail > 1 && !(target.dataset.relative ?? "")) {
                this.askRenameRoot();
                return;
            }
            this.navigate(target.dataset.relative ?? "");
            return;
        }
        if (action === "upload-file") {
            if (!this.busy) {
                this.fileInput.click();
            }
            return;
        }
        if (action === "upload-folder") {
            if (!this.busy) {
                void this.pickDirectory();
            }
            return;
        }
        if (action === "new-folder") {
            if (!this.busy) {
                this.askNewFolder();
            }
            return;
        }
        if (action === "sort") {
            this.setSort(target.dataset.sort);
            return;
        }
        if (action === "select") {
            this.toggleSelected(target);
            return;
        }
        if (action === "select-all") {
            this.toggleSelectAll(target);
            return;
        }
        if (action === "delete-selected") {
            if (!this.deleting) {
                this.askDeleteSelected();
            }
            return;
        }
        if ((event.target as Element | null)?.closest(".sy-folder-block__check")) {
            return;
        }
        const row = this.rowFromElement(target);
        if (!row || action !== "open") {
            return;
        }
        this.openRow(row);
    };

    private setView(view: FolderView): void {
        if (view === this.doc.view) {
            return;
        }
        if (!this.options.setContent(serializeFolderContent({...this.doc, view}))) {
            showMessage(this.options.label("readonly"), 4000, "error");
            return;
        }
        if (this.destroyed) {
            return;
        }
        this.doc.view = view;
        this.renderViewButtons();
        this.renderBody();
    }

    private rootLabel(): string {
        return this.doc.name || this.options.label("breadcrumbRoot");
    }

    private askRenameRoot(): void {
        openInputDialog({
            title: this.options.label("renameRoot"),
            value: this.doc.name,
            placeholder: this.options.label("breadcrumbRoot"),
            maxLength: 200,
            confirmText: this.options.label("rename"),
            onConfirm: (value, dialog) => {
                const trimmed = value.trim();
                const name = sanitizeRootName(value);
                if (trimmed && !name) {
                    showMessage(this.options.label("invalidName"), 4000, "error");
                    return;
                }
                if (name === this.doc.name) {
                    dialog.destroy();
                    return;
                }
                if (!this.options.setContent(serializeFolderContent({...this.doc, name}))) {
                    showMessage(this.options.label("readonly"), 4000, "error");
                    return;
                }
                if (this.destroyed) {
                    dialog.destroy();
                    return;
                }
                this.doc.name = name;
                dialog.destroy();
                this.renderBreadcrumb();
            },
        });
    }

    /** 还没给根目录起名时，用这次选中的文件夹名。已经改过的名称保持不变。 */
    private rememberRootName(folderName: string): void {
        if (this.destroyed || this.relative || this.doc.name) {
            return;
        }
        const name = sanitizeRootName(folderName);
        if (!name) {
            return;
        }
        if (!this.options.setContent(serializeFolderContent({...this.doc, name}))) {
            return;
        }
        if (this.destroyed) {
            return;
        }
        this.doc.name = name;
        this.renderBreadcrumb();
    }

    private navigate(relative: string): void {
        const next = relative && resolveInsideFolder(this.doc.root, relative) ? relative : "";
        this.relative = next;
        rememberedRelative.set(this.options.element, next);
        this.query = "";
        this.searchInput.value = "";
        this.selected.clear();
        this.hits = null;
        this.searchLimited = false;
        this.searchError = "";
        this.entries = [];
        this.loaded = false;
        this.renderBreadcrumb();
        this.renderBody();
        this.renderStatus();
        void this.refreshListing();
    }

    private openRow(row: RowEntry): void {
        if (row.isSymlink) {
            return;
        }
        if (row.isDir) {
            this.navigate(row.relative);
            return;
        }
        void this.openFile(row);
    }

    private async openFile(row: RowEntry): Promise<void> {
        const opened = await openWithDefaultApp(this.doc.root, row.path);
        if (!opened && !this.destroyed) {
            showMessage(this.options.label("openFailed"), 4000, "error");
        }
    }

    private fillMedia(): void {
        const signal = this.mediaAbort.signal;
        const generation = ++this.mediaGeneration;
        const slots = [...this.body.querySelectorAll<HTMLElement>("[data-media]")];
        void runQueue(slots, async (slot) => {
            if (generation !== this.mediaGeneration || signal.aborted || this.destroyed) {
                return;
            }
            const path = slot.dataset.path;
            const name = slot.dataset.name;
            if (!path || !name || slot.dataset.kind !== "image") {
                return;
            }
            await this.paintImage(slot, path, name, signal);
        });
    }

    private async paintImage(slot: HTMLElement, path: string, name: string, signal: AbortSignal): Promise<void> {
        try {
            const loaded = await this.readImage(path, name, signal);
            if (signal.aborted || this.destroyed || !slot.isConnected) {
                if (loaded.url) {
                    URL.revokeObjectURL(loaded.url);
                }
                return;
            }
            slot.replaceChildren();
            if (loaded.url) {
                const image = document.createElement("img");
                image.alt = name;
                image.src = loaded.url;
                image.dataset.objectUrl = loaded.url;
                slot.append(image);
            } else if (loaded.message) {
                slot.textContent = loaded.message;
            }
        } catch {
            if (!signal.aborted && !this.destroyed && slot.isConnected) {
                slot.textContent = this.options.label("previewFailed");
            }
        }
    }

    private async readImage(path: string, name: string, signal: AbortSignal): Promise<{url: string; message: string}> {
        if (!isInsideFolder(this.doc.root, path)) {
            return {url: "", message: ""};
        }
        const result = await readBoundedFile({
            root: this.doc.root,
            path,
            maxBytes: IMAGE_BYTE_LIMIT,
            keepPartial: false,
            appId: this.options.appId,
            signal,
        });
        if (result.truncated) {
            return {url: "", message: this.options.label("tooLarge")};
        }
        const copy = new Uint8Array(result.bytes.byteLength);
        copy.set(result.bytes);
        const url = URL.createObjectURL(new Blob([copy.buffer], {type: imageMime(name)}));
        return {url, message: ""};
    }

    private patchTimes(entries: readonly DirEntry[]): void {
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        for (const node of this.body.querySelectorAll<HTMLElement>("[data-entry]")) {
            const name = node.dataset.name ?? "";
            const entry = byName.get(name);
            if (!entry || Number(node.dataset.updated) === entry.updated) {
                continue;
            }
            node.dataset.updated = String(entry.updated);
            const time = node.querySelector("[data-role='time']");
            if (time) {
                time.textContent = formatTime(entry.updated);
            }
            if (node.querySelector("[data-role='created']")) {
                this.statCache.delete(node.dataset.path ?? "");
            }
        }
        if (this.doc.view === "title") {
            this.fillStats();
        }
    }

    private fillStats(): void {
        const generation = ++this.statGeneration;
        const pending: HTMLElement[] = [];
        for (const row of this.body.querySelectorAll<HTMLElement>("[data-entry]")) {
            const path = row.dataset.path ?? "";
            const updated = Number(row.dataset.updated ?? "0");
            const cached = path ? this.statCache.get(path) : undefined;
            if (!path) {
                continue;
            }
            if (cached && cached.updated === updated) {
                this.paintStat(row, cached);
                continue;
            }
            pending.push(row);
        }
        void this.loadStats(pending, generation);
    }

    private async loadStats(rows: readonly HTMLElement[], generation: number): Promise<void> {
        await runQueue(rows, async (row) => {
            if (generation !== this.statGeneration || this.destroyed || !row.isConnected) {
                return;
            }
            const path = row.dataset.path ?? "";
            const updated = Number(row.dataset.updated ?? "0");
            if (!path || !isInsideFolder(this.doc.root, path)) {
                return;
            }
            const stat = await statInside(this.doc.root, path).catch(() => null);
            if (generation !== this.statGeneration || this.destroyed || !row.isConnected || row.dataset.path !== path) {
                return;
            }
            if (!stat) {
                this.paintStat(row, null);
                return;
            }
            const record = {updated, created: stat.created, size: stat.size};
            this.statCache.set(path, record);
            this.paintStat(row, record);
        });
        if (generation === this.statGeneration && !this.destroyed && (this.sortKey === "created" || this.sortKey === "size")) {
            this.reorderEntries();
        }
    }

    private paintStat(row: HTMLElement, stat: {created: number; size: number} | null): void {
        const created = row.querySelector("[data-role='created']");
        const size = row.querySelector("[data-role='size']");
        if (created) {
            created.textContent = stat && stat.created > 0 ? formatTime(stat.created) : "—";
        }
        if (size) {
            size.textContent = stat && row.dataset.dir !== "1" ? formatSize(stat.size) : "—";
        }
    }

    private readonly onSearchInput = (): void => {
        window.clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => {
            void this.runSearch();
        }, 300);
    };

    private async runSearch(): Promise<void> {
        const query = this.searchInput.value;
        this.query = query;
        const generation = ++this.searchGeneration;
        if (!query.trim()) {
            this.hits = null;
            this.searchLimited = false;
            this.searchError = "";
            this.renderBody();
            this.renderStatus();
            return;
        }
        try {
            const result = await searchFolderNames(this.doc.root, query, (path) => readFolder(this.doc.root, path));
            if (generation !== this.searchGeneration || this.destroyed) {
                return;
            }
            this.hits = result.hits;
            this.searchLimited = result.limited;
            this.searchError = "";
        } catch {
            if (generation !== this.searchGeneration || this.destroyed) {
                return;
            }
            this.hits = [];
            this.searchLimited = false;
            this.searchError = this.options.label("readFailed");
        }
        this.renderBody();
        this.renderStatus();
    }

    private readonly onFiles = (): void => {
        const files = [...this.fileInput.files ?? []];
        this.fileInput.value = "";
        void this.uploadItems(files.map((file) => ({relative: file.name, isDir: false, file})));
    };

    private readonly onDirectory = (): void => {
        const files = [...this.directoryInput.files ?? []];
        this.directoryInput.value = "";
        const folderName = files[0]?.webkitRelativePath.split("/")[0] ?? "";
        void this.uploadItems(files.map((file) => ({
            relative: file.webkitRelativePath || file.name,
            isDir: false,
            file,
        }))).then(() => {
            this.rememberRootName(folderName);
        });
    };

    private async pickDirectory(): Promise<void> {
        const picker = (window as Window & {showDirectoryPicker?: () => Promise<PickedDirectory>}).showDirectoryPicker;
        if (typeof picker !== "function") {
            this.directoryInput.click();
            return;
        }
        try {
            const directory = await picker.call(window);
            const items: UploadItem[] = [];
            await collectDirectory(directory, "", items);
            await this.uploadItems(items);
            this.rememberRootName(directory.name);
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                return;
            }
            this.directoryInput.click();
        }
    }

    private async uploadItems(items: UploadItem[]): Promise<void> {
        if (this.busy || this.destroyed) {
            return;
        }
        const prepared = prepareUploadItems(items.filter((item) => item.isDir || item.file));
        if (prepared.items.length === 0) {
            if (prepared.rejected) {
                showMessage(this.options.label("uploadRejected"), 5000, "error");
            }
            return;
        }
        this.busy = true;
        let done = 0;
        let rejected = prepared.rejected;
        try {
            for (const item of prepared.items) {
                const relative = joinRelative(this.relative, item.relative);
                const target = relative ? resolveInsideFolder(this.doc.root, relative) : null;
                if (!target || (!item.isDir && !item.file)) {
                    rejected = true;
                    continue;
                }
                this.writing = fill(this.options.label("writing"), {
                    done: String(done),
                    total: String(prepared.items.length),
                });
                this.renderStatus();
                await putInside(this.doc.root, target, item.isDir ? undefined : item.file);
                done += 1;
            }
        } catch (error) {
            showMessage(error instanceof Error && error.message !== "blocked" ? error.message : this.options.label("uploadRejected"), 5000, "error");
        } finally {
            this.busy = false;
            this.writing = "";
            if (rejected) {
                showMessage(this.options.label("uploadRejected"), 5000, "error");
            }
            this.renderStatus();
            await this.refreshListing();
        }
    }

    private askNewFolder(): void {
        openInputDialog({
            title: this.options.label("newFolder"),
            value: "",
            confirmText: this.options.label("create"),
            onConfirm: (value, dialog) => {
                const target = childPath(this.doc.root, this.currentPath(), value);
                if (!target) {
                    showMessage(this.options.label("invalidName"), 4000, "error");
                    return;
                }
                void putInside(this.doc.root, target).then(() => {
                    dialog.destroy();
                    return this.refreshListing();
                }).catch((error: unknown) => {
                    showMessage(error instanceof Error ? error.message : this.options.label("invalidName"), 5000, "error");
                });
            },
        });
    }

    private askRename(row: RowEntry): void {
        if (row.isSymlink) {
            return;
        }
        openInputDialog({
            title: this.options.label("rename"),
            value: row.name,
            confirmText: this.options.label("rename"),
            onConfirm: (value, dialog) => {
                const target = renamedPath(this.doc.root, row.path, value);
                if (!target || target === row.path) {
                    if (target === row.path) {
                        dialog.destroy();
                        return;
                    }
                    showMessage(this.options.label("invalidName"), 4000, "error");
                    return;
                }
                void renameInside(this.doc.root, row.path, target).then(() => {
                    dialog.destroy();
                    return this.refreshListing();
                }).catch((error: unknown) => {
                    showMessage(error instanceof Error ? error.message : this.options.label("invalidName"), 5000, "error");
                });
            },
        });
    }

    private askDelete(row: RowEntry): void {
        if (row.isSymlink) {
            return;
        }
        confirm(this.options.label("delete"), fill(this.options.label("deleteConfirm"), {name: row.name}), () => {
            void this.deleteRows([row]);
        });
    }

    private askDeleteSelected(): void {
        const rows = this.selectedRows();
        if (rows.length === 0 || this.deleting) {
            return;
        }
        const message = rows.length === 1
            ? fill(this.options.label("deleteConfirm"), {name: rows[0].name})
            : fill(this.options.label("deleteSelectedConfirm"), {count: String(rows.length)});
        confirm(this.options.label("delete"), message, () => {
            void this.deleteRows(rows);
        });
    }

    private async deleteRows(rows: readonly RowEntry[]): Promise<void> {
        const targets = deletionOrder(rows.filter((row) => !row.isSymlink && isInsideFolder(this.doc.root, row.path)));
        if (targets.length === 0 || this.deleting || this.destroyed) {
            return;
        }
        this.deleting = true;
        this.syncDeleteButton();
        try {
            for (const row of targets) {
                await removeInside(this.doc.root, row.path);
                this.selected.delete(row.path);
            }
        } catch (error) {
            showMessage(error instanceof Error && error.message !== "blocked" ? error.message : this.options.label("readFailed"), 5000, "error");
        } finally {
            this.deleting = false;
            if (!this.destroyed) {
                this.syncDeleteButton();
                await this.refreshListing();
            }
        }
    }

    private insertLink(row: RowEntry): void {
        if (row.isDir || row.isSymlink) {
            return;
        }
        const id = folderIdFromRoot(this.doc.root);
        const relative = relativeFromRoot(this.doc.root, row.path);
        const editor = getActiveEditor();
        if (!id || !relative || !editor) {
            showMessage(this.options.label("noEditor"), 4000, "error");
            return;
        }
        const lute = editor.protyle.lute ?? window.Lute?.New();
        if (!lute) {
            showMessage(this.options.label("noEditor"), 4000, "error");
            return;
        }
        const href = fileAssetHref(id, relative, false);
        const markdown = assetMarkdown(row.name, href, isImageFile(row.name, false, false));
        editor.insert(lute.Md2BlockDOM(markdown), true);
    }

    private revokeBodyUrls(): void {
        for (const image of this.body?.querySelectorAll<HTMLImageElement>("[data-object-url]") ?? []) {
            const url = image.dataset.objectUrl;
            if (url) {
                URL.revokeObjectURL(url);
            }
        }
    }
}

function menuIcon(name: MdiIconName): string {
    return mdiMarkup(name, "b3-menu__icon");
}

function actionButton(text: string, action: string, className: string): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.dataset.action = action;
    element.textContent = text;
    return element;
}

function toolbarDivider(): HTMLSpanElement {
    const divider = document.createElement("span");
    divider.className = "sy-folder-block__divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
}

function iconButton(label: string, action: string, icon: SVGSVGElement): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "b3-button b3-button--text b3-tooltips b3-tooltips__s sy-folder-block__icon-button";
    element.dataset.action = action;
    element.setAttribute("aria-label", label);
    element.append(icon);
    return element;
}

function bindRow(element: HTMLElement, row: RowEntry): void {
    element.dataset.path = row.path;
    element.dataset.name = row.name;
    element.dataset.updated = String(row.updated);
    element.dataset.dir = row.isDir ? "1" : "0";
    element.dataset.symlink = row.isSymlink ? "1" : "0";
}

function markEntry(element: HTMLElement, row: RowEntry): void {
    element.dataset.entry = "1";
    bindRow(element, row);
}

function nameSpan(name: string): HTMLSpanElement {
    const element = document.createElement("span");
    element.className = "sy-folder-block__name";
    element.textContent = name;
    element.title = name;
    return element;
}

function metaSpan(row: RowEntry, symlinkLabel: string): HTMLSpanElement {
    const element = document.createElement("span");
    element.className = "sy-folder-block__meta";
    const time = document.createElement("span");
    time.dataset.role = "time";
    time.textContent = formatTime(row.updated);
    element.append(time);
    if (row.isSymlink) {
        const symlink = document.createElement("span");
        symlink.textContent = symlinkLabel;
        element.append(symlink);
    }
    return element;
}

function mediaSlot(row: RowEntry): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "sy-folder-block__thumb";
    slot.dataset.media = "1";
    slot.dataset.path = row.path;
    slot.dataset.name = row.name;
    slot.dataset.kind = "image";
    return slot;
}

const VIEW_ICON: Record<FolderView, "viewList" | "viewGrid"> = {
    title: "viewList",
    card: "viewGrid",
};

function viewLabelKey(view: FolderView): "viewTitle" | "viewCard" {
    return view === "card" ? "viewCard" : "viewTitle";
}

function viewIcon(view: FolderView): SVGSVGElement {
    return mdiSvg(VIEW_ICON[view]);
}

function folderView(value: string | undefined): FolderView | null {
    return FOLDER_VIEWS.find((view) => view === value) ?? null;
}

const SORT_LABEL = {
    name: "columnName",
    created: "columnCreated",
    size: "columnSize",
} as const;

function parseSortKey(value: string | undefined): SortKey | null {
    if (value === "name" || value === "created" || value === "size") {
        return value;
    }
    return null;
}

function formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "—";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return `${rounded} ${units[unit]}`;
}

function formatTime(updated: number): string {
    const milliseconds = updated > 0 && updated < 1_000_000_000_000 ? updated * 1000 : updated;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\$\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}

function stopKey(event: Event): void {
    event.stopPropagation();
}

async function collectDirectory(directory: PickedDirectory, prefix: string, into: UploadItem[]): Promise<number> {
    let count = 0;
    for await (const [name, entry] of directory.entries()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === "file") {
            into.push({relative, isDir: false, file: await entry.getFile()});
            count += 1;
            continue;
        }
        if (entry.kind === "directory") {
            const added = await collectDirectory(entry, relative, into);
            if (added === 0) {
                into.push({relative, isDir: true});
            }
            count += 1;
        }
    }
    return count;
}

async function runQueue<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({length: Math.min(3, items.length)}, async () => {
        while (index < items.length) {
            const current = items[index];
            index += 1;
            await task(current);
        }
    });
    await Promise.all(workers);
}
