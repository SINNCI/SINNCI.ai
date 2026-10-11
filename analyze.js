/**
 * ============================================================================
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * NOT an automated trading/execution system.
 *
 * TIMEFRAMES:
 * D1  = broad market context
 * H1  = trend / directional bias
 * M15 = intraday structure and entry mapping
 * M5  = scalping structure and entry mapping
 *
 * METHODS:
 * - EMA20 / EMA50
 * - Support & Resistance (SNR)
 * - Swing structure
 * - Breakout & retest
 * - Reentry / pullback
 * - Early entry-zone mapping
 * - Structural stop loss
 * - SNR-based take profit
 *
 * OPTIONAL PERSISTENT SIGNAL LOCK:
 * Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * and create the table described after this code.
 *
 * Environment variables:
 * TWELVE_DATA_API_KEY
 * SUPABASE_URL                 (optional)
 * SUPABASE_SERVICE_ROLE_KEY    (optional)
 * ============================================================================
 */

const SYMBOL = "XAU/USD";
const POINT_VALUE = 0.01;

const SETTINGS = {
  zoneThickness: 2.00,
  candleCount: 50,
  fetchTimeoutMs: 15000,

  scalping: {
    minimumScore: 65,
    lockMinutes: 720,
    maxRiskDistance: 8.00,
    maxTargetDistance: 30.00,
  },

  intraday: {
    minimumScore: 65,
    lockMinutes: 4320,
    maxRiskDistance: 15.00,
    maxTargetDistance: 80.00,
  },
};

const TIMEFRAMES = {
  D1: {
    interval: "1day",
    ms: 86400000,
  },
  H1: {
    interval: "1h",
    ms: 3600000,
  },
  M15: {
    interval: "15min",
    ms: 900000,
  },
  M5: {
    interval: "5min",
    ms: 300000,
  },
};

// -----------------------------------------------------------------------------
// GENERAL HELPERS
// -----------------------------------------------------------------------------

function responseError(message, status = 500, extra = {}) {
  return {
    success: false,
    error: message,
    status,
    ...extra,
  };
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundPrice(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    ema = values[i] * multiplier + ema * (1 - multiplier);
  }

  return roundPrice(ema);
}

function parseCandleTime(value) {
  if (!value) return 0;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeCandles(values) {
  if (!Array.isArray(values)) return [];

  return values
    .map((candle) => ({
      datetime: candle.datetime || candle.date || null,
      open: toNumber(candle.open),
      high: toNumber(candle.high),
      low: toNumber(candle.low),
      close: toNumber(candle.close),
      volume: toNumber(candle.volume, 0),
    }))
    .filter(
      (candle) =>
        candle.open !== null &&
        candle.high !== null &&
        candle.low !== null &&
        candle.close !== null
    )
    .sort(
      (a, b) =>
        parseCandleTime(a.datetime) - parseCandleTime(b.datetime)
    );
}

function getCloses(candles) {
  return candles.map((candle) => candle.close);
}

function getLatest(candles) {
  return candles[candles.length - 1] || null;
}

function getRange(candles) {
  if (!candles.length) return null;

  return {
    high: Math.max(...candles.map((candle) => candle.high)),
    low: Math.min(...candles.map((candle) => candle.low)),
  };
}

// -----------------------------------------------------------------------------
// TWELVE DATA
// -----------------------------------------------------------------------------

async function fetchCandles(apiKey, timeframeKey) {
  const timeframe = TIMEFRAMES[timeframeKey];

  if (!timeframe) {
    throw new Error(`Unsupported timeframe: ${timeframeKey}`);
  }

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", timeframe.interval);
  url.searchParams.set("outputsize", String(SETTINGS.candleCount));
  url.searchParams.set("order", "ASC");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apiKey);

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    SETTINGS.fetchTimeoutMs
  );

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    const rawText = await response.text();

    let payload;

    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error(
        `Twelve Data returned a non-JSON response for ${timeframeKey}.`
      );
    }

    if (!response.ok || payload.status === "error" || payload.code) {
      throw new Error(
        payload.message ||
          payload.msg ||
          `Twelve Data request failed for ${timeframeKey}.`
      );
    }

    const candles = normalizeCandles(payload.values);

    if (candles.length < 20) {
      throw new Error(
        `Insufficient ${timeframeKey} candles: ${candles.length}.`
      );
    }

    return {
      candles,
      meta: {
        timeframe: timeframeKey,
        interval: timeframe.interval,
        count: candles.length,
        latestCandle: getLatest(candles)?.datetime || null,
      },
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Twelve Data request timed out for ${timeframeKey}.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// MARKET STRUCTURE / SWING DETECTION
// -----------------------------------------------------------------------------

function findSwingLows(candles, left = 2, right = 2) {
  const swings = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const current = candles[i];
    let isSwing = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].low <= current.low) {
        isSwing = false;
        break;
      }
    }

    if (!isSwing) continue;

    for (let j = 1; j <= right; j++) {
      if (candles[i + j].low < current.low) {
        isSwing = false;
        break;
      }
    }

    if (isSwing) {
      swings.push({
        price: roundPrice(current.low),
        index: i,
        datetime: current.datetime,
      });
    }
  }

  return swings;
}

function findSwingHighs(candles, left = 2, right = 2) {
  const swings = [];

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const current = candles[i];
    let isSwing = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= current.high) {
        isSwing = false;
        break;
      }
    }

    if (!isSwing) continue;

    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > current.high) {
        isSwing = false;
        break;
      }
    }

    if (isSwing) {
      swings.push({
        price: roundPrice(current.high),
        index: i,
        datetime: current.datetime,
      });
    }
  }

  return swings;
}

function buildStructure(candles) {
  const swingLows = findSwingLows(candles);
  const swingHighs = findSwingHighs(candles);

  const recent = candles.slice(-20);
  const range = getRange(recent);

  const last = getLatest(candles);
  const previous = candles[candles.length - 2] || last;

  const higherHigh =
    swingHighs.length >= 2 &&
    swingHighs[swingHighs.length - 1].price >
      swingHighs[swingHighs.length - 2].price;

  const higherLow =
    swingLows.length >= 2 &&
    swingLows[swingLows.length - 1].price >
      swingLows[swingLows.length - 2].price;

  const lowerHigh =
    swingHighs.length >= 2 &&
    swingHighs[swingHighs.length - 1].price <
      swingHighs[swingHighs.length - 2].price;

  const lowerLow =
    swingLows.length >= 2 &&
    swingLows[swingLows.length - 1].price <
      swingLows[swingLows.length - 2].price;

  const bullishStructure = higherHigh && higherLow;
  const bearishStructure = lowerHigh && lowerLow;

  const breakoutUp =
    last &&
    previous &&
    range &&
    last.close > previous.high &&
    last.close >= range.high - 0.05;

  const breakoutDown =
    last &&
    previous &&
    range &&
    last.close < previous.low &&
    last.close <= range.low + 0.05;

  return {
    swingLows,
    swingHighs,
    range,
    bullishStructure,
    bearishStructure,
    breakoutUp: Boolean(breakoutUp),
    breakoutDown: Boolean(breakoutDown),
    lastClose: last?.close ?? null,
  };
}

// -----------------------------------------------------------------------------
// DIRECTIONAL BIAS
// -----------------------------------------------------------------------------

function getTrend(candles, timeframeKey) {
  const closes = getCloses(candles);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const last = getLatest(candles);

  if (!last || ema20 === null || ema50 === null) {
    return {
      direction: "NEUTRAL",
      ema20,
      ema50,
      price: last?.close ?? null,
      strength: 0,
    };
  }

  let direction = "NEUTRAL";

  if (last.close > ema20 && ema20 > ema50) {
    direction = "BULLISH";
  } else if (last.close < ema20 && ema20 < ema50) {
    direction = "BEARISH";
  } else if (last.close > ema50) {
    direction = "BULLISH";
  } else if (last.close < ema50) {
    direction = "BEARISH";
  }

  let strength = 0;

  if (direction === "BULLISH") {
    strength =
      (last.close > ema20 ? 1 : 0) +
      (ema20 > ema50 ? 1 : 0);
  } else if (direction === "BEARISH") {
    strength =
      (last.close < ema20 ? 1 : 0) +
      (ema20 < ema50 ? 1 : 0);
  }

  return {
    timeframe: timeframeKey,
    direction,
    ema20,
    ema50,
    price: last.close,
    strength,
  };
}

function directionToSide(direction) {
  if (direction === "BULLISH") return "BUY";
  if (direction === "BEARISH") return "SELL";
  return "WAIT";
}

// -----------------------------------------------------------------------------
// TRENDLINE
// -----------------------------------------------------------------------------

function calculateTrendline(candles) {
  const structure = buildStructure(candles);

  const lows = structure.swingLows.slice(-2);
  const highs = structure.swingHighs.slice(-2);

  let supportLine = null;
  let resistanceLine = null;

  if (lows.length === 2) {
    const a = lows[0];
    const b = lows[1];

    supportLine = {
      from: a.price,
      to: b.price,
      slope: roundPrice(b.price - a.price),
      direction:
        b.price > a.price
          ? "UP"
          : b.price < a.price
            ? "DOWN"
            : "FLAT",
    };
  }

  if (highs.length === 2) {
    const a = highs[0];
    const b = highs[1];

    resistanceLine = {
      from: a.price,
      to: b.price,
      slope: roundPrice(b.price - a.price),
      direction:
        b.price > a.price
          ? "UP"
          : b.price < a.price
            ? "DOWN"
            : "FLAT",
    };
  }

  return {
    supportLine,
    resistanceLine,
  };
}

// -----------------------------------------------------------------------------
// EARLY ENTRY ZONE
// -----------------------------------------------------------------------------

function buildEarlyZone(
  candles,
  direction,
  currentPrice,
  ema20,
  timeframeKey
) {
  const recent = candles.slice(-35);
  const structure = buildStructure(recent);

  const swingLows = structure.swingLows;
  const swingHighs = structure.swingHighs;

  const halfWidth = SETTINGS.zoneThickness / 2;

  let pivot = null;
  let source = "SNR";
  let isBreakout = false;
  let isReentry = false;
  let reason = "";

  if (direction === "BUY") {
    // A recently broken resistance may become support.
    const brokenResistance = swingHighs
      .filter(
        (swing) =>
          swing.price < currentPrice &&
          currentPrice - swing.price <= 8
      )
      .sort((a, b) => b.price - a.price)[0];

    // Prefer the nearest meaningful support beneath current price.
    const support = swingLows
      .filter((swing) => swing.price <= currentPrice)
      .sort((a, b) => b.price - a.price)[0];

    if (
      brokenResistance &&
      currentPrice - brokenResistance.price <= 5
    ) {
      pivot = brokenResistance.price;
      source = "SNR_BREAKOUT_RETEST";
      isBreakout = true;
      reason = "Resistance lama berpotensi bertukar menjadi support.";
    } else if (
      support &&
      currentPrice - support.price <= 10
    ) {
      pivot = support.price;
      source = "SNR_SUPPORT";
      reason = "Zon support berdasarkan swing low.";
    } else if (ema20 !== null && currentPrice >= ema20) {
      pivot = ema20;
      source = "EMA20_PULLBACK";
      isReentry = true;
      reason = "Kawasan pullback EMA20 dalam bias BUY.";
    } else if (support) {
      pivot = support.price;
      source = "SNR_SUPPORT";
      reason = "Support struktur terdekat.";
    }
  } else if (direction === "SELL") {
    const brokenSupport = swingLows
      .filter(
        (swing) =>
          swing.price > currentPrice &&
          swing.price - currentPrice <= 8
      )
      .sort((a, b) => a.price - b.price)[0];

    const resistance = swingHighs
      .filter((swing) => swing.price >= currentPrice)
      .sort((a, b) => a.price - b.price)[0];

    if (
      brokenSupport &&
      brokenSupport.price - currentPrice <= 5
    ) {
      pivot = brokenSupport.price;
      source = "SNR_BREAKDOWN_RETEST";
      isBreakout = true;
      reason = "Support lama berpotensi bertukar menjadi resistance.";
    } else if (
      resistance &&
      resistance.price - currentPrice <= 10
    ) {
      pivot = resistance.price;
      source = "SNR_RESISTANCE";
      reason = "Zon resistance berdasarkan swing high.";
    } else if (ema20 !== null && currentPrice <= ema20) {
      pivot = ema20;
      source = "EMA20_PULLBACK";
      isReentry = true;
      reason = "Kawasan pullback EMA20 dalam bias SELL.";
    } else if (resistance) {
      pivot = resistance.price;
      source = "SNR_RESISTANCE";
      reason = "Resistance struktur terdekat.";
    }
  }

  if (pivot === null || !Number.isFinite(pivot)) {
    return {
      valid: false,
      low: null,
      high: null,
      pivot: null,
      widthPips: SETTINGS.zoneThickness / POINT_VALUE,
      source: "NO_VALID_SNR",
      isBreakout: false,
      isReentry: false,
      locked: false,
      status: "WAIT",
      reason: "Struktur SNR yang sesuai belum dikenal pasti.",
      distanceFromZone: null,
      timeframe: timeframeKey,
    };
  }

  const low = roundPrice(pivot - halfWidth);
  const high = roundPrice(pivot + halfWidth);

  let distanceFromZone = 0;
  let status = "WATCH";

  if (currentPrice < low) {
    distanceFromZone = roundPrice(low - currentPrice);
  } else if (currentPrice > high) {
    distanceFromZone = roundPrice(currentPrice - high);
  }

  if (currentPrice >= low && currentPrice <= high) {
    status = "IN_ZONE";
  } else if (distanceFromZone <= 3) {
    status = "APPROACHING";
  }

  if (isBreakout) {
    reason = reason || "Breakout dan retest pada struktur SNR.";
  } else if (isReentry) {
    reason = reason || "Reentry / pullback pada EMA20.";
  } else {
    reason = reason || "Zon dipetakan daripada struktur SNR.";
  }

  return {
    valid: true,
    low,
    high,
    pivot: roundPrice(pivot),
    widthPips: SETTINGS.zoneThickness / POINT_VALUE,
    source,
    isBreakout,
    isReentry,
    locked: false,
    status,
    reason,
    distanceFromZone,
    timeframe: timeframeKey,
  };
}

// -----------------------------------------------------------------------------
// STRUCTURAL STOP LOSS
// -----------------------------------------------------------------------------

function buildStructuralStop(
  candles,
  direction,
  zone
) {
  if (!zone || !zone.valid) return null;

  const recent = candles.slice(-35);
  const structure = buildStructure(recent);

  if (direction === "BUY") {
    const lows = structure.swingLows
      .filter((swing) => swing.price < zone.low)
      .sort((a, b) => b.price - a.price);

    if (lows.length) {
      return roundPrice(lows[0].price - 0.50);
    }

    return structure.range
      ? roundPrice(structure.range.low - 0.50)
      : null;
  }

  if (direction === "SELL") {
    const highs = structure.swingHighs
      .filter((swing) => swing.price > zone.high)
      .sort((a, b) => a.price - b.price);

    if (highs.length) {
      return roundPrice(highs[0].price + 0.50);
    }

    return structure.range
      ? roundPrice(structure.range.high + 0.50)
      : null;
  }

  return null;
}

// -----------------------------------------------------------------------------
// SNR TARGETS
// -----------------------------------------------------------------------------

function uniquePrices(prices) {
  const result = [];

  for (const value of prices) {
    if (!Number.isFinite(value)) continue;

    const rounded = roundPrice(value);

    if (!result.some((existing) => Math.abs(existing - rounded) < 0.10)) {
      result.push(rounded);
    }
  }

  return result;
}

function findTargets(
  direction,
  entry,
  targetCandles,
  secondaryCandles
) {
  const primary = targetCandles.slice(-40);
  const secondary = secondaryCandles.slice(-40);

  const primaryStructure = buildStructure(primary);
  const secondaryStructure = buildStructure(secondary);

  let candidates = [];

  if (direction === "BUY") {
    candidates = [
      ...primaryStructure.swingHighs.map((swing) => swing.price),
      ...secondaryStructure.swingHighs.map((swing) => swing.price),
    ]
      .filter((price) => price > entry)
      .sort((a, b) => a - b);
  } else {
    candidates = [
      ...primaryStructure.swingLows.map((swing) => swing.price),
      ...secondaryStructure.swingLows.map((swing) => swing.price),
    ]
      .filter((price) => price < entry)
      .sort((a, b) => b - a);
  }

  return uniquePrices(candidates);
}

function buildTradePlan(
  direction,
  zone,
  stopLoss,
  targetCandles,
  secondaryCandles,
  mode
) {
  if (!zone?.valid || stopLoss === null) {
    return {
      entry: null,
      stopLoss: null,
      tp1: null,
      tp2: null,
      riskDistance: null,
      rewardDistanceTP1: null,
      rewardDistanceTP2: null,
      riskRewardTP1: null,
      riskRewardTP2: null,
      valid: false,
      reason: "Entry zone atau structural SL belum tersedia.",
    };
  }

  const entry = zone.pivot;
  const riskDistance = roundPrice(Math.abs(entry - stopLoss));

  const maxRisk =
    mode === "SCALPING"
      ? SETTINGS.scalping.maxRiskDistance
      : SETTINGS.intraday.maxRiskDistance;

  if (
    riskDistance <= 0 ||
    riskDistance > maxRisk ||
    (direction === "BUY" && stopLoss >= zone.low) ||
    (direction === "SELL" && stopLoss <= zone.high)
  ) {
    return {
      entry,
      stopLoss,
      tp1: null,
      tp2: null,
      riskDistance,
      rewardDistanceTP1: null,
      rewardDistanceTP2: null,
      riskRewardTP1: null,
      riskRewardTP2: null,
      valid: false,
      reason:
        "Setup ditolak kerana jarak SL atau kedudukan SL tidak sesuai dengan struktur.",
    };
  }

  const targets = findTargets(
    direction,
    entry,
    targetCandles,
    secondaryCandles
  );

  const maxTarget =
    mode === "SCALPING"
      ? SETTINGS.scalping.maxTargetDistance
      : SETTINGS.intraday.maxTargetDistance;

  const validTargets = targets.filter((target) => {
    const distance = Math.abs(target - entry);

    return distance > 0 && distance <= maxTarget;
  });

  const tp1 = validTargets[0] ?? null;
  const tp2 = validTargets.find(
    (target) =>
      tp1 !== null &&
      (direction === "BUY" ? target > tp1 : target < tp1)
  ) ?? null;

  if (tp1 === null) {
    return {
      entry,
      stopLoss,
      tp1: null,
      tp2: null,
      riskDistance,
      rewardDistanceTP1: null,
      rewardDistanceTP2: null,
      riskRewardTP1: null,
      riskRewardTP2: null,
      valid: false,
      reason: "Tiada target SNR yang munasabah ditemui.",
    };
  }

  const rewardDistanceTP1 = roundPrice(Math.abs(tp1 - entry));
  const rewardDistanceTP2 =
    tp2 === null ? null : roundPrice(Math.abs(tp2 - entry));

  return {
    entry,
    stopLoss,
    tp1,
    tp2,
    riskDistance,
    rewardDistanceTP1,
    rewardDistanceTP2,
    riskRewardTP1: roundPrice(rewardDistanceTP1 / riskDistance),
    riskRewardTP2:
      rewardDistanceTP2 === null
        ? null
        : roundPrice(rewardDistanceTP2 / riskDistance),
    valid: true,
    reason: "Entry berdasarkan zon SNR; SL dan TP dipetakan daripada struktur harga.",
  };
}

// -----------------------------------------------------------------------------
// SCORING
// -----------------------------------------------------------------------------

function calculateScore({
  direction,
  h1Trend,
  d1Trend,
  zone,
  structure,
  mode,
}) {
  if (!zone?.valid || direction === "WAIT") return 0;

  let score = 50;

  if (h1Trend.direction === directionToSide(direction)) {
    score += 15;
  }

  if (d1Trend.direction === directionToSide(direction)) {
    score += mode === "INTRADAY" ? 12 : 5;
  }

  if (
    direction === "BUY" &&
    structure.bullishStructure
  ) {
    score += 8;
  }

  if (
    direction === "SELL" &&
    structure.bearishStructure
  ) {
    score += 8;
  }

  if (zone.source.startsWith("SNR")) {
    score += 5;
  }

  if (zone.isBreakout) {
    score += 5;
  }

  if (zone.isReentry) {
    score += 3;
  }

  if (zone.status === "IN_ZONE") {
    score += 2;
  }

  return clamp(Math.round(score), 0, 95);
}

// -----------------------------------------------------------------------------
// OPTIONAL SUPABASE PERSISTENT SIGNAL LOCK
// -----------------------------------------------------------------------------

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) return null;

  return {
    url: url.replace(/\/+$/, ""),
    key,
  };
}

async function supabaseRequest(path, options = {}) {
  const config = getSupabaseConfig();

  if (!config) return null;

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase error ${response.status}: ${body}`);
  }

  if (!body) return [];

  try {
    return JSON.parse(body);
  } catch {
    return [];
  }
}

async function getActiveLock(mode) {
  if (!getSupabaseConfig()) return null;

  const query =
    `sinnci_setup_locks?select=*` +
    `&symbol=eq.XAUUSD` +
    `&mode=eq.${encodeURIComponent(mode)}` +
    `&status=eq.ACTIVE` +
    `&order=updated_at.desc` +
    `&limit=1`;

  const rows = await supabaseRequest(query);

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function isLockUsable(lock, direction, currentPrice, mode) {
  if (!lock) return false;
  if (lock.direction !== direction) return false;

  const createdAt = Date.parse(lock.updated_at || lock.created_at || "");
  if (!Number.isFinite(createdAt)) return false;

  const maxAge =
    (mode === "SCALPING"
      ? SETTINGS.scalping.lockMinutes
      : SETTINGS.intraday.lockMinutes) * 60000;

  if (Date.now() - createdAt > maxAge) return false;

  const sl = toNumber(lock.stop_loss);
  const zoneLow = toNumber(lock.zone_low);
  const zoneHigh = toNumber(lock.zone_high);

  if (
    sl === null ||
    zoneLow === null ||
    zoneHigh === null
  ) {
    return false;
  }

  // Invalidate the old setup if its structural SL is broken.
  if (direction === "BUY" && currentPrice <= sl) return false;
  if (direction === "SELL" && currentPrice >= sl) return false;

  return true;
}

function applyLockToSetup(setup, lock) {
  if (!setup || !lock) return setup;

  setup.setupId = lock.setup_id;
  setup.direction = lock.direction;

  setup.zone = {
    valid: true,
    low: toNumber(lock.zone_low),
    high: toNumber(lock.zone_high),
    pivot: toNumber(lock.entry),
    widthPips: SETTINGS.zoneThickness / POINT_VALUE,
    source: lock.source || "SNR_LOCKED",
    isBreakout: false,
    isReentry: false,
    locked: true,
    status: "LOCKED",
    reason: "Setup dikekalkan daripada rekod Signal Lock.",
    distanceFromZone: null,
    timeframe: setup.zone?.timeframe || null,
  };

  setup.plan = {
    entry: toNumber(lock.entry),
    stopLoss: toNumber(lock.stop_loss),
    tp1: toNumber(lock.tp1),
    tp2: toNumber(lock.tp2),
    valid: true,
    reason: "Trade plan dikekalkan daripada rekod Signal Lock.",
  };

  setup.status = "READY";
  setup.entryStatus = "READY";
  setup.signalStatus = "LOCKED";

  return setup;
}

async function saveLock(mode, setup) {
  if (!getSupabaseConfig()) {
    return {
      persisted: false,
      reason: "Supabase Signal Lock belum dikonfigurasi.",
    };
  }

  if (!setup || setup.status !== "READY" || !setup.plan?.valid) {
    return {
      persisted: false,
      reason: "Setup belum layak untuk disimpan.",
    };
  }

  const zone = setup.zone;
  const plan = setup.plan;

  const setupId = [
    "SINNCI",
    mode,
    setup.direction,
    Number(zone.low).toFixed(2),
    Number(zone.high).toFixed(2),
  ].join("-");

  const now = new Date().toISOString();

  const row = {
    setup_id: setupId,
    symbol: "XAUUSD",
    mode,
    direction: setup.direction,
    zone_low: zone.low,
    zone_high: zone.high,
    entry: plan.entry,
    stop_loss: plan.stopLoss,
    tp1: plan.tp1,
    tp2: plan.tp2,
    source: zone.source,
    status: "ACTIVE",
    updated_at: now,
  };

  const result = await supabaseRequest(
    "sinnci_setup_locks?on_conflict=setup_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    }
  );

  return {
    persisted: true,
    setupId,
    record: Array.isArray(result) ? result[0] ?? null : null,
  };
}

async function invalidateLock(lock) {
  if (!lock || !getSupabaseConfig()) return;

  const setupId = encodeURIComponent(lock.setup_id);

  await supabaseRequest(
    `sinnci_setup_locks?setup_id=eq.${setupId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "INVALIDATED",
        updated_at: new Date().toISOString(),
      }),
    }
  );
}

// -----------------------------------------------------------------------------
// SETUP BUILDER
// -----------------------------------------------------------------------------

function buildSetup({
  mode,
  direction,
  timeframe,
  candles,
  secondaryCandles,
  currentPrice,
  h1Trend,
  d1Trend,
}) {
  const isScalping = mode === "SCALPING";

  const ema20 = calculateEMA(getCloses(candles), 20);

  const zone = buildEarlyZone(
    candles,
    direction,
    currentPrice,
    ema20,
    timeframe
  );

  const structure = buildStructure(candles);

  const stopLoss = buildStructuralStop(
    candles,
    direction,
    zone
  );

  const plan = buildTradePlan(
    direction,
    zone,
    stopLoss,
    candles,
    secondaryCandles,
    mode
  );

  const score = calculateScore({
    direction,
    h1Trend,
    d1Trend,
    zone,
    structure,
    mode,
  });

  const minimumScore = isScalping
    ? SETTINGS.scalping.minimumScore
    : SETTINGS.intraday.minimumScore;

  const ready =
    zone.valid &&
    plan.valid &&
    score >= minimumScore;

  const setupId = [
    "SINNCI",
    mode,
    direction,
    zone.valid ? zone.pivot.toFixed(2) : "NOZONE",
  ].join("-");

  return {
    setupId,
    type: mode,
    timeframe: isScalping
      ? "D1 -> H1 -> M5"
      : "D1 -> H1 -> M15",
    symbol: "XAUUSD",
    direction,
    status: ready ? "READY" : "WAIT",
    entryStatus: ready ? "READY" : "WAIT",
    signalStatus: ready ? "EARLY_SIGNAL" : "WAIT",
    score,
    zone,
    plan,
    reasons: ready
      ? [
          zone.reason,
          plan.reason,
          "Signal boleh dikenal pasti sebelum harga menyentuh zon.",
        ]
      : [
          !zone.valid
            ? zone.reason
            : !plan.valid
              ? plan.reason
              : "Skor setup belum mencapai tahap minimum.",
        ],
    structure: {
      bullish: structure.bullishStructure,
      bearish: structure.bearishStructure,
      breakoutUp: structure.breakoutUp,
      breakoutDown: structure.breakoutDown,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// MAIN API HANDLER
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!["GET", "POST"].includes(req.method)) {
    return res
      .status(405)
      .json(responseError("Method not allowed.", 405));
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json(
      responseError(
        "TWELVE_DATA_API_KEY belum ditetapkan dalam Vercel Environment Variables."
      )
    );
  }

  try {
    // Four timeframe requests; M1 is intentionally removed.
    const timeframeKeys = ["D1", "H1", "M15", "M5"];

    const fetched = await Promise.all(
      timeframeKeys.map((key) => fetchCandles(apiKey, key))
    );

    const candles = {};
    const dataMeta = {};

    timeframeKeys.forEach((key, index) => {
      candles[key] = fetched[index].candles;
      dataMeta[key] = fetched[index].meta;
    });

    const latestM5 = getLatest(candles.M5);
    const latestH1 = getLatest(candles.H1);

    // The latest M5 close is used as the analysis CMP.
    // This avoids adding a separate price API request.
    const price = roundPrice(
      latestM5?.close ?? latestH1?.close
    );

    if (!Number.isFinite(price)) {
      throw new Error("Unable to determine current market price.");
    }

    const d1Trend = getTrend(candles.D1, "D1");
    const h1Trend = getTrend(candles.H1, "H1");
    const m15Trend = getTrend(candles.M15, "M15");
    const m5Trend = getTrend(candles.M5, "M5");

    const h1Structure = buildStructure(candles.H1);
    const m15Structure = buildStructure(candles.M15);
    const m5Structure = buildStructure(candles.M5);

    // Scalping follows H1 direction. M5 is used for the entry mapping.
    let scalpDirection = directionToSide(h1Trend.direction);

    if (scalpDirection === "WAIT") {
      scalpDirection = directionToSide(m5Trend.direction);
    }

    // Intraday uses H1 direction with D1 as broader context.
    let intradayDirection = directionToSide(h1Trend.direction);

    if (intradayDirection === "WAIT") {
      intradayDirection = directionToSide(d1Trend.direction);
    }

    const scalpSetup = buildSetup({
      mode: "SCALPING",
      direction: scalpDirection,
      timeframe: "M5",
      candles: candles.M5,
      secondaryCandles: candles.H1,
      currentPrice: price,
      h1Trend,
      d1Trend,
    });

    const intradaySetup = buildSetup({
      mode: "INTRADAY",
      direction: intradayDirection,
      timeframe: "M15",
      candles: candles.M15,
      secondaryCandles: candles.H1,
      currentPrice: price,
      h1Trend,
      d1Trend,
    });

    // -----------------------------------------------------------------------
    // Persistent locks are optional. If Supabase is configured, preserve an
    // existing valid lock; otherwise return the newly calculated setup.
    // -----------------------------------------------------------------------

    let scalpLockStatus = {
      enabled: Boolean(getSupabaseConfig()),
      persisted: false,
      reason: "No existing lock applied.",
    };

    let intradayLockStatus = {
      enabled: Boolean(getSupabaseConfig()),
      persisted: false,
      reason: "No existing lock applied.",
    };

    if (getSupabaseConfig()) {
      try {
        const activeScalpLock = await getActiveLock("SCALPING");

        if (
          isLockUsable(
            activeScalpLock,
            scalpDirection,
            price,
            "SCALPING"
          )
        ) {
          applyLockToSetup(scalpSetup, activeScalpLock);

          scalpLockStatus = {
            enabled: true,
            persisted: true,
            setupId: activeScalpLock.setup_id,
            reason: "Existing scalping setup lock preserved.",
          };
        } else {
          if (activeScalpLock) {
            await invalidateLock(activeScalpLock);
          }

          const saved = await saveLock("SCALPING", scalpSetup);

          scalpLockStatus = {
            enabled: true,
            ...saved,
          };
        }
      } catch (error) {
        scalpLockStatus = {
          enabled: true,
          persisted: false,
          reason: error.message,
        };
      }

      try {
        const activeIntradayLock = await getActiveLock("INTRADAY");

        if (
          isLockUsable(
            activeIntradayLock,
            intradayDirection,
            price,
            "INTRADAY"
          )
        ) {
          applyLockToSetup(intradaySetup, activeIntradayLock);

          intradayLockStatus = {
            enabled: true,
            persisted: true,
            setupId: activeIntradayLock.setup_id,
            reason: "Existing intraday setup lock preserved.",
          };
        } else {
          if (activeIntradayLock) {
            await invalidateLock(activeIntradayLock);
          }

          const saved = await saveLock("INTRADAY", intradaySetup);

          intradayLockStatus = {
            enabled: true,
            ...saved,
          };
        }
      } catch (error) {
        intradayLockStatus = {
          enabled: true,
          persisted: false,
          reason: error.message,
        };
      }
    }

    const mainSetup =
      intradaySetup.status === "READY"
        ? intradaySetup
        : scalpSetup;

    const topDirection =
      mainSetup.status === "READY"
        ? mainSetup.direction
        : "WAIT";

    const response = {
      success: true,
      status:
        scalpSetup.status === "READY" ||
        intradaySetup.status === "READY"
          ? "READY"
          : "WAIT",

      symbol: "XAUUSD",
      cmp: price,

      direction: {
        D1: d1Trend.direction,
        H1: h1Trend.direction,
        M15: intradaySetup.zone.status,
        M5: scalpSetup.zone.status,
      },

      bias: {
        overall: h1Trend.direction,
        daily: d1Trend.direction,
        hourly: h1Trend.direction,
        scalping: scalpDirection,
        intraday: intradayDirection,
      },

      zone: mainSetup.zone,
      intradayMapping: {
        timeframe: "H1 -> M15",
        direction: intradayDirection,
        range: h1Structure.range,
        invalidation:
          intradayDirection === "BUY"
            ? h1Structure.range?.low ?? null
            : intradayDirection === "SELL"
              ? h1Structure.range?.high ?? null
              : null,
        phase:
          intradayDirection === "BUY"
            ? "BULLISH_CONTEXT"
            : intradayDirection === "SELL"
              ? "BEARISH_CONTEXT"
              : "NEUTRAL",
        holdRule:
          "Selagi struktur H1 tidak invalid, nilai semula zon berdasarkan struktur dan Signal Lock.",
      },

      signal: {
        direction: topDirection,
        status: mainSetup.status,
        confirmation: "NO_CANDLE_CONFIRMATION_REQUIRED",
        entryMode: "EARLY_ZONE",
        reason:
          mainSetup.reasons?.[0] ||
          "Belum ada setup yang memenuhi syarat.",
      },

      signalStatus: mainSetup.signalStatus,

      scalping: scalpSetup,
      intraday: intradaySetup,

      punca: {
        source: mainSetup.zone?.source || "NONE",
        price: mainSetup.zone?.pivot ?? null,
      },

      score: mainSetup.score,

      trendline: {
        H1: calculateTrendline(candles.H1),
        M15: calculateTrendline(candles.M15),
        M5: calculateTrendline(candles.M5),
      },

      marketStructure: {
        H1: {
          bullish: h1Structure.bullishStructure,
          bearish: h1Structure.bearishStructure,
          range: h1Structure.range,
        },
        M15: {
          bullish: m15Structure.bullishStructure,
          bearish: m15Structure.bearishStructure,
          range: m15Structure.range,
        },
        M5: {
          bullish: m5Structure.bullishStructure,
          bearish: m5Structure.bearishStructure,
          range: m5Structure.range,
        },
      },

      signalLock: {
        scalping: scalpLockStatus,
        intraday: intradayLockStatus,
      },

      settings: {
        zoneThickness: SETTINGS.zoneThickness,
        zoneThicknessPips:
          SETTINGS.zoneThickness / POINT_VALUE,
        timeframes: ["D1", "H1", "M15", "M5"],
        scalpingMinimumScore: SETTINGS.scalping.minimumScore,
        intradayMinimumScore: SETTINGS.intraday.minimumScore,
        stopLossMethod: "STRUCTURAL_SWING",
        takeProfitMethod: "SNR_TARGETS",
        confirmationRequired: false,
      },

      data: dataMeta,
      timestamp: new Date().toISOString(),
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("[SINNCI AI] Analyze error:", error);

    return res.status(502).json(
      responseError(
        error.message || "Market analysis failed.",
        502
      )
    );
  }
}
