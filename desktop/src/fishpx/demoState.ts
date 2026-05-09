import { Random, seedStream } from "./rng.js";
import {
  STATE_VERSION,
  type FishSpecies,
  type FishTankState,
  type TankItemKind,
} from "./types.js";

const species: readonly FishSpecies[] = ["goldie", "moss", "ember", "ghost", "neon"];
const decor: readonly TankItemKind[] = ["kelp", "plant", "rock", "ruin", "shell", "coral", "bubbler"];

export function createSeededDemoState(seed: string | number = "fishpx-demo"): FishTankState {
  const rng = new Random(seedStream(seed, "state"));
  const fishCount = rng.int(3, 7);
  const itemCount = rng.int(5, 10);
  const plantCount = rng.int(1, 4);
  const itemKinds = seededItemKinds(rng, itemCount, plantCount);

  return {
    version: STATE_VERSION,
    updatedAt: Date.now(),
    foodAvailable: rng.int(4, 14),
    fullLighting: false,
    fish: Array.from({ length: fishCount }, (_, index) => {
      const fishSpecies = rng.pick(species);
      const lifeSeconds = rng.range(30 * 60, 90 * 60);
      return {
      id: `demo-fish-${index + 1}`,
      species: fishSpecies,
      x: rng.range(0.16, 0.84),
      y: rng.range(0.18, 0.68),
      z: rng.range(0.22, 0.92),
      direction: rng.next() > 0.5 ? 1 : -1,
      size: rng.range(0.76, 1.05),
      growth: rng.range(0, 0.12),
      hunger: rng.range(0.08, 0.38),
      ageSeconds: rng.range(45, 420),
      lifeSeconds,
      foodEaten: rng.int(0, 8),
      seed: rng.int(1, 100000),
      };
    }),
    items: itemKinds.map((kind, index) => ({
      id: `demo-item-${index + 1}`,
      kind,
      x: seededItemX(index, itemKinds.length, rng),
      y: 0.84,
      z: rng.range(0.12, 0.86),
      scale: kind === "plant" ? rng.range(0.62, 1.12) : rng.range(0.7, 1.2),
      variant: rng.int(0, 9),
    })),
    food: [],
  };
}

function seededItemKinds(
  rng: Random,
  itemCount: number,
  plantCount: number,
): TankItemKind[] {
  const kinds: TankItemKind[] = [];
  for (let index = 0; index < plantCount; index += 1) {
    kinds.push("plant");
  }
  while (kinds.length < itemCount) {
    kinds.push(rng.pick(decor));
  }
  return shuffle(kinds, rng);
}

function seededItemX(index: number, count: number, rng: Random): number {
  const spacing = 0.82 / Math.max(count - 1, 1);
  return clamp(0.09 + index * spacing + rng.range(-0.035, 0.035), 0.06, 0.94);
}

function shuffle<T>(items: T[], rng: Random): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = rng.int(0, index);
    const current = items[index];
    const swap = items[swapIndex];
    if (current !== undefined && swap !== undefined) {
      items[index] = swap;
      items[swapIndex] = current;
    }
  }
  return items;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
