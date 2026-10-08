export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        status: "error",
        error: "API key not configured"
      });
    }

    const SYMBOL = "XAU/USD";
    const PRICE_SYMBOL = "XAUUSD";

    // =========================================================
    // SINNCI MARKET ENGINE PRO
    // =========================================================

    const POINT = 0.01;

    // Scalping: 65 (Aktif tapi anti-fakeout)
    // Intraday: 90 (Kualiti Tinggi / Sangat Memilih)
    const SCALP_SIGNAL_SCORE = 65; 
    const INTRA_SIGNAL_SCORE = 90;

    // Scalping Risk
    const SCALP_SL_POINTS = 200;   // 20 pips SL
    const SCALP_TP1_POINTS = 600;  // 60 pips TP1
    const SCALP_TP2_POINTS = 1200; // 120 pips TP2

    // Intraday Risk (Quality Ratio)
    const INTRA_SL_POINTS = 400;   // 40 pips SL
    const INTRA_TP1_POINTS = 1500; // 150 pips TP1
    const INTRA_TP2_POINTS = 2300; // 230 pips TP2

    // =========================================================
    // CACHE (15s)
    // =========================================================

    const now = Date.now();

    if (!globalThis.__SINNCI_PRO_CACHE) {
      globalThis.__SINNCI_PRO_CACHE = {
        data: null,
        timestamp: 0
      };
    }

    if (
      globalThis.__SINNCI_PRO_CACHE.data &&
      now - globalThis.__SINNCI_PRO_CACHE.timestamp < 15000
    ) {
      return res.status(200).json(
        globalThis.__SINNCI_PRO_CACHE.data
      );
    }

    // =========================================================
    // HELPERS
    // =========================================================

    const safeNum = (v, fallback = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    const round = (v, d = 2) => {
      const p = Math.pow(10, d);
      return Math.round(v * p) / p;
    };

    const pointsToPrice = points => points * POINT;
    const priceToPoints = price => price / POINT;

    const avg = arr => {
      const a = arr.filter(Number.isFinite);
      if (!a.length) return 0;
      return a.reduce((x, y) => x + y, 0) / a.length;
    };

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

    const candleBody = c => Math.abs(safeNum(c.close) - safeNum(c.open));
    const candleRange = c => Math.max(0.0001, safeNum(c.high) - safeNum(c.low));
    const upperWick = c => safeNum(c.high) - Math.max(safeNum(c.open), safeNum(c.close));
    const lowerWick = c => Math.min(safeNum(c.open), safeNum(c.close)) - safeNum(c.low);
    const bullish = c => safeNum(c.close) > safeNum(c.open);
    const bearish = c => safeNum(c.close) < safeNum(c.open);
    const bodyRatio = c => candleBody(c) / candleRange(c);

    // =========================================================
    // TWELVE DATA
    // =========================================================

    async function getCandles(interval, outputsize = 100) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${encodeURIComponent(API_KEY)}`;

      const response = await fetch(url);
      const text = await response.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Invalid Twelve Data response for ${interval}`);
      }

      if (data.status === "error" || data.code || !Array.isArray(data.values)) {
        throw new Error(data.message || `No candle data for ${interval}`);
      }

      return data.values
        .map(c => ({
          datetime: c.datetime,
          open: safeNum(c.open),
          high: safeNum(c.high),
          low: safeNum(c.low),
          close: safeNum(c.close)
        }))
        .filter(c =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .reverse();
    }

    const [H4, H1, M15, M5] = await Promise.all([
      getCandles("4h", 80),
      getCandles("1h", 80),
      getCandles("15min", 80),
      getCandles("5min", 100)
    ]);

    if (H4.length < 15 || H1.length < 15 || M15.length < 15 || M5.length < 25) {
      throw new Error("Not enough market data");
    }

    // =========================================================
    // ATR
    // =========================================================

    function calculateATR(candles, period = 14) {
      if (candles.length < period + 1) return 0;
      const trs = [];
      for (let i = candles.length - period; i < candles.length; i++) {
        const c = candles[i];
        const prev = candles[i - 1];
        if (!prev) continue;
        const tr = Math.max(
          c.high - c.low,
          Math.abs(c.high - prev.close),
          Math.abs(c.low - prev.close)
        );
        trs.push(tr);
      }
      return avg(trs);
    }

    const atr = {
      H4: calculateATR(H4),
      H1: calculateATR(H1),
      M15: calculateATR(M15),
      M5: calculateATR(M5)
    };

    // =========================================================
    // SWINGS & STRUCTURE
    // =========================================================

    function getSwingPoints(candles, left = 2, right = 2) {
      const highs = [];
      const lows = [];

      for (let i = left; i < candles.length - right; i++) {
        const c = candles[i];
        let isHigh = true;
        let isLow = true;

        for (let j = 1; j <= left; j++) {
          if (candles[i - j].high >= c.high) isHigh = false;
          if (candles[i - j].low <= c.low) isLow = false;
        }

        if (isHigh) {
          for (let j = 1; j <= right; j++) {
            if (candles[i + j].high >= c.high) {
              isHigh = false;
              break;
            }
          }
        }

        if (isLow) {
          for (let j = 1; j <= right; j++) {
            if (candles[i + j].low <= c.low) {
              isLow = false;
              break;
            }
          }
        }

        if (isHigh) highs.push({ index: i, price: c.high, datetime: c.datetime });
        if (isLow) lows.push({ index: i, price: c.low, datetime: c.datetime });
      }

      return { highs, lows };
    }

    function structure(candles) {
      const swings = getSwingPoints(candles);
      const highs = swings.highs.slice(-4);
      const lows = swings.lows.slice(-4);
      let direction = "NEUTRAL";

      if (highs.length >= 2 && lows.length >= 2) {
        const h1 = highs[highs.length - 2].price;
        const h2 = highs[highs.length - 1].price;
        const l1 = lows[lows.length - 2].price;
        const l2 = lows[lows.length - 1].price;

        if (h2 > h1 && l2 > l1) direction = "BULLISH";
        if (h2 < h1 && l2 < l1) direction = "BEARISH";
      }

      return {
        direction,
        highs,
        lows,
        latestHigh: highs.length ? highs[highs.length - 1].price : null,
        latestLow: lows.length ? lows[lows.length - 1].price : null
      };
    }

    const structureH4 = structure(H4);
    const structureH1 = structure(H1);
    const structureM15 = structure(M15);
    const structureM5 = structure(M5);

    function getDirection(candles) {
      const s = structure(candles);
      if (s.direction !== "NEUTRAL") return s.direction;
      const recent = candles.slice(-6);
      const bull = recent.filter(bullish).length;
      const bear = recent.filter(bearish).length;
      if (bull > bear + 1) return "BULLISH";
      if (bear > bull + 1) return "BEARISH";
      return "NEUTRAL";
    }

    const direction = {
      H4: getDirection(H4),
      H1: getDirection(H1),
      M15: getDirection(M15),
      M5: getDirection(M5)
    };

    const currentPrice = safeNum(M5[M5.length - 1].close);

    // =========================================================
    // ZONES BUILDER
    // =========================================================

    function candleZone(c, type, source, index) {
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      return {
        type,
        source,
        index,
        high: round(c.high, 2),
        low: round(c.low, 2),
        bodyHigh: round(bodyHigh, 2),
        bodyLow: round(bodyLow, 2),
        midpoint: round((c.high + c.low) / 2, 2),
        datetime: c.datetime,
        range: round(c.high - c.low, 2),
        body: round(candleBody(c), 2)
      };
    }

    function buildZones(candles, source) {
      const zones = [];
      const start = Math.max(2, candles.length - 30);

      for (let i = start; i < candles.length - 1; i++) {
        const c = candles[i];
        const range = candleRange(c);
        if (range <= 0) continue;

        if (bullish(c) && candleBody(c) / range >= 0.45) {
          zones.push(candleZone(c, "DEMAND", source, i));
        }
        if (bearish(c) && candleBody(c) / range >= 0.45) {
          zones.push(candleZone(c, "SUPPLY", source, i));
        }
      }
      return zones;
    }

    const allZones = [
      ...buildZones(H1, "H1"),
      ...buildZones(M15, "M15"),
      ...buildZones(M5, "M5")
    ];

    function getCmpLocation() {
      let nearestZone = null;
      let minDistance = Infinity;

      for (const z of allZones) {
        const inside = currentPrice >= z.low && currentPrice <= z.high;
        const distance = inside ? 0 : Math.min(Math.abs(currentPrice - z.low), Math.abs(currentPrice - z.high));
        if (distance < minDistance) {
          minDistance = distance;
          nearestZone = { ...z, inside };
        }
      }

      if (!nearestZone) return { state: "NO_ZONE", zone: null, distancePoints: null };
      const distancePoints = priceToPoints(minDistance);
      let state = "FAR_FROM_ZONE";
      if (nearestZone.inside) state = "INSIDE_ZONE";
      else if (distancePoints <= 50) state = "APPROACHING_ZONE";
      else if (distancePoints <= 120) state = "NEAR_ZONE";

      return {
        state,
        zone: nearestZone,
        distancePoints: round(distancePoints, 0)
      };
    }

    const cmpLocation = getCmpLocation();

    // =========================================================
    // PRICE ACTION TRIGGERS (M5 CONFIRMATION)
    // =========================================================

    function detectM5Trigger() {
      const last = M5[M5.length - 1];
      const prev = M5[M5.length - 2];
      const prev2 = M5[M5.length - 3];

      const buy = [];
      const sell = [];

      const minActionRange = atr.M5 * 0.40;
      if (candleRange(last) >= minActionRange) {
        if (bearish(prev) && bullish(last) && last.close >= prev.open) {
          buy.push("BULLISH_ENGULFING");
        }
        if (bullish(prev) && bearish(last) && last.close <= prev.open) {
          sell.push("BEARISH_ENGULFING");
        }

        if (lowerWick(last) > candleRange(last) * 0.50 && bullish(last)) {
          buy.push("BULLISH_REJECTION");
        }
        if (upperWick(last) > candleRange(last) * 0.50 && bearish(last)) {
          sell.push("BEARISH_REJECTION");
        }

        if (bullish(last) && bodyRatio(last) >= 0.65) {
          buy.push("BULLISH_DISPLACEMENT");
        }
        if (bearish(last) && bodyRatio(last) >= 0.65) {
          sell.push("BEARISH_DISPLACEMENT");
        }

        if (prev2 && last.close > prev2.high) buy.push("M5_HIGH_BREAK");
        if (prev2 && last.close < prev2.low) sell.push("M5_LOW_BREAK");
      }

      return {
        buy,
        sell,
        strongest: buy.length > sell.length ? "BUY" : sell.length > buy.length ? "SELL" : "NEUTRAL"
      };
    }

    const m5Trigger = detectM5Trigger();

    // =========================================================
    // SCALPING ENGINE
    // =========================================================

    function scalpSide(side) {
      let score = 0;
      const reasons = [];
      const isBuy = side === "BUY";
      const wantedDir = isBuy ? "BULLISH" : "BEARISH";
      const oppositeDir = isBuy ? "BEARISH" : "BULLISH";

      if (direction.M15 === oppositeDir) {
        return {
          side,
          status: "WAIT",
          score: 15,
          reasons: ["Against M15 primary structure"],
          m5Confirmed: false
        };
      }

      if (direction.M15 === wantedDir) {
        score += 25;
        reasons.push(`M15 ${wantedDir.toLowerCase()} structure`);
      }
      if (direction.M5 === wantedDir) {
        score += 20;
        reasons.push(`M5 momentum aligned`);
      }
      if (direction.H1 === wantedDir) {
        score += 15;
        reasons.push(`H1 trend confluence`);
      }

      const triggers = isBuy ? m5Trigger.buy : m5Trigger.sell;
      if (triggers.length > 0) {
        score += 20;
        reasons.push(...triggers);
      }

      if (cmpLocation.zone && cmpLocation.zone.type === (isBuy ? "DEMAND" : "SUPPLY")) {
        score += 15;
        reasons.push(`At ${side} zone`);
      }

      const last = M5[M5.length - 1];
      const prev = M5[M5.length - 2];
      const hadPullback = isBuy ? (prev.low < last.low && bullish(last)) : (prev.high > last.high && bearish(last));
      if (hadPullback) {
        score += 10;
        reasons.push("Pullback completed");
      }

      score = clamp(Math.round(score), 0, 100);

      const hasRealTrigger = triggers.length > 0;
      const isStructureValid = direction.M15 === wantedDir || direction.M5 === wantedDir;

      let status = "WAIT";
      if (score >= 40) status = "SETUP";
      if (score >= 55) status = "READY";
      if (score >= SCALP_SIGNAL_SCORE && hasRealTrigger && isStructureValid) {
        status = "SIGNAL";
      }

      return {
        side,
        status,
        score,
        reasons: [...new Set(reasons)].slice(0, 10),
        m5Confirmed: hasRealTrigger
      };
    }

    const scalpBuy = scalpSide("BUY");
    const scalpSell = scalpSide("SELL");

    // =========================================================
    // INTRADAY ENGINE (QUALITY & PULLBACK CONVICTION)
    // =========================================================

    function intradaySide(side) {
      let score = 0;
      const reasons = [];
      const isBuy = side === "BUY";
      const wantedDir = isBuy ? "BULLISH" : "BEARISH";
      const oppositeDir = isBuy ? "BEARISH" : "BULLISH";

      // 1. SYARAT KUALITI MUTLAK: Jika H4, H1 atau M15 melawan arus, BATALKAN signal!
      if (direction.H4 === oppositeDir || direction.H1 === oppositeDir || direction.M15 === oppositeDir) {
        return {
          side,
          status: "WAIT",
          score: 20,
          reasons: ["HTF structure conflict — Not aligned"],
          m5Confirmed: false
        };
      }

      // H4 & H1 mesti sehaluan (50 markah asas)
      if (direction.H4 === wantedDir) { score += 25; reasons.push(`H4 ${wantedDir.toLowerCase()} trend`); }
      if (direction.H1 === wantedDir) { score += 25; reasons.push(`H1 ${wantedDir.toLowerCase()} trend`); }
      if (direction.M15 === wantedDir) { score += 20; reasons.push(`M15 structure aligned`); }

      // 2. MESTI ADA ZON PULLBACK HTF (H1 atau M15 Key Zone)
      const htfZone = allZones.find(z => (z.source === "H1" || z.source === "M15") && z.type === (isBuy ? "DEMAND" : "SUPPLY"));
      if (htfZone) {
        score += 15;
        reasons.push(`Confluent ${htfZone.source} Key Zone`);
      }

      // 3. PENGESAHAN PRICE ACTION
      const triggers = isBuy ? m5Trigger.buy : m5Trigger.sell;
      if (triggers.length > 0) {
        score += 15;
        reasons.push(...triggers);
      }

      score = clamp(Math.round(score), 0, 100);

      let status = "WAIT";
      if (score >= 50) status = "SETUP";
      if (score >= 75) status = "READY";

      // SYARAT SIGNAL INTRADAY: Skor >= 90 + H4/H1/M15 sehaluan + ada trigger
      if (
        score >= INTRA_SIGNAL_SCORE &&
        direction.H4 === wantedDir &&
        direction.H1 === wantedDir &&
        direction.M15 === wantedDir &&
        triggers.length > 0 &&
        htfZone
      ) {
        status = "SIGNAL";
      }

      return {
        side,
        status,
        score,
        reasons: [...new Set(reasons)].slice(0, 10),
        m5Confirmed: triggers.length > 0
      };
    }

    const intraBuy = intradaySide("BUY");
    const intraSell = intradaySide("SELL");

    // =========================================================
    // TRADE PLAN GENERATOR (PULLBACK SNIPER)
    // =========================================================

    function buildTradePlan(side, mode, score) {
      if (!side) return null;

      const isScalp = mode === "SCALPING";
      const slPoints = isScalp ? SCALP_SL_POINTS : INTRA_SL_POINTS;
      const tp1Points = isScalp ? SCALP_TP1_POINTS : INTRA_TP1_POINTS;
      const tp2Points = isScalp ? SCALP_TP2_POINTS : INTRA_TP2_POINTS;
      const signalThreshold = isScalp ? SCALP_SIGNAL_SCORE : INTRA_SIGNAL_SCORE;

      let entry = round(currentPrice, 2);

      // UNTUK INTRADAY: Letakkan Entry pada Zon Pullback HTF (Bukan Running Price)
      if (!isScalp) {
        const htfZone = allZones.find(z => 
          (z.source === "H1" || z.source === "M15") && 
          z.type === (side === "SELL" ? "SUPPLY" : "DEMAND")
        );

        if (htfZone) {
          entry = round(htfZone.midpoint, 2);
        } else {
          // Pullback offset yang mencukupi untuk Intraday (2.5 mata / 25 pips)
          entry = side === "SELL" ? round(currentPrice + 2.5, 2) : round(currentPrice - 2.5, 2);
        }
      } else {
        // UNTUK SCALPING: Pullback mikro 0.8 mata
        const pullOffset = 0.8;
        entry = side === "SELL" ? round(currentPrice + pullOffset, 2) : round(currentPrice - pullOffset, 2);
      }

      const sl = side === "BUY"
        ? round(entry - pointsToPrice(slPoints), 2)
        : round(entry + pointsToPrice(slPoints), 2);

      const tp1 = side === "BUY"
        ? round(entry + pointsToPrice(tp1Points), 2)
        : round(entry - pointsToPrice(tp1Points), 2);

      const tp2 = side === "BUY"
        ? round(entry + pointsToPrice(tp2Points), 2)
        : round(entry - pointsToPrice(tp2Points), 2);

      return {
        direction: side,
        mode,
        status: score >= signalThreshold ? "SIGNAL" : "SETUP",
        entry,
        sl,
        tp1,
        tp2,
        slPoints,
        tp1Points,
        tp2Points,
        slPips: slPoints / 10,
        tp1Pips: tp1Points / 10,
        tp2Pips: tp2Points / 10
      };
    }

    // =========================================================
    // CANDIDATES & PLANS
    // =========================================================

    const scalpCandidate = scalpBuy.score >= scalpSell.score ? scalpBuy : scalpSell;
    const intraCandidate = intraBuy.score >= intraSell.score ? intraBuy : intraSell;

    const scalpingPlan = buildTradePlan(
      scalpCandidate.side,
      "SCALPING",
      scalpCandidate.score
    );

    const intradayPlan = buildTradePlan(
      intraCandidate.side,
      "INTRADAY",
      intraCandidate.score
    );

    function waitReason(side, mode) {
      if (mode === "INTRADAY") {
        return `WAITING FOR H4/H1 PULLBACK TO KEY ZONE`;
      }
      return `WAITING FOR CONFIRMED M5 ${side} SETUP`;
    }

    const primaryCandidates = [];

    if (scalpingPlan && scalpCandidate.status === "SIGNAL") {
      primaryCandidates.push({
        ...scalpingPlan,
        score: scalpCandidate.score,
        reasons: scalpCandidate.reasons
      });
    }

    if (intradayPlan && intraCandidate.status === "SIGNAL") {
      primaryCandidates.push({
        ...intradayPlan,
        score: intraCandidate.score,
        reasons: intraCandidate.reasons
      });
    }

    primaryCandidates.sort((a, b) => b.score - a.score);
    const primarySetup = primaryCandidates.length ? primaryCandidates[0] : null;

    // =========================================================
    // FINAL RESPONSE
    // =========================================================

    const output = {
      status: "success",
      engine: {
        name: "SINNCI MARKET ENGINE PRO",
        version: "PRO-4.3 (DUAL ENGINE: ACTIVE SCALP + SNIPER INTRADAY)",
        mode: "HYBRID PRECISION"
      },
      thresholds: {
        scalpingSignal: SCALP_SIGNAL_SCORE,
        intradaySignal: INTRA_SIGNAL_SCORE
      },
      market: {
        symbol: PRICE_SYMBOL,
        price: round(currentPrice, 2)
      },
      direction,
      structure: {
        H4: structureH4.direction,
        H1: structureH1.direction,
        M15: structureM15.direction,
        M5: structureM5.direction
      },
      scalping: {
        buy: {
          ...scalpBuy,
          entry: scalpingPlan?.direction === "BUY" ? scalpingPlan.entry : null,
          sl: scalpingPlan?.direction === "BUY" ? scalpingPlan.sl : null,
          tp1: scalpingPlan?.direction === "BUY" ? scalpingPlan.tp1 : null,
          tp2: scalpingPlan?.direction === "BUY" ? scalpingPlan.tp2 : null,
          wait: scalpBuy.status === "SIGNAL" ? null : waitReason("BUY", "SCALPING")
        },
        sell: {
          ...scalpSell,
          entry: scalpingPlan?.direction === "SELL" ? scalpingPlan.entry : null,
          sl: scalpingPlan?.direction === "SELL" ? scalpingPlan.sl : null,
          tp1: scalpingPlan?.direction === "SELL" ? scalpingPlan.tp1 : null,
          tp2: scalpingPlan?.direction === "SELL" ? scalpingPlan.tp2 : null,
          wait: scalpSell.status === "SIGNAL" ? null : waitReason("SELL", "SCALPING")
        },
        plan: scalpingPlan,
        fixedRisk: {
          SL: "200 points / 20 pips",
          TP1: "600 points / 60 pips",
          TP2: "1200 points / 120 pips"
        }
      },
      intraday: {
        buy: {
          ...intraBuy,
          entry: intradayPlan?.direction === "BUY" ? intradayPlan.entry : null,
          sl: intradayPlan?.direction === "BUY" ? intradayPlan.sl : null,
          tp1: intradayPlan?.direction === "BUY" ? intradayPlan.tp1 : null,
          tp2: intradayPlan?.direction === "BUY" ? intradayPlan.tp2 : null,
          wait: intraBuy.status === "SIGNAL" ? null : waitReason("BUY", "INTRADAY")
        },
        sell: {
          ...intraSell,
          entry: intradayPlan?.direction === "SELL" ? intradayPlan.entry : null,
          sl: intradayPlan?.direction === "SELL" ? intradayPlan.sl : null,
          tp1: intradayPlan?.direction === "SELL" ? intradayPlan.tp1 : null,
          tp2: intradayPlan?.direction === "SELL" ? intradayPlan.tp2 : null,
          wait: intraSell.status === "SIGNAL" ? null : waitReason("SELL", "INTRADAY")
        },
        plan: intradayPlan,
        fixedRisk: {
          SL: "400 points / 40 pips",
          TP1: "1500 points / 150 pips",
          TP2: "2300 points / 230 pips"
        }
      },
      entry: primarySetup?.entry || null,
      sl: primarySetup?.sl || null,
      tp1: primarySetup?.tp1 || null,
      tp2: primarySetup?.tp2 || null,
      primarySetup,
      generatedAt: new Date().toISOString()
    };

    globalThis.__SINNCI_PRO_CACHE = {
      data: output,
      timestamp: Date.now()
    };

    return res.status(200).json(output);

  } catch (error) {
    console.error("SINNCI ENGINE ERROR:", error);
    return res.status(500).json({
      status: "error",
      error: error?.message || "Market analysis failed"
    });
  }
}
