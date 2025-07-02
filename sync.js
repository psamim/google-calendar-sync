import dotenv from "dotenv";
dotenv.config();
import { existsSync, readFileSync, writeFileSync } from "fs";
import { google } from "googleapis";
import { schedule } from "node-cron";
import http from "http";

// Configuration
const WORK_CALENDAR_ID = process.env.WORK_CALENDAR_ID;
const PERSONAL_CALENDAR_ID = process.env.PERSONAL_CALENDAR_ID;
const DAYS_TO_SYNC_PAST = parseInt(process.env.DAYS_TO_SYNC_PAST) || 7;
const DAYS_TO_SYNC_FUTURE = parseInt(process.env.DAYS_TO_SYNC_FUTURE) || 30;
const SYNC_INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 30;
const WORK_TOKEN_PATH = process.env.WORK_TOKEN_PATH || "tokens/work_token.json";
const PERSONAL_TOKEN_PATH =
  process.env.PERSONAL_TOKEN_PATH || "tokens/personal_token.json";
const EVENT_PREFIX = process.env.EVENT_PREFIX || "";

// Create a map to store synced events
const syncedEvents = new Map();
const SYNCED_EVENTS_FILE =
  process.env.SYNCED_EVENTS_FILE || "data/synced_events.json";

// Load previously synced events if file exists
if (existsSync(SYNCED_EVENTS_FILE)) {
  const data = JSON.parse(readFileSync(SYNCED_EVENTS_FILE));
  Object.entries(data).forEach(([key, value]) => {
    syncedEvents.set(key, value);
  });
  console.log(`Loaded ${syncedEvents.size} previously synced events`);
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

  for (const [workId, personalId] of syncedEvents.entries()) {
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

// Save synced events to file
function saveSyncedEvents() {
  const data = Object.fromEntries(syncedEvents);
  writeFileSync(SYNCED_EVENTS_FILE, JSON.stringify(data, null, 2));
  console.log(`Saved ${syncedEvents.size} synced events to file`);
}

// Main sync function
async function syncCalendars() {
  console.log("Starting calendar sync...");
  console.log("Using calendar IDs:", {
    work: WORK_CALENDAR_ID,
    personal: PERSONAL_CALENDAR_ID,
  });

  try {
    const calendars = await getCalendarClients();

    // Get work events
    const workEvents = await getWorkEvents(calendars.work);
    console.log(`Found ${workEvents.length} work events`);

    // Process each work event with rate limiting
    for (const workEvent of workEvents) {
      const existingPersonalEventId = syncedEvents.get(workEvent.id);

      if (existingPersonalEventId) {
        // Update existing event
        await updatePersonalEvent(
          calendars.personal,
          existingPersonalEventId,
          workEvent
        );
      } else {
        // Create new event
        const newEvent = await createPersonalEvent(
          calendars.personal,
          workEvent
        );
        if (newEvent) {
          syncedEvents.set(workEvent.id, newEvent.id);
        }
      }
      // Add a small delay between operations to avoid rate limits
      await sleep(100);
    }

    // Find and delete orphaned events
    const orphanedEvents = await findOrphanedEvents(calendars.work, workEvents);
    console.log(`Found ${orphanedEvents.length} orphaned events to delete`);

    for (const personalEventId of orphanedEvents) {
      const deleted = await deletePersonalEvent(
        calendars.personal,
        personalEventId
      );
      if (deleted) {
        // Find and remove the work event ID from syncedEvents
        for (const [workId, personalId] of syncedEvents.entries()) {
          if (personalId === personalEventId) {
            syncedEvents.delete(workId);
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
