/**
 * ============================================================================
 * SINNCI MARKET ENGINE PRO — LIGHTWEIGHT MONITOR ENDPOINT
 * Asset: XAUUSD (Gold)
 * File: api/monitor.js
 * Deployment: Vercel Serverless Function
 * 
 * Flow:
 * - Mengambil M5 dan M1 sahaja (menjimatkan API request/credit).
 * - Tidak memproses semula analisis trend H4/H1/M15.
 * - Mengesahkan M5 CMP/Structure Break terhadap Zone yang dikunci (LOCKED).
 * - Mengesahkan M1 Micro Confirmation (Structure, Rejection, Momentum).
 * - Standard: 10 points = 1 pip | SL = 300 points (30 pips).
 * ============================================================================
 */

const SYMBOL = "XAU/USD";
const TWELVE_DATA_BASE_URL = "https://api.twelvedata.com/time_series";
const POINT_VALUE = 0.01; // $0.01 = 1 point, $1.00 = 100 points
const SL_POINTS = 300;     // 30 pips

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

async function fetchCandles(interval, outputsize, apiKey) {
  const url = `${TWELVE_DATA_BASE_URL}?symbol=${encodeURIComponent(
    SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data HTTP error: ${res.status} (${res.statusText})`);
  }

  const data = await res.json();
  if (data.status === "error" || data.code || !Array.isArray(data.values)) {
    throw new Error(data.message || `No candle data for interval ${interval}`);
  }

  return data.values
    .map((c) => ({
      datetime: c.datetime,
      open: safeNum(c.open),
      high: safeNum(c.high),
      low: safeNum(c.low),
      close: safeNum(c.close),
    }))
    .reverse();
}

function evaluateM5Break(m5Candles, cmp, direction) {
  if (!m5Candles || m5Candles.length < 3) {
    return { hasBroken: false, status: "WAIT", details: "Waiting for M5 data" };
  }

  const latest = m5Candles[m5Candles.length - 1];
  const prev = m5Candles[m5Candles.length - 2];

  let hasBroken = false;
  let status = "WAIT";
  let details = "Waiting for M5 CMP/Structure break";

  if (direction === "BUY") {
    const cmpBrokeHigh = cmp > prev.high;
    const bullishShift = latest.close > prev.high || (latest.close > latest.open && cmp > prev.close);
    const rejectionWick = (latest.low < prev.low && cmp > prev.low);

    if (cmpBrokeHigh || bullishShift || rejectionWick) {
      hasBroken = true;
      status = "CMP BREAK CONFIRMED";
      details = "M5 CMP / structure break detected";
    }
  } else if (direction === "SELL") {
    const cmpBrokeLow = cmp < prev.low;
    const bearishShift = latest.close < prev.low || (latest.close < latest.open && cmp < prev.close);
    const rejectionWick = (latest.high > prev.high && cmp < prev.high);

    if (cmpBrokeLow || bearishShift || rejectionWick) {
      hasBroken = true;
      status = "CMP BREAK CONFIRMED";
      details = "M5 CMP / structure breakdown detected";
    }
  }

  return { hasBroken, status, details };
}

function evaluateM1Confirmation(m1Candles, cmp, direction) {
  if (!m1Candles || m1Candles.length < 4) {
    return { isConfirmed: false, status: "WAIT", details: "Waiting for M1 candles" };
  }

  const recent = m1Candles.slice(-4);
  const current = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  let isConfirmed = false;
  let status = "NO CONFIRMATION";
  let details = "Validating M1 micro-structure";

  if (direction === "BUY") {
    const bullishBody = current.close > current.open;
    const microBreak = cmp > prev.high || current.close > prev.high;
    const rejectionLow = (current.low <= prev.low && current.close > current.open);
    const positiveMomentum = current.close >= prev.close;

    if ((microBreak || rejectionLow) && bullishBody && positiveMomentum) {
      isConfirmed = true;
      status = "BULLISH CONFIRMED";
      details = "M1 confirmed: Bullish momentum reclaim";
    } else {
      status = "CHECKING";
      details = "M1 waiting for buyer follow-through";
    }
  } else if (direction === "SELL") {
    const bearishBody = current.close < current.open;
    const microBreak = cmp < prev.low || current.close < prev.low;
    const rejectionHigh = (current.high >= prev.high && current.close < current.open);
    const negativeMomentum = current.close <= prev.close;

    if ((microBreak || rejectionHigh) && bearishBody && negativeMomentum) {
      isConfirmed = true;
      status = "BEARISH CONFIRMED";
      details = "M1 confirmed: Bearish momentum breakdown";
    } else {
      status = "CHECKING";
      details = "M1 waiting for seller follow-through";
    }
  }

  return { isConfirmed, status, details };
}

function isPriceWithinExecutionBounds(direction, zone, cmp) {
  const maxTolerance = 6.0; // Max 60 pips dari had zone untuk elak chasing
  if (direction === "BUY") {
    return cmp <= zone.high + maxTolerance;
  } else {
    return cmp >= zone.low - maxTolerance;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        status: "error",
        error: "TWELVE_DATA_API_KEY is not configured.",
      });
    }

    const payload = req.method === "POST" ? req.body : req.query;
    const { setup } = payload || {};

    if (!setup || !setup.zone || !setup.direction) {
      return res.status(400).json({
        status: "error",
        error: "No active setup provided for monitoring. Zone and direction are required.",
      });
    }

    const direction = String(setup.direction).toUpperCase();
    const zone = {
      type: setup.zone.type || direction,
      low: Number(setup.zone.low),
      high: Number(setup.zone.high),
      locked: true,
      status: "LOCKED",
    };

    // Ambil M5 dan M1 SAHAJA (Ringan & Cepat)
    const [m5Candles, m1Candles] = await Promise.all([
      fetchCandles("5min", 15, apiKey),
      fetchCandles("1min", 20, apiKey),
    ]);

    if (!m5Candles.length || !m1Candles.length) {
      return res.status(502).json({
        status: "error",
        error: "Insufficient M5/M1 data returned from provider.",
      });
    }

    const cmp = round(m1Candles[m1Candles.length - 1].close, 2);

    // Semak Struktur Invalidation (jika tembus lebih 25 pips melepasi had zon)
    const slOffset = SL_POINTS * POINT_VALUE; // $3.00
    let isStructureInvalid = false;
    if (direction === "BUY" && cmp < (zone.low - slOffset)) {
      isStructureInvalid = true;
    } else if (direction === "SELL" && cmp > (zone.high + slOffset)) {
      isStructureInvalid = true;
    }

    if (isStructureInvalid) {
      return res.status(200).json({
        status: "success",
        market: { symbol: "XAUUSD", price: cmp },
        zone: { ...zone, status: "INVALID", locked: false },
        m5: { status: "WAIT", details: "Structure invalidated" },
        m1: { status: "NO CONFIRMATION", details: "Zone breached" },
        signal: {
          direction,
          status: "INVALID",
          confirmation: "STRUCTURE_INVALIDATED",
        },
        autoMonitorActive: false,
        stopReason: "INVALIDATED",
      });
    }

    // Step B: M5 CMP / Structure Break Evaluation
    const m5Eval = evaluateM5Break(m5Candles, cmp, direction);

    // Step C: M1 Micro Confirmation Evaluation (Hanya aktif jika M5 sudah break)
    let m1Eval = { isConfirmed: false, status: "WAIT", details: "Waiting for M5 break" };
    if (m5Eval.hasBroken) {
      m1Eval = evaluateM1Confirmation(m1Candles, cmp, direction);
    }

    // Tentukan Signal Akhir
    let signalStatus = "WAIT";
    let confirmationMsg = m5Eval.details;
    let autoMonitorActive = true;

    if (!m5Eval.hasBroken) {
      signalStatus = "WAIT";
      confirmationMsg = "Waiting for M5 break";
    } else if (m5Eval.hasBroken && !m1Eval.isConfirmed) {
      signalStatus = "M1_CHECKING";
      confirmationMsg = "M5 BREAK → CHECKING M1";
    } else if (m5Eval.hasBroken && m1Eval.isConfirmed) {
      const withinBounds = isPriceWithinExecutionBounds(direction, zone, cmp);
      if (withinBounds) {
        signalStatus = "READY";
        confirmationMsg = "M5 BREAK + M1 CONFIRMED";
        autoMonitorActive = false; // Capai objektif, matikan monitor berkala
      } else {
        signalStatus = "WAIT";
        confirmationMsg = "OVEREXTENDED_AVOID_CHASE";
      }
    }

    // Bina Trade Plan sekiranya READY
    let tradePlan = null;
    if (signalStatus === "READY") {
      const structuralBase = direction === "BUY" ? zone.low : zone.high;
      const plannedSL = direction === "BUY" ? round(structuralBase - slOffset, 2) : round(structuralBase + slOffset, 2);
      const isScalp = setup.mode !== "intraday";
      const tp1Pts = isScalp ? 600 : 1500;
      const tp2Pts = isScalp ? 1200 : 2300;

      const plannedTP1 = direction === "BUY"
        ? round(zone.high + (tp1Pts * POINT_VALUE), 2)
        : round(zone.low - (tp1Pts * POINT_VALUE), 2);

      const plannedTP2 = direction === "BUY"
        ? round(zone.high + (tp2Pts * POINT_VALUE), 2)
        : round(zone.low - (tp2Pts * POINT_VALUE), 2);

      tradePlan = {
        entry: cmp,
        sl: plannedSL,
        tp1: plannedTP1,
        tp2: plannedTP2,
        slPoints: SL_POINTS,
        slPips: SL_POINTS / 10,
      };
    }

    return res.status(200).json({
      status: "success",
      market: { symbol: "XAUUSD", price: cmp },
      zone: {
        ...zone,
        status: "LOCKED",
      },
      m5: {
        status: m5Eval.status,
        details: m5Eval.details,
      },
      m1: {
        status: m1Eval.status,
        details: m1Eval.details,
        direction: m1Eval.isConfirmed ? direction : "NONE",
      },
      signal: {
        direction,
        status: signalStatus,
        confirmation: confirmationMsg,
      },
      plan: tradePlan,
      autoMonitorActive,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error("MONITOR ENGINE ERROR:", error);
    return res.status(500).json({
      status: "error",
      error: error.message || "Monitor processing failed.",
    });
  }
}
