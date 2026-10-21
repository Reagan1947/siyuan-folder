import {Plugin, Setting, showMessage, type Protyle} from "siyuan";
import {putInside} from "./api/assets.ts";
import {mountFolderBlock} from "./block/folder-block.ts";
import {FOLDER_BLOCK_TYPE, folderMarkdown} from "./model/block.ts";
import {createFolderId, rootPathForId} from "./model/path.ts";
import {mdiMarkup} from "./icons.ts";
import {DEFAULT_POLL_SECONDS, MAX_POLL_SECONDS, MIN_POLL_SECONDS, setPollIntervalSeconds, SETTINGS_STORAGE} from "./settings.ts";
import "./index.css";

export default class FolderPlugin extends Plugin {
    private readonly mounts = new Set<() => void>();
    private pollInput: HTMLInputElement | null = null;

    onload() {
        this.customBlockRenders[FOLDER_BLOCK_TYPE] = {
            render: ({element, content, setContent}) => {
                const destroy = mountFolderBlock({
                    element,
                    content,
                    setContent,
                    label: (key) => this.text(key),
                    appId: this.app?.appId ?? "",
                });
                this.mounts.add(destroy);
                return () => {
                    destroy();
                    this.mounts.delete(destroy);
                };
            },
        };
        this.protyleSlash = [{
            filter: ["folder", "wjj", "文件夹"],
            id: "insert-folder",
            html: `<div class="b3-list-item__first">${mdiMarkup("folder", "b3-list-item__graphic")}<span class="b3-list-item__text">${escapeHtml(this.text("insert"))}</span></div>`,
            callback: (protyle: Protyle) => {
                void this.insertFolder(protyle);
            },
        }];
        this.pollInput = document.createElement("input");
        this.pollInput.type = "number";
        this.pollInput.min = String(MIN_POLL_SECONDS);
        this.pollInput.max = String(MAX_POLL_SECONDS);
        this.pollInput.step = "1";
        this.pollInput.className = "b3-text-field";
        this.pollInput.value = String(DEFAULT_POLL_SECONDS);
        this.pollInput.addEventListener("keydown", (event) => event.stopPropagation());
        this.setting = new Setting({
            confirmCallback: () => {
                this.persistInterval();
            },
        });
        this.setting.addItem({
            title: this.text("pollInterval"),
            description: this.text("pollIntervalDesc"),
            actionElement: this.pollInput,
        });
        void this.loadInterval();
    }

    onunload() {
        for (const destroy of this.mounts) {
            destroy();
        }
        this.mounts.clear();
    }

    private async insertFolder(protyle: Protyle): Promise<void> {
        const lute = protyle.protyle?.lute;
        const id = createFolderId();
        const root = rootPathForId(id);
        const markdown = folderMarkdown(this.name, id);
        if (!lute || !root || !markdown) {
            showMessage(this.text("insertFailed"), 5000, "error");
            return;
        }
        try {
            await putInside(root, root);
        } catch {
            showMessage(this.text("insertFailed"), 5000, "error");
            return;
        }
        protyle.insert(lute.Md2BlockDOM(markdown), true);
    }

    private persistInterval(): void {
        if (!this.pollInput) {
            return;
        }
        const seconds = setPollIntervalSeconds(Number(this.pollInput.value));
        this.pollInput.value = String(seconds);
        void this.saveData(SETTINGS_STORAGE, {pollIntervalSeconds: seconds});
    }

    private async loadInterval(): Promise<void> {
        try {
            const stored = await this.loadData(SETTINGS_STORAGE) as {pollIntervalSeconds?: unknown} | null;
            if (!this.pollInput || !stored || typeof stored.pollIntervalSeconds !== "number") {
                return;
            }
            this.pollInput.value = String(setPollIntervalSeconds(stored.pollIntervalSeconds));
        } catch {
            // 读不到设置时继续用默认间隔。
        }
    }

    private text(key: string): string {
        const value = this.i18n[key];
        return typeof value === "string" ? value : key;
    }
}

function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
