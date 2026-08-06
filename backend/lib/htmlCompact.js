import * as cheerio from "cheerio";

const KEEP_ATTRIBUTES = [
  "id",
  "href",
  "placeholder",
  "value",
  "name",
  "aria-label",
  "role",
  "class",
];

// Strips markup that costs tokens but carries no user-visible text or data.
export function dropTokenWaste(rawHtml) {
  if (!rawHtml) return "";
  const $ = cheerio.load(rawHtml);

  // 1. Instantly shred layout weight that doesn't contain user text or data
  $(
    "script, style, svg, path, link, noscript, iframe, head, footer, header, nav",
  ).remove();

  // 2. Erase non-essential tracker attributes but keep data identifiers intact
  $("*").each((_, element) => {
    const attribs = element.attribs || {};
    Object.keys(attribs).forEach((attr) => {
      if (!KEEP_ATTRIBUTES.includes(attr)) {
        $(element).removeAttr(attr);
      }
    });
  });

  // 3. Compress multiple line spaces into a single space
  return $.html().replace(/\s+/g, " ").trim();
}
