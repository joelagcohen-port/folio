import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDashboardComponentStyles, DASHBOARD_COMPONENT_STYLES, embedDashboardComponentStyles } from "./scripts/dashboard-component-styles.mjs";

const componentStylePaths = DASHBOARD_COMPONENT_STYLES.map(filename => `public/${filename}`);

function componentStyleSources() {
  return Object.fromEntries(DASHBOARD_COMPONENT_STYLES.map(filename => [filename, readFileSync(`public/${filename}`, "utf8")]));
}

function currentBuildId() {
  if (process.env.FOLIO_BUILD_ID) return process.env.FOLIO_BUILD_ID;
  const hash = createHash("sha256");
  hash.update(process.env.CF_PAGES_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "local");
  const generated = new Set(["public/sw.js"]);
  let sourcePaths: string[] = [];
  try {
    sourcePaths = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split("\0").filter(Boolean);
  } catch {
    const roots = ["app", "components", "hooks", "lib", "public", "scripts", "build", "vendor"];
    const visit = (directory: string): string[] => {
      if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return visit(path);
        return entry.isFile() ? [path.replaceAll("\\", "/")] : [];
      });
    };
    sourcePaths = roots.flatMap(visit).concat([
      "package.json", "pnpm-lock.yaml", "vite.config.ts", "next.config.ts",
      "tsconfig.json", "components.json", "postcss.config.mjs", "eslint.config.mjs",
    ]);
  }
  const paths = [...new Set([
    ...sourcePaths.filter(path => !generated.has(path)),
    ...componentStylePaths,
  ])].sort();
  for (const path of paths) {
    hash.update(path);
    let source = readFileSync(path);
    if (path === "public/dashboard.html") {
      source = Buffer.from(canonicalizeDashboardComponentStyles(source.toString("utf8"))
        .replace(/(<meta name="folio-build-id" content=")[^"]*(">)/, "$1__FOLIO_BUILD_ID__$2")
        .replace(/(<meta name="folio-api-generation" content=")[^"]*(">)/, "$1__FOLIO_API_GENERATION__$2")
        .replace(/((?:src|href)="\/folio-[^"?]+\.(?:js|css))(?:\?v=[^"]*)?(">)/g, "$1?v=__FOLIO_BUILD_ID__$2"));
    }
    hash.update(source);
  }
  return hash.digest("hex");
}
const folioBuildId = currentBuildId();
const versionSource = readFileSync("app/folio-version.ts", "utf8");
const apiGeneration = Number(versionSource.match(/FOLIO_API_GENERATION\s*=\s*(\d+)/)?.[1] || 1);
const minSupportedGeneration = Number(versionSource.match(/FOLIO_MIN_SUPPORTED_GENERATION\s*=\s*(\d+)/)?.[1] || apiGeneration);
const dashboardHtml = embedDashboardComponentStyles(readFileSync("public/dashboard.html", "utf8"), componentStyleSources())
  .replace(/(<meta name="folio-build-id" content=")[^"]*(">)/, `$1${folioBuildId}$2`)
  .replace(/(<meta name="folio-api-generation" content=")[^"]*(">)/, `$1${apiGeneration}$2`)
  .replace(/((?:src|href)="\/folio-[^"?]+\.(?:js|css))(?:\?v=[^"]*)?(">)/g, `$1?v=${folioBuildId}$2`);
writeFileSync("public/dashboard.html", dashboardHtml);
const serviceWorkerTemplate = readFileSync("public/sw.template.js", "utf8");
writeFileSync("public/sw.js", serviceWorkerTemplate
  .replaceAll("__FOLIO_BUILD_ID__", JSON.stringify(folioBuildId))
  .replaceAll("__FOLIO_API_GENERATION__", String(apiGeneration))
  .replaceAll("__FOLIO_MIN_SUPPORTED_GENERATION__", String(minSupportedGeneration)));

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_FOLIO_BUILD_ID: folioBuildId,
    NEXT_PUBLIC_FOLIO_API_GENERATION: String(apiGeneration),
    NEXT_PUBLIC_FOLIO_MIN_SUPPORTED_GENERATION: String(minSupportedGeneration),
  },
};

export default nextConfig;
