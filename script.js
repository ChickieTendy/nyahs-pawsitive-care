// ===== NAVIGATION =====

const menu = document.querySelector(".menu-toggle");
const nav = document.querySelector("#nav");

menu?.addEventListener("click", () => {
  const open = nav.classList.toggle("open");

  menu.setAttribute(
    "aria-expanded",
    String(open)
  );
});

nav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    nav.classList.remove("open");

    menu?.setAttribute(
      "aria-expanded",
      "false"
    );
  });
});

const year = document.querySelector("#year");

if (year) {
  year.textContent = new Date().getFullYear();
}


// ===== SHARED HELPERS =====

const moneyFormatter = new Intl.NumberFormat(
  "en-US",
  {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }
);

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);

  return date.toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year: "numeric"
    }
  );
}

let latestCareEstimate = null;


// ===== AVAILABILITY CALCULATOR =====

const availabilityForm =
  document.querySelector("#availability-form");

const availabilityResult =
  document.querySelector("#availability-result");

const availabilityLoading =
  document.querySelector("#availability-loading");

const availabilityStart =
  document.querySelector("#availability-start");

const availabilityEnd =
  document.querySelector("#availability-end");

if (
  availabilityForm &&
  availabilityResult &&
  availabilityStart &&
  availabilityEnd
) {
  const today = new Date();

  const localToday = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");

  availabilityStart.min = localToday;
  availabilityEnd.min = localToday;

  availabilityStart.addEventListener(
    "change",
    () => {
      availabilityEnd.min =
        availabilityStart.value || localToday;

      if (
        availabilityEnd.value &&
        availabilityEnd.value <=
          availabilityStart.value
      ) {
        availabilityEnd.value = "";
      }
    }
  );

  availabilityForm.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      latestCareEstimate = null;

      const service =
        document.querySelector(
          "#availability-service"
        ).value;

      const start = availabilityStart.value;
      const end = availabilityEnd.value;

      const dogs =
        document.querySelector(
          "#availability-dogs"
        ).value;

      availabilityResult.hidden = true;
      availabilityResult.innerHTML = "";

      availabilityLoading.hidden = false;

      try {
        const params = new URLSearchParams({
          service,
          start,
          end,
          dogs
        });

        const response = await fetch(
          `/api/availability?${params.toString()}`
        );

        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(
            data.error ||
            "Unable to check availability."
          );
        }

        const serviceName =
          data.service === "boarding"
            ? "Dog Boarding"
            : "In-Home House Sitting";

        let statusClass =
          "availability-success";

        let statusTitle =
          "Currently Available";

        if (data.availability === "limited") {
          statusClass =
            "availability-limited";

          statusTitle =
            "Limited Availability";
        }

        if (
          data.availability === "unavailable"
        ) {
          statusClass =
            "availability-unavailable";

          statusTitle =
            "Those Dates Aren’t Available";
        }

        const canContinue =
          data.availability !== "unavailable";

        if (canContinue) {
          latestCareEstimate = {
            ...data,
            serviceName
          };
        }

        availabilityResult.className =
          `availability-result ${statusClass}`;

        availabilityResult.innerHTML = `
          <div class="availability-status">
            <span class="availability-dot"></span>
            <strong>${statusTitle}</strong>
          </div>

          <h3>${serviceName}</h3>

          <div class="estimate-grid">
            <div>
              <span>Stay</span>
              <strong>
                ${data.nights}
                ${
                  data.nights === 1
                    ? "night"
                    : "nights"
                }
              </strong>
            </div>

            <div>
              <span>Dogs</span>
              <strong>${data.dogCount}</strong>
            </div>

            <div>
              <span>Nightly rate</span>
              <strong>
                ${moneyFormatter.format(
                  data.nightlyRate
                )}
              </strong>
            </div>
          </div>

          <div class="estimate-total">
            <span>Estimated Total</span>
            <strong>
              ${moneyFormatter.format(
                data.estimatedTotal
              )}
            </strong>
          </div>

          <p>${data.message}</p>

          <p class="estimate-disclaimer">
            ${data.disclaimer}
          </p>

          ${
            canContinue
              ? `
                <a
                  href="#request"
                  class="button estimate-continue"
                >
                  Continue to Request Care
                </a>
              `
              : ""
          }
        `;

        availabilityResult.hidden = false;
      } catch (error) {
        availabilityResult.className =
          "availability-result availability-error";

        availabilityResult.innerHTML = `
          <div class="availability-status">
            <strong>
              Unable to Check Availability
            </strong>
          </div>

          <p>
            ${error.message}
          </p>

          <p>
            Please try again. If the problem continues,
            contact Nyah directly.
          </p>
        `;

        availabilityResult.hidden = false;
      } finally {
        availabilityLoading.hidden = true;
      }
    }
  );
}


// ===== TRANSFER ESTIMATE TO REQUEST FORM =====

document.addEventListener(
  "click",
  (event) => {
    const continueButton =
      event.target.closest(".estimate-continue");

    if (!continueButton) {
      return;
    }

    if (!latestCareEstimate) {
      event.preventDefault();
      return;
    }

    const estimate = latestCareEstimate;

    const requestService =
      document.querySelector(
        '#care-form select[name="service"]'
      );

    const requestStart =
      document.querySelector(
        '#care-form input[name="startDate"]'
      );

    const requestEnd =
      document.querySelector(
        '#care-form input[name="endDate"]'
      );

    if (requestService) {
      requestService.value =
        estimate.serviceName;
    }

    if (requestStart) {
      requestStart.value =
        estimate.startDate;
    }

    if (requestEnd) {
      requestEnd.value =
        estimate.endDate;
    }

    const summary =
      document.querySelector(
        "#request-summary"
      );

    const summaryService =
      document.querySelector(
        "#summary-service"
      );

    const summaryDates =
      document.querySelector(
        "#summary-dates"
      );

    const summaryDogs =
      document.querySelector(
        "#summary-dogs"
      );

    const summaryNights =
      document.querySelector(
        "#summary-nights"
      );

    const summaryTotal =
      document.querySelector(
        "#summary-total"
      );

    if (summaryService) {
      summaryService.textContent =
        estimate.serviceName;
    }

    if (summaryDates) {
      summaryDates.textContent =
        `${formatDate(estimate.startDate)} – ` +
        `${formatDate(estimate.endDate)}`;
    }

    if (summaryDogs) {
      summaryDogs.textContent =
        `${estimate.dogCount} ${
          estimate.dogCount === 1
            ? "dog"
            : "dogs"
        }`;
    }

    if (summaryNights) {
      summaryNights.textContent =
        `${estimate.nights} ${
          estimate.nights === 1
            ? "night"
            : "nights"
        }`;
    }

    if (summaryTotal) {
      summaryTotal.textContent =
        moneyFormatter.format(
          estimate.estimatedTotal
        );
    }

    if (summary) {
      summary.hidden = false;
    }
  }
);


// ===== SUBMIT REQUEST TO D1 =====

const careForm =
  document.querySelector("#care-form");

const formMessage =
  document.querySelector("#form-message");

if (careForm && formMessage) {
  careForm.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();

      formMessage.className =
        "form-message";

      formMessage.textContent = "";

      if (!careForm.checkValidity()) {
        formMessage.textContent =
          "Please complete every required field and confirm that this is a request.";

        careForm.reportValidity();
        return;
      }

      if (!latestCareEstimate) {
        formMessage.textContent =
          "Please check availability and choose Continue to Request Care before submitting.";

        document
          .querySelector("#availability-checker")
          ?.scrollIntoView({
            behavior: "smooth"
          });

        return;
      }

      const data = new FormData(careForm);

      const expectedService =
        latestCareEstimate.serviceName;

      const expectedStart =
        latestCareEstimate.startDate;

      const expectedEnd =
        latestCareEstimate.endDate;

      if (
        data.get("service") !==
          expectedService ||
        data.get("startDate") !==
          expectedStart ||
        data.get("endDate") !==
          expectedEnd
      ) {
        formMessage.textContent =
          "The service or dates changed. Please run the availability check again before submitting.";

        return;
      }

      const submitButton =
        careForm.querySelector(
          'button[type="submit"]'
        );

      const originalButtonText =
        submitButton?.textContent;

      if (submitButton) {
        submitButton.disabled = true;

        submitButton.textContent =
          "Submitting Request…";
      }

      try {
        const payload = {
          ownerName:
            data.get("ownerName"),

          email:
            data.get("email"),

          phone:
            data.get("phone"),

          petName:
            data.get("petName"),

          petDetails:
            data.get("petDetails"),

          careDetails:
            data.get("details"),

          service:
            latestCareEstimate.service,

          startDate:
            latestCareEstimate.startDate,

          endDate:
            latestCareEstimate.endDate,

          dogCount:
            latestCareEstimate.dogCount,

          acknowledged:
            data.get("acknowledge") === "on"
        };

        const response = await fetch(
          "/api/requests",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify(payload)
          }
        );

        const result =
          await response.json();

        if (!response.ok || !result.ok) {
          throw new Error(
            result.error ||
            "Unable to submit your request."
          );
        }

        formMessage.className =
          "form-message success";

        formMessage.innerHTML = `
          <strong>
            Care request received 💜
          </strong>
          <br>
          Request number:
          <strong>${result.requestNumber}</strong>
          <br>
          Status: Pending Nyah’s review.
          This is not yet a confirmed reservation.
        `;

        if (submitButton) {
          submitButton.textContent =
            "Request Submitted";

          submitButton.disabled = true;
        }
      } catch (error) {
        formMessage.className =
          "form-message";

        formMessage.textContent =
          error.message;

        if (submitButton) {
          submitButton.disabled = false;

          submitButton.textContent =
            originalButtonText ||
            "Submit Care Request";
        }
      }
    }
  );
}
