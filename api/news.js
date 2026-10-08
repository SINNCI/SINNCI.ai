export default async function handler(req, res) {
  try {
    const url =
      "https://biquote.io/api/calendar?countries=US&importance=high&limit=50";

    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: "BiQuote API error",
        status: response.status
      });
    }

    const data = await response.json();

    const events = Array.isArray(data)
      ? data.map((e) => ({
          id: e.id ?? null,
          name: e.name ?? "Economic News",
          country: e.countryCode ?? "US",
          currency: e.currency ?? "USD",
          impact: e.importance ?? "medium",
          time_utc: e.time ?? null,

          // NEWS DATA
          forecast: e.forecast ?? null,
          previous: e.previous ?? null,
          actual: e.actual ?? null,

          // Extra data
          unit: e.unit ?? null,
          multiplier: e.multiplier ?? null,
          revisedPrevious: e.revisedPrevious ?? null,
          source: e.source ?? null,
          sourceUrl: e.sourceUrl ?? null
        }))
      : [];

    return res.status(200).json({
      success: true,
      source: "BiQuote",
      updated: new Date().toISOString(),
      events
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
