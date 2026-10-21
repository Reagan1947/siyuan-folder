const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");

const ICONS_FILE = path.resolve(__dirname, "src/icons.ts");

function mdiIconIds() {
    const source = fs.readFileSync(ICONS_FILE, "utf8");
    const block = source.match(/export const MDI_ICON = \{([\s\S]*?)\} as const;/);
    if (!block) {
        throw new Error("src/icons.ts is missing MDI_ICON");
    }
    const ids = [...block[1].matchAll(/:\s*"([a-z0-9-]+)"/g)].map((match) => match[1]);
    if (ids.length === 0) {
        throw new Error("MDI_ICON has no icons");
    }
    return ids;
}

function mdiSubset() {
    const mdi = require("@iconify-json/mdi/icons.json");
    const icons = {};
    for (const name of mdiIconIds()) {
        const icon = resolveMdiIcon(mdi, name);
        icons[name] = icon.width || icon.height
            ? {body: icon.body, width: icon.width, height: icon.height}
            : {body: icon.body};
    }
    return {width: mdi.width || 24, height: mdi.height || 24, icons};
}

function resolveMdiIcon(mdi, name) {
    const seen = new Set();
    let current = name;
    while (mdi.aliases?.[current]) {
        if (seen.has(current)) {
            throw new Error(`mdi alias cycle: ${name}`);
        }
        seen.add(current);
        current = mdi.aliases[current].parent;
    }
    const icon = mdi.icons[current];
    if (!icon?.body) {
        throw new Error(`Missing mdi icon: ${name}`);
    }
    return icon;
}

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    const plugins = [
        new webpack.DefinePlugin({
            __MDI__: webpack.DefinePlugin.runtimeValue(
                () => `(${JSON.stringify(mdiSubset())})`,
                [ICONS_FILE],
            ),
        }),
        new MiniCssExtractPlugin({
            filename: production ? "dist/index.css" : "index.css",
        }),
    ];

    if (production) {
        plugins.push(
            new webpack.BannerPlugin({
                banner: () => fs.readFileSync("LICENSE", "utf8"),
            }),
            new CopyPlugin({
                patterns: [
                    {from: "README*.md", to: "./dist/"},
                    {from: "plugin.json", to: "./dist/"},
                    {from: "icon.png", to: "./dist/"},
                    {from: "preview.png", to: "./dist/"},
                    {from: "src/i18n/", to: "./dist/i18n/"},
                ],
            }),
            new ZipPlugin({
                filename: "package.zip",
                algorithm: "gzip",
                include: [/dist/],
                pathMapper: (assetPath) => assetPath.replace(/^dist\//, ""),
            }),
        );
    } else {
        plugins.push(new CopyPlugin({
            patterns: [{from: "src/i18n/", to: "./i18n/"}],
        }));
    }

    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "[name].js",
            path: path.resolve(__dirname),
            library: {type: "commonjs2"},
        },
        externals: {siyuan: "siyuan"},
        entry: {
            [production ? "dist/index" : "index"]: "./src/index.ts",
        },
        optimization: {
            minimize: production,
            minimizer: [new EsbuildPlugin()],
        },
        resolve: {
            extensions: [".ts", ".js", ".json"],
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [{loader: "esbuild-loader", options: {target: "es6"}}],
                },
                {
                    test: /\.css$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [MiniCssExtractPlugin.loader, "css-loader"],
                },
            ],
        },
        plugins,
    };
};
