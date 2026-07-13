-- +goose Up
-- Idempotency ledger for once-per-day cron jobs that send a single email (the
-- owner analytics digest). Scheduler retries + manual triggers must never send
-- the same day's email twice: the job atomically claims (job, run_day) before
-- sending, and a duplicate attempt gets no row back and skips.
CREATE TABLE cron_run_claims (
    job text NOT NULL,
    run_day date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (job, run_day)
);

-- +goose Down
DROP TABLE cron_run_claims;
