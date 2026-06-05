import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import handlebars from "vite-plugin-handlebars";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";

const rootDir = path.resolve(__dirname, "src");
const distDir = path.resolve(__dirname, "dist");
const dir = "path/path2/";

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function removeLeadingSlash(value) {
  return value.replace(/^\/+/, "");
}

function removeTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeOutputDir(value) {
  return removeTrailingSlash(removeLeadingSlash(normalizePath(value)));
}

const assetOutputDir = normalizeOutputDir(dir);

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

function getAssetOutputPathForPage(htmlFile, assetType, fileName) {
  const pageDir = path.dirname(htmlFile);

  if (assetOutputDir && (pageDir === assetOutputDir || pageDir.startsWith(`${assetOutputDir}/`))) {
    const relativePageDir = normalizePath(path.relative(assetOutputDir, pageDir));

    if (!relativePageDir || relativePageDir === ".") {
      return `${assetOutputDir}/assets/${assetType}/${fileName}`;
    }

    return `${assetOutputDir}/assets/${assetType}/${relativePageDir}/${fileName}`;
  }

  if (pageDir === ".") {
    return `assets/${assetType}/${fileName}`;
  }

  return `assets/${assetType}/${normalizePath(pageDir)}/${fileName}`;
}

function cssOutputFileNameForPage(htmlFile) {
  return getAssetOutputPathForPage(htmlFile, "css", "style.css");
}

function jsOutputFileNameForPage(htmlFile) {
  return getAssetOutputPathForPage(htmlFile, "js", "script.js");
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
      jsOutput: jsFiles[0] ? jsOutputFileNameForPage(htmlFile) : undefined,
      cssFiles,
      cssOutput: cssOutputFileNameForPage(htmlFile),
    };
  });
}

function createHtmlInputs(pageEntries) {
  return Object.fromEntries(pageEntries.map((entry) => [entry.pageName, path.resolve(rootDir, entry.htmlFile)]));
}

function getHtmlCssLinkFileName(linkTag) {
  const href = getAttributeValue(linkTag, "href");

  return href ? removeLeadingSlash(href.split(/[?#]/)[0]) : "";
}

function getHtmlCssLinks(source) {
  const linkPattern =
    /^[ \t]*<link\b(?=[^>]*rel=["']stylesheet["'])(?=[^>]*href=["'][^"']+\.css(?:[?#][^"']*)?["'])[^>]*>[ \t]*\r?\n?/gim;

  return [...source.matchAll(linkPattern)].map((match, index) => ({
    index,
    start: match.index,
    end: match.index + match[0].length,
    tag: match[0],
    fileName: getHtmlCssLinkFileName(match[0]),
  }));
}

function replaceGeneratedCssLinks(source, generatedLinks, outputFileName) {
  if (generatedLinks.length === 0) {
    return source;
  }

  const links = getHtmlCssLinks(source);
  const removable = new Set(generatedLinks.map((link) => link.fileName));
  let result = "";
  let cursor = 0;
  let inserted = false;

  for (const link of links) {
    if (!removable.has(link.fileName)) {
      continue;
    }

    result += source.slice(cursor, link.start);

    if (!inserted) {
      const indent = link.tag.match(/^[ \t]*/)?.[0] ?? "";
      result += `${indent}<link rel="stylesheet" crossorigin href="/${outputFileName}">\n`;
      inserted = true;
    }

    cursor = link.end;
  }

  result += source.slice(cursor);

  return result;
}

function mpaAssetLayoutPlugin(pageEntries) {
  const entryByHtmlFile = new Map(pageEntries.map((entry) => [entry.htmlFile, entry]));
  const pageCssOutputs = new Set(pageEntries.map((entry) => entry.cssOutput));
  const generatedCssFiles = new Set();

  return {
    name: "mpa-asset-layout",

    generateBundle(_, bundle) {
      generatedCssFiles.clear();

      for (const item of Object.values(bundle)) {
        if (item.type === "asset" && item.fileName.endsWith(".css")) {
          generatedCssFiles.add(item.fileName);
        }
      }
    },

    writeBundle() {
      const usedCssFiles = new Set();
      const htmlFiles = fg.sync("**/*.html", {
        cwd: distDir,
        onlyFiles: true,
      });

      for (const htmlFile of htmlFiles) {
        const entry = entryByHtmlFile.get(htmlFile);

        if (!entry) {
          continue;
        }

        const htmlPath = path.resolve(distDir, htmlFile);
        let htmlSource = readFileSync(htmlPath, "utf8");
        const links = getHtmlCssLinks(htmlSource);
        const generatedLinks = links.filter((link) => generatedCssFiles.has(link.fileName));

        if (generatedLinks.length === 0) {
          continue;
        }

        const cssSource = generatedLinks
          .map((link) => {
            const cssPath = path.resolve(distDir, link.fileName);
            usedCssFiles.add(link.fileName);

            return readFileSync(cssPath, "utf8");
          })
          .join("\n");
        const outputPath = path.resolve(distDir, entry.cssOutput);

        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, cssSource);

        htmlSource = replaceGeneratedCssLinks(htmlSource, generatedLinks, entry.cssOutput);
        writeFileSync(htmlPath, htmlSource);
      }

      for (const fileName of usedCssFiles) {
        if (pageCssOutputs.has(fileName)) {
          continue;
        }

        const filePath = path.resolve(distDir, fileName);

        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
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
