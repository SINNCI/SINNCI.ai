export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "API key not configured"
      });
    }

    const symbol = "XAU/USD";

    const TF = {
      H4: "4h",
      H1: "1h",
      M30: "30min",
      M15: "15min",
      M5: "5min"
    };

    // =========================
    // GET CANDLES
    // =========================

    async function getCandles(interval, outputsize = 150) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (
        !response.ok ||
        data.status === "error" ||
        !data.values
      ) {
        throw new Error(
          data.message || `Failed to fetch ${interval}`
        );
      }

      return data.values
        .map(c => ({
          time: new Date(c.datetime).getTime(),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        }))
        .filter(c =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .sort((a, b) => a.time - b.time);
    }

    // =========================
    // GET ALL TIMEFRAMES
    // =========================

    const [h4, h1, m30, m15, m5] = await Promise.all([
      getCandles(TF.H4, 150),
      getCandles(TF.H1, 150),
      getCandles(TF.M30, 150),
      getCandles(TF.M15, 150),
      getCandles(TF.M5, 150)
    ]);

    // =========================
    // BASIC VALIDATION
    // =========================

    if (
      h4.length < 30 ||
      h1.length < 30 ||
      m30.length < 30 ||
      m15.length < 30 ||
      m5.length < 10
    ) {
      throw new Error("Not enough market data");
    }

    // =========================
    // HELPERS
    // =========================

    function roundPrice(value) {
      return Number(value.toFixed(2));
    }

    function averageRange(candles, count = 20) {
      const arr = candles.slice(-count);

      if (!arr.length) return 0;

      return (
        arr.reduce(
          (sum, c) => sum + (c.high - c.low),
          0
        ) / arr.length
      );
    }

    function getDirection(candles) {
      const last = candles[candles.length - 1];
      const lookback = candles.slice(-12);

      const highest = Math.max(
        ...lookback.map(c => c.high)
      );

      const lowest = Math.min(
        ...lookback.map(c => c.low)
      );

      const middle = (highest + lowest) / 2;

      if (last.close > middle) {
        return "BULLISH";
      }

      if (last.close < middle) {
        return "BEARISH";
      }

      return "NEUTRAL";
    }

    // =========================
    // MARKET DIRECTIONS
    // =========================

    const directionH4 = getDirection(h4);
    const directionH1 = getDirection(h1);
    const directionM30 = getDirection(m30);
    const directionM15 = getDirection(m15);
    const directionM5 = getDirection(m5);

    // =========================
    // CURRENT PRICE
    // =========================

    const currentPrice =
      m5[m5.length - 1].close;

    // =========================
    // FIND HISTORICAL LEVELS
    // =========================

    function findHistoricalLevels(candles) {
      const levels = [];

      const start = Math.max(
        3,
        candles.length - 120
      );

      for (let i = start; i < candles.length - 3; i++) {
        const c = candles[i];

        const left = candles.slice(
          Math.max(0, i - 3),
          i
        );

        const right = candles.slice(
          i + 1,
          i + 4
        );

        const leftHigh = Math.max(
          ...left.map(x => x.high)
        );

        const rightHigh = Math.max(
          ...right.map(x => x.high)
        );

        const leftLow = Math.min(
          ...left.map(x => x.low)
        );

        const rightLow = Math.min(
          ...right.map(x => x.low)
        );

        // RESISTANCE
        if (
          c.high >= leftHigh &&
          c.high >= rightHigh
        ) {
          levels.push({
            type: "SELL",
            price: c.high,
            strength: 2
          });
        }

        // SUPPORT
        if (
          c.low <= leftLow &&
          c.low <= rightLow
        ) {
          levels.push({
            type: "BUY",
            price: c.low,
            strength: 2
          });
        }
      }

      return levels;
    }

    // =========================
    // FIND BREAKOUT / ROLE REVERSAL
    // =========================

    function findBreakouts(candles) {
      const levels = [];

      for (
        let i = 10;
        i < candles.length - 2;
        i++
      ) {
        const previous = candles.slice(
          i - 8,
          i
        );

        const resistance = Math.max(
          ...previous.map(c => c.high)
        );

        const support = Math.min(
          ...previous.map(c => c.low)
        );

        const candle = candles[i];

        // BULLISH BREAKOUT
        if (candle.close > resistance) {
          levels.push({
            type: "BUY",
            price: resistance,
            strength: 3,
            breakout: true
          });
        }

        // BEARISH BREAKOUT
        if (candle.close < support) {
          levels.push({
            type: "SELL",
            price: support,
            strength: 3,
            breakout: true
          });
        }
      }

      return levels;
    }

    // =========================
    // COLLECT LEVELS
    // =========================

    let levels = [];

    const timeframeData = [
      { candles: h4, tf: "H4" },
      { candles: h1, tf: "H1" },
      { candles: m30, tf: "M30" },
      { candles: m15, tf: "M15" }
    ];

    for (const item of timeframeData) {
      const historical =
        findHistoricalLevels(item.candles);

      const breakouts =
        findBreakouts(item.candles);

      historical.forEach(level => {
        levels.push({
          ...level,
          source: item.tf
        });
      });

      breakouts.forEach(level => {
        levels.push({
          ...level,
          source: item.tf
        });
      });
    }

    // =========================
    // MERGE NEARBY LEVELS
    // =========================

    function mergeLevels(levels) {
      const merged = [];

      for (const level of levels) {
        const existing = merged.find(x =>
          x.type === level.type &&
          Math.abs(x.price - level.price) < 2.5
        );

        if (existing) {
          existing.price =
            (existing.price + level.price) / 2;

          existing.strength += level.strength;
        } else {
          merged.push({
            ...level
          });
        }
      }

      return merged;
    }

    levels = mergeLevels(levels);

    // =========================
    // FIND BEST PUNCA
    // =========================

    function findBestPunca(type) {
      const candidates = levels
        .filter(level => level.type === type)
        .map(level => {
          const distance =
            Math.abs(
              currentPrice - level.price
            );

          return {
            ...level,
            distance
          };
        })
        .filter(level => {
          // Jangan ambil level terlalu jauh
          return level.distance <= 80;
        })
        .sort((a, b) => {
          const scoreA =
            a.strength * 20 -
            a.distance;

          const scoreB =
            b.strength * 20 -
            b.distance;

          return scoreB - scoreA;
        });

      return candidates[0] || null;
    }

    const buyPunca =
      findBestPunca("BUY");

    const sellPunca =
      findBestPunca("SELL");

    // =========================
    // M5 CONFIRMATION
    // =========================

    const m5Last =
      m5[m5.length - 1];

    const m5Previous =
      m5[m5.length - 2];

    const body =
      Math.abs(
        m5Last.close - m5Last.open
      );

    const range =
      m5Last.high - m5Last.low;

    const upperWick =
      m5Last.high -
      Math.max(
        m5Last.open,
        m5Last.close
      );

    const lowerWick =
      Math.min(
        m5Last.open,
        m5Last.close
      ) -
      m5Last.low;

    const bullishEngulfing =
      m5Last.close > m5Last.open &&
      m5Previous.close < m5Previous.open &&
      m5Last.close >= m5Previous.open &&
      m5Last.open <= m5Previous.close;

    const bearishEngulfing =
      m5Last.close < m5Last.open &&
      m5Previous.close > m5Previous.open &&
      m5Last.close <= m5Previous.open &&
      m5Last.open >= m5Previous.close;

    const bullishRejection =
      lowerWick > body * 1.3 &&
      m5Last.close > m5Last.open;

    const bearishRejection =
      upperWick > body * 1.3 &&
      m5Last.close < m5Last.open;

    const strongBullish =
      range > 0 &&
      body / range >= 0.6 &&
      m5Last.close > m5Last.open;

    const strongBearish =
      range > 0 &&
      body / range >= 0.6 &&
      m5Last.close < m5Last.open;

    const buyConfirmation =
      bullishEngulfing ||
      bullishRejection ||
      strongBullish;

    const sellConfirmation =
      bearishEngulfing ||
      bearishRejection ||
      strongBearish;

    // =========================
    // SCORE
    // =========================

    let buyScore = 0;
    let sellScore = 0;

    // H4
    if (directionH4 === "BULLISH")
      buyScore += 25;

    if (directionH4 === "BEARISH")
      sellScore += 25;

    // H1
    if (directionH1 === "BULLISH")
      buyScore += 25;

    if (directionH1 === "BEARISH")
      sellScore += 25;

    // M30
    if (directionM30 === "BULLISH")
      buyScore += 10;

    if (directionM30 === "BEARISH")
      sellScore += 10;

    // M15
    if (directionM15 === "BULLISH")
      buyScore += 10;

    if (directionM15 === "BEARISH")
      sellScore += 10;

    // PUNCA
    if (buyPunca)
      buyScore += 15;

    if (sellPunca)
      sellScore += 15;

    // M5
    if (buyConfirmation)
      buyScore += 15;

    if (sellConfirmation)
      sellScore += 15;

    // =========================
    // PUNCA DISTANCE FILTER
    // =========================

    let buyNearPunca = false;
    let sellNearPunca = false;

    if (buyPunca) {
      buyNearPunca =
        buyPunca.distance <= 25;
    }

    if (sellPunca) {
      sellNearPunca =
        sellPunca.distance <= 25;
    }

    // =========================
    // FINAL SIGNAL
    // =========================

    let signal = "WAIT";
    let punca = null;

    if (
      buyScore >= 70 &&
      buyNearPunca &&
      buyConfirmation &&
      directionH4 !== "BEARISH" &&
      directionH1 !== "BEARISH"
    ) {
      signal = "BUY";
      punca = buyPunca;
    }

    if (
      sellScore >= 70 &&
      sellNearPunca &&
      sellConfirmation &&
      directionH4 !== "BULLISH" &&
      directionH1 !== "BULLISH"
    ) {
      if (
        sellScore > buyScore
      ) {
        signal = "SELL";
        punca = sellPunca;
      }
    }

    // =========================
    // ENTRY / SL / TP
    // =========================

    let entry = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    if (signal === "BUY" && punca) {
      entry = currentPrice;

      sl =
        Math.min(
          punca.price - 2,
          m5Last.low - 1
        );

      tp1 =
        entry + 6;

      tp2 =
        entry + 12;
    }

    if (signal === "SELL" && punca) {
      entry = currentPrice;

      sl =
        Math.max(
          punca.price + 2,
          m5Last.high + 1
        );

      tp1 =
        entry - 6;

      tp2 =
        entry - 12;
    }

    // =========================
    // RESPONSE
    // =========================

    return res.status(200).json({
      signal,

      direction: {
        H4: directionH4,
        H1: directionH1,
        M30: directionM30,
        M15: directionM15,
        M5: directionM5
      },

      entry:
        entry !== null
          ? roundPrice(entry)
          : null,

      sl:
        sl !== null
          ? roundPrice(sl)
          : null,

      tp1:
        tp1 !== null
          ? roundPrice(tp1)
          : null,

      tp2:
        tp2 !== null
          ? roundPrice(tp2)
          : null,

      punca: punca
        ? {
            type: punca.type,
            source: punca.source,
            price: roundPrice(punca.price),
            distance: roundPrice(punca.distance),
            strength: punca.strength
          }
        : null,

      scores: {
        buy: buyScore,
        sell: sellScore
      },

      confirmation: {
        M5: {
          bullishEngulfing,
          bearishEngulfing,
          bullishRejection,
          bearishRejection,
          strongBullish,
          strongBearish
        }
      },

      currentPrice:
        roundPrice(currentPrice),

      status:
        signal === "WAIT"
          ? "NO HIGH-QUALITY SETUP"
          : "HIGH-QUALITY SETUP"
    });

  } catch (error) {

    console.error("SINNCI AI ERROR:", error);

    return res.status(500).json({
      error:
        error.message ||
        "Analysis failed"
    });
  }
      }
