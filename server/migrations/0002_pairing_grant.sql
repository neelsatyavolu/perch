-- Pairing v2: the code is a commitment the new device computes from its public key and a secret it
-- never sends, so the server cannot derive it. The approving device leaves a grant (the approver's
-- key, the recovery public key and, for browsers, the sync keys) sealed to the new device with that
-- secret; the server only passes it along.
ALTER TABLE pairings ADD COLUMN grant_blob TEXT;
