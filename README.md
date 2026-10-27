# Elbow Rehab

A small web app for a 12-week tennis elbow rehabilitation program. The exercise is eccentric wrist extension for the right arm, with a 3 s down / 3 s up tempo.

| Weeks | Sets × reps |
|-------|-------------|
| 1     | 3 × 15RM    |
| 2–3   | 3 × 12RM    |
| 4–5   | 4 × 10RM    |
| 6–8   | 4 × 8RM     |
| 9–12  | 4 × 6RM     |
| 13+   | 4 × 6RM (optional) |

## Features

- Today view with a weight dial (1 round = 1 kg, 0.1 kg clicks)
- Guided session with tempo countdown, beeps, rest timer and reps per set
- Pain score (0–10) after each session, an optional next-morning check, and a warning above your pain limit
- Progress charts for weight, volume and pain
- Log with editing, CSV export and JSON backup and restore
- Reminders through an iPhone Calendar file (.ics) with repeating events and alerts

## Install on iPhone

1. Open the GitHub Pages address in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open the app from the Home Screen, then go to **Reminders** and download the calendar file.

All data is stored locally on the phone, so use **Export** under Reminders now and then as a backup.

No build step is needed. It's plain HTML, CSS and JavaScript.
