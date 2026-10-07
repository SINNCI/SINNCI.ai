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

    // =========================
    // CACHE
    // =========================

    const CACHE_MS = 90000;

    if (!globalThis.__SINNCI_ANALYZE_CACHE) {
      globalThis.__SINNCI_ANALYZE_CACHE = {
        data: null,
        timestamp: 0,
        running: false
      };
    }

    const cache = globalThis.__SINNCI_ANALYZE_CACHE;

    if (
      cache.data &&
      Date.now() - cache.timestamp < CACHE_MS
    ) {
      return res.status(200).json({
        ...cache.data,
        cached: true
      });
    }

    if (cache.running) {
      if (cache.data) {
        return res.status(200).json({
          ...cache.data,
          cached: true
        });
      }

      return res.status(200).json({
        status: "success",
        symbol: PRICE_SYMBOL,
        signal: "WAIT",
        signalStatus: "WAIT",
        waitReason: "Analysis is already running."
      });
    }

    cache.running = true;

    // =========================
    // HELPERS
    // =========================

    const safeNum = (v, fallback = 0) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    const round = (v, decimals = 2) => {
      const p = Math.pow(10, decimals);
      return Math.round(v * p) / p;
    };

    // XAUUSD
    // 0.01 price = 1 point
    // 10 points = 1 pip
    //
    // 600 points = 60 pips = 6.00 price
    // 1200 points = 120 pips = 12.00 price
    // 1600 points = 160 pips = 16.00 price
    // 2500 points = 250 pips = 25.00 price

    const pointSize = 0.01;

    const pointsToPrice = points =>
      points * pointSize;

    const priceToPoints = price =>
      Math.abs(price) / pointSize;

    const avg = arr => {
      if (!arr.length) return 0;

      return (
        arr.reduce((a, b) => a + b, 0) /
        arr.length
      );
    };

    // =========================
    // FETCH OHLC
    // =========================

    async function getCandles(interval) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(SYMBOL)}` +
        `&interval=${interval}` +
        `&outputsize=80` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (
        !response.ok ||
        data.status === "error"
      ) {
        throw new Error(
          data.message ||
          `Twelve Data error: ${response.status}`
        );
      }

      if (
        !Array.isArray(data.values) ||
        !data.values.length
      ) {
        throw new Error(
          `No candle data returned for ${interval}`
        );
      }

      return data.values
        .map(c => ({
          datetime: c.datetime,
          open: safeNum(c.open),
          high: safeNum(c.high),
          low: safeNum(c.low),
          close: safeNum(c.close)
        }))
        .reverse();
    }

    const [
      h4,
      h1,
      m15,
      m5
    ] = await Promise.all([
      getCandles("4h"),
      getCandles("1h"),
      getCandles("15min"),
      getCandles("5min")
    ]);

    // =========================
    // ATR
    // =========================

    function calculateATR(
      candles,
      period = 14
    ) {
      if (
        candles.length <
        period + 1
      ) {
        return 0;
      }

      const trs = [];

      for (
        let i = 1;
        i < candles.length;
        i++
      ) {
        const current = candles[i];
        const previous = candles[i - 1];

        const tr = Math.max(
          current.high - current.low,

          Math.abs(
            current.high -
            previous.close
          ),

          Math.abs(
            current.low -
            previous.close
          )
        );

        trs.push(tr);
      }

      return avg(
        trs.slice(-period)
      );
    }

    const atrH4 = calculateATR(h4);
    const atrH1 = calculateATR(h1);
    const atrM15 = calculateATR(m15);
    const atrM5 = calculateATR(m5);

    // =========================
    // SWING DETECTION
    // =========================

    function getSwings(
      candles,
      lookback = 2
    ) {
      const highs = [];
      const lows = [];

      for (
        let i = lookback;
        i <
        candles.length - lookback;
        i++
      ) {
        let isHigh = true;
        let isLow = true;

        for (
          let j = 1;
          j <= lookback;
          j++
        ) {
          if (
            candles[i].high <=
              candles[i - j].high ||
            candles[i].high <=
              candles[i + j].high
          ) {
            isHigh = false;
          }

          if (
            candles[i].low >=
              candles[i - j].low ||
            candles[i].low >=
              candles[i + j].low
          ) {
            isLow = false;
          }
        }

        if (isHigh) {
          highs.push(
            candles[i].high
          );
        }

        if (isLow) {
          lows.push(
            candles[i].low
          );
        }
      }

      return {
        highs: highs.slice(-12),
        lows: lows.slice(-12)
      };
    }

    const swingsH4 = getSwings(h4);
    const swingsH1 = getSwings(h1);
    const swingsM15 = getSwings(m15);
    const swingsM5 = getSwings(m5);

    // =========================
    // STRUCTURE
    // =========================

    function structureFromSwings(
      swings
    ) {
      const highs = swings.highs;
      const lows = swings.lows;

      if (
        highs.length < 2 ||
        lows.length < 2
      ) {
        return {
          direction: "NEUTRAL",
          pattern: "MIXED",
          swingHighs: highs.slice(-4),
          swingLows: lows.slice(-4)
        };
      }

      const h1 =
        highs[highs.length - 2];

      const h2 =
        highs[highs.length - 1];

      const l1 =
        lows[lows.length - 2];

      const l2 =
        lows[lows.length - 1];

      const lowerHigh =
        h2 < h1;

      const lowerLow =
        l2 < l1;

      const higherHigh =
        h2 > h1;

      const higherLow =
        l2 > l1;

      if (
        lowerHigh &&
        lowerLow
      ) {
        return {
          direction: "BEARISH",
          pattern: "LH_LL",
          swingHighs: highs.slice(-4),
          swingLows: lows.slice(-4)
        };
      }

      if (
        higherHigh &&
        higherLow
      ) {
        return {
          direction: "BULLISH",
          pattern: "HH_HL",
          swingHighs: highs.slice(-4),
          swingLows: lows.slice(-4)
        };
      }

      return {
        direction: "NEUTRAL",
        pattern: "MIXED",
        swingHighs: highs.slice(-4),
        swingLows: lows.slice(-4)
      };
    }

    const structureH4 =
      structureFromSwings(
        swingsH4
      );

    const structureH1 =
      structureFromSwings(
        swingsH1
      );

    const structureM15 =
      structureFromSwings(
        swingsM15
      );

    // =========================
    // DIRECTION
    // =========================

    function directionFromCandles(
      candles
    ) {
      if (candles.length < 10) {
        return "NEUTRAL";
      }

      const recent =
        candles.slice(-8);

      const bullish =
        recent.filter(
          c => c.close > c.open
        ).length;

      const bearish =
        recent.filter(
          c => c.close < c.open
        ).length;

      if (bullish > bearish) {
        return "BULLISH";
      }

      if (bearish > bullish) {
        return "BEARISH";
      }

      return "NEUTRAL";
    }

    const dirH4 =
      structureH4.direction !==
      "NEUTRAL"
        ? structureH4.direction
        : directionFromCandles(h4);

    const dirH1 =
      structureH1.direction !==
      "NEUTRAL"
        ? structureH1.direction
        : directionFromCandles(h1);

    const dirM15 =
      structureM15.direction !==
      "NEUTRAL"
        ? structureM15.direction
        : directionFromCandles(m15);

    const dirM5 =
      directionFromCandles(m5);

    // =========================
    // CURRENT PRICE
    // =========================

    const currentPrice =
      m5[m5.length - 1].close;

    // =========================
    // BREAKOUT / RETEST
    // =========================

    function breakoutRetest(
      candles
    ) {
      if (candles.length < 20) {
        return {
          bullishBreakout: false,
          bearishBreakout: false,
          bullishRetest: false,
          bearishRetest: false,
          rangeHigh: null,
          rangeLow: null
        };
      }

      const recent =
        candles.slice(-20, -3);

      const rangeHigh =
        Math.max(
          ...recent.map(
            c => c.high
          )
        );

      const rangeLow =
        Math.min(
          ...recent.map(
            c => c.low
          )
        );

      const last =
        candles[candles.length - 1];

      const previous =
        candles[candles.length - 2];

      const bullishBreakout =
        previous.close <=
          rangeHigh &&
        last.close > rangeHigh;

      const bearishBreakout =
        previous.close >=
          rangeLow &&
        last.close < rangeLow;

      const bullishRetest =
        last.low <= rangeHigh &&
        last.close > rangeHigh;

      const bearishRetest =
        last.high >= rangeLow &&
        last.close < rangeLow;

      return {
        bullishBreakout,
        bearishBreakout,
        bullishRetest,
        bearishRetest,
        rangeHigh: round(rangeHigh),
        rangeLow: round(rangeLow)
      };
    }

    const breakout =
      breakoutRetest(m15);

    // =========================
    // M5 CONFIRMATION
    // =========================

    function confirmation(
      candles
    ) {
      if (candles.length < 5) {
        return {
          direction: "NONE",
          reason: "NO_CONFIRMATION",
          bullishEngulfing: false,
          bearishEngulfing: false,
          bullishRejection: false,
          bearishRejection: false,
          strongBullish: false,
          strongBearish: false
        };
      }

      const last =
        candles[candles.length - 1];

      const prev =
        candles[candles.length - 2];

      const body =
        Math.abs(
          last.close -
          last.open
        );

      const range =
        last.high -
        last.low;

      const upperWick =
        last.high -
        Math.max(
          last.open,
          last.close
        );

      const lowerWick =
        Math.min(
          last.open,
          last.close
        ) -
        last.low;

      const bullishEngulfing =
        last.close > last.open &&
        prev.close < prev.open &&
        last.open <= prev.close &&
        last.close >= prev.open;

      const bearishEngulfing =
        last.close < last.open &&
        prev.close > prev.open &&
        last.open >= prev.close &&
        last.close <= prev.open;

      const bullishRejection =
        range > 0 &&
        lowerWick > body * 1.3 &&
        last.close > last.open;

      const bearishRejection =
        range > 0 &&
        upperWick > body * 1.3 &&
        last.close < last.open;

      const strongBullish =
        range > 0 &&
        body / range >= 0.65 &&
        last.close > last.open;

      const strongBearish =
        range > 0 &&
        body / range >= 0.65 &&
        last.close < last.open;

      if (
        bullishEngulfing ||
        bullishRejection ||
        strongBullish
      ) {
        return {
          direction: "BUY",

          reason:
            bullishEngulfing
              ? "BULLISH_ENGULFING"
              : bullishRejection
              ? "BULLISH_REJECTION"
              : "STRONG_BULLISH_CANDLE",

          bullishEngulfing,
          bearishEngulfing,
          bullishRejection,
          bearishRejection,
          strongBullish,
          strongBearish
        };
      }

      if (
        bearishEngulfing ||
        bearishRejection ||
        strongBearish
      ) {
        return {
          direction: "SELL",

          reason:
            bearishEngulfing
              ? "BEARISH_ENGULFING"
              : bearishRejection
              ? "BEARISH_REJECTION"
              : "STRONG_BEARISH_CANDLE",

          bullishEngulfing,
          bearishEngulfing,
          bullishRejection,
          bearishRejection,
          strongBullish,
          strongBearish
        };
      }

      return {
        direction: "NONE",
        reason: "NO_CONFIRMATION",
        bullishEngulfing,
        bearishEngulfing,
        bullishRejection,
        bearishRejection,
        strongBullish,
        strongBearish
      };
    }

    const m5Confirmation =
      confirmation(m5);

    // =========================
    // PUNCA
    // =========================

    function findPunca(
      direction
    ) {
      const levels = [
        ...swingsH1.highs,
        ...swingsM15.highs,
        ...swingsH4.highs,
        ...swingsH1.lows,
        ...swingsM15.lows
      ];

      if (direction === "SELL") {
        const candidates =
          levels.filter(
            v => v > currentPrice
          );

        if (!candidates.length) {
          return null;
        }

        return round(
          Math.min(...candidates)
        );
      }

      const candidates =
        levels.filter(
          v => v < currentPrice
        );

      if (!candidates.length) {
        return null;
      }

      return round(
        Math.max(...candidates)
      );
    }

    const sellPunca =
      findPunca("SELL");

    const buyPunca =
      findPunca("BUY");

    const punca =
      dirH4 === "BEARISH"
        ? sellPunca
        : buyPunca;

    // =========================
    // SCORE ENGINE
    // =========================

    function scoreDirection(
      direction,
      type
    ) {
      let score = 0;

      const scalping =
        type === "SCALPING";

      // =========================
      // SCALPING
      // =========================

      if (scalping) {

        if (
          direction === "SELL" &&
          dirH1 === "BEARISH"
        ) {
          score += 25;
        }

        if (
          direction === "BUY" &&
          dirH1 === "BULLISH"
        ) {
          score += 25;
        }

        if (
          direction === "SELL" &&
          dirM15 === "BEARISH"
        ) {
          score += 25;
        }

        if (
          direction === "BUY" &&
          dirM15 === "BULLISH"
        ) {
          score += 25;
        }

        if (
          direction === "SELL" &&
          dirM5 === "BEARISH"
        ) {
          score += 10;
        }

        if (
          direction === "BUY" &&
          dirM5 === "BULLISH"
        ) {
          score += 10;
        }

        if (
          direction === "SELL" &&
          structureM15.direction ===
            "BEARISH"
        ) {
          score += 10;
        }

        if (
          direction === "BUY" &&
          structureM15.direction ===
            "BULLISH"
        ) {
          score += 10;
        }

        if (
          direction === "SELL" &&
          (
            breakout.bearishBreakout ||
            breakout.bearishRetest
          )
        ) {
          score += 10;
        }

        if (
          direction === "BUY" &&
          (
            breakout.bullishBreakout ||
            breakout.bullishRetest
          )
        ) {
          score += 10;
        }

        if (
          direction === "SELL" &&
          m5Confirmation.direction ===
            "SELL"
        ) {
          score += 15;
        }

        if (
          direction === "BUY" &&
          m5Confirmation.direction ===
            "BUY"
        ) {
          score += 15;
        }

        return Math.min(score, 100);
      }

      // =========================
      // INTRADAY
      // =========================

      if (
        direction === "SELL"
      ) {
        if (dirH4 === "BEARISH") {
          score += 30;
        }

        if (dirH1 === "BEARISH") {
          score += 25;
        }

        if (dirM15 === "BEARISH") {
          score += 15;
        }
      } else {
        if (dirH4 === "BULLISH") {
          score += 30;
        }

        if (dirH1 === "BULLISH") {
          score += 25;
        }

        if (dirM15 === "BULLISH") {
          score += 15;
        }
      }

      if (
        direction === "SELL" &&
        structureM15.direction ===
          "BEARISH"
      ) {
        score += 10;
      }

      if (
        direction === "BUY" &&
        structureM15.direction ===
          "BULLISH"
      ) {
        score += 10;
      }

      if (
        direction === "SELL" &&
        (
          breakout.bearishBreakout ||
          breakout.bearishRetest
        )
      ) {
        score += 10;
      }

      if (
        direction === "BUY" &&
        (
          breakout.bullishBreakout ||
          breakout.bullishRetest
        )
      ) {
        score += 10;
      }

      if (
        direction === "SELL" &&
        m5Confirmation.direction ===
          "SELL"
      ) {
        score += 15;
      }

      if (
        direction === "BUY" &&
        m5Confirmation.direction ===
          "BUY"
      ) {
        score += 15;
      }

      return Math.min(score, 100);
    }

    const scalpingBuy =
      scoreDirection(
        "BUY",
        "SCALPING"
      );

    const scalpingSell =
      scoreDirection(
        "SELL",
        "SCALPING"
      );

    const intradayBuy =
      scoreDirection(
        "BUY",
        "INTRADAY"
      );

    const intradaySell =
      scoreDirection(
        "SELL",
        "INTRADAY"
      );

    // =========================
    // SNR STOP LOSS
    // =========================

    function chooseSNRStopLoss(
      direction,
      entry
    ) {
      const MAX_SL_POINTS = 600;

      const buffer =
        Math.max(
          atrM15 * 0.15,
          0.30
        );

      let candidates = [];

      if (direction === "SELL") {

        candidates = [
          ...swingsM5.highs,
          ...swingsM15.highs
        ];

        candidates =
          candidates
            .filter(
              v => v > entry
            )
            .sort(
              (a, b) => a - b
            );

        for (
          const level of candidates
        ) {
          const sl =
            round(
              level + buffer
            );

          const distance =
            priceToPoints(
              sl - entry
            );

          if (
            distance >= 10 &&
            distance <=
              MAX_SL_POINTS
          ) {
            return {
              sl,
              distance,
              source: "SNR_M5_M15"
            };
          }
        }

        return null;
      }

      candidates = [
        ...swingsM5.lows,
        ...swingsM15.lows
      ];

      candidates =
        candidates
          .filter(
            v => v < entry
          )
          .sort(
            (a, b) => b - a
          );

      for (
        const level of candidates
      ) {
        const sl =
          round(
            level - buffer
          );

        const distance =
          priceToPoints(
            entry - sl
          );

        if (
          distance >= 10 &&
          distance <=
            MAX_SL_POINTS
        ) {
          return {
            sl,
            distance,
            source: "SNR_M5_M15"
          };
        }
      }

      return null;
    }

    // =========================
    // SCALPING ATR FALLBACK
    // =========================

    function chooseScalpingStopLoss(
      direction,
      entry
    ) {
      const MAX_SL_POINTS = 600;

      // Cuba SNR dahulu
      const snr =
        chooseSNRStopLoss(
          direction,
          entry
        );

      if (snr) {
        return snr;
      }

      // =========================
      // ATR FALLBACK
      // =========================

      // ATR M5 biasanya lebih sesuai
      // untuk SL scalping.
      //
      // Minimum 2.00 price
      // Maximum 6.00 price

      let fallbackDistance =
        Math.max(
          atrM5 * 0.75,
          2.00
        );

      fallbackDistance =
        Math.min(
          fallbackDistance,
          pointsToPrice(
            MAX_SL_POINTS
          )
        );

      let sl;

      if (
        direction === "SELL"
      ) {
        sl =
          round(
            entry +
            fallbackDistance
          );
      } else {
        sl =
          round(
            entry -
            fallbackDistance
          );
      }

      const distance =
        priceToPoints(
          Math.abs(
            sl - entry
          )
        );

      if (
        distance < 10 ||
        distance >
          MAX_SL_POINTS
      ) {
        return null;
      }

      return {
        sl,
        distance,
        source: "ATR_M5_FALLBACK"
      };
    }

    // =========================
    // TRADE PLAN
    // =========================

    function buildTradePlan(
      direction,
      type,
      score
    ) {
      const isScalping =
        type === "SCALPING";

      const MAX_SL_POINTS = 600;

      const minimumScore =
        isScalping
          ? 45
          : 55;

      if (
        score <
        minimumScore
      ) {
        return null;
      }

      const entry =
        round(currentPrice);

      let stopData;

      // =========================
      // SCALPING
      // SNR → ATR FALLBACK
      // =========================

      if (isScalping) {
        stopData =
          chooseScalpingStopLoss(
            direction,
            entry
          );
      }

      // =========================
      // INTRADAY
      // SNR ONLY
      // =========================

      else {
        stopData =
          chooseSNRStopLoss(
            direction,
            entry
          );
      }

      if (!stopData) {
        return null;
      }

      const sl =
        stopData.sl;

      const risk =
        priceToPoints(
          sl - entry
        );

      if (
        risk < 10 ||
        risk >
          MAX_SL_POINTS
      ) {
        return null;
      }

      // =========================
      // TP
      // =========================

      const tp1Points =
        isScalping
          ? 600
          : 1600;

      const tp2Points =
        isScalping
          ? 1200
          : 2500;

      let tp1;
      let tp2;

      if (
        direction === "SELL"
      ) {
        tp1 =
          round(
            entry -
            pointsToPrice(
              tp1Points
            )
          );

        tp2 =
          round(
            entry -
            pointsToPrice(
              tp2Points
            )
          );
      } else {
        tp1 =
          round(
            entry +
            pointsToPrice(
              tp1Points
            )
          );

        tp2 =
          round(
            entry +
            pointsToPrice(
              tp2Points
            )
          );
      }

      // =========================
      // STATUS
      // =========================

      let status = "SIGNAL";

      let confirmationRequired =
        false;

      // Intraday wajib M5
      if (!isScalping) {
        confirmationRequired = true;

        if (
          m5Confirmation.direction !==
          direction
        ) {
          status = "SETUP";
        }
      }

      return {
        direction,
        type,
        status,

        entry,
        sl,
        tp1,
        tp2,

        risk,
        maxAllowedRisk:
          MAX_SL_POINTS,

        slSource:
          stopData.source,

        tp1Points,
        tp2Points,

        tp1Pips:
          tp1Points / 10,

        tp2Pips:
          tp2Points / 10,

        confirmation:
          m5Confirmation.direction ===
          direction,

        confirmationRequired,

        confirmationReason:
          m5Confirmation.direction ===
          direction
            ? m5Confirmation.reason
            : "NO_M5_CONFIRMATION"
      };
    }

    // =========================
    // BUILD SETUP
    // =========================

    function buildSetup(
      type
    ) {
      const isScalping =
        type === "SCALPING";

      const buyScore =
        isScalping
          ? scalpingBuy
          : intradayBuy;

      const sellScore =
        isScalping
          ? scalpingSell
          : intradaySell;

      let direction;

      if (
        sellScore >
        buyScore
      ) {
        direction = "SELL";
      }

      else if (
        buyScore >
        sellScore
      ) {
        direction = "BUY";
      }

      else {
        return null;
      }

      const score =
        direction === "SELL"
          ? sellScore
          : buyScore;

      const plan =
        buildTradePlan(
          direction,
          type,
          score
        );

      if (!plan) {
        return null;
      }

      let reason = "";

      if (
        direction === "SELL"
      ) {
        reason =
          isScalping
            ? "H1 bearish + M15 bearish + M5 momentum"
            : "H4/H1 bearish + M15 bearish";
      }

      else {
        reason =
          isScalping
            ? "H1 bullish + M15 bullish + M5 momentum"
            : "H4/H1 bullish + M15 bullish";
      }

      if (
        breakout.bearishBreakout ||
        breakout.bullishBreakout
      ) {
        reason += " + breakout";
      }

      if (
        breakout.bearishRetest ||
        breakout.bullishRetest
      ) {
        reason += " + retest";
      }

      if (
        m5Confirmation.direction ===
        direction
      ) {
        reason +=
          ` + M5 ${m5Confirmation.reason}`;
      }

      else if (isScalping) {
        reason +=
          " + Scalping confirmation optional";
      }

      else {
        reason +=
          " + waiting M5 confirmation";
      }

      return {
        ...plan,

        score,
        reason,

        punca:
          direction === "SELL"
            ? sellPunca
            : buyPunca
      };
    }

    const scalping =
      buildSetup("SCALPING");

    const intraday =
      buildSetup("INTRADAY");

    // =========================
    // PRIMARY SETUP
    // =========================

    const candidates =
      [
        scalping,
        intraday
      ].filter(Boolean);

    const confirmed =
      candidates
        .filter(
          s =>
            s.status ===
            "SIGNAL"
        )
        .sort(
          (a, b) =>
            b.score -
            a.score
        );

    const primarySetup =
      confirmed[0] ||
      candidates.sort(
        (a, b) =>
          b.score -
          a.score
      )[0] ||
      null;

    // =========================
    // TOP SIGNAL
    // =========================

    let signal = "WAIT";
    let signalStatus = "WAIT";
    let signalType = null;

    let entry = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    let risk = null;
    let maxAllowedRisk = null;

    if (primarySetup) {
      signal =
        primarySetup.direction;

      signalStatus =
        primarySetup.status;

      signalType =
        primarySetup.type;

      entry =
        primarySetup.entry;

      sl =
        primarySetup.sl;

      tp1 =
        primarySetup.tp1;

      tp2 =
        primarySetup.tp2;

      risk =
        primarySetup.risk;

      maxAllowedRisk =
        primarySetup.maxAllowedRisk;
    }

    // =========================
    // WAIT REASON
    // =========================

    let waitReason = null;

    if (!primarySetup) {
      const highestScore =
        Math.max(
          scalpingBuy,
          scalpingSell,
          intradayBuy,
          intradaySell
        );

      if (
        highestScore < 45
      ) {
        waitReason =
          "Market structure is not strong enough for a valid setup.";
      }

      else {
        waitReason =
          "Bias detected but no valid trade plan.";
      }
    }

    else if (
      primarySetup.status ===
      "SETUP"
    ) {
      waitReason =
        "Intraday setup detected. Waiting for M5 confirmation.";
    }

    // =========================
    // SESSION
    // =========================

    function getSession() {
      const now = new Date();

      const formatTime =
        timeZone =>
          new Intl.DateTimeFormat(
            "en-GB",
            {
              timeZone,

              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            }
          ).format(now);

      const formatMalaysia =
        new Intl.DateTimeFormat(
          "en-GB",
          {
            timeZone:
              "Asia/Kuala_Lumpur",

            dateStyle:
              "short",

            timeStyle:
              "medium"
          }
        ).format(now);

      const getHour =
        timeZone =>
          Number(
            new Intl.DateTimeFormat(
              "en-US",
              {
                timeZone,

                hour:
                  "2-digit",

                hour12:
                  false
              }
            ).format(now)
          );

      const tokyoHour =
        getHour(
          "Asia/Tokyo"
        );

      const londonHour =
        getHour(
          "Europe/London"
        );

      const newYorkHour =
        getHour(
          "America/New_York"
        );

      const asiaOpen =
        tokyoHour >= 9 &&
        tokyoHour < 18;

      const londonOpen =
        londonHour >= 8 &&
        londonHour < 17;

      const newYorkOpen =
        newYorkHour >= 8 &&
        newYorkHour < 17;

      const overlap =
        londonOpen &&
        newYorkOpen;

      let activeSession =
        "MARKET CLOSED";

      let activity =
        "LOW";

      if (overlap) {
        activeSession =
          "LONDON + NEW YORK OVERLAP";

        activity =
          "VERY HIGH";
      }

      else if (londonOpen) {
        activeSession =
          "LONDON";

        activity =
          "HIGH";
      }

      else if (newYorkOpen) {
        activeSession =
          "NEW YORK";

        activity =
          "HIGH";
      }

      else if (asiaOpen) {
        activeSession =
          "ASIA / TOKYO";

        activity =
          "MODERATE";
      }

      return {
        timezone:
          "Asia/Kuala_Lumpur",

        malaysiaTime:
          formatMalaysia,

        Asia: {
          status:
            asiaOpen
              ? "OPEN"
              : "CLOSED",

          localTime:
            formatTime(
              "Asia/Tokyo"
            )
        },

        London: {
          status:
            londonOpen
              ? "OPEN"
              : "CLOSED",

          localTime:
            formatTime(
              "Europe/London"
            )
        },

        NewYork: {
          status:
            newYorkOpen
              ? "OPEN"
              : "CLOSED",

          localTime:
            formatTime(
              "America/New_York"
            )
        },

        LondonNewYorkOverlap: {
          status:
            overlap
              ? "ACTIVE"
              : "INACTIVE"
        },

        activeSession,
        activity
      };
    }

    const session =
      getSession();

    // =========================
    // FINAL RESPONSE
    // =========================

    const result = {
      status: "success",

      symbol:
        PRICE_SYMBOL,

      signal,
      signalStatus,
      signalType,

      currentPrice:
        round(currentPrice),

      session,

      direction: {
        H4: dirH4,
        H1: dirH1,
        M15: dirM15,
        M5: dirM5
      },

      structure: {
        H4: structureH4,
        H1: structureH1,
        M15: structureM15
      },

      breakout,

      confirmation:
        m5Confirmation,

      punca,

      scores: {
        BUY:
          Math.max(
            scalpingBuy,
            intradayBuy
          ),

        SELL:
          Math.max(
            scalpingSell,
            intradaySell
          ),

        scalpingBuy,
        scalpingSell,
        intradayBuy,
        intradaySell
      },

      entry,

      sl,
      SL: sl,

      tp1,
      TP1: tp1,

      tp2,
      TP2: tp2,

      risk,

      maxAllowedRisk,

      waitReason,

      scalping,
      intraday,

      primarySetup,

      ATR: {
        H4: round(atrH4),
        H1: round(atrH1),
        M15: round(atrM15),
        M5: round(atrM5)
      },

      candles: {
        H4: h4.length,
        H1: h1.length,
        M15: m15.length,
        M5: m5.length
      },

      engine: {
        timeframes: [
          "H4",
          "H1",
          "M15",
          "M5"
        ],

        sessions: [
          "ASIA / TOKYO",
          "LONDON",
          "NEW YORK",
          "LONDON + NEW YORK OVERLAP"
        ],

        data: "OHLC",

        method:
          "Market Structure + S/R + Breakout Retest + Aggressive Scalping + Selective Intraday",

        riskRules: {
          pointSize:
            "0.01 price = 1 point",

          scalpingMode:
            "AGGRESSIVE",

          scalpingMinimumScore:
            45,

          scalpingSL:
            "SNR M5/M15, ATR M5 fallback, maximum 600 points",

          scalpingTP:
            "TP1 600 points / TP2 1200 points",

          scalpingConfirmation:
            "M5 confirmation preferred but not mandatory",

          intradayMode:
            "SELECTIVE",

          intradayMinimumScore:
            55,

          intradaySL:
            "SNR M5/M15, maximum 600 points",

          intradayTP:
            "TP1 1600 points / TP2 2500 points",

          intradayConfirmation:
            "M5 confirmation required"
        }
      },

      cached: false,

      timestamp:
        new Date().toISOString()
    };

    cache.data = result;
    cache.timestamp = Date.now();

    return res
      .status(200)
      .json(result);

  } catch (error) {

    console.error(
      "SINNCI ANALYZE ERROR:",
      error
    );

    return res
      .status(500)
      .json({
        status: "error",
        signal: "WAIT",
        error:
          error.message ||
          "Analysis failed"
      });

  } finally {

    if (
      globalThis.__SINNCI_ANALYZE_CACHE
    ) {
      globalThis
        .__SINNCI_ANALYZE_CACHE
        .running = false;
    }
  }
    }
