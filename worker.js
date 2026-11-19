function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function cleanText(value, maximumLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximumLength);
}

function isValidDateString(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  );
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

function createRequestNumber() {
  const datePart = new Date()
    .toISOString()
    .slice(2, 10)
    .replaceAll("-", "");

  const randomPart = crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 6)
    .toUpperCase();

  return `NPC-${datePart}-${randomPart}`;
}

async function getAvailabilityRows(
  env,
  service,
  startDate,
  endDate
) {
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

  return result.results || [];
}

async function sha256Hex(value) {
  const data =
    new TextEncoder().encode(value);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array
    .from(new Uint8Array(digest))
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

function createSecureToken() {
  const randomBytes =
    new Uint8Array(32);

  crypto.getRandomValues(randomBytes);

  return Array
    .from(randomBytes)
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * Backend health check
     */
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

    /*
     * Availability and pricing estimate
     */
    if (
      url.pathname === "/api/availability" &&
      request.method === "GET"
    ) {
      try {
        const service =
          url.searchParams.get("service");

        const startDate =
          url.searchParams.get("start");

        const endDate =
          url.searchParams.get("end");

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

        const availabilityRows =
          await getAvailabilityRows(
            env,
            service,
            startDate,
            endDate
          );

        const availability =
          getOverallAvailability(
            availabilityRows
          );

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

    /*
     * Create a pending care request
     */
    if (
      url.pathname === "/api/requests" &&
      request.method === "POST"
    ) {
      try {
        /*
         * Basic per-visitor abuse protection.
         */
        const clientIp =
          request.headers.get("CF-Connecting-IP") ||
          "unknown";

        const rateLimitResult =
          await env.REQUEST_LIMITER.limit({
            key: `care-request:${clientIp}`
          });

        if (!rateLimitResult.success) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Too many request attempts. Please wait one minute and try again."
            },
            429
          );
        }

        const contentType =
          request.headers.get("Content-Type") || "";

        if (
          !contentType
            .toLowerCase()
            .includes("application/json")
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "The request must use JSON."
            },
            415
          );
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return jsonResponse(
            {
              ok: false,
              error:
                "The request information could not be read."
            },
            400
          );
        }

        /*
         * Clean and limit customer-supplied text.
         */
        const ownerName =
          cleanText(body.ownerName, 100);

        const email =
          cleanText(body.email, 200)
            .toLowerCase();

        const phone =
          cleanText(body.phone, 40);

        const petName =
          cleanText(body.petName, 100);

        const petDetails =
          cleanText(body.petDetails, 300);

        const careDetails =
          cleanText(body.careDetails, 2000);

        const service =
          cleanText(body.service, 30);

        const startDate =
          cleanText(body.startDate, 10);

        const endDate =
          cleanText(body.endDate, 10);

        const dogCount =
          Number(body.dogCount);

        const acknowledged =
          body.acknowledged === true;

        /*
         * Required-field validation.
         */
        if (
          !ownerName ||
          !email ||
          !phone ||
          !petName ||
          !petDetails ||
          !careDetails
        ) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Complete all required owner and pet information."
            },
            400
          );
        }

        if (!isValidEmail(email)) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Enter a valid email address."
            },
            400
          );
        }

        if (phone.length < 7) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Enter a valid phone number."
            },
            400
          );
        }

        const allowedServices = [
          "boarding",
          "house-sitting"
        ];

        if (!allowedServices.includes(service)) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Choose a valid pet-care service."
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
                "Enter valid arrival and departure dates."
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

        if (!acknowledged) {
          return jsonResponse(
            {
              ok: false,
              error:
                "Confirm that this is a request and not a guaranteed reservation."
            },
            400
          );
        }

        /*
         * Never trust price or stay totals sent by
         * the customer's browser. Recalculate here.
         */
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

        const nightlyRate =
          getNightlyRate(service, dogCount);

        const estimatedTotal =
          nightlyRate * nights;

        /*
         * Recheck availability immediately before saving.
         */
        const availabilityRows =
          await getAvailabilityRows(
            env,
            service,
            startDate,
            endDate
          );

        const availability =
          getOverallAvailability(
            availabilityRows
          );

        if (availability === "unavailable") {
          return jsonResponse(
            {
              ok: false,
              error:
                "One or more requested dates are now full or unavailable. Please select different dates."
            },
            409
          );
        }

        const requestNumber =
          createRequestNumber();

        /*
         * Save only validated and server-calculated values.
         */
        await env.DB
          .prepare(`
            INSERT INTO booking_requests (
              request_number,
              owner_name,
              email,
              phone,
              pet_name,
              pet_details,
              service,
              start_date,
              end_date,
              dog_count,
              nights,
              nightly_rate,
              estimated_total,
              care_details,
              status
            )
            VALUES (
              ?1, ?2, ?3, ?4, ?5,
              ?6, ?7, ?8, ?9, ?10,
              ?11, ?12, ?13, ?14, ?15
            )
          `)
          .bind(
            requestNumber,
            ownerName,
            email,
            phone,
            petName,
            petDetails,
            service,
            startDate,
            endDate,
            dogCount,
            nights,
            nightlyRate,
            estimatedTotal,
            careDetails,
            "pending"
          )
          .run();

        return jsonResponse(
          {
            ok: true,
            requestNumber,
            status: "pending",
            service,
            startDate,
            endDate,
            dogCount,
            nights,
            nightlyRate,
            estimatedTotal,
            message:
              "Your care request was received and is pending Nyah's review. This is not yet a confirmed reservation."
          },
          201
        );
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Your request could not be submitted right now. Please try again.",
            details: String(error)
          },
          500
        );
      }
    }

    /*
     * Reject unsupported methods for known request path.
     */
    if (
      url.pathname === "/api/requests" &&
      request.method !== "POST"
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "This endpoint only accepts POST requests."
        },
        405
      );
    }
    
    return env.ASSETS.fetch(request);
  }
};
