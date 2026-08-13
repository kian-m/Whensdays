-- +goose Up
-- Explicit, date-specific availability: which dayparts you're free on concrete
-- upcoming dates (not a recurring "every Tuesday" grid). One row per free cell;
-- the user's set is replaced on each save. Calendar import will later mark busy
-- against these same dates.
CREATE TABLE availability_days (
    user_id text NOT NULL,
    day     date NOT NULL,
    daypart text NOT NULL CHECK (daypart IN ('early_morning', 'morning', 'noon', 'afternoon', 'evening', 'night')),
    PRIMARY KEY (user_id, day, daypart)
);
CREATE INDEX availability_days_user_idx ON availability_days (user_id, day);

-- +goose Down
DROP TABLE availability_days;
