import { Random, seedStream } from "./rng.js";

export interface SceneTheme {
  waterTop: string;
  waterMid: string;
  waterBottom: string;
  hazeLight: string;
  hazeMid: string;
  hazeDeep: string;
  sandTop: string;
  sandShadow: string;
  pebbleA: string;
  pebbleB: string;
  causticA: string;
  causticB: string;
  rayA: string;
  rayB: string;
  rayC: string;
  sandBackY: number;
  sandMidY: number;
  sandFrontY: number;
  sandWaveA: number;
  sandWaveB: number;
  pebbleOffset: number;
  causticOffset: number;
}

const waterPalettes = [
  ["#6edff0", "#197b8a", "#063844"],
  ["#7cc7ff", "#226f8f", "#0a3349"],
  ["#70e0c3", "#1b7b75", "#073a3d"],
  ["#82d8f7", "#2a7898", "#08364e"],
] as const;

const sandPalettes = [
  ["#d9b779", "#a9784e", "#8d99ae", "#d7b377"],
  ["#c7aa78", "#8c6c52", "#79828b", "#c2b17c"],
  ["#dfc48b", "#9b7651", "#7f8a93", "#e0c987"],
  ["#bfa57d", "#7e6657", "#87969c", "#ccb982"],
] as const;

export function createSceneTheme(seed: string | number): SceneTheme {
  const rng = new Random(seedStream(seed, "scene"));
  const water = rng.pick(waterPalettes);
  const sand = rng.pick(sandPalettes);
  return {
    waterTop: shiftColor(water[0], rng.range(-4, 8)),
    waterMid: shiftColor(water[1], rng.range(-5, 5)),
    waterBottom: shiftColor(water[2], rng.range(-3, 4)),
    hazeLight: shiftColor("#d7fbff", rng.range(-3, 6)),
    hazeMid: shiftColor("#6edce8", rng.range(-6, 6)),
    hazeDeep: shiftColor(water[2], rng.range(-2, 5)),
    sandTop: shiftColor(sand[0], rng.range(-8, 8)),
    sandShadow: shiftColor(sand[1], rng.range(-8, 7)),
    pebbleA: shiftColor(sand[2], rng.range(-6, 6)),
    pebbleB: shiftColor(sand[3], rng.range(-8, 8)),
    causticA: shiftColor("#d8fdff", rng.range(-5, 4)),
    causticB: shiftColor("#9ce8eb", rng.range(-5, 5)),
    rayA: shiftColor("#eff7ff", rng.range(-4, 4)),
    rayB: shiftColor("#ffffff", rng.range(-5, 0)),
    rayC: shiftColor("#b7f7f9", rng.range(-6, 6)),
    sandBackY: rng.range(496, 520),
    sandMidY: rng.range(514, 544),
    sandFrontY: rng.range(552, 579),
    sandWaveA: rng.range(13, 29),
    sandWaveB: rng.range(6, 19),
    pebbleOffset: rng.int(0, 960),
    causticOffset: rng.int(-80, 80),
  };
}

function shiftColor(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const red = parseInt(clean.slice(0, 2), 16);
  const green = parseInt(clean.slice(2, 4), 16);
  const blue = parseInt(clean.slice(4, 6), 16);
  return `#${toHex(red + amount)}${toHex(green + amount)}${toHex(blue + amount)}`;
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}
