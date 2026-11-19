const menu=document.querySelector('.menu-toggle');const nav=document.querySelector('#nav');menu?.addEventListener('click',()=>{const open=nav.classList.toggle('open');menu.setAttribute('aria-expanded',String(open));});nav?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{nav.classList.remove('open');menu?.setAttribute('aria-expanded','false');}));document.querySelector('#year').textContent=new Date().getFullYear();
const form=document.querySelector('#care-form');const message=document.querySelector('#form-message');
// Replace this address with the business email before publishing.
const BUSINESS_EMAIL='NyahsPawsitiveCare@outlook.com';
form.addEventListener('submit',(event)=>{event.preventDefault();message.className='form-message';if(!form.checkValidity()){message.textContent='Please complete every required field and check the confirmation box.';form.reportValidity();return;}const data=new FormData(form);const start=new Date(data.get('startDate')+'T00:00:00');const end=new Date(data.get('endDate')+'T00:00:00');if(end<start){message.textContent='The end date must be the same as or later than the start date.';return;}const body=["NYAH'S PAWSITIVE CARE - NEW CARE REQUEST",'',`Owner: ${data.get('ownerName')}`,`Email: ${data.get('email')}`,`Phone: ${data.get('phone')}`,`Pet: ${data.get('petName')}`,`Pet type / breed: ${data.get('petDetails')}`,`Service: ${data.get('service')}`,`Start date: ${data.get('startDate')}`,`End date: ${data.get('endDate')}`,'','Care details:',data.get('details'),'','I understand this is a request and not a confirmed reservation.'].join('\n');const subject=`Care request for ${data.get('petName')} - ${data.get('service')}`;message.className='form-message success';if(BUSINESS_EMAIL.startsWith('REPLACE-')){message.textContent='The form works, but add your business email in script.js before publishing. Your email app will open with the request draft.';}else{message.textContent='Your email draft is ready. Review it before sending.';}window.location.href=`mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;});
// ===== AVAILABILITY & PRICING CALCULATOR =====

const availabilityForm = document.querySelector("#availability-form");
const availabilityResult = document.querySelector("#availability-result");
const availabilityLoading = document.querySelector("#availability-loading");

if (availabilityForm) {
  const startInput = document.querySelector("#availability-start");
  const endInput = document.querySelector("#availability-end");

  // Prevent customers from selecting dates in the past.
  const today = new Date();
  const localToday = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");

  startInput.min = localToday;
  endInput.min = localToday;

  startInput.addEventListener("change", () => {
    endInput.min = startInput.value || localToday;

    if (
      endInput.value &&
      endInput.value <= startInput.value
    ) {
      endInput.value = "";
    }
  });

  availabilityForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const service =
      document.querySelector("#availability-service").value;

    const start =
      startInput.value;

    const end =
      endInput.value;

    const dogs =
      document.querySelector("#availability-dogs").value;

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
          data.error || "Unable to check availability."
        );
      }

      const serviceName =
        data.service === "boarding"
          ? "Dog Boarding"
          : "In-Home House Sitting";

      const money = new Intl.NumberFormat(
        "en-US",
        {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0
        }
      );

      let statusClass = "availability-success";
      let statusTitle = "Currently Available";

      if (data.availability === "limited") {
        statusClass = "availability-limited";
        statusTitle = "Limited Availability";
      }

      if (data.availability === "unavailable") {
        statusClass = "availability-unavailable";
        statusTitle = "Those Dates Aren’t Available";
      }

      const canContinue =
        data.availability !== "unavailable";

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
            <strong>${data.nights} ${
              data.nights === 1 ? "night" : "nights"
            }</strong>
          </div>

          <div>
            <span>Dogs</span>
            <strong>${data.dogCount}</strong>
          </div>

          <div>
            <span>Nightly rate</span>
            <strong>${money.format(data.nightlyRate)}</strong>
          </div>
        </div>

        <div class="estimate-total">
          <span>Estimated Total</span>
          <strong>${money.format(data.estimatedTotal)}</strong>
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
          <strong>Unable to Check Availability</strong>
        </div>

        <p>${error.message}</p>

        <p>
          Please try again or contact Nyah directly if the problem
          continues.
        </p>
      `;

      availabilityResult.hidden = false;
    } finally {
      availabilityLoading.hidden = true;
    }
  });
}

// ===== TRANSFER CALCULATOR TO REQUEST CARE =====

let latestCareEstimate = null;

document.addEventListener("click", (event) => {
  const continueButton =
    event.target.closest(".estimate-continue");

  if (!continueButton) {
    return;
  }

  const service =
    document.querySelector("#availability-service")?.value;

  const start =
    document.querySelector("#availability-start")?.value;

  const end =
    document.querySelector("#availability-end")?.value;

  const dogs =
    document.querySelector("#availability-dogs")?.value;

  if (!service || !start || !end || !dogs) {
    return;
  }

  const result =
    document.querySelector("#availability-result");

  if (
    !result ||
    result.classList.contains("availability-unavailable")
  ) {
    return;
  }

  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);

  const nights = Math.round(
    (endDate - startDate) / 86400000
  );

  let nightlyRate = 0;

  if (service === "boarding") {
    if (Number(dogs) === 1) nightlyRate = 55;
    else if (Number(dogs) === 2) nightlyRate = 95;
    else nightlyRate = 95 + ((Number(dogs) - 2) * 40);
  }

  if (service === "house-sitting") {
    if (Number(dogs) === 1) nightlyRate = 65;
    else if (Number(dogs) === 2) nightlyRate = 105;
    else nightlyRate = 105 + ((Number(dogs) - 2) * 40);
  }

  const estimatedTotal =
    nights * nightlyRate;

  const serviceName =
    service === "boarding"
      ? "Dog Boarding"
      : "In-Home House Sitting";

  latestCareEstimate = {
    service,
    serviceName,
    start,
    end,
    dogs: Number(dogs),
    nights,
    nightlyRate,
    estimatedTotal
  };

  // Existing Request Care service field.
  const requestService =
    document.querySelector(
      '#care-form select[name="service"]'
    );

  if (requestService) {
    requestService.value = serviceName;
  }

  // Existing start/end date fields.
  const requestStart =
    document.querySelector(
      '#care-form input[name="startDate"]'
    );

  const requestEnd =
    document.querySelector(
      '#care-form input[name="endDate"]'
    );

  if (requestStart) requestStart.value = start;
  if (requestEnd) requestEnd.value = end;

  // Fill visible summary.
  const summary =
    document.querySelector("#request-summary");

  const summaryService =
    document.querySelector("#summary-service");

  const summaryDates =
    document.querySelector("#summary-dates");

  const summaryDogs =
    document.querySelector("#summary-dogs");

  const summaryNights =
    document.querySelector("#summary-nights");

  const summaryTotal =
    document.querySelector("#summary-total");

  const formattedStart =
    startDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

  const formattedEnd =
    endDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

  if (summaryService) {
    summaryService.textContent = serviceName;
  }

  if (summaryDates) {
    summaryDates.textContent =
      `${formattedStart} – ${formattedEnd}`;
  }

  if (summaryDogs) {
    summaryDogs.textContent =
      `${dogs} ${Number(dogs) === 1 ? "dog" : "dogs"}`;
  }

  if (summaryNights) {
    summaryNights.textContent =
      `${nights} ${nights === 1 ? "night" : "nights"}`;
  }

  if (summaryTotal) {
    summaryTotal.textContent =
      new Intl.NumberFormat(
        "en-US",
        {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0
        }
      ).format(estimatedTotal);
  }

  if (summary) {
    summary.hidden = false;
  }
});
