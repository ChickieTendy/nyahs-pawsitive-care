function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getNightCount(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  return Math.round((end - start) / 86400000);
}

function getNightlyRate(service, dogCount) {
  if (service === "boarding") {
    if (dogCount === 1) return 55;
    if (dogCount === 2) return 95;
    return 95 + ((dogCount - 2) * 40);
  }

  if (service === "house-sitting") {
    if (dogCount === 1) return 65;
    if (dogCount === 2) return 105;
    return 105 + ((dogCount - 2) * 40);
  }

  return null;
}

function getOverallAvailability(rows) {
  const statuses = rows.map((row) =>
    String(row.status || "").toLowerCase()
  );

  if (
    statuses.includes("unavailable") ||
    statuses.includes("full")
  ) {
    return "unavailable";
  }

  if (statuses.includes("limited")) {
    return "limited";
  }

  return "available";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        const result = await env.DB
          .prepare("SELECT 1 AS connected")
          .first();

        return jsonResponse({
          ok: true,
          database:
            result?.connected === 1
              ? "connected"
              : "unexpected response"
        });
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            database: "not connected",
            error: String(error)
          },
          500
        );
      }
    }

    if (
      url.pathname === "/api/availability" &&
      request.method === "GET"
    ) {
      try {
        const service = url.searchParams.get("service");
        const startDate = url.searchParams.get("start");
        const endDate = url.searchParams.get("end");
        const dogCount = Number(
          url.searchParams.get("dogs")
        );

        const allowedServices = [
          "boarding",
          "house-sitting"
        ];

        if (!allowedServices.includes(service)) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Choose Dog Boarding or In-Home House Sitting."
            },
            400
          );
        }

        if (
          !isValidDateString(startDate) ||
          !isValidDateString(endDate)
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Enter a valid start date and end date."
            },
            400
          );
        }

        if (
          !Number.isInteger(dogCount) ||
          dogCount < 1 ||
          dogCount > 10
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Enter a number of dogs between 1 and 10."
            },
            400
          );
        }

        const nights = getNightCount(
          startDate,
          endDate
        );

        if (nights < 1) {
          return jsonResponse(
            {
              ok: false,
              error:
                "The departure date must be later than the arrival date."
            },
            400
          );
        }

        if (nights > 60) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Please request a stay of 60 nights or fewer."
            },
            400
          );
        }

        const result = await env.DB
          .prepare(`
            SELECT
              date,
              service,
              status,
              capacity,
              notes
            FROM availability
            WHERE service = ?1
              AND date >= ?2
              AND date < ?3
            ORDER BY date ASC
          `)
          .bind(service, startDate, endDate)
          .all();

        const availabilityRows =
          result.results || [];

        const availability =
          getOverallAvailability(availabilityRows);

        const nightlyRate =
          getNightlyRate(service, dogCount);

        const estimatedTotal =
          nightlyRate * nights;

        return jsonResponse({
          ok: true,
          service,
          startDate,
          endDate,
          nights,
          dogCount,
          nightlyRate,
          estimatedTotal,
          availability,
          affectedDates: availabilityRows,
          message:
            availability === "available"
              ? "These dates are currently available to request."
              : availability === "limited"
                ? "Availability is limited. Please submit a request for review."
                : "One or more requested dates are full or unavailable.",
          disclaimer:
            "This is an estimate, not a confirmed reservation. Holiday, extended-care, and other agreed charges may apply."
        });
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Unable to check availability right now.",
            details: String(error)
          },
          500
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse(
        {
          ok: false,
          error: "API endpoint not found"
        },
        404
      );
    }

    return env.ASSETS.fetch(request);
  }
};
