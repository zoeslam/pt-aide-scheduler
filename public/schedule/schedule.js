const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';

const EMPLOYEE_COLORS = [
  '#1a56db','#c0392b','#27ae60','#e67e22','#8e44ad',
  '#16a085','#d35400','#2980b9','#7f8c8d','#c0392b',
  '#f39c12','#1abc9c','#e74c3c','#3498db','#2ecc71',
  '#9b59b6','#e67e22','#34495e','#1abc9c','#e74c3c',
];
let employeeColorMap = {};

function show(id) { document.getElementById(id).style.display = ''; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

function formatMonthName(month) {
  const [year, mon] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${names[mon - 1]} ${year}`;
}

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

function renderSchedule(schedule, employees) {
  assignColors(employees);

  const container = document.getElementById('schedule-output');
  container.innerHTML = '';

  const lunchNote = document.createElement('p');
  lunchNote.className = 'lunch-note';
  lunchNote.innerHTML = '6 hr shifts &mdash; <em>MAY</em> take 30 min lunch &nbsp;&nbsp;|&nbsp;&nbsp; &gt;6 hr shifts &mdash; <em>MUST</em> take 30 min lunch';
  container.appendChild(lunchNote);

  const title = document.createElement('h2');
  title.className = 'schedule-cal-title';
  title.textContent = formatMonthName(schedule.month);
  container.appendChild(title);

  const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const table = document.createElement('table');
  table.className = 'schedule-cal';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const d of WEEKDAYS) {
    const th = document.createElement('th');
    th.textContent = d.toUpperCase();
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const week of schedule.weeks) {
    const dayMap = {};
    for (const day of week.days) dayMap[day.weekday] = day;

    const dateRow = document.createElement('tr');
    dateRow.className = 'date-row';
    for (const wd of WEEKDAYS) {
      const td = document.createElement('td');
      td.className = 'date-cell';
      const day = dayMap[wd];
      if (day) {
        td.textContent = new Date(day.date + 'T12:00:00').getDate();
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

  // Color legend
  const legend = document.createElement('div');
  legend.className = 'schedule-legend';
  for (const name of [...employees].sort()) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${employeeColorMap[name]}"></span>${name}`;
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

function populateNameSelect(employees) {
  const sel = document.getElementById('name-select');
  for (const name of employees) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    document.getElementById('btn-download-ics').disabled = !sel.value;
  });
}

async function init() {
  if (!TOKEN) {
    hide('state-loading');
    show('state-error');
    return;
  }

  try {
    const res = await fetch(`/api/schedule/public?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      hide('state-loading');
      const errEl = document.getElementById('error-msg');
      if (data.error) errEl.textContent = data.error;
      show('state-error');
      return;
    }
    const { schedule, employees } = await res.json();
    hide('state-loading');
    renderSchedule(schedule, employees);
    populateNameSelect(employees);
    show('state-ready');
  } catch {
    hide('state-loading');
    show('state-error');
  }

  document.getElementById('btn-download-ics').addEventListener('click', () => {
    const name = document.getElementById('name-select').value;
    if (!name) return;
    window.location.href = `/api/schedule/ics?token=${encodeURIComponent(TOKEN)}&name=${encodeURIComponent(name)}`;
  });
}

init();
