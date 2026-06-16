// State
const state = {
  step: 1,
  session: null,
  customLines: '',
  considerations: [],
  schedule: null,
  pollInterval: null,
};

const DEFAULT_CRITERIA = [
  'Business hours: 7:00 AM – 7:00 PM, Monday through Friday',
  'Shift length: 4–6 hours per shift (absolute maximum 8 hours); shorter shifts accepted when employee availability requires it',
  'Staffing 7–8 AM: maximum 1 employee (no more, no less); at least 2 employees at all times from 8:00 AM onward',
  'Daily shift target: no more than 5 employees per day (4–5 ideal) with staggered start/end times (30–60 min apart) for smooth handoffs',
  'Peak hour coverage: Extra staffing 10:00 AM – 2:00 PM',
  'Weekly frequency: Each employee works at least 2 different days per week',
  "Shift consistency: Each employee's schedule (days + times) repeats consistently each week of the month",
  'Hour distribution: Total hours spread evenly across all employees',
];

const EMPLOYEE_COLORS = [
  '#1a56db','#c0392b','#27ae60','#e67e22','#8e44ad',
  '#16a085','#d35400','#2980b9','#7f8c8d','#c0392b',
  '#f39c12','#1abc9c','#e74c3c','#3498db','#2ecc71',
  '#9b59b6','#e67e22','#34495e','#1abc9c','#e74c3c',
];
let employeeColorMap = {};

// --- Helpers ---

function show(id) { document.getElementById(id).style.display = ''; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

function saveState() {
  sessionStorage.setItem('pt_state', JSON.stringify({
    step: state.step,
    session: state.session,
    customLines: state.customLines,
    considerations: state.considerations,
  }));
}

function loadState() {
  try {
    const s = JSON.parse(sessionStorage.getItem('pt_state') || 'null');
    if (s) Object.assign(state, s);
  } catch {}
}

function formatMonthName(month) {
  const [year, mon] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${names[mon - 1]} ${year}`;
}

// Convert "08:00" → "8:00", "13:30" → "1:30" (no AM/PM, matches PDF style)
function shortTime(t24) {
  const [h, m] = t24.split(':').map(Number);
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}`;
}

function assignColors(names) {
  const sorted = [...names].sort();
  employeeColorMap = {};
  sorted.forEach((name, i) => {
    employeeColorMap[name] = EMPLOYEE_COLORS[i % EMPLOYEE_COLORS.length];
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Step rendering ---

function goToStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (el) el.style.display = 'none';
  }
  document.getElementById('step-schedule').style.display = 'none';
  if (n <= 4) {
    document.getElementById(`step-${n}`).style.display = '';
  } else {
    document.getElementById('step-schedule').style.display = '';
  }
  state.step = n;
  renderStepIndicator(n);
  saveState();
}

function renderStepIndicator(current) {
  const steps = ['Setup', 'Criteria', 'Share Link', 'Submissions', 'Schedule'];
  const el = document.getElementById('step-indicator');
  el.innerHTML = '';
  steps.forEach((label, i) => {
    const n = i + 1;
    const dot = document.createElement('div');
    dot.className = 'step-dot';
    dot.title = label;
    dot.textContent = n;
    if (n < current) dot.classList.add('done');
    else if (n === current) dot.classList.add('active');
    el.appendChild(dot);
    if (i < steps.length - 1) {
      const conn = document.createElement('div');
      conn.className = 'step-connector' + (n < current ? ' done' : '');
      el.appendChild(conn);
    }
  });
}

// --- Step 1 ---

function initStep1() {
  const monthInput = document.getElementById('month-input');
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  monthInput.value = next.toISOString().slice(0, 7);

  if (state.customLines) {
    document.getElementById('custom-input').value = state.customLines;
  }

  document.getElementById('btn-step1-next').addEventListener('click', async () => {
    const month = monthInput.value;
    if (!month) { alert('Please select a month.'); return; }
    state.customLines = document.getElementById('custom-input').value;

    // Back/forward navigation — reuse existing session, skip API call
    if (state.session && state.session.month === month) {
      const custom = state.customLines.split('\n').map(l => l.trim()).filter(Boolean);
      state.considerations = [...DEFAULT_CRITERIA, ...custom];
      goToStep(2);
      renderCriteriaList();
      return;
    }

    const btn = document.getElementById('btn-step1-next');
    btn.disabled = true; btn.textContent = 'Creating session…';
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.session = data;
      const custom = state.customLines.split('\n').map(l => l.trim()).filter(Boolean);
      state.considerations = [...DEFAULT_CRITERIA, ...custom];
      goToStep(2);
      renderCriteriaList();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Next: Review Criteria';
    }
  });
}

// --- Step 2 ---

function renderCriteriaList() {
  const container = document.getElementById('criteria-list');
  container.innerHTML = '';
  state.considerations.forEach((text, i) => {
    const isDefault = i < DEFAULT_CRITERIA.length;
    const row = document.createElement('div');
    row.className = 'consideration-item';
    row.innerHTML = `
      <span style="color:var(--muted);font-size:0.85rem;min-width:20px">${i + 1}.</span>
      <input type="text" value="${escapeHtml(text)}" style="flex:1">
      ${isDefault ? '<span class="default-badge">Default</span>' : ''}
      ${!isDefault ? `<button class="btn-remove" data-index="${i}">&times;</button>` : '<span style="width:28px"></span>'}
    `;
    row.querySelector('input').addEventListener('input', e => {
      state.considerations[i] = e.target.value;
    });
    const removeBtn = row.querySelector('.btn-remove');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        state.considerations.splice(i, 1);
        renderCriteriaList();
      });
    }
    container.appendChild(row);
  });
}

function initStep2() {
  document.getElementById('btn-add-criterion').addEventListener('click', () => {
    state.considerations.push('');
    renderCriteriaList();
    const inputs = document.querySelectorAll('#criteria-list input[type="text"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  document.getElementById('btn-step2-back').addEventListener('click', () => goToStep(1));
  document.getElementById('btn-step2-confirm').addEventListener('click', async () => {
    const filtered = state.considerations.filter(c => c.trim());
    if (!filtered.length) { alert('Please keep at least one criterion.'); return; }
    const btn = document.getElementById('btn-step2-confirm');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/session/considerations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ considerations: filtered }),
      });
      if (!res.ok) throw new Error('Failed to save criteria');
      state.considerations = filtered;
      goToStep(3);
      renderLinkStep();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Looks Good — Get Employee Link';
    }
  });
}

// --- Step 3 ---

function renderLinkStep() {
  const link = `${location.origin}/availability?token=${state.session.employee_link_token}`;
  document.getElementById('employee-link').value = link;
}

function initStep3() {
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const input = document.getElementById('employee-link');
    input.select();
    try {
      navigator.clipboard.writeText(input.value).catch(() => document.execCommand('copy'));
    } catch {
      document.execCommand('copy');
    }
    const fb = document.getElementById('copy-feedback');
    fb.style.display = '';
    setTimeout(() => { fb.style.display = 'none'; }, 2500);
  });
  document.getElementById('btn-step3-back').addEventListener('click', () => {
    goToStep(2);
    renderCriteriaList();
  });
  document.getElementById('btn-step3-next').addEventListener('click', () => {
    goToStep(4);
    startPolling();
  });
}

// --- Step 4 ---

async function renderAvailabilityTable() {
  const container = document.getElementById('avail-table-container');
  try {
    const data = await fetch('/api/submissions/detail').then(r => r.json());
    if (!data.employees || !data.employees.length) { container.style.display = 'none'; return; }
    container.style.display = '';
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const tbody = document.querySelector('#avail-table tbody');
    tbody.innerHTML = '';
    for (const emp of data.employees) {
      const tr = document.createElement('tr');
      const dayCells = DAYS.map(d => {
        const val = emp.weekdays[d] || '-';
        return `<td class="${val === '-' ? 'unavail' : ''}">${escapeHtml(val)}</td>`;
      }).join('');
      tr.innerHTML = `
        <td>${escapeHtml(emp.name)}</td>
        ${dayCells}
        <td class="time-off">${emp.time_off.length ? escapeHtml(emp.time_off.join(', ')) : '—'}</td>
        <td>${emp.preferred_days ?? '—'}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch { container.style.display = 'none'; }
}

async function updateDashboard() {
  try {
    const data = await fetch('/api/submissions').then(r => r.json());
    document.getElementById('submission-count').textContent = data.count;
    const list = document.getElementById('employee-list');
    list.innerHTML = '';
    for (const name of data.employees) {
      const li = document.createElement('li');
      li.className = 'employee-chip';
      li.innerHTML = `<span>${escapeHtml(name)}</span><button class="btn-remove-employee" title="Remove submission">&times;</button>`;
      li.querySelector('.btn-remove-employee').addEventListener('click', async () => {
        if (!confirm(`Remove ${name}'s submission?`)) return;
        await fetch(`/api/submissions?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        updateDashboard();
      });
      list.appendChild(li);
    }
    document.getElementById('waiting-msg').style.display = data.count === 0 ? '' : 'none';
    const btn = document.getElementById('btn-generate');
    const hint = document.getElementById('generate-hint');
    btn.disabled = data.count < 2;
    hint.style.display = data.count < 2 ? '' : 'none';
  } catch {}
}

function startPolling() {
  updateDashboard();
  state.pollInterval = setInterval(updateDashboard, 10000);
}

function stopPolling() {
  if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
}

function initStep4() {
  document.getElementById('btn-step4-back').addEventListener('click', () => {
    stopPolling();
    goToStep(3);
    renderLinkStep();
  });

  document.getElementById('btn-generate').addEventListener('click', async () => {
    stopPolling();
    const btn = document.getElementById('btn-generate');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const res = await fetch('/api/schedule/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modification_note: '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.schedule = data.schedule;
      goToStep(5);
      renderSchedule();
    } catch (err) {
      alert('Error generating schedule: ' + err.message);
      btn.disabled = false; btn.textContent = 'Generate Schedule';
    }
  });
}

// --- Schedule rendering (calendar-grid format matching PDF) ---

function renderSchedule() {
  const s = state.schedule;
  if (!s) return;

  // Collect all employee names for color assignment
  const allEmployees = new Set();
  for (const week of s.weeks) {
    for (const day of week.days) {
      for (const shift of day.shifts) allEmployees.add(shift.employee);
    }
  }
  assignColors(allEmployees);

  // Show shareable schedule link
  if (state.session) {
    const scheduleLink = `${location.origin}/schedule?token=${state.session.employee_link_token}`;
    document.getElementById('schedule-link').value = scheduleLink;
    document.getElementById('schedule-share-box').style.display = '';
  }

  const container = document.getElementById('schedule-output');
  container.innerHTML = '';

  // Modification note banner
  if (s.modification_note) {
    show('mod-banner');
    document.getElementById('mod-banner-text').textContent = s.modification_note;
  } else {
    hide('mod-banner');
  }

  // Print header (hidden on screen, shown when printing)
  const printHeader = document.createElement('div');
  printHeader.className = 'print-only';
  printHeader.innerHTML = `<h1 style="text-align:center;margin:0 0 2px">Peak PT Aide Scheduler</h1>`;
  container.appendChild(printHeader);

  // Lunch note
  const lunchNote = document.createElement('p');
  lunchNote.className = 'lunch-note';
  lunchNote.innerHTML = '6 hr shifts &mdash; <em>MAY</em> take 30 min lunch &nbsp;&nbsp;|&nbsp;&nbsp; &gt;6 hr shifts &mdash; <em>MUST</em> take 30 min lunch';
  container.appendChild(lunchNote);

  // Month title
  const title = document.createElement('h2');
  title.className = 'schedule-cal-title';
  title.textContent = formatMonthName(s.month);
  container.appendChild(title);

  // Calendar table
  const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const table = document.createElement('table');
  table.className = 'schedule-cal';

  // Header row
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const d of WEEKDAYS) {
    const th = document.createElement('th');
    th.textContent = d.toUpperCase();
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body — one date-row + one shifts-row per week
  const tbody = document.createElement('tbody');
  for (const week of s.weeks) {
    const dayMap = {};
    for (const day of week.days) dayMap[day.weekday] = day;

    // Date number row
    const dateRow = document.createElement('tr');
    dateRow.className = 'date-row';
    for (const wd of WEEKDAYS) {
      const td = document.createElement('td');
      td.className = 'date-cell';
      const day = dayMap[wd];
      if (day) {
        td.textContent = new Date(day.date + 'T12:00:00').getDate();
        // Warnings: small badge on date cell, tooltip on hover
        if (day.warnings && day.warnings.length) {
          td.classList.add('has-warning');
          const badge = document.createElement('span');
          badge.className = 'warn-badge';
          badge.textContent = '⚠';
          const tip = document.createElement('span');
          tip.className = 'warn-tip';
          tip.textContent = day.warnings.join(' • ');
          td.appendChild(badge);
          td.appendChild(tip);
        }
      }
      dateRow.appendChild(td);
    }
    tbody.appendChild(dateRow);

    // Shifts row
    const shiftsRow = document.createElement('tr');
    shiftsRow.className = 'shifts-row';
    for (const wd of WEEKDAYS) {
      const td = document.createElement('td');
      td.className = 'shifts-cell';
      const day = dayMap[wd];
      if (day) {
        const sorted = [...day.shifts].sort((a, b) => a.start.localeCompare(b.start));
        for (const shift of sorted) {
          const div = document.createElement('div');
          div.className = 'cal-shift';
          div.style.color = employeeColorMap[shift.employee] || '#1a1a1a';
          div.textContent = `${shortTime(shift.start)} - ${shortTime(shift.end)} ${shift.employee}`;
          td.appendChild(div);
        }
      }
      shiftsRow.appendChild(td);
    }
    tbody.appendChild(shiftsRow);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // Color legend (screen only)
  const legend = document.createElement('div');
  legend.className = 'schedule-legend no-print';
  for (const name of [...allEmployees].sort()) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${employeeColorMap[name]}"></span>${name}`;
    legend.appendChild(item);
  }
  container.appendChild(legend);

  // Availability summary + hours summary (screen only)
  renderAvailabilityTable();
  renderSummary(s.summary);
}

function renderSummary(summary) {
  const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const tbody = document.querySelector('#summary-table tbody');
  tbody.innerHTML = '';
  for (const [emp, info] of Object.entries(summary)) {
    const tr = document.createElement('tr');
    const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${employeeColorMap[emp]||'#ccc'};margin-right:6px;vertical-align:middle"></span>`;
    tr.innerHTML = `
      <td>${dot}${emp}</td>
      <td>${info.total_hours}h</td>
      ${WEEKDAYS.map(d => `<td>${info.shifts_per_weekday[d] || '—'}</td>`).join('')}
    `;
    tbody.appendChild(tr);
  }
}

// --- Schedule action buttons ---

function initScheduleSection() {
  document.getElementById('btn-step5-back').addEventListener('click', () => {
    goToStep(4);
    startPolling();
  });

  document.getElementById('btn-print').addEventListener('click', () => window.print());

  document.getElementById('btn-request-mod').addEventListener('click', () => {
    show('mod-panel');
    hide('btn-request-mod');
  });

  document.getElementById('btn-cancel-mod').addEventListener('click', () => {
    hide('mod-panel');
    show('btn-request-mod');
    document.getElementById('mod-note').value = '';
  });

  document.getElementById('btn-regenerate').addEventListener('click', async () => {
    const note = document.getElementById('mod-note').value.trim();
    if (!note) { alert('Please describe the modification you want.'); return; }
    const btn = document.getElementById('btn-regenerate');
    btn.disabled = true; btn.textContent = 'Regenerating…';
    try {
      const res = await fetch('/api/schedule/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modification_note: note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.schedule = data.schedule;
      document.getElementById('mod-note').value = '';
      hide('mod-panel');
      show('btn-request-mod');
      renderSchedule();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Regenerate Schedule';
    }
  });

  document.getElementById('btn-copy-schedule-link').addEventListener('click', () => {
    const input = document.getElementById('schedule-link');
    input.select();
    try {
      navigator.clipboard.writeText(input.value).catch(() => document.execCommand('copy'));
    } catch {
      document.execCommand('copy');
    }
    const fb = document.getElementById('schedule-copy-feedback');
    fb.style.display = '';
    setTimeout(() => { fb.style.display = 'none'; }, 2500);
  });

  document.getElementById('btn-new-month').addEventListener('click', () => {
    if (!confirm('Start a new month? This will create a fresh session.')) return;
    stopPolling();
    sessionStorage.removeItem('pt_state');
    Object.assign(state, { step: 1, session: null, customLines: '', considerations: [], schedule: null });
    // Reset Step 1 inputs
    document.getElementById('custom-input').value = '';
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    document.getElementById('month-input').value = next.toISOString().slice(0, 7);
    // Reset dashboard
    document.getElementById('submission-count').textContent = '0';
    document.getElementById('employee-list').innerHTML = '';
    document.getElementById('waiting-msg').style.display = '';
    document.getElementById('btn-generate').disabled = true;
    document.getElementById('generate-hint').style.display = '';
    // Hide schedule share link
    document.getElementById('schedule-share-box').style.display = 'none';
    goToStep(1);
  });
}

// --- Init ---

async function init() {
  loadState();
  renderStepIndicator(state.step);
  initStep1();
  initStep2();
  initStep3();
  initStep4();
  initScheduleSection();

  if (state.session) {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        state.session = data;
        if (data.status === 'generated' && data.schedule) {
          state.schedule = data.schedule;
          goToStep(5);
          renderSchedule();
          return;
        }
        if (data.status === 'collecting') {
          goToStep(state.step >= 3 ? state.step : 3);
          if (state.step >= 3) renderLinkStep();
          if (state.step === 4) startPolling();
          return;
        }
      }
    } catch {}
  }

  goToStep(1);
}

init();
