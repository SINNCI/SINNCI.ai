/**
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Execution Engine:
 * - Scalping: H1 -> M5 -> M1 (MA 8 + SNR Bucu + CMP)
 * - Intraday: H1 -> M15 -> M5 (MA 50 + SNR Bucu + CMP + Mapping Hold)
 * 
 * Rules:
 * - Zone: 20 pips ($2.00) uniform
 * - SL: 35 pips ($3.50) uniform
 * - Scalping TP: TP1 60 pips ($6.00), TP2 120 pips ($12.00)
 * - Intraday TP: TP1 130 pips ($13.00), TP2 220 pips ($22.00)
 * - Scoring Range: 65 - 75 (Early Mapping & Direct Touch Execution)
 * - TF H4: Removed for optimized API speed
 *
 * Data source: Twelve Data time_series
 */

const SYMBOL = "XAU/USD";

const SETTINGS = {
  // Zon 20 pips ($2.00) & SL 35 pips ($3.50)
  zoneThickness: 2.00,
  stopLossDistance: 3.50,

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

  candleCount: 40,
  fetchTimeoutMs: 15000
};

// TF H4 dibuang sepenuhnya untuk menjimatkan masa respons API
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

function calculateEMA(candles, period) {
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

// =========================================================================
// PENGESAN BUCU SNR (SWING HIGH & LOW)
// =========================================================================
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

// BINA ZON BUCU 20 PIPS ($2.00) — KELUAR AWAL & TERKUNCI
function buildZoneBucu(candles, direction, price, fallbackPivot) {
  if (!candles || !candles.length || price === null) {
    return { valid: false, low: null, high: null, reason: "Tiada data zon." };
  }

  const recent = candles.slice(-30);
  const swingPoints = direction === "BUY" ? findSwingLows(recent) : findSwingHighs(recent);

  const candidates = swingPoints
    .filter((point) => (direction === "BUY" ? point.price <= price : point.price >= price))
    .sort((a, b) => (direction === "BUY" ? b.price - a.price : a.price - b.price));

  const bucuPivot = candidates.length > 0 ? candidates[0].price : (fallbackPivot || price);

  // Zon 20 pips ($2.00) seragam: separuh lebar = 1.00 ($1.00 atas dan bawah bucu)
  const halfWidth = SETTINGS.zoneThickness / 2; // 1.00
  const low = roundPrice(bucuPivot - halfWidth);
  const high = roundPrice(bucuPivot + halfWidth);

  const inZone = price >= low && price <= high;
  const dist = direction === "BUY" ? Math.max(0, price - high) : Math.max(0, low - price);
  const isApproaching = dist <= 1.50; // Menghampiri dalam jarak 15 pips

  return {
    valid: true,
    low,
    high,
    pivot: roundPrice(bucuPivot),
    widthPips: 20,
    source: "ZONE_BUCU_SNR",
    locked: true,
    status: inZone ? "IN_ZONE" : isApproaching ? "APPROACHING" : "WATCH",
    reason: inZone 
      ? "Harga aktif dalam zon bucu (20 pips)." 
      : isApproaching 
        ? `Menghampiri zon bucu (${low} – ${high}). Bersedia.` 
        : `Zon bucu dikenal pasti (${low} – ${high}).`,
    distanceFromZone: roundPrice(dist)
  };
}

// MAPPING INTRADAY (H1) UNTUK HOLD POSITION
function buildIntradayMapping(candlesH1, direction, price, ema50H1) {
  const h1Recent = candlesH1.slice(-24);
  const highestH1 = Math.max(...h1Recent.map((c) => c.high));
  const lowestH1 = Math.min(...h1Recent.map((c) => c.low));

  const invalidationLevel = direction === "BUY" 
    ? roundPrice(lowestH1 - 0.50) 
    : roundPrice(highestH1 + 0.50);

  const nextTarget = direction === "BUY" ? roundPrice(highestH1) : roundPrice(lowestH1);
  const dynamicSR = roundPrice(ema50H1);

  return {
    phase: direction === "BUY" ? "BULLISH_HOLD" : "BEARISH_HOLD",
    dynamicSupportResistance: dynamicSR,
    rangeHigh: roundPrice(highestH1),
    rangeLow: roundPrice(lowestH1),
    nextMajorObstacle: nextTarget,
    structureInvalidation: invalidationLevel,
    holdRule: direction === "BUY"
      ? `Kekal HOLD selagi lilin bertahan di atas ${dynamicSR} (MA 50 H1).`
      : `Kekal HOLD selagi lilin bertahan di bawah ${dynamicSR} (MA 50 H1).`
  };
}

// PELAN DAGANGAN: SL TETAP 35 PIPS ($3.50)
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
    // 4 Timeframe pantas sahaja
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

    // 1. SCALPING (H1 -> M5 -> M1): MA 8 (H1) + SNR BUCU (M5) + CMP (M1)
    const scalpDirection = price >= ema8_H1 ? "BUY" : "SELL";
    const scalpZone = buildZoneBucu(candles.M5, scalpDirection, price, ema8_H1);

    // 2. INTRADAY (H1 -> M15 -> M5): MA 50 (H1) + SNR BUCU (M15) + CMP (M5) + MAPPING HOLD
    const intradayDirection = price >= ema50_H1 ? "BUY" : "SELL";
    const intraZone = buildZoneBucu(candles.M15, intradayDirection, price, ema50_H1);
    const intradayMapping = buildIntradayMapping(candles.H1, intradayDirection, price, ema50_H1);

    // ==========================================
    // SISTEM SKOR DILONGGARKAN (65 - 75)
    // ==========================================
    // Scalp: In zone = 75, Approaching = 65, Luar = 45
    const scalpInZone = scalpZone.status === "IN_ZONE";
    const scalpApproaching = scalpZone.status === "APPROACHING";
    const scalpScore = scalpInZone ? 75 : scalpApproaching ? 65 : 45;
    const scalpReady = scalpScore >= SETTINGS.scalping.minimumScore;

    // Intraday: In zone = 75, Approaching = 65, Luar = 45
    const intraInZone = intraZone.status === "IN_ZONE";
    const intraApproaching = intraZone.status === "APPROACHING";
    const intraScore = intraInZone ? 75 : intraApproaching ? 65 : 45;
    const intraReady = intraScore >= SETTINGS.intraday.minimumScore;

    const scalpPlan = buildFixedTradePlan(scalpDirection, price, SETTINGS.scalping);
    const intraPlan = buildFixedTradePlan(intradayDirection, price, SETTINGS.intraday);

    // Setup Scalping Payload (Label model dibuang)
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
        ? ["Zon bucu 20 pips aktif & sedia untuk eksekusi."] 
        : [`Zon bucu dikenal pasti (${scalpZone.low} – ${scalpZone.high}). Menghampiri zon.`],
      lastUpdated: new Date().toISOString()
    };

    // Setup Intraday Payload (Label model dibuang)
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
        ? [`Zon bucu 20 pips aktif. ${intradayMapping.holdRule}`] 
        : [`Zon bucu dipetakan (${intraZone.low} – ${intraZone.high}). ${intradayMapping.holdRule}`],
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
      
      // Zon Bucu Aktif Terus Dikeluarkan Awal
      zone: scalpZone,
      intradayMapping,

      signal: {
        direction: scalpDirection,
        status: scalpReady ? `${scalpDirection} READY` : "WAIT",
        confirmation: scalpReady 
          ? `Zon bucu 20 pips aktif (Skor: ${scalpScore})` 
          : `Zon bucu sedia dipantau (${scalpZone.low} – ${scalpZone.high}).`
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
