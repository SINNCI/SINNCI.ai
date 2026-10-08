/**
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Analysis only. NO automated trading or order execution.
 * Data source: Twelve Data time_series
 */

const SYMBOL = "XAU/USD";
const POINT_VALUE = 0.01;

const SETTINGS = {
  zoneMin: 2.00,
  zoneMax: 3.50,
  stopLossDistance: 3.00,

  scalping: {
    tp1Distance: 6.00,
    tp2Distance: 12.00,
    minimumScore: 65
  },

  intraday: {
    tp1Distance: 15.00,
    tp2Distance: 23.00,
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

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundPrice(value) {
  return value === null || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(2));
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
      throw new Error(`${timeframeKey}: Respons API bukan JSON yang sah.`);
    }

    if (!response.ok || payload.status === "error" || payload.code) {
      const message = payload.message || payload.error || `HTTP ${response.status}`;
      throw new Error(`${timeframeKey}: ${message}`);
    }

    if (!Array.isArray(payload.values)) {
      throw new Error(`${timeframeKey}: Tiada data candle diterima.`);
    }

    const candles = normalizeCandles(payload.values);

    if (candles.length < 5) {
      throw new Error(`${timeframeKey}: Data candle tidak mencukupi (${candles.length}).`);
    }

    return {
      candles,
      meta: {
        interval: timeframe.interval,
        received: payload.values.length,
        usableClosedCandles: candles.length,
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

function candleDirection(candle) {
  if (candle.close > candle.open) return "BULLISH";
  if (candle.close < candle.open) return "BEARISH";
  return "NEUTRAL";
}

function getTrend(candles) {
  if (!Array.isArray(candles) || candles.length < 10) {
    return {
      direction: "NEUTRAL",
      score: 0,
      reason: "Candle tidak mencukupi untuk struktur."
    };
  }

  const sample = candles.slice(-10);
  const firstHalf = sample.slice(0, 5);
  const secondHalf = sample.slice(5);

  const oldHigh = Math.max(...firstHalf.map((c) => c.high));
  const newHigh = Math.max(...secondHalf.map((c) => c.high));
  const oldLow = Math.min(...firstHalf.map((c) => c.low));
  const newLow = Math.min(...secondHalf.map((c) => c.low));

  const oldClose = average(firstHalf.map((c) => c.close));
  const newClose = average(secondHalf.map((c) => c.close));

  if (newHigh > oldHigh && newLow > oldLow && newClose > oldClose) {
    return {
      direction: "BULLISH",
      score: 20,
      reason: "Struktur Higher High & Higher Low terbentuk."
    };
  }

  if (newHigh < oldHigh && newLow < oldLow && newClose < oldClose) {
    return {
      direction: "BEARISH",
      score: 20,
      reason: "Struktur Lower High & Lower Low terbentuk."
    };
  }

  return {
    direction: newClose >= oldClose ? "BULLISH" : "BEARISH",
    score: 10,
    reason: "Arah pasaran mengikut purata penutupan terkini."
  };
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

function buildZone(candles, direction, price) {
  if (!candles.length || price === null) {
    return { valid: false, low: null, high: null, reason: "Tiada data zon." };
  }

  const recent = candles.slice(-40);
  const swingPoints = direction === "BUY" ? findSwingLows(recent) : findSwingHighs(recent);

  const candidates = swingPoints
    .filter((point) => (direction === "BUY" ? point.price <= price : point.price >= price))
    .sort((a, b) => (direction === "BUY" ? b.price - a.price : a.price - b.price));

  const pivot = candidates.length > 0 ? candidates[0].price : price;
  const halfWidth = 1.5;

  const low = pivot - halfWidth;
  const high = pivot + halfWidth;

  return {
    valid: true,
    low: roundPrice(low),
    high: roundPrice(high),
    pivot: roundPrice(pivot),
    source: "M15_SWING",
    locked: false,
    status: price >= low && price <= high ? "IN_ZONE" : price < low ? "BELOW_ZONE" : "ABOVE_ZONE",
    reason: "Zon struktur M15 dikenal pasti.",
    distanceFromZone: roundPrice(direction === "BUY" ? Math.max(0, price - high) : Math.max(0, low - price))
  };
}

function getStructureBreak(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return { confirmed: false, status: "NOT_CONFIRMED", reason: "Candle M5 tidak mencukupi." };
  }

  const last = candles[candles.length - 1];
  const previous = candles.slice(-5, -1);

  if (direction === "BUY") {
    const referenceHigh = Math.max(...previous.map((c) => c.high));
    const confirmed = last.close >= referenceHigh;
    return {
      confirmed,
      status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
      method: "CLOSE_ABOVE_STRUCTURE",
      reference: roundPrice(referenceHigh),
      reason: confirmed ? "M5 pecah struktur atas." : "M5 belum pecah struktur rintangan."
    };
  }

  const referenceLow = Math.min(...previous.map((c) => c.low));
  const confirmed = last.close <= referenceLow;
  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
    method: "CLOSE_BELOW_STRUCTURE",
    reference: roundPrice(referenceLow),
    reason: confirmed ? "M5 pecah struktur bawah." : "M5 belum pecah struktur sokongan."
  };
}

function getM1Confirmation(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return { confirmed: false, status: "NOT_CONFIRMED", reason: "Candle M1 tidak mencukupi." };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const lastDir = candleDirection(last);
  const prevDir = candleDirection(previous);

  const confirmed = direction === "BUY" 
    ? lastDir === "BULLISH" || (lastDir === "BULLISH" && prevDir === "BEARISH")
    : lastDir === "BEARISH" || (lastDir === "BEARISH" && prevDir === "BULLISH");

  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
    method: direction === "BUY" ? "M1_BULLISH_MOMENTUM" : "M1_BEARISH_MOMENTUM",
    reason: confirmed ? "Momentum M1 disahkan." : "Momentum M1 belum selari."
  };
}

function buildTradePlan(direction, price, settings) {
  if (price === null || !Number.isFinite(price)) return null;

  const sl = direction === "BUY" ? price - SETTINGS.stopLossDistance : price + SETTINGS.stopLossDistance;
  const tp1 = direction === "BUY" ? price + settings.tp1Distance : price - settings.tp1Distance;
  const tp2 = direction === "BUY" ? price + settings.tp2Distance : price - settings.tp2Distance;

  return {
    entry: roundPrice(price),
    sl: roundPrice(sl),
    tp1: roundPrice(tp1),
    tp2: roundPrice(tp2)
  };
}

function makeSetup({ type, direction, price, higherTrend, lowerTrend, m15, m5, m1, settings }) {
  const zone = buildZone(m15, direction, price);
  const m5Confirm = getStructureBreak(m5, direction);
  const m1Confirm = getM1Confirmation(m1, direction);

  let score = 30;
  if (higherTrend.direction === (direction === "BUY" ? "BULLISH" : "BEARISH")) score += 20;
  if (lowerTrend.direction === (direction === "BUY" ? "BULLISH" : "BEARISH")) score += 20;
  if (zone.status === "IN_ZONE") score += 10;
  if (m5Confirm.confirmed) score += 10;
  if (m1Confirm.confirmed) score += 10;

  const ready = score >= settings.minimumScore && m5Confirm.confirmed && m1Confirm.confirmed;
  const entryStatus = ready ? "READY" : "WAIT";

  return {
    setupId: `SINNCI-${type}-${direction}`,
    type,
    symbol: "XAUUSD",
    direction,
    status: entryStatus,
    entryStatus,
    score,
    zone,
    confirmation: { m5: m5Confirm, m1: m1Confirm },
    plan: ready ? buildTradePlan(direction, price, settings) : null,
    reasons: ready ? ["Setup lengkap dan disahkan."] : ["Menunggu pencetus konfirmasi M5/M1."],
    lastUpdated: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Membenarkan kedua-dua kaedah GET dan POST
  if (req.method !== "GET" && req.method !== "POST") {
    return responseError(res, 405, "METHOD_NOT_ALLOWED", "Kaedah HTTP tidak dibenarkan.");
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    return responseError(res, 500, "MISSING_API_KEY", "TWELVE_DATA_API_KEY tiada di Vercel Environment.");
  }

  try {
    const timeframeKeys = ["H4", "H1", "M15", "M5", "M1"];
    const fetched = await Promise.all(
      timeframeKeys.map(async (key) => [key, await fetchCandles(apiKey, key)])
    );

    const data = Object.fromEntries(fetched);
    const candles = Object.fromEntries(timeframeKeys.map((key) => [key, data[key].candles]));

    const lastM1 = candles.M1[candles.M1.length - 1];
    const price = lastM1.close;

    const trendH4 = getTrend(candles.H4);
    const trendH1 = getTrend(candles.H1);
    const trendM15 = getTrend(candles.M15);

    const scalpDirection = trendH1.direction === "BULLISH" ? "BUY" : "SELL";
    const intradayDirection = trendH4.direction === "BULLISH" ? "BUY" : "SELL";

    const scalping = makeSetup({
      type: "SCALPING",
      direction: scalpDirection,
      price,
      higherTrend: trendH1,
      lowerTrend: trendM15,
      m15: candles.M15,
      m5: candles.M5,
      m1: candles.M1,
      settings: SETTINGS.scalping
    });

    const intraday = makeSetup({
      type: "INTRADAY",
      direction: intradayDirection,
      price,
      higherTrend: trendH4,
      lowerTrend: trendH1,
      m15: candles.M15,
      m5: candles.M5,
      m1: candles.M1,
      settings: SETTINGS.intraday
    });

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI MARKET ENGINE",
      symbol: "XAUUSD",
      market: {
        price: roundPrice(price),
        trends: { H4: trendH4, H1: trendH1, M15: trendM15 }
      },
      scalping,
      intraday,
      settings: {
        stopLossDistance: SETTINGS.stopLossDistance
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return responseError(
      res,
      502,
      "MARKET_DATA_ERROR",
      "Gagal mendapatkan data pasaran.",
      error.message
    );
  }
}
