# Folder

在思源笔记中插入文件夹, 文件将保存至 assets 文件夹中, 并自动纳入思源笔记同步逻辑中。用 `/folder` 或 `/wjj` 插入，块内切换标题、卡片两种视图。

方案说明见 [docs/folder-mount.md](docs/folder-mount.md)。

## 开发

把本目录放到 `{工作空间}/data/plugins/siyuan-folder/`，目录名必须和 `plugin.json` 的 `name` 一致。

```bash
pnpm install
pnpm dev
```

然后在思源「集市 → 已下载 → 插件」里启用 Folder。`pnpm dev` 会监视源码并写出 `index.js`、`index.css` 和 `i18n/`。构建配置在 `webpack.config.cjs`。

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm build` 生成 `dist/` 和 `package.zip`。
