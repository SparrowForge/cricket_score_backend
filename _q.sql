SELECT max(completed_at) AS latest, count(*)::int AS completed_matches FROM matches WHERE status='completed';
