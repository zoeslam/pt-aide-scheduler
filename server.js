const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Scheduling utilities (inlined from scheduler.js) ---

const OPEN = 420;         // 7:00 AM
const CLOSE = 1140;       // 7:00 PM
const FRIDAY_CLOSE = 1080; // 6:00 PM
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const TEMPLATES = {
  3: [
    { start: 480,  end: 780,  name: 'opener' },         // 8:00–1:00
    { start: 540,  end: 1020, name: 'anchor bridge' },   // 9:00–5:00
    { start: 780,  end: 1080, name: 'closer' },          // 1:00–6:00
  ],
  4: [
    { start: 480,  end: 690,  name: 'short opener' },    // 8:00–11:30
    { start: 510,  end: 870,  name: 'morning anchor' },  // 8:30–2:30
    { start: 690,  end: 1050, name: 'afternoon anchor' },// 11:30–5:30
    { start: 870,  end: 1140, name: 'closer' },          // 2:30–7:00
  ],
  5: [
    { start: 420,  end: 720,  name: 'early opener' },    // 7:00–12:00
    { start: 510,  end: 810,  name: 'late opener' },     // 8:30–1:30
    { start: 600,  end: 900,  name: 'midday bridge' },   // 10:00–3:00
    { start: 810,  end: 1140, name: 'primary closer' },  // 1:30–7:00
    { start: 900,  end: 1140, name: 'peak closer' },     // 3:00–7:00
  ],
  6: [
    { start: 420,  end: 720,  name: 'early opener' },    // 7:00–12:00
    { start: 480,  end: 810,  name: 'opener' },          // 8:00–1:30
    { start: 540,  end: 840,  name: 'late morning' },    // 9:00–2:00
    { start: 600,  end: 900,  name: 'midday bridge' },   // 10:00–3:00
    { start: 810,  end: 1140, name: 'primary closer' },  // 1:30–7:00
    { start: 900,  end: 1140, name: 'peak closer' },     // 3:00–7:00
  ],
};

function toMin(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function toTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function toTime24(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getWeekdayDates(month) {
  const [year, mon] = month.split('-').map(Number);
  const firstDay = new Date(year, mon - 1, 1);
  const firstDow = firstDay.getDay();
  const daysToMon = firstDow === 1 ? 0 : firstDow === 0 ? 1 : 8 - firstDow;
  const startDate = new Date(year, mon - 1, 1 + daysToMon);
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
  const d = new Date(dateStr + 'T12:00:00');
  return WEEKDAYS[d.getDay() - 1];
}

function groupByWeek(dates) {
  const weeks = [];
  let current = [];
  let lastWeek = null;
  for (const d of dates) {
    const date = new Date(d + 'T12:00:00');
    const weekNum = getISOWeek(date);
    if (weekNum !== lastWeek) {
      if (current.length) weeks.push(current);
      current = [d];
      lastWeek = weekNum;
    } else {
      current.push(d);
    }
  }
  if (current.length) weeks.push(current);
  return weeks;
}

function parseAvailability(submissions) {
  const avail = new Map();
  for (const sub of submissions) {
    const dateMap = new Map();
    const raw = JSON.parse(sub.availability);
    for (const [date, slot] of Object.entries(raw)) {
      if (!slot.available) continue;
      let windows = [];
      if (slot.windows && slot.windows.length) {
        windows = slot.windows
          .filter(w => w.start && w.end && w.start < w.end)
          .map(w => ({ start: Math.max(toMin(w.start), OPEN), end: Math.min(toMin(w.end), CLOSE) }))
          .filter(w => w.end > w.start);
      } else if (slot.start && slot.end) {
        const s = Math.max(toMin(slot.start), OPEN);
        const e = Math.min(toMin(slot.end), CLOSE);
        if (e > s) windows = [{ start: s, end: e }];
      }
      if (!windows.length) continue;
      windows.sort((a, b) => (b.end - b.start) - (a.end - a.start));
      dateMap.set(date, windows[0]);
    }
    avail.set(sub.display_name, dateMap);
  }
  return avail;
}

function buildAvailSummary(submissions, month) {
  const allDates = getWeekdayDates(month);
  const avail = parseAvailability(submissions);
  const fmt = m => {
    const h = Math.floor(m / 60) % 12 || 12;
    const mn = m % 60;
    return mn ? `${h}:${String(mn).padStart(2, '0')}` : `${h}`;
  };
  return submissions.map(sub => {
    const windows = WEEKDAYS.map(wd => {
      const w = getCommonWindow(sub.display_name, wd, allDates, avail);
      if (!w) return `${wd}: unavailable`;
      const label = (w.start <= OPEN + 30 && w.end >= CLOSE - 30)
        ? 'any time'
        : `${fmt(w.start)}–${fmt(w.end)}`;
      return `${wd}: ${label}`;
    });
    return `${sub.display_name}: ${windows.join(' | ')}`;
  }).join('\n');
}

// --- Deterministic scheduling algorithm ---

function buildWeekdayMatrix(allDates, avail) {
  const matrix = new Map();
  for (const [emp, dateMap] of avail) {
    const wdAvail = new Set();
    for (const wd of WEEKDAYS) {
      const datesInWd = allDates.filter(d => getDayName(d) === wd);
      if (!datesInWd.length) continue;
      const available = datesInWd.filter(d => dateMap.has(d)).length;
      if (available >= Math.ceil(datesInWd.length / 2)) wdAvail.add(wd);
    }
    matrix.set(emp, wdAvail);
  }
  return matrix;
}

function assignWeekdays(employeeNames, weekdayMatrix, countOverrides, preferredDaysMap = new Map()) {
  const roster = new Map(WEEKDAYS.map(wd => [wd, []]));
  const empCounts = new Map(employeeNames.map(n => [n, 0]));

  const sorted = [...WEEKDAYS].sort((a, b) => {
    const aCount = employeeNames.filter(e => weekdayMatrix.get(e)?.has(a)).length;
    const bCount = employeeNames.filter(e => weekdayMatrix.get(e)?.has(b)).length;
    return aCount - bCount;
  });

  for (const wd of sorted) {
    const target = (countOverrides.byWeekday || {})[wd] || 5;
    const candidates = employeeNames
      .filter(e => {
        if (!weekdayMatrix.get(e)?.has(wd)) return false;
        const max = preferredDaysMap.get(e) || 4;
        return empCounts.get(e) < max;
      })
      .sort((a, b) => empCounts.get(a) - empCounts.get(b));
    const chosen = candidates.slice(0, target);
    roster.set(wd, chosen);
    for (const e of chosen) empCounts.set(e, empCounts.get(e) + 1);
  }

  // Enforce minimum 2 days per employee where possible (skip if preferred is 1)
  for (const [emp, count] of empCounts) {
    const preferred = preferredDaysMap.get(emp);
    const min = preferred === 1 ? 1 : 2;
    if (count >= min) continue;
    for (const wd of WEEKDAYS) {
      if (roster.get(wd).includes(emp)) continue;
      if (!weekdayMatrix.get(emp)?.has(wd)) continue;
      const max = preferred || 4;
      if (empCounts.get(emp) >= max) break;
      const target = (countOverrides.byWeekday || {})[wd] || 5;
      if (roster.get(wd).length < target + 1) {
        roster.get(wd).push(emp);
        empCounts.set(emp, empCounts.get(emp) + 1);
        break;
      }
    }
  }

  return roster;
}

function getCommonWindow(emp, weekday, allDates, avail) {
  const dateMap = avail.get(emp);
  if (!dateMap) return null;
  const windows = [];
  for (const date of allDates) {
    if (getDayName(date) !== weekday) continue;
    const w = dateMap.get(date);
    if (w) windows.push(w);
  }
  if (!windows.length) return null;
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  return windows[Math.floor(windows.length / 2)];
}

function designWeekdayShifts(employees, weekday, allDates, avail) {
  const isFriday = weekday === 'Friday';
  const dayClose = isFriday ? FRIDAY_CLOSE : CLOSE;

  const candidates = [];
  for (const emp of employees) {
    const window = getCommonWindow(emp, weekday, allDates, avail);
    if (window) candidates.push({ name: emp, window });
  }
  if (!candidates.length) return [];

  // Most constrained first (shortest window)
  candidates.sort((a, b) =>
    (a.window.end - a.window.start) - (b.window.end - b.window.start)
  );

  const n = Math.min(candidates.length, 6);
  const baseTemplate = (TEMPLATES[n] || TEMPLATES[5]).map(s => ({
    ...s,
    end: Math.min(s.end, dayClose),
  }));
  const remainingSlots = baseTemplate.map(s => ({ ...s }));

  const assigned = [];
  for (const cand of candidates) {
    let bestSlotIdx = -1, bestOverlap = -Infinity;
    for (let i = 0; i < remainingSlots.length; i++) {
      const slot = remainingSlots[i];
      const overlap = Math.min(slot.end, cand.window.end) - Math.max(slot.start, cand.window.start);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestSlotIdx = i; }
    }
    if (bestSlotIdx === -1) continue;

    const slot = remainingSlots[bestSlotIdx];
    remainingSlots.splice(bestSlotIdx, 1);

    const start = cand.window.start;
    const end = Math.min(cand.window.end, slot.end);
    if (end - start < 120) continue; // skip — shift would be under 2 hours
    assigned.push({
      employee: cand.name,
      start,
      end,
      hours: Math.round((end - start) / 60 * 10) / 10,
      slot_name: slot.name,
    });
  }

  // Gap-close: pull next shift's start back only as far as their own window allows
  assigned.sort((a, b) => a.start - b.start);
  for (let i = 0; i < assigned.length - 1; i++) {
    if (assigned[i].end >= assigned[i + 1].start) continue;
    const candB = candidates.find(c => c.name === assigned[i + 1].employee);
    if (!candB) continue;
    const pullBackTo = Math.max(assigned[i].end, candB.window.start);
    if (pullBackTo < assigned[i + 1].start) {
      assigned[i + 1].start = pullBackTo;
      assigned[i + 1].hours = Math.round((assigned[i + 1].end - pullBackTo) / 60 * 10) / 10;
    }
  }

  // Swap pass: for any remaining gap, replace the higher-hours adjacent employee
  // with an unassigned employee who can bridge it
  const assignedNames = new Set(assigned.map(s => s.employee));
  for (let i = 0; i < assigned.length - 1; i++) {
    if (assigned[i].end >= assigned[i + 1].start) continue;

    const gapStart = assigned[i].end;
    const gapEnd   = assigned[i + 1].start;
    const swapIsLeft = assigned[i].hours >= assigned[i + 1].hours;
    const swapIdx    = swapIsLeft ? i : i + 1;
    const toSwap     = assigned[swapIdx];

    const replacement = [...avail.keys()]
      .filter(e => !assignedNames.has(e))
      .map(e => ({ name: e, window: getCommonWindow(e, weekday, allDates, avail) }))
      .filter(c => {
        if (!c.window) return false;
        if (swapIsLeft) {
          return c.window.start <= toSwap.start && c.window.end >= gapEnd;
        } else {
          return c.window.start <= gapStart && c.window.end >= toSwap.end;
        }
      })
      .sort((a, b) => (a.window.end - a.window.start) - (b.window.end - b.window.start))[0];

    if (replacement) {
      const start = Math.max(replacement.window.start, toSwap.start);
      const end   = Math.min(replacement.window.end, toSwap.end);
      if (end - start < 120) continue; // replacement shift too short — skip
      assignedNames.delete(toSwap.employee);
      assignedNames.add(replacement.name);
      assigned[swapIdx] = {
        employee: replacement.name,
        start,
        end,
        hours: Math.round((end - start) / 60 * 10) / 10,
        slot_name: toSwap.slot_name,
      };
      assigned.sort((a, b) => a.start - b.start);
      i = -1; // restart scan — swap may close downstream gaps
    }
  }

  return assigned;
}

function generateSchedule(session, submissions, countOverrides = {}) {
  const allDates = getWeekdayDates(session.month);
  const avail = parseAvailability(submissions);

  const weekdayMatrix = buildWeekdayMatrix(allDates, avail);
  const employeeNames = submissions.map(s => s.display_name);
  const preferredDaysMap = new Map(submissions.map(s => [s.display_name, s.preferred_days || null]).filter(([, v]) => v));
  const roster = assignWeekdays(employeeNames, weekdayMatrix, countOverrides, preferredDaysMap);

  // Design shift times for each weekday (consistent week-over-week)
  const weekdayShifts = new Map();
  for (const wd of WEEKDAYS) {
    weekdayShifts.set(wd, designWeekdayShifts(roster.get(wd) || [], wd, allDates, avail));
  }

  // Expand weekday template to every calendar date
  const weeks = groupByWeek(allDates).map((weekDates, wi) => ({
    week_number: wi + 1,
    days: weekDates.map(date => {
      const weekday = getDayName(date);
      const templateShifts = weekdayShifts.get(weekday) || [];
      const warnings = [];
      const working = new Set(templateShifts.map(x => x.employee));

      const shifts = [];
      for (const ts of templateShifts) {
        const empAvail = avail.get(ts.employee)?.get(date);
        const actualStart = empAvail ? Math.max(ts.start, empAvail.start) : null;
        const actualEnd   = empAvail ? Math.min(ts.end, empAvail.end)   : null;

        if (empAvail && actualEnd - actualStart >= 120) {
          shifts.push({
            employee: ts.employee,
            start: toTime24(actualStart),
            end: toTime24(actualEnd),
            start_display: toTime(actualStart),
            end_display: toTime(actualEnd),
            hours: Math.round((actualEnd - actualStart) / 60 * 10) / 10,
            slot: ts.slot_name,
          });
        } else {
          // Absent or availability too narrow — find a substitute
          const sub = submissions.find(s => {
            if (working.has(s.display_name)) return false;
            const w = avail.get(s.display_name)?.get(date);
            if (!w) return false;
            return Math.min(w.end, ts.end) - Math.max(w.start, ts.start) >= 120;
          });
          if (sub) {
            const w = avail.get(sub.display_name).get(date);
            const start = Math.max(w.start, ts.start);
            const end = Math.min(w.end, ts.end);
            working.add(sub.display_name);
            shifts.push({
              employee: sub.display_name,
              start: toTime24(start),
              end: toTime24(end),
              start_display: toTime(start),
              end_display: toTime(end),
              hours: Math.round((end - start) / 60 * 10) / 10,
              slot: ts.slot_name,
              substitute_for: ts.employee,
            });
            warnings.push(`${ts.employee} absent — ${sub.display_name} substituting`);
          } else {
            warnings.push(`${ts.employee} absent on ${date} — no substitute found`);
          }
        }
      }

      // Per-date gap-close: pull the next shift's start back when availability clamping
      // created a gap that the employee can actually cover
      shifts.sort((a, b) => toMin(a.start) - toMin(b.start));
      for (let i = 0; i < shifts.length - 1; i++) {
        const prevEnd = toMin(shifts[i].end);
        const nextStart = toMin(shifts[i + 1].start);
        if (prevEnd >= nextStart) continue;
        const nextWindow = avail.get(shifts[i + 1].employee)?.get(date);
        if (nextWindow && nextWindow.start <= prevEnd) {
          shifts[i + 1] = {
            ...shifts[i + 1],
            start: toTime24(prevEnd),
            start_display: toTime(prevEnd),
            hours: Math.round((toMin(shifts[i + 1].end) - prevEnd) / 60 * 10) / 10,
          };
        }
      }

      return { date, weekday, shifts, warnings };
    }),
  }));

  // Build summary
  const summary = {};
  for (const sub of submissions) {
    const name = sub.display_name;
    let totalHours = 0;
    const wdTimes = {};
    for (const week of weeks) {
      for (const day of week.days) {
        for (const shift of day.shifts) {
          if (shift.employee !== name) continue;
          totalHours += shift.hours;
          if (!wdTimes[day.weekday]) wdTimes[day.weekday] = `${shift.start_display}–${shift.end_display}`;
        }
      }
    }
    if (totalHours > 0) summary[name] = {
      total_hours: Math.round(totalHours * 10) / 10,
      shifts_per_weekday: wdTimes,
    };
  }

  return {
    month: session.month,
    generated_at: new Date().toISOString(),
    weeks,
    summary,
    warnings: [],
  };
}

// --- Page routes ---

app.get('/', (_req, res) => res.redirect('/admin'));

app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/admin/index.html')));

app.get('/availability', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/employee/index.html')));

app.get('/schedule', (req, res) =>
  res.sendFile(path.join(__dirname, 'public/schedule/index.html')));

// --- Schedule helpers for Claude calls ---

function stripForClaude(schedule) {
  return {
    month: schedule.month,
    weeks: schedule.weeks.map(w => ({
      week_number: w.week_number,
      days: w.days.map(d => ({
        date: d.date,
        weekday: d.weekday,
        shifts: d.shifts.map(s => ({ employee: s.employee, start: s.start, end: s.end })),
        warnings: d.warnings,
      })),
    })),
  };
}

function recomputeSummary(weeks) {
  const summary = {};
  for (const week of weeks) {
    for (const day of week.days) {
      for (const shift of day.shifts) {
        const emp = shift.employee;
        if (!summary[emp]) summary[emp] = { total_hours: 0, shifts_per_weekday: {} };
        summary[emp].total_hours += shift.hours;
        if (!summary[emp].shifts_per_weekday[day.weekday]) {
          summary[emp].shifts_per_weekday[day.weekday] = `${shift.start_display}–${shift.end_display}`;
        }
      }
    }
  }
  for (const emp of Object.values(summary)) {
    emp.total_hours = Math.round(emp.total_hours * 10) / 10;
  }
  return summary;
}

function applyPatches(baseSchedule, patches) {
  if (!patches || !patches.length) return baseSchedule;
  const patchMap = new Map(patches.map(p => [p.date, p]));
  const weeks = baseSchedule.weeks.map(w => ({
    ...w,
    days: w.days.map(d => {
      const patch = patchMap.get(d.date);
      if (!patch) return d;
      const seen = new Set();
      const shifts = patch.shifts.map(s => {
        if (seen.has(s.employee))
          throw new Error(`${s.employee} is scheduled twice on ${d.date} — modification rejected`);
        seen.add(s.employee);
        const startMin = toMin(s.start);
        const endMin = toMin(s.end);
        return {
          employee: s.employee,
          start: s.start,
          end: s.end,
          start_display: toTime(startMin),
          end_display: toTime(endMin),
          hours: Math.round((endMin - startMin) / 60 * 10) / 10,
        };
      });
      return { ...d, shifts, warnings: patch.warnings || [] };
    }),
  }));
  return { ...baseSchedule, weeks, summary: recomputeSummary(weeks) };
}

function clampToAvailability(schedule, avail) {
  const weeks = schedule.weeks.map(w => ({
    ...w,
    days: w.days.map(d => ({
      ...d,
      shifts: d.shifts.map(s => {
        const window = avail.get(s.employee)?.get(d.date);
        if (!window) return s;
        const startMin = Math.max(toMin(s.start), window.start);
        const endMin   = Math.min(toMin(s.end), window.end);
        if (endMin - startMin < 120) return null; // too short after clamping — drop
        if (startMin === toMin(s.start) && endMin === toMin(s.end)) return s;
        return {
          ...s,
          start: toTime24(startMin),
          end: toTime24(endMin),
          start_display: toTime(startMin),
          end_display: toTime(endMin),
          hours: Math.round((endMin - startMin) / 60 * 10) / 10,
        };
      }).filter(Boolean),
    })),
  }));
  return { ...schedule, weeks, summary: recomputeSummary(weeks) };
}

// --- Claude response JSON extractor ---

function extractJSON(text) {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('Claude did not return valid JSON');
  // Walk forward to find the matching closing brace (handles extra text after the object)
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('Claude did not return valid JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

// --- Claude: refine initial schedule against criteria ---

async function refineWithCriteria(baseSchedule, considerations) {
  const client = new Anthropic();
  const prompt = `You are a scheduling assistant for Peak PT, a physical therapy clinic.
A deterministic algorithm has produced a draft schedule with exact shift times.
Review it, apply the considerations below, and fix any warnings. Return ONLY the days that need changes.

SHIFT TEMPLATES BY HEADCOUNT (use when a consideration changes headcount for a day):
3-person day:   8:00–1:00 | 9:00–5:00 | 1:00–6:00
4-person day:   8:00–11:30 | 8:30–2:30 | 11:30–5:30 | 2:30–7:00
5-person day:   7:00–12:00 | 8:30–1:30 | 10:00–3:00 | 1:30–7:00 | 3:00–7:00
6-person day:   7:00–12:00 | 8:00–1:30 | 9:00–2:00 | 10:00–3:00 | 1:30–7:00 | 3:00–7:00
Friday adjustment: all closing shifts end at 6:00 PM.

RULES:
- Never schedule anyone outside their availability window.
- Prefer employees with the least total availability when adding to a day.
- Maintain week-over-week consistency. Only deviate for: (1) per-date absence — substitute that date, restore next week; (2) explicit consideration override.
- When changing headcount: remove highest-hours employees first; add lowest-hours available employees first.
- Never schedule the same employee more than once on the same day, unless Alex's considerations explicitly request it.
- Fix all warnings before returning.

CONSIDERATIONS (take priority over algorithm defaults):
${considerations.join('\n')}

DRAFT SCHEDULE:
${JSON.stringify(stripForClaude(baseSchedule))}

Return ONLY a JSON object in this exact structure:
{
  "patches": [
    {
      "date": "YYYY-MM-DD",
      "shifts": [ { "employee": "Name", "start": "HH:MM", "end": "HH:MM" } ],
      "warnings": []
    }
  ]
}
Include ONLY days that differ from the draft. If no changes are needed, return { "patches": [] }.
Output raw JSON only — no markdown, no explanation.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });
  const { patches } = extractJSON(msg.content[0].text);
  return applyPatches(baseSchedule, patches);
}

// --- Claude: apply a modification note to existing schedule ---

async function applyModification(currentSchedule, submissions, month, modificationNote, considerations) {
  const client = new Anthropic();
  const availSummary = buildAvailSummary(submissions, month);
  const prompt = `You are a scheduling assistant for a physical therapy clinic.
Modify the schedule below to satisfy the requested change while following all considerations and rules.
Return ONLY the days that need to change.

RULES:
- Never schedule an employee outside their listed availability window.
- Never schedule the same employee more than once on the same day, unless the modification request explicitly asks for it.
- Maintain week-over-week consistency — only change days directly affected by the modification.

EMPLOYEE AVAILABILITY (typical window per weekday):
${availSummary}

CONSIDERATIONS:
${considerations.join('\n')}

MODIFICATION REQUEST: ${modificationNote}

CURRENT SCHEDULE:
${JSON.stringify(stripForClaude(currentSchedule))}

Return ONLY a JSON object in this exact structure:
{
  "patches": [
    {
      "date": "YYYY-MM-DD",
      "shifts": [ { "employee": "Name", "start": "HH:MM", "end": "HH:MM" } ],
      "warnings": []
    }
  ]
}
Include ONLY days that differ from the current schedule. If no changes are needed, return { "patches": [] }.
Output raw JSON only — no markdown, no explanation.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });
  const result = extractJSON(msg.content[0].text);
  if (!result.patches) throw new Error('Claude returned an unexpected response format');
  if (result.patches.length === 0) throw new Error('Claude could not determine what to change — try rephrasing the modification');
  return applyPatches(currentSchedule, result.patches);
}

// --- ICS builder ---

function buildICS(employeeName, schedule) {
  const events = [];
  for (const week of schedule.weeks) {
    for (const day of week.days) {
      for (const shift of day.shifts) {
        if (shift.employee !== employeeName) continue;
        const dateStr = day.date.replace(/-/g, '');
        const startStr = shift.start.replace(':', '') + '00';
        const endStr = shift.end.replace(':', '') + '00';
        const uid = `peak-pt-${day.date}-${employeeName.replace(/\s+/g, '-').toLowerCase()}@scheduler`;
        events.push([
          'BEGIN:VEVENT',
          `DTSTART:${dateStr}T${startStr}`,
          `DTEND:${dateStr}T${endStr}`,
          'SUMMARY:Peak PT Shift',
          `DESCRIPTION:${shift.start} - ${shift.end}`,
          `UID:${uid}`,
          'END:VEVENT',
        ].join('\r\n'));
      }
    }
  }
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Peak PT Aide Scheduler//EN',
    'X-WR-CALNAME:Peak PT Shifts',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

// --- Session routes ---

// Create or retrieve a session for a given month
app.post('/api/session', (req, res) => {
  const { month } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Invalid month format (expected YYYY-MM)' });
  }
  const token = crypto.randomBytes(4).toString('hex');
  const session = db.createSession(month, token);
  const count = db.getSubmissionCount(session.id);
  res.status(201).json({
    id: session.id,
    month: session.month,
    status: session.status,
    considerations: JSON.parse(session.considerations),
    employee_link_token: session.employee_link_token,
    submission_count: count,
    schedule: session.schedule ? JSON.parse(session.schedule) : null,
  });
});

// Get the current active session
app.get('/api/session', (req, res) => {
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const count = db.getSubmissionCount(session.id);
  res.json({
    id: session.id,
    month: session.month,
    status: session.status,
    considerations: JSON.parse(session.considerations),
    employee_link_token: session.employee_link_token,
    submission_count: count,
    schedule: session.schedule ? JSON.parse(session.schedule) : null,
  });
});

// Save finalized criteria list
app.patch('/api/session/considerations', (req, res) => {
  const { considerations } = req.body;
  if (!Array.isArray(considerations)) {
    return res.status(400).json({ error: 'considerations must be an array' });
  }
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  db.updateConsiderations(session.id, considerations);
  res.json({ ok: true, considerations });
});

// --- Submission routes ---

// Remove a submission by display name
app.delete('/api/submissions', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const deleted = db.deleteSubmission(session.id, name);
  if (!deleted) return res.status(404).json({ error: 'Submission not found' });
  res.json({ ok: true });
});

// Submission count + names for admin dashboard
app.get('/api/submissions', (req, res) => {
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const rows = db.getSubmissions(session.id);
  res.json({
    count: rows.length,
    employees: rows.map(r => r.display_name),
  });
});

// Detailed availability summary for admin table
app.get('/api/submissions/detail', (_req, res) => {
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  const rows = db.getSubmissions(session.id);
  const allDates = getWeekdayDates(session.month);
  const avail = parseAvailability(rows);

  function fmtWin(start, end) {
    if (start <= OPEN + 30 && end >= CLOSE - 30) return 'Any';
    const fmt = m => {
      const h = Math.floor(m / 60) % 12 || 12;
      const mn = m % 60;
      return mn ? `${h}:${String(mn).padStart(2, '0')}` : `${h}`;
    };
    return `${fmt(start)}–${fmt(end)}`;
  }

  function collapseRanges(dates) {
    if (!dates.length) return [];
    const sorted = [...dates].sort();
    const ranges = [];
    let rangeStart = sorted[0], prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      const prevMs = new Date(prev + 'T12:00:00').getTime();
      const curMs = cur ? new Date(cur + 'T12:00:00').getTime() : null;
      const consecutive = curMs && curMs - prevMs <= 86400000 * 3; // allow weekends between weekdays
      if (!consecutive) {
        const s = new Date(rangeStart + 'T12:00:00');
        const e = new Date(prev + 'T12:00:00');
        const fmt = d => `${d.getMonth() + 1}/${d.getDate()}`;
        ranges.push(rangeStart === prev ? fmt(s) : `${fmt(s)}–${fmt(e)}`);
        rangeStart = cur;
      }
      prev = cur;
    }
    return ranges;
  }

  const employees = rows.map(sub => {
    const dateMap = avail.get(sub.display_name) || new Map();
    const weekdays = {};
    let timesPerWeek = 0;
    for (const wd of WEEKDAYS) {
      const wdDates = allDates.filter(d => getDayName(d) === wd);
      if (!wdDates.length) { weekdays[wd] = '-'; continue; }
      const available = wdDates.filter(d => dateMap.has(d));
      if (available.length < Math.ceil(wdDates.length / 2)) { weekdays[wd] = '-'; continue; }
      timesPerWeek++;
      // Most common window
      const counts = {};
      for (const d of available) {
        const w = dateMap.get(d);
        const key = `${w.start},${w.end}`;
        counts[key] = (counts[key] || 0) + 1;
      }
      const [start, end] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
      weekdays[wd] = fmtWin(start, end);
    }

    // Time off: dates explicitly marked unavailable
    const raw = JSON.parse(sub.availability);
    const timeOffDates = Object.entries(raw)
      .filter(([, slot]) => slot.available === false)
      .map(([date]) => date)
      .filter(d => allDates.includes(d) || true); // include all marked-off dates in month

    return {
      name: sub.display_name,
      weekdays,
      time_off: collapseRanges(timeOffDates),
      times_per_week: timesPerWeek || null,
      preferred_days: sub.preferred_days || null,
    };
  });

  res.json({ employees });
});

// Name duplicate check
app.get('/api/submissions/check-name', (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const session = db.getActiveSession();
  if (!session) return res.json({ taken: false });
  res.json({ taken: db.nameExists(session.id, name) });
});

// Employee submits availability
app.post('/api/submissions', (req, res) => {
  const { token, display_name, availability, preferred_days } = req.body;
  if (!token || !display_name || !availability) {
    return res.status(400).json({ error: 'token, display_name, and availability are required' });
  }
  const session = db.getActiveSession();
  if (!session || session.employee_link_token !== token) {
    return res.status(400).json({ error: 'Invalid or expired link' });
  }

  // Validate availability shape (accepts both legacy {start,end} and new {windows:[]} format)
  for (const [date, slot] of Object.entries(availability)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: `Invalid date: ${date}` });
    }
    if (!slot.available) continue;

    if (slot.windows) {
      // New multi-window format
      for (const w of slot.windows) {
        if (!w.start || !w.end) {
          return res.status(400).json({ error: `Missing start/end in a window for ${date}` });
        }
        if (w.start >= w.end) {
          return res.status(400).json({ error: `Start must be before end for ${date}` });
        }
      }
    } else {
      // Legacy single-window format
      if (!slot.start || !slot.end) {
        return res.status(400).json({ error: `Missing start/end for ${date}` });
      }
      if (slot.start >= slot.end) {
        return res.status(400).json({ error: `start must be before end for ${date}` });
      }
    }
  }

  const parsedPreferred = Number.isInteger(preferred_days) && preferred_days >= 1 && preferred_days <= 5
    ? preferred_days : null;
  const result = db.insertSubmission(session.id, display_name, availability, parsedPreferred);
  if (!result.ok && result.conflict) {
    return res.status(409).json({ error: 'Name already taken' });
  }
  res.status(201).json({ ok: true, employee: display_name });
});

// --- Override parser ---

function parseCountOverrides(considerations, month) {
  const byDate = {};
  const byWeekday = {};
  const [year, mon] = month.split('-').map(Number);

  for (const c of considerations) {
    const lower = c.toLowerCase();

    // "N people on the Xth/Xst/Xnd/Xrd"
    const dateMatch = lower.match(/(\d+)\s+people\s+on\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)/);
    if (dateMatch) {
      const count = parseInt(dateMatch[1], 10);
      const day = parseInt(dateMatch[2], 10);
      const d = new Date(year, mon - 1, day);
      if (d.getMonth() === mon - 1 && count >= 1 && count <= 6) {
        byDate[d.toISOString().slice(0, 10)] = count;
      }
      continue;
    }

    // "N people on [weekday]" or "N people on [weekday]s"
    const wdMatch = lower.match(/(\d+)\s+people\s+on\s+(monday|tuesday|wednesday|thursday|friday)s?/);
    if (wdMatch) {
      const count = parseInt(wdMatch[1], 10);
      const wd = wdMatch[2].charAt(0).toUpperCase() + wdMatch[2].slice(1);
      if (count >= 1 && count <= 6) byWeekday[wd] = count;
    }
  }

  return { byDate, byWeekday };
}

// --- Schedule routes ---

// Generate (or regenerate) schedule
app.post('/api/schedule/generate', async (req, res) => {
  const { modification_note = '' } = req.body;
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });

  const submissions = db.getSubmissions(session.id);
  if (submissions.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 submissions to generate a schedule' });
  }

  const considerations = JSON.parse(session.considerations);
  const avail = parseAvailability(submissions);

  try {
    let schedule;
    if (modification_note && session.schedule) {
      const existing = JSON.parse(session.schedule);
      schedule = await applyModification(existing, submissions, session.month, modification_note, considerations);
      schedule.modification_note = modification_note;
    } else {
      const countOverrides = parseCountOverrides(considerations, session.month);
      const base = generateSchedule(session, submissions, countOverrides);
      schedule = await refineWithCriteria(base, considerations);
    }
    schedule = clampToAvailability(schedule, avail);
    db.updateSchedule(session.id, schedule);
    res.json({ schedule });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Schedule generation failed' });
  }
});

// Get saved schedule
app.get('/api/schedule', (req, res) => {
  const session = db.getActiveSession();
  if (!session) return res.status(404).json({ error: 'No active session' });
  res.json({ schedule: session.schedule ? JSON.parse(session.schedule) : null });
});

// Public schedule view (token-gated, for shared schedule page)
app.get('/api/schedule/public', (req, res) => {
  const { token } = req.query;
  const session = db.getActiveSession();
  if (!session || session.employee_link_token !== token) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  if (!session.schedule) {
    return res.status(404).json({ error: 'Schedule not yet generated' });
  }
  const schedule = JSON.parse(session.schedule);
  const employees = new Set();
  for (const week of schedule.weeks) {
    for (const day of week.days) {
      for (const shift of day.shifts) employees.add(shift.employee);
    }
  }
  res.json({ schedule, employees: [...employees].sort() });
});

// ICS calendar download for one employee
app.get('/api/schedule/ics', (req, res) => {
  const { token, name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  const session = db.getActiveSession();
  if (!session || session.employee_link_token !== token) {
    return res.status(404).json({ error: 'Schedule not found' });
  }
  if (!session.schedule) return res.status(404).json({ error: 'Schedule not yet generated' });
  const schedule = JSON.parse(session.schedule);
  const ics = buildICS(name, schedule);
  const filename = `${name.replace(/\s+/g, '_')}_shifts.ics`;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(ics);
});

// --- Start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Peak PT Scheduler running at http://localhost:${PORT}`));
