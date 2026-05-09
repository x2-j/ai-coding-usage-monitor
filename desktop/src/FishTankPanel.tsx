import { useEffect, useMemo, useRef, useState } from "react";
import type { FishTankApi, FishTankState, TankItemKind } from "./fishpx/types.js";
import type { MonitorState } from "./types";

const debugItems: readonly TankItemKind[] = ["kelp", "plant", "rock", "ruin", "shell", "coral", "bubbler"];
const TANK_STORAGE_PREFIX = "simple-ai-usage-monitor:fishpx:v2";
const DEFAULT_FOOD_TOKEN_INTERVAL = 50_000;
const DEFAULT_FISH_TOKEN_INTERVAL = 10_000_000;
const DEFAULT_ITEM_TOKEN_INTERVAL = 20_000_000;

type RewardProgress = {
  baselineTokens: number;
  foodMilestone: number;
  itemMilestone: number;
  fishMilestone: number;
  foodInterval: number;
  itemInterval: number;
  fishInterval: number;
};

function sessionTokensForTank(state: MonitorState) {
  return state.provider_usages.reduce((total, usage) => {
    const session = usage.totals.session;
    if (!session) return total;
    return total + (state.settings.include_cache_tokens ? session.total_tokens : session.visible_tokens);
  }, 0);
}

function tankSessionKey(state: MonitorState) {
  const sessionMs = Math.max(1, state.settings.session_hours) * 60 * 60 * 1000;
  const fallbackBucket = Math.floor(Date.now() / sessionMs);
  const providerWindows = state.provider_usages.map((usage) => {
    const reset = usage.snapshot.session_reset_at;
    if (reset) return `${usage.provider_id}:${reset}`;
    return `${usage.provider_id}:rolling:${fallbackBucket}`;
  });
  if (providerWindows.length > 0) {
    return providerWindows.sort().join("|");
  }

  return `local:${fallbackBucket}`;
}

export function FishTankPanel({ state }: { state: MonitorState }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tankRef = useRef<FishTankApi | null>(null);
  const rewardProgressRef = useRef<RewardProgress | null>(null);
  const tokenTotalRef = useRef(0);
  const intervalsRef = useRef({
    food: DEFAULT_FOOD_TOKEN_INTERVAL,
    item: DEFAULT_ITEM_TOKEN_INTERVAL,
    fish: DEFAULT_FISH_TOKEN_INTERVAL,
  });
  const [debugOpen, setDebugOpen] = useState(false);
  const [fullLightingEnabled, setFullLightingEnabled] = useState(false);
  const enabled = state.settings.fish_tank_enabled;
  const foodTokenInterval = Math.max(1, Math.floor(state.settings.fish_tank_food_token_interval || DEFAULT_FOOD_TOKEN_INTERVAL));
  const itemTokenInterval = Math.max(1, Math.floor(state.settings.fish_tank_item_token_interval || DEFAULT_ITEM_TOKEN_INTERVAL));
  const fishTokenInterval = Math.max(1, Math.floor(state.settings.fish_tank_fish_token_interval || DEFAULT_FISH_TOKEN_INTERVAL));
  const tokenTotal = sessionTokensForTank(state);
  const seed = useMemo(
    () => state.settings.fish_tank_seed || `fishpx-${Date.now()}`,
    [state.settings.fish_tank_seed]
  );
  const sessionKey = useMemo(() => tankSessionKey(state), [state]);
  const storageKey = useMemo(() => `${TANK_STORAGE_PREFIX}:${seed}:session:${sessionKey}`, [seed, sessionKey]);

  useEffect(() => {
    tokenTotalRef.current = tokenTotal;
    intervalsRef.current = {
      food: foodTokenInterval,
      item: itemTokenInterval,
      fish: fishTokenInterval,
    };
  }, [fishTokenInterval, foodTokenInterval, itemTokenInterval, tokenTotal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F8") return;
      event.preventDefault();
      setDebugOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!enabled || !containerRef.current) return undefined;
    let cancelled = false;
    let mountedTank: FishTankApi | null = null;
    Promise.all([
      import("./fishpx/tank.js"),
      import("./fishpx/demoState.js"),
    ]).then(([tankModule, demoStateModule]) => {
      if (cancelled || !containerRef.current) return;
      const savedTankState = readJson<FishTankState>(`${storageKey}:state`);
      const initialState = savedTankState ?? starterState(demoStateModule.createSeededDemoState(seed));
      mountedTank = tankModule.createFishTank(containerRef.current, {
        seed,
        state: initialState,
        width: "100%",
        height: "100%",
        onStateChange: (nextState) => {
          setFullLightingEnabled(nextState.fullLighting);
          writeJson(`${storageKey}:state`, nextState);
        },
      });
      tankRef.current = mountedTank;
      rewardProgressRef.current = loadRewardProgress(storageKey, tokenTotalRef.current, intervalsRef.current);
      writeJson(`${storageKey}:rewards`, rewardProgressRef.current);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      mountedTank?.destroy();
      if (tankRef.current === mountedTank) {
        tankRef.current = null;
      }
      rewardProgressRef.current = null;
    };
  }, [enabled, seed, storageKey]);

  useEffect(() => {
    if (!enabled || !tankRef.current) return;
    const intervals = { food: foodTokenInterval, item: itemTokenInterval, fish: fishTokenInterval };
    let progress = rewardProgressRef.current ?? loadRewardProgress(storageKey, tokenTotal, intervals);
    const intervalsChanged = progress.foodInterval !== intervals.food
      || progress.itemInterval !== intervals.item
      || progress.fishInterval !== intervals.fish;
    if (intervalsChanged || tokenTotal < progress.baselineTokens) {
      progress = createRewardProgress(tokenTotal, intervals);
    }
    const tokensSinceBaseline = Math.max(0, tokenTotal - progress.baselineTokens);
    const nextFoodMilestone = Math.floor(tokensSinceBaseline / intervals.food);
    const nextItemMilestone = Math.floor(tokensSinceBaseline / intervals.item);
    const nextFishMilestone = Math.floor(tokensSinceBaseline / intervals.fish);

    const foodEarned = nextFoodMilestone - progress.foodMilestone;
    const itemEarned = nextItemMilestone - progress.itemMilestone;
    const fishEarned = nextFishMilestone - progress.fishMilestone;

    if (foodEarned > 0) {
      tankRef.current.grantFood(foodEarned);
    }
    for (let index = 0; index < itemEarned; index += 1) {
      const kind = debugItems[(progress.itemMilestone + index) % debugItems.length] ?? "plant";
      tankRef.current.addItem({ kind, y: 0.08 });
    }
    for (let index = 0; index < fishEarned; index += 1) {
      tankRef.current.addFish({ size: 0.58, ageSeconds: 0, y: 0.08 });
    }

    progress.foodMilestone = nextFoodMilestone;
    progress.itemMilestone = nextItemMilestone;
    progress.fishMilestone = nextFishMilestone;
    progress.foodInterval = intervals.food;
    progress.itemInterval = intervals.item;
    progress.fishInterval = intervals.fish;
    rewardProgressRef.current = progress;
    writeJson(`${storageKey}:rewards`, progress);
  }, [enabled, fishTokenInterval, foodTokenInterval, itemTokenInterval, storageKey, tokenTotal]);

  if (!enabled) return null;

  return (
    <section className="fish-tank-panel" aria-label="Token fish tank">
      <div className="fish-tank-controls" role="toolbar" aria-label="Fish tank controls">
        <button
          onClick={() => tankRef.current?.setFullLighting(!fullLightingEnabled)}
          type="button"
        >
          {fullLightingEnabled ? "Lights Off" : "Lights On"}
        </button>
      </div>
      {debugOpen && (
        <div className="fish-tank-debug" role="toolbar" aria-label="Fish tank debug controls">
          <button onClick={() => tankRef.current?.grantFood(1)} type="button">Food</button>
          <button onClick={() => tankRef.current?.addFish({ y: 0.08 })} type="button">Fish</button>
          <button
            onClick={() => {
              const item = debugItems[Math.floor(Math.random() * debugItems.length)] ?? "plant";
              tankRef.current?.addItem({ kind: item, y: 0.08 });
            }}
            type="button"
          >
            Decor
          </button>
          <button
            onClick={() => {
              const tank = tankRef.current;
              if (!tank) return;
              tank.setFullLighting(!tank.getState().fullLighting);
            }}
            type="button"
          >
            Light
          </button>
        </div>
      )}
      <div className="fish-tank-mount" ref={containerRef} />
    </section>
  );
}

function starterState(state: FishTankState): FishTankState {
  return {
    ...state,
    foodAvailable: 0,
    food: [],
    fish: state.fish.slice(0, 3).map((fish) => ({ ...fish, ageSeconds: Math.min(fish.ageSeconds, 120) })),
    items: state.items.slice(0, 4),
  };
}

function createRewardProgress(tokenTotal: number, intervals: { food: number; item: number; fish: number }): RewardProgress {
  return {
    baselineTokens: tokenTotal,
    foodMilestone: 0,
    itemMilestone: 0,
    fishMilestone: 0,
    foodInterval: intervals.food,
    itemInterval: intervals.item,
    fishInterval: intervals.fish,
  };
}

function loadRewardProgress(
  storageKey: string,
  tokenTotal: number,
  intervals: { food: number; item: number; fish: number },
): RewardProgress {
  const saved = readJson<RewardProgress>(`${storageKey}:rewards`);
  if (!saved || !Number.isFinite(saved.baselineTokens)) {
    return createRewardProgress(tokenTotal, intervals);
  }
  if (
    saved.foodInterval !== intervals.food
    || saved.itemInterval !== intervals.item
    || saved.fishInterval !== intervals.fish
    || tokenTotal < saved.baselineTokens
  ) {
    return createRewardProgress(tokenTotal, intervals);
  }
  return saved;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Fish tank persistence is decorative; the monitor should keep working if storage is unavailable.
  }
}
