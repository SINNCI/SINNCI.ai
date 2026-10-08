/**
 * SINNCI AI — XAUUSD MARKET ANALYSIS ENGINE
 * File: api/analyze.js
 *
 * Analysis only. NO automated trading or order execution.
 *
 * Data source: Twelve Data time_series
 * Required environment variable: TWELVE_DATA_API_KEY
 *
 * Timeframes:
 * Scalping:  H1 -> M15 -> M5 -> M1
 * Intraday:  H4 -> H1 -> M15 -> M5 -> M1
 *
 * Important:
 * - No fabricated candles or prices.
 * - WAIT if required data or confirmation is missing.
 * - M5 structure break + M1 final confirmation required for READY.
 * - This endpoint does not permanently store or lock zones.
 */

const SYMBOL = "XAU/USD";
const POINT_VALUE = 0.01;

// Gold price movement: 1 point = $0.01.
// These values are price-distance units, not guaranteed broker pip conventions.
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

  candleCount: 60,
  fetchTimeoutMs: 12000
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

  // Twelve Data forex timestamps are normally UTC.
  // Preserve an explicit timezone if one is already supplied.
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeCandles(values, timeframeMs) {
  if (!Array.isArray(values)) return [];

  const now = Date.now();

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
      candle.high >= candle.low &&
      candle.high >= candle.open &&
      candle.high >= candle.close &&
      candle.low <= candle.open &&
      candle.low <= candle.close &&
      candle.time + timeframeMs <= now
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
  const timer = setTimeout(
    () => controller.abort(),
    SETTINGS.fetchTimeoutMs
  );

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
      throw new Error(`${timeframeKey}: respons API bukan JSON yang sah.`);
    }

    if (!response.ok || payload.status === "error" || payload.code) {
      const message =
        payload.message ||
        payload.error ||
        `HTTP ${response.status}`;

      throw new Error(`${timeframeKey}: ${message}`);
    }

    if (!Array.isArray(payload.values)) {
      throw new Error(
        `${timeframeKey}: data candle tiada. Semak simbol, API key atau kuota.`
      );
    }

    const candles = normalizeCandles(
      payload.values,
      timeframe.ms
    );

    if (candles.length < 10) {
      throw new Error(
        `${timeframeKey}: candle tertutup tidak mencukupi (${candles.length}).`
      );
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
      throw new Error(`${timeframeKey}: permintaan API tamat masa.`);
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
  if (!Array.isArray(candles) || candles.length < 12) {
    return {
      direction: "NEUTRAL",
      score: 0,
      reason: "Candle tidak mencukupi untuk menentukan struktur."
    };
  }

  const sample = candles.slice(-12);
  const firstHalf = sample.slice(0, 6);
  const secondHalf = sample.slice(6);

  const oldHigh = Math.max(...firstHalf.map((c) => c.high));
  const newHigh = Math.max(...secondHalf.map((c) => c.high));
  const oldLow = Math.min(...firstHalf.map((c) => c.low));
  const newLow = Math.min(...secondHalf.map((c) => c.low));

  const oldClose = average(firstHalf.map((c) => c.close));
  const newClose = average(secondHalf.map((c) => c.close));

  const higherHigh = newHigh > oldHigh;
  const higherLow = newLow > oldLow;
  const lowerHigh = newHigh < oldHigh;
  const lowerLow = newLow < oldLow;

  if (higherHigh && higherLow && newClose > oldClose) {
    return {
      direction: "BULLISH",
      score: 20,
      reason: "Struktur menunjukkan higher high dan higher low."
    };
  }

  if (lowerHigh && lowerLow && newClose < oldClose) {
    return {
      direction: "BEARISH",
      score: 20,
      reason: "Struktur menunjukkan lower high dan lower low."
    };
  }

  if (newClose > oldClose) {
    return {
      direction: "BULLISH",
      score: 10,
      reason: "Purata penutupan meningkat tetapi struktur belum lengkap."
    };
  }

  if (newClose < oldClose) {
    return {
      direction: "BEARISH",
      score: 10,
      reason: "Purata penutupan menurun tetapi struktur belum lengkap."
    };
  }

  return {
    direction: "NEUTRAL",
    score: 0,
    reason: "Struktur belum menunjukkan arah yang jelas."
  };
}

function findSwingLows(candles) {
  const result = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const value = candles[i].low;

    if (
      value < candles[i - 1].low &&
      value < candles[i - 2].low &&
      value <= candles[i + 1].low &&
      value <= candles[i + 2].low
    ) {
      result.push({
        price: value,
        time: candles[i].datetime,
        index: i
      });
    }
  }

  return result;
}

function findSwingHighs(candles) {
  const result = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const value = candles[i].high;

    if (
      value > candles[i - 1].high &&
      value > candles[i - 2].high &&
      value >= candles[i + 1].high &&
      value >= candles[i + 2].high
    ) {
      result.push({
        price: value,
        time: candles[i].datetime,
        index: i
      });
    }
  }

  return result;
}

function buildZone(candles, direction, price) {
  if (!candles.length || price === null) {
    return {
      valid: false,
      low: null,
      high: null,
      reason: "Tiada data untuk membina zon."
    };
  }

  const recent = candles.slice(-40);
  const swingPoints = direction === "BUY"
    ? findSwingLows(recent)
    : findSwingHighs(recent);

  const candidates = swingPoints
    .filter((point) => {
      if (direction === "BUY") return point.price <= price;
      return point.price >= price;
    })
    .sort((a, b) => {
      if (direction === "BUY") return b.price - a.price;
      return a.price - b.price;
    });

  if (!candidates.length) {
    return {
      valid: false,
      low: null,
      high: null,
      reason: "Tiada swing zone yang sah berhampiran harga."
    };
  }

  const pivot = candidates[0].price;
  const halfWidth = (SETTINGS.zoneMin + SETTINGS.zoneMax) / 4;

  let low;
  let high;

  if (direction === "BUY") {
    low = pivot - halfWidth;
    high = pivot + halfWidth;
  } else {
    low = pivot - halfWidth;
    high = pivot + halfWidth;
  }

  const zoneWidth = high - low;

  if (
    zoneWidth < SETTINGS.zoneMin ||
    zoneWidth > SETTINGS.zoneMax ||
    low <= 0 ||
    high <= low
  ) {
    return {
      valid: false,
      low: null,
      high: null,
      reason: "Zon tidak memenuhi julat yang ditetapkan."
    };
  }

  // Do not force a setup when price is already far from the zone.
  const distance = direction === "BUY"
    ? price - high
    : low - price;

  const tooFar = distance > SETTINGS.zoneMax;

  return {
    valid: !tooFar,
    low: roundPrice(low),
    high: roundPrice(high),
    pivot: roundPrice(pivot),
    source: "M15_SWING",
    locked: false,
    status: price >= low && price <= high
      ? "IN_ZONE"
      : price < low
        ? "BELOW_ZONE"
        : "ABOVE_ZONE",
    reason: tooFar
      ? "Harga terlalu jauh daripada zon; tunggu peluang baharu."
      : "Zon dibina daripada swing M15 yang dikesan.",
    distanceFromZone: roundPrice(Math.max(0, distance))
  };
}

function getStructureBreak(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 7) {
    return {
      confirmed: false,
      status: "NOT_CONFIRMED",
      reason: "Candle M5 tidak mencukupi."
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles.slice(-7, -1);

  if (direction === "BUY") {
    const referenceHigh = Math.max(...previous.map((c) => c.high));
    const confirmed = last.close > referenceHigh;

    return {
      confirmed,
      status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
      method: "CLOSE_ABOVE_PREVIOUS_STRUCTURE",
      reference: roundPrice(referenceHigh),
      candleTime: last.datetime,
      reason: confirmed
        ? "Candle M5 tertutup di atas struktur sebelumnya."
        : "Belum ada penutupan M5 di atas struktur sebelumnya."
    };
  }

  const referenceLow = Math.min(...previous.map((c) => c.low));
  const confirmed = last.close < referenceLow;

  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
    method: "CLOSE_BELOW_PREVIOUS_STRUCTURE",
    reference: roundPrice(referenceLow),
    candleTime: last.datetime,
    reason: confirmed
      ? "Candle M5 tertutup di bawah struktur sebelumnya."
      : "Belum ada penutupan M5 di bawah struktur sebelumnya."
  };
}

function getM1Confirmation(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return {
      confirmed: false,
      status: "NOT_CONFIRMED",
      reason: "Candle M1 tidak mencukupi."
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const recent = candles.slice(-5, -1);

  const lastDirection = candleDirection(last);
  const previousDirection = candleDirection(previous);

  const bullishEngulfing =
    lastDirection === "BULLISH" &&
    previousDirection === "BEARISH" &&
    last.open <= previous.close &&
    last.close >= previous.open;

  const bearishEngulfing =
    lastDirection === "BEARISH" &&
    previousDirection === "BULLISH" &&
    last.open >= previous.close &&
    last.close <= previous.open;

  const bullishBreak =
    lastDirection === "BULLISH" &&
    last.close > Math.max(...recent.map((c) => c.high));

  const bearishBreak =
    lastDirection === "BEARISH" &&
    last.close < Math.min(...recent.map((c) => c.low));

  const confirmed = direction === "BUY"
    ? bullishEngulfing || bullishBreak
    : bearishEngulfing || bearishBreak;

  const method = direction === "BUY"
    ? bullishEngulfing
      ? "BULLISH_ENGULFING"
      : bullishBreak
        ? "M1_MICRO_STRUCTURE_BREAK"
        : null
    : bearishEngulfing
      ? "BEARISH_ENGULFING"
      : bearishBreak
        ? "M1_MICRO_STRUCTURE_BREAK"
        : null;

  return {
    confirmed,
    status: confirmed ? "CONFIRMED" : "NOT_CONFIRMED",
    method,
    candleTime: last.datetime,
    reason: confirmed
      ? `Confirmation M1 sah: ${method}.`
      : "Engulfing atau break struktur M1 belum disahkan."
  };
}

function buildTradePlan(direction, price, settings) {
  if (price === null || !Number.isFinite(price)) return null;

  const sl = direction === "BUY"
    ? price - SETTINGS.stopLossDistance
    : price + SETTINGS.stopLossDistance;

  const tp1 = direction === "BUY"
    ? price + settings.tp1Distance
    : price - settings.tp1Distance;

  const tp2 = direction === "BUY"
    ? price + settings.tp2Distance
    : price - settings.tp2Distance;

  return {
    entry: roundPrice(price),
    sl: roundPrice(sl),
    tp1: roundPrice(tp1),
    tp2: roundPrice(tp2),
    distances: {
      stopLoss: SETTINGS.stopLossDistance,
      tp1: settings.tp1Distance,
      tp2: settings.tp2Distance
    }
  };
}

function makeSetup({
  type,
  direction,
  price,
  higherTrend,
  lowerTrend,
  m15,
  m5,
  m1,
  settings
}) {
  const zone = buildZone(m15, direction, price);
  const m5Confirmation = getStructureBreak(m5, direction);
  const m1Confirmation = getM1Confirmation(m1, direction);

  const directionAligned =
    higherTrend.direction === directionToTrend(direction) &&
    lowerTrend.direction === directionToTrend(direction);

  let score = 0;

  if (higherTrend.direction === directionToTrend(direction)) {
    score += 20;
  }

  if (lowerTrend.direction === directionToTrend(direction)) {
    score += 20;
  }

  if (zone.valid) score += 15;
  if (zone.status === "IN_ZONE") score += 10;
  if (m5Confirmation.confirmed) score += 20;
  if (m1Confirmation.confirmed) score += 15;

  score = Math.min(100, score);

  const reasons = [];

  if (!directionAligned) {
    reasons.push("Arah timeframe utama belum selari.");
  }

  if (!zone.valid) {
    reasons.push(zone.reason);
  }

  if (zone.valid && zone.status !== "IN_ZONE") {
    reasons.push("Harga belum berada di dalam entry zone.");
  }

  if (!m5Confirmation.confirmed) {
    reasons.push(m5Confirmation.reason);
  }

  if (!m1Confirmation.confirmed) {
    reasons.push(m1Confirmation.reason);
  }

  if (score < settings.minimumScore) {
    reasons.push(`Score di bawah minimum ${settings.minimumScore}.`);
  }

  const ready =
    directionAligned &&
    zone.valid &&
    zone.status === "IN_ZONE" &&
    m5Confirmation.confirmed &&
    m1Confirmation.confirmed &&
    score >= settings.minimumScore;

  const entryStatus = ready ? "READY" : "WAIT";

  return {
    setupId: `SINNCI-${type}-${direction}-${m15[m15.length - 1].time}`,
    type,
    symbol: "XAUUSD",
    direction,
    status: entryStatus,
    entryStatus,
    score,
    minimumScore: settings.minimumScore,
    marketBias: {
      higherTimeframe: higherTrend.direction,
      setupTimeframe: lowerTrend.direction
    },
    zone: {
      low: zone.low,
      high: zone.high,
      pivot: zone.pivot ?? null,
      source: zone.source ?? null,
      locked: false,
      status: zone.status,
      valid: zone.valid,
      reason: zone.reason
    },
    confirmation: {
      m5: {
        ...m5Confirmation,
        method: m5Confirmation.method || null
      },
      m1: {
        ...m1Confirmation,
        method: m1Confirmation.method || null
      }
    },
    plan: ready ? buildTradePlan(direction, price, settings) : null,
    reasons: ready
      ? ["Timeframe selari, harga dalam zon, M5 dan M1 disahkan."]
      : [...new Set(reasons)],
    lastUpdated: new Date().toISOString()
  };
}

function directionToTrend(direction) {
  return direction === "BUY" ? "BULLISH" : "BEARISH";
}

function selectDirection(higherTrend, lowerTrend) {
  if (
    higherTrend.direction === "BULLISH" &&
    lowerTrend.direction === "BULLISH"
  ) {
    return "BUY";
  }

  if (
    higherTrend.direction === "BEARISH" &&
    lowerTrend.direction === "BEARISH"
  ) {
    return "SELL";
  }

  return null;
}

function makeWaitingSetup(type, reason, price = null) {
  return {
    setupId: null,
    type,
    symbol: "XAUUSD",
    direction: "WAIT",
    status: "WAIT",
    entryStatus: "WAIT",
    score: 0,
    zone: {
      low: null,
      high: null,
      pivot: null,
      source: null,
      locked: false,
      status: "NOT_AVAILABLE",
      valid: false,
      reason
    },
    confirmation: {
      m5: {
        confirmed: false,
        status: "NOT_CHECKED",
        reason
      },
      m1: {
        confirmed: false,
        status: "NOT_CHECKED",
        reason
      }
    },
    plan: null,
    reasons: [reason],
    lastUpdated: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return responseError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan GET untuk mendapatkan analisis."
    );
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return responseError(
      res,
      500,
      "MISSING_API_KEY",
      "Environment variable TWELVE_DATA_API_KEY belum ditetapkan di Vercel."
    );
  }

  try {
    // Five timeframe requests are required for the complete analysis.
    // They are fetched once per request, concurrently.
    const timeframeKeys = ["H4", "H1", "M15", "M5", "M1"];

    const fetched = await Promise.all(
      timeframeKeys.map(async (key) => [
        key,
        await fetchCandles(apiKey, key)
      ])
    );

    const data = Object.fromEntries(fetched);
    const candles = Object.fromEntries(
      timeframeKeys.map((key) => [key, data[key].candles])
    );

    const lastM1 = candles.M1[candles.M1.length - 1];
    const price = lastM1.close;

    const trendH4 = getTrend(candles.H4);
    const trendH1 = getTrend(candles.H1);
    const trendM15 = getTrend(candles.M15);

    const scalpDirection = selectDirection(trendH1, trendM15);
    const intradayDirection = selectDirection(trendH4, trendH1);

    let scalping;
    let intraday;

    if (scalpDirection) {
      scalping = makeSetup({
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
    } else {
      scalping = makeWaitingSetup(
        "SCALPING",
        "Arah H1 dan M15 tidak selari. Tunggu setup yang lebih jelas."
      );
    }

    if (intradayDirection) {
      intraday = makeSetup({
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
    } else {
      intraday = makeWaitingSetup(
        "INTRADAY",
        "Arah H4 dan H1 tidak selari. Tunggu setup yang lebih jelas."
      );
    }

    const readySetups = [scalping, intraday].filter(
      (setup) => setup.entryStatus === "READY"
    );

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI MARKET ENGINE",
      version: "2.0.0",
      symbol: "XAUUSD",
      source: "Twelve Data",
      analysisOnly: true,
      automatedTrading: false,
      market: {
        price: roundPrice(price),
        priceSource: "Last available CLOSED M1 candle close",
        priceTime: lastM1.datetime,
        priceIsBrokerQuote: false,
        trends: {
          H4: trendH4,
          H1: trendH1,
          M15: trendM15
        }
      },
      scalping,
      intraday,
      bestSetup: readySetups.length
        ? readySetups.reduce((best, current) =>
            current.score > best.score ? current : best
          )
        : null,
      summary: {
        ready: readySetups.length > 0,
        readyCount: readySetups.length,
        message: readySetups.length
          ? "Sekurang-kurangnya satu setup memenuhi syarat confirmation."
          : "Tiada setup READY. Tunggu confirmation yang sah.",
        note: "Score tinggi sahaja tidak mencukupi untuk mengaktifkan entry."
      },
      dataQuality: {
        closedCandlesOnly: true,
        timeframes: Object.fromEntries(
          timeframeKeys.map((key) => [key, data[key].meta])
        ),
        zonePersistence: false,
        warning:
          "Harga menggunakan penutupan candle M1 terakhir yang tersedia, bukan quote broker live."
      },
      settings: {
        zoneMin: SETTINGS.zoneMin,
        zoneMax: SETTINGS.zoneMax,
        stopLossDistance: SETTINGS.stopLossDistance,
        scalping: SETTINGS.scalping,
        intraday: SETTINGS.intraday,
        pointValue: POINT_VALUE
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const message = error?.message || "Analisis gagal diproses.";

    return responseError(
      res,
      502,
      "MARKET_DATA_ERROR",
      "SINNCI AI tidak dapat menyelesaikan analisis menggunakan data pasaran.",
      message
    );
  }
}
