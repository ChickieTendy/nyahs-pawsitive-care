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
function getCookieValue(request, cookieName) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {
    const separatorIndex =
      cookie.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const name =
      cookie
        .slice(0, separatorIndex)
        .trim();

    const value =
      cookie
        .slice(separatorIndex + 1)
        .trim();

    if (name === cookieName) {
      return value;
    }
  }

  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
async function verifyTurnstile(
  token,
  request,
  env
) {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 2048
  ) {
    return false;
  }

  const clientIp =
    request.headers.get(
      "CF-Connecting-IP"
    ) || "";

  const formData =
    new FormData();

  formData.append(
    "secret",
    env.TURNSTILE_SECRET
  );

  formData.append(
    "response",
    token
  );

  if (clientIp) {
    formData.append(
      "remoteip",
      clientIp
    );
  }

  const response =
    await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: formData
      }
    );

  if (!response.ok) {
    return false;
  }

  const result =
    await response.json();

  return result.success === true;
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
const turnstileToken =
  typeof body.turnstileToken === "string"
    ? body.turnstileToken
    : "";

const turnstileValid =
  await verifyTurnstile(
    turnstileToken,
    request,
    env
  );

if (!turnstileValid) {
  return jsonResponse(
    {
      ok: false,
      error:
        "Security verification failed. Please try again."
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
  }
    /*
 * Create a new customer household and
 * send an email-verification magic link.
 */
if (
  url.pathname === "/api/auth/signup" &&
  request.method === "POST"
) {
  try {
    const body =
      await request.json();

    const fullName =
      typeof body.fullName === "string"
        ? body.fullName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 100)
        : "";

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    const phone =
      typeof body.phone === "string"
        ? body.phone
            .trim()
            .slice(0, 40)
        : "";

    const turnstileToken =
      typeof body.turnstileToken === "string"
        ? body.turnstileToken
        : "";

    if (
      !fullName ||
      fullName.length < 2
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter your full name."
        },
        400
      );
    }

    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid email address."
        },
        400
      );
    }

    if (
      !phone ||
      phone.replace(/\D/g, "").length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid phone number."
        },
        400
      );
    }

    /*
     * Verify Turnstile before writing
     * any account data.
     */
    const turnstileValid =
      await verifyTurnstile(
        turnstileToken,
        request,
        env
      );

    if (!turnstileValid) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Security verification failed. Please try again."
        },
        400
      );
    }

    /*
     * Prevent the same email from
     * creating another household.
     */
    const existingAccount =
      await env.DB
        .prepare(`
          SELECT
            id,
            status
          FROM customer_accounts
          WHERE email = ?1
          LIMIT 1
        `)
        .bind(email)
        .first();

    if (existingAccount) {
      return jsonResponse(
        {
          ok: true,
          accountExists: true,
          message:
            "An account may already exist for this email. Use Returning Client to sign in."
        },
        200
      );
    }

    /*
     * Generate identifiers.
     */
    const identifier =
      crypto
        .randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)
        .toUpperCase();

    const householdNumber =
      `HH-${identifier}`;

    const accountNumber =
      `CA-${identifier}`;

    const rawToken =
      createSecureToken();

    const tokenHash =
      await sha256Hex(rawToken);

    const expiresAt =
      new Date(
        Date.now() +
        (15 * 60 * 1000)
      ).toISOString();

    /*
     * Create the household, account,
     * primary parent, and verification token
     * together.
     *
     * D1 batch executes these statements
     * in order.
     */
    await env.DB.batch([

      env.DB
        .prepare(`
          INSERT INTO households (
            household_number,
            display_name,
            status
          )
          VALUES (
            ?1,
            ?2,
            ?3
          )
        `)
        .bind(
          householdNumber,
          `${fullName}'s Household`,
          "pending"
        ),

      env.DB
        .prepare(`
          INSERT INTO customer_accounts (
            account_number,
            household_id,
            email,
            status,
            email_verified
          )
          SELECT
            ?1,
            id,
            ?2,
            ?3,
            0
          FROM households
          WHERE household_number = ?4
        `)
        .bind(
          accountNumber,
          email,
          "active",
          householdNumber
        ),

      env.DB
        .prepare(`
          INSERT INTO household_members (
            household_id,
            full_name,
            email,
            phone,
            role,
            is_primary_contact,
            can_request_care,
            receives_updates,
            status
          )
          SELECT
            h.id,
            ?1,
            ?2,
            ?3,
            ?4,
            1,
            1,
            1,
            'active'
          FROM households h
          WHERE h.household_number = ?5
        `)
        .bind(
          fullName,
          email,
          phone,
          "Primary Pet Parent",
          householdNumber
        ),

      env.DB
        .prepare(`
          INSERT INTO auth_tokens (
            account_id,
            token_hash,
            purpose,
            expires_at
          )
          SELECT
            ca.id,
            ?1,
            ?2,
            ?3
          FROM customer_accounts ca
          WHERE ca.account_number = ?4
        `)
        .bind(
          tokenHash,
          "magic_login",
          expiresAt,
          accountNumber
        )

    ]);

    /*
     * Build email verification/sign-in URL.
     */
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

            to: [email],

            subject:
              "Verify your Nyah's Pawsitive Care account",

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
                  Welcome to Nyah's Pawsitive Care
                </h1>

                <p>
                  Hi ${escapeHtml(fullName)},
                </p>

                <p>
                  Your household account has been started.
                  Verify your email to securely access your
                  customer portal.
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
                    Verify Email & Sign In
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
                  If you did not create this account,
                  contact Nyah's Pawsitive Care.
                </p>

              </div>
            `
          })
        }
      );

    if (!resendResponse.ok) {
      /*
       * Keep the pending account rather than
       * silently duplicating an account on retry.
       * Returning Client can be used once email
       * delivery is available again.
       */
      return jsonResponse(
        {
          ok: false,
          accountCreated: true,
          error:
            "Your account was created, but the verification email could not be sent. Please use Returning Client to request another sign-in link."
        },
        502
      );
    }

    return jsonResponse(
      {
        ok: true,
        accountCreated: true,
        message:
          "Account created. Check your email to verify your address and sign in."
      },
      201
    );

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to create the account right now."
      },
      500
    );
  }
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
    /*
 * Authenticated read-only household data.
 */
if (
  url.pathname === "/api/account-data" &&
  request.method === "GET"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error: "Authentication required."
      },
      401
    );
  }

  try {
    const sessionHash =
      await sha256Hex(rawSession);

    const customer =
      await env.DB
        .prepare(`
          SELECT
            ca.id AS account_id,
            ca.household_id,
            ca.email,

           h.household_number,
h.display_name,
h.status AS household_status,
h.address_line_1,
h.address_line_2,
h.city,
h.state,
h.postal_code
          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          JOIN households h
            ON h.id = ca.household_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at > CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!customer) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    const results =
      await env.DB.batch([

        env.DB
          .prepare(`
            SELECT
            id,
              full_name,
              email,
              phone,
              role,
              is_primary_contact,
              can_request_care,
              receives_updates
            FROM household_members
            WHERE household_id = ?1
              AND status = 'active'
            ORDER BY
              is_primary_contact DESC,
              full_name ASC
          `)
          .bind(customer.household_id),

        env.DB
          .prepare(`
            SELECT
            id,
              full_name,
              relationship,
              primary_phone,
              alternate_phone,
              email,
              priority,
              authorized_for_medical_decisions,
              authorized_for_pickup,
              notes
            FROM emergency_contacts
            WHERE household_id = ?1
            ORDER BY
              priority ASC,
              full_name ASC
          `)
          .bind(customer.household_id),

        env.DB
          .prepare(`
            SELECT
              id,
              pet_number,
              name,
              species,
              breed,
              color_markings,
              date_of_birth,
              sex,
              spayed_neutered,
              weight_lbs,
              feeding_notes,
              medication_notes,
              medical_notes,
              behavior_notes,
              routine_notes,
              allergy_notes,
              house_trained,
              crate_trained,
              dog_friendly,
              cat_friendly,
              child_friendly,
              meet_greet_status,
              compatibility_status,
              approval_status
            FROM pets
            WHERE household_id = ?1
              AND status = 'active'
            ORDER BY name ASC
          `)
          .bind(customer.household_id),

        env.DB
          .prepare(`
            SELECT
              p.pet_number,
              p.name AS pet_name,

              pvr.relationship_type,
              pvr.is_primary,
              pvr.permission_to_contact,

              vc.clinic_name,
              vc.veterinarian_name,
              vc.phone,
              vc.emergency_phone,
              vc.email,
              vc.website,
              vc.address_line_1,
              vc.address_line_2,
              vc.city,
              vc.state,
              vc.postal_code,
              vc.clinic_type

            FROM pet_veterinary_relationships pvr

            JOIN pets p
              ON p.id = pvr.pet_id

            JOIN veterinary_clinics vc
              ON vc.id = pvr.clinic_id

            WHERE p.household_id = ?1
              AND p.status = 'active'

            ORDER BY
              p.name ASC,
              pvr.is_primary DESC,
              vc.clinic_name ASC
          `)
          .bind(customer.household_id),

        env.DB
          .prepare(`
            SELECT
              p.pet_number,
              p.name AS pet_name,

              v.vaccine_name,
              v.administered_date,
              v.expiration_date,
              v.veterinarian_name,
              v.source,
              v.verification_status,
              v.customer_confirmed,
              v.admin_verified,
              v.notes,

              vc.clinic_name,

              CASE
                WHEN v.expiration_date IS NULL
                  OR TRIM(v.expiration_date) = ''
                  THEN 'needs_review'

                WHEN DATE(v.expiration_date) <
                  DATE('now')
                  THEN 'expired'

                WHEN DATE(v.expiration_date) <=
                  DATE('now', '+30 days')
                  THEN 'expiring_soon'

                ELSE 'current'
              END AS display_status

            FROM vaccinations v

            JOIN pets p
              ON p.id = v.pet_id

            LEFT JOIN veterinary_clinics vc
              ON vc.id = v.clinic_id

            WHERE p.household_id = ?1
              AND p.status = 'active'

            ORDER BY
              p.name ASC,
              v.expiration_date ASC,
              v.vaccine_name ASC
          `)
          .bind(customer.household_id)

      ]);

    return jsonResponse({
      ok: true,

     household: {
  householdNumber:
    customer.household_number,

  displayName:
    customer.display_name,

  status:
    customer.household_status,

  addressLine1:
    customer.address_line_1,

  addressLine2:
    customer.address_line_2,

  city:
    customer.city,

  state:
    customer.state,

  postalCode:
    customer.postal_code
},

      parents:
        results[0]?.results || [],

      emergencyContacts:
        results[1]?.results || [],

      pets:
        results[2]?.results || [],

      veterinaryRelationships:
        results[3]?.results || [],

      vaccinations:
        results[4]?.results || []
    });

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to load the household details."
      },
      500
    );
  }
}
    /*
 * Update the authenticated customer's
 * household profile.
 */
if (
  url.pathname === "/api/account/household" &&
  request.method === "PUT"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Authentication required."
      },
      401
    );
  }

  try {
    const body =
      await request.json();

    const displayName =
      typeof body.displayName === "string"
        ? body.displayName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 120)
        : "";

    const addressLine1 =
      typeof body.addressLine1 === "string"
        ? body.addressLine1
            .trim()
            .slice(0, 150)
        : "";

    const addressLine2 =
      typeof body.addressLine2 === "string"
        ? body.addressLine2
            .trim()
            .slice(0, 150)
        : "";

    const city =
      typeof body.city === "string"
        ? body.city
            .trim()
            .slice(0, 100)
        : "";

    const state =
      typeof body.state === "string"
        ? body.state
            .trim()
            .toUpperCase()
            .slice(0, 2)
        : "";

    const postalCode =
      typeof body.postalCode === "string"
        ? body.postalCode
            .trim()
            .slice(0, 10)
        : "";

    if (!displayName) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a household name."
        },
        400
      );
    }

    /*
     * Resolve household from the session.
     * Never trust a household ID from
     * the customer's browser.
     */
    const sessionHash =
      await sha256Hex(rawSession);

    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id
          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    await env.DB
      .prepare(`
        UPDATE households
        SET
          display_name = ?1,
          address_line_1 = ?2,
          address_line_2 = ?3,
          city = ?4,
          state = ?5,
          postal_code = ?6,
          updated_at =
            CURRENT_TIMESTAMP
        WHERE id = ?7
      `)
      .bind(
        displayName,
        addressLine1 || null,
        addressLine2 || null,
        city || null,
        state || null,
        postalCode || null,
        account.household_id
      )
      .run();

    return jsonResponse({
      ok: true,
      message:
        "Household information updated."
    });

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to update the household right now."
      },
      500
    );
  }
}
    /*
 * Add a pet parent or authorized person
 * to the authenticated customer's household.
 */
if (
  url.pathname === "/api/account/parents" &&
  request.method === "POST"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Authentication required."
      },
      401
    );
  }

  try {
    const body =
      await request.json();

    const fullName =
      typeof body.fullName === "string"
        ? body.fullName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 100)
        : "";

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    const phone =
      typeof body.phone === "string"
        ? body.phone
            .trim()
            .slice(0, 40)
        : "";

    const role =
      typeof body.role === "string"
        ? body.role
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80)
        : "";

    const requestedPrimary =
      body.isPrimaryContact === true;

    const canRequestCare =
      body.canRequestCare !== false
        ? 1
        : 0;

    const receivesUpdates =
      body.receivesUpdates !== false
        ? 1
        : 0;

    if (
      !fullName ||
      fullName.length < 2
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the pet parent’s full name."
        },
        400
      );
    }

    if (
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid email address."
        },
        400
      );
    }

    if (
      phone &&
      phone.replace(/\D/g, "").length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid phone number."
        },
        400
      );
    }

    if (!role) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the person’s role."
        },
        400
      );
    }

    /*
     * Resolve the household from the session.
     * The browser does not choose household_id.
     */
    const sessionHash =
      await sha256Hex(rawSession);

    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id
          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    /*
     * Avoid duplicate active household members
     * using the same provided email address.
     */
    if (email) {
      const duplicate =
        await env.DB
          .prepare(`
            SELECT id
            FROM household_members
            WHERE household_id = ?1
              AND LOWER(email) = ?2
              AND status = 'active'
            LIMIT 1
          `)
          .bind(
            account.household_id,
            email
          )
          .first();

      if (duplicate) {
        return jsonResponse(
          {
            ok: false,
            error:
              "An active pet parent with this email already exists in the household."
          },
          409
        );
      }
    }

    /*
     * The first active member automatically
     * becomes the primary contact.
     */
    const memberSummary =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) AS active_count,

            SUM(
              CASE
                WHEN is_primary_contact = 1
                THEN 1
                ELSE 0
              END
            ) AS primary_count

          FROM household_members
          WHERE household_id = ?1
            AND status = 'active'
        `)
        .bind(account.household_id)
        .first();

    const activeCount =
      Number(
        memberSummary?.active_count || 0
      );

    const primaryCount =
      Number(
        memberSummary?.primary_count || 0
      );

    const shouldBePrimary =
      requestedPrimary ||
      activeCount === 0 ||
      primaryCount === 0;

    const insertStatement =
      env.DB
        .prepare(`
          INSERT INTO household_members (
            household_id,
            full_name,
            email,
            phone,
            role,
            is_primary_contact,
            can_request_care,
            receives_updates,
            status,
            created_at,
            updated_at
          )
          VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            ?6,
            ?7,
            ?8,
            'active',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          account.household_id,
          fullName,
          email || null,
          phone || null,
          role,
          shouldBePrimary ? 1 : 0,
          canRequestCare,
          receivesUpdates
        );

    let insertResult;

    if (shouldBePrimary) {
      /*
       * Transfer primary status and insert
       * the new primary person atomically.
       */
      const batchResults =
        await env.DB.batch([
          env.DB
            .prepare(`
              UPDATE household_members
              SET
                is_primary_contact = 0,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE household_id = ?1
                AND status = 'active'
            `)
            .bind(
              account.household_id
            ),

          insertStatement
        ]);

      insertResult =
        batchResults[1];

    } else {
      insertResult =
        await insertStatement.run();
    }

    return jsonResponse(
      {
        ok: true,

        parentId:
          insertResult?.meta
            ?.last_row_id || null,

        message:
          "Pet parent added.",

        isPrimaryContact:
          shouldBePrimary
      },
      201
    );

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to add the pet parent right now."
      },
      500
    );
  }
}
    /*
 * Edit a pet parent belonging to the
 * authenticated customer's household.
 */
if (
  url.pathname.startsWith(
    "/api/account/parents/"
  ) &&
  request.method === "PUT"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error: "Authentication required."
      },
      401
    );
  }

  try {
    const parentIdText =
      url.pathname
        .slice(
          "/api/account/parents/"
            .length
        )
        .trim();

    const parentId =
      Number(parentIdText);

    if (
      !Number.isInteger(parentId) ||
      parentId < 1
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid pet parent."
        },
        400
      );
    }

    const body =
      await request.json();

    const fullName =
      typeof body.fullName === "string"
        ? body.fullName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 100)
        : "";

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    const phone =
      typeof body.phone === "string"
        ? body.phone
            .trim()
            .slice(0, 40)
        : "";

    const role =
      typeof body.role === "string"
        ? body.role
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80)
        : "";

    const requestedPrimary =
      body.isPrimaryContact === true;

    const canRequestCare =
      body.canRequestCare !== false
        ? 1
        : 0;

    const receivesUpdates =
      body.receivesUpdates !== false
        ? 1
        : 0;

    if (
      !fullName ||
      fullName.length < 2
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the pet parent’s full name."
        },
        400
      );
    }

    if (
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid email address."
        },
        400
      );
    }

    if (
      phone &&
      phone.replace(/\D/g, "")
        .length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid phone number."
        },
        400
      );
    }

    if (!role) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the person’s role."
        },
        400
      );
    }

    /*
     * Resolve the household from the
     * authenticated session.
     */
    const sessionHash =
      await sha256Hex(rawSession);

    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id

          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    /*
     * Critical ownership check:
     * parent ID must belong to this household.
     */
    const existingParent =
      await env.DB
        .prepare(`
          SELECT
            id,
            is_primary_contact

          FROM household_members

          WHERE id = ?1
            AND household_id = ?2
            AND status = 'active'

          LIMIT 1
        `)
        .bind(
          parentId,
          account.household_id
        )
        .first();

    if (!existingParent) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Pet parent not found."
        },
        404
      );
    }

    /*
     * Prevent duplicate active email
     * within the same household.
     */
    if (email) {
      const duplicate =
        await env.DB
          .prepare(`
            SELECT id

            FROM household_members

            WHERE household_id = ?1
              AND LOWER(email) = ?2
              AND status = 'active'
              AND id <> ?3

            LIMIT 1
          `)
          .bind(
            account.household_id,
            email,
            parentId
          )
          .first();

      if (duplicate) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Another active pet parent already uses this email."
          },
          409
        );
      }
    }

    /*
     * Don't let the current primary be
     * demoted if no other primary exists.
     */
    if (
      Number(
        existingParent
          .is_primary_contact
      ) === 1 &&
      !requestedPrimary
    ) {
      const otherPrimary =
        await env.DB
          .prepare(`
            SELECT id

            FROM household_members

            WHERE household_id = ?1
              AND status = 'active'
              AND is_primary_contact = 1
              AND id <> ?2

            LIMIT 1
          `)
          .bind(
            account.household_id,
            parentId
          )
          .first();

      if (!otherPrimary) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Choose another primary contact before removing primary status from this person."
          },
          409
        );
      }
    }

    const updateParent =
      env.DB
        .prepare(`
          UPDATE household_members
          SET
            full_name = ?1,
            email = ?2,
            phone = ?3,
            role = ?4,
            is_primary_contact = ?5,
            can_request_care = ?6,
            receives_updates = ?7,
            updated_at =
              CURRENT_TIMESTAMP

          WHERE id = ?8
            AND household_id = ?9
            AND status = 'active'
        `)
        .bind(
          fullName,
          email || null,
          phone || null,
          role,
          requestedPrimary ? 1 : 0,
          canRequestCare,
          receivesUpdates,
          parentId,
          account.household_id
        );

    if (requestedPrimary) {
      /*
       * Transfer primary status and save
       * the edited person atomically.
       */
      await env.DB.batch([
        env.DB
          .prepare(`
            UPDATE household_members
            SET
              is_primary_contact = 0,
              updated_at =
                CURRENT_TIMESTAMP

            WHERE household_id = ?1
              AND status = 'active'
              AND id <> ?2
          `)
          .bind(
            account.household_id,
            parentId
          ),

        updateParent
      ]);

    } else {
      await updateParent.run();
    }

    return jsonResponse({
      ok: true,
      parentId,
      message:
        "Pet parent updated.",
      isPrimaryContact:
        requestedPrimary
    });

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to update the pet parent right now."
      },
      500
    );
  }
}
   /*
 * Deactivate a pet parent belonging to
 * the authenticated customer's household.
 */
if (
  url.pathname.startsWith(
    "/api/account/parents/"
  ) &&
  request.method === "DELETE"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Authentication required."
      },
      401
    );
  }

  try {
    const parentIdText =
      url.pathname
        .slice(
          "/api/account/parents/"
            .length
        )
        .trim();

    const parentId =
      Number(parentIdText);

    if (
      !Number.isInteger(parentId) ||
      parentId < 1
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid pet parent."
        },
        400
      );
    }

    const sessionHash =
      await sha256Hex(rawSession);

    /*
     * Resolve the household from the
     * authenticated customer session.
     */
    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id

          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    /*
     * Confirm that this active Pet Parent
     * belongs to the authenticated household.
     */
    const parent =
      await env.DB
        .prepare(`
          SELECT
            id,
            full_name,
            is_primary_contact

          FROM household_members

          WHERE id = ?1
            AND household_id = ?2
            AND status = 'active'

          LIMIT 1
        `)
        .bind(
          parentId,
          account.household_id
        )
        .first();

    if (!parent) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Pet parent not found."
        },
        404
      );
    }

    /*
     * Never remove the household's only
     * active primary contact.
     */
    if (
      Number(
        parent.is_primary_contact
      ) === 1
    ) {
      const anotherPrimary =
        await env.DB
          .prepare(`
            SELECT id

            FROM household_members

            WHERE household_id = ?1
              AND status = 'active'
              AND is_primary_contact = 1
              AND id <> ?2

            LIMIT 1
          `)
          .bind(
            account.household_id,
            parentId
          )
          .first();

      if (!anotherPrimary) {
        return jsonResponse(
          {
            ok: false,
            error:
              "Choose another primary contact before removing this person."
          },
          409
        );
      }
    }

    /*
     * At least one other active household
     * member must remain.
     */
    const anotherActiveMember =
      await env.DB
        .prepare(`
          SELECT id

          FROM household_members

          WHERE household_id = ?1
            AND status = 'active'
            AND id <> ?2

          LIMIT 1
        `)
        .bind(
          account.household_id,
          parentId
        )
        .first();

    if (!anotherActiveMember) {
      return jsonResponse(
        {
          ok: false,
          error:
            "A household must keep at least one active pet parent."
        },
        409
      );
    }

    /*
     * Preserve the historical record by
     * deactivating rather than deleting it.
     */
    await env.DB
      .prepare(`
        UPDATE household_members

        SET
          status = 'inactive',
          is_primary_contact = 0,
          can_request_care = 0,
          receives_updates = 0,
          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = ?1
          AND household_id = ?2
          AND status = 'active'
      `)
      .bind(
        parentId,
        account.household_id
      )
      .run();

    return jsonResponse({
      ok: true,
      parentId,
      message:
        "Pet parent removed from the active household."
    });

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to remove the pet parent right now."
      },
      500
    );
  }
}
/*
 * Add an emergency contact to the
 * authenticated customer's household.
 */
if (
  url.pathname ===
    "/api/account/emergency-contacts" &&
  request.method === "POST"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Authentication required."
      },
      401
    );
  }

  try {
    const body =
      await request.json();

    const fullName =
      typeof body.fullName === "string"
        ? body.fullName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 100)
        : "";

    const relationship =
      typeof body.relationship === "string"
        ? body.relationship
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80)
        : "";

    const primaryPhone =
      typeof body.primaryPhone === "string"
        ? body.primaryPhone
            .trim()
            .slice(0, 40)
        : "";

    const alternatePhone =
      typeof body.alternatePhone === "string"
        ? body.alternatePhone
            .trim()
            .slice(0, 40)
        : "";

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    const priorityNumber =
      Number(body.priority);

    const priority =
      Number.isInteger(
        priorityNumber
      ) &&
      priorityNumber >= 1 &&
      priorityNumber <= 99
        ? priorityNumber
        : 1;

    const authorizedMedical =
      body.authorizedForMedicalDecisions ===
      true
        ? 1
        : 0;

    const authorizedPickup =
      body.authorizedForPickup === true
        ? 1
        : 0;

    const notes =
      typeof body.notes === "string"
        ? body.notes
            .trim()
            .slice(0, 1000)
        : "";

    /*
     * Validate submitted contact data.
     */
    if (
      !fullName ||
      fullName.length < 2
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the emergency contact’s full name."
        },
        400
      );
    }

    if (!primaryPhone) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a primary phone number."
        },
        400
      );
    }

    if (
      primaryPhone
        .replace(/\D/g, "")
        .length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid primary phone number."
        },
        400
      );
    }

    if (
      alternatePhone &&
      alternatePhone
        .replace(/\D/g, "")
        .length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid alternate phone number."
        },
        400
      );
    }

    if (
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid email address."
        },
        400
      );
    }

    /*
     * Resolve the household from the
     * authenticated session.
     */
    const sessionHash =
      await sha256Hex(rawSession);

    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id

          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    /*
     * Add the contact only to the household
     * resolved from this customer session.
     */
    const insertResult =
      await env.DB
        .prepare(`
          INSERT INTO emergency_contacts (
            household_id,
            full_name,
            relationship,
            primary_phone,
            alternate_phone,
            email,
            priority,
            authorized_for_medical_decisions,
            authorized_for_pickup,
            notes,
            created_at,
            updated_at
          )
          VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            ?6,
            ?7,
            ?8,
            ?9,
            ?10,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
        `)
        .bind(
          account.household_id,
          fullName,
          relationship || null,
          primaryPhone,
          alternatePhone || null,
          email || null,
          priority,
          authorizedMedical,
          authorizedPickup,
          notes || null
        )
        .run();

    return jsonResponse(
      {
        ok: true,

        contactId:
          insertResult?.meta
            ?.last_row_id || null,

        message:
          "Emergency contact added."
      },
      201
    );

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to add the emergency contact right now."
      },
      500
    );
  }
}
    /*
 * Edit an emergency contact belonging to
 * the authenticated customer's household.
 */
if (
  url.pathname.startsWith(
    "/api/account/emergency-contacts/"
  ) &&
  request.method === "PUT"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Authentication required."
      },
      401
    );
  }

  try {
    const contactIdText =
      url.pathname
        .slice(
          "/api/account/emergency-contacts/"
            .length
        )
        .trim();

    const contactId =
      Number(contactIdText);

    if (
      !Number.isInteger(contactId) ||
      contactId < 1
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Invalid emergency contact."
        },
        400
      );
    }

    const body =
      await request.json();

    const fullName =
      typeof body.fullName === "string"
        ? body.fullName
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 100)
        : "";

    const relationship =
      typeof body.relationship === "string"
        ? body.relationship
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80)
        : "";

    const primaryPhone =
      typeof body.primaryPhone === "string"
        ? body.primaryPhone
            .trim()
            .slice(0, 40)
        : "";

    const alternatePhone =
      typeof body.alternatePhone === "string"
        ? body.alternatePhone
            .trim()
            .slice(0, 40)
        : "";

    const email =
      typeof body.email === "string"
        ? body.email
            .trim()
            .toLowerCase()
            .slice(0, 200)
        : "";

    const priorityNumber =
      Number(body.priority);

    const priority =
      Number.isInteger(
        priorityNumber
      ) &&
      priorityNumber >= 1 &&
      priorityNumber <= 99
        ? priorityNumber
        : 1;

    const authorizedMedical =
      body.authorizedForMedicalDecisions ===
      true
        ? 1
        : 0;

    const authorizedPickup =
      body.authorizedForPickup === true
        ? 1
        : 0;

    const notes =
      typeof body.notes === "string"
        ? body.notes
            .trim()
            .slice(0, 1000)
        : "";

    if (
      !fullName ||
      fullName.length < 2
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter the emergency contact’s full name."
        },
        400
      );
    }

    if (
      !primaryPhone ||
      primaryPhone
        .replace(/\D/g, "")
        .length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid primary phone number."
        },
        400
      );
    }

    if (
      alternatePhone &&
      alternatePhone
        .replace(/\D/g, "")
        .length < 7
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid alternate phone number."
        },
        400
      );
    }

    if (
      email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Enter a valid email address."
        },
        400
      );
    }

    const sessionHash =
      await sha256Hex(rawSession);

    /*
     * Resolve household from session.
     */
    const account =
      await env.DB
        .prepare(`
          SELECT
            ca.household_id

          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at >
              CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!account) {
      return jsonResponse(
        {
          ok: false,
          error:
            "The customer session is invalid or expired."
        },
        401
      );
    }

    /*
     * Ownership check.
     */
    const existingContact =
      await env.DB
        .prepare(`
          SELECT id

          FROM emergency_contacts

          WHERE id = ?1
            AND household_id = ?2

          LIMIT 1
        `)
        .bind(
          contactId,
          account.household_id
        )
        .first();

    if (!existingContact) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Emergency contact not found."
        },
        404
      );
    }

    await env.DB
      .prepare(`
        UPDATE emergency_contacts

        SET
          full_name = ?1,
          relationship = ?2,
          primary_phone = ?3,
          alternate_phone = ?4,
          email = ?5,
          priority = ?6,
          authorized_for_medical_decisions = ?7,
          authorized_for_pickup = ?8,
          notes = ?9,
          updated_at =
            CURRENT_TIMESTAMP

        WHERE id = ?10
          AND household_id = ?11
      `)
      .bind(
        fullName,
        relationship || null,
        primaryPhone,
        alternatePhone || null,
        email || null,
        priority,
        authorizedMedical,
        authorizedPickup,
        notes || null,
        contactId,
        account.household_id
      )
      .run();

    return jsonResponse({
      ok: true,

      contactId,

      message:
        "Emergency contact updated."
    });

  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Unable to update the emergency contact right now."
      },
      500
    );
  }
}
    /*
 * Public customer sign-in and account creation page.
 */
if (
  url.pathname === "/account-access" &&
  request.method === "GET"
) {
  const page = `
    <!doctype html>
    <html lang="en">

      <head>
        <meta charset="utf-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

        <title>
          Sign In | Nyah's Pawsitive Care
        </title>

        <script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          async
          defer
        ></script>

        <style>
          :root {
            color-scheme: dark;

            --bg: #09080d;
            --panel: #15101d;
            --panel-two: #1b1426;

            --purple: #c1a7ff;
            --purple-strong: #8d63ff;

            --text: #f7f2ff;
            --muted: #c5bdd0;

            --border:
              rgba(193, 167, 255, 0.24);
          }

          * {
            box-sizing: border-box;
          }

          body {
            margin: 0;
            min-height: 100vh;
            padding: 38px 18px 70px;

            background:
              radial-gradient(
                circle at top,
                rgba(141, 99, 255, 0.16),
                transparent 37%
              ),
              var(--bg);

            color: var(--text);

            font-family:
              system-ui,
              -apple-system,
              BlinkMacSystemFont,
              "Segoe UI",
              sans-serif;
          }

          main {
            width: min(1000px, 100%);
            margin: 0 auto;
          }

          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 18px;

            margin-bottom: 42px;
          }

          .brand {
            color: var(--purple);

            font-size: 0.82rem;
            font-weight: 900;
            letter-spacing: 0.1em;
            text-transform: uppercase;
          }

          .back-link {
            color: var(--text);
            text-decoration: none;
            font-weight: 800;
          }

          .intro {
            max-width: 680px;
            margin-bottom: 28px;
          }

          .intro h1 {
            margin: 0 0 10px;

            font-size:
              clamp(2.3rem, 7vw, 4rem);
          }

          .intro p {
            margin: 0;
            color: var(--muted);
            line-height: 1.7;
          }

          .account-grid {
            display: grid;

            grid-template-columns:
              repeat(2, minmax(0, 1fr));

            gap: 18px;
          }

          .account-card {
            padding: 25px;

            background:
              linear-gradient(
                145deg,
                var(--panel),
                #0f0c15
              );

            border:
              1px solid var(--border);

            border-radius: 22px;

            box-shadow:
              0 18px 42px
              rgba(0, 0, 0, 0.30);
          }

          .account-card h2 {
            margin: 0 0 7px;
          }

          .card-intro {
            min-height: 52px;

            margin: 0 0 20px;

            color: var(--muted);
            line-height: 1.6;
          }

          label {
            display: block;

            margin: 15px 0 7px;

            color: #eee7f7;

            font-size: 0.86rem;
            font-weight: 800;
          }

          input {
            width: 100%;

            padding: 13px 14px;

            color: var(--text);
            background: #0d0b12;

            border:
              1px solid
              rgba(193, 167, 255, 0.22);

            border-radius: 11px;

            font: inherit;
          }

          input:focus {
            outline: none;

            border-color:
              rgba(193, 167, 255, 0.65);

            box-shadow:
              0 0 0 3px
              rgba(141, 99, 255, 0.10);
          }

          .turnstile-wrap {
            margin: 20px 0;
            min-height: 65px;
          }

          button {
            width: 100%;

            padding: 13px 16px;

            color: white;

            background:
              linear-gradient(
                135deg,
                var(--purple-strong),
                #6e42e8
              );

            border: 0;
            border-radius: 11px;

            font: inherit;
            font-weight: 900;

            cursor: pointer;
          }

          button[disabled] {
            cursor: not-allowed;
            opacity: 0.55;
          }

.signin-message {
  min-height: 24px;
  margin: 14px 0 0;
  color: var(--muted);
  line-height: 1.5;
}

.signin-message.success {
  color: #bfffd1;
}

.signin-message.error {
  color: #ffc1c1;
}
          .security-note {
            margin-top: 22px;

            padding: 14px 16px;

            color: var(--muted);

            background:
              rgba(141, 99, 255, 0.07);

            border-left:
              3px solid
              var(--purple-strong);

            border-radius:
              5px 12px 12px 5px;

            font-size: 0.86rem;
            line-height: 1.55;
          }

          @media (max-width: 760px) {
            body {
              padding:
                24px 13px 50px;
            }

            .topbar {
              align-items: flex-start;
              flex-direction: column;
            }

            .account-grid {
              grid-template-columns: 1fr;
            }

            .card-intro {
              min-height: 0;
            }
          }
        </style>
      </head>

      <body>

        <main>

          <nav class="topbar">

            <span class="brand">
              Nyah's Pawsitive Care
            </span>

            <a
              class="back-link"
              href="/"
            >
              Back to Website
            </a>

          </nav>

          <section class="intro">

            <h1>
              Welcome to Pawsitive Care
            </h1>

            <p>
              Sign in to manage your household and pets,
              or create a new account to get started.
            </p>

          </section>

          <section class="account-grid">

            <article class="account-card">

              <h2>
                Returning Client
              </h2>

              <p class="card-intro">
                We'll email you a secure,
                passwordless sign-in link.
              </p>

              <form id="signin-form">

                <label for="signin-email">
                  Email Address
                </label>

                <input
                  id="signin-email"
                  name="email"
                  type="email"
                  autocomplete="email"
                  required
                >

                <div class="turnstile-wrap">

                 <div
  id="signin-turnstile"
  class="cf-turnstile"
  data-sitekey="0x4AAAAAAGJ2AmD8lBspXWmi"
  data-theme="dark"
  data-callback="signinTurnstilePassed"
  data-expired-callback="signinTurnstileExpired"
  data-error-callback="signinTurnstileExpired"
></div>

                </div>

                <button
  id="signin-submit"
  type="submit"
  disabled
>
  Send Secure Sign-In Link
</button>

<p
  id="signin-message"
  class="signin-message"
  aria-live="polite"
></p>

              </form>

            </article>


            <article class="account-card">

              <h2>
                New Client
              </h2>

              <p class="card-intro">
                Create your household account,
                then add your pets and care information.
              </p>

              <form id="signup-form">

                <label for="signup-name">
                  Full Name
                </label>

                <input
                  id="signup-name"
                  name="fullName"
                  type="text"
                  autocomplete="name"
                  required
                >

                <label for="signup-email">
                  Email Address
                </label>

                <input
                  id="signup-email"
                  name="email"
                  type="email"
                  autocomplete="email"
                  required
                >

                <label for="signup-phone">
                  Phone Number
                </label>

                <input
                  id="signup-phone"
                  name="phone"
                  type="tel"
                  autocomplete="tel"
                  required
                >

                <div class="turnstile-wrap">
<div
  id="signup-turnstile"
  class="cf-turnstile"
  data-sitekey="0x4AAAAAAGJ2AmD8lBspXWmi"
  data-theme="dark"
  data-callback="signupTurnstilePassed"
  data-expired-callback="signupTurnstileExpired"
  data-error-callback="signupTurnstileExpired"
></div>

                </div>

               <button
  id="signup-submit"
  type="submit"
  disabled
>
  Create Account
</button>

<p
  id="signup-message"
  class="signin-message"
  aria-live="polite"
></p>
              </form>

            </article>

          </section>

          <p class="security-note">
            🔒 Nyah's Pawsitive Care uses secure,
            passwordless sign-in. Payment-card information
            is never collected by this page.
          </p>

        </main>

<script>
  let signinTurnstileToken = "";

  function signinTurnstilePassed(token) {
    signinTurnstileToken = token;

    const button =
      document.querySelector(
        "#signin-submit"
      );

    if (button) {
      button.disabled = false;
    }
  }

  function signinTurnstileExpired() {
    signinTurnstileToken = "";

    const button =
      document.querySelector(
        "#signin-submit"
      );

    if (button) {
      button.disabled = true;
    }
  }

  const signinForm =
    document.querySelector(
      "#signin-form"
    );

  const signinMessage =
    document.querySelector(
      "#signin-message"
    );

  signinForm?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      const email =
        document.querySelector(
          "#signin-email"
        )?.value
          .trim()
          .toLowerCase();

      if (
        !email ||
        !signinTurnstileToken
      ) {
        signinMessage.className =
          "signin-message error";

        signinMessage.textContent =
          "Complete the email and security verification first.";

        return;
      }

      const button =
        document.querySelector(
          "#signin-submit"
        );

      if (button) {
        button.disabled = true;

        button.textContent =
          "Sending Secure Link...";
      }

      signinMessage.className =
        "signin-message";

      signinMessage.textContent =
        "Sending your secure sign-in link...";

      try {
        const response =
          await fetch(
            "/api/auth/request-link",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body: JSON.stringify({
                email,
                turnstileToken:
                  signinTurnstileToken
              })
            }
          );

        const result =
          await response.json();

        if (
          !response.ok ||
          !result.ok
        ) {
          throw new Error(
            result.error ||
            "Unable to send the sign-in link."
          );
        }

        signinMessage.className =
          "signin-message success";

        signinMessage.textContent =
          "Check your email for your secure sign-in link.";

        signinTurnstileToken = "";

        if (window.turnstile) {
          window.turnstile.reset(
            "#signin-turnstile"
          );
        }

        if (button) {
          button.textContent =
            "Link Sent";
        }

      } catch (error) {
        signinMessage.className =
          "signin-message error";

        signinMessage.textContent =
          error.message;

        signinTurnstileToken = "";

        if (window.turnstile) {
          window.turnstile.reset(
            "#signin-turnstile"
          );
        }

        if (button) {
          button.disabled = true;

          button.textContent =
            "Send Secure Sign-In Link";
        }
      }
    }
  );
  let signupTurnstileToken = "";

function signupTurnstilePassed(token) {
  signupTurnstileToken = token;

  const button =
    document.querySelector(
      "#signup-submit"
    );

  if (button) {
    button.disabled = false;
  }
}

function signupTurnstileExpired() {
  signupTurnstileToken = "";

  const button =
    document.querySelector(
      "#signup-submit"
    );

  if (button) {
    button.disabled = true;
  }
}

const signupForm =
  document.querySelector(
    "#signup-form"
  );

const signupMessage =
  document.querySelector(
    "#signup-message"
  );

signupForm?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const fullName =
      document.querySelector(
        "#signup-name"
      )?.value.trim();

    const email =
      document.querySelector(
        "#signup-email"
      )?.value
        .trim()
        .toLowerCase();

    const phone =
      document.querySelector(
        "#signup-phone"
      )?.value.trim();

    if (
      !fullName ||
      !email ||
      !phone ||
      !signupTurnstileToken
    ) {
      signupMessage.className =
        "signin-message error";

      signupMessage.textContent =
        "Complete all fields and the security verification first.";

      return;
    }

    const button =
      document.querySelector(
        "#signup-submit"
      );

    if (button) {
      button.disabled = true;

      button.textContent =
        "Creating Account...";
    }

    signupMessage.className =
      "signin-message";

    signupMessage.textContent =
      "Creating your secure household account...";

    try {
      const response =
        await fetch(
          "/api/auth/signup",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              fullName,
              email,
              phone,
              turnstileToken:
                signupTurnstileToken
            })
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.ok
      ) {
        throw new Error(
          result.error ||
          "Unable to create the account."
        );
      }

      signupMessage.className =
        "signin-message success";

      if (result.accountExists) {
        signupMessage.textContent =
          "An account may already exist for this email. Use Returning Client above to sign in.";
      } else {
        signupMessage.textContent =
          "Account created. Check your email to verify your address and sign in.";
      }

      signupTurnstileToken = "";

      if (window.turnstile) {
        window.turnstile.reset(
          "#signup-turnstile"
        );
      }

      if (button) {
        button.textContent =
          result.accountExists
            ? "Use Returning Client"
            : "Account Created";
      }

    } catch (error) {
      signupMessage.className =
        "signin-message error";

      signupMessage.textContent =
        error.message;

      signupTurnstileToken = "";

      if (window.turnstile) {
        window.turnstile.reset(
          "#signup-turnstile"
        );
      }

      if (button) {
        button.disabled = true;

        button.textContent =
          "Create Account";
      }
    }
  }
);
</script>
      </body>

    </html>
  `;

  return new Response(
    page,
    {
      headers: {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
    /*
 * Authenticated customer account dashboard.
 * Read-only household checkpoint.
 */
if (
  url.pathname === "/account" &&
  request.method === "GET"
) {
  const rawSession =
    getCookieValue(
      request,
      "__Host-npc_session"
    );

  if (!rawSession) {
    return Response.redirect(
      "https://nyahspawsitivecare.com/#account-sign-in",
      302
    );
  }

  try {
    const sessionHash =
      await sha256Hex(rawSession);

    const customer =
      await env.DB
        .prepare(`
          SELECT
            ca.id AS account_id,
            ca.account_number,
            ca.household_id,
            ca.email,
            ca.status AS account_status,
            ca.last_login_at,

            h.household_number,
            h.display_name,
            h.status AS household_status,
            h.address_line_1,
            h.address_line_2,
            h.city,
            h.state,
            h.postal_code

          FROM customer_sessions cs

          JOIN customer_accounts ca
            ON ca.id = cs.account_id

          JOIN households h
            ON h.id = ca.household_id

          WHERE cs.session_hash = ?1
            AND cs.revoked_at IS NULL
            AND cs.expires_at > CURRENT_TIMESTAMP
            AND ca.status = 'active'

          LIMIT 1
        `)
        .bind(sessionHash)
        .first();

    if (!customer) {
      return Response.redirect(
        "https://nyahspawsitivecare.com/#account-sign-in",
        302
      );
    }

    const counts =
      await env.DB
        .prepare(`
          SELECT
            (
              SELECT COUNT(*)
              FROM household_members
              WHERE household_id = ?1
                AND status = 'active'
            ) AS member_count,

            (
              SELECT COUNT(*)
              FROM emergency_contacts
              WHERE household_id = ?1
            ) AS emergency_contact_count,

            (
              SELECT COUNT(*)
              FROM pets
              WHERE household_id = ?1
                AND status = 'active'
            ) AS pet_count,

            (
              SELECT COUNT(*)
              FROM vaccinations v
              JOIN pets p
                ON p.id = v.pet_id
              WHERE p.household_id = ?1
            ) AS vaccination_count
        `)
        .bind(customer.household_id)
        .first();

    await env.DB
      .prepare(`
        UPDATE customer_sessions
        SET last_seen_at = CURRENT_TIMESTAMP
        WHERE session_hash = ?1
      `)
      .bind(sessionHash)
      .run();

    const addressParts = [
      customer.address_line_1,
      customer.address_line_2,
      customer.city,
      customer.state,
      customer.postal_code
    ].filter(Boolean);

    const address =
      addressParts.length > 0
        ? addressParts.join(", ")
        : "No household address added yet.";

    const page = `
      <!doctype html>
      <html lang="en">

        <head>
          <meta charset="utf-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <meta
            name="robots"
            content="noindex, nofollow"
          >

          <title>
            My Account | Nyah's Pawsitive Care
          </title>

          <style>
            :root {
              color-scheme: dark;
              --background: #09080d;
              --panel: #15101d;
              --panel-two: #1b1426;
              --purple: #c1a7ff;
              --purple-strong: #8d63ff;
              --text: #f7f2ff;
              --muted: #c4bbd0;
              --border:
                rgba(193, 167, 255, 0.24);
            }

            * {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              min-height: 100vh;
              padding: 38px 18px 70px;
              background:
                radial-gradient(
                  circle at top,
                  rgba(141, 99, 255, 0.14),
                  transparent 36%
                ),
                var(--background);
              color: var(--text);
              font-family:
                system-ui,
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;
            }

            main {
              width: min(1000px, 100%);
              margin: 0 auto;
            }

            .topbar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 18px;
              margin-bottom: 30px;
            }

            .brand {
              color: var(--purple);
              font-size: 0.82rem;
              font-weight: 900;
              letter-spacing: 0.1em;
              text-transform: uppercase;
            }

            .home-link {
              color: var(--text);
              text-decoration: none;
              font-weight: 800;
            }

            .hero {
              padding: 28px;
              background:
                linear-gradient(
                  145deg,
                  var(--panel),
                  #0f0c15
                );
              border: 1px solid var(--border);
              border-radius: 24px;
              box-shadow:
                0 20px 45px rgba(0, 0, 0, 0.30);
            }

            .status {
              display: inline-block;
              padding: 7px 11px;
              color: #eee6ff;
              background:
                rgba(141, 99, 255, 0.18);
              border: 1px solid var(--border);
              border-radius: 999px;
              font-size: 0.74rem;
              font-weight: 900;
              letter-spacing: 0.07em;
              text-transform: uppercase;
            }

            h1 {
              margin: 16px 0 9px;
              font-size:
                clamp(2rem, 6vw, 3.5rem);
            }

            .intro,
            .address,
            .notice {
              color: var(--muted);
              line-height: 1.65;
            }
.details-section {
  margin-top: 20px;
  padding: 23px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 20px;
}

.details-section h2 {
  margin: 0 0 6px;
}

.section-intro {
  margin: 0 0 18px;
  color: var(--muted);
  line-height: 1.6;
}

.card-grid {
  display: grid;
  grid-template-columns:
    repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.detail-card {
  padding: 18px;
  background: var(--panel-two);
  border: 1px solid
    rgba(193, 167, 255, 0.17);
  border-radius: 16px;
}

.detail-card h3 {
  margin: 0 0 6px;
  color: var(--text);
}

.detail-card h4 {
  margin: 18px 0 8px;
  color: var(--purple);
}

.detail-card p {
  margin: 7px 0;
  color: var(--muted);
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.detail-card strong {
  color: var(--text);
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}

.tag {
  display: inline-block;
  padding: 6px 9px;
  color: #eee6ff;
  background:
    rgba(141, 99, 255, 0.13);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.73rem;
  font-weight: 850;
}

.primary-tag {
  color: #ffffff;
  background:
    rgba(141, 99, 255, 0.32);
}

.vaccine-list {
  display: grid;
  gap: 11px;
}

.vaccine-record {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr) auto;
  gap: 15px;
  align-items: start;
  padding: 16px;
  background: var(--panel-two);
  border: 1px solid
    rgba(193, 167, 255, 0.17);
  border-radius: 15px;
}

.vaccine-record h3 {
  margin: 0 0 6px;
}

.vaccine-record p {
  margin: 5px 0;
  color: var(--muted);
  line-height: 1.5;
}

.vaccine-status {
  display: inline-block;
  padding: 7px 10px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 900;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}

.status-current {
  color: #bfffd1;
  background: rgba(42, 175, 84, 0.17);
  border: 1px solid rgba(76, 220, 119, 0.32);
}

.status-expiring {
  color: #ffeaa6;
  background: rgba(223, 168, 28, 0.16);
  border: 1px solid rgba(247, 196, 67, 0.34);
}

.status-expired {
  color: #ffc1c1;
  background: rgba(214, 57, 57, 0.17);
  border: 1px solid rgba(244, 92, 92, 0.35);
}

.status-review {
  color: #e1d2ff;
  background: rgba(141, 99, 255, 0.18);
  border: 1px solid rgba(193, 167, 255, 0.35);
}

.loading-panel,
.empty-panel,
.error-panel {
  padding: 18px;
  color: var(--muted);
  background: var(--panel-two);
  border: 1px solid
    rgba(193, 167, 255, 0.16);
  border-radius: 15px;
}

.error-panel {
  color: #ffc1c1;
  border-color: rgba(244, 92, 92, 0.35);
}

@media (max-width: 700px) {
  .card-grid {
    grid-template-columns: 1fr;
  }

  .vaccine-record {
    grid-template-columns: 1fr;
  }

  .vaccine-status {
    width: fit-content;
  }
}
            .summary-grid {
              display: grid;
              grid-template-columns:
                repeat(4, minmax(0, 1fr));
              gap: 12px;
              margin-top: 22px;
            }

            .summary-card {
              padding: 17px;
              background: var(--panel-two);
              border:
                1px solid rgba(
                  193,
                  167,
                  255,
                  0.16
                );
              border-radius: 16px;
            }

            .summary-card span {
              display: block;
              margin-bottom: 7px;
              color: var(--muted);
              font-size: 0.72rem;
              font-weight: 800;
              letter-spacing: 0.07em;
              text-transform: uppercase;
            }

            .summary-card strong {
              color: var(--purple);
              font-size: 1.8rem;
            }

            .section {
              margin-top: 20px;
              padding: 23px;
              background: var(--panel);
              border: 1px solid var(--border);
              border-radius: 20px;
            }

            .section h2 {
              margin-top: 0;
            }

            .notice {
              padding: 14px 16px;
              background:
                rgba(141, 99, 255, 0.08);
              border-left:
                3px solid var(--purple-strong);
              border-radius: 6px 13px 13px 6px;
            }

            @media (max-width: 700px) {
              body {
                padding:
                  24px 13px 50px;
              }

              .topbar {
                align-items: flex-start;
                flex-direction: column;
              }

              .hero {
                padding: 19px;
              }

              .summary-grid {
                grid-template-columns:
                  1fr 1fr;
              }
            }
            .household-form-grid {
  display: grid;
  grid-template-columns:
    repeat(2, minmax(0, 1fr));
  gap: 13px;
  margin: 20px 0;
}

.household-form-grid label {
  display: block;
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 800;
}

.household-form-grid input {
  width: 100%;
  margin-top: 7px;
  padding: 12px 13px;

  color: var(--text);
  background: #0d0b12;

  border:
    1px solid
    rgba(193, 167, 255, 0.22);

  border-radius: 11px;

  font: inherit;
}

.household-form-grid input:focus {
  outline: none;

  border-color:
    rgba(193, 167, 255, 0.65);

  box-shadow:
    0 0 0 3px
    rgba(141, 99, 255, 0.10);
}

.portal-button {
  padding: 12px 17px;

  color: white;
  background:
    linear-gradient(
      135deg,
      var(--purple-strong),
      #6e42e8
    );

  border: 0;
  border-radius: 11px;

  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.portal-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.portal-message {
  min-height: 24px;
  margin: 13px 0 0;
  color: var(--muted);
}

.portal-message.success {
  color: #bfffd1;
}

.portal-message.error {
  color: #ffc1c1;
}
.portal-editor {
  margin: 18px 0;
  padding: 16px;

  background:
    rgba(141, 99, 255, 0.06);

  border:
    1px solid
    rgba(193, 167, 255, 0.20);

  border-radius: 16px;
}

.portal-editor summary {
  color: var(--purple);
  font-weight: 900;
  cursor: pointer;
}

.portal-editor[open] summary {
  margin-bottom: 18px;
}

.parent-form-grid {
  display: grid;

  grid-template-columns:
    repeat(2, minmax(0, 1fr));

  gap: 13px;
}

.parent-form-grid label {
  display: block;

  color: var(--muted);

  font-size: 0.82rem;
  font-weight: 800;
}

.parent-form-grid input {
  width: 100%;
  margin-top: 7px;
  padding: 12px 13px;

  color: var(--text);
  background: #0d0b12;

  border:
    1px solid
    rgba(193, 167, 255, 0.22);

  border-radius: 11px;

  font: inherit;
}

.parent-form-grid input:focus {
  outline: none;

  border-color:
    rgba(193, 167, 255, 0.65);

  box-shadow:
    0 0 0 3px
    rgba(141, 99, 255, 0.10);
}

.parent-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;

  margin: 18px 0;
}

.checkbox-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  padding: 9px 11px;

  color: var(--muted);
  background: var(--panel-two);

  border:
    1px solid
    rgba(193, 167, 255, 0.16);

  border-radius: 11px;

  font-size: 0.83rem;
  font-weight: 800;
}

.checkbox-option input {
  width: auto;
  margin: 0;
  accent-color: var(--purple-strong);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 16px;
}

.secondary-button {
  padding: 9px 13px;

  color: var(--purple);

  background:
    rgba(141, 99, 255, 0.08);

  border:
    1px solid var(--border);

  border-radius: 10px;

  font: inherit;
  font-size: 0.82rem;
  font-weight: 900;

  cursor: pointer;
}

.secondary-button:hover {
  background:
    rgba(141, 99, 255, 0.15);
}
.danger-button {
  padding: 9px 13px;

  color: #ffc1c1;

  background:
    rgba(214, 57, 57, 0.10);

  border:
    1px solid
    rgba(244, 92, 92, 0.35);

  border-radius: 10px;

  font: inherit;
  font-size: 0.82rem;
  font-weight: 900;

  cursor: pointer;
}

.danger-button:hover {
  background:
    rgba(214, 57, 57, 0.18);
}

.danger-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.parent-edit-form {
  display: grid;
  gap: 11px;

  margin-top: 16px;
  padding-top: 16px;

  border-top:
    1px solid
    rgba(193, 167, 255, 0.16);
}

.parent-edit-form[hidden] {
  display: none;
}

.parent-edit-form label {
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 800;
}

.parent-edit-form input[type="text"],
.parent-edit-form input[type="email"],
.parent-edit-form input[type="tel"] {
  width: 100%;
  margin-top: 6px;
  padding: 10px 11px;

  color: var(--text);
  background: #0d0b12;

  border:
    1px solid
    rgba(193, 167, 255, 0.22);

  border-radius: 10px;

  font: inherit;
}
@media (max-width: 700px) {
  .parent-form-grid {
    grid-template-columns: 1fr;
  }

  .parent-options {
    flex-direction: column;
  }
}
@media (max-width: 700px) {
  .household-form-grid {
    grid-template-columns: 1fr;
  }
}
.emergency-notes-label {
  display: block;
  margin: 18px 0;

  color: var(--muted);

  font-size: 0.82rem;
  font-weight: 800;
}

.emergency-notes-label textarea {
  width: 100%;
  margin-top: 7px;
  padding: 12px 13px;

  min-height: 110px;
  resize: vertical;

  color: var(--text);
  background: #0d0b12;

  border:
    1px solid
    rgba(193, 167, 255, 0.22);

  border-radius: 11px;

  font: inherit;
  line-height: 1.5;
}

.emergency-notes-label textarea:focus {
  outline: none;

  border-color:
    rgba(193, 167, 255, 0.65);

  box-shadow:
    0 0 0 3px
    rgba(141, 99, 255, 0.10);
}
            @media (max-width: 430px) {
              .summary-grid {
                grid-template-columns: 1fr;
              }
            }
          </style>
        </head>

        <body>

          <main>

            <nav class="topbar">
              <span class="brand">
                Nyah's Pawsitive Care
              </span>

              <a
                class="home-link"
                href="/"
              >
                Back to Website
              </a>
            </nav>

            <section class="hero">

              <span class="status">
                ${escapeHtml(
                  customer.household_status
                )}
              </span>

              <h1>
                ${escapeHtml(
                  customer.display_name ||
                  "My Household"
                )}
              </h1>

              <p class="intro">
                Secure customer account for
                ${escapeHtml(customer.email)}.
              </p>

              <p class="address">
                ${escapeHtml(address)}
              </p>

              <div class="summary-grid">

                <div class="summary-card">
                  <span>Pet Parents</span>
                  <strong>
                    ${Number(
                      counts?.member_count || 0
                    )}
                  </strong>
                </div>

                <div class="summary-card">
                  <span>Emergency Contacts</span>
                  <strong>
                    ${Number(
                      counts
                        ?.emergency_contact_count ||
                      0
                    )}
                  </strong>
                </div>

                <div class="summary-card">
                  <span>Pets</span>
                  <strong>
                    ${Number(
                      counts?.pet_count || 0
                    )}
                  </strong>
                </div>

                <div class="summary-card">
                  <span>Vaccination Records</span>
                  <strong>
                    ${Number(
                      counts
                        ?.vaccination_count ||
                      0
                    )}
                  </strong>
                </div>

              </div>

            </section>

            <section class="section">
              <h2>My Household</h2>

              <p>
                Household number:
                <strong>
                  ${escapeHtml(
                    customer.household_number
                  )}
                </strong>
              </p>
<form id="household-form">

  <div class="household-form-grid">

    <label>
      Household Name
      <input
        id="household-display-name"
        type="text"
        maxlength="120"
        required
      >
    </label>

    <label>
      Street Address
      <input
        id="household-address-1"
        type="text"
        maxlength="150"
        autocomplete="street-address"
      >
    </label>

    <label>
      Address Line 2
      <input
        id="household-address-2"
        type="text"
        maxlength="150"
      >
    </label>

    <label>
      City
      <input
        id="household-city"
        type="text"
        maxlength="100"
        autocomplete="address-level2"
      >
    </label>

    <label>
      State
      <input
        id="household-state"
        type="text"
        maxlength="2"
        autocomplete="address-level1"
        placeholder="FL"
      >
    </label>

    <label>
      ZIP Code
      <input
        id="household-zip"
        type="text"
        maxlength="10"
        autocomplete="postal-code"
      >
    </label>

  </div>

  <button
    id="household-save"
    type="submit"
    class="portal-button"
  >
    Save Household Information
  </button>

  <p
    id="household-message"
    class="portal-message"
    aria-live="polite"
  ></p>

</form>
              <p class="notice">
                This first portal version is read-only.
                Profile editing, pets, emergency contacts,
                veterinarians, vaccinations, and documents
                will be added after household isolation is
                verified.
              </p>
            </section>
<section class="details-section">
  <h2>Pet Parents</h2>

  <p class="section-intro">
    Household members authorized to manage care
    and receive updates.
  </p>
<details class="portal-editor">

  <summary>
    + Add Pet Parent
  </summary>

  <form id="parent-add-form">

    <div class="parent-form-grid">

      <label>
        Full Name
        <input
          id="parent-full-name"
          type="text"
          maxlength="100"
          autocomplete="name"
          required
        >
      </label>

      <label>
        Email Address
        <input
          id="parent-email"
          type="email"
          maxlength="200"
          autocomplete="email"
        >
      </label>

      <label>
        Phone Number
        <input
          id="parent-phone"
          type="tel"
          maxlength="40"
          autocomplete="tel"
        >
      </label>

      <label>
        Role
        <input
          id="parent-role"
          type="text"
          maxlength="80"
          value="Pet Parent"
          required
        >
      </label>

    </div>

    <div class="parent-options">

      <label class="checkbox-option">
        <input
          id="parent-primary"
          type="checkbox"
        >
        Make primary contact
      </label>

      <label class="checkbox-option">
        <input
          id="parent-can-request"
          type="checkbox"
          checked
        >
        Can request care
      </label>

      <label class="checkbox-option">
        <input
          id="parent-receives-updates"
          type="checkbox"
          checked
        >
        Receives booking updates
      </label>

    </div>

    <button
      id="parent-add-submit"
      type="submit"
      class="portal-button"
    >
      Add Pet Parent
    </button>

    <p
      id="parent-add-message"
      class="portal-message"
      aria-live="polite"
    ></p>

  </form>

</details>
  <div
    id="parent-list"
    class="card-grid"
  >
    <div class="loading-panel">
      Loading pet parents...
    </div>
  </div>
</section>

<section class="details-section">
  <h2>Emergency Contacts</h2>

  <p class="section-intro">
    Contacts listed in priority order for
    emergencies and authorized pickup.
  </p>
<details class="portal-editor">

  <summary>
    + Add Emergency Contact
  </summary>

  <form id="emergency-add-form">

    <div class="parent-form-grid">

      <label>
        Full Name
        <input
          id="emergency-full-name"
          type="text"
          maxlength="100"
          autocomplete="name"
          required
        >
      </label>

      <label>
        Relationship
        <input
          id="emergency-relationship"
          type="text"
          maxlength="80"
          placeholder="Friend, Neighbor, Family Member"
        >
      </label>

      <label>
        Primary Phone
        <input
          id="emergency-primary-phone"
          type="tel"
          maxlength="40"
          autocomplete="tel"
          required
        >
      </label>

      <label>
        Alternate Phone
        <input
          id="emergency-alternate-phone"
          type="tel"
          maxlength="40"
        >
      </label>

      <label>
        Email Address
        <input
          id="emergency-email"
          type="email"
          maxlength="200"
          autocomplete="email"
        >
      </label>

      <label>
        Priority
        <input
          id="emergency-priority"
          type="number"
          min="1"
          max="99"
          value="1"
          required
        >
      </label>

    </div>

    <div class="parent-options">

      <label class="checkbox-option">
        <input
          id="emergency-medical"
          type="checkbox"
        >
        Authorized for medical decisions
      </label>

      <label class="checkbox-option">
        <input
          id="emergency-pickup"
          type="checkbox"
        >
        Authorized for pickup
      </label>

    </div>

    <label class="emergency-notes-label">
      Notes

      <textarea
        id="emergency-notes"
        maxlength="1000"
        rows="4"
        placeholder="Anything Nyah should know about this contact"
      ></textarea>
    </label>

    <button
      id="emergency-add-submit"
      type="submit"
      class="portal-button"
    >
      Add Emergency Contact
    </button>

    <p
      id="emergency-add-message"
      class="portal-message"
      aria-live="polite"
    ></p>

  </form>

</details>
 
  <div
    id="emergency-list"
    class="card-grid"
  >
    <div class="loading-panel">
      Loading emergency contacts...
    </div>
  </div>
</section>

<section class="details-section">
  <h2>My Pets</h2>

  <p class="section-intro">
    Saved profiles, routines, care information,
    and compatibility status.
  </p>

  <div
    id="pet-list"
    class="card-grid"
  >
    <div class="loading-panel">
      Loading pets...
    </div>
  </div>
</section>

<section class="details-section">
  <h2>Veterinary Care</h2>

  <p class="section-intro">
    Veterinary clinics connected to each pet.
  </p>

  <div
    id="vet-list"
    class="card-grid"
  >
    <div class="loading-panel">
      Loading veterinary information...
    </div>
  </div>
</section>

<section class="details-section">
  <h2>Vaccination Records</h2>

  <p class="section-intro">
    Vaccine status is calculated from the saved
    expiration date. Records without an expiration
    date require review.
  </p>

  <div
    id="vaccine-list"
    class="vaccine-list"
  >
    <div class="loading-panel">
      Loading vaccination records...
    </div>
  </div>
</section>
          </main>
<script>
  const portalText = (value, fallback = "Not provided") => {
    if (
      value === null ||
      value === undefined ||
      String(value).trim() === ""
    ) {
      return fallback;
    }

    return String(value);
  };

  const yesNo = (value) =>
    Number(value) === 1 ? "Yes" : "No";

  const titleWords = (value) =>
    portalText(value)
      .replaceAll("_", " ")
      .replace(
        /\b\w/g,
        (letter) => letter.toUpperCase()
      );

  const formatPortalDate = (value) => {
    if (!value) {
      return "Not provided";
    }

    const date =
      new Date(value + "T00:00:00");

    if (Number.isNaN(date.getTime())) {
      return portalText(value);
    }

    return date.toLocaleDateString(
      "en-US",
      {
        month: "short",
        day: "numeric",
        year: "numeric"
      }
    );
  };

  function element(
    tagName,
    className,
    text
  ) {
    const node =
      document.createElement(tagName);

    if (className) {
      node.className = className;
    }

    if (
      text !== undefined &&
      text !== null
    ) {
      node.textContent =
        String(text);
    }

    return node;
  }

  function informationLine(
    label,
    value
  ) {
    const paragraph =
      element("p");

    const strong =
      element(
        "strong",
        "",
        label + ": "
      );

    paragraph.append(strong);

    paragraph.append(
      document.createTextNode(
        portalText(value)
      )
    );

    return paragraph;
  }

  function addTag(
    container,
    text,
    isPrimary = false
  ) {
    container.append(
      element(
        "span",
        isPrimary
          ? "tag primary-tag"
          : "tag",
        text
      )
    );
  }

  function showEmpty(
    container,
    message
  ) {
    container.replaceChildren(
      element(
        "div",
        "empty-panel",
        message
      )
    );
  }

function renderParents(parents) {
  const container =
    document.querySelector(
      "#parent-list"
    );

  if (!parents.length) {
    showEmpty(
      container,
      "No pet parents have been added."
    );

    return;
  }

  const cards =
    parents.map((parent) => {
      const card =
        element(
          "article",
          "detail-card"
        );

      card.append(
        element(
          "h3",
          "",
          portalText(parent.full_name)
        ),

        informationLine(
          "Role",
          parent.role
        ),

        informationLine(
          "Email",
          parent.email
        ),

        informationLine(
          "Phone",
          parent.phone
        )
      );

      const tags =
        element(
          "div",
          "tag-row"
        );

      if (
        Number(
          parent.is_primary_contact
        ) === 1
      ) {
        addTag(
          tags,
          "Primary Contact",
          true
        );
      }

      addTag(
        tags,
        "Can Request Care: " +
          yesNo(
            parent.can_request_care
          )
      );

      addTag(
        tags,
        "Receives Updates: " +
          yesNo(
            parent.receives_updates
          )
      );

      card.append(tags);

      const actions =
        element(
          "div",
          "card-actions"
        );

      const editButton =
        element(
          "button",
          "secondary-button",
          "Edit"
        );

      editButton.type =
        "button";

      actions.append(editButton);

      card.append(actions);

      const editForm =
        element(
          "form",
          "parent-edit-form"      
        );

      editForm.hidden = true;

      const createTextField = (
        labelText,
        type,
        value
      ) => {
        const label =
          element("label");

        label.append(
          document.createTextNode(
            labelText
          )
        );

        const input =
          document.createElement(
            "input"
          );

        input.type = type;
        input.value =
          value || "";

        label.append(input);

        return {
          label,
          input
        };
      };

      const nameField =
        createTextField(
          "Full Name",
          "text",
          parent.full_name
        );

      const emailField =
        createTextField(
          "Email",
          "email",
          parent.email
        );

      const phoneField =
        createTextField(
          "Phone",
          "tel",
          parent.phone
        );

      const roleField =
        createTextField(
          "Role",
          "text",
          parent.role
        );

      editForm.append(
        nameField.label,
        emailField.label,
        phoneField.label,
        roleField.label
      );

      const options =
        element(
          "div",
          "parent-options"
        );

      const createCheckbox = (
        text,
        checked
      ) => {
        const label =
          element(
            "label",
            "checkbox-option"
          );

        const input =
          document.createElement(
            "input"
          );

        input.type =
          "checkbox";

        input.checked =
          checked;

        label.append(
          input,
          document.createTextNode(
            text
          )
        );

        return {
          label,
          input
        };
      };

      const primaryField =
        createCheckbox(
          "Primary Contact",
          Number(
            parent.is_primary_contact
          ) === 1
        );

      const requestField =
        createCheckbox(
          "Can Request Care",
          Number(
            parent.can_request_care
          ) === 1
        );

      const updatesField =
        createCheckbox(
          "Receives Updates",
          Number(
            parent.receives_updates
          ) === 1
        );

      options.append(
        primaryField.label,
        requestField.label,
        updatesField.label
      );

      editForm.append(options);

      const saveButton =
        element(
          "button",
          "portal-button",
          "Save Changes"
        );

      saveButton.type =
        "submit";

      const editMessage =
        element(
          "p",
          "portal-message"
        );

      editMessage.setAttribute(
        "aria-live",
        "polite"
      );

      editForm.append(
        saveButton,
        editMessage
      );
const removeButton =
  element(
    "button",
    "danger-button",
    "Remove from Household"
  );

removeButton.type =
  "button";

editForm.append(
  removeButton
);
removeButton.addEventListener(
  "click",
  async () => {
    const confirmed =
      window.confirm(
        "Remove this person from the active household? Their historical record will be kept."
      );

    if (!confirmed) {
      return;
    }

    removeButton.disabled =
      true;

    removeButton.textContent =
      "Removing...";

    editMessage.className =
      "portal-message";

    editMessage.textContent =
      "Removing pet parent...";

    try {
      const response =
        await fetch(
          "/api/account/parents/" +
            encodeURIComponent(
              parent.id
            ),
          {
            method: "DELETE",

            credentials:
              "same-origin"
          }
        );

      const responseText =
        await response.text();

      let result = null;

      try {
        result =
          responseText
            ? JSON.parse(responseText)
            : null;
      } catch {
        result = null;
      }

      if (!result) {
        throw new Error(
          "Invalid server response. HTTP " +
            response.status
        );
      }

      if (
        !response.ok ||
        !result.ok
      ) {
        throw new Error(
          result.error ||
          "Unable to remove the pet parent."
        );
      }

      editMessage.className =
        "portal-message success";

      editMessage.textContent =
        "Pet parent removed from the active household.";

      await loadAccountDetails();

      window.setTimeout(
        () => {
          window.location.reload();
        },
        700
      );

    } catch (error) {
      editMessage.className =
        "portal-message error";

      editMessage.textContent =
        error.message;

      removeButton.disabled =
        false;

      removeButton.textContent =
        "Remove from Household";
    }
  }
);
      editButton.addEventListener(
        "click",
        () => {
          editForm.hidden =
            !editForm.hidden;

          editButton.textContent =
            editForm.hidden
              ? "Edit"
              : "Cancel";
        }
      );

      editForm.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const payload = {
            fullName:
              nameField.input
                .value.trim(),

            email:
              emailField.input
                .value
                .trim()
                .toLowerCase(),

            phone:
              phoneField.input
                .value.trim(),

            role:
              roleField.input
                .value.trim(),

            isPrimaryContact:
              primaryField.input
                .checked,

            canRequestCare:
              requestField.input
                .checked,

            receivesUpdates:
              updatesField.input
                .checked
          };

          if (
            !payload.fullName ||
            !payload.role
          ) {
            editMessage.className =
              "portal-message error";

            editMessage.textContent =
              "Enter the person’s full name and role.";

            return;
          }

          saveButton.disabled =
            true;

          saveButton.textContent =
            "Saving...";

          editMessage.className =
            "portal-message";

          editMessage.textContent =
            "Saving changes...";

          try {
            const response =
              await fetch(
                "/api/account/parents/" +
                  encodeURIComponent(
                    parent.id
                  ),
                {
                  method:
                    "PUT",

                  headers: {
                    "Content-Type":
                      "application/json"
                  },

                  credentials:
                    "same-origin",

                  body:
                    JSON.stringify(
                      payload
                    )
                }
              );

            const result =
              await response.json();

            if (
              !response.ok ||
              !result.ok
            ) {
              throw new Error(
                result.error ||
                "Unable to update the pet parent."
              );
            }

            editMessage.className =
              "portal-message success";

            editMessage.textContent =
              "Pet parent updated.";

            await loadAccountDetails();

            window.setTimeout(
              () => {
                window.location.reload();
              },
              700
            );

          } catch (error) {
            editMessage.className =
              "portal-message error";

            editMessage.textContent =
              error.message;

            saveButton.disabled =
              false;

            saveButton.textContent =
              "Save Changes";
          }
        }
      );

      card.append(
        editForm
      );

      return card;
    });

  container.replaceChildren(
    ...cards
  );
}

function renderEmergencyContacts(
  contacts
) {
  const container =
    document.querySelector(
      "#emergency-list"
    );

  if (!contacts.length) {
    showEmpty(
      container,
      "No emergency contacts have been added."
    );

    return;
  }

  const cards =
    contacts.map((contact) => {
      const card =
        element(
          "article",
          "detail-card"
        );

      card.append(
        element(
          "h3",
          "",
          portalText(
            contact.full_name
          )
        ),

        informationLine(
          "Relationship",
          contact.relationship
        ),

        informationLine(
          "Priority",
          contact.priority
        ),

        informationLine(
          "Primary Phone",
          contact.primary_phone
        ),

        informationLine(
          "Alternate Phone",
          contact.alternate_phone
        ),

        informationLine(
          "Email",
          contact.email
        ),

        informationLine(
          "Notes",
          contact.notes
        )
      );

      const tags =
        element(
          "div",
          "tag-row"
        );

      addTag(
        tags,
        "Medical Decisions: " +
          yesNo(
            contact
              .authorized_for_medical_decisions
          )
      );

      addTag(
        tags,
        "Authorized Pickup: " +
          yesNo(
            contact
              .authorized_for_pickup
          )
      );

     card.append(tags);

const actions =
  element(
    "div",
    "card-actions"
  );

const editButton =
  element(
    "button",
    "secondary-button",
    "Edit"
  );

editButton.type =
  "button";

actions.append(
  editButton
);

card.append(
  actions
);

 function renderPets(pets) {
    const container =
      document.querySelector(
        "#pet-list"
      );

    if (!pets.length) {
      showEmpty(
        container,
        "No pets have been added."
      );
      return;
    }

    const cards =
      pets.map((pet) => {
        const card =
          element(
            "article",
            "detail-card"
          );

        card.append(
          element(
            "h3",
            "",
            portalText(pet.name)
          ),

          informationLine(
            "Species",
            titleWords(pet.species)
          ),

          informationLine(
            "Breed",
            pet.breed
          ),

          informationLine(
            "Color / Markings",
            pet.color_markings
          ),

          informationLine(
            "Date of Birth",
            formatPortalDate(
              pet.date_of_birth
            )
          ),

          informationLine(
            "Sex",
            titleWords(pet.sex)
          ),

          informationLine(
            "Spayed / Neutered",
            yesNo(
              pet.spayed_neutered
            )
          ),

          informationLine(
            "Weight",
            pet.weight_lbs
              ? pet.weight_lbs + " lb"
              : null
          )
        );

        card.append(
          element(
            "h4",
            "",
            "Care & Routine"
          ),

          informationLine(
            "Feeding",
            pet.feeding_notes
          ),

          informationLine(
            "Medications",
            pet.medication_notes
          ),

          informationLine(
            "Medical Notes",
            pet.medical_notes
          ),

          informationLine(
            "Allergies",
            pet.allergy_notes
          ),

          informationLine(
            "Behavior",
            pet.behavior_notes
          ),

          informationLine(
            "Routine",
            pet.routine_notes
          )
        );

        card.append(
          element(
            "h4",
            "",
            "Compatibility"
          )
        );

        const tags =
          element("div", "tag-row");

        addTag(
          tags,
          "Dogs: " +
            titleWords(
              pet.dog_friendly
            )
        );

        addTag(
          tags,
          "Cats: " +
            titleWords(
              pet.cat_friendly
            )
        );

        addTag(
          tags,
          "Children: " +
            titleWords(
              pet.child_friendly
            )
        );

        addTag(
          tags,
          "House Trained: " +
            yesNo(
              pet.house_trained
            )
        );

        addTag(
          tags,
          "Crate Trained: " +
            yesNo(
              pet.crate_trained
            )
        );

        addTag(
          tags,
          "Meet & Greet: " +
            titleWords(
              pet.meet_greet_status
            ),
          true
        );

        addTag(
          tags,
          "Compatibility: " +
            titleWords(
              pet.compatibility_status
            )
        );

        addTag(
          tags,
          "Approval: " +
            titleWords(
              pet.approval_status
            ),
          true
        );

        card.append(tags);

        return card;
      });

    container.replaceChildren(
      ...cards
    );
  }

  function renderVets(
    relationships
  ) {
    const container =
      document.querySelector(
        "#vet-list"
      );

    if (!relationships.length) {
      showEmpty(
        container,
        "No veterinary clinics have been linked."
      );
      return;
    }

    const cards =
      relationships.map((vet) => {
        const card =
          element(
            "article",
            "detail-card"
          );

        card.append(
          element(
            "h3",
            "",
            portalText(vet.pet_name) +
              " — " +
              portalText(vet.clinic_name)
          )
        );

        const address = [
          vet.address_line_1,
          vet.address_line_2,
          vet.city,
          vet.state,
          vet.postal_code
        ]
          .filter(Boolean)
          .join(", ");

        card.append(
          informationLine(
            "Veterinarian",
            vet.veterinarian_name
          ),

          informationLine(
            "Relationship",
            titleWords(
              vet.relationship_type
            )
          ),

          informationLine(
            "Phone",
            vet.phone
          ),

          informationLine(
            "Emergency Phone",
            vet.emergency_phone
          ),

          informationLine(
            "Email",
            vet.email
          ),

          informationLine(
            "Address",
            address
          ),

          informationLine(
            "Permission to Contact",
            yesNo(
              vet.permission_to_contact
            )
          )
        );

        const tags =
          element("div", "tag-row");

        if (
          Number(vet.is_primary) === 1
        ) {
          addTag(
            tags,
            "Primary Clinic",
            true
          );
        }

        addTag(
          tags,
          titleWords(vet.clinic_type)
        );

        card.append(tags);

        return card;
      });

    container.replaceChildren(
      ...cards
    );
  }

  const vaccineStatusDetails = {
    current: {
      label: "Current",
      className:
        "vaccine-status status-current"
    },

    expiring_soon: {
      label: "Expiring Soon",
      className:
        "vaccine-status status-expiring"
    },

    expired: {
      label: "Expired",
      className:
        "vaccine-status status-expired"
    },

    needs_review: {
      label: "Needs Review",
      className:
        "vaccine-status status-review"
    }
  };

  function renderVaccinations(
    records
  ) {
    const container =
      document.querySelector(
        "#vaccine-list"
      );

    if (!records.length) {
      showEmpty(
        container,
        "No vaccination records have been added."
      );
      return;
    }

    const cards =
      records.map((record) => {
        const card =
          element(
            "article",
            "vaccine-record"
          );

        const content =
          element("div");

        content.append(
          element(
            "h3",
            "",
            portalText(record.pet_name) +
              " — " +
              portalText(
                record.vaccine_name
              )
          ),

          informationLine(
            "Administered",
            formatPortalDate(
              record.administered_date
            )
          ),

          informationLine(
            "Expires",
            record.expiration_date
              ? formatPortalDate(
                  record.expiration_date
                )
              : "Not entered"
          ),

          informationLine(
            "Clinic",
            record.clinic_name
          ),

          informationLine(
            "Veterinarian",
            record.veterinarian_name
          ),

          informationLine(
            "Verification",
            titleWords(
              record.verification_status
            )
          ),

          informationLine(
            "Notes",
            record.notes
          )
        );

        const status =
          vaccineStatusDetails[
            record.display_status
          ] ||
          vaccineStatusDetails
            .needs_review;

        card.append(
          content,
          element(
            "span",
            status.className,
            status.label
          )
        );

        return card;
      });

    container.replaceChildren(
      ...cards
    );
  }

  async function loadAccountDetails() {
    try {
      const response =
        await fetch(
          "/api/account-data",
          {
            credentials:
              "same-origin",

            headers: {
              "Accept":
                "application/json"
            }
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.ok
      ) {
        throw new Error(
          data.error ||
          "Unable to load account details."
        );
      }
const household =
  data.household || {};

const householdDisplayName =
  document.querySelector(
    "#household-display-name"
  );

const householdAddress1 =
  document.querySelector(
    "#household-address-1"
  );

const householdAddress2 =
  document.querySelector(
    "#household-address-2"
  );

const householdCity =
  document.querySelector(
    "#household-city"
  );

const householdState =
  document.querySelector(
    "#household-state"
  );

const householdZip =
  document.querySelector(
    "#household-zip"
  );

if (householdDisplayName) {
  householdDisplayName.value =
    household.displayName || "";
}

if (householdAddress1) {
  householdAddress1.value =
    household.addressLine1 || "";
}

if (householdAddress2) {
  householdAddress2.value =
    household.addressLine2 || "";
}

if (householdCity) {
  householdCity.value =
    household.city || "";
}

if (householdState) {
  householdState.value =
    household.state || "";
}

if (householdZip) {
  householdZip.value =
    household.postalCode || "";
}
      renderParents(
        data.parents || []
      );

      renderEmergencyContacts(
        data.emergencyContacts || []
      );

      renderPets(
        data.pets || []
      );

      renderVets(
        data.veterinaryRelationships ||
        []
      );

      renderVaccinations(
        data.vaccinations || []
      );

    } catch (error) {
      const ids = [
        "#parent-list",
        "#emergency-list",
        "#pet-list",
        "#vet-list",
        "#vaccine-list"
      ];

      for (const id of ids) {
        const container =
          document.querySelector(id);

        if (container) {
          container.replaceChildren(
            element(
              "div",
              "error-panel",
              "Unable to load this information right now."
            )
          );
        }
      }
    }
  }

  loadAccountDetails();
  const householdForm =
  document.querySelector(
    "#household-form"
  );

const householdMessage =
  document.querySelector(
    "#household-message"
  );

householdForm?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const saveButton =
      document.querySelector(
        "#household-save"
      );

    const payload = {
      displayName:
        document.querySelector(
          "#household-display-name"
        )?.value.trim() || "",

      addressLine1:
        document.querySelector(
          "#household-address-1"
        )?.value.trim() || "",

      addressLine2:
        document.querySelector(
          "#household-address-2"
        )?.value.trim() || "",

      city:
        document.querySelector(
          "#household-city"
        )?.value.trim() || "",

      state:
        document.querySelector(
          "#household-state"
        )?.value
          .trim()
          .toUpperCase() || "",

      postalCode:
        document.querySelector(
          "#household-zip"
        )?.value.trim() || ""
    };

    if (!payload.displayName) {
      householdMessage.className =
        "portal-message error";

      householdMessage.textContent =
        "Enter a household name.";

      return;
    }

    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent =
        "Saving...";
    }

    householdMessage.className =
      "portal-message";

    householdMessage.textContent =
      "Saving household information...";

    try {
      const response =
        await fetch(
          "/api/account/household",
          {
            method: "PUT",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body:
              JSON.stringify(payload)
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.ok
      ) {
        throw new Error(
          result.error ||
          "Unable to save household information."
        );
      }

      householdMessage.className =
        "portal-message success";

      householdMessage.textContent =
        "Household information saved.";

    } catch (error) {
      householdMessage.className =
        "portal-message error";

      householdMessage.textContent =
        error.message;

    } finally {
      if (saveButton) {
        saveButton.disabled = false;

        saveButton.textContent =
          "Save Household Information";
      }
    }
  }
);

const parentAddForm =
  document.querySelector(
    "#parent-add-form"
  );

const parentAddMessage =
  document.querySelector(
    "#parent-add-message"
  );

parentAddForm?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const fullName =
      document.querySelector(
        "#parent-full-name"
      )?.value.trim() || "";

    const email =
      document.querySelector(
        "#parent-email"
      )?.value
        .trim()
        .toLowerCase() || "";

    const phone =
      document.querySelector(
        "#parent-phone"
      )?.value.trim() || "";

    const role =
      document.querySelector(
        "#parent-role"
      )?.value.trim() || "";

    const isPrimaryContact =
      document.querySelector(
        "#parent-primary"
      )?.checked === true;

    const canRequestCare =
      document.querySelector(
        "#parent-can-request"
      )?.checked === true;

    const receivesUpdates =
      document.querySelector(
        "#parent-receives-updates"
      )?.checked === true;

    if (!fullName || !role) {
      parentAddMessage.className =
        "portal-message error";

      parentAddMessage.textContent =
        "Enter the person’s full name and role.";

      return;
    }

    const button =
      document.querySelector(
        "#parent-add-submit"
      );

    if (button) {
      button.disabled = true;
      button.textContent =
        "Adding Pet Parent...";
    }

    parentAddMessage.className =
      "portal-message";

    parentAddMessage.textContent =
      "Saving the new pet parent...";

    try {
      const response =
        await fetch(
          "/api/account/parents",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body: JSON.stringify({
              fullName,
              email,
              phone,
              role,
              isPrimaryContact,
              canRequestCare,
              receivesUpdates
            })
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.ok
      ) {
        throw new Error(
          result.error ||
          "Unable to add the pet parent."
        );
      }

      parentAddMessage.className =
        "portal-message success";

      parentAddMessage.textContent =
        result.isPrimaryContact
          ? "Pet parent added as the primary contact."
          : "Pet parent added.";

      parentAddForm.reset();

      const roleField =
        document.querySelector(
          "#parent-role"
        );

      if (roleField) {
        roleField.value =
          "Pet Parent";
      }

      const canRequestField =
        document.querySelector(
          "#parent-can-request"
        );

      const receivesUpdatesField =
        document.querySelector(
          "#parent-receives-updates"
        );

      if (canRequestField) {
        canRequestField.checked = true;
      }

      if (receivesUpdatesField) {
        receivesUpdatesField.checked =
          true;
      }

      /*
       * Refresh the authenticated household
       * lists, including Pet Parents.
       */
      await loadAccountDetails();

      /*
       * Reload shortly afterward so the
       * server-rendered summary count also updates.
       */
      window.setTimeout(
        () => {
          window.location.reload();
        },
        900
      );

    } catch (error) {
      parentAddMessage.className =
        "portal-message error";

      parentAddMessage.textContent =
        error.message;

      if (button) {
        button.disabled = false;

        button.textContent =
          "Add Pet Parent";
      }
    }
  }
);

const emergencyAddForm =
  document.querySelector(
    "#emergency-add-form"
  );

const emergencyAddMessage =
  document.querySelector(
    "#emergency-add-message"
  );

emergencyAddForm?.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    const fullName =
      document.querySelector(
        "#emergency-full-name"
      )?.value.trim() || "";

    const relationship =
      document.querySelector(
        "#emergency-relationship"
      )?.value.trim() || "";

    const primaryPhone =
      document.querySelector(
        "#emergency-primary-phone"
      )?.value.trim() || "";

    const alternatePhone =
      document.querySelector(
        "#emergency-alternate-phone"
      )?.value.trim() || "";

    const email =
      document.querySelector(
        "#emergency-email"
      )?.value
        .trim()
        .toLowerCase() || "";

    const priority =
      Number(
        document.querySelector(
          "#emergency-priority"
        )?.value || 1
      );

    const authorizedForMedicalDecisions =
      document.querySelector(
        "#emergency-medical"
      )?.checked === true;

    const authorizedForPickup =
      document.querySelector(
        "#emergency-pickup"
      )?.checked === true;

    const notes =
      document.querySelector(
        "#emergency-notes"
      )?.value.trim() || "";

    if (
      !fullName ||
      !primaryPhone
    ) {
      emergencyAddMessage.className =
        "portal-message error";

      emergencyAddMessage.textContent =
        "Enter the contact’s full name and primary phone number.";

      return;
    }

    const button =
      document.querySelector(
        "#emergency-add-submit"
      );

    if (button) {
      button.disabled = true;

      button.textContent =
        "Adding Contact...";
    }

    emergencyAddMessage.className =
      "portal-message";

    emergencyAddMessage.textContent =
      "Saving emergency contact...";

    try {
      const response =
        await fetch(
          "/api/account/emergency-contacts",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            credentials:
              "same-origin",

            body: JSON.stringify({
              fullName,
              relationship,
              primaryPhone,
              alternatePhone,
              email,
              priority,
              authorizedForMedicalDecisions,
              authorizedForPickup,
              notes
            })
          }
        );

      const responseText =
        await response.text();

      let result = null;

      try {
        result =
          responseText
            ? JSON.parse(responseText)
            : null;
      } catch {
        result = null;
      }

      if (!result) {
        throw new Error(
          "Invalid server response. HTTP " +
            response.status
        );
      }

      if (
        !response.ok ||
        !result.ok
      ) {
        throw new Error(
          result.error ||
          "Unable to add the emergency contact."
        );
      }

      emergencyAddMessage.className =
        "portal-message success";

      emergencyAddMessage.textContent =
        "Emergency contact added.";

      emergencyAddForm.reset();

      const priorityField =
        document.querySelector(
          "#emergency-priority"
        );

      if (priorityField) {
        priorityField.value = "1";
      }

      await loadAccountDetails();

      window.setTimeout(
        () => {
          window.location.reload();
        },
        700
      );

    } catch (error) {
      emergencyAddMessage.className =
        "portal-message error";

      emergencyAddMessage.textContent =
        error.message;

      if (button) {
        button.disabled = false;

        button.textContent =
          "Add Emergency Contact";
      }
    }
  }
);
</script>
        </body>
      </html>
    `;

    return new Response(
      page,
      {
        headers: {
          "Content-Type":
            "text/html; charset=utf-8",

          "Cache-Control":
            "no-store",

          "X-Frame-Options":
            "DENY",

          "Referrer-Policy":
            "no-referrer"
        }
      }
    );

  } catch (error) {
    return new Response(
      "Unable to load the customer account right now.",
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
    return env.ASSETS.fetch(request);
  }
};
