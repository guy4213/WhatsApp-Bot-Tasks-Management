/**
 * Microsoft Graph calendar read service (Wave 1 — READ-ONLY).
 *
 * Exports:
 *   listEventsAsUser  — list events for a user's calendar (calendarView or /events)
 *   getEventAsUser    — fetch a single event by Graph event id
 *   normalizeEvent    — map a raw Graph event object to NormalizedEvent
 *
 * Write operations (create / update / delete / respond) are explicitly OUT OF SCOPE.
 * Tokens are never logged or returned.
 */

import { moduleLogger } from '../utils/logger';
import { getAccessToken } from './microsoftAuth';

const logger = moduleLogger('graph-calendar');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NormalizedEvent {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  start: { dateTime: string; timeZone: string } | null;
  end:   { dateTime: string; timeZone: string } | null;
  location: { displayName: string | null; address: string | null } | null;
  locations: Array<{ displayName: string | null; address: string | null }>;
  organizer: { email: string | null; name: string | null } | null;
  isOnlineMeeting: boolean;
  joinUrl: string | null;
  webLink: string | null;
  categories: string[];
  isAllDay: boolean;
  isCancelled: boolean;
  showAs: string | null;         // free/tentative/busy/oof/workingElsewhere/unknown
  sensitivity: string | null;    // normal/personal/private/confidential
  type: string | null;           // singleInstance/occurrence/exception/seriesMaster
  seriesMasterId: string | null;
  recurrence: unknown | null;    // raw Graph recurrence object; not parsed in Wave 1
  lastModifiedDateTime: string | null;
  attendees: Array<{ email: string | null; name: string | null; response: string | null }>;
  raw: unknown;                  // original Graph object, untouched
}

export interface ListEventsOpts {
  startIso?: string;   // ISO 8601 UTC, e.g. "2026-07-14T00:00:00Z"
  endIso?: string;     // ISO 8601 UTC
  top?: number;        // default 50, clamped to [1, 200]
  search?: string;
}

// ── Shared constants ──────────────────────────────────────────────────────────

/**
 * The $select value used by both list and get operations.
 * Kept as a single string constant so it can never drift between the two callers.
 */
const SELECT_FIELDS = [
  'id',
  'subject',
  'bodyPreview',
  'start',
  'end',
  'location',
  'locations',
  'organizer',
  'isOnlineMeeting',
  'onlineMeeting',
  'webLink',
  'attendees',
  'categories',
  'isAllDay',
  'isCancelled',
  'showAs',
  'sensitivity',
  'type',
  'seriesMasterId',
  'recurrence',
  'lastModifiedDateTime',
].join(',');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a raw Graph location object to a flat address string.
 * `raw.location.address` may be an object like
 *   { street, city, state, countryOrRegion, postalCode }
 * or a string, or absent. We concatenate whichever fields exist, separated by
 * ", ", stripping empties. If nothing is present, returns null.
 */
function flattenAddress(addressObj: unknown): string | null {
  if (!addressObj) return null;

  // If Graph returned it as a plain string (uncommon but possible), keep it.
  if (typeof addressObj === 'string') {
    return addressObj.trim() || null;
  }

  if (typeof addressObj !== 'object') return null;

  const a = addressObj as Record<string, unknown>;
  const parts: string[] = [];

  for (const key of ['street', 'city', 'state', 'countryOrRegion', 'postalCode']) {
    const v = a[key];
    if (typeof v === 'string' && v.trim()) {
      parts.push(v.trim());
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

/** Coerce a value that may be undefined/null/non-string to string | null. */
function strOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return null;
}

/**
 * Map a raw Graph location entry (from `location` or `locations[n]`) to our
 * canonical shape.
 */
function normalizeLocationEntry(
  loc: unknown,
): { displayName: string | null; address: string | null } {
  if (!loc || typeof loc !== 'object') {
    return { displayName: null, address: null };
  }
  const l = loc as Record<string, unknown>;
  return {
    displayName: strOrNull(l['displayName']),
    address: flattenAddress(l['address']),
  };
}

// ── normalizeEvent ─────────────────────────────────────────────────────────────

/**
 * Map a raw Microsoft Graph event object to a NormalizedEvent.
 *
 * Defensive: all optional fields fall back to null / empty array.
 * This function must NOT throw on missing or unexpected fields.
 */
export function normalizeEvent(raw: unknown): NormalizedEvent {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('normalizeEvent: raw must be a non-null object');
  }

  const r = raw as Record<string, any>;

  // ── id (required by Graph, but guard defensively) ──────────────────────────
  const id: string = typeof r['id'] === 'string' ? r['id'] : '';

  // ── start / end ────────────────────────────────────────────────────────────
  const start =
    r['start'] && typeof r['start'] === 'object'
      ? {
          dateTime: strOrNull(r['start']['dateTime']) ?? '',
          timeZone: strOrNull(r['start']['timeZone']) ?? '',
        }
      : null;

  const end =
    r['end'] && typeof r['end'] === 'object'
      ? {
          dateTime: strOrNull(r['end']['dateTime']) ?? '',
          timeZone: strOrNull(r['end']['timeZone']) ?? '',
        }
      : null;

  // ── location / locations ───────────────────────────────────────────────────
  const location = r['location'] ? normalizeLocationEntry(r['location']) : null;

  const rawLocations: unknown[] = Array.isArray(r['locations']) ? r['locations'] : [];
  const locations = rawLocations.map(normalizeLocationEntry);

  // ── organizer ──────────────────────────────────────────────────────────────
  const orgEmail = r['organizer'];
  const organizer =
    orgEmail && typeof orgEmail === 'object'
      ? {
          email: strOrNull((orgEmail as Record<string, any>)['emailAddress']?.['address']),
          name:  strOrNull((orgEmail as Record<string, any>)['emailAddress']?.['name']),
        }
      : null;

  // ── attendees ──────────────────────────────────────────────────────────────
  const rawAttendees: unknown[] = Array.isArray(r['attendees']) ? r['attendees'] : [];
  const attendees = rawAttendees.map((a: unknown) => {
    if (!a || typeof a !== 'object') {
      return { email: null, name: null, response: null };
    }
    const att = a as Record<string, any>;
    return {
      email:    strOrNull(att['emailAddress']?.['address']),
      name:     strOrNull(att['emailAddress']?.['name']),
      response: strOrNull(att['status']?.['response']),
    };
  });

  // ── online meeting / join URL ─────────────────────────────────────────────
  const joinUrl: string | null =
    r['onlineMeeting'] && typeof r['onlineMeeting'] === 'object'
      ? strOrNull((r['onlineMeeting'] as Record<string, any>)['joinUrl'])
      : null;

  // ── categories ────────────────────────────────────────────────────────────
  const categories: string[] = Array.isArray(r['categories'])
    ? (r['categories'] as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  return {
    id,
    subject:              strOrNull(r['subject']),
    bodyPreview:          strOrNull(r['bodyPreview']),
    start,
    end,
    location,
    locations,
    organizer,
    isOnlineMeeting:      r['isOnlineMeeting'] === true,
    joinUrl,
    webLink:              strOrNull(r['webLink']),
    categories,
    isAllDay:             r['isAllDay'] === true,
    isCancelled:          r['isCancelled'] === true,
    showAs:               strOrNull(r['showAs']),
    sensitivity:          strOrNull(r['sensitivity']),
    type:                 strOrNull(r['type']),
    seriesMasterId:       strOrNull(r['seriesMasterId']),
    recurrence:           r['recurrence'] !== undefined ? (r['recurrence'] ?? null) : null,
    lastModifiedDateTime: strOrNull(r['lastModifiedDateTime']),
    attendees,
    raw,
  };
}

// ── listEventsAsUser ──────────────────────────────────────────────────────────

/**
 * List calendar events for the given user.
 *
 * Uses calendarView (with date filter) when both startIso and endIso are
 * supplied; otherwise falls back to /me/events.
 *
 * $search requires ConsistencyLevel: eventual — added automatically.
 */
export async function listEventsAsUser(
  userId: string,
  opts: ListEventsOpts,
): Promise<NormalizedEvent[]> {
  const token = await getAccessToken(userId);

  const top = Math.min(Math.max(opts.top ?? 50, 1), 200);

  // Build base URL + mandatory query params
  let url: string;
  if (opts.startIso && opts.endIso) {
    url =
      `${GRAPH_BASE}/me/calendarView` +
      `?startDateTime=${encodeURIComponent(opts.startIso)}` +
      `&endDateTime=${encodeURIComponent(opts.endIso)}` +
      `&$orderby=start%2FdateTime` +
      `&$top=${top}` +
      `&$select=${encodeURIComponent(SELECT_FIELDS)}`;
  } else {
    url =
      `${GRAPH_BASE}/me/events` +
      `?$orderby=start%2FdateTime` +
      `&$top=${top}` +
      `&$select=${encodeURIComponent(SELECT_FIELDS)}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  // $search: strip double-quote chars to prevent injection, wrap in quotes per Graph spec
  if (opts.search && opts.search.trim() !== '') {
    const sanitized = opts.search.replace(/"/g, '');
    url += `&$search="${encodeURIComponent(sanitized)}"`;
    headers['ConsistencyLevel'] = 'eventual';
  }

  const res = await fetch(url, { headers });

  if (res.status === 403) {
    logger.error({ status: 403 }, 'Graph calendar list forbidden');
    throw new Error(
      'אין הרשאת יומן ל-Outlook — יש להתחבר מחדש כדי לאשר את הרשאת היומן (Calendars.ReadWrite)',
    );
  }

  if (!res.ok) {
    logger.error({ status: res.status }, 'Graph calendar list failed');
    throw new Error(`Graph API request failed with status ${res.status}`);
  }

  const data = (await res.json()) as { value?: unknown[] };
  const items = Array.isArray(data.value) ? data.value : [];
  return items.map(normalizeEvent);
}

// ── getEventAsUser ────────────────────────────────────────────────────────────

/**
 * Fetch a single calendar event by its Graph event ID for the given user.
 */
export async function getEventAsUser(
  userId: string,
  eventId: string,
): Promise<NormalizedEvent> {
  const token = await getAccessToken(userId);

  const url =
    `${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}` +
    `?$select=${encodeURIComponent(SELECT_FIELDS)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const res = await fetch(url, { headers });

  if (res.status === 403) {
    logger.error({ status: 403 }, 'Graph calendar get forbidden');
    throw new Error(
      'אין הרשאת יומן ל-Outlook — יש להתחבר מחדש כדי לאשר את הרשאת היומן (Calendars.ReadWrite)',
    );
  }

  if (res.status === 404) {
    logger.error({ status: 404 }, 'Graph calendar event not found');
    throw new Error('האירוע לא נמצא ביומן');
  }

  if (!res.ok) {
    logger.error({ status: res.status }, 'Graph calendar get failed');
    throw new Error(`Graph API request failed with status ${res.status}`);
  }

  const data = await res.json();
  return normalizeEvent(data);
}

// ── createEventAsUser ─────────────────────────────────────────────────────────

export interface CreateEventInput {
  subject: string;
  /** ISO 8601 local wall time, e.g. "2026-07-15T10:00:00" (no Z). */
  startIso: string;
  /** ISO 8601 local wall time. */
  endIso: string;
  /** IANA timezone the start/end are expressed in. Default Asia/Jerusalem. */
  timeZone?: string;
  location?: string | null;
  /** Plain-text body/notes. */
  body?: string | null;
}

/**
 * VOICE-3: Create a calendar event on the linked Outlook account of `userId`.
 * POST /me/events with the same token helper the read paths use — requires the
 * already-granted Calendars.ReadWrite scope. Returns the normalized event.
 */
export async function createEventAsUser(
  userId: string,
  input: CreateEventInput,
): Promise<NormalizedEvent> {
  const token = await getAccessToken(userId);
  const tz = input.timeZone ?? 'Asia/Jerusalem';

  const res = await fetch(`${GRAPH_BASE}/me/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      subject: input.subject,
      start: { dateTime: input.startIso, timeZone: tz },
      end: { dateTime: input.endIso, timeZone: tz },
      ...(input.location ? { location: { displayName: input.location } } : {}),
      ...(input.body ? { body: { contentType: 'text', content: input.body } } : {}),
    }),
  });

  if (res.status === 403) {
    logger.error({ status: 403 }, 'Graph calendar create forbidden');
    throw new Error(
      'אין הרשאת יומן ל-Outlook — יש להתחבר מחדש כדי לאשר את הרשאת היומן (Calendars.ReadWrite)',
    );
  }

  if (!res.ok) {
    logger.error({ status: res.status }, 'Graph calendar create failed');
    throw new Error(`Graph API request failed with status ${res.status}`);
  }

  const data = await res.json();
  return normalizeEvent(data);
}
