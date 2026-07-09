-- ===================== post-event recap ===========================

-- name: ListEventsNeedingRecap :many
-- Events that happened on the PREVIOUS Pacific calendar day and haven't been
-- recapped — the day-after "how was it? plan the next one" email, sent by the
-- same daily 2pm-Pacific cron as reminders.
SELECT id, host_id, title, event_type, description,
       location_mode, location_address, scheduling_mode, starts_at, status, created_at, comments_enabled, group_id, series_id, recurrence, reminder_sent, visibility, topic, city, custom_emoji, custom_label, general_scope, photo_url, theme, timezone, ends_at, poll_deadline, poll_ready_sent, vote_reminder_sent, quorum_sent
FROM events
WHERE status = 'scheduled'
  AND (starts_at AT TIME ZONE 'America/Los_Angeles')::date
      = ((now() AT TIME ZONE 'America/Los_Angeles')::date - 1)
  AND NOT EXISTS (SELECT 1 FROM event_recaps rc WHERE rc.event_id = events.id);

-- name: MarkRecapSent :exec
INSERT INTO event_recaps (event_id) VALUES ($1) ON CONFLICT DO NOTHING;
