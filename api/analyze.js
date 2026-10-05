export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "API key not configured"
      });
    }

    const timeframes = {
      H4: "4h",
      H1: "1h",
      M30: "30min",
      M15: "15min",
      M5: "5min"
    };

    const market = {};

    for (const [name, interval] of Object.entries(timeframes)) {
      const url =
        "https://api.twelvedata.com/time_series" +
        "?symbol=XAU/USD" +
        "&interval=" + interval +
        "&outputsize=50" +
        "&apikey=" + API_KEY;

      const response = await fetch(url);
      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({
          error: "Market data service returned an invalid response"
        });
      }

      if (data.status === "error" || !data.values) {
        return res.status(503).json({
          error: data.message || "Market data unavailable"
        });
      }

      market[name] = data.values;
    }

    function direction(candles) {
      if (!candles || candles.length < 10) {
        return "WAIT";
      }

      const newest = Number(candles[0].close);
      const oldest = Number(candles[9].close);

      if (newest > oldest) {
        return "BULLISH";
      }

      if (newest < oldest) {
        return "BEARISH";
      }

      return "SIDEWAYS";
    }

    const directions = {
      H4: direction(market.H4),
      H1: direction(market.H1),
      M30: direction(market.M30),
      M15: direction(market.M15),
      M5: direction(market.M5)
    };

    let bullish = 0;
    let bearish = 0;

    Object.values(directions).forEach(dir => {
      if (dir === "BULLISH") bullish++;
      if (dir === "BEARISH") bearish++;
    });

    let signal = "WAIT";

    if (bullish >= 4) {
      signal = "BUY";
    }

    if (bearish >= 4) {
      signal = "SELL";
    }

    const price = Number(market.M5[0].close);

    let entry = price;
    let sl = null;
    let tp1 = null;
    let tp2 = null;

    if (signal === "BUY") {
      sl = price - 3;
      tp1 = price + 6;
      tp2 = price + 12;
    }

    if (signal === "SELL") {
      sl = price + 3;
      tp1 = price - 6;
      tp2 = price - 12;
    }

    return res.status(200).json({
      symbol: "XAUUSD",
      price: price,
      signal: signal,
      direction: directions,
      entry: entry,
      sl: sl,
      tp1: tp1,
      tp2: tp2,
      market_status: "Using latest available candle",
      note: "SINNCI AI Technical Analysis"
    });

  } catch (error) {
    return res.status(500).json({
      error: "SINNCI AI analysis temporarily unavailable"
    });
  }
}
