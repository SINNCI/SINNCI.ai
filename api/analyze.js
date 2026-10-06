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

    async function getCandles(interval, outputsize = 150) {
      const url =
        `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok || data.status === "error" || !data.values) {
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

    const [h4, h1, m30, m15, m5] = await Promise.all([
      getCandles(TF.H4, 150),
      getCandles(TF.H1, 150),
      getCandles(TF.M30, 150),
      getCandles(TF.M15, 150),
      getCandles(TF.M5, 150)
    ]);

    if (
      h4.length < 30 ||
      h1.length < 30 ||
      m30.length < 30 ||
      m15.length < 30 ||
      m5.length < 30
    ) {
      throw new Error("Not enough candle data");
    }

    const last = arr => arr[arr.length - 1];
    const prev = arr => arr[arr.length - 2];

    function avgRange(arr, count = 20) {
      const data = arr.slice(-count);
      if (!data.length) return 0;

      return data.reduce(
        (sum, c) => sum + (c.high - c.low),
        0
      ) / data.length;
    }

    function body(c) {
      return Math.abs(c.close - c.open);
    }

    function range(c) {
      return c.high - c.low;
    }

    function upperWick(c) {
      return c.high - Math.max(c.open, c.close);
    }

    function lowerWick(c) {
      return Math.min(c.open, c.close) - c.low;
    }

    function bullish(c) {
      return c.close > c.open;
    }

    function bearish(c) {
      return c.close < c.open;
    }

    function strongBull(c) {
      const r = range(c);
      if (r <= 0) return false;

      return (
        bullish(c) &&
        body(c) >= r * 0.55 &&
        c.close >= c.low + r * 0.70
      );
    }

    function strongBear(c) {
      const r = range(c);
      if (r <= 0) return false;

      return (
        bearish(c) &&
        body(c) >= r * 0.55 &&
        c.close <= c.high - r * 0.70
      );
    }

    function structure(arr) {
      const recent = arr.slice(-30);

      const first = recent.slice(0, 10);
      const middle = recent.slice(10, 20);
      const last10 = recent.slice(-10);

      const firstHigh = Math.max(...first.map(c => c.high));
      const middleHigh = Math.max(...middle.map(c => c.high));
      const lastHigh = Math.max(...last10.map(c => c.high));

      const firstLow = Math.min(...first.map(c => c.low));
      const middleLow = Math.min(...middle.map(c => c.low));
      const lastLow = Math.min(...last10.map(c => c.low));

      let bullishScore = 0;
      let bearishScore = 0;

      if (lastHigh > middleHigh) bullishScore++;
      if (lastLow > middleLow) bullishScore++;

      if (lastHigh < middleHigh) bearishScore++;
      if (lastLow < middleLow) bearishScore++;

      if (bullishScore >= 2) return "BULLISH";
      if (bearishScore >= 2) return "BEARISH";

      return "SIDEWAYS";
    }

    const directionH4 = structure(h4);
    const directionH1 = structure(h1);
    const directionM30 = structure(m30);
    const directionM15 = structure(m15);

    let majorDirection = "SIDEWAYS";

    if (
      directionH4 === "BULLISH" &&
      (directionH1 === "BULLISH" ||
        directionH1 === "SIDEWAYS")
    ) {
      majorDirection = "BULLISH";
    }

    if (
      directionH4 === "BEARISH" &&
      (directionH1 === "BEARISH" ||
        directionH1 === "SIDEWAYS")
    ) {
      majorDirection = "BEARISH";
    }

    // =========================
    // HISTORICAL PUNCA / ZONES
    // =========================

    function createZones(arr, timeframe) {
      const zones = [];
      const lookback = arr.slice(0, -5);

      for (let i = 2; i < lookback.length - 2; i++) {
        const c = lookback[i];
        const before = lookback[i - 1];
        const after = lookback[i + 1];

        const r = range(c);
        if (r <= 0) continue;

        // RESISTANCE
        if (
          c.high >= before.high &&
          c.high >= after.high
        ) {
          let reaction = 0;

          for (
            let j = i + 1;
            j < Math.min(i + 8, lookback.length);
            j++
          ) {
            if (lookback[j].close < c.high) {
              reaction++;
            }
          }

          if (reaction >= 2) {
            zones.push({
              type: "SELL",
              low: c.high - r * 0.35,
              high: c.high + r * 0.20,
              source: timeframe,
              strength: 2 + Math.min(reaction, 4),
              time: c.time
            });
          }
        }

        // SUPPORT
        if (
          c.low <= before.low &&
          c.low <= after.low
        ) {
          let reaction = 0;

          for (
            let j = i + 1;
            j < Math.min(i + 8, lookback.length);
            j++
          ) {
            if (lookback[j].close > c.low) {
              reaction++;
            }
          }

          if (reaction >= 2) {
            zones.push({
              type: "BUY",
              low: c.low - r * 0.20,
              high: c.low + r * 0.35,
              source: timeframe,
              strength: 2 + Math.min(reaction, 4),
              time: c.time
            });
          }
        }
      }

      // BREAKOUT / CHANGE OF ROLE
      for (let i = 5; i < lookback.length - 3; i++) {
        const base = lookback.slice(i - 5, i);

        const resistance = Math.max(
          ...base.map(c => c.high)
        );

        const support = Math.min(
          ...base.map(c => c.low)
        );

        const c = lookback[i];

        if (c.close > resistance) {
          zones.push({
            type: "BUY",
            low: resistance - avgRange(arr, 10) * 0.25,
            high: resistance + avgRange(arr, 10) * 0.30,
            source: timeframe,
            strength: 5,
            time: c.time
          });
        }

        if (c.close < support) {
          zones.push({
            type: "SELL",
            low: support - avgRange(arr, 10) * 0.30,
            high: support + avgRange(arr, 10) * 0.25,
            source: timeframe,
            strength: 5,
            time: c.time
          });
        }
      }

      return zones;
    }

    let zones = [
      ...createZones(h4, "H4"),
      ...createZones(h1, "H1"),
      ...createZones(m30, "M30"),
      ...createZones(m15, "M15"),
      ...createZones(m5, "M5")
    ];

    const currentPrice = last(m5).close;

    const volatility =
      avgRange(h1, 20) +
      avgRange(m30, 20);

    const averageVolatility = volatility / 2;

    const maxDistance =
      averageVolatility * 2.2;

    function zoneDistance(z) {
      if (
        currentPrice >= z.low &&
        currentPrice <= z.high
      ) {
        return 0;
      }

      if (currentPrice < z.low) {
        return z.low - currentPrice;
      }

      return currentPrice - z.high;
    }

    zones = zones
      .map(z => ({
        ...z,
        distance: zoneDistance(z)
      }))
      .filter(z =>
        z.distance <= maxDistance
      );

    function mergeZones(input) {
      const result = [];

      input
        .sort((a, b) => a.low - b.low)
        .forEach(z => {
          const existing = result.find(
            r =>
              r.type === z.type &&
              Math.abs(
                ((r.low + r.high) / 2) -
                ((z.low + z.high) / 2)
              ) <= averageVolatility * 0.20
          );

          if (existing) {
            existing.low = Math.min(
              existing.low,
              z.low
            );

            existing.high = Math.max(
              existing.high,
              z.high
            );

            existing.strength += z.strength;
          } else {
            result.push({ ...z });
          }
        });

      return result;
    }

    zones = mergeZones(zones);

    function bestPunca(type) {
      const candidates = zones
        .filter(z => z.type === type)
        .map(z => {
          let score = z.strength;

          if (z.source === "H4") score += 5;
          if (z.source === "H1") score += 4;
          if (z.source === "M30") score += 3;
          if (z.source === "M15") score += 2;
          if (z.source === "M5") score += 1;

          score += Math.max(
            0,
            5 -
              (z.distance /
                Math.max(
                  averageVolatility,
                  0.01
                )) *
                2
          );

          return {
            ...z,
            score
          };
        })
        .sort((a, b) =>
          b.score - a.score
        );

      return candidates[0] || null;
    }

    const buyPunca = bestPunca("BUY");
    const sellPunca = bestPunca("SELL");

    // =========================
    // M5 CONFIRMATION
    // =========================

    const m5Last = last(m5);
    const m5Prev = prev(m5);

    const m5Range = range(m5Last);
    const m5AvgRange = avgRange(m5, 20);

    const candleIsNormal =
      m5Range >= m5AvgRange * 0.45;

    const bullishEngulfing =
      bullish(m5Last) &&
      bearish(m5Prev) &&
      m5Last.open <= m5Prev.close &&
      m5Last.close >= m5Prev.open;

    const bearishEngulfing =
      bearish(m5Last) &&
      bullish(m5Prev) &&
      m5Last.open >= m5Prev.close &&
      m5Last.close <= m5Prev.open;

    const bullishRejection =
      bullish(m5Last) &&
      lowerWick(m5Last) >=
        body(m5Last) * 1.2 &&
      m5Last.close >=
        m5Last.low + m5Range * 0.60;

    const bearishRejection =
      bearish(m5Last) &&
      upperWick(m5Last) >=
        body(m5Last) * 1.2 &&
      m5Last.close <=
        m5Last.high - m5Range * 0.60;

    const bullishConfirmation =
      candleIsNormal &&
      (
        bullishEngulfing ||
        bullishRejection ||
        strongBull(m5Last)
      );

    const bearishConfirmation =
      candleIsNormal &&
      (
        bearishEngulfing ||
        bearishRejection ||
        strongBear(m5Last)
      );

    function touchedZone(c, z) {
      if (!z) return false;

      return (
        c.high >= z.low &&
        c.low <= z.high
      );
    }

    function rejectedZone(c, z, type) {
      if (!z) return false;
      if (!touchedZone(c, z)) return false;

      if (type === "SELL") {
        return (
          c.close < z.high &&
          upperWick(c) > body(c)
        );
      }

      if (type === "BUY") {
        return (
          c.close > z.low &&
          lowerWick(c) > body(c)
        );
      }

      return false;
    }

    const sellAtPunca =
      sellPunca &&
      touchedZone(m5Last, sellPunca);

    const buyAtPunca =
      buyPunca &&
      touchedZone(m5Last, buyPunca);

    const sellReject =
      rejectedZone(
        m5Last,
        sellPunca,
        "SELL"
      );

    const buyReject =
      rejectedZone(
        m5Last,
        buyPunca,
        "BUY"
      );

    // =========================
    // SCORE
    // =========================

    function calculateSellScore() {
      let score = 0;

      if (directionH4 === "BEARISH")
        score += 25;

      if (directionH1 === "BEARISH")
        score += 20;

      if (
        directionM30 === "BEARISH" ||
        directionM30 === "SIDEWAYS"
      )
        score += 10;

      if (
        directionM15 === "BEARISH" ||
        directionM15 === "SIDEWAYS"
      )
        score += 10;

      if (sellPunca)
        score += 10;

      if (sellAtPunca)
        score += 10;

      if (bearishEngulfing)
        score += 10;
      else if (bearishRejection)
        score += 8;
      else if (strongBear(m5Last))
        score += 5;

      if (sellReject)
        score += 5;

      return Math.min(score, 100);
    }

    function calculateBuyScore() {
      let score = 0;

      if (directionH4 === "BULLISH")
        score += 25;

      if (directionH1 === "BULLISH")
        score += 20;

      if (
        directionM30 === "BULLISH" ||
        directionM30 === "SIDEWAYS"
      )
        score += 10;

      if (
        directionM15 === "BULLISH" ||
        directionM15 === "SIDEWAYS"
      )
        score += 10;

      if (buyPunca)
        score += 10;

      if (buyAtPunca)
        score += 10;

      if (bullishEngulfing)
        score += 10;
      else if (bullishRejection)
        score += 8;
      else if (strongBull(m5Last))
        score += 5;

      if (buyReject)
        score += 5;

      return Math.min(score, 100);
    }

    const sellScore =
      calculateSellScore();

    const buyScore =
      calculateBuyScore();

    // =========================
    // FINAL SIGNAL
    // =========================

    let signal = "WAIT";
    let selected = null;
    let confidence = 0;

    if (
      majorDirection === "BEARISH" &&
      sellPunca &&
      sellAtPunca &&
      bearishConfirmation &&
      sellScore >= 75
    ) {
      signal = "SELL";
      selected = sellPunca;
      confidence = sellScore;
    }

    if (
      majorDirection === "BULLISH" &&
      buyPunca &&
      buyAtPunca &&
      bullishConfirmation &&
      buyScore >= 75
    ) {
      signal = "BUY";
      selected = buyPunca;
      confidence = buyScore;
    }

    // =========================
    // ENTRY / SL / TP
    // =========================

    let entry = currentPrice;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    if (
      selected &&
      signal !== "WAIT"
    ) {
      const zoneSize =
        Math.max(
          selected.high -
            selected.low,
          averageVolatility * 0.15
        );

      if (signal === "SELL") {
        entry = currentPrice;

        sl =
          selected.high +
          zoneSize * 0.45;

        const risk = sl - entry;

        tp1 =
          entry -
          risk * 1.2;

        tp2 =
          entry -
          risk * 2.0;
      }

      if (signal === "BUY") {
        entry = currentPrice;

        sl =
          selected.low -
          zoneSize * 0.45;

        const risk = entry - sl;

        tp1 =
          entry +
          risk * 1.2;

        tp2 =
          entry +
          risk * 2.0;
      }
    }

    // =========================
    // SETUP TYPE
    // =========================

    let setupType = "WAIT";

    if (signal === "BUY") {
      setupType =
        bullishEngulfing
          ? "BUY - BULLISH ENGULFING"
          : bullishRejection
            ? "BUY - SUPPORT REJECTION"
            : "BUY - STRONG CLOSE";
    }

    if (signal === "SELL") {
      setupType =
        bearishEngulfing
          ? "SELL - BEARISH ENGULFING"
          : bearishRejection
            ? "SELL - RESISTANCE REJECTION"
            : "SELL - STRONG CLOSE";
    }

    const punca =
      signal === "BUY"
        ? buyPunca
        : signal === "SELL"
          ? sellPunca
          : null;

    return res.status(200).json({
      symbol,

      signal,
      setupType,
      confidence,

      market: {
        price: Number(
          currentPrice.toFixed(2)
        ),
        majorDirection,

        H4: directionH4,
        H1: directionH1,
        M30: directionM30,
        M15: directionM15
      },

      punca: punca
        ? {
            type: punca.type,
            source: punca.source,
            low: Number(
              punca.low.toFixed(2)
            ),
            high: Number(
              punca.high.toFixed(2)
            ),
            distance: Number(
              punca.distance.toFixed(2)
            ),
            strength: punca.strength
          }
        : null,

      confirmation: {
        M5: {
          bullishEngulfing,
          bearishEngulfing,
          bullishRejection,
          bearishRejection,

          strongBull:
            strongBull(m5Last),

          strongBear:
            strongBear(m5Last),

          candleRange:
            Number(
              m5Range.toFixed(2)
            )
        },

        atPunca:
          signal === "BUY"
            ? buyAtPunca
            : signal === "SELL"
              ? sellAtPunca
              : false,

        candleConfirmed:
          signal === "BUY"
            ? bullishConfirmation
            : signal === "SELL"
              ? bearishConfirmation
              : false
      },

      levels: {
        entry: Number(
          entry.toFixed(2)
        ),

        sl:
          sl !== null
            ? Number(sl.toFixed(2))
            : null,

        tp1:
          tp1 !== null
            ? Number(tp1.toFixed(2))
            : null,

        tp2:
          tp2 !== null
            ? Number(tp2.toFixed(2))
            : null
      },

      scores: {
        buy: buyScore,
        sell: sellScore
      },

      status:
        signal === "WAIT"
          ? "NO HIGH-QUALITY SETUP"
          : "HIGH-QUALITY SETUP"
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        error.message ||
        "Analysis failed"
    });
  }
            }
