DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'warning_type'
      AND e.enumlabel = 'navigation_blocked'
  ) THEN
    ALTER TYPE warning_type ADD VALUE 'navigation_blocked';
  END IF;
END$$;
