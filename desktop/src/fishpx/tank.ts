import {
  STATE_VERSION,
  type AddFishInput,
  type AddTankItemInput,
  type FishSpecies,
  type FishState,
  type FishTankApi,
  type FishTankChangeListener,
  type FishTankChangeReason,
  type FishTankOptions,
  type FishTankState,
  type FoodPelletState,
  type TankItemKind,
  type TankItemState,
} from "./types.js";
import { Random } from "./rng.js";
import { createSceneTheme, type SceneTheme } from "./sceneTheme.js";
import {
  createFishArt,
  createFoodArt,
  createItemArt,
  pixelRect,
  setAttrs,
  svgEl,
} from "./pixelArt.js";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 614.4;
const FISH_SPECIES: readonly FishSpecies[] = [
  "goldie",
  "ember",
  "moss",
  "ghost",
  "neon",
];
const ITEM_KINDS: readonly TankItemKind[] = [
  "kelp",
  "plant",
  "rock",
  "ruin",
  "shell",
  "coral",
  "bubbler",
];
const PASSIVE_GROWTH_PER_SECOND = 0.00000007;
const FOOD_GROWTH = 0.012;
const HUNGER_PER_SECOND = 0.00018;
const PELLET_SINK_PER_SECOND = 0.055;
const PELLET_MAX_AGE_SECONDS = 360;
const FISH_MIN_Y = 0.1;
const FISH_MAX_Y = 0.865;
const FISH_MIN_LIFE_SECONDS = 4 * 60 * 60;
const FISH_MAX_LIFE_SECONDS = 12 * 60 * 60;
const PLANT_MIN_SCALE = 0.48;
const PLANT_MAX_SCALE = 1.55;
const PLANT_GROWTH_PER_SECOND = 0.00075;
const PLANT_EAT_HUNGER = 0.62;
const PLANT_BITE_SIZE = 0.035;
const ITEM_DROP_PER_SECOND = 0.18;

interface FishNode {
  root: SVGGElement;
  tail: SVGGElement;
  fish: FishState;
  targetX: number;
  targetY: number;
  targetZ: number;
  targetFoodId: string | undefined;
  targetPlantId: string | undefined;
  nextWanderAt: number;
  panicUntil: number;
  speed: number;
}

interface ItemNode {
  root: SVGGElement;
  item: TankItemState;
}

interface PelletNode {
  root: SVGGElement;
  pellet: FoodPelletState;
  drift: number;
}

interface BubbleNode {
  root: SVGCircleElement;
  x: number;
  y: number;
  z: number;
  radius: number;
  speed: number;
  phase: number;
}

type SortableEntity = {
  root: SVGGElement;
  z: number;
  y: number;
};

interface LightingProfile {
  tint: string;
  tintOpacity: number;
  glow: string;
  glowOpacity: number;
  raysOpacity: number;
  causticsOpacity: number;
  brightness: number;
  saturation: number;
  activity: number;
  bottomBias: number;
  schooling: number;
}

export class FishTank implements FishTankApi {
  private readonly rng: Random;
  private readonly scene: SceneTheme;
  private readonly container: HTMLElement;
  private readonly host: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly causticLayer: SVGGElement;
  private readonly lightLayer: SVGGElement;
  private readonly entityLayer: SVGGElement;
  private readonly bubbleLayer: SVGGElement;
  private readonly glassEffectLayer: SVGGElement;
  private readonly lightingLayer: SVGGElement;
  private readonly timeTint: SVGRectElement;
  private readonly timeGlow: SVGRectElement;
  private readonly fishNodes = new Map<string, FishNode>();
  private readonly itemNodes = new Map<string, ItemNode>();
  private readonly pelletNodes = new Map<string, PelletNode>();
  private readonly bubbles: BubbleNode[] = [];
  private readonly listeners = new Set<FishTankChangeListener>();
  private state: FishTankState;
  private lighting = lightingProfile(new Date(), false);
  private frameId = 0;
  private foodBurstTimer = 0;
  private queuedFoodDrops = 0;
  private foodBurstAverageDelayMs = 0;
  private lastLightingUpdate = Number.NEGATIVE_INFINITY;
  private lastFrameAt = 0;
  private paused = true;
  private disposed = false;

  constructor(container: HTMLElement, options: FishTankOptions = {}) {
    const seed = options.seed ?? "fishpx";
    this.rng = new Random(`${String(seed)}:runtime`);
    this.scene = createSceneTheme(seed);
    this.container = container;
    this.host = document.createElement("div");
    this.host.className = "fishpx-host";
    this.applyDimensions(options.width, options.height);
    this.svg = svgEl("svg", {
      class: "fishpx-stage",
      viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
      preserveAspectRatio: "xMidYMid meet",
      role: "img",
      "aria-label": "Pixel fish tank",
    });
    this.causticLayer = svgEl("g", { class: "fishpx-caustics" });
    this.lightLayer = svgEl("g", { class: "fishpx-light-rays" });
    this.entityLayer = svgEl("g", { class: "fishpx-entities" });
    this.bubbleLayer = svgEl("g", { class: "fishpx-bubbles" });
    this.glassEffectLayer = svgEl("g", { class: "fishpx-glass-effects" });
    this.lightingLayer = svgEl("g", { class: "fishpx-time-lighting" });
    this.timeGlow = svgEl("rect", {
      x: 0,
      y: 0,
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      fill: "#ffffff",
      opacity: 0,
    });
    this.timeTint = svgEl("rect", {
      x: 0,
      y: 0,
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      fill: "#091f35",
      opacity: 0,
    });
    this.state = this.emptyState();

    if (options.onStateChange) {
      this.listeners.add(options.onStateChange);
    }

    this.buildScene();
    this.host.append(this.svg);
    this.container.replaceChildren(this.host);
    this.svg.addEventListener("pointerdown", this.handlePointerDown);
    this.setState(options.state ?? this.emptyState());
    if (options.fullLighting !== undefined) {
      this.setFullLighting(options.fullLighting);
    }

    if (options.autoplay !== false) {
      this.resume();
    }
  }

  setState(state: FishTankState): void {
    this.clearFoodBurst();
    this.state = this.normalizeState(state);
    this.rebuildEntities();
    this.updateLighting(true);
    this.dropFoodBurst();
    this.emit("state:set");
  }

  getState(): FishTankState {
    return cloneState({ ...this.state, updatedAt: Date.now() });
  }

  addFish(input: AddFishInput = {}): FishState {
    const fish = this.makeFish(input);
    this.state.fish.push(fish);
    this.fishNodes.set(fish.id, this.createFishNode(fish));
    this.render(0);
    this.emit("fish:add");
    return { ...fish };
  }

  addItem(input: AddTankItemInput): TankItemState {
    const item = this.makeItem(input);
    this.state.items.push(item);
    this.itemNodes.set(item.id, this.createItemNode(item));
    this.render(0);
    this.emit("item:add");
    return { ...item };
  }

  removeItem(id: string): boolean {
    const index = this.state.items.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }
    this.state.items.splice(index, 1);
    const node = this.itemNodes.get(id);
    node?.root.remove();
    this.itemNodes.delete(id);
    this.emit("item:remove");
    return true;
  }

  grantFood(count: number): number {
    const safeCount = Math.max(0, Math.floor(count));
    this.state.foodAvailable = clamp(
      this.state.foodAvailable + safeCount,
      0,
      9999,
    );
    this.emit("food:grant");
    this.dropFoodBurst();
    return this.state.foodAvailable;
  }

  feedAt(x: number, y: number): boolean {
    return this.dropFoodAt(x, y);
  }

  dropFoodBurst(maxCount = this.state.foodAvailable): number {
    const count = Math.max(0, Math.min(Math.floor(maxCount), this.state.foodAvailable));
    if (count === 0) {
      return count;
    }

    this.queuedFoodDrops += count;
    if (this.foodBurstTimer !== 0) {
      this.foodBurstAverageDelayMs = Math.min(
        this.foodBurstAverageDelayMs,
        foodBurstAverageDelay(count),
      );
      return count;
    }
    this.foodBurstAverageDelayMs = foodBurstAverageDelay(count);

    const dropNext = (): void => {
      this.foodBurstTimer = 0;
      if (this.disposed || this.queuedFoodDrops <= 0 || this.state.foodAvailable <= 0) {
        this.queuedFoodDrops = 0;
        return;
      }

      this.queuedFoodDrops -= 1;
      this.dropFoodAt(this.rng.range(0.08, 0.92), this.rng.range(0.07, 0.18));

      if (this.queuedFoodDrops > 0 && this.state.foodAvailable > 0) {
        this.foodBurstTimer = window.setTimeout(
          dropNext,
          this.nextFoodBurstDelay(),
        );
      }
    };

    this.foodBurstTimer = window.setTimeout(dropNext, this.firstFoodBurstDelay());
    return count;
  }

  tapAt(x: number, y: number): void {
    const tapX = clamp(x, 0, 1);
    const tapY = clamp(y, 0, 1);
    this.createGlassRipple(tapX, tapY);
    const now = performance.now();

    for (const node of this.fishNodes.values()) {
      const { fish } = node;
      const dx = fish.x - tapX;
      const dy = fish.y - tapY;
      const distance = Math.hypot(dx, dy);
      const scatterRadius = 0.24 + fish.z * 0.08;
      if (distance > scatterRadius) {
        continue;
      }

      const angle = distance < 0.001 ? this.rng.range(0, Math.PI * 2) : Math.atan2(dy, dx);
      const push = this.rng.range(0.18, 0.34) * (1 - distance / scatterRadius);
      node.targetX = clamp(fish.x + Math.cos(angle) * push, 0.07, 0.93);
      node.targetY = clamp(fish.y + Math.sin(angle) * push, FISH_MIN_Y, FISH_MAX_Y);
      node.targetZ = clamp(fish.z + this.rng.range(-0.18, 0.18), 0.12, 0.98);
      node.targetFoodId = undefined;
      node.targetPlantId = undefined;
      node.nextWanderAt = now + this.rng.range(900, 1600);
      node.panicUntil = now + this.rng.range(900, 1450);
    }
  }

  setFullLighting(enabled: boolean): void {
    this.state.fullLighting = enabled;
    this.updateLighting(true);
    this.emit("light:set");
  }

  private dropFoodAt(x: number, y: number): boolean {
    if (this.state.foodAvailable <= 0) {
      this.host.classList.add("is-empty");
      window.setTimeout(() => this.host.classList.remove("is-empty"), 220);
      return false;
    }

    const pellet: FoodPelletState = {
      id: this.rng.id("food"),
      x: clamp(x, 0.04, 0.96),
      y: clamp(y, 0.08, 0.78),
      z: this.rng.range(0.35, 0.96),
      ageSeconds: 0,
      value: 1,
    };
    this.state.foodAvailable -= 1;
    this.state.food.push(pellet);
    this.pelletNodes.set(pellet.id, this.createPelletNode(pellet));
    this.emit("food:drop");
    return true;
  }

  setSize(width?: number | string, height?: number | string): void {
    this.applyDimensions(width, height);
  }

  onStateChange(listener: FishTankChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pause(): void {
    this.paused = true;
    if (this.frameId !== 0) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
  }

  resume(): void {
    if (this.disposed || !this.paused) {
      return;
    }
    this.paused = false;
    this.lastFrameAt = 0;
    this.frameId = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    this.disposed = true;
    this.pause();
    this.clearFoodBurst();
    this.svg.removeEventListener("pointerdown", this.handlePointerDown);
    this.host.remove();
    this.listeners.clear();
  }

  private buildScene(): void {
    const defs = svgEl("defs");
    const waterGradient = svgEl("linearGradient", {
      id: "fishpx-water-gradient",
      x1: "0%",
      x2: "0%",
      y1: "0%",
      y2: "100%",
    });
    waterGradient.append(
      svgEl("stop", { offset: "0%", "stop-color": this.scene.waterTop }),
      svgEl("stop", { offset: "45%", "stop-color": this.scene.waterMid }),
      svgEl("stop", { offset: "100%", "stop-color": this.scene.waterBottom }),
    );

    const hazeGradient = svgEl("linearGradient", {
      id: "fishpx-haze-gradient",
      x1: "0%",
      x2: "100%",
      y1: "0%",
      y2: "100%",
    });
    hazeGradient.append(
      svgEl("stop", { offset: "0%", "stop-color": this.scene.hazeLight, "stop-opacity": 0.22 }),
      svgEl("stop", { offset: "55%", "stop-color": this.scene.hazeMid, "stop-opacity": 0.12 }),
      svgEl("stop", { offset: "100%", "stop-color": this.scene.hazeDeep, "stop-opacity": 0.46 }),
    );

    defs.append(waterGradient, hazeGradient);

    const background = svgEl("g", { class: "fishpx-background" });
    background.append(
      svgEl("rect", {
        x: 0,
        y: 0,
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        fill: "url(#fishpx-water-gradient)",
      }),
      svgEl("rect", {
        class: "fishpx-back-haze",
        x: 0,
        y: 0,
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        fill: "url(#fishpx-haze-gradient)",
      }),
    );

    this.lightLayer.append(
      svgEl("polygon", {
        class: "fishpx-light-ray fishpx-light-ray-one",
        points: `60,0 185,0 420,${VIEW_HEIGHT} 280,${VIEW_HEIGHT}`,
        fill: this.scene.rayA,
        opacity: 0.16,
      }),
      svgEl("polygon", {
        class: "fishpx-light-ray fishpx-light-ray-two",
        points: `515,0 610,0 725,${VIEW_HEIGHT} 610,${VIEW_HEIGHT}`,
        fill: this.scene.rayB,
        opacity: 0.1,
      }),
      svgEl("polygon", {
        class: "fishpx-light-ray fishpx-light-ray-three",
        points: `760,0 900,0 840,${VIEW_HEIGHT} 720,${VIEW_HEIGHT}`,
        fill: this.scene.rayC,
        opacity: 0.11,
      }),
    );

    for (let index = 0; index < 12; index += 1) {
      this.causticLayer.append(
        svgEl("path", {
          d: `M ${this.scene.causticOffset - 80 + index * 96} ${58 + (index % 3) * 19} h 52 l 22 10 h 70`,
          fill: "none",
          stroke: index % 2 === 0 ? this.scene.causticA : this.scene.causticB,
          "stroke-width": 4,
          opacity: 0.2,
        }),
      );
    }

    const backPebbles = svgEl("g", { class: "fishpx-back-pebbles" });
    for (let index = 0; index < 42; index += 1) {
      const x = (this.scene.pebbleOffset + index * 71) % VIEW_WIDTH;
      const y = this.scene.sandMidY + 8 + ((index * 17) % 44);
      const width = 7 + (index % 4) * 3;
      backPebbles.append(
        pixelRect(x, y, width, 4 + (index % 3), index % 2 === 0 ? this.scene.pebbleA : this.scene.pebbleB),
      );
    }

    const sand = svgEl("g", { class: "fishpx-sand" });
    sand.append(
      svgEl("path", {
        d: sandPath(this.scene.sandBackY, this.scene.sandWaveA, this.scene.sandWaveB),
        fill: this.scene.sandTop,
      }),
      svgEl("path", {
        d: sandPath(this.scene.sandFrontY, this.scene.sandWaveB, this.scene.sandWaveA * 0.55),
        fill: this.scene.sandShadow,
        opacity: 0.5,
      }),
    );

    const frontGlass = svgEl("g", { class: "fishpx-front-glass" });
    frontGlass.append(
      svgEl("rect", {
        x: 0,
        y: 0,
        width: VIEW_WIDTH,
        height: VIEW_HEIGHT,
        fill: "url(#fishpx-haze-gradient)",
        opacity: 0.52,
      }),
      svgEl("rect", {
        x: 12,
        y: 12,
        width: VIEW_WIDTH - 24,
        height: VIEW_HEIGHT - 24,
        fill: "none",
        stroke: "#dffcff",
        "stroke-width": 2,
        opacity: 0.32,
      }),
    );
    frontGlass.append(this.glassEffectLayer);
    this.lightingLayer.append(this.timeGlow, this.timeTint);

    this.svg.append(
      defs,
      background,
      this.lightLayer,
      this.causticLayer,
      backPebbles,
      sand,
      this.entityLayer,
      this.bubbleLayer,
      this.lightingLayer,
      frontGlass,
    );

    this.createBubbles();
  }

  private createBubbles(): void {
    for (let index = 0; index < 26; index += 1) {
      const bubble: BubbleNode = {
        root: svgEl("circle", {
          class: "fishpx-bubble",
          fill: "none",
          stroke: "#dffcff",
          "stroke-width": 2,
        }),
        x: this.rng.range(0.05, 0.95),
        y: this.rng.range(0.12, 0.92),
        z: this.rng.range(0.2, 1),
        radius: this.rng.range(2, 6),
        speed: this.rng.range(0.018, 0.06),
        phase: this.rng.range(0, Math.PI * 2),
      };
      this.bubbles.push(bubble);
      this.bubbleLayer.append(bubble.root);
    }
  }

  private rebuildEntities(): void {
    this.entityLayer.replaceChildren();
    this.fishNodes.clear();
    this.itemNodes.clear();
    this.pelletNodes.clear();

    for (const item of this.state.items) {
      this.itemNodes.set(item.id, this.createItemNode(item));
    }
    for (const pellet of this.state.food) {
      this.pelletNodes.set(pellet.id, this.createPelletNode(pellet));
    }
    for (const fish of this.state.fish) {
      this.fishNodes.set(fish.id, this.createFishNode(fish));
    }

    this.render(0);
  }

  private createFishNode(fish: FishState): FishNode {
    const art = createFishArt(fish.species);
    const node: FishNode = {
      root: art.root,
      tail: art.tail,
      fish,
      targetX: this.rng.range(0.12, 0.88),
      targetY: this.rng.range(0.16, 0.72),
      targetZ: this.rng.range(0.22, 0.96),
      targetFoodId: undefined,
      targetPlantId: undefined,
      nextWanderAt: 0,
      panicUntil: 0,
      speed: this.rng.range(0.025, 0.052),
    };
    return node;
  }

  private createItemNode(item: TankItemState): ItemNode {
    return {
      root: createItemArt(item.kind, item.variant),
      item,
    };
  }

  private createPelletNode(pellet: FoodPelletState): PelletNode {
    return {
      root: createFoodArt(),
      pellet,
      drift: this.rng.range(-0.02, 0.02),
    };
  }

  private tick = (time: number): void => {
    if (this.disposed || this.paused) {
      return;
    }

    const dt =
      this.lastFrameAt === 0 ? 0 : Math.min((time - this.lastFrameAt) / 1000, 0.08);
    this.lastFrameAt = time;
    this.update(dt, time);
    this.render(time);
    this.frameId = requestAnimationFrame(this.tick);
  };

  private update(dt: number, time: number): void {
    this.causticLayer.setAttribute(
      "transform",
      `translate(${Math.sin(time * 0.00034) * 28} ${Math.cos(time * 0.00027) * 5})`,
    );
    this.lightLayer.setAttribute(
      "transform",
      `translate(${Math.sin(time * 0.00018) * 16} 0)`,
    );
    this.updateLighting();

    for (const pellet of this.state.food) {
      const node = this.pelletNodes.get(pellet.id);
      pellet.ageSeconds += dt;
      const floorY = floorYAt(pellet.x);
      if (pellet.y < floorY) {
        pellet.y = Math.min(
          floorY,
          pellet.y + PELLET_SINK_PER_SECOND * dt * (0.85 + pellet.z * 0.35),
        );
      }
      if (node) {
        pellet.x += Math.sin(time * 0.0012 + node.drift * 30) * 0.00005;
        pellet.x = clamp(pellet.x, 0.04, 0.96);
        pellet.y = Math.min(pellet.y, floorYAt(pellet.x));
      }
    }

    const expiredFood = this.state.food.filter(
      (pellet) => pellet.ageSeconds > PELLET_MAX_AGE_SECONDS,
    );
    for (const pellet of expiredFood) {
      this.removePellet(pellet.id);
    }

    this.updateItems(dt);
    this.updatePlants(dt);

    const deadFish: string[] = [];
    for (const node of this.fishNodes.values()) {
      this.updateFish(node, dt, time);
      if (node.fish.ageSeconds >= node.fish.lifeSeconds) {
        deadFish.push(node.fish.id);
      }
    }
    for (const id of deadFish) {
      this.removeFish(id);
    }

    for (const bubble of this.bubbles) {
      bubble.y -= bubble.speed * dt;
      bubble.x += Math.sin(time * 0.001 + bubble.phase) * 0.00045;
      if (bubble.y < 0.05) {
        bubble.y = this.rng.range(0.88, 0.97);
        bubble.x = this.rng.range(0.05, 0.95);
      }
    }
  }

  private updateFish(node: FishNode, dt: number, time: number): void {
    const fish = node.fish;
    fish.ageSeconds += dt;
    fish.hunger = clamp(fish.hunger + HUNGER_PER_SECOND * dt, 0, 1);
    fish.growth = clamp(fish.growth + PASSIVE_GROWTH_PER_SECOND * dt, 0, 0.72);

    const isLowLight = this.lighting.bottomBias > 0.28;
    const food = this.closestFoodFor(fish);
    if (food && (fish.hunger > 0.08 || food.ageSeconds < 18 || isPelletOnFloor(food))) {
      node.targetX = food.x;
      node.targetY = pelletBiteY(food);
      node.targetZ = food.z;
      node.targetFoodId = food.id;
      node.targetPlantId = undefined;
    } else if (fish.hunger >= PLANT_EAT_HUNGER) {
      const plant = this.closestEdiblePlantFor(fish);
      if (plant) {
        node.targetX = plant.x;
        node.targetY = floorYAt(plant.x) - 0.055;
        node.targetZ = plant.z;
        node.targetFoodId = undefined;
        node.targetPlantId = plant.id;
      } else if (
        time > node.nextWanderAt ||
        distance3(fish.x, fish.y, fish.z, node.targetX, node.targetY, node.targetZ) < 0.025
      ) {
        this.chooseWanderTarget(node, time);
      }
    } else if (
      time > node.nextWanderAt ||
      (isLowLight && node.targetY < 0.68) ||
      distance3(fish.x, fish.y, fish.z, node.targetX, node.targetY, node.targetZ) < 0.025
    ) {
      this.chooseWanderTarget(node, time);
    }

    const dx = node.targetX - fish.x;
    const dy = node.targetY - fish.y;
    const dz = (node.targetZ - fish.z) * 0.7;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > 0.0001) {
      const isSeekingFood = node.targetFoodId !== undefined;
      const isSeekingPlant = node.targetPlantId !== undefined;
      const isPanicked = time < node.panicUntil;
      const hungerBoost = 1 + fish.hunger * 0.55 + (isSeekingFood ? 0.45 : 0);
      const sizeDrag = 1 / Math.sqrt(Math.max(fish.size + fish.growth, 0.4));
      const panicBoost = isPanicked ? 3.1 : 1;
      const lightSpeed =
        isSeekingFood || isSeekingPlant || isPanicked
          ? 0.82 + this.lighting.activity * 0.22
          : 0.32 + this.lighting.activity * 0.68;
      const step = Math.min(
        distance,
        node.speed * hungerBoost * sizeDrag * panicBoost * lightSpeed * dt,
      );
      fish.x = clamp(fish.x + (dx / distance) * step, 0.05, 0.95);
      fish.y = clamp(fish.y + (dy / distance) * step, FISH_MIN_Y, FISH_MAX_Y);
      fish.z = clamp(fish.z + (dz / distance) * step, 0.12, 0.98);
      if (Math.abs(dx) > 0.001) {
        fish.direction = dx > 0 ? 1 : -1;
      }
    }

    if (node.targetFoodId) {
      const target = this.state.food.find((pellet) => pellet.id === node.targetFoodId);
      if (!target) {
        node.targetFoodId = undefined;
      } else if (
        distance3(fish.x, fish.y, fish.z, target.x, pelletBiteY(target), target.z) <
        pelletBiteReach(target, fish)
      ) {
        this.consumePellet(target, fish);
        node.targetFoodId = undefined;
        this.chooseWanderTarget(node, time);
      }
    }

    if (node.targetPlantId) {
      const plant = this.state.items.find((item) => item.id === node.targetPlantId);
      if (!plant || plant.kind !== "plant" || plant.scale <= PLANT_MIN_SCALE) {
        node.targetPlantId = undefined;
      } else if (fish.hunger < PLANT_EAT_HUNGER) {
        node.targetPlantId = undefined;
        this.chooseWanderTarget(node, time);
      } else if (
        distance3(fish.x, fish.y, fish.z, plant.x, floorYAt(plant.x) - 0.055, plant.z) <
        0.055 + (fish.size + fish.growth) * 0.012
      ) {
        this.consumePlant(plant, fish);
        node.targetPlantId = undefined;
        this.chooseWanderTarget(node, time);
      }
    }
  }

  private chooseWanderTarget(node: FishNode, time: number): void {
    if (this.lighting.bottomBias > 0.28) {
      const groupCenter = schoolCenterFor(node.fish.seed);
      const schooling = this.lighting.schooling;
      node.targetX = clamp(
        groupCenter + this.rng.range(-0.18, 0.18) * (1 - schooling * 0.55),
        0.1,
        0.9,
      );
      node.targetY = this.rng.range(
        0.7 + this.lighting.bottomBias * 0.08,
        FISH_MAX_Y,
      );
      node.targetZ = this.rng.range(0.18, 0.62);
    } else {
      node.targetX = this.rng.range(0.1, 0.9);
      node.targetY = this.rng.range(0.15, 0.74);
      node.targetZ = this.rng.range(0.18, 0.98);
    }
    node.targetFoodId = undefined;
    node.targetPlantId = undefined;
    node.nextWanderAt =
      time +
      this.rng.range(2200, 6200) /
        (0.65 + this.lighting.activity * 0.55);
  }

  private closestFoodFor(fish: FishState): FoodPelletState | undefined {
    let nearest: FoodPelletState | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const pellet of this.state.food) {
      const score =
        distance3(fish.x, fish.y, fish.z, pellet.x, pelletBiteY(pellet), pellet.z) +
        (isPelletOnFloor(pellet) ? -0.025 : pellet.ageSeconds * 0.00025);
      if (score < bestScore) {
        nearest = pellet;
        bestScore = score;
      }
    }
    return nearest;
  }

  private closestEdiblePlantFor(fish: FishState): TankItemState | undefined {
    let nearest: TankItemState | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const item of this.state.items) {
      if (item.kind !== "plant" || item.scale <= PLANT_MIN_SCALE + 0.02) {
        continue;
      }
      const score = distance3(fish.x, fish.y, fish.z, item.x, floorYAt(item.x), item.z);
      if (score < bestScore) {
        nearest = item;
        bestScore = score;
      }
    }
    return nearest;
  }

  private updatePlants(dt: number): void {
    if (dt <= 0) {
      return;
    }
    for (const item of this.state.items) {
      if (item.kind !== "plant") {
        continue;
      }
      item.scale = clamp(item.scale + PLANT_GROWTH_PER_SECOND * dt, PLANT_MIN_SCALE, PLANT_MAX_SCALE);
    }
  }

  private updateItems(dt: number): void {
    if (dt <= 0) {
      return;
    }
    for (const item of this.state.items) {
      const floor = floorYAtFootprint(item.x, item.scale);
      if (item.y < floor) {
        item.y = Math.min(floor, item.y + ITEM_DROP_PER_SECOND * dt * (0.75 + item.z * 0.35));
      } else {
        item.y = floor;
      }
    }
  }

  private consumePlant(plant: TankItemState, fish: FishState): void {
    if (plant.scale <= PLANT_MIN_SCALE || fish.hunger < PLANT_EAT_HUNGER) {
      return;
    }
    plant.scale = clamp(plant.scale - PLANT_BITE_SIZE, PLANT_MIN_SCALE, PLANT_MAX_SCALE);
    fish.hunger = clamp(fish.hunger - 0.075, 0, 1);
    this.emit("plant:eaten");
  }

  private consumePellet(pellet: FoodPelletState, fish: FishState): void {
    this.removePellet(pellet.id);
    fish.foodEaten += pellet.value;
    fish.hunger = clamp(fish.hunger - 0.4 * pellet.value, 0, 1);
    fish.growth = clamp(fish.growth + FOOD_GROWTH * pellet.value, 0, 0.72);
    this.emit("food:eaten");
  }

  private removePellet(id: string): void {
    const index = this.state.food.findIndex((pellet) => pellet.id === id);
    if (index !== -1) {
      this.state.food.splice(index, 1);
    }
    const node = this.pelletNodes.get(id);
    node?.root.remove();
    this.pelletNodes.delete(id);
  }

  private removeFish(id: string): void {
    const index = this.state.fish.findIndex((fish) => fish.id === id);
    if (index !== -1) {
      this.state.fish.splice(index, 1);
    }
    const node = this.fishNodes.get(id);
    node?.root.remove();
    this.fishNodes.delete(id);
    this.emit("fish:death");
  }

  private render(time: number): void {
    const entities: SortableEntity[] = [];

    for (const node of this.itemNodes.values()) {
      const { item, root } = node;
      const floor = floorYAtFootprint(item.x, item.scale);
      const groundedY = clamp(item.y, 0.06, floor) + 0.006;
      const scale = item.scale * (1.35 + item.z * 1.1);
      const opacity = 0.42 + item.z * 0.42;
      setAttrs(root, {
        transform: `translate(${item.x * VIEW_WIDTH} ${groundedY * VIEW_HEIGHT}) scale(${scale}) translate(-16 -${itemBaseline(item.kind)})`,
        opacity,
      });
      root.style.filter = `blur(${(1 - item.z) * 1.1}px) saturate(${0.8 + item.z * 0.28})`;
      entities.push({ root, z: item.z - 0.02, y: groundedY });
    }

    for (const node of this.pelletNodes.values()) {
      const { pellet, root } = node;
      const scale = 4.2 + pellet.z * 2.8;
      setAttrs(root, {
        transform: `translate(${pellet.x * VIEW_WIDTH} ${pellet.y * VIEW_HEIGHT}) scale(${scale}) translate(-1.5 -1.5)`,
        opacity: 0.52 + pellet.z * 0.38,
      });
      entities.push({ root, z: pellet.z + 0.01, y: pellet.y });
    }

    for (const node of this.fishNodes.values()) {
      const { fish, root, tail } = node;
      const grownSize = fish.size + fish.growth;
      const scale = grownSize * (3.1 + fish.z * 1.95);
      const tailSpeed = 0.0038 + this.lighting.activity * 0.0072;
      const tailOffset =
        Math.sin(time * tailSpeed + fish.seed) *
        (0.25 + this.lighting.activity * 0.3 + fish.hunger * 0.45);
      setAttrs(tail, { transform: `translate(${tailOffset} 0)` });
      setAttrs(root, {
        transform: `translate(${fish.x * VIEW_WIDTH} ${fish.y * VIEW_HEIGHT}) scale(${fish.direction * scale} ${scale}) translate(-8 -5)`,
        opacity: 0.46 + fish.z * 0.46,
      });
      root.style.filter = `blur(${(1 - fish.z) * 0.42}px) saturate(${0.9 + fish.z * 0.24})`;
      entities.push({ root, z: fish.z + 0.03, y: fish.y });
    }

    entities.sort((a, b) => a.z - b.z || a.y - b.y);
    for (const entity of entities) {
      this.entityLayer.append(entity.root);
    }

    for (const bubble of this.bubbles) {
      setAttrs(bubble.root, {
        cx: bubble.x * VIEW_WIDTH,
        cy: bubble.y * VIEW_HEIGHT,
        r: bubble.radius * (0.7 + bubble.z * 0.8),
        opacity: 0.16 + bubble.z * 0.38,
      });
    }
  }

  private normalizeState(input: FishTankState): FishTankState {
    const now = Date.now();
    const elapsedSeconds = clamp((now - input.updatedAt) / 1000, 0, 60 * 60 * 24 * 45);
    const fish = input.fish.map((source) => {
      const next = this.makeFish(source);
      next.ageSeconds += elapsedSeconds;
      next.growth = clamp(
        next.growth + elapsedSeconds * PASSIVE_GROWTH_PER_SECOND,
        0,
        0.72,
      );
      next.hunger = clamp(next.hunger + elapsedSeconds * HUNGER_PER_SECOND, 0, 1);
      return next;
    }).filter((source) => source.ageSeconds < source.lifeSeconds);
    const food = input.food
      .map((source) => ({
        id: source.id || this.rng.id("food"),
        x: clamp(source.x, 0.04, 0.96),
        y: clamp(
          source.y + elapsedSeconds * PELLET_SINK_PER_SECOND,
          0.08,
          floorYAt(source.x),
        ),
        z: clamp(source.z, 0.12, 0.98),
        ageSeconds: clamp(source.ageSeconds + elapsedSeconds, 0, 3600),
        value: clamp(source.value, 1, 5),
      }))
      .filter((pellet) => pellet.ageSeconds < PELLET_MAX_AGE_SECONDS);

    return {
      version: STATE_VERSION,
      updatedAt: now,
      foodAvailable: Math.floor(clamp(input.foodAvailable, 0, 9999)),
      fullLighting: Boolean(input.fullLighting),
      fish,
      items: input.items.map((item) => {
        const next = this.makeItem(item);
        if (next.kind === "plant") {
          next.scale = clamp(
            next.scale + elapsedSeconds * PLANT_GROWTH_PER_SECOND,
            PLANT_MIN_SCALE,
            PLANT_MAX_SCALE,
          );
        }
        const floor = floorYAtFootprint(next.x, next.scale);
        next.y = Math.min(floor, next.y + elapsedSeconds * ITEM_DROP_PER_SECOND);
        return next;
      }),
      food,
    };
  }

  private makeFish(input: AddFishInput): FishState {
    const species = input.species ?? this.rng.pick(FISH_SPECIES);
    const fish: FishState = {
      id: input.id || this.rng.id("fish"),
      species,
      x: clamp(input.x ?? this.rng.range(0.12, 0.88), 0.05, 0.95),
      y: clamp(input.y ?? FISH_MIN_Y, FISH_MIN_Y, FISH_MAX_Y),
      z: clamp(input.z ?? this.rng.range(0.25, 0.95), 0.12, 0.98),
      direction: input.direction === -1 ? -1 : 1,
      size: clamp(input.size ?? this.rng.range(0.78, 1.02), 0.5, 1.6),
      growth: clamp(input.growth ?? 0, 0, 0.72),
      hunger: clamp(input.hunger ?? this.rng.range(0.08, 0.42), 0, 1),
      ageSeconds: Math.max(0, input.ageSeconds ?? this.rng.range(30, 420)),
      lifeSeconds: clamp(
        input.lifeSeconds ?? this.rng.range(FISH_MIN_LIFE_SECONDS, FISH_MAX_LIFE_SECONDS),
        FISH_MIN_LIFE_SECONDS,
        FISH_MAX_LIFE_SECONDS,
      ),
      foodEaten: Math.max(0, Math.floor(input.foodEaten ?? 0)),
      seed: input.seed ?? this.rng.int(1, 100000),
    };

    if (input.name) {
      fish.name = input.name;
    }
    return fish;
  }

  private makeItem(input: AddTankItemInput | TankItemState): TankItemState {
    const x = clamp(input.x ?? this.rng.range(0.1, 0.9), 0.04, 0.96);
    const floor = floorYAt(x);
    return {
      id: input.id || this.rng.id("item"),
      kind: input.kind,
      x,
      y: clamp(input.y ?? floor, 0.06, floor),
      z: clamp(input.z ?? this.rng.range(0.12, 0.9), 0.08, 0.98),
      scale:
        input.kind === "plant"
          ? clamp(input.scale ?? this.rng.range(0.72, 1.05), PLANT_MIN_SCALE, PLANT_MAX_SCALE)
          : clamp(input.scale ?? this.rng.range(0.8, 1.18), 0.35, 2.5),
      variant: Math.max(0, Math.floor(input.variant ?? this.rng.int(0, 9))),
    };
  }

  private emptyState(): FishTankState {
    return {
      version: STATE_VERSION,
      updatedAt: Date.now(),
      foodAvailable: 0,
      fullLighting: false,
      fish: [],
      items: [],
      food: [],
    };
  }

  private emit(reason: FishTankChangeReason): void {
    this.state.updatedAt = Date.now();
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot, reason);
    }
  }

  private clearFoodBurst(): void {
    if (this.foodBurstTimer !== 0) {
      window.clearTimeout(this.foodBurstTimer);
      this.foodBurstTimer = 0;
    }
    this.queuedFoodDrops = 0;
    this.foodBurstAverageDelayMs = 0;
  }

  private firstFoodBurstDelay(): number {
    if (this.queuedFoodDrops <= 1) {
      return this.rng.range(250, 1500);
    }
    return this.rng.range(300, Math.min(1800, this.foodBurstAverageDelayMs));
  }

  private nextFoodBurstDelay(): number {
    return clamp(
      this.foodBurstAverageDelayMs * this.rng.range(0.55, 1.45),
      300,
      12000,
    );
  }

  private createGlassRipple(x: number, y: number): void {
    const ripple = svgEl("circle", {
      class: "fishpx-glass-ripple",
      cx: x * VIEW_WIDTH,
      cy: y * VIEW_HEIGHT,
      r: 5,
      fill: "none",
      stroke: "#effcff",
      "stroke-width": 2,
      opacity: 0.62,
    });
    this.glassEffectLayer.append(ripple);
    window.setTimeout(() => ripple.remove(), 720);
  }

  private updateLighting(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastLightingUpdate < 10000) {
      return;
    }
    this.lastLightingUpdate = now;
    const profile = lightingProfile(new Date(), this.state.fullLighting);
    this.lighting = profile;
    setAttrs(this.timeTint, {
      fill: profile.tint,
      opacity: profile.tintOpacity,
    });
    setAttrs(this.timeGlow, {
      fill: profile.glow,
      opacity: profile.glowOpacity,
    });
    setAttrs(this.lightLayer, { opacity: profile.raysOpacity });
    setAttrs(this.causticLayer, { opacity: profile.causticsOpacity });
    this.svg.style.filter = `brightness(${profile.brightness}) saturate(${profile.saturation})`;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const rect = this.svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    this.tapAt(x, y);
  };

  private applyDimensions(
    width: number | string | undefined,
    height: number | string | undefined,
  ): void {
    if (width !== undefined) {
      this.host.style.width = cssSize(width);
    }
    if (height !== undefined) {
      this.host.style.height = cssSize(height);
      this.host.style.aspectRatio = "auto";
    } else if (width !== undefined) {
      this.host.style.height = "auto";
      this.host.style.aspectRatio = "25 / 16";
    }
  }
}

export function createFishTank(
  container: HTMLElement | string,
  options: FishTankOptions = {},
): FishTankApi {
  const target =
    typeof container === "string"
      ? document.querySelector<HTMLElement>(container)
      : container;

  if (!target) {
    throw new Error("FishPx container was not found.");
  }

  return new FishTank(target, options);
}

export function randomItemKind(seed: string | number): TankItemKind {
  return new Random(seed).pick(ITEM_KINDS);
}

function foodBurstAverageDelay(count: number): number {
  return clamp(60000 / Math.max(1, count), 300, 60000);
}

function cloneState(state: FishTankState): FishTankState {
  return {
    version: STATE_VERSION,
    updatedAt: state.updatedAt,
    foodAvailable: state.foodAvailable,
    fullLighting: state.fullLighting,
    fish: state.fish.map((fish) => ({ ...fish })),
    items: state.items.map((item) => ({ ...item })),
    food: state.food.map((pellet) => ({ ...pellet })),
  };
}

function distance3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return Math.hypot(ax - bx, ay - by, (az - bz) * 0.75);
}

function floorYAt(x: number): number {
  const wave =
    Math.sin(x * Math.PI * 6.2 + 0.3) * 0.015 +
    Math.sin(x * Math.PI * 2.4 + 1.1) * 0.011;
  return clamp(0.84 + wave, 0.81, 0.885);
}

function sandPath(baseY: number, waveA: number, waveB: number): string {
  const p1 = baseY - waveA;
  const p2 = baseY + waveB;
  const p3 = baseY - waveB * 0.3;
  const p4 = baseY - waveA * 0.8;
  const p5 = baseY + waveB * 0.5;
  const p6 = baseY - waveA * 0.4;
  return `M0 ${baseY} C140 ${p1} 245 ${p2} 390 ${p3} C545 ${p4} 650 ${p5} 790 ${p6} C872 ${baseY - waveB} 918 ${baseY - waveB * 0.7} ${VIEW_WIDTH} ${baseY - 2} L${VIEW_WIDTH} ${VIEW_HEIGHT} L0 ${VIEW_HEIGHT} Z`;
}

function isPelletOnFloor(pellet: FoodPelletState): boolean {
  return pellet.y >= floorYAt(pellet.x) - 0.006;
}

function pelletBiteY(pellet: FoodPelletState): number {
  if (!isPelletOnFloor(pellet)) {
    return pellet.y;
  }
  return Math.min(FISH_MAX_Y - 0.006, floorYAt(pellet.x) - 0.026);
}

function pelletBiteReach(pellet: FoodPelletState, fish: FishState): number {
  const grownSize = fish.size + fish.growth;
  return (isPelletOnFloor(pellet) ? 0.09 : 0.048) + grownSize * 0.018;
}

function floorYAtFootprint(x: number, scale: number): number {
  const radius = clamp(scale * 0.018, 0.012, 0.04);
  return Math.max(
    floorYAt(clamp(x - radius, 0, 1)),
    floorYAt(x),
    floorYAt(clamp(x + radius, 0, 1)),
  );
}

function itemBaseline(kind: TankItemKind): number {
  switch (kind) {
    case "shell":
      return 28;
    case "rock":
    case "bubbler":
      return 29;
    case "kelp":
    case "plant":
    case "ruin":
    case "coral":
      return 30;
  }
}

function schoolCenterFor(seed: number): number {
  const centers = [0.28, 0.5, 0.72] as const;
  return centers[Math.abs(Math.floor(seed)) % centers.length] ?? 0.5;
}

function lightingProfile(date: Date, fullLighting: boolean): LightingProfile {
  if (fullLighting) {
    return {
      tint: "#e8fdff",
      tintOpacity: 0.01,
      glow: "#fff8df",
      glowOpacity: 0.05,
      raysOpacity: 1,
      causticsOpacity: 1,
      brightness: 1.1,
      saturation: 1.08,
      activity: 1,
      bottomBias: 0,
      schooling: 0.12,
    };
  }

  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour >= 10 && hour < 15.5) {
    return {
      tint: "#e8fdff",
      tintOpacity: 0.01,
      glow: "#fff8df",
      glowOpacity: 0.05,
      raysOpacity: 0.96,
      causticsOpacity: 1,
      brightness: 1.04,
      saturation: 1.04,
      activity: 1,
      bottomBias: 0.04,
      schooling: 0.12,
    };
  }
  if (hour >= 7 && hour < 17) {
    return {
      tint: "#caf3ff",
      tintOpacity: 0.025,
      glow: "#fff4c2",
      glowOpacity: 0.035,
      raysOpacity: 0.66,
      causticsOpacity: 0.72,
      brightness: 0.96,
      saturation: 0.98,
      activity: 0.9,
      bottomBias: 0.12,
      schooling: 0.2,
    };
  }
  if (hour >= 17 && hour < 21) {
    return {
      tint: "#c9793b",
      tintOpacity: 0.055,
      glow: "#f6ba73",
      glowOpacity: 0.04,
      raysOpacity: 0.22,
      causticsOpacity: 0.24,
      brightness: 0.7,
      saturation: 0.86,
      activity: 0.56,
      bottomBias: 0.52,
      schooling: 0.62,
    };
  }
  if (hour >= 5 && hour < 7) {
    return {
      tint: "#b18d7e",
      tintOpacity: 0.045,
      glow: "#d8b48e",
      glowOpacity: 0.03,
      raysOpacity: 0.16,
      causticsOpacity: 0.18,
      brightness: 0.62,
      saturation: 0.8,
      activity: 0.48,
      bottomBias: 0.6,
      schooling: 0.7,
    };
  }
  return {
    tint: "#06152a",
    tintOpacity: 0.1,
    glow: "#5170a4",
    glowOpacity: 0.012,
    raysOpacity: 0.035,
    causticsOpacity: 0.06,
    brightness: 0.44,
    saturation: 0.66,
    activity: 0.28,
    bottomBias: 0.86,
    schooling: 0.9,
  };
}

function cssSize(size: number | string): string {
  if (typeof size === "number") {
    return `${Math.max(1, size)}px`;
  }
  return size;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
