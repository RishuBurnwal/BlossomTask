const FALLBACK_TIMEZONE = "UTC";

export function normalizeTimeZone(timeZone?: string | null): string {
  return timeZone?.trim() || FALLBACK_TIMEZONE;
}

export function formatDateTime(
  value?: string | null,
  timeZone?: string | null,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Never";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: normalizeTimeZone(timeZone),
    ...options,
  }).format(date);
}

export function formatTimeZoneLabel(timeZone?: string | null): string {
  const normalized = normalizeTimeZone(timeZone);
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalized,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const offset = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  return `${offset} | ${normalized}`;
}

export function formatCountdown(seconds?: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "Not scheduled";
  }
  if (seconds <= 0) {
    return "Now";
  }

  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export const GMT_TIMEZONE_OPTIONS = [
  "UTC",
  "Etc/GMT+12",
  "Pacific/Pago_Pago",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/St_Johns",
  "America/Sao_Paulo",
  "Atlantic/South_Georgia",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Athens",
  "Europe/Moscow",
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Kabul",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Yangon",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Pacific/Noumea",
  "Pacific/Auckland",
  "Pacific/Chatham",
  "Pacific/Apia",
  "Pacific/Kiritimati",
];
