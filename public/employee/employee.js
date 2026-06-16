const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';

let SESSION = null;
let EMPLOYEE_NAME = '';
let PREFERRED_DAYS = null;

// availability[date] = { available: bool, windows: [{start, end}] }
// start/end are "HH:MM" (24h), e.g. "07:00", "19:00"
const availability = {};

// --- Time options (15-min steps, 7am–7pm) ---

function buildTimeOptions(selected = '07:00') {
  let html = '';
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === 19 && m > 0) break;
      const val = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      const h12 = h % 12 || 12;
      const suffix = h >= 12 ? 'PM' : 'AM';
      const label = `${h12}:${String(m).padStart(2,'0')} ${suffix}`;
      html += `<option value="${val}"${val === selected ? ' selected' : ''}>${label}</option>`;
    }
  }
  return html;
}

// --- Helpers ---

function show(id) { document.getElementById(id).style.display = ''; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

function getWeekdayDates(month) {
  const [year, mon] = month.split('-').map(Number);

  // Start: first Monday >= the 1st of the month
  const firstDay = new Date(year, mon - 1, 1);
  const firstDow = firstDay.getDay();
  const daysToMon = firstDow === 1 ? 0 : firstDow === 0 ? 1 : 8 - firstDow;
  const startDate = new Date(year, mon - 1, 1 + daysToMon);

  // End: Friday of the week containing the last weekday of the month
  const lastDay = new Date(year, mon, 0);
  let lastWeekday = new Date(lastDay);
  while (lastWeekday.getDay() === 0 || lastWeekday.getDay() === 6) {
    lastWeekday.setDate(lastWeekday.getDate() - 1);
  }
  const lastDow = lastWeekday.getDay();
  const endDate = new Date(lastWeekday);
  if (lastDow !== 5) endDate.setDate(lastWeekday.getDate() + (5 - lastDow));

  const dates = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function getDayName(dateStr) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

function getDayAbbr(dateStr) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(dateStr + 'T12:00:00').getDay()];
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function groupByWeek(dates) {
  const weeks = [];
  let current = [];
  let lastMon = null;
  for (const d of dates) {
    const date = new Date(d + 'T12:00:00');
    const monday = new Date(date);
    monday.setDate(date.getDate() - date.getDay() + 1);
    const monStr = monday.toISOString().slice(0, 10);
    if (monStr !== lastMon) {
      if (current.length) weeks.push(current);
      current = [d];
      lastMon = monStr;
    } else {
      current.push(d);
    }
  }
  if (current.length) weeks.push(current);
  return weeks;
}

function formatMonthName(month) {
  const [year, mon] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${names[mon - 1]} ${year}`;
}

// --- Validation ---

function validateWindow(w) {
  if (!w.start || !w.end) return 'Enter both start and end times.';
  if (w.start >= w.end) return 'Start must be before end.';
  return null;
}

function validateDay(date) {
  const slot = availability[date];
  if (!slot || !slot.available) return null;
  if (!slot.windows.length) return 'Add at least one time window.';
  for (const w of slot.windows) {
    const err = validateWindow(w);
    if (err) return err;
  }
  return null;
}

function validateAll() {
  for (const date of Object.keys(availability)) {
    if (validateDay(date)) return false;
  }
  return true;
}

function updateSubmitBtns() {
  const ok = validateAll();
  document.getElementById('btn-submit').disabled = !ok;
  document.getElementById('btn-submit-bottom').disabled = !ok;
}

// --- Master toggles ---

function setAllAvailable() {
  for (const date of Object.keys(availability)) {
    availability[date] = { available: true, windows: [{ start: '07:00', end: '19:00' }] };
  }
  renderCalendar(SESSION.month);
}

function setAllUnavailable() {
  for (const date of Object.keys(availability)) {
    availability[date] = { available: false, windows: [] };
  }
  renderCalendar(SESSION.month);
}

// --- Build day card ---

function buildWindowRow(date, winIdx) {
  const w = availability[date].windows[winIdx];
  const row = document.createElement('div');
  row.className = 'window-row';
  row.innerHTML = `
    <select class="time-sel win-start">${buildTimeOptions(w.start)}</select>
    <span class="to-label">to</span>
    <select class="time-sel win-end">${buildTimeOptions(w.end)}</select>
    <button class="btn-remove-win" title="Remove this window">&times;</button>
  `;

  const startSel = row.querySelector('.win-start');
  const endSel = row.querySelector('.win-end');
  const removeBtn = row.querySelector('.btn-remove-win');

  startSel.addEventListener('change', () => {
    availability[date].windows[winIdx].start = startSel.value;
    refreshDayError(date);
    updateSubmitBtns();
  });
  endSel.addEventListener('change', () => {
    availability[date].windows[winIdx].end = endSel.value;
    refreshDayError(date);
    updateSubmitBtns();
  });
  removeBtn.addEventListener('click', () => {
    availability[date].windows.splice(winIdx, 1);
    rebuildWindowsList(date);
    updateSubmitBtns();
  });

  return row;
}

function rebuildWindowsList(date) {
  const card = document.querySelector(`.day-card[data-date="${date}"]`);
  if (!card) return;
  const slot = availability[date];
  const list = card.querySelector('.windows-list');
  list.innerHTML = '';
  slot.windows.forEach((_, i) => list.appendChild(buildWindowRow(date, i)));
  card.querySelector('.btn-add-win').style.display =
    slot.available && slot.windows.length < 3 ? '' : 'none';
  refreshDayError(date);
}

function refreshDayError(date) {
  const card = document.querySelector(`.day-card[data-date="${date}"]`);
  if (!card) return;
  const err = validateDay(date);
  const errEl = card.querySelector('.day-error');
  errEl.textContent = err || '';
  errEl.style.display = err ? '' : 'none';
}

function buildDayCard(date) {
  const slot = availability[date];
  const card = document.createElement('div');
  card.className = `day-card${slot.available ? ' available' : ' unavailable'}`;
  card.dataset.date = date;

  const weekdayName = getDayName(date);
  // Flag days that fall outside the primary schedule month
  const cardMonth = date.slice(0, 7);
  const isOutsideMonth = SESSION && cardMonth !== SESSION.month;

  card.innerHTML = `
    <div class="day-header">
      <div class="day-info">
        <div class="day-abbr">${getDayAbbr(date)}</div>
        <div class="day-date-lbl${isOutsideMonth ? ' outside-month' : ''}">${formatDateLabel(date)}</div>
      </div>
      <button class="avail-toggle ${slot.available ? 'on' : ''}" title="Toggle availability">
        ${slot.available ? 'Available' : 'Unavailable'}
      </button>
    </div>
    <div class="windows-list"></div>
    <button class="btn-add-win" style="display:${slot.available && slot.windows.length < 3 ? '' : 'none'}">+ Add Window</button>
    <div class="apply-row" style="display:${slot.available ? '' : 'none'}">
      <span class="weekday-apply">Apply to all ${weekdayName}s</span>
    </div>
    <div class="day-error" style="display:none"></div>
  `;

  // Populate windows
  const list = card.querySelector('.windows-list');
  slot.windows.forEach((_, i) => list.appendChild(buildWindowRow(date, i)));

  // Toggle available/unavailable
  const toggle = card.querySelector('.avail-toggle');
  toggle.addEventListener('click', () => {
    slot.available = !slot.available;
    if (slot.available && !slot.windows.length) {
      slot.windows.push({ start: '07:00', end: '19:00' });
    }
    card.className = `day-card${slot.available ? ' available' : ' unavailable'}`;
    toggle.className = `avail-toggle${slot.available ? ' on' : ''}`;
    toggle.textContent = slot.available ? 'Available' : 'Unavailable';
    card.querySelector('.windows-list').style.display = slot.available ? '' : 'none';
    card.querySelector('.apply-row').style.display = slot.available ? '' : 'none';
    rebuildWindowsList(date);
    updateSubmitBtns();
  });

  // Add window button
  card.querySelector('.btn-add-win').addEventListener('click', () => {
    // Default new window to end of last window or 12pm–5pm
    const last = slot.windows[slot.windows.length - 1];
    const newStart = last ? last.end : '12:00';
    const newEnd = '19:00';
    slot.windows.push({ start: newStart, end: newEnd });
    rebuildWindowsList(date);
    updateSubmitBtns();
  });

  // Apply to all weekday
  card.querySelector('.weekday-apply').addEventListener('click', () => {
    applyToAllWeekday(date, weekdayName);
  });

  return card;
}

function applyToAllWeekday(sourceDate, weekdayName) {
  const source = availability[sourceDate];
  if (!source.available || !source.windows.length) {
    alert(`Set a valid time window for this ${weekdayName} first.`);
    return;
  }
  const others = Object.keys(availability).filter(d => getDayName(d) === weekdayName && d !== sourceDate);
  if (!others.length) return;

  if (!confirm(`Apply this schedule to all other ${weekdayName}s? This will overwrite existing entries.`)) return;

  for (const d of others) {
    availability[d] = {
      available: true,
      windows: source.windows.map(w => ({ ...w })),
    };
  }
  renderCalendar(SESSION.month);
}

// --- Render calendar ---

function renderCalendar(month) {
  const dates = getWeekdayDates(month);
  const weeks = groupByWeek(dates);
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  // Initialize availability (default: unavailable)
  for (const date of dates) {
    if (!availability[date]) {
      availability[date] = { available: false, windows: [] };
    }
  }

  for (const week of weeks) {
    const d = new Date(week[0] + 'T12:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = document.createElement('div');
    label.className = 'week-label';
    label.textContent = `Week of ${months[d.getMonth()]} ${d.getDate()}`;
    grid.appendChild(label);

    for (const date of week) {
      grid.appendChild(buildDayCard(date));
    }
  }

  // Show the outside-month note if any dates spill into another month
  const hasOutside = dates.some(d => d.slice(0, 7) !== SESSION.month);
  const noteEl = document.getElementById('outside-month-note');
  if (noteEl) noteEl.style.display = hasOutside ? '' : 'none';

  updateSubmitBtns();
}

// --- Submit ---

async function submitAvailability() {
  hide('submit-error');
  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, display_name: EMPLOYEE_NAME, availability, preferred_days: PREFERRED_DAYS }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submission failed');
    hide('step-calendar');
    show('step-confirm');
    document.getElementById('confirm-msg').textContent =
      `Thank you, ${EMPLOYEE_NAME}! Your availability for ${formatMonthName(SESSION.month)} has been recorded.`;
  } catch (err) {
    show('submit-error');
    document.getElementById('submit-error').textContent = err.message;
    btn.disabled = false; btn.textContent = 'Submit Availability';
  }
}

// --- Name step ---

async function handleNameNext() {
  const nameInput = document.getElementById('name-input');
  const nameError = document.getElementById('name-error');
  const name = nameInput.value.trim();
  nameError.style.display = 'none';

  if (!name) {
    nameError.textContent = 'Please enter your name.';
    nameError.style.display = '';
    return;
  }

  const btn = document.getElementById('btn-next-name');
  btn.disabled = true; btn.textContent = 'Checking…';

  try {
    const res = await fetch(`/api/submissions/check-name?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.taken) {
      nameError.textContent = 'That name has already been submitted. Contact your manager if this is a mistake.';
      nameError.style.display = '';
      btn.disabled = false; btn.textContent = 'Continue';
      return;
    }
    EMPLOYEE_NAME = name;
    hide('step-name');
    show('step-calendar');
    document.getElementById('calendar-title').textContent = `${name}'s Availability`;
    document.getElementById('calendar-subtitle').textContent = formatMonthName(SESSION.month);
    renderCalendar(SESSION.month);
  } catch {
    nameError.textContent = 'Network error. Please try again.';
    nameError.style.display = '';
    btn.disabled = false; btn.textContent = 'Continue';
  }
}

// --- Init ---

async function init() {
  if (!TOKEN) { hide('step-name'); show('step-error'); return; }

  try {
    const res = await fetch('/api/session');
    if (!res.ok) throw new Error();
    SESSION = await res.json();
    if (SESSION.employee_link_token !== TOKEN) throw new Error();
  } catch {
    hide('step-name'); show('step-error'); return;
  }

  document.getElementById('btn-next-name').addEventListener('click', handleNameNext);
  document.getElementById('name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleNameNext();
  });
  document.getElementById('btn-submit').addEventListener('click', submitAvailability);
  document.getElementById('btn-submit-bottom').addEventListener('click', submitAvailability);
  document.getElementById('btn-all-available').addEventListener('click', setAllAvailable);
  document.getElementById('btn-all-unavailable').addEventListener('click', () => {
    if (confirm('Mark all days as unavailable?')) setAllUnavailable();
  });
  document.getElementById('preferred-days').addEventListener('input', e => {
    const v = parseInt(e.target.value, 10);
    PREFERRED_DAYS = (v >= 1 && v <= 5) ? v : null;
  });
}

init();
