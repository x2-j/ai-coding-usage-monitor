import type { FishSpecies, TankItemKind } from "./types.js";

const SVG_NS = "http://www.w3.org/2000/svg";

type SvgAttrs = Record<string, string | number | boolean | undefined>;

export function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: SvgAttrs = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  setAttrs(node, attrs);
  return node;
}

export function setAttrs(node: Element, attrs: SvgAttrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }
    node.setAttribute(key, String(value));
  }
}

export function pixelRect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
): SVGRectElement {
  return svgEl("rect", { x, y, width, height, fill });
}

const fishPalettes: Record<
  FishSpecies,
  { body: string; light: string; shade: string; fin: string; eye: string }
> = {
  goldie: {
    body: "#f49b34",
    light: "#ffd166",
    shade: "#b94d2b",
    fin: "#ff6b35",
    eye: "#17161f",
  },
  ember: {
    body: "#e85d75",
    light: "#ff9aa8",
    shade: "#8d2748",
    fin: "#ffbf69",
    eye: "#17161f",
  },
  moss: {
    body: "#49a078",
    light: "#9ee493",
    shade: "#216869",
    fin: "#2f6f6d",
    eye: "#17161f",
  },
  ghost: {
    body: "#bfd7ea",
    light: "#eff7ff",
    shade: "#6d9dc5",
    fin: "#98c1d9",
    eye: "#242038",
  },
  neon: {
    body: "#2ec4b6",
    light: "#cbf3f0",
    shade: "#2b7a78",
    fin: "#ff9f1c",
    eye: "#17161f",
  },
};

export interface FishArt {
  root: SVGGElement;
  tail: SVGGElement;
}

export function createFishArt(species: FishSpecies): FishArt {
  const palette = fishPalettes[species];
  const root = svgEl("g", {
    class: "pixel-art fishpx-fish",
    "data-species": species,
  });
  const shadow = svgEl("g", { opacity: 0.32 });
  const tail = svgEl("g", { class: "fishpx-tail" });
  const body = svgEl("g");

  shadow.append(
    pixelRect(3, 7, 9, 1, "#06262e"),
    pixelRect(5, 8, 5, 1, "#06262e"),
  );

  tail.append(
    pixelRect(0, 3, 2, 1, palette.fin),
    pixelRect(1, 4, 3, 2, palette.fin),
    pixelRect(0, 6, 2, 1, palette.shade),
    pixelRect(2, 5, 2, 1, palette.light),
  );

  body.append(
    pixelRect(3, 3, 8, 4, palette.body),
    pixelRect(5, 2, 5, 1, palette.light),
    pixelRect(4, 7, 6, 1, palette.shade),
    pixelRect(10, 4, 3, 3, palette.body),
    pixelRect(11, 3, 2, 1, palette.light),
    pixelRect(13, 5, 1, 1, palette.shade),
    pixelRect(6, 8, 2, 1, palette.fin),
    pixelRect(7, 4, 1, 1, palette.light),
    pixelRect(12, 4, 1, 1, palette.eye),
  );

  root.append(shadow, tail, body);
  return { root, tail };
}

export function createFoodArt(): SVGGElement {
  const root = svgEl("g", { class: "pixel-art fishpx-food" });
  root.append(
    pixelRect(0, 0, 2, 2, "#f6d365"),
    pixelRect(2, 0, 1, 1, "#fff4a3"),
    pixelRect(1, 2, 2, 1, "#c9822b"),
  );
  return root;
}

export function createItemArt(kind: TankItemKind, variant: number): SVGGElement {
  const root = svgEl("g", {
    class: "pixel-art fishpx-item",
    "data-kind": kind,
  });

  switch (kind) {
    case "kelp":
      root.append(...createKelp(variant));
      break;
    case "plant":
      root.append(...createPlant(variant));
      break;
    case "rock":
      root.append(...createRock());
      break;
    case "ruin":
      root.append(...createRuin());
      break;
    case "shell":
      root.append(...createShell());
      break;
    case "coral":
      root.append(...createCoral());
      break;
    case "bubbler":
      root.append(...createBubbler());
      break;
  }

  return root;
}

function createPlant(variant: number): SVGRectElement[] {
  const leaf = variant % 2 === 0 ? "#5ec96f" : "#6bd18f";
  const light = variant % 2 === 0 ? "#b7ef73" : "#c8f59a";
  const shade = variant % 2 === 0 ? "#26734d" : "#2f7f5f";
  return [
    pixelRect(13, 24, 7, 6, "#17453a"),
    pixelRect(15, 12, 3, 16, shade),
    pixelRect(10, 17, 5, 4, leaf),
    pixelRect(7, 13, 5, 4, light),
    pixelRect(18, 18, 5, 4, leaf),
    pixelRect(22, 14, 5, 4, light),
    pixelRect(14, 8, 4, 5, light),
    pixelRect(17, 9, 3, 8, shade),
    pixelRect(11, 25, 11, 3, "#22604f"),
  ];
}

function createKelp(variant: number): SVGRectElement[] {
  const colors = ["#226f54", "#2c9f72", "#8bd450"] as const;
  const colorAt = (index: number): string => colors[index % colors.length] ?? "#226f54";
  const offset = variant % 3;
  return [
    pixelRect(14, 9, 4, 19, colorAt(offset + 0)),
    pixelRect(10, 14, 4, 4, colorAt(offset + 1)),
    pixelRect(18, 18, 5, 4, colorAt(offset + 2)),
    pixelRect(8, 24, 7, 4, colorAt(offset + 2)),
    pixelRect(18, 7, 4, 8, colorAt(offset + 1)),
    pixelRect(21, 11, 5, 4, colorAt(offset + 0)),
    pixelRect(12, 27, 12, 3, "#16453f"),
  ];
}

function createRock(): SVGRectElement[] {
  return [
    pixelRect(6, 21, 20, 7, "#586f7c"),
    pixelRect(9, 16, 15, 5, "#78909c"),
    pixelRect(13, 12, 8, 4, "#9fb3bd"),
    pixelRect(7, 26, 18, 3, "#30444d"),
    pixelRect(16, 18, 6, 3, "#3f5964"),
  ];
}

function createRuin(): SVGRectElement[] {
  return [
    pixelRect(5, 25, 23, 4, "#64748b"),
    pixelRect(7, 11, 5, 14, "#94a3b8"),
    pixelRect(20, 11, 5, 14, "#94a3b8"),
    pixelRect(6, 8, 20, 4, "#cbd5e1"),
    pixelRect(8, 14, 3, 2, "#475569"),
    pixelRect(21, 16, 3, 2, "#475569"),
    pixelRect(13, 20, 6, 5, "#334155"),
    pixelRect(5, 28, 23, 2, "#334155"),
  ];
}

function createShell(): SVGRectElement[] {
  return [
    pixelRect(8, 22, 16, 6, "#f4a261"),
    pixelRect(10, 18, 12, 4, "#ffd6a5"),
    pixelRect(12, 14, 8, 4, "#f9c74f"),
    pixelRect(14, 11, 4, 3, "#ffe8c2"),
    pixelRect(11, 23, 2, 5, "#bc6c25"),
    pixelRect(16, 20, 2, 8, "#bc6c25"),
    pixelRect(21, 23, 2, 5, "#bc6c25"),
  ];
}

function createCoral(): SVGRectElement[] {
  return [
    pixelRect(14, 14, 4, 15, "#ef476f"),
    pixelRect(9, 18, 5, 4, "#ff7a90"),
    pixelRect(8, 14, 4, 4, "#ff7a90"),
    pixelRect(18, 21, 6, 4, "#d23f69"),
    pixelRect(23, 17, 4, 4, "#d23f69"),
    pixelRect(15, 10, 4, 4, "#ff9fb0"),
    pixelRect(12, 28, 10, 2, "#7d2d44"),
  ];
}

function createBubbler(): SVGRectElement[] {
  return [
    pixelRect(9, 24, 15, 5, "#334155"),
    pixelRect(12, 20, 9, 4, "#64748b"),
    pixelRect(15, 14, 3, 6, "#94a3b8"),
    pixelRect(13, 12, 7, 2, "#cbd5e1"),
    pixelRect(20, 8, 3, 3, "#bde0fe"),
    pixelRect(12, 5, 2, 2, "#bde0fe"),
    pixelRect(18, 2, 2, 2, "#eff7ff"),
  ];
}
