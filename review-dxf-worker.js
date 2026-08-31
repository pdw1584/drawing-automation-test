import { decodeDxfFile } from "./dxf-encoding.js";

self.onmessage = async event => {
  try {
    const {text, codepage} = await decodeDxfFile(event.data.file);
    const textItems = [], drawingText = [];
    const entityPattern = /^0\r?\n(?:TEXT|MTEXT|ATTRIB|ATTDEF)\r?\n([\s\S]*?)(?=^0\r?\n)/gm;
    for (const match of text.matchAll(entityPattern)) {
      const lines = match[1].replace(/\r/g, "").split("\n");
      let x = 0, y = 0, height = 3;
      const fragments = [];
      for (let index = 0; index + 1 < lines.length; index += 2) {
        const code = lines[index].trim(), value = lines[index + 1].trim();
        if (code === "1" || code === "3") fragments.push(value);
        else if (code === "10") x = Number(value) || 0;
        else if (code === "20") y = Number(value) || 0;
        else if (code === "40") height = Number(value) || 3
      }
      const value = fragments.join("").trim();
      if (!value) continue;
      drawingText.push(value);
      textItems.push({
        text: value,
        page: 1,
        x,
        y,
        w: Math.max(8, value.length * Math.max(height, 1) * .6),
        h: Math.max(4, height)
      })
    }
    self.postMessage({
      codepage,
      drawingText: drawingText.join("\n"),
      preview: {
        type: "dxf",
        bounds: {minX: 0, minY: 0, maxX: 100, maxY: 100},
        textItems,
        blockCount: 0
      }
    })
  } catch (error) {
    self.postMessage({error: error instanceof Error ? error.message : String(error)})
  }
};
