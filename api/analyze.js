/**
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Rules:
 * - Zone: 20 pips ($2.00) uniform for both modes
 * - SL: 35 pips ($3.50) uniform for both modes
 * - Scalping TP: TP1 60 pips ($6.00), TP2 120 pips ($12.00)
 * - Intraday TP: TP1 130 pips ($13.00), TP2 220 pips ($22.00)
 * - TF Scalping: H1 -> M5 -> M1 (Bucu, Breakout & Reentry M5, dua hala fleksibel)
 * - TF Intraday: H1 -> M15 -> M5 (MA 50 + SNR Bucu / Breakout / Reentry M15)
 * - Techniques: SNR Bucu + Breakout & React + Reentry Pullback
 *
 * Data source: Twelve Data time_series
 */

const SYMBOL = "XAU/USD";
const POINT_VALUE = 0.01;

const SETTINGS = {
  // 20 pips = 200 points = $2.00 zon ketebalan
  zoneThickness: 2.00,
  stopLossDistance: 3.50, // 35 pips = 350 points = $3.50 SL

  scalping: {
    tp1Distance: 6.00,    // 60 pips ($6.00)
    tp2Distance: 12.00,   // 120 pips ($12.00)
    minimumScore: 65
  },

  intraday: {
    tp1Distance: 13.00,   // 130 pips ($13.00)
    tp2Distance: 22.00,   // 220 pips ($22.00)
    minimumScore: 65
  },

  candleCount: 50,
  fetchTimeoutMs: 15000
};

// TF H4 dibuang untuk kelajuan API; H1, M15, M5, M1 dikekalkan
const TIMEFRAMES = {
  H1: { interval: "1h", ms: 60 * 60 * 1000 },
  M15: { interval: "15min", ms: 15 * 60 * 1000 },
  M5: { interval: "5min", ms: 5 * 60 * 1000 },
  M1: { interval: "1min", ms: 60 * 1000 }
};

function responseError(res, statusCode, code, message, details = null) {
  return res.status(statusCode).json({
    success: false,
    status: "error",
    code,
    error: message,
    details,
    symbol: "XAUUSD",
    source: "SINNCI AI",
    timestamp: new Date().toISOString()
  });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPrice(value) {
  return value === null || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(2));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateEMA(candles, period = 20) {
  if (!candles || !candles.length) return 0;
  if (candles.length < period) return candles[candles.length - 1].close;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((acc, c) => acc + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

function parseCandleTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeCandles(values) {
  if (!Array.isArray(values)) return [];

  return values
    .map((item) => {
      const time = parseCandleTime(item.datetime);
      return {
        time,
        datetime: item.datetime || null,
        open: toNumber(item.open),
        high: toNumber(item.high),
        low: toNumber(item.low),
        close: toNumber(item.close)
      };
    })
    .filter((candle) =>
      candle.time !== null &&
      candle.open !== null &&
      candle.high !== null &&
      candle.low !== null &&
      candle.close !== null &&
      candle.high >= candle.low
    )
    .sort((a, b) => a.time - b.time);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchCandles(key, timeframeKey) {
  const timeframe = TIMEFRAMES[timeframeKey];
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", timeframe.interval);
  url.searchParams.set("outputsize", String(SETTINGS.candleCount));
  url.searchParams.set("order", "DESC");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS.fetchTimeoutMs);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${timeframeKey}: Respons API bukan format JSON yang sah.`);
    }

    if (!response.ok || payload.status === "error" || payload.code) {
      const message = payload.message || payload.error || `HTTP ${response.status}`;
      throw new Error(`${timeframeKey}: ${message}`);
    }

    if (!Array.isArray(payload.values)) {
      throw new Error(`${timeframeKey}: Tiada data lilin pasaran.`);
    }

    const candles = normalizeCandles(payload.values);

    if (candles.length < 5) {
      throw new Error(`${timeframeKey}: Data lilin tidak mencukupi (${candles.length}).`);
    }

    return {
      candles,
      meta: {
        interval: timeframe.interval,
        usableCandles: candles.length,
        lastCandleTime: candles[candles.length - 1].datetime
      }
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${timeframeKey}: Permintaan API tamat masa.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findSwingLows(candles) {
  const result = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const value = candles[i].low;
    if (
      value <= candles[i - 1].low &&
      value <= candles[i - 2].low &&
      value <= candles[i + 1].low &&
      value <= candles[i + 2].low
    ) {
      result.push({ price: value, time: candles[i].datetime, index: i });
    }
  }
  return result;
}

function findSwingHighs(candles) {
  const result = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const value = candles[i].high;
    if (
      value >= candles[i - 1].high &&
      value >= candles[i - 2].high &&
      value >= candles[i + 1].high &&
      value >= candles[i + 2].high
    ) {
      result.push({ price: value, time: candles[i].datetime, index: i });
    }
  }
  return result;
}

// =========================================================================
// 1. ZON ENTRY (SNR BUCU + BREAKOUT & REACT + REENTRY PULLBACK)
// =========================================================================
function buildEarlyZone(candles, direction, price, maLevel) {
  if (!candles || !candles.length || price === null) {
    return { valid: false, low: null, high: null, reason: "Tiada data zon." };
  }

  const recent = candles.slice(-30);
  const swingLows = findSwingLows(recent);
  const swingHighs = findSwingHighs(recent);

  let pivot = null;
  let sourceTechnique = "ZONE_BUCU_SNR";
  let isBreakoutActive = false;
  let isReentryActive = false;

  // Kira aras EMA dinamik untuk pengesanan Reentry
  const tfEMA = calculateEMA(candles, 20);

  if (direction === "BUY") {
    // 1. TEKNIK: Breakout & React (RBS: Resistance yang pecah)
    const brokenResistance = swingHighs.filter((sh) => {
      const diff = price - sh.price;
      return diff >= 0 && diff <= 2.50; // Baru melepasi / sedang retest
    }).sort((a, b) => b.price - a.price);

    // 2. TEKNIK: Reentry Pullback ke sokongan dinamik EMA
    const isPullbackReentry = price >= tfEMA - 1.00 && Math.abs(price - tfEMA) <= 1.50;

    if (brokenResistance.length > 0) {
      pivot = brokenResistance[0].price;
      sourceTechnique = "BREAKOUT_REACT_RBS";
      isBreakoutActive = true;
    } else if (isPullbackReentry) {
      pivot = tfEMA;
      sourceTechnique = "REENTRY_PULLBACK";
      isReentryActive = true;
    } else {
      // 3. TEKNIK ASAL: Bucu Support Terdekat
      const candidates = swingLows
        .filter((point) => point.price <= price)
        .sort((a, b) => b.price - a.price);
      pivot = candidates.length > 0 ? candidates[0].price : (maLevel || price);
      sourceTechnique = "ZONE_BUCU_SNR";
    }
  } else {
    // 1. TEKNIK: Breakout & React (SBR: Support yang pecah)
    const brokenSupport = swingLows.filter((sl) => {
      const diff = sl.price - price;
      return diff >= 0 && diff <= 2.50; // Baru melepasi / sedang retest
    }).sort((a, b) => a.price - b.price);

    // 2. TEKNIK: Reentry Pullback ke rintangan dinamik EMA
    const isPullbackReentry = price <= tfEMA + 1.00 && Math.abs(price - tfEMA) <= 1.50;

    if (brokenSupport.length > 0) {
      pivot = brokenSupport[0].price;
      sourceTechnique = "BREAKOUT_REACT_SBR";
      isBreakoutActive = true;
    } else if (isPullbackReentry) {
      pivot = tfEMA;
      sourceTechnique = "REENTRY_PULLBACK";
      isReentryActive = true;
    } else {
      // 3. TEKNIK ASAL: Bucu Resistance Terdekat
      const candidates = swingHighs
        .filter((point) => point.price >= price)
        .sort((a, b) => a.price - b.price);
      pivot = candidates.length > 0 ? candidates[0].price : (maLevel || price);
      sourceTechnique = "ZONE_BUCU_SNR";
    }
  }

  // Zon 20 pips ($2.00) seragam: separuh lebar = 1.00
  const halfWidth = SETTINGS.zoneThickness / 2; // 1.00
  const low = roundPrice(pivot - halfWidth);
  const high = roundPrice(pivot + halfWidth);

  const inZone = price >= low && price <= high;
  const dist = direction === "BUY" ? Math.max(0, price - high) : Math.max(0, low - price);
  const isApproaching = dist <= 1.50;

  // Jika breakout, reentry atau CMP dalam zon, tandakan IN_ZONE
  const status = (isBreakoutActive || isReentryActive || inZone)
    ? "IN_ZONE"
    : (isApproaching ? "APPROACHING" : "WATCH");

  return {
    valid: true,
    low,
    high,
    pivot: roundPrice(pivot),
    widthPips: 20,
    source: sourceTechnique,
    isBreakout: isBreakoutActive,
    isReentry: isReentryActive,
    locked: true,
    status,
    reason: isBreakoutActive 
      ? `Breakout dikesan pada aras bucu ${roundPrice(pivot)}.`
      : isReentryActive
        ? `Reentry Pullback dikesan pada paras purata bergerak ${roundPrice(pivot)}.`
        : inZone 
          ? "Harga aktif dalam zon persediaan (20 pips)." 
          : `Zon entry sedia dipantau (${low} – ${high}).`,
    distanceFromZone: roundPrice(dist)
  };
}

// =========================================================================
// PENGESANAN SCALPING DUA HALA (UNLOCKED DARI TREND H1)
// =========================================================================
function resolveScalpDualMode(candlesM5, price, maLevel) {
  const buyZone = buildEarlyZone(candlesM5, "BUY", price, maLevel);
  const sellZone = buildEarlyZone(candlesM5, "SELL", price, maLevel);

  // Utamakan arah yang mempunyai Breakout, Reentry atau berada dalam zon aktif M5
  if (sellZone.isBreakout || sellZone.isReentry || sellZone.status === "IN_ZONE") {
    return { direction: "SELL", zone: sellZone };
  }
  if (buyZone.isBreakout || buyZone.isReentry || buyZone.status === "IN_ZONE") {
    return { direction: "BUY", zone: buyZone };
  }

  // Jika belum aktif, pilih arah persediaan yang paling hampir dengan CMP
  if (sellZone.distanceFromZone < buyZone.distanceFromZone) {
    return { direction: "SELL", zone: sellZone };
  }
  return { direction: "BUY", zone: buyZone };
}

// =========================================================================
// 2. MAPPING KHAS INTRADAY (UNTUK TUJUAN HOLD SETUP)
// =========================================================================
function buildIntradayMapping(candlesH1, direction, price, ema50H1) {
  const h1Recent = candlesH1.slice(-24);
  const h1Highs = h1Recent.map((c) => c.high);
  const h1Lows = h1Recent.map((c) => c.low);

  const highestH1 = Math.max(...h1Highs);
  const lowestH1 = Math.min(...h1Lows);

  const invalidationLevel = direction === "BUY" 
    ? roundPrice(lowestH1 - 0.50) 
    : roundPrice(highestH1 + 0.50);

  const nextTarget = direction === "BUY" ? roundPrice(highestH1) : roundPrice(lowestH1);
  const dynamicSR = roundPrice(ema50H1);

  return {
    phase: direction === "BUY" ? "BULLISH_EXPANSION" : "BEARISH_EXPANSION",
    dynamicSupportResistance: dynamicSR,
    rangeHigh: roundPrice(highestH1),
    rangeLow: roundPrice(lowestH1),
    nextMajorObstacle: nextTarget,
    structureInvalidation: invalidationLevel,
    holdRule: direction === "BUY"
      ? `Kekal HOLD selagi lilin bertahan di atas ${dynamicSR} (EMA 50 H1).`
      : `Kekal HOLD selagi lilin bertahan di bawah ${dynamicSR} (EMA 50 H1).`
  };
}

// Pelan Dagangan Tetap (SL 35 Pips, TP Mengikut Mod)
function buildFixedTradePlan(direction, price, tpSettings) {
  if (price === null || !Number.isFinite(price)) return null;

  const sl = direction === "BUY" 
    ? price - SETTINGS.stopLossDistance 
    : price + SETTINGS.stopLossDistance;
  const tp1 = direction === "BUY" 
    ? price + tpSettings.tp1Distance 
    : price - tpSettings.tp1Distance;
  const tp2 = direction === "BUY" 
    ? price + tpSettings.tp2Distance 
    : price - tpSettings.tp2Distance;

  return {
    entry: roundPrice(price),
    sl: roundPrice(sl),
    tp1: roundPrice(tp1),
    tp2: roundPrice(tp2)
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    return responseError(res, 405, "METHOD_NOT_ALLOWED", "Kaedah HTTP tidak dibenarkan.");
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return responseError(res, 500, "MISSING_API_KEY", "TWELVE_DATA_API_KEY tiada dalam Environment Vercel.");
  }

  try {
    const timeframeKeys = ["H1", "M15", "M5", "M1"];
    const fetched = [];

    for (const key of timeframeKeys) {
      const result = await fetchCandles(apiKey, key);
      fetched.push([key, result]);
      await sleep(150);
    }

    const data = Object.fromEntries(fetched);
    const candles = Object.fromEntries(timeframeKeys.map((key) => [key, data[key].candles]));

    const lastM1 = candles.M1[candles.M1.length - 1];
    const price = lastM1.close;

    // Moving Averages
    const ema8_H1 = calculateEMA(candles.H1, 8);
    const ema50_H1 = calculateEMA(candles.H1, 50);

    // 1. PENENTUAN ARAH
    // Scalping: Fleksibel dua hala berasaskan aksi harga bucu/breakout M5 (unlocked dari H1)
    const scalpResolved = resolveScalpDualMode(candles.M5, price, ema8_H1);
    const scalpDirection = scalpResolved.direction;
    const scalpZone = scalpResolved.zone;

    // Intraday: Mengikut trend EMA 50 H1 + CMP
    const intradayDirection = price >= ema50_H1 ? "BUY" : "SELL";
    const intraZone = buildEarlyZone(candles.M15, intradayDirection, price, ema50_H1);

    // 2. MAPPING KHAS INTRADAY
    const intradayMapping = buildIntradayMapping(candles.H1, intradayDirection, price, ema50_H1);

    // 3. KELULUSAN SKOR & STATUS (Breakout / Reentry / In Zone = 75, Approaching = 65)
    const scalpReady = scalpZone.status === "IN_ZONE" || scalpZone.status === "APPROACHING" || scalpZone.isBreakout || scalpZone.isReentry;
    const scalpScore = (scalpZone.isBreakout || scalpZone.isReentry || scalpZone.status === "IN_ZONE") ? 75 : (scalpZone.status === "APPROACHING" ? 65 : 45);

    const intraReady = intraZone.status === "IN_ZONE" || intraZone.status === "APPROACHING" || intraZone.isBreakout || intraZone.isReentry;
    const intraScore = (intraZone.isBreakout || intraZone.isReentry || intraZone.status === "IN_ZONE") ? 75 : (intraZone.status === "APPROACHING" ? 65 : 45);

    // Pelan Dagangan Lengkap
    const scalpPlan = buildFixedTradePlan(scalpDirection, price, SETTINGS.scalping);
    const intraPlan = buildFixedTradePlan(intradayDirection, price, SETTINGS.intraday);

    // Setup Scalping Payload
    const scalpingPayload = {
      setupId: `SINNCI-SCALPING-${scalpDirection}`,
      type: "SCALPING",
      timeframe: "H1 -> M5 -> M1",
      symbol: "XAUUSD",
      direction: scalpDirection,
      status: scalpReady ? "READY" : "WAIT",
      entryStatus: scalpReady ? "READY" : "WAIT",
      score: scalpScore,
      zone: scalpZone,
      plan: scalpPlan,
      reasons: scalpReady 
        ? [scalpZone.reason] 
        : ["Zon sedia. Menunggu sentuhan harga atau breakout."],
      lastUpdated: new Date().toISOString()
    };

    // Setup Intraday Payload
    const intradayPayload = {
      setupId: `SINNCI-INTRADAY-${intradayDirection}`,
      type: "INTRADAY",
      timeframe: "H1 -> M15 -> M5",
      symbol: "XAUUSD",
      direction: intradayDirection,
      status: intraReady ? "READY" : "WAIT",
      entryStatus: intraReady ? "READY" : "WAIT",
      score: intraScore,
      zone: intraZone,
      mapping: intradayMapping,
      plan: intraPlan,
      reasons: intraReady 
        ? [intraZone.reason + " " + intradayMapping.holdRule] 
        : [`Zon 20 pips dipetakan. ${intradayMapping.holdRule}`],
      lastUpdated: new Date().toISOString()
    };

    return res.status(200).json({
      success: true,
      status: "success",
      symbol: "XAUUSD",
      cmp: roundPrice(price),
      direction: {
        H1: price >= ema50_H1 ? "BULLISH" : "BEARISH",
        M15: intraZone.status,
        M5: scalpZone.status,
        M1: scalpReady ? "IN_ZONE" : "APPROACHING"
      },
      bias: scalpDirection === "BUY" ? "BULLISH" : "BEARISH",
      
      zone: scalpZone,
      intradayMapping,

      signal: {
        direction: scalpDirection,
        status: scalpReady ? `${scalpDirection} READY` : "WAIT",
        confirmation: scalpReady 
          ? `Zon aktif (${scalpZone.source})! Skor: ${scalpScore}` 
          : `Zon 20 pips sedia (${scalpZone.low} – ${scalpZone.high}).`
      },
      signalStatus: scalpReady ? "READY" : "WAIT",

      scalping: scalpingPayload,
      intraday: intradayPayload,

      punca: {
        source: scalpZone.source,
        price: scalpZone.pivot
      },
      score: scalpScore,
      settings: {
        zoneThicknessPips: 20,
        stopLossPips: 35,
        stopLossDistance: SETTINGS.stopLossDistance
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return responseError(
      res,
      502,
      "MARKET_DATA_ERROR",
      "Gagal memproses data pasaran.",
      error.message
    );
  }
}
