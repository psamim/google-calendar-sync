# Google Calendar Sync

A Node.js application that syncs events from your work calendar to both your personal Google calendar and Nextcloud calendar.

## Features

- Syncs events from work calendar to personal Google calendar
- Syncs events from work calendar to Nextcloud calendar via CalDAV
- Handles multiple Google accounts
- Automatic updates and deletions
- Configurable sync interval
- Configurable date range for syncing
- Supports both Google Calendar API and CalDAV protocols

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:

   ```
   # Google Calendar Configuration
   WORK_CALENDAR_ID=your_work_calendar_id
   PERSONAL_CALENDAR_ID=your_personal_calendar_id

   # Nextcloud Calendar Configuration
   NEXTCLOUD_CALENDAR_URL=https://your-nextcloud-instance/remote.php/dav/calendars/username/calendar-name/
   NEXTCLOUD_USERNAME=your_nextcloud_username
   NEXTCLOUD_PASSWORD=your_nextcloud_password

   # Sync Configuration
   DAYS_TO_SYNC_PAST=7
   DAYS_TO_SYNC_FUTURE=30
   SYNC_INTERVAL_MINUTES=30
   EVENT_PREFIX=Work:
   ```

4. Set up OAuth credentials:
   - Go to Google Cloud Console
   - Create a new project
   - Enable Google Calendar API
   - Create OAuth 2.0 credentials for a desktop application
   - Download the credentials and save as `oauth2credentials.json`

## Usage

Run the sync:

```bash
node sync.js
```

The script will:

1. Ask you to authenticate your work calendar account
2. Ask you to authenticate your personal calendar account
3. Start syncing events to both personal Google calendar and Nextcloud calendar
4. Continue syncing at the configured interval

## Configuration

### Google Calendar Settings

- `WORK_CALENDAR_ID`: Your work Google calendar ID
- `PERSONAL_CALENDAR_ID`: Your personal Google calendar ID
- `WORK_TOKEN_PATH`: Path to store work calendar token (default: tokens/work_token.json)
- `PERSONAL_TOKEN_PATH`: Path to store personal calendar token (default: tokens/personal_token.json)

### Nextcloud Calendar Settings

- `NEXTCLOUD_CALENDAR_URL`: Full URL to your Nextcloud calendar (e.g., https://next.psam.im/remote.php/dav/calendars/psamim/samim-work/)
- `NEXTCLOUD_USERNAME`: Your Nextcloud username
- `NEXTCLOUD_PASSWORD`: Your Nextcloud password

### Sync Settings

- `DAYS_TO_SYNC_PAST`: Number of past days to sync (default: 7)
- `DAYS_TO_SYNC_FUTURE`: Number of future days to sync (default: 30)
- `SYNC_INTERVAL_MINUTES`: How often to sync (default: 30)
- `EVENT_PREFIX`: Prefix to add to synced event titles (default: none)

### Data Files

- `SYNCED_PERSONAL_EVENTS_FILE`: Path to store personal calendar sync data (default: data/synced_personal_events.json)
- `SYNCED_NEXTCLOUD_EVENTS_FILE`: Path to store Nextcloud calendar sync data (default: data/synced_nextcloud_events.json)

## How It Works

The script:

1. Fetches events from your work Google calendar
2. For each work event:
   - Creates or updates the event in your personal Google calendar
   - Creates or updates the event in your Nextcloud calendar via CalDAV
3. Removes events from both calendars if they no longer exist in the work calendar
4. Maintains separate tracking files for each calendar to avoid conflicts

## Security

The following files contain sensitive information and are ignored by git:

- `oauth2credentials.json`: OAuth credentials
- `work_token.json`: Work calendar access token
- `personal_token.json`: Personal calendar access token
- `.env`: Environment variables (including Nextcloud credentials)
- `data/synced_personal_events.json`: Personal calendar sync tracking
- `data/synced_nextcloud_events.json`: Nextcloud calendar sync tracking
