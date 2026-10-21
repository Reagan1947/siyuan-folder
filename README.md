<p align="center">
<img alt="siyuan-folder" src="./icon.png" width="160">
</p>

<p align="center">
    <strong>siyuan-folder</strong>
    <br>
    思源文件夹
    <br>
    Insert a folder into a SiYuan document. Files are saved in the assets folder and included in SiYuan sync.
    <br>
    Two views · Files stay in assets · Included in sync
</p>

<p align="center">
    <a href="./README.zh-CN.md">中文</a> | <a href="./README.md">English</a>
</p>

## Features

- [x] Insert a folder with `/folder`, `/wjj`, or `/文件夹`
- [x] Switch between Title and Card views inside the block
- [x] Open a subfolder in the same block, and return with the breadcrumb
- [x] Create a subfolder, add files, or upload a local folder and keep its relative paths
- [x] Rename and delete items inside the folder
- [x] Insert an asset link for a selected file at the cursor
- [x] Search by file or folder name
- [x] Sort by name, created time, or size
- [x] Show image thumbnails in Card view
- [x] Open a file with the system default app
- [x] Show an item in the file manager on desktop
- [x] Reread the visible folder level on an interval

## Usage

**Insert a folder**

Type `/folder` or `/wjj` in the editor, then choose siyuan-folder. SiYuan creates `data/assets/folder/{id}/` and inserts the block at the cursor. If the directory cannot be created, nothing is inserted.

**Switch views**

Use the view control in the block.

- **Title:** one name per row, with created time and size.
- **Card:** a grid. Images show a thumbnail. Other files show a type icon, with the name underneath.

The chosen view is saved in the block. The folder you have opened is not: reopening the document returns to the root of that folder.

**Move around**

Click a folder to open it. The breadcrumb returns to a parent or to the root. You can rename the name shown on the root.

Click a file to open it with the system default app. On desktop, the item menu can show it in the file manager. A symbolic link is listed and is not opened or entered.

**Add files**

- **Add file** writes the selected files into the current level.
- **Add folder** uploads a local folder and keeps relative paths, including empty subfolders.
- **New folder** creates a subfolder in the current level.

Names are checked by SiYuan. A name that starts with a dot is rejected. A path that would leave this folder is rejected.

**Rename, delete, and insert a link**

Use the item menu to rename or delete one item. Select several items to delete them together. Deleting cannot be undone.

**Insert link** places that file’s asset link at the cursor in the current editor.

**Search and sort**

Search matches file and folder names under the current folder, up to 6 levels and 200 results. Sort by name, created time, or size. Sort order stays in the block until you leave it.

**Images**

In Card view, an image under 20 MB is shown as a thumbnail. A larger image shows its name and modified time only.

**Refresh**

While the block is visible, the current level is reread every 3 seconds. Change this in the plugin settings. The interval is from 2 to 30 seconds. A level that is collapsed or scrolled out of view is not requested.

**Where the files live**

Each block owns one directory, `data/assets/folder/{id}/`. The block stores a link to that directory. SiYuan treats the files there as referenced assets, so they are kept when cleaning unreferenced files and they follow SiYuan sync.

Copying the block copies that link. Both blocks show the same files.

The block does not browse the rest of the workspace, and it does not read paths outside its own asset directory.

**Publish**

The interactive folder is not rendered on a publish page. The asset link remains in the document. The same fallback is shown when the plugin is disabled.

## Changelog

+ v0.1.0
  + Feature: insert a folder block with `/folder` or `/wjj`
  + Feature: Title and Card views
  + Feature: create subfolders, upload files, and upload a local folder
  + Feature: rename, delete, search, and sort
  + Feature: insert an asset link, open with the system app, and reveal in the file manager
