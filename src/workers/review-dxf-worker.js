import { decodeDxfFile } from "../shared/dxf-encoding.js";

function records(sectionText) {
  const result = [], lines = sectionText.split("\n");
  let current = null;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index].trim(), value = lines[index + 1].trim();
    if (code === "0") {
      if (current) result.push(current);
      current = {type: value, map: new Map()};
      continue
    }
    if (!current) continue;
    if (!current.map.has(code)) current.map.set(code, []);
    current.map.get(code).push(value)
  }
  if (current) result.push(current);
  return result
}

const numberValue = (map, code, fallback = 0) => Number(map.get(code)?.[0]) || fallback;

function textItem(record, transform = point => point) {
  if (!["TEXT", "MTEXT", "ATTRIB", "ATTDEF"].includes(record.type)) return null;
  const map = record.map, text = [...(map.get("3") || []), ...(map.get("1") || [])].join("").trim();
  if (!text) return null;
  const point = transform({x: numberValue(map, "10"), y: numberValue(map, "20")});
  const height = numberValue(map, "40", 3);
  return {text, page: 1, x: point.x, y: point.y, w: Math.max(8, text.length * Math.max(height, 1) * .6), h: Math.max(4, height)}
}

function section(text, name) {
  const pattern = new RegExp(`^[ \\t]*0[ \\t]*\\nSECTION\\n[ \\t]*2[ \\t]*\\n${name}\\n([\\s\\S]*?)^[ \\t]*0[ \\t]*\\nENDSEC`, "m");
  return text.match(pattern)?.[1] || ""
}

function blockDefinitions(blockSection) {
  const blocks = new Map();
  let current = null;
  for (const record of records(blockSection)) {
    if (record.type === "BLOCK") {
      const name = record.map.get("2")?.[0];
      current = name ? {name, base: {x: numberValue(record.map, "10"), y: numberValue(record.map, "20")}, records: []} : null
    } else if (record.type === "ENDBLK") {
      if (current) blocks.set(current.name, {base: current.base, records: current.records});
      current = null
    } else if (current) current.records.push(record)
  }
  return blocks
}

function insertTransform(record, definition, parentTransform) {
  const map = record.map, origin = {x: numberValue(map, "10"), y: numberValue(map, "20")};
  const scaleX = numberValue(map, "41", 1), scaleY = numberValue(map, "42", 1), angle = numberValue(map, "50") * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return point => {
    const x = (point.x - definition.base.x) * scaleX, y = (point.y - definition.base.y) * scaleY;
    return parentTransform({x: origin.x + cos * x - sin * y, y: origin.y + sin * x + cos * y})
  }
}

function expandInsert(record, blocks, output, ancestry = new Set(), parentTransform = point => point) {
  const map = record.map, blockName = map.get("2")?.[0], definition = blocks.get(blockName);
  if (!definition || ancestry.has(blockName)) return;
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(blockName);
  const transform = insertTransform(record, definition, parentTransform);
  for (const child of definition.records) {
    const item = textItem(child, transform);
    if (item) output.push(item);
    else if (child.type === "INSERT") expandInsert(child, blocks, output, nextAncestry, transform)
  }
}

export function extractTextItems(text) {
  const normalized = text.replace(/\r/g, ""), entityRecords = records(section(normalized, "ENTITIES"));
  const blocks = blockDefinitions(section(normalized, "BLOCKS")), textItems = [];
  for (const record of entityRecords) {
    const item = textItem(record);
    if (item) textItems.push(item);
    else if (record.type === "INSERT") expandInsert(record, blocks, textItems)
  }
  return {textItems, blockCount: blocks.size}
}

if (typeof self !== "undefined") self.onmessage = async event => {
  try {
    const {text, codepage} = await decodeDxfFile(event.data.file);
    const {textItems, blockCount} = extractTextItems(text);
    self.postMessage({
      codepage,
      drawingText: textItems.map(item => item.text).join("\n"),
      preview: {
        type: "dxf",
        bounds: {minX: 0, minY: 0, maxX: 100, maxY: 100},
        textItems,
        blockCount
      }
    })
  } catch (error) {
    self.postMessage({error: error instanceof Error ? error.message : String(error)})
  }
};
