/**
 * Deterministic itinerary stop classification for Track.cruises ports_list.
 */

function normaliseLabel(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEA_PATTERNS = [
  /^at sea$/,
  /^sea day$/,
  /^day at sea$/,
  /^fun day at sea$/,
  /^cruising$/,
  /^en route$/,
  /^sailing$/,
  /^cross(ing)? international date line$/,
  /^international date line$/
];

/**
 * @param {string} providerPortName
 * @returns {boolean}
 */
function isSeaDayLabel(providerPortName) {
  const n = normaliseLabel(providerPortName);
  if (!n) return false;
  return SEA_PATTERNS.some((re) => re.test(n));
}

/**
 * Scenic cruising / glacier / passage cruising (not a pier call).
 * @param {string} providerPortName
 * @returns {boolean}
 */
function isScenicCruisingLabel(providerPortName) {
  const raw = String(providerPortName || "");
  const n = normaliseLabel(raw);
  if (!n || isSeaDayLabel(raw)) return false;
  if (/scenic\s+cruis/.test(n)) return true;
  if (/\(\s*scenic/.test(raw.toLowerCase())) return true;
  if (/glacier/.test(n) && /cruis/.test(n)) return true;
  if (/hubbard glacier/.test(n)) return true;
  if (/tracy arm/.test(n)) return true;
  if (/inside passage/.test(n) && /cruis/.test(n)) return true;
  if (/glacier bay/.test(n)) return true;
  if (/scenic cruising/.test(raw.toLowerCase())) return true;
  if (/panama canal/.test(n)) return true;
  if (/full transit/.test(n)) return true;
  return false;
}

/**
 * Classify ordered ports_list entries.
 * @param {Array<{port?: string, day?: number|string}>} portsList
 * @returns {Array<{ dayNumber: number|null, providerPortName: string|null, type: string }>}
 */
function classifyPortsList(portsList) {
  const items = Array.isArray(portsList) ? portsList : [];
  const prepared = items.map((item, index) => {
    const providerPortName = String(item?.port || item?.name || item?.port_name || "").trim() || null;
    const dayRaw = item?.day ?? item?.day_number ?? item?.dayNumber;
    const dayNumber =
      dayRaw == null || dayRaw === "" ? index + 1 : Number(dayRaw);
    return {
      dayNumber: Number.isFinite(dayNumber) ? dayNumber : index + 1,
      providerPortName,
      index
    };
  });

  const realPortIndexes = prepared
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => {
      if (!row.providerPortName) return false;
      if (isSeaDayLabel(row.providerPortName)) return false;
      if (isScenicCruisingLabel(row.providerPortName)) return false;
      return true;
    })
    .map(({ i }) => i);

  const firstReal = realPortIndexes.length ? realPortIndexes[0] : -1;
  const lastReal = realPortIndexes.length ? realPortIndexes[realPortIndexes.length - 1] : -1;

  return prepared.map((row) => {
    const name = row.providerPortName;
    if (!name) {
      return { dayNumber: row.dayNumber, providerPortName: null, type: "port" };
    }
    if (isSeaDayLabel(name)) {
      return { dayNumber: row.dayNumber, providerPortName: name, type: "sea" };
    }
    if (isScenicCruisingLabel(name)) {
      return { dayNumber: row.dayNumber, providerPortName: name, type: "scenic_cruising" };
    }
    if (row.index === firstReal) {
      return { dayNumber: row.dayNumber, providerPortName: name, type: "embarkation" };
    }
    if (row.index === lastReal) {
      return { dayNumber: row.dayNumber, providerPortName: name, type: "disembarkation" };
    }
    return { dayNumber: row.dayNumber, providerPortName: name, type: "port" };
  });
}

module.exports = {
  normaliseLabel,
  isSeaDayLabel,
  isScenicCruisingLabel,
  classifyPortsList
};
