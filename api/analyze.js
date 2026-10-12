/**
 * SINNCI AI — XAU/USD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Analysis only. No automated trading or order execution.
 * Zone accuracy > signal timing > score.
 *
 * TP1 / TP2: STRUCTURAL SNR ONLY
 * No fixed-price TP fallback.
 * TP2 must be at least $5.00 beyond TP1.
 *
 * SL:
 * - Scalping entry zone: M5
 * - Scalping SL structure: M15
 * - Intraday entry zone: M15
 * - Intraday SL structure: M15
 * - Maximum SL risk: $4.00 for both modes
 */

const SETTINGS = {
  symbol: "XAU/USD",
  point: 0.01,
  zoneThickness: 2.00,
  candleCount: 50,
  timeout: 15000,

  scalping: {
    minimumScore: 65,
    lockMinutes: 720,
    maxRiskDistance: 4.00,
    maxTargetDistance: 30.00,
    minimumRR1: 1.20,
    minimumRR2: 2.00,
    minimumTPSeparation: 5.00,
  },

  intraday: {
    minimumScore: 65,
    lockMinutes: 4320,
    maxRiskDistance: 4.00,
    maxTargetDistance: 80.00,
    minimumRR1: 1.20,
    minimumRR2: 1.80,
    minimumTPSeparation: 5.00,
  },
};

const TIMEFRAMES = {
  D1: "1day",
  H1: "1h",
  M15: "15min",
  M5: "5min",
};

const TABLE = "sinnci_setup_locks";

/* =========================================================
   GENERAL HELPERS
========================================================= */

function json(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}

function round(value, decimals = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(decimals)) : null;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function uniquePrices(values, tolerance = 0.15) {
  const result = [];

  for (const value of values) {
    if (!Number.isFinite(value)) continue;

    if (
      !result.some((existing) =>
        Math.abs(existing - value) <= tolerance
      )
    ) {
      result.push(value);
    }
  }

  return result;
}

function getEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function isBuy(direction) {
  return direction === "BUY";
}

function isCorrectTarget(direction, entry, target) {
  if (!Number.isFinite(target)) return false;
  return isBuy(direction) ? target > entry : target < entry;
}

/* =========================================================
   TWELVE DATA
========================================================= */

async function fetchCandles(interval) {
  const apiKey = getEnv("TWELVE_DATA_API_KEY");

  if (!apiKey) {
    throw new Error(
      "TWELVE_DATA_API_KEY belum ditetapkan di Vercel."
    );
  }

  const params = new URLSearchParams({
    symbol: SETTINGS.symbol,
    interval,
    outputsize: String(SETTINGS.candleCount),
    order: "ASC",
    timezone: "UTC",
    apikey: apiKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    SETTINGS.timeout
  );

  try {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?${params.toString()}`,
      {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      }
    );

    const raw = await response.text();
    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        `Twelve Data memulangkan respons bukan JSON (HTTP ${response.status}).`
      );
    }

    if (!response.ok || body.status === "error" || body.code) {
      throw new Error(
        body.message ||
        body.msg ||
        `Twelve Data gagal mendapatkan ${interval} (HTTP ${response.status}).`
      );
    }

    if (!Array.isArray(body.values)) {
      throw new Error(`Data candle ${interval} tidak tersedia.`);
    }

    const candles = body.values
      .map((item) => ({
        time: item.datetime,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume || 0),
      }))
      .filter((c) =>
        c.time &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.high >= c.low &&
        c.high >= Math.max(c.open, c.close) &&
        c.low <= Math.min(c.open, c.close)
      )
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    if (candles.length < 25) {
      throw new Error(
        `Candle ${interval} tidak mencukupi: ${candles.length} diterima.`
      );
    }

    return candles;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function findSwings(candles, wing = 2) {
  const highs = [];
  const lows = [];

  for (let i = wing; i < candles.length - wing; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;

      if (candles[j].high >= current.high) isHigh = false;
      if (candles[j].low <= current.low) isLow = false;
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: current.high,
        time: current.time,
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: current.low,
        time: current.time,
      });
    }
  }

  return { highs, lows };
}

function buildStructure(candles) {
  const recent = candles.slice(-20);
  const closes = candles.map((c) => c.close);
  const swings = findSwings(candles, 2);

  const range = recent.length
    ? {
        high: Math.max(...recent.map((c) => c.high)),
        low: Math.min(...recent.map((c) => c.low)),
      }
    : null;

  const lastHighs = swings.highs.slice(-2);
  const lastLows = swings.lows.slice(-2);

  let direction = "NEUTRAL";

  if (lastHighs.length === 2 && lastLows.length === 2) {
    const higherHigh =
      lastHighs[1].price > lastHighs[0].price;
    const higherLow =
      lastLows[1].price > lastLows[0].price;
    const lowerHigh =
      lastHighs[1].price < lastHighs[0].price;
    const lowerLow =
      lastLows[1].price < lastLows[0].price;

    if (higherHigh && higherLow) direction = "BULLISH";
    else if (lowerHigh && lowerLow) direction = "BEARISH";
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  if (direction === "NEUTRAL" && ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) {
      direction = "BULLISH";
    } else if (last.close < ema20 && ema20 < ema50) {
      direction = "BEARISH";
    }
  }

  const breakoutUp = Boolean(
    range &&
    last.close > previous.high &&
    last.close >= range.high - 0.05
  );

  const breakoutDown = Boolean(
    range &&
    last.close < previous.low &&
    last.close <= range.low + 0.05
  );

  return {
    direction,
    range,
    swingHighs: swings.highs,
    swingLows: swings.lows,
    ema20,
    ema50,
    breakoutUp,
    breakoutDown,
    lastClose: last.close,
    lastTime: last.time,
  };
}

/* =========================================================
   EARLY ENTRY ZONE
========================================================= */

function buildEarlyZone(candles, direction, cmp, mode) {
  const recent = candles.slice(-35);
  const structure = buildStructure(recent);
  const swings = findSwings(recent, 2);
  const buy = isBuy(direction);

  const relevantSwings = buy ? swings.lows : swings.highs;

  const candidates = relevantSwings
    .filter((s) => buy ? s.price < cmp : s.price > cmp)
    .map((s) => ({
      price: s.price,
      time: s.time,
      source: buy ? "SNR_SUPPORT" : "SNR_RESISTANCE",
    }));

  let pivot = null;
  let source = "SNR_RANGE_EDGE";
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = Math.abs(cmp - candidate.price);

    if (distance < bestDistance) {
      pivot = candidate.price;
      source = candidate.source;
      bestDistance = distance;
    }
  }

  const ema20 = ema(recent.map((c) => c.close), 20);

  if (pivot === null && ema20 !== null) {
    const correctSide = buy ? ema20 < cmp : ema20 > cmp;

    if (correctSide) {
      pivot = ema20;
      source = "EMA20_REENTRY";
    }
  }

  if (pivot === null && structure.range) {
    pivot = buy ? structure.range.low : structure.range.high;
    source = "SNR_RANGE_EDGE";
  }

  if (!Number.isFinite(pivot)) {
    return {
      valid: false,
      reason: "Struktur SNR yang sesuai belum ditemui.",
      low: null,
      high: null,
      entry: null,
      pivot: null,
      source,
      status: "WATCH",
      distance: null,
    };
  }

  const half = SETTINGS.zoneThickness / 2;
  const low = round(pivot - half);
  const high = round(pivot + half);

  let status = "WATCH";

  if (cmp >= low && cmp <= high) {
    status = "IN_ZONE";
  } else if (buy && cmp > high && cmp - high <= 5) {
    status = "APPROACHING";
  } else if (!buy && cmp < low && low - cmp <= 5) {
    status = "APPROACHING";
  }

  return {
    valid: Number.isFinite(low) &&
      Number.isFinite(high) &&
      high > low,
    low,
    high,
    entry: round(pivot),
    pivot: round(pivot),
    source,
    status,
    distance: round(Math.abs(cmp - pivot)),
    timeframe: mode === "scalping" ? "M5" : "M15",
    reason: null,
  };
}

/* =========================================================
   STRUCTURAL STOP LOSS
   Uses structural swing levels only.
   No synthetic fallback.
========================================================= */

function buildStructuralStop(direction, zone, candles, maxRisk) {
  if (!zone || !Number.isFinite(zone.entry)) {
    return {
      value: null,
      risk: null,
      valid: false,
      reason: "Entry zone tidak sah untuk pengiraan SL.",
    };
  }

  const recent = candles.slice(-35);
  const swings = findSwings(recent, 2);
  const buy = isBuy(direction);

  const candidates = buy
    ? swings.lows
        .map((s) => s.price)
        .filter((p) => p < zone.low)
    : swings.highs
        .map((s) => s.price)
        .filter((p) => p > zone.high);

  candidates.sort((a, b) => buy ? b - a : a - b);

  const entry = zone.entry;
  let stop = null;

  for (const level of candidates) {
    const candidate = buy
      ? round(level - 0.50)
      : round(level + 0.50);

    const risk = round(Math.abs(entry - candidate));
    const correctSide = buy
      ? candidate < zone.low
      : candidate > zone.high;

    if (
      correctSide &&
      risk > 0 &&
      risk <= maxRisk
    ) {
      stop = candidate;
      break;
    }
  }

  if (stop === null) {
    return {
      value: null,
      risk: null,
      valid: false,
      reason:
        `Tiada swing M15 yang sah dalam had risiko $${maxRisk.toFixed(2)}.`,
    };
  }

  const risk = round(Math.abs(entry - stop));
  const correctSide = buy
    ? stop < zone.low
    : stop > zone.high;

  return {
    value: stop,
    risk,
    valid: correctSide && risk > 0 && risk <= maxRisk,
    reason: null,
  };
}

/* =========================================================
   STRUCTURAL TARGET CANDIDATES
========================================================= */

function findTargets(direction, entry, targetCandles, secondaryCandles) {
  const primary = targetCandles.slice(-40);
  const secondary = secondaryCandles.slice(-40);

  const primaryStructure = buildStructure(primary);
  const secondaryStructure = buildStructure(secondary);

  let candidates = [];

  if (isBuy(direction)) {
    candidates = [
      ...primaryStructure.swingHighs.map((s) => s.price),
      ...secondaryStructure.swingHighs.map((s) => s.price),
      primaryStructure.range?.high,
      secondaryStructure.range?.high,
    ];
  } else {
    candidates = [
      ...primaryStructure.swingLows.map((s) => s.price),
      ...secondaryStructure.swingLows.map((s) => s.price),
      primaryStructure.range?.low,
      secondaryStructure.range?.low,
    ];
  }

  return uniquePrices(
    candidates
      .filter((price) => isCorrectTarget(direction, entry, price))
      .map((price) => round(price))
      .filter(Number.isFinite)
      .sort((a, b) => isBuy(direction) ? a - b : b - a)
  );
}

/* =========================================================
   TRADE PLAN
========================================================= */

function buildTradePlan(
  direction,
  zone,
  stopResult,
  primary,
  secondary,
  config
) {
  const invalidPlan = (
    reason,
    entry = zone.entry,
    sl = stopResult.value,
    risk = stopResult.risk
  ) => ({
    valid: false,
    entry,
    sl,
    tp1: null,
    tp2: null,
    risk,
    reward1: null,
    reward2: null,
    rr1: null,
    rr2: null,
    reason,
  });

  if (!zone.valid || !stopResult.valid) {
    return invalidPlan(
      stopResult.reason ||
      "SL tidak sah atau risiko melebihi had."
    );
  }

  const entry = zone.entry;
  const sl = stopResult.value;
  const risk = round(Math.abs(entry - sl));

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(sl) ||
    !Number.isFinite(risk) ||
    risk <= 0 ||
    risk > config.maxRiskDistance
  ) {
    return invalidPlan(
      "Risiko SL tidak sah atau melebihi had.",
      entry,
      sl,
      risk
    );
  }

  const minimumReward1 = risk * config.minimumRR1;
  const minimumReward2 = risk * config.minimumRR2;

  const structuralTargets = findTargets(
    direction,
    entry,
    primary,
    secondary
  );

  const validTargets = structuralTargets.filter((price) => {
    const reward = Math.abs(price - entry);
    const rr = reward / risk;

    return (
      isCorrectTarget(direction, entry, price) &&
      reward >= minimumReward1 &&
      reward <= config.maxTargetDistance &&
      rr >= config.minimumRR1
    );
  });

  const tp1 = validTargets[0] ?? null;

  if (tp1 === null) {
    return invalidPlan(
      "Tiada TP1 struktur SNR yang sah dan memenuhi minimum risk/reward."
    );
  }

  const reward1 = round(Math.abs(tp1 - entry));
  const rr1 = round(reward1 / risk);

  const tp2 = validTargets.find((price) => {
    const separation = Math.abs(price - tp1);
    const reward = Math.abs(price - entry);
    const rr = reward / risk;

    return (
      isCorrectTarget(direction, tp1, price) &&
      separation >= config.minimumTPSeparation &&
      reward >= minimumReward2 &&
      reward <= config.maxTargetDistance &&
      rr >= config.minimumRR2
    );
  }) ?? null;

  if (tp2 === null) {
    return {
      valid: true,
      entry,
      sl,
      tp1,
      tp2: null,
      risk,
      reward1,
      reward2: null,
      rr1,
      rr2: null,
      reason:
        "TP1 sah; TP2 struktur seterusnya belum memenuhi syarat.",
    };
  }

  const reward2 = round(Math.abs(tp2 - entry));
  const rr2 = round(reward2 / risk);

  return {
    valid: true,
    entry,
    sl,
    tp1,
    tp2,
    risk,
    reward1,
    reward2,
    rr1,
    rr2,
    reason: null,
  };
}

/* =========================================================
   SCORE
========================================================= */

function calculateScore(direction, trendH1, trendEntry, zone, structure) {
  let score = 50;
  const wanted = isBuy(direction) ? "BULLISH" : "BEARISH";

  if (trendH1 === wanted) score += 15;
  else if (trendH1 !== "NEUTRAL") score -= 12;

  if (trendEntry === wanted) score += 10;
  else if (trendEntry !== "NEUTRAL") score -= 8;

  if (
    zone.source === "SNR_SUPPORT" ||
    zone.source === "SNR_RESISTANCE"
  ) {
    score += 10;
  } else if (zone.source.includes("RETEST")) {
    score += 12;
  } else if (zone.source === "EMA20_REENTRY") {
    score += 6;
  }

  if (zone.status === "IN_ZONE") score += 8;
  else if (zone.status === "APPROACHING") score += 5;

  if (structure.breakoutUp && isBuy(direction)) score += 5;
  if (structure.breakoutDown && !isBuy(direction)) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/* =========================================================
   SUPABASE
========================================================= */

function supabaseConfig() {
  const url = getEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  return url && key ? { url, key } : null;
}

async function supabaseRequest(path, options = {}) {
  const config = supabaseConfig();

  if (!config) {
    throw new Error("Supabase environment variables belum lengkap.");
  }

  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (!headers.Prefer && options.prefer) {
    headers.Prefer = options.prefer;
  }

  const response = await fetch(
    `${config.url}/rest/v1/${path}`,
    { ...options, headers }
  );

  const raw = await response.text();
  let body = null;

  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = { message: raw };
    }
  }

  if (!response.ok) {
    throw new Error(
      body?.message ||
      body?.hint ||
      `Supabase gagal (HTTP ${response.status}).`
    );
  }

  return body;
}

async function getActiveLocks(mode) {
  if (!supabaseConfig()) return [];

  const query = new URLSearchParams({
    select: "*",
    symbol: `eq.${SETTINGS.symbol}`,
    mode: `eq.${mode}`,
    status: "eq.ACTIVE",
    order: "updated_at.desc",
    limit: "20",
  });

  return await supabaseRequest(`${TABLE}?${query.toString()}`, {
    method: "GET",
    prefer: "return=representation",
  });
}

function lockStillFresh(lock, config) {
  const updatedAt = new Date(
    lock.updated_at || lock.created_at
  ).getTime();

  if (!Number.isFinite(updatedAt)) return false;

  const age = Date.now() - updatedAt;

  return age >= 0 && age <= config.lockMinutes * 60 * 1000;
}

function makeSetupId(mode, direction, zone) {
  const zoneKey = `${zone.low.toFixed(2)}_${zone.high.toFixed(2)}`;

  return `${SETTINGS.symbol.replace("/", "")}_${mode}_${direction}_${zoneKey}`
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/* =========================================================
   STORED PLAN VALIDATION
========================================================= */

function validateStoredPlan(
  lock,
  direction,
  config,
  structuralTargets,
  expectedStop
) {
  const entry = Number(lock.entry);
  const sl = Number(lock.stop_loss);
  const tp1 = Number(lock.tp1);
  const tp2 = lock.tp2 == null ? null : Number(lock.tp2);

  if (![entry, sl, tp1].every(Number.isFinite)) return false;

  const risk = Math.abs(entry - sl);
  const reward1 = Math.abs(tp1 - entry);
  const rr1 = risk > 0 ? reward1 / risk : 0;

  const slCorrect = isBuy(direction) ? sl < entry : sl > entry;
  const tp1Correct = isCorrectTarget(direction, entry, tp1);

  const tp1IsStructural = structuralTargets.some(
    (price) => Math.abs(price - tp1) <= 0.25
  );

  // Stored SL mesti sepadan dengan swing yang dikira semula.
  const storedStopMatches =
    expectedStop.valid &&
    Number.isFinite(expectedStop.value) &&
    Math.abs(sl - expectedStop.value) <= 0.25;

  if (
    !slCorrect ||
    !storedStopMatches ||
    !tp1Correct ||
    !tp1IsStructural ||
    risk <= 0 ||
    risk > config.maxRiskDistance ||
    reward1 < risk * config.minimumRR1 ||
    reward1 > config.maxTargetDistance ||
    rr1 < config.minimumRR1
  ) {
    return false;
  }

  if (tp2 !== null) {
    const reward2 = Math.abs(tp2 - entry);
    const rr2 = risk > 0 ? reward2 / risk : 0;
    const separation = Math.abs(tp2 - tp1);

    const tp2IsStructural = structuralTargets.some(
      (price) => Math.abs(price - tp2) <= 0.25
    );

    if (
      !isCorrectTarget(direction, tp1, tp2) ||
      !tp2IsStructural ||
      separation < config.minimumTPSeparation ||
      reward2 < risk * config.minimumRR2 ||
      reward2 > config.maxTargetDistance ||
      rr2 < config.minimumRR2
    ) {
      return false;
    }
  }

  return true;
}

async function deactivateLock(lock) {
  const query = new URLSearchParams({
    setup_id: `eq.${lock.setup_id}`,
  });

  await supabaseRequest(`${TABLE}?${query.toString()}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "INACTIVE",
      updated_at: new Date().toISOString(),
    }),
  });
}

async function saveLock(setup, mode) {
  if (!supabaseConfig()) {
    return {
      enabled: false,
      persisted: false,
      reason: "Supabase belum dikonfigurasi.",
    };
  }

  if (
    setup.status !== "READY" ||
    !setup.plan?.valid ||
    !Number.isFinite(setup.plan.tp1) ||
    !setup.zone?.valid
  ) {
    return {
      enabled: true,
      persisted: false,
      reason: "Setup belum layak untuk disimpan.",
    };
  }

  const setupId = makeSetupId(mode, setup.direction, setup.zone);

  const row = {
    setup_id: setupId,
    symbol: SETTINGS.symbol,
    mode,
    direction: setup.direction,
    zone_low: setup.zone.low,
    zone_high: setup.zone.high,
    entry: setup.plan.entry,
    stop_loss: setup.plan.sl,
    tp1: setup.plan.tp1,
    tp2: setup.plan.tp2,
    source: setup.zone.source,
    status: "ACTIVE",
    updated_at: new Date().toISOString(),
  };

  try {
    const query = new URLSearchParams({ on_conflict: "setup_id" });

    await supabaseRequest(`${TABLE}?${query.toString()}`, {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    });

    return {
      enabled: true,
      persisted: true,
      reused: false,
      setupId,
      reason: null,
    };
  } catch (error) {
    return {
      enabled: true,
      persisted: false,
      reused: false,
      reason: error.message,
    };
  }
}

/* =========================================================
   APPLY EXISTING SETUP LOCK
   Uses M15 candles to revalidate the stored SL.
========================================================= */

async function applyExistingLock(
  setup,
  mode,
  config,
  targetCandles,
  secondaryCandles,
  stopCandles
) {
  if (!supabaseConfig() || !setup.zone?.valid) return setup;

  try {
    const locks = await getActiveLocks(mode);

    const matching = locks.find((lock) =>
      lockStillFresh(lock, config) &&
      lock.direction === setup.direction &&
      Math.abs(Number(lock.zone_low) - setup.zone.low) <= 0.25 &&
      Math.abs(Number(lock.zone_high) - setup.zone.high) <= 0.25
    );

    if (!matching) return setup;

    const storedEntry = Number(matching.entry);
    const storedZoneLow = Number(matching.zone_low);
    const storedZoneHigh = Number(matching.zone_high);

    if (
      !Number.isFinite(storedEntry) ||
      !Number.isFinite(storedZoneLow) ||
      !Number.isFinite(storedZoneHigh)
    ) {
      await deactivateLock(matching);
      return setup;
    }

    const lockedZoneForValidation = {
      ...setup.zone,
      low: storedZoneLow,
      high: storedZoneHigh,
      entry: storedEntry,
      pivot: storedEntry,
      valid: true,
    };

    const expectedStop = buildStructuralStop(
      setup.direction,
      lockedZoneForValidation,
      stopCandles || targetCandles,
      config.maxRiskDistance
    );

    const structuralTargets = findTargets(
      setup.direction,
      storedEntry,
      targetCandles,
      secondaryCandles
    );

    const validStoredPlan = validateStoredPlan(
      matching,
      setup.direction,
      config,
      structuralTargets,
      expectedStop
    );

    if (!validStoredPlan) {
      await deactivateLock(matching);
      return setup;
    }

    const lockedZone = {
      ...setup.zone,
      low: storedZoneLow,
      high: storedZoneHigh,
      entry: storedEntry,
      pivot: storedEntry,
      source: matching.source || setup.zone.source,
      locked: true,
      setupId: matching.setup_id,
    };

    const entry = storedEntry;
    const sl = Number(matching.stop_loss);
    const tp1 = Number(matching.tp1);
    const tp2 = matching.tp2 == null ? null : Number(matching.tp2);

    const risk = round(Math.abs(entry - sl));
    const reward1 = round(Math.abs(tp1 - entry));
    const reward2 = tp2 === null ? null : round(Math.abs(tp2 - entry));

    const lockedPlan = {
      valid: true,
      entry,
      sl,
      tp1,
      tp2,
      risk,
      reward1,
      reward2,
      rr1: round(reward1 / risk),
      rr2: reward2 === null ? null : round(reward2 / risk),
      reason: tp2 === null
        ? "TP1 sah; TP2 struktur seterusnya belum memenuhi syarat."
        : null,
    };

    const ready = setup.score >= config.minimumScore;

    return {
      ...setup,
      zone: lockedZone,
      plan: lockedPlan,
      status: ready ? "READY" : "WAIT",
      reason: ready
        ? (lockedZone.status === "WATCH"
          ? "Zon dikunci; tunggu harga menghampiri zon."
          : lockedPlan.reason)
        : `Score ${setup.score} belum mencapai minimum ${config.minimumScore}.`,
      signalLock: {
        enabled: true,
        persisted: true,
        reused: true,
        setupId: matching.setup_id,
        reason: null,
      },
    };
  } catch (error) {
    return {
      ...setup,
      signalLock: {
        enabled: true,
        persisted: false,
        reused: false,
        reason: error.message,
      },
    };
  }
}

/* =========================================================
   SETUP BUILDER
========================================================= */

function buildSetup({
  mode,
  cmp,
  direction,
  trendH1,
  entryCandles,
  targetCandles,
  secondaryCandles,
  stopCandles,
  entryStructure,
  config,
}) {
  const zone = buildEarlyZone(
    entryCandles,
    direction,
    cmp,
    mode
  );

  if (!zone.valid) {
    return {
      mode,
      direction,
      status: "WAIT",
      score: 0,
      zone,
      plan: {
        valid: false,
        entry: null,
        sl: null,
        tp1: null,
        tp2: null,
        risk: null,
        reason: zone.reason,
      },
      reason: zone.reason,
    };
  }

  // Entry zone kekal pada timeframe entry.
  // SL dikira menggunakan stopCandles, iaitu M15 untuk kedua-dua mode.
  const stop = buildStructuralStop(
    direction,
    zone,
    stopCandles || entryCandles,
    config.maxRiskDistance
  );

  const plan = buildTradePlan(
    direction,
    zone,
    stop,
    targetCandles,
    secondaryCandles,
    config
  );

  const score = calculateScore(
    direction,
    trendH1,
    entryStructure.direction,
    zone,
    entryStructure
  );

  const status =
    zone.valid &&
    plan.valid &&
    Number.isFinite(plan.tp1) &&
    score >= config.minimumScore
      ? "READY"
      : "WAIT";

  let reason = null;

  if (!plan.valid) {
    reason = plan.reason;
  } else if (score < config.minimumScore) {
    reason = `Score ${score} belum mencapai minimum ${config.minimumScore}.`;
  } else if (zone.status === "WATCH") {
    reason = "Setup READY; zon masih WATCH. Tunggu harga menghampiri zon.";
  } else if (zone.status === "APPROACHING") {
    reason = "Setup READY; harga sedang menghampiri zon.";
  } else if (plan.tp2 === null) {
    reason = plan.reason;
  }

  return {
    mode,
    direction,
    status,
    score,
    zone,
    plan,
    reason,
    trend: {
      h1: trendH1,
      entry: entryStructure.direction,
    },
    signalLock: {
      enabled: Boolean(supabaseConfig()),
      persisted: false,
      reason: null,
    },
  };
}

/* =========================================================
   API HANDLER
========================================================= */

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return json(res, 405, {
      success: false,
      error: "Method tidak dibenarkan. Gunakan GET atau POST.",
    });
  }

  try {
    const [d1, h1, m15, m5] = await Promise.all([
      fetchCandles(TIMEFRAMES.D1),
      fetchCandles(TIMEFRAMES.H1),
      fetchCandles(TIMEFRAMES.M15),
      fetchCandles(TIMEFRAMES.M5),
    ]);

    const cmp = round(m5[m5.length - 1].close);

    const d1Structure = buildStructure(d1);
    const h1Structure = buildStructure(h1);
    const m15Structure = buildStructure(m15);
    const m5Structure = buildStructure(m5);

    const h1Trend = h1Structure.direction;
    const d1Trend = d1Structure.direction;

    const preferredTrend =
      h1Trend !== "NEUTRAL" ? h1Trend : d1Trend;

    const direction =
      preferredTrend === "BULLISH"
        ? "BUY"
        : preferredTrend === "BEARISH"
          ? "SELL"
          : null;

    let scalping;
    let intraday;

    if (!direction) {
      const neutralSetup = (mode) => ({
        mode,
        direction: "WAIT",
        status: "WAIT",
        score: 0,
        zone: {
          valid: false,
          low: null,
          high: null,
          entry: null,
          pivot: null,
          source: null,
          status: "WATCH",
          distance: null,
        },
        plan: {
          valid: false,
          entry: null,
          sl: null,
          tp1: null,
          tp2: null,
          risk: null,
          reason: "Arah D1 dan H1 belum jelas.",
        },
        reason: "Arah D1 dan H1 belum jelas; elakkan memaksa signal.",
        signalLock: {
          enabled: Boolean(supabaseConfig()),
          persisted: false,
          reason: "Tiada setup arah yang layak.",
        },
      });

      scalping = neutralSetup("scalping");
      intraday = neutralSetup("intraday");
    } else {
      scalping = buildSetup({
        mode: "scalping",
        cmp,
        direction,
        trendH1: h1Trend,
        entryCandles: m5,
        targetCandles: m5,
        secondaryCandles: m15,
        stopCandles: m15,
        entryStructure: m5Structure,
        config: SETTINGS.scalping,
      });

      intraday = buildSetup({
        mode: "intraday",
        cmp,
        direction,
        trendH1: h1Trend,
        entryCandles: m15,
        targetCandles: m15,
        secondaryCandles: h1,
        stopCandles: m15,
        entryStructure: m15Structure,
        config: SETTINGS.intraday,
      });

      scalping = await applyExistingLock(
        scalping,
        "scalping",
        SETTINGS.scalping,
        m5,
        m15,
        m15
      );

      intraday = await applyExistingLock(
        intraday,
        "intraday",
        SETTINGS.intraday,
        m15,
        h1,
        m15
      );

      if (!scalping.signalLock?.reused) {
        scalping.signalLock = await saveLock(scalping, "scalping");
      }

      if (!intraday.signalLock?.reused) {
        intraday.signalLock = await saveLock(intraday, "intraday");
      }
    }

    const mainSetup =
      intraday.status === "READY"
        ? intraday
        : scalping.status === "READY"
          ? scalping
          : null;

    const mainSignal = mainSetup
      ? mainSetup.direction
      : "WAIT";

    const mainPlan = mainSetup?.plan || {
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      risk: null,
      valid: false,
      reason:
        intraday.reason ||
        scalping.reason ||
        "Belum ada setup yang memenuhi syarat.",
    };

    const mainZone = mainSetup?.zone || null;

    return json(res, 200, {
      success: true,
      symbol: SETTINGS.symbol,
      timestamp: new Date().toISOString(),
      cmp,

      signal: mainSignal,
      direction: {
        D1: d1Trend,
        H1: h1Trend,
        M15: m15Structure.direction,
        M5: m5Structure.direction,
      },

      entry: mainPlan.entry,
      sl: mainPlan.sl,
      tp1: mainPlan.tp1,
      tp2: mainPlan.tp2,
      risk: mainPlan.risk,

      maxAllowedRisk: mainSetup
        ? SETTINGS[mainSetup.mode].maxRiskDistance
        : null,

      punca: mainZone
        ? {
            price: mainZone.pivot,
            source: mainZone.source,
          }
        : {
            price: null,
            source: null,
          },

      zone: mainZone,
      waitReason: mainSetup
        ? mainSetup.reason
        : mainPlan.reason,

      scores: {
        buy: direction === "BUY"
          ? Math.max(scalping.score || 0, intraday.score || 0)
          : 0,
        sell: direction === "SELL"
          ? Math.max(scalping.score || 0, intraday.score || 0)
          : 0,
      },

      scalping,
      intraday,

      marketStructure: {
        D1: d1Structure,
        H1: h1Structure,
        M15: m15Structure,
        M5: m5Structure,
      },

      signalLock: {
        enabled: Boolean(supabaseConfig()),
        scalping: scalping.signalLock,
        intraday: intraday.signalLock,
      },

      settings: {
        zoneThickness: SETTINGS.zoneThickness,
        minimumScore: {
          scalping: SETTINGS.scalping.minimumScore,
          intraday: SETTINGS.intraday.minimumScore,
        },
        minimumRR: {
          scalping: {
            tp1: SETTINGS.scalping.minimumRR1,
            tp2: SETTINGS.scalping.minimumRR2,
          },
          intraday: {
            tp1: SETTINGS.intraday.minimumRR1,
            tp2: SETTINGS.intraday.minimumRR2,
          },
        },
        minimumTPSeparation: {
          scalping: SETTINGS.scalping.minimumTPSeparation,
          intraday: SETTINGS.intraday.minimumTPSeparation,
        },
        maxRiskDistance: {
          scalping: SETTINGS.scalping.maxRiskDistance,
          intraday: SETTINGS.intraday.maxRiskDistance,
        },
        maxTargetDistance: {
          scalping: SETTINGS.scalping.maxTargetDistance,
          intraday: SETTINGS.intraday.maxTargetDistance,
        },
        timeframes: TIMEFRAMES,
      },

      data: {
        candleCount: {
          D1: d1.length,
          H1: h1.length,
          M15: m15.length,
          M5: m5.length,
        },
        latestCandle: {
          D1: d1[d1.length - 1].time,
          H1: h1[h1.length - 1].time,
          M15: m15[m15.length - 1].time,
          M5: m5[m5.length - 1].time,
        },
      },
    });
  } catch (error) {
    console.error("[SINNCI AI analyze]", error);

    return json(res, 500, {
      success: false,
      error: "Analisis XAU/USD gagal.",
      message: error.message || "Ralat tidak diketahui.",
      timestamp: new Date().toISOString(),
    });
  }
};
