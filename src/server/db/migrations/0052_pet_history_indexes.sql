-- Current room reads and keyset dex pages must not scan retained care/pet history.
CREATE INDEX pet_cares_latest_feed_idx
  ON public.pet_cares (tenant_id, student_id, created_at DESC)
  WHERE kind = 'FEED';

CREATE INDEX pets_graduated_history_idx
  ON public.pets (tenant_id, student_id, graduated_at DESC, pet_id DESC)
  WHERE status = 'GRADUATED';

-- One indexed latest representative per species/color, at most 28 probes.
CREATE INDEX pets_graduated_collection_idx
  ON public.pets (tenant_id, student_id, species, color, graduated_at DESC, pet_id DESC)
  WHERE status = 'GRADUATED';
