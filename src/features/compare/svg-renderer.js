import {distance} from "./engine.js";
import {escapeHtml} from "../../shared/ui-utils.js";

function arcPath(entity) {
  const center = entity.points[0] || {x: 0, y: 0}, radius = entity.radius || 1,
    start = (entity.startAngle || 0) * Math.PI / 180, end = (entity.endAngle || 0) * Math.PI / 180,
    delta = ((entity.endAngle || 0) - (entity.startAngle || 0) + 360) % 360,
    x1 = center.x + radius * Math.cos(start), y1 = -(center.y + radius * Math.sin(start)),
    x2 = center.x + radius * Math.cos(end), y2 = -(center.y + radius * Math.sin(end));
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${delta > 180 ? 1 : 0} 0 ${x2} ${y2}`
}

function polylinePath(entity) {
  if (!entity.points.length) return "";
  const points = entity.closed ? [...entity.points, entity.points[0]] : entity.points;
  let path = `M ${points[0].x} ${-points[0].y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index], end = points[index + 1], bulge = start.bulge || 0;
    if (Math.abs(bulge) < 1e-9) path += ` L ${end.x} ${-end.y}`;
    else {
      const chord = Math.hypot(end.x - start.x, end.y - start.y), radius = chord * (1 + bulge * bulge) / (4 * Math.abs(bulge)), angle = 4 * Math.atan(Math.abs(bulge));
      path += ` A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} ${bulge > 0 ? 0 : 1} ${end.x} ${-end.y}`
    }
  }
  return path
}

function dimensionSvg(entity, attributes) {
  const points = entity.points;
  if (points.length < 3) return `<circle ${attributes} cx="${points[0]?.x||0}" cy="${-(points[0]?.y||0)}" r="1.5"/>`;
  const definition = points[0], first = points.at(-2), second = points.at(-1), size = Math.max(distance(first, second) * .025, 1);
  return `<g ${attributes}><line x1="${first.x}" y1="${-first.y}" x2="${second.x}" y2="${-second.y}"/><line x1="${first.x}" y1="${-first.y}" x2="${definition.x}" y2="${-definition.y}"/><line x1="${second.x}" y1="${-second.y}" x2="${definition.x}" y2="${-definition.y}"/><circle cx="${first.x}" cy="${-first.y}" r="${size}"/><circle cx="${second.x}" cy="${-second.y}" r="${size}"/></g>`
}

/** 엔티티와 변경 결과만 입력받아 SVG 문자열을 만드는 상태 비의존 렌더러다. */
export function entitySvg(entity, index, side, diffs = []) {
  const classes = ["entity", ["TEXT", "MTEXT"].includes(entity.type) ? "text" : ""];
  const difference = diffs.find(item => (side === "old" ? item.oldIndex : item.newIndex) === index);
  if (difference) classes.push(`diff-${difference.kind}`);
  const attributes = `class="${classes.join(" ")}" data-index="${index}"`;
  if (entity.type === "LINE") return `<line ${attributes} x1="${entity.points[0]?.x||0}" y1="${-(entity.points[0]?.y||0)}" x2="${entity.points[1]?.x||0}" y2="${-(entity.points[1]?.y||0)}"/>`;
  if (entity.type === "CIRCLE") return `<circle ${attributes} cx="${entity.points[0]?.x||0}" cy="${-(entity.points[0]?.y||0)}" r="${entity.radius||1}"/>`;
  if (entity.type === "ARC") return `<path ${attributes} d="${arcPath(entity)}"/>`;
  if (["TEXT", "MTEXT"].includes(entity.type)) return `<text ${attributes} x="${entity.points[0]?.x||0}" y="${-(entity.points[0]?.y||0)}" font-size="${entity.height||3}" transform="rotate(${-(entity.rotation||0)} ${entity.points[0]?.x||0} ${-(entity.points[0]?.y||0)})">${escapeHtml(entity.text||"")}</text>`;
  if (entity.type === "DIMENSION") return dimensionSvg(entity, attributes);
  if (["POINT", "INSERT"].includes(entity.type)) return `<circle ${attributes} cx="${entity.points[0]?.x||0}" cy="${-(entity.points[0]?.y||0)}" r="1.4"/>`;
  return `<path ${attributes} d="${polylinePath(entity)}"/>`
}
