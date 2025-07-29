import dotenv from "dotenv";
dotenv.config();
import { existsSync, readFileSync, writeFileSync } from "fs";
import { google } from "googleapis";
import { schedule } from "node-cron";
import http from "http";
import fetch from "node-fetch";
import ical from "ical.js";

// Configuration
const WORK_CALENDAR_ID = process.env.WORK_CALENDAR_ID;
const PERSONAL_CALENDAR_ID = process.env.PERSONAL_CALENDAR_ID;
const NEXTCLOUD_CALENDAR_URL =
  process.env.NEXTCLOUD_CALENDAR_URL ||
  "https://next.psam.im/remote.php/dav/calendars/psamim/samim-work/";
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME;
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD;
const DAYS_TO_SYNC_PAST = parseInt(process.env.DAYS_TO_SYNC_PAST) || 7;
const DAYS_TO_SYNC_FUTURE = parseInt(process.env.DAYS_TO_SYNC_FUTURE) || 30;
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 30;
const WORK_TOKEN_PATH = process.env.WORK_TOKEN_PATH || "tokens/work_token.json";
const PERSONAL_TOKEN_PATH =
  process.env.PERSONAL_TOKEN_PATH || "tokens/personal_token.json";
const EVENT_PREFIX = process.env.EVENT_PREFIX || "";

// Create maps to store synced events for both calendars
const syncedPersonalEvents = new Map();
const syncedNextcloudEvents = new Map();
const SYNCED_PERSONAL_EVENTS_FILE =
  process.env.SYNCED_PERSONAL_EVENTS_FILE || "data/synced_personal_events.json";
const SYNCED_NEXTCLOUD_EVENTS_FILE =
  process.env.SYNCED_NEXTCLOUD_EVENTS_FILE ||
  "data/synced_nextcloud_events.json";

// Load previously synced events if files exist
if (existsSync(SYNCED_PERSONAL_EVENTS_FILE)) {
  const data = JSON.parse(readFileSync(SYNCED_PERSONAL_EVENTS_FILE));
  Object.entries(data).forEach(([key, value]) => {
    syncedPersonalEvents.set(key, value);
  });
  console.log(
    `Loaded ${syncedPersonalEvents.size} previously synced personal events`
  );
}

if (existsSync(SYNCED_NEXTCLOUD_EVENTS_FILE)) {
  const data = JSON.parse(readFileSync(SYNCED_NEXTCLOUD_EVENTS_FILE));
  Object.entries(data).forEach(([key, value]) => {
    syncedNextcloudEvents.set(key, value);
  });
  console.log(
    `Loaded ${syncedNextcloudEvents.size} previously synced Nextcloud events`
  );
}

// Set up OAuth2 authentication
async function getAuthClient(tokenPath, accountType) {
  // Load client secrets from file
  const credentials = JSON.parse(readFileSync("oauth2credentials.json"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check if we have previously stored a token
  try {
    if (existsSync(tokenPath)) {
      const token = JSON.parse(readFileSync(tokenPath));
      oAuth2Client.setCredentials(token);
      return oAuth2Client;
    } else {
      return await getNewToken(oAuth2Client, tokenPath, accountType);
    }
  } catch (error) {
    console.error(`Error loading ${accountType} token:`, error);
    return await getNewToken(oAuth2Client, tokenPath, accountType);
  }
}

// Get new token after prompting for user authorization
async function getNewToken(oAuth2Client, tokenPath, accountType) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent", // Force consent screen to get refresh token
  });

  console.log(
    `\nPlease authorize the ${accountType} calendar account by visiting this URL:`,
    authUrl
  );

  return new Promise((resolve, reject) => {
    const server = http
      .createServer(async (req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");
          const code = url.searchParams.get("code");

          if (code) {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            writeFileSync(tokenPath, JSON.stringify(tokens));
            console.log(`Token stored to ${tokenPath}`);

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              `Authentication successful for ${accountType} calendar! You can close this window and return to the terminal.`
            );

            server.close();
            resolve(oAuth2Client);
          }
        } catch (error) {
          console.error(
            `Error retrieving access token for ${accountType} calendar:`,
            error
          );
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("Authentication failed. Please try again.");
          server.close();
          reject(error);
        }
      })
      .listen(80, () => {
        console.log("Server is listening on port 80");
      });
  });
}

// Get calendar clients
async function getCalendarClients() {
  const workAuth = await getAuthClient(WORK_TOKEN_PATH, "work");
  const personalAuth = await getAuthClient(PERSONAL_TOKEN_PATH, "personal");

  return {
    work: google.calendar({ version: "v3", auth: workAuth }),
    personal: google.calendar({ version: "v3", auth: personalAuth }),
  };
}

// Add rate limiting helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to log timezone information for debugging
function logTimezoneInfo(workEvent, eventType) {
  console.log(
    `${eventType} timezone info for event: ${workEvent.summary || "Untitled"}`
  );
  if (workEvent.start.dateTime) {
    console.log(`  Start: ${workEvent.start.dateTime}`);
    const startDate = new Date(workEvent.start.dateTime);
    console.log(`  Start parsed: ${startDate.toISOString()}`);
  }
  if (workEvent.end.dateTime) {
    console.log(`  End: ${workEvent.end.dateTime}`);
    const endDate = new Date(workEvent.end.dateTime);
    console.log(`  End parsed: ${endDate.toISOString()}`);
  }
}

// CalDAV helper functions for Nextcloud
async function makeCalDAVRequest(
  url,
  method = "GET",
  body = null,
  headers = {}
) {
  const auth = Buffer.from(
    `${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`
  ).toString("base64");

  const requestHeaders = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "text/calendar; charset=utf-8",
    ...headers,
  };

  const options = {
    method,
    headers: requestHeaders,
  };

  if (body) {
    options.body = body;
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error(
        `CalDAV request failed: ${response.status} ${response.statusText}`
      );
    }

    return response;
  } catch (error) {
    console.error("CalDAV request error:", error.message);
    throw error;
  }
}

// Get events from Nextcloud calendar
async function getNextcloudEvents() {
  try {
    const response = await makeCalDAVRequest(NEXTCLOUD_CALENDAR_URL);
    const calendarData = await response.text();

    if (!calendarData.trim()) {
      console.log("Nextcloud calendar is empty");
      return [];
    }

    const calendar = new ical.Component(["vcalendar", [], []]);
    calendar.parseICS(calendarData);

    const events = calendar.getAllSubcomponents("vevent");
    console.log(`Found ${events.length} events in Nextcloud calendar`);

    return events;
  } catch (error) {
    console.error("Error fetching Nextcloud events:", error.message);
    return [];
  }
}

// Create an event in Nextcloud calendar
async function createNextcloudEvent(workEvent) {
  // Skip declined events
  if (
    workEvent.attendees &&
    workEvent.attendees.some((a) => a.self && a.responseStatus === "declined")
  ) {
    console.log(`Skipping declined event for Nextcloud: ${workEvent.summary}`);
    return null;
  }

  // Log timezone information for debugging
  logTimezoneInfo(workEvent, "Creating Nextcloud event");

  try {
    const event = new ical.Event();

    // Set event properties
    event.component.addPropertyWithValue(
      "summary",
      EVENT_PREFIX
        ? `${EVENT_PREFIX} ${workEvent.summary || "Busy"}`
        : workEvent.summary || "Busy"
    );

    if (workEvent.location) {
      event.component.addPropertyWithValue("location", workEvent.location);
    }

    if (workEvent.description) {
      event.component.addPropertyWithValue(
        "description",
        `${workEvent.description}\n\n(Synced from work calendar)`
      );
    } else {
      event.component.addPropertyWithValue(
        "description",
        "Synced from work calendar"
      );
    }

    // Set start and end times with proper timezone handling
    if (workEvent.start.dateTime) {
      // Parse the dateTime string which includes timezone info (e.g., "2024-01-15T10:00:00-05:00")
      const startDate = new Date(workEvent.start.dateTime);

      // Create timezone-aware time object
      const startTime = new ical.Time({
        year: startDate.getFullYear(),
        month: startDate.getMonth() + 1,
        day: startDate.getDate(),
        hour: startDate.getHours(),
        minute: startDate.getMinutes(),
        second: startDate.getSeconds(),
        isDate: false,
      });

      // If the original dateTime has timezone info, preserve it
      if (
        workEvent.start.dateTime.includes("T") &&
        (workEvent.start.dateTime.includes("+") ||
          workEvent.start.dateTime.includes("-"))
      ) {
        // Extract timezone offset from the original string
        const tzMatch = workEvent.start.dateTime.match(/([+-]\d{2}:\d{2})$/);
        if (tzMatch) {
          startTime.timezone = tzMatch[1];
        }
      }

      event.component.addPropertyWithValue("dtstart", startTime);
    }

    if (workEvent.end.dateTime) {
      // Parse the dateTime string which includes timezone info
      const endDate = new Date(workEvent.end.dateTime);

      // Create timezone-aware time object
      const endTime = new ical.Time({
        year: endDate.getFullYear(),
        month: endDate.getMonth() + 1,
        day: endDate.getDate(),
        hour: endDate.getHours(),
        minute: endDate.getMinutes(),
        second: endDate.getSeconds(),
        isDate: false,
      });

      // If the original dateTime has timezone info, preserve it
      if (
        workEvent.end.dateTime.includes("T") &&
        (workEvent.end.dateTime.includes("+") ||
          workEvent.end.dateTime.includes("-"))
      ) {
        // Extract timezone offset from the original string
        const tzMatch = workEvent.end.dateTime.match(/([+-]\d{2}:\d{2})$/);
        if (tzMatch) {
          endTime.timezone = tzMatch[1];
        }
      }

      event.component.addPropertyWithValue("dtend", endTime);
    }

    // Set transparency
    if (workEvent.transparency === "transparent") {
      event.component.addPropertyWithValue("transp", "TRANSPARENT");
    } else {
      event.component.addPropertyWithValue("transp", "OPAQUE");
    }

    // Add custom property to identify as synced event
    event.component.addPropertyWithValue(
      "x-synced-from-work-event",
      workEvent.id
    );

    // Generate unique filename for the event
    const eventId = workEvent.id.replace(/[^a-zA-Z0-9]/g, "_");
    const eventUrl = `${NEXTCLOUD_CALENDAR_URL}${eventId}.ics`;

    // Convert event to iCalendar format with timezone support
    const calendar = new ical.Component(["vcalendar", [], []]);

    // Add timezone component if we have timezone-aware times
    const startTime = event.component.getFirstPropertyValue("dtstart");
    const endTime = event.component.getFirstPropertyValue("dtend");

    if (startTime && startTime.timezone && startTime.timezone !== "UTC") {
      // Add VTIMEZONE component for the timezone
      const tzComponent = new ical.Component(["vtimezone", [], []]);
      tzComponent.addPropertyWithValue("tzid", startTime.timezone);
      calendar.addSubcomponent(tzComponent);
    }

    calendar.addSubcomponent(event.component);
    const icalData = calendar.toString();

    // Log the generated iCal data for debugging
    console.log(
      `Generated iCal data for Nextcloud event: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );
    console.log(`iCal data preview: ${icalData.substring(0, 500)}...`);

    console.log(
      `Attempting to create Nextcloud event: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );

    const response = await makeCalDAVRequest(eventUrl, "PUT", icalData);

    console.log(
      `Created Nextcloud event: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );
    return { id: eventId, url: eventUrl };
  } catch (error) {
    console.error("Error creating Nextcloud event:", error.message);
    return null;
  }
}

// Update an existing Nextcloud event
async function updateNextcloudEvent(eventId, workEvent) {
  // Log timezone information for debugging
  logTimezoneInfo(workEvent, "Updating Nextcloud event");

  try {
    const event = new ical.Event();

    // Set event properties
    event.component.addPropertyWithValue(
      "summary",
      EVENT_PREFIX
        ? `${EVENT_PREFIX} ${workEvent.summary || "Busy"}`
        : workEvent.summary || "Busy"
    );

    if (workEvent.location) {
      event.component.addPropertyWithValue("location", workEvent.location);
    }

    if (workEvent.description) {
      event.component.addPropertyWithValue(
        "description",
        `${workEvent.description}\n\n(Synced from work calendar)`
      );
    } else {
      event.component.addPropertyWithValue(
        "description",
        "Synced from work calendar"
      );
    }

    // Set start and end times with proper timezone handling
    if (workEvent.start.dateTime) {
      // Parse the dateTime string which includes timezone info (e.g., "2024-01-15T10:00:00-05:00")
      const startDate = new Date(workEvent.start.dateTime);

      // Create timezone-aware time object
      const startTime = new ical.Time({
        year: startDate.getFullYear(),
        month: startDate.getMonth() + 1,
        day: startDate.getDate(),
        hour: startDate.getHours(),
        minute: startDate.getMinutes(),
        second: startDate.getSeconds(),
        isDate: false,
      });

      // If the original dateTime has timezone info, preserve it
      if (
        workEvent.start.dateTime.includes("T") &&
        (workEvent.start.dateTime.includes("+") ||
          workEvent.start.dateTime.includes("-"))
      ) {
        // Extract timezone offset from the original string
        const tzMatch = workEvent.start.dateTime.match(/([+-]\d{2}:\d{2})$/);
        if (tzMatch) {
          startTime.timezone = tzMatch[1];
        }
      }

      event.component.addPropertyWithValue("dtstart", startTime);
    }

    if (workEvent.end.dateTime) {
      // Parse the dateTime string which includes timezone info
      const endDate = new Date(workEvent.end.dateTime);

      // Create timezone-aware time object
      const endTime = new ical.Time({
        year: endDate.getFullYear(),
        month: endDate.getMonth() + 1,
        day: endDate.getDate(),
        hour: endDate.getHours(),
        minute: endDate.getMinutes(),
        second: endDate.getSeconds(),
        isDate: false,
      });

      // If the original dateTime has timezone info, preserve it
      if (
        workEvent.end.dateTime.includes("T") &&
        (workEvent.end.dateTime.includes("+") ||
          workEvent.end.dateTime.includes("-"))
      ) {
        // Extract timezone offset from the original string
        const tzMatch = workEvent.end.dateTime.match(/([+-]\d{2}:\d{2})$/);
        if (tzMatch) {
          endTime.timezone = tzMatch[1];
        }
      }

      event.component.addPropertyWithValue("dtend", endTime);
    }

    // Set transparency
    if (workEvent.transparency === "transparent") {
      event.component.addPropertyWithValue("transp", "TRANSPARENT");
    } else {
      event.component.addPropertyWithValue("transp", "OPAQUE");
    }

    // Add custom property to identify as synced event
    event.component.addPropertyWithValue(
      "x-synced-from-work-event",
      workEvent.id
    );

    const eventUrl = `${NEXTCLOUD_CALENDAR_URL}${eventId}.ics`;

    // Convert event to iCalendar format with timezone support
    const calendar = new ical.Component(["vcalendar", [], []]);

    // Add timezone component if we have timezone-aware times
    const startTime = event.component.getFirstPropertyValue("dtstart");
    const endTime = event.component.getFirstPropertyValue("dtend");

    if (startTime && startTime.timezone && startTime.timezone !== "UTC") {
      // Add VTIMEZONE component for the timezone
      const tzComponent = new ical.Component(["vtimezone", [], []]);
      tzComponent.addPropertyWithValue("tzid", startTime.timezone);
      calendar.addSubcomponent(tzComponent);
    }

    calendar.addSubcomponent(event.component);
    const icalData = calendar.toString();

    // Log the generated iCal data for debugging
    console.log(
      `Generated iCal data for Nextcloud event update: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );
    console.log(`iCal data preview: ${icalData.substring(0, 500)}...`);

    console.log(
      `Attempting to update Nextcloud event: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );

    const response = await makeCalDAVRequest(eventUrl, "PUT", icalData);

    console.log(
      `Updated Nextcloud event: ${event.component.getFirstPropertyValue(
        "summary"
      )}`
    );
    return { id: eventId, url: eventUrl };
  } catch (error) {
    console.error("Error updating Nextcloud event:", error.message);
    return null;
  }
}

// Delete an event from Nextcloud calendar
async function deleteNextcloudEvent(eventId) {
  try {
    const eventUrl = `${NEXTCLOUD_CALENDAR_URL}${eventId}.ics`;
    await makeCalDAVRequest(eventUrl, "DELETE");
    console.log(`Deleted Nextcloud event: ${eventId}`);
    return true;
  } catch (error) {
    console.error("Error deleting Nextcloud event:", error.message);
    return false;
  }
}

// Find orphaned Nextcloud events
async function findOrphanedNextcloudEvents(workEvents) {
  const orphanedEvents = [];

  for (const [workId, nextcloudId] of syncedNextcloudEvents.entries()) {
    // Find the corresponding work event if it exists
    const workEvent = workEvents.find((event) => event.id === workId);

    // Consider an event orphaned if:
    // 1. The work event doesn't exist anymore, OR
    // 2. The work event is an all-day event (has date instead of dateTime), OR
    // 3. The work event is declined
    if (!workEvent) {
      console.log(
        `Nextcloud event ${workId} no longer exists in work calendar`
      );
      orphanedEvents.push(nextcloudId);
    } else if (workEvent.start.date !== undefined) {
      console.log(
        `Marking all-day event as orphaned in Nextcloud: ${
          workEvent.summary || "Untitled"
        } (${workEvent.start.date})`
      );
      orphanedEvents.push(nextcloudId);
    } else if (
      workEvent.attendees &&
      workEvent.attendees.some((a) => a.self && a.responseStatus === "declined")
    ) {
      console.log(
        `Marking declined event as orphaned in Nextcloud: ${
          workEvent.summary || "Untitled"
        }`
      );
      orphanedEvents.push(nextcloudId);
    }
  }

  return orphanedEvents;
}

// Save synced events to files
function saveSyncedEvents() {
  const personalData = Object.fromEntries(syncedPersonalEvents);
  writeFileSync(
    SYNCED_PERSONAL_EVENTS_FILE,
    JSON.stringify(personalData, null, 2)
  );
  console.log(
    `Saved ${syncedPersonalEvents.size} synced personal events to file`
  );

  const nextcloudData = Object.fromEntries(syncedNextcloudEvents);
  writeFileSync(
    SYNCED_NEXTCLOUD_EVENTS_FILE,
    JSON.stringify(nextcloudData, null, 2)
  );
  console.log(
    `Saved ${syncedNextcloudEvents.size} synced Nextcloud events to file`
  );
}

// Get events from work calendar
async function getWorkEvents(workCalendar) {
  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setDate(now.getDate() - DAYS_TO_SYNC_PAST);

  const timeMax = new Date(now);
  timeMax.setDate(now.getDate() + DAYS_TO_SYNC_FUTURE);

  console.log(
    `Fetching work events from ${timeMin.toISOString()} to ${timeMax.toISOString()}`
  );

  try {
    const response = await workCalendar.events.list({
      calendarId: WORK_CALENDAR_ID,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    // Filter out all-day events
    const filteredEvents = response.data.items.filter((event) => {
      const isAllDay = event.start.date !== undefined;
      if (isAllDay) {
        console.log(
          `Skipping all-day event: ${event.summary || "Untitled"} (${
            event.start.date
          })`
        );
      }
      return !isAllDay;
    });

    console.log(
      `Filtered out ${
        response.data.items.length - filteredEvents.length
      } all-day events`
    );
    return filteredEvents;
  } catch (error) {
    console.error("Error fetching work events:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return [];
  }
}

// Create an event in personal calendar
async function createPersonalEvent(personalCalendar, workEvent) {
  // Skip declined events
  if (
    workEvent.attendees &&
    workEvent.attendees.some((a) => a.self && a.responseStatus === "declined")
  ) {
    console.log(`Skipping declined event: ${workEvent.summary}`);
    return null;
  }

  // Create a copy of the work event for the personal calendar
  const personalEvent = {
    summary: EVENT_PREFIX
      ? `${EVENT_PREFIX} ${workEvent.summary || "Busy"}`
      : workEvent.summary || "Busy",
    location: workEvent.location,
    description: workEvent.description
      ? `${workEvent.description}\n\n(Synced from work calendar)`
      : "Synced from work calendar",
    start: workEvent.start,
    end: workEvent.end,
    transparency: workEvent.transparency || "opaque",
    reminders: {
      useDefault: false,
    },
    // Add a custom property to identify this as a synced event
    extendedProperties: {
      private: {
        syncedFromWorkEvent: workEvent.id,
      },
    },
  };

  try {
    console.log(`Attempting to create event: ${personalEvent.summary}`);
    const response = await personalCalendar.events.insert({
      calendarId: PERSONAL_CALENDAR_ID,
      resource: personalEvent,
    });

    console.log(`Created event: ${personalEvent.summary}`);
    return response.data;
  } catch (error) {
    console.error("Error creating personal event:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
      if (error.response.data.error?.code === 404) {
        console.error(
          "Calendar not found. Please check your PERSONAL_CALENDAR_ID"
        );
      }
      if (error.response.data.error?.code === 429) {
        console.log("Rate limit hit, waiting 1 second before retrying...");
        await sleep(1000);
        return createPersonalEvent(personalCalendar, workEvent);
      }
    }
    return null;
  }
}

// Update an existing personal event
async function updatePersonalEvent(
  personalCalendar,
  personalEventId,
  workEvent
) {
  // Create an updated version of the personal event
  const updatedEvent = {
    summary: EVENT_PREFIX
      ? `${EVENT_PREFIX} ${workEvent.summary || "Busy"}`
      : workEvent.summary || "Busy",
    location: workEvent.location,
    description: workEvent.description
      ? `${workEvent.description}\n\n(Synced from work calendar)`
      : "Synced from work calendar",
    start: workEvent.start,
    end: workEvent.end,
    transparency: workEvent.transparency || "opaque",
  };

  try {
    const response = await personalCalendar.events.patch({
      calendarId: PERSONAL_CALENDAR_ID,
      eventId: personalEventId,
      resource: updatedEvent,
    });

    console.log(`Updated event: ${updatedEvent.summary}`);
    return response.data;
  } catch (error) {
    console.error("Error updating personal event:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return null;
  }
}

// Delete an event from personal calendar
async function deletePersonalEvent(personalCalendar, eventId) {
  try {
    await personalCalendar.events.delete({
      calendarId: PERSONAL_CALENDAR_ID,
      eventId: eventId,
    });

    console.log(`Deleted event: ${eventId}`);
    return true;
  } catch (error) {
    console.error("Error deleting personal event:", error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return false;
  }
}

// Find synced events that no longer exist in work calendar
async function findOrphanedEvents(workCalendar, workEvents) {
  const orphanedEvents = [];

  for (const [workId, personalId] of syncedPersonalEvents.entries()) {
    // Find the corresponding work event if it exists
    const workEvent = workEvents.find((event) => event.id === workId);

    // Consider an event orphaned if:
    // 1. The work event doesn't exist anymore, OR
    // 2. The work event is an all-day event (has date instead of dateTime), OR
    // 3. The work event is declined
    if (!workEvent) {
      console.log(`Event ${workId} no longer exists in work calendar`);
      orphanedEvents.push(personalId);
    } else if (workEvent.start.date !== undefined) {
      console.log(
        `Marking all-day event as orphaned: ${
          workEvent.summary || "Untitled"
        } (${workEvent.start.date})`
      );
      orphanedEvents.push(personalId);
    } else if (
      workEvent.attendees &&
      workEvent.attendees.some((a) => a.self && a.responseStatus === "declined")
    ) {
      console.log(
        `Marking declined event as orphaned: ${workEvent.summary || "Untitled"}`
      );
      orphanedEvents.push(personalId);
    }
  }

  return orphanedEvents;
}

// Main sync function
async function syncCalendars() {
  console.log("Starting calendar sync...");
  console.log("Using calendar IDs:", {
    work: WORK_CALENDAR_ID,
    personal: PERSONAL_CALENDAR_ID,
    nextcloud: NEXTCLOUD_CALENDAR_URL,
  });

  try {
    const calendars = await getCalendarClients();

    // Get work events
    const workEvents = await getWorkEvents(calendars.work);
    console.log(`Found ${workEvents.length} work events`);

    // Process each work event for both calendars with rate limiting
    for (const workEvent of workEvents) {
      // Sync to Personal Google Calendar
      const existingPersonalEventId = syncedPersonalEvents.get(workEvent.id);
      if (existingPersonalEventId) {
        await updatePersonalEvent(
          calendars.personal,
          existingPersonalEventId,
          workEvent
        );
      } else {
        const newPersonalEvent = await createPersonalEvent(
          calendars.personal,
          workEvent
        );
        if (newPersonalEvent) {
          syncedPersonalEvents.set(workEvent.id, newPersonalEvent.id);
        }
      }

      // Sync to Nextcloud Calendar
      const existingNextcloudEventId = syncedNextcloudEvents.get(workEvent.id);
      if (existingNextcloudEventId) {
        await updateNextcloudEvent(existingNextcloudEventId, workEvent);
      } else {
        const newNextcloudEvent = await createNextcloudEvent(workEvent);
        if (newNextcloudEvent) {
          syncedNextcloudEvents.set(workEvent.id, newNextcloudEvent.id);
        }
      }

      // Add a small delay between operations to avoid rate limits
      await sleep(100);
    }

    // Find and delete orphaned events from Personal Calendar
    const orphanedPersonalEvents = await findOrphanedEvents(
      calendars.work,
      workEvents
    );
    console.log(
      `Found ${orphanedPersonalEvents.length} orphaned personal events to delete`
    );

    for (const personalEventId of orphanedPersonalEvents) {
      const deleted = await deletePersonalEvent(
        calendars.personal,
        personalEventId
      );
      if (deleted) {
        // Find and remove the work event ID from syncedPersonalEvents
        for (const [workId, personalId] of syncedPersonalEvents.entries()) {
          if (personalId === personalEventId) {
            syncedPersonalEvents.delete(workId);
            break;
          }
        }
      }
    }

    // Find and delete orphaned events from Nextcloud Calendar
    const orphanedNextcloudEvents = await findOrphanedNextcloudEvents(
      workEvents
    );
    console.log(
      `Found ${orphanedNextcloudEvents.length} orphaned Nextcloud events to delete`
    );

    for (const nextcloudEventId of orphanedNextcloudEvents) {
      const deleted = await deleteNextcloudEvent(nextcloudEventId);
      if (deleted) {
        // Find and remove the work event ID from syncedNextcloudEvents
        for (const [workId, nextcloudId] of syncedNextcloudEvents.entries()) {
          if (nextcloudId === nextcloudEventId) {
            syncedNextcloudEvents.delete(workId);
            break;
          }
        }
      }
    }

    // Save updated synced events
    saveSyncedEvents();

    console.log("Calendar sync completed successfully");
  } catch (error) {
    console.error("Error during calendar sync:", error);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
  }
}

// Run initial sync
syncCalendars();

// Schedule recurring sync
schedule(`*/${SYNC_INTERVAL_MINUTES} * * * *`, () => {
  console.log(
    `Running scheduled sync (every ${SYNC_INTERVAL_MINUTES} minutes)`
  );
  syncCalendars();
});

console.log(
  `Calendar sync scheduled to run every ${SYNC_INTERVAL_MINUTES} minutes`
);
