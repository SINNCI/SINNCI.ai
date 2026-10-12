/**
 * SINNCI AI — LIVE SETUP MONITOR
 * File: api/monitor.js
 *
 * Reads the real response from /api/analyze.
 * Does not invent prices, signals or confirmations.
 * Analysis only — no trade execution.
 *
 * IMPORTANT:
 * - Does not require confirmation.m5.confirmed because
 *   that field has not been verified in analyze.js.
 * - Does not independently confirm candle patterns.
 * - Does not update Supabase SL/TP statuses.
 */

function sendError(
  res,
  statusCode,
  code,
  message,
  details = null
) {
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

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function getZoneStatus(setup) {
  return String(
    setup?.zone?.status ??
    setup?.zoneStatus ??
    ""
  ).toUpperCase();
}

function getEntryStatus(setup) {
  return String(
    setup?.entryStatus ??
    setup?.status ??
    ""
  ).toUpperCase();
}

/**
 * Readiness is based on fields returned by analyze.js.
 * M5 confirmation is not independently assumed.
 */
function evaluateSetup(setup) {
  if (!isObject(setup)) {
    return {
      ready: false,
      reason: "INVALID_SETUP_DATA"
    };
  }

  const entryStatus = getEntryStatus(setup);
  const zoneStatus = getZoneStatus(setup);
  const zoneValid = setup?.zone?.valid;
  const hasPlan = isObject(setup?.plan);

  if (entryStatus !== "READY") {
    return {
      ready: false,
      reason: "ENTRY_NOT_READY"
    };
  }

  if (zoneValid !== true) {
    return {
      ready: false,
      reason: "ZONE_NOT_VALID"
    };
  }

  if (zoneStatus !== "IN_ZONE") {
    return {
      ready: false,
      reason: "PRICE_NOT_IN_ZONE"
    };
  }

  if (!hasPlan) {
    return {
      ready: false,
      reason: "PLAN_UNAVAILABLE"
    };
  }

  return {
    ready: true,
    reason: null
  };
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, max-age=0, must-revalidate"
  );

  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");

    return sendError(
      res,
      405,
      "METHOD_NOT_ALLOWED",
      "Gunakan GET untuk mendapatkan status monitor."
    );
  }

  const requestedType = String(
    req.query?.type || "both"
  ).toLowerCase();

  const allowedTypes = [
    "both",
    "scalping",
    "intraday"
  ];

  if (!allowedTypes.includes(requestedType)) {
    return sendError(
      res,
      400,
      "INVALID_TYPE",
      "type mesti both, scalping atau intraday."
    );
  }

  const host = req.headers.host;

  if (!host) {
    return sendError(
      res,
      500,
      "MISSING_HOST",
      "Host request tidak tersedia."
    );
  }

  // Use the deployment protocol where available.
  const forwardedProto = String(
    req.headers["x-forwarded-proto"] || ""
  )
    .split(",")[0]
    .trim();

  const protocol =
    forwardedProto === "http" ||
    forwardedProto === "https"
      ? forwardedProto
      : "https";

  const analyzeUrl = new URL(
    "/api/analyze",
    `${protocol}://${host}`
  ).toString();

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 20000);

  let response;
  let data;

  try {
    try {
      response = await fetch(analyzeUrl, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal,
        cache: "no-store"
      });

      const responseText = await response.text();

      try {
        data = JSON.parse(responseText);
      } catch {
        return sendError(
          res,
          502,
          "INVALID_ANALYZE_JSON",
          "API Analyze tidak memulangkan JSON yang sah.",
          {
            httpStatus: response.status,
            responsePreview: responseText.slice(0, 300)
          }
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok || data?.success !== true) {
      return sendError(
        res,
        502,
        "ANALYZE_API_FAILED",
        "Monitor tidak dapat mendapatkan analisis sebenar.",
        {
          httpStatus: response.status,
          analyzeResponse: data
        }
      );
    }

    /*
     * Keep the original analyze.js setup objects.
     * Do not construct new trading setups here.
     */
    const selectedSetups = {};

    if (
      requestedType === "both" ||
      requestedType === "scalping"
    ) {
      if (isObject(data.scalping)) {
        selectedSetups.scalping = data.scalping;
      }
    }

    if (
      requestedType === "both" ||
      requestedType === "intraday"
    ) {
      if (isObject(data.intraday)) {
        selectedSetups.intraday = data.intraday;
      }
    }

    const setupEntries = Object.entries(
      selectedSetups
    );

    const evaluatedSetups = setupEntries.map(
      ([type, setup]) => {
        const evaluation = evaluateSetup(setup);

        return {
          type,
          setup,
          ready: evaluation.ready,
          reason: evaluation.reason
        };
      }
    );

    const readySetups = evaluatedSetups.filter(
      item => item.ready
    );

    const bestSetup = readySetups.length
      ? readySetups.reduce((best, current) => {
          return Number(
            current.setup.score ?? 0
          ) > Number(
            best.setup.score ?? 0
          )
            ? current
            : best;
        })
      : null;

    /*
     * Return the original setup data unchanged.
     * Readiness metadata is provided separately.
     */
    const setupReadiness = {};

    for (const item of evaluatedSetups) {
      setupReadiness[item.type] = {
        ready: item.ready,
        reason: item.reason
      };
    }

    return res.status(200).json({
      success: true,
      status: "success",
      engine: "SINNCI LIVE MONITOR",
      version: "2.3.0",

      symbol: data.symbol || "XAUUSD",
      source: data.source || "SINNCI AI",
      analysisOnly: true,
      automatedTrading: false,

      market: data.market ?? null,
      cmp: data.cmp ?? null,

      setups: selectedSetups,
      setupReadiness,

      bestSetup: bestSetup
        ? {
            type: bestSetup.type,
            ...bestSetup.setup
          }
        : null,

      summary: {
        ready: readySetups.length > 0,
        readyCount: readySetups.length,
        checkedCount: evaluatedSetups.length,

        message: readySetups.length
          ? "Setup memenuhi syarat status analisis."
          : "Belum ada setup yang memenuhi semua syarat readiness.",

        note:
          "Monitor membaca respons sebenar daripada analyze.js. " +
          "Confirmation M5 tidak diwajibkan oleh monitor ini. " +
          "Monitor tidak mengesahkan candle secara berasingan " +
          "dan tidak mengemas kini status SL/TP dalam Supabase."
      },

      signalLock: data.signalLock ?? null,
      dataQuality: data.dataQuality ?? null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const isTimeout =
      error?.name === "AbortError";

    return sendError(
      res,
      502,
      isTimeout
        ? "ANALYZE_TIMEOUT"
        : "MONITOR_INTERNAL_ERROR",
      isTimeout
        ? "Permintaan analisis mengambil masa terlalu lama."
        : "Monitor gagal mendapatkan analisis.",
      {
        message: error?.message || null
      }
    );
  }
}
