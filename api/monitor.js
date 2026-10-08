/**
 * SINNCI AI — LIVE SETUP MONITOR
 * File: api/monitor.js
 *
 * Reads the real analysis response from /api/analyze.
 * No fabricated prices, no fake confirmation, no trade execution.
 */

function sendError(res, statusCode, code, message, details = null) {
  return res.status(statusCode).json({
    success: false,
    status: "error",
    code,
    error: message,
    details,
    source: "SINNCI Monitor",
    timestamp: new Date().toISOString()
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return sendError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan GET untuk memantau setup."
    );
  }

  try {
    const baseUrl = `https://${req.headers.host}`;
    const analyzeUrl = `${baseUrl}/api/analyze`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    let data;

    try {
      response = await fetch(analyzeUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store"
      });

      data = await response.json();
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok || data.success !== true) {
      return sendError(
        res,
        502,
        "ANALYZE_API_FAILED",
        "Monitor tidak dapat mendapatkan analisis sebenar.",
        data
      );
    }

    const requestedType = String(
      req.query?.type || "both"
    ).toLowerCase();

    const allowedTypes = ["both", "scalping", "intraday"];

    if (!allowedTypes.includes(requestedType)) {
      return sendError(
        res,
        400,
        "INVALID_TYPE",
        "type mesti both, scalping atau intraday."
      );
    }

    const selectedSetups = {};

    if (
      (requestedType === "both" || requestedType === "scalping") &&
      data.scalping
    ) {
      selectedSetups.scalping = data.scalping;
    }

    if (
      (requestedType === "both" || requestedType === "intraday") &&
      data.intraday
    ) {
      selectedSetups.intraday = data.intraday;
    }

    const setups = Object.values(selectedSetups);

    const readySetups = setups.filter(
      (setup) => setup.entryStatus === "READY" &&
        setup.confirmation?.m5?.confirmed === true &&
        setup.confirmation?.m1?.confirmed === true &&
        setup.zone?.valid === true &&
        setup.zone?.status === "IN_ZONE" &&
        setup.plan !== null
    );

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI LIVE MONITOR",
      version: "2.0.0",
      symbol: data.symbol || "XAUUSD",
      source: data.source || "SINNCI AI",
      analysisOnly: true,
      automatedTrading: false,
      market: data.market || null,
      setups: selectedSetups,
      bestSetup: readySetups.length
        ? readySetups.reduce((best, setup) =>
            setup.score > best.score ? setup : best
          )
        : null,
      summary: {
        ready: readySetups.length > 0,
        readyCount: readySetups.length,
        message: readySetups.length
          ? "Setup disahkan oleh analisis M5 dan M1."
          : "WAIT — belum ada setup yang memenuhi semua syarat.",
        note:
          "Monitor membaca keputusan analisis. Ia tidak mengesahkan candle secara berasingan."
      },
      dataQuality: data.dataQuality || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Permintaan analisis mengambil masa terlalu lama."
      : error?.message || "Monitor gagal diproses.";

    return sendError(
      res,
      502,
      "MONITOR_INTERNAL_ERROR",
      message
    );
  }
}
