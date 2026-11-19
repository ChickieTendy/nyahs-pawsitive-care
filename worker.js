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

function createSessionCookie(rawSession) {
  return [
    `__Host-npc_session=${rawSession}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=604800"
  ].join("; ");
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

    /*
 * AUTH CHECKPOINT 1
 * Create and store a hashed magic-login token.
 * Email delivery is added after this passes.
 */
if (
  url.pathname === "/api/auth/request-link" &&
  request.method === "POST"
) {
  try {
    const body = await request.json();

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error: "Enter a valid email address."
        },
        400
      );
    }

    const account =
      await env.DB
        .prepare(`
          SELECT
            id,
            email,
            status
          FROM customer_accounts
          WHERE email = ?1
          LIMIT 1
        `)
        .bind(email)
        .first();

    if (
      !account ||
      account.status !== "active"
    ) {
      return jsonResponse({
        ok: true,
        message:
          "If that account is eligible for sign-in, check the inbox."
      });
    }

    const rawToken =
      createSecureToken();

    const tokenHash =
      await sha256Hex(rawToken);

    const expiresAt =
      new Date(
        Date.now() + (15 * 60 * 1000)
      ).toISOString();

    await env.DB
      .prepare(`
        DELETE FROM auth_tokens
        WHERE account_id = ?1
          AND purpose = ?2
          AND used_at IS NULL
      `)
      .bind(
        account.id,
        "magic_login"
      )
      .run();

    await env.DB
      .prepare(`
        INSERT INTO auth_tokens (
          account_id,
          token_hash,
          purpose,
          expires_at
        )
        VALUES (?1, ?2, ?3, ?4)
      `)
      .bind(
        account.id,
        tokenHash,
        "magic_login",
        expiresAt
      )
      .run();

    const magicUrl =
  new URL(
    "/auth/verify",
    "https://nyahspawsitivecare.com"
  );

magicUrl.searchParams.set(
  "token",
  rawToken
);

const resendResponse =
  await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        "Authorization":
          `Bearer ${env.RESEND_API_KEY}`,

        "Content-Type":
          "application/json",

        "User-Agent":
          "nyahs-pawsitive-care/1.0"
      },

      body: JSON.stringify({
        from:
          "Nyah's Pawsitive Care <login@accounts.nyahspawsitivecare.com>",

        to: [account.email],

        subject:
          "Sign in to Nyah's Pawsitive Care",

        html: `
          <div
            style="
              font-family:Arial,sans-serif;
              max-width:560px;
              margin:auto;
              padding:32px;
              color:#241b30;
            "
          >

            <h1
              style="
                color:#7b4ce2;
                margin-bottom:16px;
              "
            >
              Nyah's Pawsitive Care
            </h1>

            <p>
              Use the button below to securely
              sign in to your customer account.
            </p>

            <p style="margin:28px 0;">
              <a
                href="${magicUrl.toString()}"
                style="
                  display:inline-block;
                  padding:14px 22px;
                  background:#7b4ce2;
                  color:#ffffff;
                  text-decoration:none;
                  border-radius:10px;
                  font-weight:bold;
                "
              >
                Sign In
              </a>
            </p>

            <p>
              This link expires in 15 minutes
              and can only be used once.
            </p>

            <p
              style="
                color:#766b82;
                font-size:13px;
                margin-top:26px;
              "
            >
              If you did not request this sign-in
              link, you can safely ignore this email.
            </p>

          </div>
        `
      })
    }
  );

if (!resendResponse.ok) {
  await env.DB
    .prepare(`
      DELETE FROM auth_tokens
      WHERE token_hash = ?1
    `)
    .bind(tokenHash)
    .run();

  return jsonResponse(
    {
      ok: false,
      error:
        "Unable to send the sign-in email."
    },
    502
  );
}

return jsonResponse({
  ok: true,
  message:
    "Check your email for your secure sign-in link.",
  checkpoint: "email-sent"
});

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to create the authentication token."
      },
      500
    );
  }
  /*
 * Verify a passwordless magic link
 * and create a customer session.
 */
if (
  url.pathname === "/auth/verify" &&
  request.method === "GET"
) {
  try {
    const rawToken =
      url.searchParams.get("token") || "";

    if (
      rawToken.length < 32 ||
      rawToken.length > 200
    ) {
      return new Response(
        "This sign-in link is invalid.",
        {
          status: 400,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    const tokenHash =
      await sha256Hex(rawToken);

    const token =
      await env.DB
        .prepare(`
          SELECT
            id,
            account_id,
            expires_at,
            used_at
          FROM auth_tokens
          WHERE token_hash = ?1
            AND purpose = ?2
          LIMIT 1
        `)
        .bind(
          tokenHash,
          "magic_login"
        )
        .first();

    if (!token) {
      return new Response(
        "This sign-in link is invalid or has already been replaced.",
        {
          status: 400,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    if (token.used_at) {
      return new Response(
        "This sign-in link has already been used.",
        {
          status: 400,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    if (
      new Date(token.expires_at).getTime() <
      Date.now()
    ) {
      return new Response(
        "This sign-in link has expired. Please request a new one.",
        {
          status: 400,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    const account =
      await env.DB
        .prepare(`
          SELECT
            id,
            household_id,
            status
          FROM customer_accounts
          WHERE id = ?1
          LIMIT 1
        `)
        .bind(token.account_id)
        .first();

    if (
      !account ||
      account.status !== "active"
    ) {
      return new Response(
        "This customer account is not available.",
        {
          status: 403,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    const rawSession =
      createSecureToken();

    const sessionHash =
      await sha256Hex(rawSession);

    const sessionExpiresAt =
      new Date(
        Date.now() +
        (7 * 24 * 60 * 60 * 1000)
      ).toISOString();

    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE auth_tokens
          SET used_at = CURRENT_TIMESTAMP
          WHERE id = ?1
            AND used_at IS NULL
        `)
        .bind(token.id),

      env.DB
        .prepare(`
          INSERT INTO customer_sessions (
            account_id,
            session_hash,
            expires_at,
            last_seen_at
          )
          VALUES (
            ?1,
            ?2,
            ?3,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          account.id,
          sessionHash,
          sessionExpiresAt
        ),

      env.DB
        .prepare(`
          UPDATE customer_accounts
          SET
            email_verified = 1,
            last_login_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?1
        `)
        .bind(account.id)
    ]);

    const headers =
      new Headers();

    headers.set(
      "Location",
      "/account"
    );

    headers.append(
      "Set-Cookie",
      createSessionCookie(rawSession)
    );

    headers.set(
      "Cache-Control",
      "no-store"
    );

    return new Response(
      null,
      {
        status: 302,
        headers
      }
    );

  } catch (error) {
    return new Response(
      "Unable to complete sign-in right now.",
      {
        status: 500,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",
          "Cache-Control":
            "no-store"
        }
      }
    );
  }
}
}
    
    return env.ASSETS.fetch(request);
  }
};
