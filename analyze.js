/**
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Models:
 * 1. Scalping: MA 20 + SNR + CMP (Fast M1 Trigger)
 * 2. Intraday: SNR + MA 50 + CMP + Mapping (Structure Hold Analysis)
 * 
 * Rules:
 * - Zone: 35 pips ($3.50) uniform for both modes
 * - SL: 30 pips ($3.00) uniform for both modes
 * - Scalping TP: TP1 60 pips ($6.00), TP2 120 pips ($12.00)
 * - Intraday TP: TP1 130 pips ($13.00), TP2 220 pips ($22.00)
 * - Early Zone Mapping (Zone displayed early before Signal trigger)
 *
 * Data source: Twelve Data time_series
 */

const SYMBOL = "XAU/USD";
const POINT_VALUE = 0.01;

const SETTINGS = {
  // 35 pips = 350 points = $3.50 zon ketebalan
  zoneThickness: 3.50,
  stopLossDistance: 3.00, // 30 pips = 300 points = $3.00 SL

  scalping: {
    tp1Distance: 6.00,    // 60 pips ($6.00)
    tp2Distance: 12.00,   // 120 pips ($12.00) — Wajib TP
    minimumScore: 60
  },

  intraday: {
    tp1Distance: 13.00,   // 130 pips ($13.00)
    tp2Distance: 22.00,   // 220 pips ($22.00)
    minimumScore: 65
  },

  candleCount: 50,
  fetchTimeoutMs: 15000
};

const TIMEFRAMES = {
  H4: { interval: "4h", ms: 4 * 60 * 60 * 1000 },
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
// 1. ZON ENTRY KELUAR AWAL (PRE-MAPPED: 35 PIPS SERAGAM)
// =========================================================================
function buildEarlyZone(candles, direction, price, maLevel) {
  if (!candles || !candles.length || price === null) {
    return { valid: false, low: null, high: null, reason: "Tiada data zon." };
  }

  const recent = candles.slice(-30);
  const swingPoints = direction === "BUY" ? findSwingLows(recent) : findSwingHighs(recent);

  const candidates = swingPoints
    .filter((point) => (direction === "BUY" ? point.price <= price : point.price >= price))
    .sort((a, b) => (direction === "BUY" ? b.price - a.price : a.price - b.price));

  // Ambil swing terdekat, jika tiada ambil MA Level sebagai aras konfluens
  const pivot = candidates.length > 0 ? candidates[0].price : (maLevel || price);

  // Zon 35 pips ($3.50) seragam: separuh lebar = 1.75
  const halfWidth = SETTINGS.zoneThickness / 2; // 1.75
  const low = roundPrice(pivot - halfWidth);
  const high = roundPrice(pivot + halfWidth);

  const inZone = price >= low && price <= high;

  return {
    valid: true,
    low,
    high,
    pivot: roundPrice(pivot),
    widthPips: 35,
    source: "STRUCTURAL_SNR_CONFLUENCE",
    locked: true,
    status: inZone ? "IN_ZONE" : price < low ? "BELOW_ZONE" : "APPROACHING",
    reason: inZone 
      ? "Harga aktif dalam zon persediaan (35 pips)." 
      : `Zon entry sedia dipantau (${low} – ${high}).`,
    distanceFromZone: roundPrice(direction === "BUY" ? Math.max(0, price - high) : Math.max(0, low - price))
  };
}

// =========================================================================
// 2. MAPPING KHAS INTRADAY (UNTUK TUJUAN HOLD SETUP)
// =========================================================================
function buildIntradayMapping(candlesH4, candlesH1, direction, price, ema50H1) {
  const h1Recent = candlesH1.slice(-24);
  const h1Highs = h1Recent.map((c) => c.high);
  const h1Lows = h1Recent.map((c) => c.low);

  const highestH1 = Math.max(...h1Highs);
  const lowestH1 = Math.min(...h1Lows);

  // Aras Invalidasi Struktur: Jika pecah, batalkan setup hold serta-merta
  const invalidationLevel = direction === "BUY" 
    ? roundPrice(lowestH1 - 0.50) 
    : roundPrice(highestH1 + 0.50);

  // Halangan Ayunan Seterusnya (Roadmap swing target)
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

// =========================================================================
// 3. TRIGGER MOMENTUM PANTAS M1 (SCALPING — TANPA TUNGGU M5)
// =========================================================================
function getM1InstantTrigger(candlesM1, direction, price) {
  if (!candlesM1 || candlesM1.length < 2) {
    return { confirmed: false, status: "WAIT", reason: "Lilin M1 tidak mencukupi." };
  }

  const current = candlesM1[candlesM1.length - 1];
  const prev = candlesM1[candlesM1.length - 2];

  let confirmed = false;
  if (direction === "BUY") {
    confirmed = price >= prev.high || current.close > current.open;
  } else {
    confirmed = price <= prev.low || current.close < current.open;
  }

  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "WAIT",
    method: "M1_MOMENTUM_PULSE",
    reason: confirmed ? "Momentum M1 disahkan serta-merta." : "Menunggu lilin M1 bertukar arah."
  };
}

// =========================================================================
// 4. TRIGGER PENGESAHAN M5 (INTRADAY STRUCTURE)
// =========================================================================
function getM5StructureTrigger(candlesM5, direction, price) {
  if (!candlesM5 || candlesM5.length < 5) {
    return { confirmed: false, status: "WAIT", reason: "Lilin M5 tidak mencukupi." };
  }

  const last = candlesM5[candlesM5.length - 1];
  const previous = candlesM5.slice(-5, -1);

  if (direction === "BUY") {
    const referenceHigh = Math.max(...previous.map((c) => c.high));
    const confirmed = last.close >= referenceHigh || price >= referenceHigh;
    return {
      confirmed,
      status: confirmed ? "CONFIRMED" : "WAIT",
      reference: roundPrice(referenceHigh),
      reason: confirmed ? "M5 menembusi rintangan swing." : "Menunggu pengesahan M5."
    };
  }

  const referenceLow = Math.min(...previous.map((c) => c.low));
  const confirmed = last.close <= referenceLow || price <= referenceLow;
  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "WAIT",
    reference: roundPrice(referenceLow),
    reason: confirmed ? "M5 menembusi sokongan swing." : "Menunggu pengesahan M5."
  };
}

// Pelan Dagangan Tetap (SL 30 Pips, TP Mengikut Mod)
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
    const timeframeKeys = ["H4", "H1", "M15", "M5", "M1"];
    const fetched = [];

    for (const key of timeframeKeys) {
      const result = await fetchCandles(apiKey, key);
      fetched.push([key, result]);
      await sleep(150); // Mencegah sekatan kadar had API Twelve Data
    }

    const data = Object.fromEntries(fetched);
    const candles = Object.fromEntries(timeframeKeys.map((key) => [key, data[key].candles]));

    const lastM1 = candles.M1[candles.M1.length - 1];
    const price = lastM1.close;

    // Moving Averages
    const ema20_H1 = calculateEMA(candles.H1, 20);
    const ema50_H4 = calculateEMA(candles.H4, 50);
    const ema50_H1 = calculateEMA(candles.H1, 50);
    const ema50_M15 = calculateEMA(candles.M15, 50);

    // 1. PENENTUAN ARAH
    // Scalping: MA 20 H1 + CMP
    const scalpDirection = price >= ema20_H1 ? "BUY" : "SELL";
    // Intraday: EMA 50 H4 & H1 + CMP
    const intradayDirection = (price >= ema50_H4 && price >= ema50_H1) ? "BUY" : "SELL";

    // 2. PEMETAAN ZON AWAL (35 PIPS SERAGAM)
    const scalpZone = buildEarlyZone(candles.M15, scalpDirection, price, ema20_H1);
    const intraZone = buildEarlyZone(candles.M15, intradayDirection, price, ema50_M15);

    // 3. MAPPING KHAS INTRADAY
    const intradayMapping = buildIntradayMapping(candles.H4, candles.H1, intradayDirection, price, ema50_H1);

    // 4. TRIGGER PENGESAHAN
    // Scalping: M1 Instant Trigger
    const m1ScalpTrigger = getM1InstantTrigger(candles.M1, scalpDirection, price);
    // Intraday: M5 Structure Confirmation
    const m5IntraTrigger = getM5StructureTrigger(candles.M5, intradayDirection, price);

    const scalpReady = m1ScalpTrigger.confirmed && (scalpZone.status === "IN_ZONE" || scalpZone.status === "APPROACHING");
    const intraReady = m5IntraTrigger.confirmed && (intraZone.status === "IN_ZONE" || intraZone.status === "APPROACHING");

    // Pelan Dagangan Lengkap
    const scalpPlan = buildFixedTradePlan(scalpDirection, price, SETTINGS.scalping);
    const intraPlan = buildFixedTradePlan(intradayDirection, price, SETTINGS.intraday);

    // Setup Scalping Payload
    const scalpingPayload = {
      setupId: `SINNCI-SCALPING-${scalpDirection}`,
      type: "SCALPING",
      model: "MA20_SNR_CMP",
      symbol: "XAUUSD",
      direction: scalpDirection,
      status: scalpReady ? "READY" : "WAIT",
      entryStatus: scalpReady ? "READY" : "WAIT",
      score: scalpReady ? 85 : 60,
      zone: scalpZone,
      confirmation: { m1: m1ScalpTrigger },
      plan: scalpPlan,
      reasons: scalpReady 
        ? ["Zon 35 pips dikesan & Momentum M1 disahkan."] 
        : ["Zon sedia. Menunggu lonjakan lilin M1."],
      lastUpdated: new Date().toISOString()
    };

    // Setup Intraday Payload
    const intradayPayload = {
      setupId: `SINNCI-INTRADAY-${intradayDirection}`,
      type: "INTRADAY",
      model: "SNR_MA50_CMP_MAPPING",
      symbol: "XAUUSD",
      direction: intradayDirection,
      status: intraReady ? "READY" : "WAIT",
      entryStatus: intraReady ? "READY" : "WAIT",
      score: intraReady ? 90 : 65,
      zone: intraZone,
      mapping: intradayMapping,
      confirmation: { m5: m5IntraTrigger },
      plan: intraPlan,
      reasons: intraReady 
        ? [`Struktur M5 disahkan. ${intradayMapping.holdRule}`] 
        : [`Zon 35 pips dipetakan. Menunggu lilin M5 tutup & ${intradayMapping.holdRule}`],
      lastUpdated: new Date().toISOString()
    };

    const activeSetup = scalpingPayload;

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI MARKET ENGINE",
      symbol: "XAUUSD",
      cmp: roundPrice(price),
      direction: {
        H4: price >= ema50_H4 ? "BULLISH" : "BEARISH",
        H1: price >= ema20_H1 ? "BULLISH" : "BEARISH",
        M15: scalpZone.status,
        M5: m5IntraTrigger.status,
        M1: m1ScalpTrigger.status
      },
      bias: scalpDirection === "BUY" ? "BULLISH" : "BEARISH",
      
      // Zon Aktif Terus Diberikan (Locked & Early Display)
      zone: scalpZone,
      intradayMapping,

      signal: {
        direction: scalpDirection,
        status: scalpReady ? `${scalpDirection} READY` : "WAIT",
        confirmation: scalpReady 
          ? "Zon 35 pips aktif & momentum M1 disahkan!" 
          : "Zon 35 pips sedia. Menunggu reaksi lilin M1."
      },
      signalStatus: scalpReady ? "READY" : "WAIT",

      audit: {
        m5Break: m5IntraTrigger.confirmed,
        m1Confirmed: m1ScalpTrigger.confirmed
      },

      scalping: scalpingPayload,
      intraday: intradayPayload,

      punca: {
        source: scalpZone.source,
        price: scalpZone.pivot
      },
      score: activeSetup.score,
      settings: {
        zoneThicknessPips: 35,
        stopLossPips: 30,
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
