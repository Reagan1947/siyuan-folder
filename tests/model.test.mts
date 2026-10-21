import assert from "node:assert/strict";
import test from "node:test";
import {folderMarkdown, parseFolderContent, sanitizeRootName, serializeFolderContent} from "../src/model/block.ts";
import {deletionOrder, ENTRY_LIMIT, listingDelta, sortEntries, visibleEntries} from "../src/model/entries.ts";
import {assetMarkdown, fileAssetHref} from "../src/model/link.ts";
import {localAssetPath} from "../src/model/local-path.ts";
import {
    childPath,
    createFolderId,
    isFolderId,
    isInsideFolder,
    joinRelative,
    normalizeWorkspacePath,
    renamedPath,
    resolveInsideFolder,
    rootPathForId,
    type DirEntry,
} from "../src/model/path.ts";
import {isImageFile} from "../src/model/image.ts";
import {SEARCH_MAX_DEPTH, SEARCH_MAX_HITS, searchFolderNames} from "../src/model/search.ts";
import {clampPollSeconds} from "../src/settings.ts";
import {prepareUploadItems} from "../src/model/upload.ts";

const ID = "20261021113000-a1b2c3d";
const ROOT = `/data/assets/folder/${ID}`;

function entry(name: string, overrides: Partial<DirEntry> = {}): DirEntry {
    return {name, isDir: false, isSymlink: false, updated: 1, ...overrides};
}

test("folder ids use the siyuan timestamp shape", () => {
    const id = createFolderId(new Date(2026, 9, 21, 11, 30, 0), "a1b2c3d");
    assert.equal(id, "20261021113000-a1b2c3d");
    assert.equal(isFolderId(id), true);
    assert.equal(isFolderId(createFolderId()), true);
});

test("normalize keeps a workspace path and rejects traversal", () => {
    assert.equal(normalizeWorkspacePath("/data/assets/folder/20261021113000-a1b2c3d"), ROOT);
    assert.equal(normalizeWorkspacePath("/data//assets/./folder/20261021113000-a1b2c3d"), ROOT);
    assert.equal(normalizeWorkspacePath("/data/../conf"), null);
    assert.equal(normalizeWorkspacePath("data/assets"), null);
    assert.equal(normalizeWorkspacePath("/data/assets\0"), null);
});

test("only the block asset directory and its children are accepted", () => {
    assert.equal(rootPathForId(ID), ROOT);
    assert.equal(rootPathForId("../conf"), null);
    assert.equal(isInsideFolder(ROOT, ROOT), true);
    assert.equal(isInsideFolder(ROOT, `${ROOT}/nested/a.txt`), true);
    assert.equal(isInsideFolder(ROOT, "/data/assets"), false);
    assert.equal(isInsideFolder(ROOT, "/data/assets/folder"), false);
    assert.equal(isInsideFolder(ROOT, "/data/assets/other"), false);
    assert.equal(isInsideFolder(ROOT, `${ROOT}2`), false);
    assert.equal(isInsideFolder(ROOT, "/data/assets/folder/20261021113000-a1b2c3d/../../conf"), false);
    assert.equal(resolveInsideFolder(ROOT, "../conf"), null);
    assert.equal(resolveInsideFolder(ROOT, "/etc/passwd"), null);
    assert.equal(resolveInsideFolder(ROOT, ".hidden"), null);
    assert.equal(resolveInsideFolder(ROOT, "notes/a.txt"), `${ROOT}/notes/a.txt`);
    assert.equal(joinRelative("notes", "../a.txt"), null);
    assert.equal(childPath(ROOT, `${ROOT}/notes`, "a.txt"), `${ROOT}/notes/a.txt`);
    assert.equal(childPath(ROOT, "/data/assets", "a.txt"), null);
    assert.equal(renamedPath(ROOT, `${ROOT}/a.txt`, ".secret"), null);
    assert.equal(renamedPath(ROOT, `${ROOT}/notes/a.txt`, "b.txt"), `${ROOT}/notes/b.txt`);
    assert.equal(renamedPath(ROOT, ROOT, "b.txt"), null);
});

test("folder block content keeps the asset link and a known view", () => {
    const parsed = parseFolderContent(`[folder](assets/folder/${ID}/)\ncard\n`);
    assert.deepEqual(parsed, {root: ROOT, href: `assets/folder/${ID}/`, view: "card", name: ""});
    assert.equal(parseFolderContent(`[folder](assets/folder/${ID}/)\nnope`)?.view, "title");
    assert.equal(parseFolderContent(`[folder](assets/other/)\ntitle`), null);
    assert.equal(parseFolderContent(`[folder](assets/folder/${ID}/nested/)\ntitle`), null);
    assert.equal(parseFolderContent(`[folder](assets/folder/${ID}/)\npreview`)?.view, "title");
    assert.equal(serializeFolderContent({root: ROOT, href: `assets/folder/${ID}/`, view: "card", name: ""}), `[folder](assets/folder/${ID}/)\ncard`);
    assert.equal(parseFolderContent(`[folder](assets/folder/${ID}/)\ntitle\n项目资料`)?.name, "项目资料");
    assert.equal(serializeFolderContent({root: ROOT, href: `assets/folder/${ID}/`, view: "title", name: "项目资料"}), `[folder](assets/folder/${ID}/)\ntitle\n项目资料`);
    assert.equal(sanitizeRootName("  Notes  "), "Notes");
    assert.equal(sanitizeRootName("   "), "");
    assert.equal(sanitizeRootName(";;;"), "");
    assert.equal(sanitizeRootName("a".repeat(201)).length, 200);
    assert.equal(folderMarkdown("siyuan-folder", ID), `;;;siyuan-folder/folder\n[folder](assets/folder/${ID}/)\ntitle\n;;;`);
    assert.equal(folderMarkdown("siyuan-folder", "../conf"), null);
});

test("visible entries drop dot names and sort directories first", () => {
    const entries = visibleEntries([
        entry("b.txt"),
        entry(".secret"),
        entry("nested", {isDir: true, updated: 2}),
        entry("a.txt", {updated: 3}),
    ]);
    assert.deepEqual(entries.map((item) => item.name), ["nested", "a.txt", "b.txt"]);
    assert.equal(ENTRY_LIMIT, 5000);
});

test("sorting keeps directories first and uses name, created time, or size", () => {
    const rows = [
        {name: "b.txt", isDir: false, created: 20, size: 5},
        {name: "z", isDir: true, created: 5, size: null},
        {name: "a", isDir: true, created: 40, size: null},
        {name: "a.txt", isDir: false, created: 10, size: 30},
        {name: "pending.txt", isDir: false, created: null, size: null},
    ];
    assert.deepEqual(sortEntries(rows, "name", "asc").map((item) => item.name), ["a", "z", "a.txt", "b.txt", "pending.txt"]);
    assert.deepEqual(sortEntries(rows, "name", "desc").map((item) => item.name), ["z", "a", "pending.txt", "b.txt", "a.txt"]);
    assert.deepEqual(sortEntries(rows, "created", "asc").map((item) => item.name), ["z", "a", "a.txt", "b.txt", "pending.txt"]);
    assert.deepEqual(sortEntries(rows, "created", "desc").map((item) => item.name), ["a", "z", "b.txt", "a.txt", "pending.txt"]);
    assert.deepEqual(sortEntries(rows, "size", "asc").map((item) => item.name), ["a", "z", "b.txt", "a.txt", "pending.txt"]);
    assert.deepEqual(sortEntries(rows, "size", "desc").map((item) => item.name), ["a", "z", "a.txt", "b.txt", "pending.txt"]);
    assert.deepEqual(deletionOrder([
        {relative: "pics", path: "/pics"},
        {relative: "pics/a.txt", path: "/pics/a.txt"},
        {relative: "notes.txt", path: "/notes.txt"},
    ]).map((item) => item.relative), ["pics/a.txt", "notes.txt", "pics"]);
});

test("listing delta distinguishes mtime changes from membership changes", () => {
    const file = entry("a.txt", {updated: 10});
    assert.deepEqual(listingDelta([file], [file]), {type: "unchanged"});
    assert.deepEqual(listingDelta([file], [{...file, updated: 11}]), {type: "times", names: ["a.txt"]});
    assert.deepEqual(listingDelta([file], [{...file, isDir: true}]), {type: "replaced"});
    assert.deepEqual(listingDelta([file], []), {type: "replaced"});
});

test("image files are recognized and symlinks are not", () => {
    assert.equal(isImageFile("a.png", false, false), true);
    assert.equal(isImageFile("a.JPG", false, false), true);
    assert.equal(isImageFile("photo.svg", false, false), true);
    assert.equal(isImageFile("a.md", false, false), false);
    assert.equal(isImageFile("a.pdf", false, false), false);
    assert.equal(isImageFile("a.png", false, true), false);
    assert.equal(isImageFile("dir", true, false), false);
});

test("upload preparation keeps parent directories and rejects escape paths", () => {
    const prepared = prepareUploadItems([
        {relative: "pics/a.txt", isDir: false},
        {relative: "empty", isDir: true},
        {relative: "../secret.txt", isDir: false},
        {relative: ".hidden", isDir: false},
    ]);
    assert.equal(prepared.rejected, true);
    assert.deepEqual(prepared.items.map((item) => `${item.isDir ? "d" : "f"}:${item.relative}`), [
        "d:empty",
        "d:pics",
        "f:pics/a.txt",
    ]);
});

test("asset links encode names and choose image or file markdown", () => {
    assert.equal(fileAssetHref(ID, "my file.png", false), `assets/folder/${ID}/my%20file.png`);
    assert.equal(assetMarkdown("my file.png", `assets/folder/${ID}/my%20file.png`, true), `![my file.png](assets/folder/${ID}/my%20file.png)`);
    assert.equal(assetMarkdown("a].txt", "assets/folder/x/a%5D.txt", false), `[a\\].txt](assets/folder/x/a%5D.txt)`);
});

test("local reveal path stays under the block asset directory", () => {
    assert.equal(
        localAssetPath("/Users/me/ws", ROOT, `${ROOT}/a.txt`),
        `/Users/me/ws/data/assets/folder/${ID}/a.txt`,
    );
    assert.equal(
        localAssetPath("C:\\ws\\", ROOT, ROOT),
        `C:\\ws\\data\\assets\\folder\\${ID}`,
    );
    assert.equal(localAssetPath("", ROOT, ROOT), null);
    assert.equal(localAssetPath("/Users/me/ws", "/data/assets", "/data/assets/a.txt"), null);
});

test("poll interval stays between 2 and 30 seconds", () => {
    assert.equal(clampPollSeconds(1), 2);
    assert.equal(clampPollSeconds(30.6), 30);
    assert.equal(clampPollSeconds(Number.NaN), 3);
    assert.equal(clampPollSeconds(9.2), 9);
});

test("name search stays inside the block directory and stops at the limits", async () => {
    const tree = new Map<string, DirEntry[]>([
        [ROOT, [entry("d1", {isDir: true}), entry(".hit.txt"), entry("root-hit.txt")]],
        [`${ROOT}/d1`, [entry("d2", {isDir: true})]],
        [`${ROOT}/d1/d2`, [entry("d3", {isDir: true})]],
        [`${ROOT}/d1/d2/d3`, [entry("d4", {isDir: true})]],
        [`${ROOT}/d1/d2/d3/d4`, [entry("d5", {isDir: true})]],
        [`${ROOT}/d1/d2/d3/d4/d5`, [entry("d6", {isDir: true})]],
        [`${ROOT}/d1/d2/d3/d4/d5/d6`, [entry("hit.txt"), entry("d7", {isDir: true})]],
        [`${ROOT}/d1/d2/d3/d4/d5/d6/d7`, [entry("miss.txt")]],
    ]);
    const found = await searchFolderNames(ROOT, "hit", async (path) => tree.get(path) ?? []);
    assert.deepEqual(found.hits.map((hit) => hit.relative).sort(), [`d1/d2/d3/d4/d5/d6/hit.txt`, "root-hit.txt"]);
    assert.equal(found.limited, true);
    assert.equal(SEARCH_MAX_DEPTH, 6);

    const wide = [ROOT, Array.from({length: SEARCH_MAX_HITS + 5}, (_value, index) => entry(`n${index}.txt`))] as const;
    const many = await searchFolderNames(ROOT, "n", async (path) => path === wide[0] ? wide[1] : []);
    assert.equal(many.hits.length, SEARCH_MAX_HITS);
    assert.equal(many.limited, true);

    const symlinks = await searchFolderNames(ROOT, "inner", async (path) => {
        if (path === ROOT) {
            return [entry("link", {isDir: true, isSymlink: true})];
        }
        if (path === `${ROOT}/link`) {
            return [entry("inner.txt")];
        }
        return [];
    });
    assert.deepEqual(symlinks.hits.map((hit) => hit.name), []);
});
