// =============================================================================
// FILE: netlify/functions/cal-webhook.js
// VozAI — Cal.com Booking Webhook → Twilio SMS Confirmation
// =============================================================================

"use strict";

const twilio = require("twilio");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER    = process.env.TWILIO_PHONE_NUMBER;

// Cal.com event types we handle
const EVENT_TYPES = {
  BOOKING_CREATED:    "BOOKING_CREATED",
  BOOKING_CANCELLED:  "BOOKING_CANCELLED",   // ready to extend
  BOOKING_RESCHEDULED:"BOOKING_RESCHEDULED", // ready to extend
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Attempt to normalise a US phone number to E.164 (+1XXXXXXXXXX).
 * If the number is already E.164 or looks non-US, it is returned unchanged.
 */
function normalizePhone(raw) {
  if (!raw) return null;

  const digits = raw.replace(/\D/g, "");

  // Already E.164 with country code
  if (raw.startsWith("+")) return raw;

  // 10-digit US number
  if (digits.length === 10) return `+1${digits}`;

  // 11-digit starting with 1 (US with country code, no +)
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Cannot safely normalise — return as-is and let Twilio validate
  console.warn(`[cal-webhook] Could not normalise phone number: ${raw}`);
  return raw;
}

/**
 * Format a date string into a human-friendly format.
 * Example: "Monday, July 14, 2025 at 2:00 PM"
 */
function formatDateTime(isoString) {
  if (!isoString) return "your scheduled time";
  try {
    return new Date(isoString).toLocaleString("en-US", {
      weekday: "long",
      year:    "numeric",
      month:   "long",
      day:     "numeric",
      hour:    "numeric",
      minute:  "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return isoString; // fallback to raw string
  }
}

/**
 * Build the SMS message body for a confirmed booking.
 * Keep under 160 chars for a single SMS segment where possible.
 */
function buildConfirmationSMS(name, eventName, startTime) {
  const friendlyTime = formatDateTime(startTime);
  const label = eventName ? eventName : "VozAI demo";
  return (
    `Hi ${name}! Your ${label} is confirmed for ${friendlyTime}. ` +
    `We look forward to speaking with you. Reply STOP to unsubscribe.`
  );
}

/**
 * Recursively walk an object looking for a value whose key matches a phone
 * pattern. Returns the first match found, or null. Guards against circular
 * refs via a visited Set.
 */
function deepFindPhone(obj, visited = new Set()) {
  if (!obj || typeof obj !== "object" || visited.has(obj)) return null;
  visited.add(obj);

  const PHONE_KEY = /phone|mobile|cell|tel|sms/i;

  for (const [key, value] of Object.entries(obj)) {
    if (PHONE_KEY.test(key) && typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      const found = deepFindPhone(value, visited);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// EVENT HANDLERS
// Structured so you can add BOOKING_CANCELLED, BOOKING_RESCHEDULED, etc.
// ---------------------------------------------------------------------------

async function handleBookingCreated(payload) {
  // ── 0. NORMALIZE PAYLOAD LEVEL ───────────────────────────────────────────
  // Cal.com wraps the booking object under payload.payload in most webhook
  // versions. We alias it here so all reads below work regardless of nesting.
  const booking = payload.payload;
  console.log("[cal-webhook] BOOKING OBJECT:", JSON.stringify(booking, null, 2));

  // ── 1. ATTENDEE NAME ────────────────────────────────────────────────────
  const attendees = booking.attendees || [];
  const attendee  = attendees[0] || {};

  // responses.name.value is the most reliable source; fall back to attendees[]
  const name =
    booking.responses?.name?.value ||
    attendee.name ||
    "there";
  console.log(`[cal-webhook] Attendee name source: ${
    booking.responses?.name?.value ? "booking.responses.name.value" :
    attendee.name                  ? "booking.attendees[0].name"    : "fallback 'there'"
  } → "${name}"`);

  // ── 2. PHONE NUMBER ─────────────────────────────────────────────────────
  // Cal.com stores custom question answers in booking.responses as:
  //   { "<questionIdentifier>": { label: "Phone Number", value: "+1..." } }
  // We also check attendees[] and metadata as fallbacks.

  let rawPhone = null;
  let phoneSource = "none";

  // 2a. responses object — scan every key for phone-like labels or values
  if (booking.responses && typeof booking.responses === "object") {
    const PHONE_LABELS = /phone|mobile|cell|tel|sms/i;

    for (const [key, field] of Object.entries(booking.responses)) {
      const label = (field?.label || key || "").toString();
      const value = field?.value;

      if (!value || typeof value !== "string") continue;

      // Match by label name OR by key name containing phone keywords
      if (PHONE_LABELS.test(label) || PHONE_LABELS.test(key)) {
        rawPhone    = value;
        phoneSource = `booking.responses["${key}"].value (label: "${label}")`;
        break;
      }
    }
  }

  // 2b. attendees[0] direct fields
  if (!rawPhone) {
    rawPhone = attendee.phoneNumber || attendee.phone || null;
    if (rawPhone) phoneSource = "booking.attendees[0].phoneNumber/phone";
  }

  // 2c. booking.metadata (some Cal.com setups pass it here)
  if (!rawPhone && booking.metadata && typeof booking.metadata === "object") {
    const meta = booking.metadata;
    rawPhone = meta.phone || meta.phoneNumber || meta.mobile || null;
    if (rawPhone) phoneSource = "booking.metadata";
  }

  // 2d. Deep fallback — recursively walk the entire booking looking for any
  //     string value whose key matches a phone pattern (last resort)
  if (!rawPhone) {
    rawPhone = deepFindPhone(booking);
    if (rawPhone) phoneSource = "deep booking scan";
  }

  console.log(`[cal-webhook] Phone source: ${phoneSource} → "${rawPhone}"`);

  // ── 3. START TIME ────────────────────────────────────────────────────────
  const startTime =
    booking.startTime          ||
    booking.payload?.startTime ||
    null;
  console.log(`[cal-webhook] Start time source: ${
    booking.startTime          ? "booking.startTime"          :
    booking.payload?.startTime ? "booking.payload.startTime"  : "not found"
  } → "${startTime}"`);

  // ── 4. EVENT NAME ────────────────────────────────────────────────────────
  const eventName =
    booking.title            ||
    booking.eventType?.title ||
    null;

  console.log(`[cal-webhook] Booking created — attendee: "${name}", phone: "${rawPhone}", start: "${startTime}"`);

  if (!rawPhone) {
    console.warn("[cal-webhook] No phone number found in payload. Skipping SMS.");
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "skipped",
        reason: "No attendee phone number in payload.",
      }),
    };
  }

  const toNumber = normalizePhone(rawPhone);
  const body     = buildConfirmationSMS(name, eventName, startTime);

  console.log(`[cal-webhook] Sending SMS to ${toNumber}: "${body}"`);

  const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  const message = await client.messages.create({
    from: FROM_NUMBER,
    to:   toNumber,
    body,
  });

  console.log(`[cal-webhook] SMS sent — SID: ${message.sid}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      status:     "success",
      messageSid: message.sid,
    }),
  };
}

// Stubs — wire up when you're ready to extend
async function handleBookingCancelled(payload) {
  console.log("[cal-webhook] BOOKING_CANCELLED received — handler not yet implemented.");
  return { statusCode: 200, body: JSON.stringify({ status: "ignored", event: EVENT_TYPES.BOOKING_CANCELLED }) };
}

async function handleBookingRescheduled(payload) {
  console.log("[cal-webhook] BOOKING_RESCHEDULED received — handler not yet implemented.");
  return { statusCode: 200, body: JSON.stringify({ status: "ignored", event: EVENT_TYPES.BOOKING_RESCHEDULED }) };
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    console.error("[cal-webhook] Failed to parse request body:", err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  console.log("[cal-webhook] Incoming payload:", JSON.stringify(payload, null, 2));

  const triggerEvent = payload.triggerEvent || payload.type || "";

  // Route to the correct handler
  try {
    switch (triggerEvent) {
      case EVENT_TYPES.BOOKING_CREATED:
        return await handleBookingCreated(payload);

      case EVENT_TYPES.BOOKING_CANCELLED:
        return await handleBookingCancelled(payload);

      case EVENT_TYPES.BOOKING_RESCHEDULED:
        return await handleBookingRescheduled(payload);

      default:
        console.log(`[cal-webhook] Unhandled event type: "${triggerEvent}". Ignoring.`);
        return {
          statusCode: 200,
          body: JSON.stringify({ status: "ignored", event: triggerEvent }),
        };
    }
  } catch (err) {
    console.error("[cal-webhook] Unexpected error:", err.message, err.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error", detail: err.message }),
    };
  }
};
