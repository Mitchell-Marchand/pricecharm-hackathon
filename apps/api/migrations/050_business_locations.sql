-- Where a business works from: a city, neighborhood or ZIP/postcode as the owner typed it, up to
-- five. The first is kept in businesses.service_area too, so code that reads one area still works.
CREATE TABLE IF NOT EXISTS business_locations (
  id CHAR(36) PRIMARY KEY,
  business_id CHAR(36) NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  area VARCHAR(120) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY business_location_position (business_id, position),
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO business_locations (id, business_id, position, area)
SELECT UUID(), id, 0, LEFT(service_area, 120) FROM businesses
WHERE service_area <> '' AND NOT EXISTS (
  SELECT 1 FROM business_locations WHERE business_locations.business_id = businesses.id
);

-- Setup asks how far an owner travels no more. New businesses start with no limit; a "too far"
-- turn-down in practice, or Settings, sets one.
ALTER TABLE businesses MODIFY COLUMN onboarding_step VARCHAR(20) NOT NULL DEFAULT 'trade';
