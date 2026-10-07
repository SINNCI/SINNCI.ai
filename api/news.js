export default async function handler(req, res) {
  try {
    const now = new Date();

    const from = now.toISOString().slice(0, 10);

    const future = new Date(now);
    future.setDate(future.getDate() + 14);
    const to = future.toISOString().slice(0, 10);

    const url =
      `https://www.financecalendar.com/wp-json/fc/v1/calendar` +
      `?from=${from}&to=${to}&limit=100`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`FinanceCalendar error: ${response.status}`);
    }

    const data = await response.json();

    const events = Array.isArray(data)
      ? data
      : (data.events || []);

    const filtered = events
      .filter(event => {
        const impact = String(event.impact || "").toLowerCase();

        return impact === "high" || impact === "medium";
      })
      .filter(event => {
        const name = String(
          event.name ||
          event.title ||
          ""
        ).toLowerCase();

        // Fokus kepada news yang relevan untuk XAUUSD
        const keywords = [
          "us ",
          "u.s.",
          "united states",
          "fomc",
          "fed",
          "federal reserve",
          "cpi",
          "ppi",
          "pce",
          "employment",
          "non-farm",
          "nfp",
          "jobless",
          "unemployment",
          "payroll",
          "gdp",
          "retail sales",
          "ism",
          "jolts",
          "consumer confidence",
          "interest rate"
        ];

        return keywords.some(keyword =>
          name.includes(keyword)
        );
      })
      .map(event => ({
        name: event.name || event.title || "Economic News",

        title: event.title || event.name || "Economic News",

        impact: String(
          event.impact || "medium"
        ).toLowerCase(),

        category: event.category || "",

        time_utc:
          event.time_utc ||
          event.scheduledAt ||
          event.date ||
          null,

        consensus:
          event.consensus ??
          event.forecast ??
          null,

        prior:
          event.prior ??
          event.previous ??
          null,

        actual:
          event.actual ??
          null,

        url:
          event.url ||
          "https://www.financecalendar.com/"
      }));

    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=600"
    );

    return res.status(200).json({
      success: true,
      source: "FinanceCalendar.com",
      updated: new Date().toISOString(),
      events: filtered
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: "Unable to load economic news",
      events: []
    });
  }
}
