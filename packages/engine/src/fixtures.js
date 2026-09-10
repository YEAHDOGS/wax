/**
 * Fixture builders for tests and demos. Shapes mirror the Discogs payloads
 * the live adapter will normalize (listing id, price, condition, seller) —
 * the public collection `dcruzship` can seed these later, but no fixture here
 * depends on any real account or any network.
 */

export function makeListing(overrides = {}) {
  return {
    id: 'discogs:1001',
    release_id: 'rel_blue_train',
    price_cents: 4500,
    currency: 'USD',
    condition: 'NM',
    available: true,
    url: 'https://www.discogs.com/sell/item/1001',
    seller: 'groove-merchant',
    ...overrides,
  };
}

export function makePressing(overrides = {}) {
  return {
    id: 'discogs:master:501',
    release_id: 'rel_blue_train',
    title: 'Blue Train — 2024 Blue Note Tone Poet reissue',
    format: 'LP',
    released_at: '2024-03-01',
    ...overrides,
  };
}

export function makeMerchItem(overrides = {}) {
  return {
    id: 'merch:tee_42',
    release_id: null,
    merch_type: 'tee',
    title: 'Tone Poet tour tee',
    price_cents: 3500,
    url: null,
    ...overrides,
  };
}

export function makeSnapshot({ listings = [], pressings = [], merch = [], taken_at = '2026-09-10T11:00:00.000Z' } = {}) {
  return {
    listings: Object.fromEntries(listings.map((l) => [l.id, l])),
    pressings: Object.fromEntries(pressings.map((p) => [p.id, p])),
    merch: Object.fromEntries(merch.map((m) => [m.id, m])),
    taken_at,
  };
}

export function makeRule(overrides = {}) {
  return {
    id: 'wtc_1',
    user_id: 'usr_1',
    scope_type: 'artist',
    scope_id: 'art_coltrane',
    watch_vinyl: true,
    merch_types: [],
    target_price_cents: null,
    cooldown_hours: 24,
    channels: ['push'],
    ...overrides,
  };
}
