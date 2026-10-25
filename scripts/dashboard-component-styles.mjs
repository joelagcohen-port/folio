export const DASHBOARD_COMPONENT_STYLES = Object.freeze([
  "folio-guided.css",
  "folio-coaching.css",
  "folio-select.css",
  "folio-rental.css",
  "folio-refund.css",
]);

const componentStyleSet = new Set(DASHBOARD_COMPONENT_STYLES);
const linkPattern = /<link\b(?=[^>]*\brel\s*=\s*(?:"stylesheet"|'stylesheet'))(?=[^>]*\bhref\s*=\s*(?:"|')([^"']+)(?:"|'))[^>]*>/gi;

function filenameForReference(reference) {
  let pathname;
  try {
    pathname = new URL(reference, "https://folio.invalid").pathname;
  } catch {
    return null;
  }
  const filename = pathname.split("/").at(-1);
  return componentStyleSet.has(filename) ? filename : null;
}

function styleBlock(filename, css) {
  const safeCss = String(css).replace(/<\/style/gi, "\\3C /style");
  return `<style data-folio-component-style="${filename}">${safeCss}</style>`;
}

/** Revert generated component style blocks to their canonical stylesheet links. */
export function canonicalizeDashboardComponentStyles(html) {
  const seenBlocks = new Map();
  const canonical = String(html).replace(
    /<style\b(?=[^>]*\bdata-folio-component-style\s*=\s*(?:"|')([^"']+)(?:"|'))[^>]*>[\s\S]*?<\/style\s*>/gi,
    (block, filename) => {
      if (!componentStyleSet.has(filename)) return block;
      seenBlocks.set(filename, (seenBlocks.get(filename) || 0) + 1);
      return `<link rel="stylesheet" href="/${filename}">`;
    },
  );
  for (const filename of seenBlocks.keys()) {
    let references = 0;
    for (const [, href] of canonical.matchAll(linkPattern)) {
      if (filenameForReference(href) === filename) references++;
    }
    assertExactlyOne(Array.from({ length: references }), filename);
  }
  return canonical;
}

function assertExactlyOne(matches, filename) {
  if (matches.length !== 1) {
    throw new Error(`Expected one canonical stylesheet reference for ${filename}, found ${matches.length}`);
  }
}

/** Replace known stylesheet links in place using the corresponding CSS source. */
export function embedDashboardComponentStyles(html, cssByFilename) {
  const canonical = canonicalizeDashboardComponentStyles(html);
  const counts = new Map(DASHBOARD_COMPONENT_STYLES.map(filename => [filename, 0]));
  const embedded = canonical.replace(linkPattern, (tag, reference) => {
    const filename = filenameForReference(reference);
    if (!filename) return tag;
    counts.set(filename, counts.get(filename) + 1);
    if (!(filename in cssByFilename)) throw new Error(`Missing dashboard CSS source: ${filename}`);
    return styleBlock(filename, cssByFilename[filename]);
  });
  for (const filename of DASHBOARD_COMPONENT_STYLES) {
    assertExactlyOne(Array.from({ length: counts.get(filename) }), filename);
  }
  return embedded;
}
