"use strict";

// VozAI → Cal.com booking function
// - Receives booking details from ElevenLabs
// - Creates booking in Cal.com v2
// - Handles timezone conversion correctly
// - Supports either `notes` or `service` from the agent payload

const CAL_API_BASE = "https://api.cal.com/v2";
const CAL_API_VERSION = "2024-08-13";
const CAL_EVENT_SLUG = "vozai-demo-consultation";
const CAL_USERNAME = "cindy-p0qomv";
const DEFAULT_TIMEZONE = "America/New_York";

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Convert a local wall-clock date/time in a given IANA timezone
 * into a UTC ISO string for Cal.com.
 *
 * Accepts:
 * - date: "2026-03-26", "03/26/2026", "March 26, 2026"
 * - time: "10:00 AM", "2:30 PM", "14:00", "14:00:00"
 */
function buildISOStart(date, time, timeZone) {
  let year, month, day;
  const isoDateMatch = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoDateMatch) {
    year = parseInt(isoDateMatch[1], 10);
    month = parseInt(isoDateMatch[2], 10);
    day = parseInt(isoDateMatch[3], 10);
  } else {
    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      throw new Error(`Cannot parse date: "${date}"`);
    }
    year = parsedDate.getFullYear();
    month = parsedDate.getMonth() + 1;
    day = parsedDate.getDate();
  }

  let hour, minute;
  const rawTime = String(time).trim();

  const ampmMatch = rawTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  const h24Match = rawTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

  if (ampmMatch) {
    hour = parseInt(ampmMatch[1], 10);
    minute = parseInt(ampmMatch[2], 10);
    const meridiem = ampmMatch[3].toUpperCase();

    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
  } else if (h24Match) {
    hour = parseInt(h24Match[1], 10);
    minute = parseInt(h24Match[2], 10);
  } else {
    throw new Error(`Cannot parse time: "${time}"`);
  }

  const desiredLocal = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const renderedLocal = formatter.format(utcGuess).replace("T", " ");

  const desiredMs = Date.parse(desiredLocal.replace(" ", "T") + "Z");
  const renderedMs = Date.parse(renderedLocal.replace(" ", "T") + "Z");

  if (Number.isNaN(desiredMs) || Number.isNaN(renderedMs)) {
    throw new Error(`Failed to calculate timezone-adjusted start for ${date} ${time} (${timeZone})`);
  }

  const corrected = new Date(utcGuess.getTime() - (renderedMs - desiredMs));
  return corrected.toISOString();
}

async function fetchEventTypeId(calApiKey) {
  try {
    const response = await fetch(`${CAL_API_BASE}/event-types`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${calApiKey}`,
        "Content-Type": "application/json",
        "cal-api-version": CAL_API_VERSION,
      },
    });

    const json = await response.json();

    if (!response.ok) {
      console.warn("[create-booking] Could not fetch event types:", json);
      return null;
    }

    const eventTypes = (json?.data?.eventTypeGroups ?? []).flatMap(
      (group) => group?.eventTypes ?? []
    );

    const match = eventTypes.find(
      (item) =>
        item?.slug === CAL_EVENT_SLUG ||
        item?.eventTypeSlug === CAL_EVENT_SLUG
    );

    return match?.id || null;
  } catch (err) {
    console.warn("[create-booking] Event type lookup failed:", err.message);
    return null;
  }
}

exports.handler = async (event) => {
  const requestId = `req_${Date.now()}`;

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: "Method Not Allowed",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: "Invalid JSON in request body.",
      }),
    };
  }

  const {
    name,
    email,
    date,
    time,
    notes,
    service,
    timeZone,
  } = body;

  const missing = [];
  if (!name) missing.push("name");
  if (!email) missing.push("email");
  if (!date) missing.push("date");
  if (!time) missing.push("time");

  if (missing.length > 0) {
    console.error(`[create-booking][${requestId}] Missing fields:`, missing);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
        missingFields: missing,
      }),
    };
  }

  if (!isValidEmail(email)) {
    console.error(`[create-booking][${requestId}] Invalid email: ${email}`);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: `The email address "${email}" does not appear to be valid.`,
      }),
    };
  }

  const CAL_API_KEY = process.env.CAL_API_KEY;
  if (!CAL_API_KEY) {
    console.error(`[create-booking][${requestId}] Missing CAL_API_KEY`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: "Server configuration error: CAL_API_KEY is not set.",
      }),
    };
  }

  const resolvedTZ = timeZone || DEFAULT_TIMEZONE;

  let startISO;
  try {
    startISO = buildISOStart(date, time, resolvedTZ);
    console.log(
      `[create-booking][${requestId}] Resolved start time: ${startISO} (TZ: ${resolvedTZ})`
    );
  } catch (err) {
    console.error(`[create-booking][${requestId}] Date/time parse error:`, err.message);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: `Could not parse the provided date/time. date="${date}", time="${time}". Error: ${err.message}`,
      }),
    };
  }

  let eventTypeId = process.env.CAL_EVENT_TYPE_ID
    ? parseInt(process.env.CAL_EVENT_TYPE_ID, 10)
    : null;

  if (!eventTypeId) {
    eventTypeId = await fetchEventTypeId(CAL_API_KEY);
  }

  const bookingTitle = `VozAI Demo & Consultation — ${String(name).trim()}`;
  const combinedNotes = notes || service || "";

  const calPayload = {
    start: startISO,
    attendee: {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      timeZone: resolvedTZ,
      language: "en",
    },
    bookingFieldsResponses: {
      title: bookingTitle,
      ...(combinedNotes ? { notes: String(combinedNotes).trim() } : {}),
    },
    metadata: {
      source: "vozai-voice-agent",
      bookedVia: "elevenlabs-phone-call",
    },
  };

  if (eventTypeId) {
    calPayload.eventTypeId = eventTypeId;
  } else {
    calPayload.eventTypeSlug = CAL_EVENT_SLUG;
    calPayload.username = CAL_USERNAME;
  }

  console.log(
    `[create-booking][${requestId}] Cal.com payload:`,
    JSON.stringify(calPayload)
  );

  let calResponse;
  let calJSON;

  try {
    calResponse = await fetch(`${CAL_API_BASE}/bookings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CAL_API_KEY}`,
        "Content-Type": "application/json",
        "cal-api-version": CAL_API_VERSION,
      },
      body: JSON.stringify(calPayload),
    });

    calJSON = await calResponse.json();

    console.log(
      `[create-booking][${requestId}] Cal.com HTTP status: ${calResponse.status}`
    );
    console.log(
      `[create-booking][${requestId}] Cal.com response:`,
      JSON.stringify(calJSON)
    );
  } catch (err) {
    console.error(
      `[create-booking][${requestId}] Network error calling Cal.com:`,
      err.message
    );

    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: "Network error: could not reach the Cal.com API. Please try again.",
        error: err.message,
      }),
    };
  }

  if (!calResponse.ok || calJSON?.status === "error") {
    const calErrorMsg =
      calJSON?.error?.message ??
      calJSON?.message ??
      `Cal.com returned HTTP ${calResponse.status}`;

    console.error(
      `[create-booking][${requestId}] Cal.com booking FAILED:`,
      calErrorMsg
    );

    let hint = "";
    if (String(calErrorMsg).includes("no_available_users_found")) {
      hint = " The requested time slot may not be available. Ask the caller to choose a different time.";
    } else if (String(calErrorMsg).includes("error_required_field")) {
      hint = " A required Cal.com field is missing. Check bookingFieldsResponses.";
    } else if (
      String(calErrorMsg).includes("Unauthorized") ||
      calResponse.status === 401
    ) {
      hint = " CAL_API_KEY may be invalid or expired.";
    }

    return {
      statusCode: calResponse.status >= 500 ? 502 : 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        message: `Booking failed: ${calErrorMsg}.${hint}`,
        calError: calJSON?.error ?? null,
        calStatus: calResponse.status,
      }),
    };
  }

  const booking = calJSON?.data ?? calJSON;

  console.log(
    `[create-booking][${requestId}] Booking created successfully. UID: ${booking?.uid}`
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      success: true,
      message: `Booking confirmed for ${String(name).trim()} on ${date} at ${time} (${resolvedTZ}).`,
      bookingUid: booking?.uid ?? null,
      bookingId: booking?.id ?? null,
      startTime: booking?.start ?? startISO,
      endTime: booking?.end ?? null,
      calendarLink: booking?.meetingUrl ?? null,
      attendee: {
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
      },
    }),
  };
};
