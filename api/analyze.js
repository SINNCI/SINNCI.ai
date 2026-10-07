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
    // 500 points = 50 pips = 5.00 price
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
        const current =
          candles[i];

        const previous =
          candles[i - 1];

        const tr =
          Math.max(
            current.high -
              current.low,

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

    const atrH4 =
      calculateATR(h4);

    const atrH1 =
      calculateATR(h1);

    const atrM15 =
      calculateATR(m15);

    const atrM5 =
      calculateATR(m5);

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

    // Swing points dengan index
    // digunakan untuk detect pattern
    function getSwingPoints(
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
          highs.push({
            index: i,
            price:
              candles[i].high
          });
        }

        if (isLow) {
          lows.push({
            index: i,
            price:
              candles[i].low
          });
        }
      }

      return {
        highs:
          highs.slice(-15),

        lows:
          lows.slice(-15)
      };
    }

    const swingsH4 =
      getSwings(h4);

    const swingsH1 =
      getSwings(h1);

    const swingsM15 =
      getSwings(m15);

    const swingsM5 =
      getSwings(m5);

    const pointsH1 =
      getSwingPoints(h1);

    const pointsM15 =
      getSwingPoints(m15);

    const pointsM5 =
      getSwingPoints(m5);

    // =========================
    // STRUCTURE
    // =========================

    function structureFromSwings(
      swings
    ) {
      const highs =
        swings.highs;

      const lows =
        swings.lows;

      if (
        highs.length < 2 ||
        lows.length < 2
      ) {
        return {
          direction: "NEUTRAL",
          pattern: "MIXED",
          swingHighs:
            highs.slice(-4),
          swingLows:
            lows.slice(-4)
        };
      }

      const h1 =
        highs[
          highs.length - 2
        ];

      const h2 =
        highs[
          highs.length - 1
        ];

      const l1 =
        lows[
          lows.length - 2
        ];

      const l2 =
        lows[
          lows.length - 1
        ];

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
          swingHighs:
            highs.slice(-4),
          swingLows:
            lows.slice(-4)
        };
      }

      if (
        higherHigh &&
        higherLow
      ) {
        return {
          direction: "BULLISH",
          pattern: "HH_HL",
          swingHighs:
            highs.slice(-4),
          swingLows:
            lows.slice(-4)
        };
      }

      return {
        direction: "NEUTRAL",
        pattern: "MIXED",
        swingHighs:
          highs.slice(-4),
        swingLows:
          lows.slice(-4)
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
      if (
        candles.length < 10
      ) {
        return "NEUTRAL";
      }

      const recent =
        candles.slice(-8);

      const bullish =
        recent.filter(
          c =>
            c.close >
            c.open
        ).length;

      const bearish =
        recent.filter(
          c =>
            c.close <
            c.open
        ).length;

      if (
        bullish >
        bearish
      ) {
        return "BULLISH";
      }

      if (
        bearish >
        bullish
      ) {
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
      m5[
        m5.length - 1
      ].close;

    // =========================
    // BREAKOUT / RETEST
    // =========================

    function breakoutRetest(
      candles
    ) {
      if (
        candles.length < 20
      ) {
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
        candles.slice(
          -20,
          -3
        );

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
        candles[
          candles.length - 1
        ];

      const previous =
        candles[
          candles.length - 2
        ];

      const bullishBreakout =
        previous.close <=
          rangeHigh &&
        last.close >
          rangeHigh;

      const bearishBreakout =
        previous.close >=
          rangeLow &&
        last.close <
          rangeLow;

      const bullishRetest =
        last.low <=
          rangeHigh &&
        last.close >
          rangeHigh;

      const bearishRetest =
        last.high >=
          rangeLow &&
        last.close <
          rangeLow;

      return {
        bullishBreakout,
        bearishBreakout,
        bullishRetest,
        bearishRetest,

        rangeHigh:
          round(rangeHigh),

        rangeLow:
          round(rangeLow)
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
      if (
        candles.length < 5
      ) {
        return {
          direction: "NONE",
          reason:
            "NO_CONFIRMATION",

          bullishEngulfing: false,
          bearishEngulfing: false,

          bullishRejection: false,
          bearishRejection: false,

          strongBullish: false,
          strongBearish: false
        };
      }

      const last =
        candles[
          candles.length - 1
        ];

      const prev =
        candles[
          candles.length - 2
        ];

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
        last.close >
          last.open &&
        prev.close <
          prev.open &&
        last.open <=
          prev.close &&
        last.close >=
          prev.open;

      const bearishEngulfing =
        last.close <
          last.open &&
        prev.close >
          prev.open &&
        last.open >=
          prev.close &&
        last.close <=
          prev.open;

      const bullishRejection =
        range > 0 &&
        lowerWick >
          body * 1.3 &&
        last.close >
          last.open;

      const bearishRejection =
        range > 0 &&
        upperWick >
          body * 1.3 &&
        last.close <
          last.open;

      const strongBullish =
        range > 0 &&
        body / range >=
          0.65 &&
        last.close >
          last.open;

      const strongBearish =
        range > 0 &&
        body / range >=
          0.65 &&
        last.close <
          last.open;

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

        reason:
          "NO_CONFIRMATION",

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

    // ==================================================
    // PATTERN ENGINE
    // ==================================================

    const patternTolerance = Math.max(
      atrM15 * 0.30,
      0.50
    );

    const zoneWidth = Math.max(
      atrM15 * 0.18,
      0.30
    );

    // =========================
    // DOUBLE TOP / BOTTOM
    // =========================

    function detectDoubleTopBottom() {
      const highs =
        pointsM15.highs;

      const lows =
        pointsM15.lows;

      let doubleTop = {
        detected: false,
        active: false,
        type: "DOUBLE_TOP",
        price: null,
        neckline: null,
        zoneLow: null,
        zoneHigh: null
      };

      let doubleBottom = {
        detected: false,
        active: false,
        type: "DOUBLE_BOTTOM",
        price: null,
        neckline: null,
        zoneLow: null,
        zoneHigh: null
      };

      if (
        highs.length >= 2
      ) {
        const a =
          highs[
            highs.length - 2
          ];

        const b =
          highs[
            highs.length - 1
          ];

        const difference =
          Math.abs(
            a.price -
              b.price
          );

        if (
          difference <=
          patternTolerance
        ) {
          const between =
            m15.slice(
              a.index,
              b.index + 1
            );

          const neckline =
            between.length
              ? Math.min(
                  ...between.map(
                    c => c.low
                  )
                )
              : Math.min(
                  a.price,
                  b.price
                ) -
                patternTolerance;

          const active =
            currentPrice <=
              b.price +
                zoneWidth &&
            currentPrice >=
              neckline -
                zoneWidth;

          doubleTop = {
            detected: true,
            active,

            type:
              "DOUBLE_TOP",

            price:
              round(
                (a.price +
                  b.price) /
                  2
              ),

            neckline:
              round(
                neckline
              ),

            zoneLow:
              round(
                b.price -
                  zoneWidth
              ),

            zoneHigh:
              round(
                b.price +
                  zoneWidth
              )
          };
        }
      }

      if (
        lows.length >= 2
      ) {
        const a =
          lows[
            lows.length - 2
          ];

        const b =
          lows[
            lows.length - 1
          ];

        const difference =
          Math.abs(
            a.price -
              b.price
          );

        if (
          difference <=
          patternTolerance
        ) {
          const between =
            m15.slice(
              a.index,
              b.index + 1
            );

          const neckline =
            between.length
              ? Math.max(
                  ...between.map(
                    c => c.high
                  )
                )
              : Math.max(
                  a.price,
                  b.price
                ) +
                patternTolerance;

          const active =
            currentPrice >=
              b.price -
                zoneWidth &&
            currentPrice <=
              neckline +
                zoneWidth;

          doubleBottom = {
            detected: true,
            active,

            type:
              "DOUBLE_BOTTOM",

            price:
              round(
                (a.price +
                  b.price) /
                  2
              ),

            neckline:
              round(
                neckline
              ),

            zoneLow:
              round(
                b.price -
                  zoneWidth
              ),

            zoneHigh:
              round(
                b.price +
                  zoneWidth
              )
          };
        }
      }

      return {
        doubleTop,
        doubleBottom
      };
    }

    const doublePatterns =
      detectDoubleTopBottom();

    // =========================
    // QUASIMODO
    // =========================

    function detectQM() {
      const highs =
        pointsM15.highs;

      const lows =
        pointsM15.lows;

      let qmSell = {
        detected: false,
        active: false,
        type: "QM_SELL",
        zoneLow: null,
        zoneHigh: null,
        neckline: null
      };

      let qmBuy = {
        detected: false,
        active: false,
        type: "QM_BUY",
        zoneLow: null,
        zoneHigh: null,
        neckline: null
      };

      // =========================
      // QM SELL
      // =========================

      if (
        highs.length >= 3
      ) {
        const left =
          highs[
            highs.length - 3
          ];

        const head =
          highs[
            highs.length - 2
          ];

        const right =
          highs[
            highs.length - 1
          ];

        const lowsBetween =
          pointsM15.lows.filter(
            x =>
              x.index >
                left.index &&
              x.index <
                right.index
          );

        const neckline =
          lowsBetween.length
            ? Math.min(
                ...lowsBetween.map(
                  x => x.price
                )
              )
            : null;

        const headHigher =
          head.price >
          left.price +
            patternTolerance * 0.4;

        const rightLower =
          right.price <
          head.price -
            patternTolerance * 0.2;

        const rightNearLeft =
          right.price <=
          left.price +
            patternTolerance;

        if (
          headHigher &&
          rightLower &&
          rightNearLeft
        ) {
          const active =
            currentPrice >=
              right.price -
                zoneWidth &&
            currentPrice <=
              right.price +
                zoneWidth;

          qmSell = {
            detected: true,
            active,

            type:
              "QM_SELL",

            zoneLow:
              round(
                right.price -
                  zoneWidth
              ),

            zoneHigh:
              round(
                right.price +
                  zoneWidth
              ),

            neckline:
              neckline !== null
                ? round(
                    neckline
                  )
                : null,

            leftShoulder:
              round(
                left.price
              ),

            head:
              round(
                head.price
              ),

            rightShoulder:
              round(
                right.price
              )
          };
        }
      }

      // =========================
      // QM BUY
      // =========================

      if (
        lows.length >= 3
      ) {
        const left =
          lows[
            lows.length - 3
          ];

        const head =
          lows[
            lows.length - 2
          ];

        const right =
          lows[
            lows.length - 1
          ];

        const highsBetween =
          pointsM15.highs.filter(
            x =>
              x.index >
                left.index &&
              x.index <
                right.index
          );

        const neckline =
          highsBetween.length
            ? Math.max(
                ...highsBetween.map(
                  x => x.price
                )
              )
            : null;

        const headLower =
          head.price <
          left.price -
            patternTolerance * 0.4;

        const rightHigher =
          right.price >
          head.price +
            patternTolerance * 0.2;

        const rightNearLeft =
          right.price >=
          left.price -
            patternTolerance;

        if (
          headLower &&
          rightHigher &&
          rightNearLeft
        ) {
          const active =
            currentPrice >=
              right.price -
                zoneWidth &&
            currentPrice <=
              right.price +
                zoneWidth;

          qmBuy = {
            detected: true,
            active,

            type:
              "QM_BUY",

            zoneLow:
              round(
                right.price -
                  zoneWidth
              ),

            zoneHigh:
              round(
                right.price +
                  zoneWidth
              ),

            neckline:
              neckline !== null
                ? round(
                    neckline
                  )
                : null,

            leftShoulder:
              round(
                left.price
              ),

            head:
              round(
                head.price
              ),

            rightShoulder:
              round(
                right.price
              )
          };
        }
      }

      return {
        qmBuy,
        qmSell
      };
    }

    const qm =
      detectQM();

    // =========================
    // LIQUIDITY SWEEP
    // =========================

    function detectLiquiditySweep() {
      const recent =
        m5.slice(-6);

      if (
        recent.length < 4
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const last =
        recent[
          recent.length - 1
        ];

      const previous =
        recent.slice(
          0,
          -1
        );

      const previousHigh =
        Math.max(
          ...previous.map(
            c => c.high
          )
        );

      const previousLow =
        Math.min(
          ...previous.map(
            c => c.low
          )
        );

      const bearish =
        last.high >
          previousHigh &&
        last.close <
          previousHigh;

      const bullish =
        last.low <
          previousLow &&
        last.close >
          previousLow;

      return {
        bullish,
        bearish,

        sweptHigh:
          bearish
            ? round(
                last.high
              )
            : null,

        sweptLow:
          bullish
            ? round(
                last.low
              )
            : null
      };
    }

    const liquiditySweep =
      detectLiquiditySweep();

    // =========================
    // ORDER BLOCK
    // =========================

    function detectOrderBlock() {
      let bullishOB = {
        detected: false,
        active: false,
        zoneLow: null,
        zoneHigh: null
      };

      let bearishOB = {
        detected: false,
        active: false,
        zoneLow: null,
        zoneHigh: null
      };

      if (
        m15.length >= 5
      ) {
        for (
          let i =
            m15.length - 4;
          i >= 2;
          i--
        ) {
          const base =
            m15[i];

          const next1 =
            m15[i + 1];

          const next2 =
            m15[i + 2];

          // Bullish order block
          const bullishMove =
            next1.close >
              next1.open &&
            next2.close >
              next2.open &&
            next2.close -
              base.low >
              atrM15 * 0.35;

          if (
            bullishMove &&
            base.close <
              base.open
          ) {
            const low =
              base.low;

            const high =
              base.open;

            const active =
              currentPrice >=
                low -
                  zoneWidth &&
              currentPrice <=
                high +
                  zoneWidth;

            bullishOB = {
              detected: true,
              active,

              zoneLow:
                round(low),

              zoneHigh:
                round(high)
            };

            break;
          }

          // Bearish order block
          const bearishMove =
            next1.close <
              next1.open &&
            next2.close <
              next2.open &&
            base.high -
              next2.close >
              atrM15 * 0.35;

          if (
            bearishMove &&
            base.close >
              base.open
          ) {
            const low =
              base.close;

            const high =
              base.high;

            const active =
              currentPrice >=
                low -
                  zoneWidth &&
              currentPrice <=
                high +
                  zoneWidth;

            bearishOB = {
              detected: true,
              active,

              zoneLow:
                round(low),

              zoneHigh:
                round(high)
            };

            break;
          }
        }
      }

      return {
        bullishOB,
        bearishOB
      };
    }

    const orderBlock =
      detectOrderBlock();

    // =========================
    // FRESH / FIRST TOUCH ZONE
    // =========================

    function detectFreshZones() {
      let buyZone = null;
      let sellZone = null;

      const lows =
        pointsM15.lows;

      const highs =
        pointsM15.highs;

      // =========================
      // BUY DEMAND ZONE
      // =========================

      for (
        let i =
          lows.length - 1;
        i >= 0;
        i--
      ) {
        const pivot =
          lows[i];

        const low =
          pivot.price -
          zoneWidth;

        const high =
          pivot.price +
          zoneWidth;

        let touches = 0;

        for (
          let j =
            pivot.index + 1;
          j <
            m15.length;
          j++
        ) {
          if (
            m15[j].low <= high &&
            m15[j].high >= low
          ) {
            touches++;
          }
        }

        const active =
          currentPrice >=
            low -
              zoneWidth &&
          currentPrice <=
            high +
              zoneWidth;

        if (
          active
        ) {
          buyZone = {
            direction: "BUY",
            type: "DEMAND_ZONE",

            zoneLow:
              round(low),

            zoneHigh:
              round(high),

            sourcePrice:
              round(
                pivot.price
              ),

            touches,

            fresh:
              touches === 0,

            firstTouch:
              touches <= 1,

            active
          };

          break;
        }
      }

      // =========================
      // SELL SUPPLY ZONE
      // =========================

      for (
        let i =
          highs.length - 1;
        i >= 0;
        i--
      ) {
        const pivot =
          highs[i];

        const low =
          pivot.price -
          zoneWidth;

        const high =
          pivot.price +
          zoneWidth;

        let touches = 0;

        for (
          let j =
            pivot.index + 1;
          j <
            m15.length;
          j++
        ) {
          if (
            m15[j].low <= high &&
            m15[j].high >= low
          ) {
            touches++;
          }
        }

        const active =
          currentPrice >=
            low -
              zoneWidth &&
          currentPrice <=
            high +
              zoneWidth;

        if (
          active
        ) {
          sellZone = {
            direction: "SELL",
            type: "SUPPLY_ZONE",

            zoneLow:
              round(low),

            zoneHigh:
              round(high),

            sourcePrice:
              round(
                pivot.price
              ),

            touches,

            fresh:
              touches === 0,

            firstTouch:
              touches <= 1,

            active
          };

          break;
        }
      }

      return {
        buyZone,
        sellZone
      };
    }

    const freshZones =
      detectFreshZones();

    // =========================
    // ENTRY ZONE
    // =========================

    function getEntryZone(
      direction
    ) {
      const zones = [];

      if (
        direction === "BUY"
      ) {
        if (
          qm.qmBuy.detected
        ) {
          zones.push({
            type: "QM_BUY",
            priority:
              qm.qmBuy.active
                ? 5
                : 2,
            active:
              qm.qmBuy.active,
            zoneLow:
              qm.qmBuy.zoneLow,
            zoneHigh:
              qm.qmBuy.zoneHigh
          });
        }

        if (
          doublePatterns
            .doubleBottom
            .detected
        ) {
          zones.push({
            type:
              "DOUBLE_BOTTOM",
            priority:
              doublePatterns
                .doubleBottom
                .active
                ? 4
                : 2,
            active:
              doublePatterns
                .doubleBottom
                .active,

            zoneLow:
              doublePatterns
                .doubleBottom
                .zoneLow,

            zoneHigh:
              doublePatterns
                .doubleBottom
                .zoneHigh
          });
        }

        if (
          orderBlock
            .bullishOB
            .detected
        ) {
          zones.push({
            type:
              "BULLISH_ORDER_BLOCK",

            priority:
              orderBlock
                .bullishOB
                .active
                ? 4
                : 2,

            active:
              orderBlock
                .bullishOB
                .active,

            zoneLow:
              orderBlock
                .bullishOB
                .zoneLow,

            zoneHigh:
              orderBlock
                .bullishOB
                .zoneHigh
          });
        }

        if (
          freshZones.buyZone
        ) {
          zones.push({
            type:
              freshZones
                .buyZone
                .fresh
                ? "FRESH_DEMAND"
                : "DEMAND_ZONE",

            priority:
              freshZones
                .buyZone
                .fresh
                ? 5
                : 3,

            active: true,

            zoneLow:
              freshZones
                .buyZone
                .zoneLow,

            zoneHigh:
              freshZones
                .buyZone
                .zoneHigh
          });
        }
      }

      if (
        direction === "SELL"
      ) {
        if (
          qm.qmSell.detected
        ) {
          zones.push({
            type: "QM_SELL",
            priority:
              qm.qmSell.active
                ? 5
                : 2,
            active:
              qm.qmSell.active,

            zoneLow:
              qm.qmSell.zoneLow,

            zoneHigh:
              qm.qmSell.zoneHigh
          });
        }

        if (
          doublePatterns
            .doubleTop
            .detected
        ) {
          zones.push({
            type:
              "DOUBLE_TOP",

            priority:
              doublePatterns
                .doubleTop
                .active
                ? 4
                : 2,

            active:
              doublePatterns
                .doubleTop
                .active,

            zoneLow:
              doublePatterns
                .doubleTop
                .zoneLow,

            zoneHigh:
              doublePatterns
                .doubleTop
                .zoneHigh
          });
        }

        if (
          orderBlock
            .bearishOB
            .detected
        ) {
          zones.push({
            type:
              "BEARISH_ORDER_BLOCK",

            priority:
              orderBlock
                .bearishOB
                .active
                ? 4
                : 2,

            active:
              orderBlock
                .bearishOB
                .active,

            zoneLow:
              orderBlock
                .bearishOB
                .zoneLow,

            zoneHigh:
              orderBlock
                .bearishOB
                .zoneHigh
          });
        }

        if (
          freshZones.sellZone
        ) {
          zones.push({
            type:
              freshZones
                .sellZone
                .fresh
                ? "FRESH_SUPPLY"
                : "SUPPLY_ZONE",

            priority:
              freshZones
                .sellZone
                .fresh
                ? 5
                : 3,

            active: true,

            zoneLow:
              freshZones
                .sellZone
                .zoneLow,

            zoneHigh:
              freshZones
                .sellZone
                .zoneHigh
          });
        }
      }

      zones.sort(
        (a, b) =>
          b.priority -
          a.priority
      );

      return (
        zones[0] || null
      );
    }

    const buyEntryZone =
      getEntryZone("BUY");

    const sellEntryZone =
      getEntryZone("SELL");

    // =========================
    // ZONE PROXIMITY
    // =========================

    function zoneIsNear(
      zone
    ) {
      if (!zone) {
        return false;
      }

      return (
        currentPrice >=
          zone.zoneLow -
            zoneWidth &&
        currentPrice <=
          zone.zoneHigh +
            zoneWidth
      );
    }

    const buyZoneNear =
      zoneIsNear(
        buyEntryZone
      );

    const sellZoneNear =
      zoneIsNear(
        sellEntryZone
      );

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

      if (
        direction === "SELL"
      ) {
        const candidates =
          levels.filter(
            v =>
              v >
              currentPrice
          );

        if (
          !candidates.length
        ) {
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

      if (
        !candidates.length
      ) {
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

    // ==================================================
    // SCORE ENGINE
    // ==================================================

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

      if (
        scalping
      ) {
        // H1
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

        // M15
        if (
          direction === "SELL" &&
          dirM15 === "BEARISH"
        ) {
          score += 20;
        }

        if (
          direction === "BUY" &&
          dirM15 === "BULLISH"
        ) {
          score += 20;
        }

        // M5
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

        // M15 structure
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

        // Breakout
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

        // M5 confirmation
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
      }

      // =========================
      // INTRADAY
      // =========================

      else {
        if (
          direction === "SELL"
        ) {
          if (
            dirH4 === "BEARISH"
          ) {
            score += 30;
          }

          if (
            dirH1 === "BEARISH"
          ) {
            score += 25;
          }

          if (
            dirM15 === "BEARISH"
          ) {
            score += 15;
          }
        }

        else {
          if (
            dirH4 === "BULLISH"
          ) {
            score += 30;
          }

          if (
            dirH1 === "BULLISH"
          ) {
            score += 25;
          }

          if (
            dirM15 === "BULLISH"
          ) {
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
      }

      // ==================================================
      // PATTERN BOOST
      // ==================================================

      if (
        direction === "BUY"
      ) {
        if (
          qm.qmBuy.detected
        ) {
          score +=
            qm.qmBuy.active
              ? 20
              : 10;
        }

        if (
          doublePatterns
            .doubleBottom
            .detected
        ) {
          score +=
            doublePatterns
              .doubleBottom
              .active
              ? 15
              : 8;
        }

        if (
          orderBlock
            .bullishOB
            .detected
        ) {
          score +=
            orderBlock
              .bullishOB
              .active
              ? 12
              : 6;
        }

        if (
          freshZones.buyZone
        ) {
          score +=
            freshZones
              .buyZone
              .fresh
              ? 10
              : freshZones
                  .buyZone
                  .firstTouch
              ? 7
              : 4;
        }

        if (
          liquiditySweep.bullish
        ) {
          score += 10;
        }

        if (
          buyZoneNear
        ) {
          score += 8;
        }
      }

      // =========================
      // SELL PATTERNS
      // =========================

      if (
        direction === "SELL"
      ) {
        if (
          qm.qmSell.detected
        ) {
          score +=
            qm.qmSell.active
              ? 20
              : 10;
        }

        if (
          doublePatterns
            .doubleTop
            .detected
        ) {
          score +=
            doublePatterns
              .doubleTop
              .active
              ? 15
              : 8;
        }

        if (
          orderBlock
            .bearishOB
            .detected
        ) {
          score +=
            orderBlock
              .bearishOB
              .active
              ? 12
              : 6;
        }

        if (
          freshZones.sellZone
        ) {
          score +=
            freshZones
              .sellZone
              .fresh
              ? 10
              : freshZones
                  .sellZone
                  .firstTouch
              ? 7
              : 4;
        }

        if (
          liquiditySweep.bearish
        ) {
          score += 10;
        }

        if (
          sellZoneNear
        ) {
          score += 8;
        }
      }

      return Math.min(
        score,
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

    // ==================================================
    // FIXED STOP LOSS
    // ==================================================

    function chooseFixedStopLoss(
      direction,
      entry
    ) {
      const SL_POINTS =
        500;

      const slDistance =
        pointsToPrice(
          SL_POINTS
        );

      let sl;

      if (
        direction === "SELL"
      ) {
        sl =
          round(
            entry +
              slDistance
          );
      }

      else {
        sl =
          round(
            entry -
              slDistance
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

    // ==================================================
    // TRADE PLAN
    // ==================================================

    function buildTradePlan(
      direction,
      type,
      score
    ) {
      const isScalping =
        type === "SCALPING";

      const MAX_SL_POINTS =
        500;

      const minimumScore =
        isScalping
          ? 40
          : 50;

      if (
        score <
        minimumScore
      ) {
        return null;
      }

      const entry =
        round(
          currentPrice
        );

      // =========================
      // TRIGGER LOGIC
      // =========================

      const matchingM5 =
        m5Confirmation.direction ===
        direction;

      const matchingMomentum =
        dirM5 ===
        (
          direction === "BUY"
            ? "BULLISH"
            : "BEARISH"
        );

      const matchingPattern =
        direction === "BUY"
          ? (
              qm.qmBuy.active ||
              doublePatterns
                .doubleBottom
                .active ||
              orderBlock
                .bullishOB
                .active ||
              buyZoneNear ||
              liquiditySweep.bullish
            )
          : (
              qm.qmSell.active ||
              doublePatterns
                .doubleTop
                .active ||
              orderBlock
                .bearishOB
                .active ||
              sellZoneNear ||
              liquiditySweep.bearish
            );

      // =========================
      // SCALPING
      // =========================

      if (
        isScalping
      ) {
        /*
          Scalping tidak lagi terlalu ketat.

          Trigger boleh datang daripada:

          1. M5 confirmation
          ATAU
          2. Pattern/zone aktif + M5 momentum
        */

        if (
          !matchingM5 &&
          !(
            matchingPattern &&
            matchingMomentum
          )
        ) {
          return null;
        }
      }

      // =========================
      // FIXED SL
      // =========================

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
      }

      else {
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

      let status =
        "SIGNAL";

      let triggerType =
        "M5_CONFIRMATION";

      if (
        !matchingM5 &&
        matchingPattern &&
        matchingMomentum
      ) {
        triggerType =
          "PATTERN_ZONE_M5_MOMENTUM";
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
          matchingM5,

        confirmationRequired:
          isScalping,

        confirmationReason:
          matchingM5
            ? m5Confirmation.reason
            : matchingPattern &&
              matchingMomentum
            ? "PATTERN_ZONE_M5_MOMENTUM"
            : "WAITING_FOR_TRIGGER",

        triggerType
      };
    }

    // ==================================================
    // BUILD SETUP
    // ==================================================

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
        direction =
          "SELL";
      }

      else if (
        buyScore >
        sellScore
      ) {
        direction =
          "BUY";
      }

      else {
        return null;
      }

      const score =
        direction === "SELL"
          ? sellScore
          : buyScore;

      const entryZone =
        direction === "SELL"
          ? sellEntryZone
          : buyEntryZone;

      const plan =
        buildTradePlan(
          direction,
          type,
          score
        );

      if (!plan) {
        return null;
      }

      let reason =
        "";

      if (
        direction === "SELL"
      ) {
        reason =
          isScalping
            ? "H1 bearish + M15 bearish"
            : "H4/H1 bearish + M15 bearish";

        if (
          qm.qmSell.detected
        ) {
          reason +=
            " + QM SELL";
        }

        if (
          doublePatterns
            .doubleTop
            .detected
        ) {
          reason +=
            " + DOUBLE TOP";
        }

        if (
          orderBlock
            .bearishOB
            .detected
        ) {
          reason +=
            " + BEARISH OB";
        }

        if (
          freshZones.sellZone
        ) {
          reason +=
            freshZones
              .sellZone
              .fresh
              ? " + FRESH SUPPLY"
              : " + SUPPLY ZONE";
        }

        if (
          liquiditySweep.bearish
        ) {
          reason +=
            " + LIQUIDITY SWEEP";
        }
      }

      else {
        reason =
          isScalping
            ? "H1 bullish + M15 bullish"
            : "H4/H1 bullish + M15 bullish";

        if (
          qm.qmBuy.detected
        ) {
          reason +=
            " + QM BUY";
        }

        if (
          doublePatterns
            .doubleBottom
            .detected
        ) {
          reason +=
            " + DOUBLE BOTTOM";
        }

        if (
          orderBlock
            .bullishOB
            .detected
        ) {
          reason +=
            " + BULLISH OB";
        }

        if (
          freshZones.buyZone
        ) {
          reason +=
            freshZones
              .buyZone
              .fresh
              ? " + FRESH DEMAND"
              : " + DEMAND ZONE";
        }

        if (
          liquiditySweep.bullish
        ) {
          reason +=
            " + LIQUIDITY SWEEP";
        }
      }

      if (
        breakout.bearishBreakout ||
        breakout.bullishBreakout
      ) {
        reason +=
          " + BREAKOUT";
      }

      if (
        breakout.bearishRetest ||
        breakout.bullishRetest
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

      else if (
        entryZone
      ) {
        reason +=
          " + ACTIVE ENTRY ZONE";
      }

      return {
        ...plan,

        score,

        reason,

        entryZone,

        punca:
          direction === "SELL"
            ? sellPunca
            : buyPunca
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

    // ==================================================
    // PRIMARY SETUP
    // ==================================================

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

    // ==================================================
    // TOP SIGNAL
    // ==================================================

    let signal =
      "WAIT";

    let signalStatus =
      "WAIT";

    let signalType =
      null;

    let entry =
      null;

    let sl =
      null;

    let tp1 =
      null;

    let tp2 =
      null;

    let risk =
      null;

    let maxAllowedRisk =
      null;

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

    // ==================================================
    // WAIT REASON
    // ==================================================

    let waitReason =
      null;

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

      if (
        highestScore <
        40
      ) {
        waitReason =
          "No strong setup yet. Waiting for better market structure.";
      }

      else {
        const strongestDirection =
          scalpingSell >
          scalpingBuy
            ? "SELL"
            : scalpingBuy >
              scalpingSell
            ? "BUY"
            : intradaySell >
              intradayBuy
            ? "SELL"
            : "BUY";

        const patternFound =
          strongestDirection ===
          "SELL"
            ? (
                qm.qmSell.detected ||
                doublePatterns
                  .doubleTop
                  .detected ||
                orderBlock
                  .bearishOB
                  .detected
              )
            : (
                qm.qmBuy.detected ||
                doublePatterns
                  .doubleBottom
                  .detected ||
                orderBlock
                  .bullishOB
                  .detected
              );

        if (
          patternFound
        ) {
          waitReason =
            `${strongestDirection} bias detected. Waiting for entry trigger / M5 momentum.`;
        }

        else {
          waitReason =
            `${strongestDirection} bias detected but entry zone is not active yet.`;
        }
      }
    }

    else if (
      primarySetup.status ===
      "SIGNAL"
    ) {
      waitReason =
        null;
    }

    // ==================================================
    // SESSION
    // ==================================================

    function getSession() {
      const now =
        new Date();

      const formatTime =
        timeZone =>
          new Intl.DateTimeFormat(
            "en-GB",
            {
              timeZone,

              hour:
                "2-digit",

              minute:
                "2-digit",

              hour12:
                false
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

      if (
        overlap
      ) {
        activeSession =
          "LONDON + NEW YORK OVERLAP";

        activity =
          "VERY HIGH";
      }

      else if (
        londonOpen
      ) {
        activeSession =
          "LONDON";

        activity =
          "HIGH";
      }

      else if (
        newYorkOpen
      ) {
        activeSession =
          "NEW YORK";

        activity =
          "HIGH";
      }

      else if (
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

    // ==================================================
    // FINAL RESPONSE
    // ==================================================

    const result = {
      status:
        "success",

      symbol:
        PRICE_SYMBOL,

      signal,

      signalStatus,

      signalType,

      currentPrice:
        round(
          currentPrice
        ),

      session,

      direction: {
        H4:
          dirH4,

        H1:
          dirH1,

        M15:
          dirM15,

        M5:
          dirM5
      },

      structure: {
        H4:
          structureH4,

        H1:
          structureH1,

        M15:
          structureM15
      },

      breakout,

      confirmation:
        m5Confirmation,

      punca,

      // ==================================================
      // PATTERNS
      // ==================================================

      patterns: {
        qmBuy:
          qm.qmBuy,

        qmSell:
          qm.qmSell,

        doubleTop:
          doublePatterns
            .doubleTop,

        doubleBottom:
          doublePatterns
            .doubleBottom,

        liquiditySweep,

        orderBlock
      },

      // ==================================================
      // ZONES
      // ==================================================

      zones: {
        buy:
          buyEntryZone,

        sell:
          sellEntryZone,

        freshBuy:
          freshZones.buyZone,

        freshSell:
          freshZones.sellZone
      },

      entryZone:
        primarySetup
          ? primarySetup.entryZone
          : null,

      // ==================================================
      // SCORES
      // ==================================================

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

      SL:
        sl,

      tp1,

      TP1:
        tp1,

      tp2,

      TP2:
        tp2,

      risk,

      maxAllowedRisk,

      waitReason,

      scalping,

      intraday,

      primarySetup,

      // ==================================================
      // ATR
      // ==================================================

      ATR: {
        H4:
          round(
            atrH4
          ),

        H1:
          round(
            atrH1
          ),

        M15:
          round(
            atrM15
          ),

        M5:
          round(
            atrM5
          )
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

      // ==================================================
      // ENGINE
      // ==================================================

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
          "H4/H1 Market Structure + M15 SNR + QM + Double Top/Bottom + Order Block + Liquidity Sweep + Breakout Retest + M5 Trigger",

        patterns: [
          "QM BUY",
          "QM SELL",
          "DOUBLE TOP",
          "DOUBLE BOTTOM",
          "ORDER BLOCK",
          "LIQUIDITY SWEEP",
          "FRESH ZONE",
          "FIRST TOUCH",
          "BREAKOUT",
          "RETEST",
          "ENGULFING",
          "REJECTION"
        ],

        riskRules: {
          pointSize:
            "0.01 price = 1 point",

          fixedSL:
            "500 points / 50 pips",

          scalpingMode:
            "AGGRESSIVE",

          scalpingMinimumScore:
            40,

          scalpingSL:
            "FIXED 500 POINTS / 50 PIPS",

          scalpingTP:
            "TP1 600 points / 60 pips / TP2 1200 points / 120 pips",

          scalpingTrigger:
            "M5 confirmation OR active pattern/zone + M5 momentum",

          intradayMode:
            "SELECTIVE",

          intradayMinimumScore:
            50,

          intradaySL:
            "FIXED 500 POINTS / 50 PIPS",

          intradayTP:
            "TP1 1600 points / 160 pips / TP2 2500 points / 250 pips",

          intradayTrigger:
            "M5 confirmation preferred"
        }
      },

      cached:
        false,

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
        status:
          "error",

        signal:
          "WAIT",

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
        .running =
        false;
    }
  }
      }
