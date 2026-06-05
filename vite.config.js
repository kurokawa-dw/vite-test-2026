import { defineConfig } from "vite";
import { resolve, dirname, relative } from "node:path";
import fg from "fast-glob";

const rootDir = resolve(__dirname, "src");

function createHtmlInputs() {
  const htmlFiles = fg.sync("**/index.html", {
    cwd: rootDir,
  });

  return Object.fromEntries(
    htmlFiles.map((file) => {
      const name = file.replace(/\/index\.html$/, "") || "index";
      return [name, resolve(rootDir, file)];
    }),
  );
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function getPageDirFromJsPath(facadeModuleId) {
  if (!facadeModuleId) return "";

  const normalized = normalizePath(facadeModuleId);

  // /src/assets/js/main.js -> ""
  // /src/assets/js/sub/main.js -> "sub"
  // /src/assets/js/sub2/main.js -> "sub2"
  const match = normalized.match(/\/assets\/js\/(.+)\/main\.js$/);

  if (match) {
    return match[1];
  }

  return "";
}

function renameCssPlugin() {
  return {
    name: "rename-css-by-entry",

    generateBundle(_, bundle) {
      const cssRenameMap = new Map();

      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        if (!item.isEntry) continue;

        const pageDir = getPageDirFromJsPath(item.facadeModuleId);

        // JSの出力先を調整
        if (pageDir) {
          item.fileName = `assets/js/${pageDir}/main.js`;
        } else {
          item.fileName = "assets/js/main.js";
        }

        // このJSエントリーに紐づくCSSを探す
        const importedCss = item.viteMetadata?.importedCss;

        if (!importedCss) continue;

        for (const cssFileName of importedCss) {
          const newCssFileName = pageDir ? `assets/css/${pageDir}/style.css` : "assets/css/style.css";

          cssRenameMap.set(cssFileName, newCssFileName);
        }
      }

      // CSS asset自体のfileNameを変更
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset") continue;

        const newFileName = cssRenameMap.get(item.fileName);

        if (newFileName) {
          item.fileName = newFileName;
        }
      }

      // HTML内の参照パスを置換
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset") continue;
        if (!item.fileName.endsWith(".html")) continue;
        if (typeof item.source !== "string") continue;

        for (const [oldFileName, newFileName] of cssRenameMap) {
          const oldPath = oldFileName.replace(/^assets\//, "/assets/");
          const newPath = newFileName.replace(/^assets\//, "/assets/");

          item.source = item.source.replaceAll(oldFileName, newFileName).replaceAll(oldPath, newPath);
        }
      }
    },
  };
}

export default defineConfig({
  root: "src",
  base: "./",

  plugins: [renameCssPlugin()],

  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets",
    cssCodeSplit: true,

    // modulepreload-polyfill.js が不要なら消せます
    modulePreload: {
      polyfill: false,
    },

    rollupOptions: {
      input: createHtmlInputs(),

      output: {
        entryFileNames: "assets/js/[name].js",
        chunkFileNames: "assets/js/chunks/[name].js",

        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";

          if (/\.(png|jpe?g|svg|gif|webp|avif|tiff|bmp|ico)$/i.test(name)) {
            return "assets/images/[name][extname]";
          }

          if (/\.(ttf|otf|eot|woff|woff2)$/i.test(name)) {
            return "assets/fonts/[name][extname]";
          }

          // CSSはplugin側でリネームする
          if (/\.css$/i.test(name)) {
            return "assets/[name][extname]";
          }

          return "assets/[name][extname]";
        },
      },
    },
  },
});
