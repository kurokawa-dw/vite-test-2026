import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import handlebars from "vite-plugin-handlebars";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";

const rootDir = path.resolve(__dirname, "src");
const distDir = path.resolve(__dirname, "dist");

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function removeLeadingSlash(value) {
  return value.replace(/^\/+/, "");
}

function resolveHtmlReference(htmlFile, reference) {
  const cleanReference = reference.split(/[?#]/)[0];

  if (cleanReference.startsWith("/")) {
    return removeLeadingSlash(cleanReference);
  }

  return normalizePath(path.join(path.dirname(htmlFile), cleanReference));
}

function getAttributeValue(tag, attributeName) {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*["']([^"']+)["']`, "i");
  return tag.match(pattern)?.[1];
}

function toPageName(htmlFile) {
  const pageDir = path.dirname(htmlFile);
  return pageDir === "." ? "index" : normalizePath(pageDir);
}

function cssOutputFileName(cssFile) {
  const normalized = normalizePath(cssFile);
  const match = normalized.match(/^assets\/(?:s[ac]ss)\/(.+)\.(?:s[ac]ss)$/);

  if (match) {
    return `assets/css/${match[1]}.css`;
  }

  return `assets/css/${path.basename(normalized, path.extname(normalized))}.css`;
}

function cssOutputCandidates(cssFile) {
  const normalized = normalizePath(cssFile);
  const candidates = [cssOutputFileName(normalized)];
  const topLevelScss = normalized.match(/^assets\/(?:s[ac]ss)\/([^/]+)\.(?:s[ac]ss)$/);

  if (topLevelScss) {
    candidates.push(`assets/${topLevelScss[1]}.css`);
  }

  return [...new Set(candidates)];
}

function jsOutputFileName(jsFile) {
  const normalized = normalizePath(jsFile);
  const match = normalized.match(/^assets\/js\/(.+)$/);

  if (match) {
    return `assets/js/${match[1]}`;
  }

  return `assets/js/${path.basename(normalized)}`;
}

function createPageEntries() {
  const htmlFiles = fg.sync("**/*.html", {
    cwd: rootDir,
    onlyFiles: true,
    ignore: ["components/**/*.html"],
  });

  return htmlFiles.map((htmlFile) => {
    const source = readFileSync(path.resolve(rootDir, htmlFile), "utf8");
    const stylesheetTags = source.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi) ?? [];
    const moduleScriptTags =
      source.match(/<script\b[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi) ?? [];

    const cssFiles = stylesheetTags
      .map((tag) => getAttributeValue(tag, "href"))
      .filter((href) => href && /\.(s[ac]ss)(?:[?#].*)?$/i.test(href))
      .map((href) => resolveHtmlReference(htmlFile, href));

    const jsFiles = moduleScriptTags
      .map((tag) => getAttributeValue(tag, "src"))
      .filter((src) => src && /\.js(?:[?#].*)?$/i.test(src))
      .map((src) => resolveHtmlReference(htmlFile, src));

    return {
      htmlFile,
      pageName: toPageName(htmlFile),
      jsOutput: jsFiles[0] ? jsOutputFileName(jsFiles[0]) : undefined,
      cssFiles,
      cssOutputs: cssFiles.map(cssOutputFileName),
    };
  });
}

function createHtmlInputs(pageEntries) {
  return Object.fromEntries(pageEntries.map((entry) => [entry.pageName, path.resolve(rootDir, entry.htmlFile)]));
}

function getCssLinkOrder(entry) {
  return entry.cssFiles.flatMap(cssOutputCandidates);
}

function getHtmlCssLinkFileName(linkTag) {
  const href = getAttributeValue(linkTag, "href");

  return href ? removeLeadingSlash(href.split(/[?#]/)[0]) : "";
}

function reorderCssLinks(source, entry) {
  const order = getCssLinkOrder(entry);
  const orderIndex = new Map(order.map((fileName, index) => [fileName, index]));
  const linkPattern = /^[ \t]*<link\b(?=[^>]*rel=["']stylesheet["'])(?=[^>]*href=["'][^"']+\.css(?:[?#][^"']*)?["'])[^>]*>[ \t]*\r?\n?/gim;
  const links = [...source.matchAll(linkPattern)].map((match, index) => ({
    index,
    start: match.index,
    end: match.index + match[0].length,
    tag: match[0],
    fileName: getHtmlCssLinkFileName(match[0]),
  }));

  const sortableLinks = links.filter((link) => orderIndex.has(link.fileName));

  if (sortableLinks.length < 2) {
    return source;
  }

  const sortedTags = [...sortableLinks]
    .sort((a, b) => orderIndex.get(a.fileName) - orderIndex.get(b.fileName) || a.index - b.index)
    .map((link) => link.tag.trimEnd())
    .join("\n");
  const removable = new Set(sortableLinks);
  let result = "";
  let cursor = 0;
  let inserted = false;

  for (const link of links) {
    if (!removable.has(link)) {
      continue;
    }

    result += source.slice(cursor, link.start);

    if (!inserted) {
      result += `${sortedTags}\n`;
      inserted = true;
    }

    cursor = link.end;
  }

  result += source.slice(cursor);

  return result;
}

function mpaAssetLayoutPlugin(pageEntries) {
  const entryByPageName = new Map(pageEntries.map((entry) => [entry.pageName, entry]));
  const entryByHtmlFile = new Map(pageEntries.map((entry) => [entry.htmlFile, entry]));
  const cssRenameMap = new Map();

  return {
    name: "mpa-asset-layout",

    generateBundle(_, bundle) {
      cssRenameMap.clear();

      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || !item.fileName.endsWith(".css")) {
          continue;
        }

        const pageName = path.basename(item.fileName, ".css");
        const entry = entryByPageName.get(pageName);
        const cssOutput = entry?.cssOutputs.at(-1);

        if (cssOutput) {
          cssRenameMap.set(item.fileName, cssOutput);
          item.fileName = cssOutput;
        }
      }

      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || !item.fileName.endsWith(".html") || typeof item.source !== "string") {
          continue;
        }

        for (const [oldFileName, newFileName] of cssRenameMap) {
          item.source = item.source.replaceAll(oldFileName, newFileName);
        }

        const entry = entryByHtmlFile.get(item.fileName);

        if (entry) {
          item.source = reorderCssLinks(item.source, entry);
        }
      }
    },

    writeBundle() {
      const htmlFiles = fg.sync("**/*.html", {
        cwd: distDir,
        onlyFiles: true,
      });

      for (const htmlFile of htmlFiles) {
        const filePath = path.resolve(distDir, htmlFile);
        let source = readFileSync(filePath, "utf8");

        for (const [oldFileName, newFileName] of cssRenameMap) {
          source = source.replaceAll(oldFileName, newFileName);
        }

        const entry = entryByHtmlFile.get(htmlFile);

        if (entry) {
          source = reorderCssLinks(source, entry);
        }

        writeFileSync(filePath, source);
      }
    },
  };
}

const pageEntries = createPageEntries();
const entryByPageName = new Map(pageEntries.map((entry) => [entry.pageName, entry]));

export default defineConfig({
  root: "src",
  publicDir: path.resolve(__dirname, "public"),
  base: "/",
  server: {
    host: "0.0.0.0",
  },

  plugins: [
    handlebars({
      partialDirectory: path.resolve(rootDir, "components"),
    }),
    vue(),
    mpaAssetLayoutPlugin(pageEntries),
  ],

  build: {
    outDir: "../dist",
    emptyOutDir: true,
    assetsDir: "assets",
    cssCodeSplit: true,
    modulePreload: {
      polyfill: false,
    },

    rollupOptions: {
      input: createHtmlInputs(pageEntries),

      output: {
        entryFileNames: (chunkInfo) => {
          const entry = entryByPageName.get(chunkInfo.name);

          return entry?.jsOutput ?? "assets/js/[name].js";
        },
        chunkFileNames: "assets/js/chunks/[name].js",

        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";

          if (/\.(png|jpe?g|svg|gif|webp|avif|tiff|bmp|ico)$/i.test(name)) {
            return "assets/images/[name][extname]";
          }

          if (/\.(ttf|otf|eot|woff|woff2)$/i.test(name)) {
            return "assets/fonts/[name][extname]";
          }

          return "assets/[name][extname]";
        },
      },
    },
  },
});
