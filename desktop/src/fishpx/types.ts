export const STATE_VERSION = 2;

export type FishSpecies = "goldie" | "ember" | "moss" | "ghost" | "neon";

export type TankItemKind =
  | "kelp"
  | "plant"
  | "rock"
  | "ruin"
  | "shell"
  | "coral"
  | "bubbler";

export interface FishState {
  id: string;
  species: FishSpecies;
  name?: string;
  x: number;
  y: number;
  z: number;
  direction: -1 | 1;
  size: number;
  growth: number;
  hunger: number;
  ageSeconds: number;
  lifeSeconds: number;
  foodEaten: number;
  seed: number;
}

export interface TankItemState {
  id: string;
  kind: TankItemKind;
  x: number;
  y: number;
  z: number;
  scale: number;
  variant: number;
}

export interface FoodPelletState {
  id: string;
  x: number;
  y: number;
  z: number;
  ageSeconds: number;
  value: number;
}

export interface FishTankState {
  version: typeof STATE_VERSION;
  updatedAt: number;
  foodAvailable: number;
  fullLighting: boolean;
  fish: FishState[];
  items: TankItemState[];
  food: FoodPelletState[];
}

export type FishTankChangeReason =
  | "state:set"
  | "fish:add"
  | "item:add"
  | "item:remove"
  | "food:grant"
  | "food:drop"
  | "food:eaten"
  | "fish:death"
  | "light:set"
  | "plant:eaten";

export type FishTankChangeListener = (
  state: FishTankState,
  reason: FishTankChangeReason,
) => void;

export type AddFishInput = Partial<Omit<FishState, "seed">> & {
  seed?: number;
};

export type AddTankItemInput = Partial<TankItemState> & {
  kind: TankItemKind;
};

export interface FishTankOptions {
  seed?: string | number;
  state?: FishTankState;
  width?: number | string;
  height?: number | string;
  fullLighting?: boolean;
  autoplay?: boolean;
  onStateChange?: FishTankChangeListener;
}

export interface FishTankApi {
  setState(state: FishTankState): void;
  getState(): FishTankState;
  addFish(input?: AddFishInput): FishState;
  addItem(input: AddTankItemInput): TankItemState;
  removeItem(id: string): boolean;
  grantFood(count: number): number;
  feedAt(x: number, y: number): boolean;
  dropFoodBurst(maxCount?: number): number;
  tapAt(x: number, y: number): void;
  setFullLighting(enabled: boolean): void;
  setSize(width?: number | string, height?: number | string): void;
  onStateChange(listener: FishTankChangeListener): () => void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

declare global {
  interface Window {
    FishPx?: {
      createFishTank: (
        container: HTMLElement | string,
        options?: FishTankOptions,
      ) => FishTankApi;
      createSeededDemoState: (seed?: string | number) => FishTankState;
    };
    fishTank?: FishTankApi;
  }
}
