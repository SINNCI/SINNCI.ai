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

    const last = arr =>
      arr[arr.length - 1];

    const prev = arr =>
      arr[arr.length - 2];

    const clamp = (value, min, max) =>
      Math.max(min, Math.min(max, value));

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
        i < candles.length - lookback;
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
          highs.push({
            price: candles[i].high,
            index: i
          });
        }

        if (isLow) {
          lows.push({
            price: candles[i].low,
            index: i
          });
        }
      }

      return {
        highs: highs.slice(-15),
        lows: lows.slice(-15)
      };
    }

    const swingsH4 = getSwings(h4);
    const swingsH1 = getSwings(h1);
    const swingsM15 = getSwings(m15);
    const swingsM5 = getSwings(m5);

    // =========================
    // SIMPLE SWING PRICES
    // =========================

    function swingPrices(swings) {
      return {
        highs: swings.highs.map(
          x => x.price
        ),
        lows: swings.lows.map(
          x => x.price
        )
      };
    }

    const swingPriceH4 =
      swingPrices(swingsH4);

    const swingPriceH1 =
      swingPrices(swingsH1);

    const swingPriceM15 =
      swingPrices(swingsM15);

    const swingPriceM5 =
      swingPrices(swingsM5);

    // =========================
    // STRUCTURE
    // =========================

    function structureFromSwings(
      swings
    ) {
      const highs =
        swings.highs.map(x => x.price);

      const lows =
        swings.lows.map(x => x.price);

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

      const lowerHigh = h2 < h1;
      const lowerLow = l2 < l1;

      const higherHigh = h2 > h1;
      const higherLow = l2 > l1;

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
      structureFromSwings(swingsH4);

    const structureH1 =
      structureFromSwings(swingsH1);

    const structureM15 =
      structureFromSwings(swingsM15);

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
      structureH4.direction !== "NEUTRAL"
        ? structureH4.direction
        : directionFromCandles(h4);

    const dirH1 =
      structureH1.direction !== "NEUTRAL"
        ? structureH1.direction
        : directionFromCandles(h1);

    const dirM15 =
      structureM15.direction !== "NEUTRAL"
        ? structureM15.direction
        : directionFromCandles(m15);

    const dirM5 =
      directionFromCandles(m5);

    // =========================
    // CURRENT PRICE
    // =========================

    const currentPrice =
      last(m5).close;

    // =========================
    // CANDLE HELPERS
    // =========================

    function candleBody(c) {
      return Math.abs(
        c.close - c.open
      );
    }

    function candleRange(c) {
      return c.high - c.low;
    }

    function upperWick(c) {
      return (
        c.high -
        Math.max(c.open, c.close)
      );
    }

    function lowerWick(c) {
      return (
        Math.min(c.open, c.close) -
        c.low
      );
    }

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

      const current =
        last(candles);

      const previous =
        prev(candles);

      const bullishBreakout =
        previous.close <= rangeHigh &&
        current.close > rangeHigh;

      const bearishBreakout =
        previous.close >= rangeLow &&
        current.close < rangeLow;

      const bullishRetest =
        current.low <= rangeHigh &&
        current.close > rangeHigh;

      const bearishRetest =
        current.high >= rangeLow &&
        current.close < rangeLow;

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

      const current =
        last(candles);

      const previous =
        prev(candles);

      const body =
        candleBody(current);

      const range =
        candleRange(current);

      const upWick =
        upperWick(current);

      const downWick =
        lowerWick(current);

      const bullishEngulfing =
        current.close > current.open &&
        previous.close < previous.open &&
        current.open <= previous.close &&
        current.close >= previous.open;

      const bearishEngulfing =
        current.close < current.open &&
        previous.close > previous.open &&
        current.open >= previous.close &&
        current.close <= previous.open;

      const bullishRejection =
        range > 0 &&
        downWick > body * 1.3 &&
        current.close > current.open;

      const bearishRejection =
        range > 0 &&
        upWick > body * 1.3 &&
        current.close < current.open;

      const strongBullish =
        range > 0 &&
        body / range >= 0.65 &&
        current.close > current.open;

      const strongBearish =
        range > 0 &&
        body / range >= 0.65 &&
        current.close < current.open;

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
    // ZONE HELPERS
    // =========================

    const ZONE_TOLERANCE =
      Math.max(
        atrM15 * 0.35,
        0.80
      );

    function makeZone(
      type,
      direction,
      high,
      low,
      originIndex,
      timeframe,
      source
    ) {
      high = safeNum(high);
      low = safeNum(low);

      if (
        high <= low ||
        !Number.isFinite(high) ||
        !Number.isFinite(low)
      ) {
        return null;
      }

      const zoneHeight =
        Math.max(
          high - low,
          0.20
        );

      const normalizedHigh =
        round(
          Math.max(high, low)
        );

      const normalizedLow =
        round(
          Math.min(high, low)
        );

      return {
        type,
        direction,
        high: normalizedHigh,
        low: normalizedLow,
        midpoint: round(
          (normalizedHigh +
            normalizedLow) / 2
        ),
        timeframe,
        source,
        originIndex,
        zoneHeight:
          round(zoneHeight),
        active: false,
        status: "FRESH",
        touches: 0,
        distancePoints: null
      };
    }

    function zoneDistance(zone) {
      if (
        currentPrice >= zone.low &&
        currentPrice <= zone.high
      ) {
        return 0;
      }

      if (
        currentPrice < zone.low
      ) {
        return priceToPoints(
          zone.low -
          currentPrice
        );
      }

      return priceToPoints(
        currentPrice -
        zone.high
      );
    }

    function countZoneTouches(
      candles,
      zone,
      startIndex
    ) {
      let touches = 0;

      const start =
        clamp(
          startIndex || 0,
          0,
          candles.length - 1
        );

      for (
        let i = start;
        i < candles.length;
        i++
      ) {
        const c = candles[i];

        const overlaps =
          c.high >= zone.low &&
          c.low <= zone.high;

        if (overlaps) {
          touches++;
        }
      }

      return touches;
    }

    function classifyZone(
      candles,
      zone
    ) {
      const touches =
        countZoneTouches(
          candles,
          zone,
          zone.originIndex + 1
        );

      zone.touches = touches;

      const distance =
        zoneDistance(zone);

      zone.distancePoints =
        round(distance, 1);

      const inside =
        distance === 0;

      const near =
        distance <=
        priceToPoints(
          ZONE_TOLERANCE
        );

      zone.active =
        inside || near;

      if (touches === 0) {
        zone.status = "FRESH";
      } else if (touches === 1) {
        zone.status = "FIRST_TOUCH";
      } else if (touches === 2) {
        zone.status = "SECOND_TOUCH";
      } else {
        zone.status = "USED";
      }

      return zone;
    }

    // =========================
    // PATTERN ENGINE
    // =========================

    function detectPatterns(
      candles,
      swings,
      timeframe
    ) {
      const zones = [];

      const highs =
        swings.highs;

      const lows =
        swings.lows;

      // -------------------------
      // QM BUY / SELL
      // -------------------------

      if (
        highs.length >= 3 &&
        lows.length >= 3
      ) {
        const H1 =
          highs[highs.length - 3];

        const H2 =
          highs[highs.length - 2];

        const H3 =
          highs[highs.length - 1];

        const L1 =
          lows[lows.length - 3];

        const L2 =
          lows[lows.length - 2];

        const L3 =
          lows[lows.length - 1];

        // QM SELL:
        // LH -> LL -> HH
        // last HH becomes QM area
        const qmSell =
          H2.price < H1.price &&
          L2.price < L1.price &&
          H3.price > H2.price;

        if (qmSell) {
          const candle =
            candles[
              clamp(
                H3.index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "QM_SELL",
              "SELL",
              candle.high,
              candle.open,
              H3.index,
              timeframe,
              "QM"
            )
          );
        }

        // QM BUY:
        // HL -> HH -> LL
        // last LL becomes QM area
        const qmBuy =
          L2.price > L1.price &&
          H2.price > H1.price &&
          L3.price < L2.price;

        if (qmBuy) {
          const candle =
            candles[
              clamp(
                L3.index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "QM_BUY",
              "BUY",
              candle.open,
              candle.low,
              L3.index,
              timeframe,
              "QM"
            )
          );
        }
      }

      // -------------------------
      // DOUBLE TOP / BOTTOM
      // -------------------------

      if (
        highs.length >= 2
      ) {
        const a =
          highs[highs.length - 2];

        const b =
          highs[highs.length - 1];

        const tolerance =
          Math.max(
            atrM15 * 0.20,
            0.40
          );

        if (
          Math.abs(
            a.price - b.price
          ) <= tolerance
        ) {
          const index =
            b.index;

          const c =
            candles[
              clamp(
                index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "DOUBLE_TOP",
              "SELL",
              Math.max(
                a.price,
                b.price
              ),
              c.open,
              index,
              timeframe,
              "DOUBLE_TOP"
            )
          );
        }
      }

      if (
        lows.length >= 2
      ) {
        const a =
          lows[lows.length - 2];

        const b =
          lows[lows.length - 1];

        const tolerance =
          Math.max(
            atrM15 * 0.20,
            0.40
          );

        if (
          Math.abs(
            a.price - b.price
          ) <= tolerance
        ) {
          const index =
            b.index;

          const c =
            candles[
              clamp(
                index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "DOUBLE_BOTTOM",
              "BUY",
              c.open,
              Math.min(
                a.price,
                b.price
              ),
              index,
              timeframe,
              "DOUBLE_BOTTOM"
            )
          );
        }
      }

      // -------------------------
      // HEAD & SHOULDERS
      // -------------------------

      if (
        highs.length >= 3
      ) {
        const left =
          highs[highs.length - 3];

        const head =
          highs[highs.length - 2];

        const right =
          highs[highs.length - 1];

        const shoulderTolerance =
          Math.max(
            atrM15 * 0.50,
            1.00
          );

        if (
          head.price > left.price &&
          head.price > right.price &&
          Math.abs(
            left.price -
            right.price
          ) <= shoulderTolerance
        ) {
          const c =
            candles[
              clamp(
                head.index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "HEAD_SHOULDERS",
              "SELL",
              head.price,
              c.open,
              head.index,
              timeframe,
              "H&S"
            )
          );
        }
      }

      // -------------------------
      // INVERSE HEAD & SHOULDERS
      // -------------------------

      if (
        lows.length >= 3
      ) {
        const left =
          lows[lows.length - 3];

        const head =
          lows[lows.length - 2];

        const right =
          lows[lows.length - 1];

        const shoulderTolerance =
          Math.max(
            atrM15 * 0.50,
            1.00
          );

        if (
          head.price < left.price &&
          head.price < right.price &&
          Math.abs(
            left.price -
            right.price
          ) <= shoulderTolerance
        ) {
          const c =
            candles[
              clamp(
                head.index,
                0,
                candles.length - 1
              )
            ];

          zones.push(
            makeZone(
              "INVERSE_HEAD_SHOULDERS",
              "BUY",
              c.open,
              head.price,
              head.index,
              timeframe,
              "INVERSE_H&S"
            )
          );
        }
      }

      // -------------------------
      // RBR / DBR / RBD / DBD
      // -------------------------

      for (
        let i = 2;
        i < candles.length - 2;
        i++
      ) {
        const a =
          candles[i - 2];

        const b =
          candles[i - 1];

        const c =
          candles[i];

        const bodyA =
          candleBody(a);

        const bodyB =
          candleBody(b);

        const bodyC =
          candleBody(c);

        const rangeA =
          candleRange(a);

        const rangeB =
          candleRange(b);

        const rangeC =
          candleRange(c);

        if (
          rangeA <= 0 ||
          rangeB <= 0 ||
          rangeC <= 0
        ) {
          continue;
        }

        const aBull =
          a.close > a.open;

        const bBull =
          b.close > b.open;

        const cBull =
          c.close > c.open;

        const aBear =
          a.close < a.open;

        const bBear =
          b.close < b.open;

        const cBear =
          c.close < c.open;

        // RBR
        if (
          aBull &&
          bBull &&
          cBull &&
          bodyB / rangeB >= 0.35 &&
          bodyC / rangeC >= 0.55
        ) {
          zones.push(
            makeZone(
              "RBR",
              "BUY",
              Math.max(
                a.open,
                a.close
              ),
              Math.min(
                a.open,
                a.close
              ),
              i - 2,
              timeframe,
              "RBR"
            )
          );
        }

        // DBR
        if (
          aBear &&
          bBull &&
          cBull &&
          bodyB / rangeB >= 0.30 &&
          bodyC / rangeC >= 0.50
        ) {
          zones.push(
            makeZone(
              "DBR",
              "BUY",
              Math.max(
                b.open,
                b.close
              ),
              b.low,
              i - 1,
              timeframe,
              "DBR"
            )
          );
        }

        // RBD
        if (
          aBull &&
          bBear &&
          cBear &&
          bodyB / rangeB >= 0.30 &&
          bodyC / rangeC >= 0.50
        ) {
          zones.push(
            makeZone(
              "RBD",
              "SELL",
              b.high,
              Math.min(
                b.open,
                b.close
              ),
              i - 1,
              timeframe,
              "RBD"
            )
          );
        }

        // DBD
        if (
          aBear &&
          bBear &&
          cBear &&
          bodyB / rangeB >= 0.35 &&
          bodyC / rangeC >= 0.55
        ) {
          zones.push(
            makeZone(
              "DBD",
              "SELL",
              Math.max(
                a.open,
                a.close
              ),
              Math.min(
                a.open,
                a.close
              ),
              i - 2,
              timeframe,
              "DBD"
            )
          );
        }
      }

      return zones
        .filter(Boolean)
        .slice(-25);
    }

    const patternZonesH1 =
      detectPatterns(
        h1,
        swingsH1,
        "H1"
      );

    const patternZonesM15 =
      detectPatterns(
        m15,
        swingsM15,
        "M15"
      );

    // =========================
    // SUPPORT / RESISTANCE ZONES
    // =========================

    function buildSRZones(
      candles,
      swings,
      timeframe
    ) {
      const zones = [];

      for (
        const swing of swings.highs
      ) {
        const c =
          candles[
            clamp(
              swing.index,
              0,
              candles.length - 1
            )
          ];

        const zone =
          makeZone(
            "RESISTANCE",
            "SELL",
            swing.price +
              Math.max(
                atrM15 * 0.10,
                0.10
              ),
            swing.price -
              Math.max(
                atrM15 * 0.10,
                0.10
              ),
            swing.index,
            timeframe,
            "SNR"
          );

        if (zone) {
          zones.push(zone);
        }
      }

      for (
        const swing of swings.lows
      ) {
        const c =
          candles[
            clamp(
              swing.index,
              0,
              candles.length - 1
            )
          ];

        const zone =
          makeZone(
            "SUPPORT",
            "BUY",
            swing.price +
              Math.max(
                atrM15 * 0.10,
                0.10
              ),
            swing.price -
              Math.max(
                atrM15 * 0.10,
                0.10
              ),
            swing.index,
            timeframe,
            "SNR"
          );

        if (zone) {
          zones.push(zone);
        }
      }

      return zones.slice(-15);
    }

    const srZonesH1 =
      buildSRZones(
        h1,
        swingsH1,
        "H1"
      );

    const srZonesM15 =
      buildSRZones(
        m15,
        swingsM15,
        "M15"
      );

    // =========================
    // ALL ZONES
    // =========================

    let allZones = [
      ...patternZonesH1,
      ...patternZonesM15,
      ...srZonesH1,
      ...srZonesM15
    ];

    allZones =
      allZones
        .filter(Boolean)
        .map(zone => {
          const candles =
            zone.timeframe === "H1"
              ? h1
              : m15;

          return classifyZone(
            candles,
            zone
          );
        });

    // =========================
    // LIQUIDITY SWEEP
    // =========================

    function detectLiquiditySweep(
      candles,
      swings
    ) {
      if (
        candles.length < 5
      ) {
        return {
          bullishSweep: false,
          bearishSweep: false,
          sweptLow: null,
          sweptHigh: null
        };
      }

      const current =
        last(candles);

      const previous =
        prev(candles);

      const highs =
        swings.highs
          .map(x => x.price);

      const lows =
        swings.lows
          .map(x => x.price);

      const recentHigh =
        highs.length
          ? Math.max(
              ...highs.slice(-3)
            )
          : null;

      const recentLow =
        lows.length
          ? Math.min(
              ...lows.slice(-3)
            )
          : null;

      const sweepTolerance =
        Math.max(
          atrM15 * 0.20,
          0.30
        );

      const bearishSweep =
        recentHigh !== null &&
        current.high >
          recentHigh &&
        current.close <
          recentHigh &&
        (
          current.high -
          current.close
        ) >= sweepTolerance;

      const bullishSweep =
        recentLow !== null &&
        current.low <
          recentLow &&
        current.close >
          recentLow &&
        (
          current.close -
          current.low
        ) >= sweepTolerance;

      return {
        bullishSweep,
        bearishSweep,
        sweptLow:
          bullishSweep
            ? round(current.low)
            : null,
        sweptHigh:
          bearishSweep
            ? round(current.high)
            : null
      };
    }

    const liquidityM15 =
      detectLiquiditySweep(
        m15,
        swingsM15
      );

    const liquidityM5 =
      detectLiquiditySweep(
        m5,
        swingsM5
      );

    const liquidity = {
      bullishSweep:
        liquidityM15.bullishSweep ||
        liquidityM5.bullishSweep,

      bearishSweep:
        liquidityM15.bearishSweep ||
        liquidityM5.bearishSweep,

      M15: liquidityM15,
      M5: liquidityM5
    };

    // =========================
    // EQUAL HIGH / LOW
    // =========================

    function detectEqualLevels(
      swings
    ) {
      const highs =
        swings.highs.map(
          x => x.price
        );

      const lows =
        swings.lows.map(
          x => x.price
        );

      const tolerance =
        Math.max(
          atrM15 * 0.18,
          0.35
        );

      let equalHigh = null;
      let equalLow = null;

      if (
        highs.length >= 2
      ) {
        const a =
          highs[highs.length - 2];

        const b =
          highs[highs.length - 1];

        if (
          Math.abs(a - b) <=
          tolerance
        ) {
          equalHigh =
            round(
              (a + b) / 2
            );
        }
      }

      if (
        lows.length >= 2
      ) {
        const a =
          lows[lows.length - 2];

        const b =
          lows[lows.length - 1];

        if (
          Math.abs(a - b) <=
          tolerance
        ) {
          equalLow =
            round(
              (a + b) / 2
            );
        }
      }

      return {
        equalHigh,
        equalLow
      };
    }

    const equalLevels =
      detectEqualLevels(
        swingsM15
      );

    // =========================
    // BOS
    // =========================

    function detectBOS(
      candles,
      swings
    ) {
      if (
        candles.length < 5 ||
        !swings.highs.length ||
        !swings.lows.length
      ) {
        return {
          bullish: false,
          bearish: false,
          level: null
        };
      }

      const current =
        last(candles);

      const previous =
        prev(candles);

      const lastHigh =
        last(swings.highs).price;

      const lastLow =
        last(swings.lows).price;

      const bullish =
        previous.close <= lastHigh &&
        current.close > lastHigh;

      const bearish =
        previous.close >= lastLow &&
        current.close < lastLow;

      return {
        bullish,
        bearish,
        level:
          bullish
            ? round(lastHigh)
            : bearish
            ? round(lastLow)
            : null
      };
    }

    const bosM15 =
      detectBOS(
        m15,
        swingsM15
      );

    const bosM5 =
      detectBOS(
        m5,
        swingsM5
      );

    const BOS = {
      bullish:
        bosM15.bullish ||
        bosM5.bullish,

      bearish:
        bosM15.bearish ||
        bosM5.bearish,

      M15: bosM15,
      M5: bosM5
    };

    // =========================
    // CHOCH
    // =========================

    function detectCHOCH(
      candles,
      structure
    ) {
      if (
        candles.length < 6
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current =
        last(candles);

      const recent =
        candles.slice(-6, -1);

      const recentHigh =
        Math.max(
          ...recent.map(
            c => c.high
          )
        );

      const recentLow =
        Math.min(
          ...recent.map(
            c => c.low
          )
        );

      const bullish =
        structure.direction ===
          "BEARISH" &&
        current.close >
          recentHigh;

      const bearish =
        structure.direction ===
          "BULLISH" &&
        current.close <
          recentLow;

      return {
        bullish,
        bearish
      };
    }

    const chochM15 =
      detectCHOCH(
        m15,
        structureM15
      );

    const chochM5 =
      detectCHOCH(
        m5,
        structureFromSwings(
          swingsM5
        )
      );

    const CHOCH = {
      bullish:
        chochM15.bullish ||
        chochM5.bullish,

      bearish:
        chochM15.bearish ||
        chochM5.bearish,

      M15: chochM15,
      M5: chochM5
    };

    // =========================
    // FVG / IMBALANCE
    // =========================

    function detectFVG(
      candles,
      timeframe
    ) {
      const zones = [];

      if (
        candles.length < 3
      ) {
        return zones;
      }

      const start =
        Math.max(
          0,
          candles.length - 20
        );

      for (
        let i = start;
        i < candles.length - 2;
        i++
      ) {
        const a =
          candles[i];

        const b =
          candles[i + 1];

        const c =
          candles[i + 2];

        // Bullish FVG
        if (
          c.low > a.high
        ) {
          zones.push(
            makeZone(
              "BULLISH_FVG",
              "BUY",
              c.low,
              a.high,
              i + 2,
              timeframe,
              "FVG"
            )
          );
        }

        // Bearish FVG
        if (
          c.high < a.low
        ) {
          zones.push(
            makeZone(
              "BEARISH_FVG",
              "SELL",
              a.low,
              c.high,
              i + 2,
              timeframe,
              "FVG"
            )
          );
        }
      }

      return zones
        .filter(Boolean)
        .slice(-10);
    }

    const fvgM15 =
      detectFVG(
        m15,
        "M15"
      );

    const fvgM5 =
      detectFVG(
        m5,
        "M5"
      );

    const fvgZones = [
      ...fvgM15,
      ...fvgM5
    ].map(zone => {
      const candles =
        zone.timeframe === "M15"
          ? m15
          : m5;

      return classifyZone(
        candles,
        zone
      );
    });

    // =========================
    // FRESH / FIRST TOUCH
    // =========================

    const activeZones =
      allZones
        .filter(
          zone =>
            zone.active
        )
        .sort(
          (a, b) =>
            a.distancePoints -
            b.distancePoints
        );

    const activeFVG =
      fvgZones
        .filter(
          zone =>
            zone.active
        )
        .sort(
          (a, b) =>
            a.distancePoints -
            b.distancePoints
        );

    // =========================
    // BEST ZONE BY DIRECTION
    // =========================

    function bestZone(
      direction
    ) {
      const candidates =
        activeZones.filter(
          z =>
            z.direction ===
            direction
        );

      if (!candidates.length) {
        return null;
      }

      const priority = {
        FRESH: 4,
        FIRST_TOUCH: 5,
        SECOND_TOUCH: 2,
        USED: 0
      };

      candidates.sort(
        (a, b) => {

          const scoreA =
            priority[a.status] * 20 -
            a.distancePoints * 0.2;

          const scoreB =
            priority[b.status] * 20 -
            b.distancePoints * 0.2;

          return scoreB - scoreA;
        }
      );

      return candidates[0];
    }

    const buyZone =
      bestZone("BUY");

    const sellZone =
      bestZone("SELL");

    // =========================
    // ZONE CONFLUENCE
    // =========================

    function zoneConfluence(
      direction,
      zone
    ) {
      if (!zone) {
        return {
          score: 0,
          patterns: []
        };
      }

      let score = 0;
      const patterns = [];

      // Pattern itself
      if (
        [
          "QM_BUY",
          "QM_SELL"
        ].includes(zone.type)
      ) {
        score += 20;
        patterns.push(zone.type);
      }

      if (
        [
          "DOUBLE_TOP",
          "DOUBLE_BOTTOM"
        ].includes(zone.type)
      ) {
        score += 15;
        patterns.push(zone.type);
      }

      if (
        [
          "HEAD_SHOULDERS",
          "INVERSE_HEAD_SHOULDERS"
        ].includes(zone.type)
      ) {
        score += 15;
        patterns.push(zone.type);
      }

      if (
        [
          "RBR",
          "DBR",
          "RBD",
          "DBD"
        ].includes(zone.type)
      ) {
        score += 15;
        patterns.push(zone.type);
      }

      if (
        [
          "SUPPORT",
          "RESISTANCE"
        ].includes(zone.type)
      ) {
        score += 8;
        patterns.push(zone.type);
      }

      // Fresh / first touch
      if (
        zone.status === "FRESH"
      ) {
        score += 15;
      }

      if (
        zone.status === "FIRST_TOUCH"
      ) {
        score += 20;
      }

      if (
        zone.status === "SECOND_TOUCH"
      ) {
        score += 5;
      }

      if (
        zone.status === "USED"
      ) {
        score -= 10;
      }

      // FVG overlap
      const fvgMatch =
        activeFVG.find(
          fvg =>
            fvg.direction ===
              direction &&
            fvg.high >= zone.low &&
            fvg.low <= zone.high
        );

      if (fvgMatch) {
        score += 10;
        patterns.push(
          fvgMatch.type
        );
      }

      return {
        score:
          clamp(score, 0, 60),
        patterns
      };
    }

    const buyConfluence =
      zoneConfluence(
        "BUY",
        buyZone
      );

    const sellConfluence =
      zoneConfluence(
        "SELL",
        sellZone
      );

    // =========================
    // PUNCA
    // =========================

    function findPunca(
      direction
    ) {
      const levels = [
        ...swingPriceH1.highs,
        ...swingPriceM15.highs,
        ...swingPriceH4.highs,
        ...swingPriceH1.lows,
        ...swingPriceM15.lows
      ];

      if (
        direction === "SELL"
      ) {
        const candidates =
          levels.filter(
            v =>
              v >
              currentPrice
          );

        if (!candidates.length) {
          return null;
        }

        return round(
          Math.min(
            ...candidates
          )
        );
      }

      const candidates =
        levels.filter(
          v =>
            v <
            currentPrice
        );

      if (!candidates.length) {
        return null;
      }

      return round(
        Math.max(
          ...candidates
        )
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
    // DISPLACEMENT
    // =========================

    function detectDisplacement(
      candles
    ) {
      if (
        candles.length < 5
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current =
        last(candles);

      const recent =
        candles.slice(-6, -1);

      const averageRange =
        avg(
          recent.map(
            c =>
              candleRange(c)
          )
        );

      const currentRange =
        candleRange(current);

      const body =
        candleBody(current);

      const strong =
        averageRange > 0 &&
        currentRange >=
          averageRange * 1.5 &&
        body / currentRange >=
          0.65;

      return {
        bullish:
          strong &&
          current.close >
            current.open,

        bearish:
          strong &&
          current.close <
            current.open
      };
    }

    const displacement =
      detectDisplacement(m5);

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

      // -------------------------
      // MAIN DIRECTION
      // -------------------------

      if (
        direction === "BUY"
      ) {
        if (
          dirH1 === "BULLISH"
        ) {
          score +=
            scalping ? 20 : 25;
        }

        if (
          dirM15 === "BULLISH"
        ) {
          score += 15;
        }

        if (
          dirM5 === "BULLISH"
        ) {
          score += 10;
        }

        if (
          dirH4 === "BULLISH"
        ) {
          score +=
            scalping ? 5 : 20;
        }
      }

      if (
        direction === "SELL"
      ) {
        if (
          dirH1 === "BEARISH"
        ) {
          score +=
            scalping ? 20 : 25;
        }

        if (
          dirM15 === "BEARISH"
        ) {
          score += 15;
        }

        if (
          dirM5 === "BEARISH"
        ) {
          score += 10;
        }

        if (
          dirH4 === "BEARISH"
        ) {
          score +=
            scalping ? 5 : 20;
        }
      }

      // -------------------------
      // ZONE
      // -------------------------

      const zone =
        direction === "BUY"
          ? buyZone
          : sellZone;

      const confluence =
        direction === "BUY"
          ? buyConfluence
          : sellConfluence;

      if (zone) {
        score += 10;
        score +=
          Math.min(
            confluence.score,
            30
          );

        if (
          zone.status ===
          "FRESH"
        ) {
          score += 8;
        }

        if (
          zone.status ===
          "FIRST_TOUCH"
        ) {
          score += 12;
        }

        if (
          zone.status ===
          "USED"
        ) {
          score -= 8;
        }
      }

      // -------------------------
      // LIQUIDITY SWEEP
      // -------------------------

      if (
        direction === "BUY" &&
        liquidity.bullishSweep
      ) {
        score += 15;
      }

      if (
        direction === "SELL" &&
        liquidity.bearishSweep
      ) {
        score += 15;
      }

      // -------------------------
      // BOS
      // -------------------------

      if (
        direction === "BUY" &&
        BOS.bullish
      ) {
        score += 10;
      }

      if (
        direction === "SELL" &&
        BOS.bearish
      ) {
        score += 10;
      }

      // -------------------------
      // CHOCH
      // -------------------------

      if (
        direction === "BUY" &&
        CHOCH.bullish
      ) {
        score += 10;
      }

      if (
        direction === "SELL" &&
        CHOCH.bearish
      ) {
        score += 10;
      }

      // -------------------------
      // FVG
      // -------------------------

      const fvg =
        activeFVG.find(
          z =>
            z.direction ===
              direction
        );

      if (fvg) {
        score += 8;
      }

      // -------------------------
      // BREAKOUT / RETEST
      // -------------------------

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
        (
          breakout.bearishBreakout ||
          breakout.bearishRetest
        )
      ) {
        score += 10;
      }

      // -------------------------
      // DISPLACEMENT
      // -------------------------

      if (
        direction === "BUY" &&
        displacement.bullish
      ) {
        score += 8;
      }

      if (
        direction === "SELL" &&
        displacement.bearish
      ) {
        score += 8;
      }

      // -------------------------
      // M5 CONFIRMATION
      // -------------------------

      if (
        direction === "BUY" &&
        m5Confirmation.direction ===
          "BUY"
      ) {
        score += 15;
      }

      if (
        direction === "SELL" &&
        m5Confirmation.direction ===
          "SELL"
      ) {
        score += 15;
      }

      return clamp(
        Math.round(score),
        0,
        100
      );
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
    // FIXED STOP LOSS
    // =========================
    //
    // BOTH SCALPING + INTRADAY
    // = 500 POINTS / 50 PIPS
    //
    // BUY:
    // Entry - 500 points
    //
    // SELL:
    // Entry + 500 points
    //
    // =========================

    function chooseFixedStopLoss(
      direction,
      entry
    ) {
      const SL_POINTS = 500;

      const distance =
        pointsToPrice(
          SL_POINTS
        );

      let sl;

      if (
        direction === "SELL"
      ) {
        sl =
          round(
            entry + distance
          );
      } else {
        sl =
          round(
            entry - distance
          );
      }

      return {
        sl,
        distance:
          SL_POINTS,
        source:
          "FIXED_500_POINTS"
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

      const MAX_SL_POINTS =
        500;

      // Aggressive scalping
      const minimumScore =
        isScalping
          ? 42
          : 55;

      if (
        score <
        minimumScore
      ) {
        return null;
      }

      const entry =
        round(currentPrice);

      const zone =
        direction === "BUY"
          ? buyZone
          : sellZone;

      // CMP must be in / near a valid zone
      if (!zone) {
        return null;
      }

      if (
        !zone.active
      ) {
        return null;
      }

      // Used zones are heavily restricted
      if (
        zone.status ===
        "USED"
      ) {
        return null;
      }

      // Scalping keeps M5 confirmation mandatory.
      // Intraday keeps the previous behaviour.
      if (
        isScalping &&
        m5Confirmation.direction !==
          direction
      ) {
        return null;
      }

      const stopData =
        chooseFixedStopLoss(
          direction,
          entry
        );

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
        risk !==
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

      return {
        direction,
        type,

        status:
          "SIGNAL",

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

        zoneType:
          zone.type,

        zoneDirection:
          zone.direction,

        zoneHigh:
          zone.high,

        zoneLow:
          zone.low,

        zoneStatus:
          zone.status,

        zoneTouches:
          zone.touches,

        zoneDistancePoints:
          zone.distancePoints,

        zoneSource:
          zone.source,

        confirmation:
          m5Confirmation.direction ===
          direction,

        confirmationRequired:
          isScalping,

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
      } else if (
        buyScore >
        sellScore
      ) {
        direction = "BUY";
      } else {
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
            ? "H1 bearish + M15 bearish"
            : "H4/H1 bearish + M15 bearish";
      } else {
        reason =
          isScalping
            ? "H1 bullish + M15 bullish"
            : "H4/H1 bullish + M15 bullish";
      }

      if (
        plan.zoneType
      ) {
        reason +=
          ` + ${plan.zoneType}`;
      }

      if (
        plan.zoneStatus
      ) {
        reason +=
          ` + ${plan.zoneStatus}`;
      }

      if (
        liquidity.bullishSweep &&
        direction === "BUY"
      ) {
        reason +=
          " + LIQUIDITY_SWEEP";
      }

      if (
        liquidity.bearishSweep &&
        direction === "SELL"
      ) {
        reason +=
          " + LIQUIDITY_SWEEP";
      }

      if (
        BOS.bullish &&
        direction === "BUY"
      ) {
        reason +=
          " + BOS";
      }

      if (
        BOS.bearish &&
        direction === "SELL"
      ) {
        reason +=
          " + BOS";
      }

      if (
        CHOCH.bullish &&
        direction === "BUY"
      ) {
        reason +=
          " + CHOCH";
      }

      if (
        CHOCH.bearish &&
        direction === "SELL"
      ) {
        reason +=
          " + CHOCH";
      }

      if (
        activeFVG.some(
          z =>
            z.direction ===
            direction
        )
      ) {
        reason +=
          " + FVG";
      }

      if (
        breakout.bullishBreakout &&
        direction === "BUY"
      ) {
        reason +=
          " + BREAKOUT";
      }

      if (
        breakout.bearishBreakout &&
        direction === "SELL"
      ) {
        reason +=
          " + BREAKOUT";
      }

      if (
        breakout.bullishRetest &&
        direction === "BUY"
      ) {
        reason +=
          " + RETEST";
      }

      if (
        breakout.bearishRetest &&
        direction === "SELL"
      ) {
        reason +=
          " + RETEST";
      }

      if (
        m5Confirmation.direction ===
        direction
      ) {
        reason +=
          ` + M5 ${m5Confirmation.reason}`;
      }

      return {
        ...plan,

        score,

        reason,

        punca:
          direction === "SELL"
            ? sellPunca
            : buyPunca,

        confluence:
          direction === "SELL"
            ? sellConfluence
            : buyConfluence
      };
    }

    const scalping =
      buildSetup(
        "SCALPING"
      );

    const intraday =
      buildSetup(
        "INTRADAY"
      );

    // =========================
    // PRIMARY SETUP
    // =========================

    const candidates = [
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

    if (
      primarySetup
    ) {
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

    if (
      !primarySetup
    ) {
      const highestScore =
        Math.max(
          scalpingBuy,
          scalpingSell,
          intradayBuy,
          intradaySell
        );

      const anyZoneNear =
        activeZones.length >
        0;

      if (
        !anyZoneNear
      ) {
        waitReason =
          "Waiting for CMP to reach a valid entry zone.";
      } else if (
        highestScore < 42
      ) {
        waitReason =
          "Entry zone detected but confluence score is not strong enough.";
      } else if (
        m5Confirmation.direction ===
        "NONE"
      ) {
        waitReason =
          "Waiting for M5 confirmation.";
      } else {
        waitReason =
          "Valid zone detected but setup conditions are not fully aligned.";
      }
    }

    // =========================
    // SESSION
    // =========================

    function getSession() {
      const now =
        new Date();

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
            dateStyle: "short",
            timeStyle: "medium"
          }
        ).format(now);

      const getHour =
        timeZone =>
          Number(
            new Intl.DateTimeFormat(
              "en-US",
              {
                timeZone,
                hour: "2-digit",
                hour12: false
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
      } else if (
        londonOpen
      ) {
        activeSession =
          "LONDON";

        activity =
          "HIGH";
      } else if (
        newYorkOpen
      ) {
        activeSession =
          "NEW YORK";

        activity =
          "HIGH";
      } else if (
        asiaOpen
      ) {
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
    // ZONE SUMMARY
    // =========================

    const zoneSummary =
      activeZones
        .slice(0, 10)
        .map(zone => ({
          type: zone.type,
          direction: zone.direction,
          high: zone.high,
          low: zone.low,
          midpoint: zone.midpoint,
          timeframe: zone.timeframe,
          source: zone.source,
          status: zone.status,
          touches: zone.touches,
          distancePoints:
            zone.distancePoints,
          active: zone.active
        }));

    const fvgSummary =
      activeFVG
        .slice(0, 8)
        .map(zone => ({
          type: zone.type,
          direction: zone.direction,
          high: zone.high,
          low: zone.low,
          timeframe: zone.timeframe,
          status: zone.status,
          touches: zone.touches,
          distancePoints:
            zone.distancePoints
        }));

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

      liquidity,

      equalLevels,

      BOS,

      CHOCH,

      displacement,

      punca,

      // =========================
      // ZONES
      // =========================

      zones: {
        active: zoneSummary,

        bestBuy:
          buyZone
            ? {
                type:
                  buyZone.type,
                direction:
                  buyZone.direction,
                high:
                  buyZone.high,
                low:
                  buyZone.low,
                midpoint:
                  buyZone.midpoint,
                timeframe:
                  buyZone.timeframe,
                source:
                  buyZone.source,
                status:
                  buyZone.status,
                touches:
                  buyZone.touches,
                distancePoints:
                  buyZone.distancePoints
              }
            : null,

        bestSell:
          sellZone
            ? {
                type:
                  sellZone.type,
                direction:
                  sellZone.direction,
                high:
                  sellZone.high,
                low:
                  sellZone.low,
                midpoint:
                  sellZone.midpoint,
                timeframe:
                  sellZone.timeframe,
                source:
                  sellZone.source,
                status:
                  sellZone.status,
                touches:
                  sellZone.touches,
                distancePoints:
                  sellZone.distancePoints
              }
            : null,

        fvg:
          fvgSummary
      },

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
        H4:
          round(atrH4),

        H1:
          round(atrH1),

        M15:
          round(atrM15),

        M5:
          round(atrM5)
      },

      candles: {
        H4:
          h4.length,

        H1:
          h1.length,

        M15:
          m15.length,

        M5:
          m5.length
      },

      // =========================
      // ENGINE
      // =========================

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

        data:
          "OHLC",

        method:
          "H4/H1 Direction + Pattern Zone + Fresh/First Touch + CMP + Liquidity + BOS + CHOCH + FVG + M5 Confirmation",

        entryPatterns: [
          "QM BUY",
          "QM SELL",
          "DOUBLE BOTTOM",
          "DOUBLE TOP",
          "INVERSE HEAD & SHOULDERS",
          "HEAD & SHOULDERS",
          "RBR",
          "DBR",
          "RBD",
          "DBD",
          "SUPPORT",
          "RESISTANCE",
          "BREAKOUT",
          "RETEST"
        ],

        zoneRules: {
          patternSource:
            "Structure/pattern from candles on the left",

          cmpRule:
            "CMP must be inside or near the active zone",

          freshZone:
            "Zone with no subsequent touch",

          firstTouch:
            "First retest receives higher priority",

          secondTouch:
            "Lower priority",

          usedZone:
            "Repeatedly tested zone is rejected"
        },

        confirmationRules: {
          m5Engulfing:
            true,

          m5Rejection:
            true,

          m5StrongCandle:
            true,

          liquiditySweep:
            true,

          displacement:
            true
        },

        aggressiveMode: {
          scalping:
            true,

          minimumScore:
            42,

          dailySignalLimit:
            "NONE"
        },

        riskRules: {
          pointSize:
            "0.01 price = 1 point",

          scalpingSL:
            "FIXED 500 POINTS / 50 PIPS",

          intradaySL:
            "FIXED 500 POINTS / 50 PIPS",

          scalpingTP:
            "TP1 600 points / TP2 1200 points",

          intradayTP:
            "TP1 1600 points / TP2 2500 points"
        }
      },

      cached: false,

      timestamp:
        new Date().toISOString()
    };

    cache.data =
      result;

    cache.timestamp =
      Date.now();

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
