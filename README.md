# Google Calendar Sync

A Node.js application that syncs events from your work calendar to your personal calendar.

## Features

- Syncs events from work calendar to personal calendar
- Handles multiple Google accounts
- Automatic updates and deletions
- Configurable sync interval
- Configurable date range for syncing

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   WORK_CALENDAR_ID=your_work_calendar_id
   PERSONAL_CALENDAR_ID=your_personal_calendar_id
   DAYS_TO_SYNC_PAST=7
   DAYS_TO_SYNC_FUTURE=30
   SYNC_INTERVAL_MINUTES=30
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
3. Start syncing events
4. Continue syncing at the configured interval

## Configuration

- `DAYS_TO_SYNC_PAST`: Number of past days to sync (default: 7)
- `DAYS_TO_SYNC_FUTURE`: Number of future days to sync (default: 30)
- `SYNC_INTERVAL_MINUTES`: How often to sync (default: 30)

## Security

The following files contain sensitive information and are ignored by git:

- `oauth2credentials.json`: OAuth credentials
- `work_token.json`: Work calendar access token
- `personal_token.json`: Personal calendar access token
- `.env`: Environment variables
