/**
 * SINNCI AI — XAU/USD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Analysis only. No automated trading or order execution.
 * ZONE ACCURACY > SIGNAL TIMING > SCORE
 *
 * H1 = primary trend/setup context.
 * M5 = scalping entry structure.
 * M15 = intraday entry structure.
 * Retracement candidate may be selected when primary H1 zone
 * is more than $3 away, provided its own setup is valid.
 *
 * SL: M15 first, M5 fallback.
 * TP1/TP2: structural targets only.
 */

const SETTINGS = {
  symbol: "XAU/USD",
  point: 0.01,
  zoneThickness: 2.00,
  priorityDistance: 3.00,
  approachDistance: 3.00,
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

    if (!result.some((existing) =>
      Math.abs(existing - value) <= tolerance
    )) {
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

function oppositeDirection(direction) {
  return direction === "BUY" ? "SELL" : "BUY";
}

function directionFromTrend(trend) {
  if (trend === "BULLISH") return "BUY";
  if (trend === "BEARISH") return "SELL";
  return null;
}

function isCorrectTarget(direction, entry, target) {
  if (!Number.isFinite(target)) return false;
  return isBuy(direction) ? target > entry : target < entry;
}

function distanceToZone(cmp, zone) {
  if (!zone || !zone.valid) return Infinity;
  if (cmp < zone.low) return round(zone.low - cmp);
  if (cmp > zone.high) return round(cmp - zone.high);
  return 0;
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
    const higherHigh = lastHighs[1].price > lastHighs[0].price;
    const higherLow = lastLows[1].price > lastLows[0].price;
    const lowerHigh = lastHighs[1].price < lastHighs[0].price;
    const lowerLow = lastLows[1].price < lastLows[0].price;

    if (higherHigh && higherLow) direction = "BULLISH";
    else if (lowerHigh && lowerLow) direction = "BEARISH";
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  if (direction === "NEUTRAL" && ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) direction = "BULLISH";
    else if (last.close < ema20 && ema20 < ema50) direction = "BEARISH";
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
      timeframe: mode === "scalping" ? "M5" : "M15",
    };
  }

  const half = SETTINGS.zoneThickness / 2;
  const low = round(pivot - half);
  const high = round(pivot + half);

  let status = "WATCH";

  if (cmp >= low && cmp <= high) {
    status = "IN_ZONE";
  } else if (buy && cmp > high &&
    cmp - high <= SETTINGS.approachDistance) {
    status = "APPROACHING";
  } else if (!buy && cmp < low &&
    low - cmp <= SETTINGS.approachDistance) {
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
    distance: distanceToZone(cmp, { low, high, valid: true }),
    timeframe: mode === "scalping" ? "M5" : "M15",
    reason: null,
  };
}

/* =========================================================
   STRUCTURAL STOP LOSS
   Priority: M15 first, then M5 fallback.
========================================================= */

function buildStructuralStop(
  direction,
  zone,
  candles,
  maxRisk,
  fallbackCandles = null
) {
  if (!zone || !Number.isFinite(zone.entry)) {
    return {
      value: null,
      risk: null,
      valid: false,
      source: null,
      reason: "Entry zone tidak sah untuk pengiraan SL.",
    };
  }

  const buy = isBuy(direction);
  const entry = zone.entry;

  const sources = [
    { candles, timeframe: "M15" },
    ...(Array.isArray(fallbackCandles) && fallbackCandles.length
      ? [{ candles: fallbackCandles, timeframe: "M5" }]
      : []),
  ];

  for (const item of sources) {
    const swings = findSwings(item.candles.slice(-35), 2);

    const candidates = buy
      ? swings.lows.map((s) => s.price).filter((p) => p < zone.low)
      : swings.highs.map((s) => s.price).filter((p) => p > zone.high);

    candidates.sort((a, b) => buy ? b - a : a - b);

    for (const level of candidates) {
      const candidate = buy
        ? round(level - 0.50)
        : round(level + 0.50);

      const risk = round(Math.abs(entry - candidate));
      const correctSide = buy
        ? candidate < zone.low
        : candidate > zone.high;

      if (correctSide && risk > 0 && risk <= maxRisk) {
        return {
          value: candidate,
          risk,
          valid: true,
          source: item.timeframe,
          reason: null,
        };
      }
    }
  }

  return {
    value: null,
    risk: null,
    valid: false,
    source: null,
    reason:
      `Tiada swing M15 atau M5 yang sah dalam had risiko $${maxRisk.toFixed(2)}.`,
  };
}

/* =========================================================
   STRUCTURAL TARGET CANDIDATES
========================================================= */

function findTargets(direction, entry, targetCandles, secondaryCandles) {
  const primary = buildStructure(targetCandles.slice(-40));
  const secondary = buildStructure(secondaryCandles.slice(-40));

  let candidates;

  if (isBuy(direction)) {
    candidates = [
      ...primary.swingHighs.map((s) => s.price),
      ...secondary.swingHighs.map((s) => s.price),
      primary.range?.high,
      secondary.range?.high,
    ];
  } else {
    candidates = [
      ...primary.swingLows.map((s) => s.price),
      ...secondary.swingLows.map((s) => s.price),
      primary.range?.low,
      secondary.range?.low,
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
  const invalidPlan = (reason) => ({
    valid: false,
    entry: zone?.entry ?? null,
    sl: stopResult?.value ?? null,
    tp1: null,
    tp2: null,
    risk: stopResult?.risk ?? null,
    reward1: null,
    reward2: null,
    rr1: null,
    rr2: null,
    reason,
  });

  if (!zone?.valid || !stopResult?.valid) {
    return invalidPlan(
      stopResult?.reason || "SL tidak sah atau risiko melebihi had."
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
    return invalidPlan("Risiko SL tidak sah atau melebihi had.");
  }

  const structuralTargets = findTargets(
    direction, entry, primary, secondary
  );

  const validTargets = structuralTargets.filter((price) => {
    const reward = Math.abs(price - entry);
    return (
      isCorrectTarget(direction, entry, price) &&
      reward >= risk * config.minimumRR1 &&
      reward <= config.maxTargetDistance &&
      reward / risk >= config.minimumRR1
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

    return (
      isCorrectTarget(direction, tp1, price) &&
      separation >= config.minimumTPSeparation &&
      reward >= risk * config.minimumRR2 &&
      reward <= config.maxTargetDistance &&
      reward / risk >= config.minimumRR2
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
      reason: "TP1 sah; TP2 struktur seterusnya belum memenuhi syarat.",
    };
  }

  const reward2 = round(Math.abs(tp2 - entry));

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
    rr2: round(reward2 / risk),
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

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers,
  });

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
    limit: "50",
  });

  return await supabaseRequest(`${TABLE}?${query.toString()}`, {
    method: "GET",
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

async function deactivateLock(lock) {
  const query = new URLSearchParams({
    setup_id: `eq.${lock.setup_id}`,
    status: "eq.ACTIVE",
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

function lockInvalidationReason(lock, cmp) {
  const direction = lock.direction;
  const sl = Number(lock.stop_loss);
  const tp1 = Number(lock.tp1);

  if (![sl, tp1].every(Number.isFinite)) {
    return "Pelan lock tidak lengkap.";
  }

  if (direction === "BUY") {
    if (cmp <= sl) return "Harga telah mencapai SL BUY.";
    if (cmp >= tp1) return "Harga telah mencapai TP1 BUY.";
  } else if (direction === "SELL") {
    if (cmp >= sl) return "Harga telah mencapai SL SELL.";
    if (cmp <= tp1) return "Harga telah mencapai TP1 SELL.";
  } else {
    return "Arah setup lock tidak sah.";
  }

  return null;
}

/*
 * Resolve the existing lock once per mode.
 * If old duplicate ACTIVE rows exist, keep the newest valid one
 * and deactivate the other rows to reduce conflicting locks.
 */
async function getCanonicalActiveLock(mode, config, cmp) {
  const locks = await getActiveLocks(mode);
  const valid = [];

  for (const lock of locks) {
    if (!lockStillFresh(lock, config)) {
      await deactivateLock(lock);
      continue;
    }

    const invalidReason = lockInvalidationReason(lock, cmp);

    if (invalidReason) {
      await deactivateLock(lock);
      continue;
    }

    valid.push(lock);
  }

  if (!valid.length) return null;

  const canonical = valid[0];

  for (const duplicate of valid.slice(1)) {
    await deactivateLock(duplicate);
  }

  return canonical;
}

function planFromLock(lock, mode, cmp) {
  const entry = Number(lock.entry);
  const low = Number(lock.zone_low);
  const high = Number(lock.zone_high);
  const sl = Number(lock.stop_loss);
  const tp1 = Number(lock.tp1);
  const tp2 = lock.tp2 == null ? null : Number(lock.tp2);

  if (
    ![entry, low, high, sl, tp1].every(Number.isFinite) ||
    high <= low
  ) {
    return null;
  }

  const direction = lock.direction;
  const risk = round(Math.abs(entry - sl));
  const reward1 = round(Math.abs(tp1 - entry));
  const reward2 = tp2 === null ? null : round(Math.abs(tp2 - entry));

  const correctSL = isBuy(direction) ? sl < low : sl > high;

  if (
    !correctSL ||
    !isCorrectTarget(direction, entry, tp1) ||
    risk <= 0 ||
    risk > 4
  ) {
    return null;
  }

  if (tp2 !== null) {
    if (
      !isCorrectTarget(direction, tp1, tp2) ||
      Math.abs(tp2 - tp1) < 5
    ) {
      return null;
    }
  }

  let zoneStatus = "WATCH";

  if (cmp >= low && cmp <= high) {
    zoneStatus = "IN_ZONE";
  } else if (distanceToZone(cmp, { low, high, valid: true }) <=
    SETTINGS.approachDistance) {
    zoneStatus = "APPROACHING";
  }

  return {
    zone: {
      valid: true,
      low,
      high,
      entry,
      pivot: entry,
      source: lock.source || "SNR_STRUCTURE",
      status: zoneStatus,
      distance: distanceToZone(cmp, { low, high, valid: true }),
      timeframe: mode === "scalping" ? "M5" : "M15",
      locked: true,
      setupId: lock.setup_id,
      reason: null,
    },
    plan: {
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
      reason: tp2 === null ? "TP1 sah; TP2 belum tersedia." : null,
    },
  };
}

async function applyModeLock(setups, mode, config, cmp) {
  if (!supabaseConfig()) {
    return { setups, activeLock: null, error: null };
  }

  try {
    const active = await getCanonicalActiveLock(mode, config, cmp);

    if (!active) {
      return { setups, activeLock: null, error: null };
    }

    const locked = planFromLock(active, mode, cmp);

    if (!locked) {
      await deactivateLock(active);
      return { setups, activeLock: null, error: null };
    }

    const updated = setups.map((setup) => {
      if (setup.direction !== active.direction) {
        return {
          ...setup,
          blockedByActiveLock: true,
          activeLockDirection: active.direction,
          activeLockSetupId: active.setup_id,
        };
      }

      return {
        ...setup,
        status: "READY",
        zone: locked.zone,
        plan: locked.plan,
        reason: locked.zone.status === "WATCH"
          ? "Setup dikunci; tunggu harga menghampiri zon."
          : locked.zone.status === "APPROACHING"
            ? "Setup dikunci; harga menghampiri zon."
            : "Setup dikunci; harga berada dalam zon.",
        signalLock: {
          enabled: true,
          persisted: true,
          reused: true,
          setupId: active.setup_id,
          reason: null,
        },
      };
    });

    return {
      setups: updated,
      activeLock: active,
      error: null,
    };
  } catch (error) {
    return {
      setups,
      activeLock: null,
      error: error.message,
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
  fallbackStopCandles,
  entryStructure,
  config,
}) {
  const zone = buildEarlyZone(entryCandles, direction, cmp, mode);

  const base = {
    mode,
    direction,
    status: "WAIT",
    score: 0,
    zone,
    plan: {
      valid: false,
      entry: zone.entry,
      sl: null,
      tp1: null,
      tp2: null,
      risk: null,
      reward1: null,
      reward2: null,
      rr1: null,
      rr2: null,
      reason: zone.reason || "Setup belum dinilai.",
    },
    reason: zone.reason || null,
    trend: {
      h1: trendH1,
      entry: entryStructure.direction,
    },
    signalLock: {
      enabled: Boolean(supabaseConfig()),
      persisted: false,
      reused: false,
      reason: null,
    },
  };

  if (!zone.valid) return base;

  const stop = buildStructuralStop(
    direction,
    zone,
    stopCandles || entryCandles,
    config.maxRiskDistance,
    fallbackStopCandles
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
    ...base,
    status,
    score,
    zone,
    plan,
    reason,
  };
}

/* =========================================================
   SETUP PRIORITY
========================================================= */

function chooseBestCandidate(buySetup, sellSetup) {
  const candidates = [buySetup, sellSetup];

  const locked = candidates.find(
    (setup) => setup.signalLock?.reused === true
  );

  if (locked) return locked;

  const blocked = candidates.find(
    (setup) => setup.blockedByActiveLock === true
  );

  if (blocked) {
    return candidates.find(
      (setup) => setup.direction === blocked.activeLockDirection
    ) || blocked;
  }

  const ready = candidates
    .filter((setup) => setup.status === "READY")
    .sort((a, b) => b.score - a.score);

  if (ready.length) return ready[0];

  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const wanted = directionFromTrend(a.trend?.h1);

    if (wanted === a.direction) return -1;
    if (wanted === b.direction) return 1;

    return 0;
  })[0];
}

/*
 * The setup matching H1 is primary.
 * A counter-trend retracement candidate may be selected only when
 * the primary H1 zone is more than $3 away and retracement is READY.
 * This rule chooses priority; it does not guarantee profitability.
 */
function chooseTrendOrRetracement({
  buySetup,
  sellSetup,
  h1Trend,
  cmp,
  primaryH1Zone,
}) {
  const primaryDirection = directionFromTrend(h1Trend);

  if (!primaryDirection) {
    return chooseBestCandidate(buySetup, sellSetup);
  }

  const setups = { BUY: buySetup, SELL: sellSetup };
  const primary = setups[primaryDirection];
  const retracement = setups[oppositeDirection(primaryDirection)];

  const primaryDistance = distanceToZone(cmp, primaryH1Zone);
  const primaryFar = primaryDistance > SETTINGS.priorityDistance;

  if (
    primaryFar &&
    retracement.status === "READY" &&
    !retracement.signalLock?.reused &&
    !retracement.blockedByActiveLock
  ) {
    return {
      ...retracement,
      setupType: "RETRACEMENT",
      primaryH1Direction: primaryDirection,
      primaryH1Distance: primaryDistance,
      reason:
        "Setup retracement sah dipilih kerana zon utama H1 masih jauh.",
    };
  }

  if (primary.signalLock?.reused) return primary;
  if (primary.status === "READY") {
    return {
      ...primary,
      setupType: "FOLLOW_TREND",
      primaryH1Direction: primaryDirection,
      primaryH1Distance: primaryDistance,
    };
  }

  if (retracement.signalLock?.reused) return retracement;

  return chooseBestCandidate(buySetup, sellSetup);
}

/* =========================================================
   SAVE LOCK
========================================================= */

async function saveLock(setup, mode) {
  if (!supabaseConfig()) {
    return {
      enabled: false,
      persisted: false,
      reused: false,
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
      reused: false,
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
    /*
     * Deactivate other active rows for this mode before saving.
     * This reduces stale opposing locks. For strict concurrency
     * guarantees, enforce uniqueness/locking at database level too.
     */
    const oldLocks = await getActiveLocks(mode);

    for (const lock of oldLocks) {
      if (lock.setup_id !== setupId) {
        await deactivateLock(lock);
      }
    }

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

    /*
     * Build a separate H1 primary zone. This zone is used to
     * calculate distance/priority only; the actual trade plan
     * still uses the entry timeframe's own zone and risk checks.
     */
    const primaryH1Direction = directionFromTrend(h1Trend);

    const primaryH1Zone = primaryH1Direction
      ? buildEarlyZone(h1, primaryH1Direction, cmp, "intraday")
      : null;

    let scalpBuy = buildSetup({
      mode: "scalping",
      direction: "BUY",
      cmp,
      trendH1: h1Trend,
      entryCandles: m5,
      targetCandles: m5,
      secondaryCandles: m15,
      stopCandles: m15,
      fallbackStopCandles: m5,
      entryStructure: m5Structure,
      config: SETTINGS.scalping,
    });

    let scalpSell = buildSetup({
      mode: "scalping",
      direction: "SELL",
      cmp,
      trendH1: h1Trend,
      entryCandles: m5,
      targetCandles: m5,
      secondaryCandles: m15,
      stopCandles: m15,
      fallbackStopCandles: m5,
      entryStructure: m5Structure,
      config: SETTINGS.scalping,
    });

    let intraBuy = buildSetup({
      mode: "intraday",
      direction: "BUY",
      cmp,
      trendH1: h1Trend,
      entryCandles: m15,
      targetCandles: m15,
      secondaryCandles: h1,
      stopCandles: m15,
      fallbackStopCandles: m5,
      entryStructure: m15Structure,
      config: SETTINGS.intraday,
    });

    let intraSell = buildSetup({
      mode: "intraday",
      direction: "SELL",
      cmp,
      trendH1: h1Trend,
      entryCandles: m15,
      targetCandles: m15,
      secondaryCandles: h1,
      stopCandles: m15,
      fallbackStopCandles: m5,
      entryStructure: m15Structure,
      config: SETTINGS.intraday,
    });

    /*
     * Apply one canonical active lock per mode, instead of
     * independently querying/deactivating the same lock for BUY
     * and SELL evaluations.
     */
    const scalpLockResult = await applyModeLock(
      [scalpBuy, scalpSell],
      "scalping",
      SETTINGS.scalping,
      cmp
    );

    [scalpBuy, scalpSell] = scalpLockResult.setups;

    const intraLockResult = await applyModeLock(
      [intraBuy, intraSell],
      "intraday",
      SETTINGS.intraday,
      cmp
    );

    [intraBuy, intraSell] = intraLockResult.setups;

    let scalping = chooseTrendOrRetracement({
      buySetup: scalpBuy,
      sellSetup: scalpSell,
      h1Trend,
      cmp,
      primaryH1Zone,
    });

    let intraday = chooseTrendOrRetracement({
      buySetup: intraBuy,
      sellSetup: intraSell,
      h1Trend,
      cmp,
      primaryH1Zone,
    });

    /*
     * Do not save a new setup if an existing lock was reused.
     * Do not save a candidate blocked by the active lock.
     */
    if (
      !scalping.signalLock?.reused &&
      !scalping.blockedByActiveLock
    ) {
      scalping.signalLock = await saveLock(scalping, "scalping");
    }

    if (
      !intraday.signalLock?.reused &&
      !intraday.blockedByActiveLock
    ) {
      intraday.signalLock = await saveLock(intraday, "intraday");
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
        : { price: null, source: null },

      zone: mainZone,

      waitReason: mainSetup
        ? mainSetup.reason
        : mainPlan.reason,

      scores: {
        buy: Math.max(scalpBuy.score || 0, intraBuy.score || 0),
        sell: Math.max(scalpSell.score || 0, intraSell.score || 0),
      },

      candidates: {
        scalping: {
          buy: {
            status: scalpBuy.status,
            score: scalpBuy.score,
            zone: scalpBuy.zone,
            plan: scalpBuy.plan,
            reason: scalpBuy.reason,
          },
          sell: {
            status: scalpSell.status,
            score: scalpSell.score,
            zone: scalpSell.zone,
            plan: scalpSell.plan,
            reason: scalpSell.reason,
          },
        },
        intraday: {
          buy: {
            status: intraBuy.status,
            score: intraBuy.score,
            zone: intraBuy.zone,
            plan: intraBuy.plan,
            reason: intraBuy.reason,
          },
          sell: {
            status: intraSell.status,
            score: intraSell.score,
            zone: intraSell.zone,
            plan: intraSell.plan,
            reason: intraSell.reason,
          },
        },
      },

      scalping,
      intraday,

      primarySetup: {
        h1Direction: primaryH1Direction,
        h1Zone: primaryH1Zone,
        priorityDistance: SETTINGS.priorityDistance,
        distanceFromH1Zone: primaryH1Zone
          ? distanceToZone(cmp, primaryH1Zone)
          : null,
      },

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
        errors: {
          scalping: scalpLockResult.error,
          intraday: intraLockResult.error,
        },
      },

      settings: {
        zoneThickness: SETTINGS.zoneThickness,
        priorityDistance: SETTINGS.priorityDistance,
        approachDistance: SETTINGS.approachDistance,

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
