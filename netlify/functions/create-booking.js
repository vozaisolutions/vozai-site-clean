"use strict";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const { name, service, date, time } = data;

  if (!name || !date || !time) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        message: "Missing required booking info",
      }),
    };
  }

  try {
    const response = await fetch("https://api.cal.com/v1/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
      },
      body: JSON.stringify({
        eventTypeSlug: "vozai-demo-consultation",
        username: "cindy-p0qomv",
        start: `${date}T${time}:00`,
        responses: {
          name: name,
          notes: service || "",
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          message: "Cal.com booking failed",
          error: result,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Booking created successfully",
        data: result,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Server error",
        error: err.message,
      }),
    };
  }
};
