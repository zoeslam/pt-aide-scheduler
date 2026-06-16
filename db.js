const fs = require('fs');
const path = require('path');

// Store data in a JSON file next to the server (or at DB_PATH with .json extension)
const DATA_PATH = process.env.DB_PATH
  ? process.env.DB_PATH.replace(/\.db$/, '.json')
  : path.join(__dirname, 'data.json');

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { sessions: [], submissions: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// --- Session helpers ---

function getActiveSession() {
  const data = readData();
  return data.sessions.length ? data.sessions[data.sessions.length - 1] : null;
}

function createSession(month, token) {
  const data = readData();
  // Remove any prior session for this month and its submissions (clean slate)
  const old = data.sessions.find(s => s.month === month);
  if (old) {
    data.sessions = data.sessions.filter(s => s.month !== month);
    data.submissions = data.submissions.filter(s => s.session_id !== old.id);
  }
  const session = {
    id: Date.now(),
    month,
    status: 'collecting',
    considerations: '[]',
    schedule: null,
    employee_link_token: token,
    created_at: new Date().toISOString(),
  };
  data.sessions.push(session);
  writeData(data);
  return session;
}

function updateConsiderations(sessionId, considerations) {
  const data = readData();
  const session = data.sessions.find(s => s.id === sessionId);
  if (session) {
    session.considerations = JSON.stringify(considerations);
    writeData(data);
  }
}

function updateSchedule(sessionId, schedule) {
  const data = readData();
  const session = data.sessions.find(s => s.id === sessionId);
  if (session) {
    session.schedule = JSON.stringify(schedule);
    session.status = 'generated';
    writeData(data);
  }
}

// --- Submission helpers ---

function getSubmissions(sessionId) {
  const data = readData();
  return data.submissions.filter(s => s.session_id === sessionId);
}

function getSubmissionCount(sessionId) {
  return getSubmissions(sessionId).length;
}

function nameExists(sessionId, name) {
  const data = readData();
  return data.submissions.some(
    s => s.session_id === sessionId && s.employee_name === name.toLowerCase().trim()
  );
}

function insertSubmission(sessionId, displayName, availability, preferredDays) {
  const data = readData();
  const key = displayName.toLowerCase().trim();
  const duplicate = data.submissions.some(
    s => s.session_id === sessionId && s.employee_name === key
  );
  if (duplicate) return { ok: false, conflict: true };

  data.submissions.push({
    id: Date.now() + Math.random(),
    session_id: sessionId,
    employee_name: key,
    display_name: displayName,
    availability: JSON.stringify(availability),
    preferred_days: preferredDays || null,
    submitted_at: new Date().toISOString(),
  });
  writeData(data);
  return { ok: true };
}

function deleteSubmission(sessionId, displayName) {
  const data = readData();
  const key = displayName.toLowerCase().trim();
  const before = data.submissions.length;
  data.submissions = data.submissions.filter(
    s => !(s.session_id === sessionId && s.employee_name === key)
  );
  if (data.submissions.length === before) return false;
  writeData(data);
  return true;
}

module.exports = {
  getActiveSession,
  createSession,
  updateConsiderations,
  updateSchedule,
  getSubmissions,
  getSubmissionCount,
  nameExists,
  insertSubmission,
  deleteSubmission,
};
