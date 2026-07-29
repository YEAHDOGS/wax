/**
 * @file The demo dataset.
 *
 * Every row the app shows before anybody has typed anything comes from here.
 * Two rules govern this file:
 *
 * 1. **The audio is real.** The eleven tracks below are the DOGS catalog,
 *    hosted at `data.wearedogs.net`, cleared for use in this product. Their
 *    titles, artists, albums, cover art and years are the real metadata. The
 *    player is not miming — it streams these files.
 *
 * 2. **The vinyl data is synthetic and says so.** Pressing quantities, listing
 *    prices, catalog numbers and detection timings are invented. The UI marks
 *    every surface carrying them, because a collector making a $200 decision
 *    must never mistake a demo figure for a real listing.
 *
 * Timestamps are generated *relative to load*, not hardcoded. An alert board
 * whose newest entry is four months old does not demonstrate a real-time alert
 * pipeline; one whose newest entry landed 38 seconds ago does.
 *
 * @see ./schema.sql for the tables these fill
 * @see ./types.js for the shape of every record
 */

/** Origin serving the DOGS audio and cover art. */
const DATA = 'https://data.wearedogs.net';

/** Module load time. Every relative timestamp below is measured back from here. */
const NOW = Date.now();

/**
 * An ISO instant `secondsAgo` seconds before load.
 * @param {number} secondsAgo
 * @returns {import('./types.js').Timestamp}
 */
const ago = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

/** Seconds in a day, for readability at the call site. */
const DAY = 86400;

// ------------------------------------------------------------------ artists

/** @type {import('./types.js').Artist[]} */
export const artists = [
  { id: 'art_yg',        name: 'YG',                    discogs_artist_id: 2277573, image_url: null, genres: ['Hip-Hop'],                created_at: ago(400 * DAY) },
  { id: 'art_mj',        name: 'Michael Jackson',       discogs_artist_id: 15885,   image_url: null, genres: ['Pop', 'Soul'],            created_at: ago(400 * DAY) },
  { id: 'art_zedsdead',  name: 'Zeds Dead',             discogs_artist_id: 1633096, image_url: null, genres: ['Electronic', 'Dubstep'],  created_at: ago(400 * DAY) },
  { id: 'art_buddha',    name: 'The Buddha-Bar Lounge', discogs_artist_id: null,    image_url: null, genres: ['Lounge', 'Downtempo'],    created_at: ago(400 * DAY) },
  { id: 'art_dasracist', name: 'Das Racist',            discogs_artist_id: 1502233, image_url: null, genres: ['Hip-Hop'],                created_at: ago(400 * DAY) },
  { id: 'art_tobyfox',   name: 'Toby Fox',              discogs_artist_id: 4859381, image_url: null, genres: ['Video Game', 'Soundtrack'], created_at: ago(400 * DAY) },
  { id: 'art_deadmau5',  name: 'deadmau5',              discogs_artist_id: 68632,   image_url: null, genres: ['Electronic', 'Progressive House'], created_at: ago(400 * DAY) },
  { id: 'art_travis',    name: 'Travis Scott',          discogs_artist_id: 3195561, image_url: null, genres: ['Hip-Hop'],                created_at: ago(400 * DAY) },
  { id: 'art_sonnet',    name: 'Sweet Boy Sonnet',      discogs_artist_id: null,    image_url: null, genres: ['Electronic'],             created_at: ago(400 * DAY) },
  { id: 'art_nxnja',     name: 'Nxnja',                 discogs_artist_id: null,    image_url: null, genres: ['Hip-Hop', 'Beats'],       created_at: ago(400 * DAY) },
  { id: 'art_sensor',    name: 'Trevor Sensor',         discogs_artist_id: 5253119, image_url: null, genres: ['Indie Rock', 'Folk'],     created_at: ago(400 * DAY) },
  // No audio, but the reason the product exists.
  { id: 'art_bt',        name: 'BT',                    discogs_artist_id: 6262,    image_url: null, genres: ['Electronic', 'Ambient'],  created_at: ago(400 * DAY) },
  { id: 'art_bonobo',    name: 'Bonobo',                discogs_artist_id: 12345,   image_url: null, genres: ['Electronic', 'Downtempo'], created_at: ago(400 * DAY) },
  { id: 'art_aphex',     name: 'Aphex Twin',            discogs_artist_id: 45,      image_url: null, genres: ['Electronic', 'IDM'],      created_at: ago(400 * DAY) },
];

// ----------------------------------------------------------------- releases

/**
 * Cover art URL for a DOGS catalog slug.
 * @param {string} slug
 * @param {'webp'|'png'|'jpg'} [ext]
 */
const cover = (slug, ext = 'webp') => `${DATA}/img/covers/2026/${slug}.${ext}`;

/**
 * The catalog. The first eleven correspond to the audio below and carry real
 * cover art; the remainder exist so the alert board and price watch have
 * pressings to talk about that nothing streams from.
 *
 * @type {import('./types.js').Release[]}
 */
export const releases = [
  {
    id: 'rel_gentlemens', cat: 'WAX 4101', artist_id: 'art_yg',
    title: "THE GENTLEMEN'S CLUB", year: 2026, label: '4Hunnid', label_cat: '4H-026',
    format: '2xLP', variant: 'Gold /1000', pressing_qty: 1000,
    cover_url: cover('yg'), ink: 'ink', discogs_release_id: null,
    released_at: ago(34 * DAY), created_at: ago(34 * DAY),
  },
  {
    id: 'rel_xscape', cat: 'WAX 4102', artist_id: 'art_mj',
    title: 'Xscape', year: 2014, label: 'Epic', label_cat: '88843 05215 1',
    format: 'LP', variant: 'Black', pressing_qty: null,
    cover_url: cover('mj'), ink: 'ink', discogs_release_id: 5763331,
    released_at: ago(300 * DAY), created_at: ago(300 * DAY),
  },
  {
    id: 'rel_return', cat: 'WAX 4103', artist_id: 'art_zedsdead',
    title: 'Return to the Return (of the Spectrum of Intergalactic Happiness)',
    year: 2026, label: 'Deadbeats', label_cat: 'DBR-114',
    format: '2xLP', variant: 'Splatter /500', pressing_qty: 500,
    cover_url: cover('zd'), ink: 'ultramarine', discogs_release_id: null,
    released_at: ago(21 * DAY), created_at: ago(21 * DAY),
  },
  {
    id: 'rel_denchai', cat: 'WAX 4104', artist_id: 'art_buddha',
    title: 'Den Chai', year: 2008, label: 'George V', label_cat: 'GV-2008',
    format: 'LP', variant: 'Black', pressing_qty: null,
    cover_url: cover('buddha'), ink: 'cyan', discogs_release_id: null,
    released_at: ago(360 * DAY), created_at: ago(360 * DAY),
  },
  {
    id: 'rel_shutup', cat: 'WAX 4105', artist_id: 'art_dasracist',
    title: 'Shut Up, Dude', year: 2010, label: 'Greedhead', label_cat: 'GH-004',
    format: '2xLP', variant: 'Clear /300', pressing_qty: 300,
    cover_url: cover('rainbow'), ink: 'chartreuse', discogs_release_id: null,
    released_at: ago(120 * DAY), created_at: ago(120 * DAY),
  },
  {
    id: 'rel_deltarune', cat: 'WAX 4106', artist_id: 'art_tobyfox',
    title: 'Deltarune', year: 2021, label: 'Materia Collective', label_cat: 'MTR-DR1',
    format: '4xLP', variant: 'Box Set', pressing_qty: 2000,
    cover_url: cover('deltarune'), ink: 'ink', discogs_release_id: null,
    released_at: ago(200 * DAY), created_at: ago(200 * DAY),
  },
  {
    id: 'rel_atgh', cat: 'WAX 4107', artist_id: 'art_deadmau5',
    title: '> album title goes here <', year: 2026, label: 'mau5trap', label_cat: 'MAU5-050',
    format: '2xLP', variant: 'Picture Disc', pressing_qty: 750,
    cover_url: cover('sleepless'), ink: 'ultramarine', discogs_release_id: null,
    released_at: ago(9 * DAY), created_at: ago(9 * DAY),
  },
  {
    id: 'rel_utopia', cat: 'WAX 4108', artist_id: 'art_travis',
    title: 'UTOPIA', year: 2023, label: 'Cactus Jack', label_cat: 'CJ-2023',
    format: '2xLP', variant: 'Silver /1500', pressing_qty: 1500,
    cover_url: cover('utopia'), ink: 'ink', discogs_release_id: null,
    released_at: ago(150 * DAY), created_at: ago(150 * DAY),
  },
  {
    id: 'rel_wheredoi', cat: 'WAX 4109', artist_id: 'art_sonnet',
    title: 'Where do I put my love?', year: 2026, label: 'DOGS', label_cat: 'DOGS-007',
    format: 'LP', variant: 'Translucent Red /200', pressing_qty: 200,
    cover_url: cover('slow'), ink: 'vermilion', discogs_release_id: null,
    released_at: ago(2 * DAY), created_at: ago(2 * DAY),
  },
  {
    id: 'rel_arigato', cat: 'WAX 4110', artist_id: 'art_nxnja',
    title: 'ARIGATO', year: 2026, label: 'Nxnja', label_cat: 'NXJ-001',
    format: '12"', variant: 'White Label /100', pressing_qty: 100,
    cover_url: cover('arigato'), ink: 'chartreuse', discogs_release_id: null,
    released_at: ago(5 * DAY), created_at: ago(5 * DAY),
  },
  {
    id: 'rel_exile2', cat: 'WAX 4111', artist_id: 'art_sensor',
    title: 'On Account of Exile, Vol. 2', year: 2021, label: 'Jagjaguwar', label_cat: 'JAG-341',
    format: 'LP', variant: 'Black', pressing_qty: null,
    cover_url: cover('exile'), ink: 'ink', discogs_release_id: null,
    released_at: ago(240 * DAY), created_at: ago(240 * DAY),
  },

  // -- Pressings with no audio. These carry the alert board's live states. --
  {
    id: 'rel_tbu', cat: 'WAX 4112', artist_id: 'art_bt',
    title: 'This Binary Universe', year: 2006, label: 'Binary Acoustics', label_cat: 'BA-006',
    format: '3xLP', variant: 'Clear /500', pressing_qty: 500,
    cover_url: null, ink: 'board', discogs_release_id: 785482,
    released_at: ago(18 * DAY), created_at: ago(18 * DAY),
  },
  {
    id: 'rel_fragments', cat: 'WAX 4113', artist_id: 'art_bonobo',
    title: 'Fragments', year: 2022, label: 'Ninja Tune', label_cat: 'ZEN273',
    format: '2xLP', variant: 'Deluxe Gatefold', pressing_qty: 3000,
    cover_url: null, ink: 'cyan', discogs_release_id: 22079459,
    released_at: ago(1 * DAY), created_at: ago(1 * DAY),
  },
  {
    id: 'rel_syro', cat: 'WAX 4114', artist_id: 'art_aphex',
    title: 'Syro', year: 2014, label: 'Warp', label_cat: 'WARPLP247',
    format: '3xLP', variant: 'Repress', pressing_qty: 1200,
    cover_url: null, ink: 'vermilion', discogs_release_id: 6099925,
    released_at: ago(0.02 * DAY), created_at: ago(0.02 * DAY),
  },
];

// ------------------------------------------------------------------- tracks

/**
 * The DOGS catalog. Real files, real metadata, cleared for use.
 *
 * `duration_sec` is null on every row: nothing has decoded these files yet.
 * The player reads the true duration off the audio element on load and PATCHes
 * it back, so this column fills itself in as the app is used.
 *
 * @type {import('./types.js').Track[]}
 */
export const tracks = [
  {
    id: 'trk_hollywood', release_id: 'rel_gentlemens',
    title: 'HOLLYWOOD', artist: 'YG', album: "THE GENTLEMEN'S CLUB",
    year: 2026, genre: 'Hip-Hop', cover_url: cover('yg'),
    audio_url: `${DATA}/music/2026/HOLLYWOOD.mp3`, duration_sec: null,
    attrib_url: 'https://the-gentlemens-club.com/', position: 1, created_at: ago(34 * DAY),
  },
  {
    id: 'trk_chicago', release_id: 'rel_xscape',
    title: 'Chicago', artist: 'Michael Jackson', album: 'Xscape',
    year: 2014, genre: 'Pop', cover_url: cover('mj'),
    audio_url: `${DATA}/music/2026/Chicago.mp3`, duration_sec: null,
    attrib_url: null, position: 2, created_at: ago(34 * DAY),
  },
  {
    id: 'trk_pourin', release_id: 'rel_return',
    title: 'Pourin Rain (feat. Skratch Bastid)', artist: 'Zeds Dead',
    album: 'Return to the Return (of the Spectrum of Intergalactic Happiness)',
    year: 2026, genre: 'Electronic', cover_url: cover('zd'),
    audio_url: `${DATA}/music/2026/Pourin.mp3`, duration_sec: null,
    attrib_url: 'https://shop.zedsdead.net/', position: 3, created_at: ago(21 * DAY),
  },
  {
    id: 'trk_denchai', release_id: 'rel_denchai',
    title: 'Den Chai', artist: 'The Buddha-Bar Lounge', album: 'Den Chai',
    year: 2008, genre: 'Lounge', cover_url: cover('buddha'),
    audio_url: `${DATA}/music/2026/DENCHAI.mp3`, duration_sec: null,
    attrib_url: 'https://open.spotify.com/artist/0du3MpnxBOpQEie1IV3u9v', position: 4, created_at: ago(21 * DAY),
  },
  {
    id: 'trk_rainbow', release_id: 'rel_shutup',
    title: 'Rainbow in the Dark', artist: 'Das Racist', album: 'Shut Up, Dude',
    year: 2010, genre: 'Hip-Hop', cover_url: cover('rainbow'),
    audio_url: `${DATA}/music/2026/rainbow.mp3`, duration_sec: null,
    attrib_url: 'https://dasracist.bandcamp.com/album/shut-up-dude', position: 5, created_at: ago(20 * DAY),
  },
  {
    id: 'trk_hipsong', release_id: 'rel_deltarune',
    title: 'Hip Song', artist: 'Toby Fox / Trevor Alan Gomes', album: 'Deltarune',
    year: 2021, genre: 'Video Game', cover_url: cover('deltarune'),
    audio_url: `${DATA}/music/2026/shop.mp3`, duration_sec: null,
    attrib_url: 'https://deltarune.com/', position: 6, created_at: ago(19 * DAY),
  },
  {
    id: 'trk_sleepless', release_id: 'rel_atgh',
    title: 'Sleepless', artist: 'deadmau5', album: '> album title goes here <',
    year: 2026, genre: 'Electronic', cover_url: cover('sleepless'),
    audio_url: `${DATA}/music/2026/sleepless.mp3`, duration_sec: null,
    attrib_url: 'https://deadmau5.com/', position: 7, created_at: ago(16 * DAY),
  },
  {
    id: 'trk_skitzo', release_id: 'rel_utopia',
    title: 'Skitzo (feat. Young Thug)', artist: 'Travis Scott', album: 'UTOPIA',
    year: 2023, genre: 'Hip-Hop', cover_url: cover('utopia'),
    audio_url: `${DATA}/music/2026/skitzo.mp3`, duration_sec: null,
    attrib_url: 'https://shop.travisscott.com/', position: 8, created_at: ago(12 * DAY),
  },
  {
    id: 'trk_slow', release_id: 'rel_wheredoi',
    title: 'SLOW ft. DOGS', artist: 'Sweet Boy Sonnet', album: 'Where do I put my love?',
    year: 2026, genre: 'Electronic', cover_url: cover('slow'),
    audio_url: `${DATA}/music/2026/SLOW-FT-DOGS.mp3`, duration_sec: null,
    attrib_url: 'https://sweetboysonnet.com/', position: 9, created_at: ago(8 * DAY),
  },
  {
    id: 'trk_arigato', release_id: 'rel_arigato',
    title: 'ARIGATO', artist: 'Nxnja', album: 'ARIGATO',
    year: 2026, genre: 'Hip-Hop', cover_url: cover('arigato'),
    audio_url: `${DATA}/music/2026/arigato.mp3`, duration_sec: null,
    attrib_url: 'https://nxnjaa.beatstars.com/', position: 10, created_at: ago(5 * DAY),
  },
  {
    id: 'trk_exile', release_id: 'rel_exile2',
    title: "What's Beneath the Chicken Coop", artist: 'Trevor Sensor',
    album: 'On Account of Exile, Vol. 2',
    year: 2021, genre: 'Indie Rock', cover_url: cover('exile'),
    audio_url: `${DATA}/music/2026/exile.mp3`, duration_sec: null,
    attrib_url: 'https://trevorsensorofficial.com/', position: 11, created_at: ago(5 * DAY),
  },
];

// -------------------------------------------------------------------- users

/**
 * Accounts. `usr_test` is the one the "Enter as test collector" button signs
 * you in as; the rest exist so the social layer has neighbours to show.
 *
 * @type {import('./types.js').User[]}
 */
export const users = [
  {
    id: 'usr_test', email: 'test@wax.fm', handle: 'testpressing',
    display_name: 'Test Pressing', avatar_url: null,
    plan: 'trial', trial_ends_at: ago(-28 * DAY),
    phone: '+15555550142', phone_verified: true, email_verified: true,
    created_at: ago(96 * DAY),
  },
  {
    id: 'usr_kestrel', email: 'kestrel@example.com', handle: 'kestrel',
    display_name: 'Kestrel', avatar_url: null,
    plan: 'series', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: ago(420 * DAY),
  },
  {
    id: 'usr_marisol', email: 'marisol@example.com', handle: 'marisol',
    display_name: 'Marisol Vega', avatar_url: null,
    plan: 'free', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: ago(210 * DAY),
  },
  {
    id: 'usr_dial', email: 'dial@example.com', handle: 'dialtone',
    display_name: 'dialtone', avatar_url: null,
    plan: 'series', trial_ends_at: null,
    phone: null, phone_verified: false, email_verified: true,
    created_at: ago(150 * DAY),
  },
];

/** @type {import('./types.js').Profile[]} */
export const profiles = [
  {
    user_id: 'usr_test',
    bio: 'Missed the BT pressing in 2006 and have been unreasonable about it ever since. Mostly electronic, increasingly whatever the algorithm cannot find.',
    location: 'Chicago, IL', ink: 'vermilion',
    genres: ['Electronic', 'Hip-Hop', 'Indie Rock'], crate_public: true,
    updated_at: ago(3 * DAY),
  },
  {
    user_id: 'usr_kestrel',
    bio: 'Ambient, IDM, and anything Warp put out between 1993 and 2001.',
    location: 'Portland, OR', ink: 'cyan',
    genres: ['Electronic', 'IDM', 'Ambient'], crate_public: true,
    updated_at: ago(30 * DAY),
  },
  {
    user_id: 'usr_marisol',
    bio: 'Soul, funk, and the occasional very expensive mistake.',
    location: 'Austin, TX', ink: 'chartreuse',
    genres: ['Soul', 'Pop', 'Hip-Hop'], crate_public: true,
    updated_at: ago(60 * DAY),
  },
  {
    user_id: 'usr_dial',
    bio: 'Test pressings and white labels only. Do not ask.',
    location: 'Detroit, MI', ink: 'ultramarine',
    genres: ['Electronic', 'Hip-Hop'], crate_public: false,
    updated_at: ago(45 * DAY),
  },
];

/** @type {import('./types.js').Follow[]} */
export const follows = [
  { follower_id: 'usr_test', followee_id: 'usr_kestrel', created_at: ago(40 * DAY) },
  { follower_id: 'usr_test', followee_id: 'usr_marisol', created_at: ago(38 * DAY) },
  { follower_id: 'usr_kestrel', followee_id: 'usr_test', created_at: ago(39 * DAY) },
  { follower_id: 'usr_dial', followee_id: 'usr_test', created_at: ago(20 * DAY) },
  { follower_id: 'usr_marisol', followee_id: 'usr_test', created_at: ago(12 * DAY) },
];

// ------------------------------------------------------------------ watches

/** @type {import('./types.js').Watch[]} */
export const watches = [
  {
    id: 'wch_bt', user_id: 'usr_test', artist_id: 'art_bt',
    watch_vinyl: true, merch_types: ['test-pressing'], target_price_cents: 12000,
    channels: ['email', 'sms', 'push'], created_at: ago(90 * DAY),
  },
  {
    id: 'wch_deadmau5', user_id: 'usr_test', artist_id: 'art_deadmau5',
    watch_vinyl: true, merch_types: [], target_price_cents: null,
    channels: ['email', 'push'], created_at: ago(70 * DAY),
  },
  {
    id: 'wch_zeds', user_id: 'usr_test', artist_id: 'art_zedsdead',
    watch_vinyl: true, merch_types: ['tee', 'poster'], target_price_cents: 6500,
    channels: ['push'], created_at: ago(55 * DAY),
  },
  {
    id: 'wch_aphex', user_id: 'usr_test', artist_id: 'art_aphex',
    watch_vinyl: true, merch_types: [], target_price_cents: 9000,
    channels: ['email', 'sms', 'push'], created_at: ago(30 * DAY),
  },
  {
    id: 'wch_sonnet', user_id: 'usr_test', artist_id: 'art_sonnet',
    watch_vinyl: true, merch_types: [], target_price_cents: null,
    channels: ['push'], created_at: ago(8 * DAY),
  },
  {
    id: 'wch_bonobo', user_id: 'usr_test', artist_id: 'art_bonobo',
    watch_vinyl: true, merch_types: [], target_price_cents: 4500,
    channels: ['email'], created_at: ago(6 * DAY),
  },
];

// ------------------------------------------------------------------- alerts

/**
 * The alert board.
 *
 * Ordered newest first as written. The top row is deliberately seconds old and
 * `live` — the board's whole job is to look like something that just happened.
 *
 * @type {import('./types.js').Alert[]}
 */
export const alerts = [
  {
    id: 'alr_syro', user_id: 'usr_test', release_id: 'rel_syro', watch_id: 'wch_aphex',
    kind: 'drop', state: 'live',
    detected_at: ago(38), dispatched_at: ago(36), read_at: null,
    channels: ['email', 'sms', 'push'],
    listing_url: 'https://www.discogs.com/sell/release/6099925',
    price_cents: 8400, created_at: ago(38),
  },
  {
    id: 'alr_fragments', user_id: 'usr_test', release_id: 'rel_fragments', watch_id: 'wch_bonobo',
    kind: 'price', state: 'live',
    detected_at: ago(1420), dispatched_at: ago(1418), read_at: null,
    channels: ['email'],
    listing_url: 'https://www.discogs.com/sell/release/22079459',
    price_cents: 4200, created_at: ago(1420),
  },
  {
    id: 'alr_slow', user_id: 'usr_test', release_id: 'rel_wheredoi', watch_id: 'wch_sonnet',
    kind: 'drop', state: 'caught',
    detected_at: ago(2 * DAY), dispatched_at: ago(2 * DAY - 3), read_at: ago(2 * DAY - 900),
    channels: ['push'],
    listing_url: 'https://sweetboysonnet.com/', price_cents: 3200, created_at: ago(2 * DAY),
  },
  {
    id: 'alr_atgh', user_id: 'usr_test', release_id: 'rel_atgh', watch_id: 'wch_deadmau5',
    kind: 'drop', state: 'caught',
    detected_at: ago(9 * DAY), dispatched_at: ago(9 * DAY - 11), read_at: ago(9 * DAY - 400),
    channels: ['email', 'push'],
    listing_url: 'https://mau5trap.com/', price_cents: 4800, created_at: ago(9 * DAY),
  },
  {
    id: 'alr_tbu', user_id: 'usr_test', release_id: 'rel_tbu', watch_id: 'wch_bt',
    kind: 'restock', state: 'sold_out',
    detected_at: ago(18 * DAY), dispatched_at: ago(18 * DAY - 7), read_at: ago(17 * DAY),
    channels: ['email', 'sms', 'push'],
    listing_url: 'https://www.discogs.com/sell/release/785482',
    price_cents: 14500, created_at: ago(18 * DAY),
  },
  {
    id: 'alr_return', user_id: 'usr_test', release_id: 'rel_return', watch_id: 'wch_zeds',
    kind: 'drop', state: 'caught',
    detected_at: ago(21 * DAY), dispatched_at: ago(21 * DAY - 4), read_at: ago(21 * DAY - 200),
    channels: ['push'],
    listing_url: 'https://shop.zedsdead.net/', price_cents: 5400, created_at: ago(21 * DAY),
  },
  {
    id: 'alr_zedstee', user_id: 'usr_test', release_id: 'rel_return', watch_id: 'wch_zeds',
    kind: 'merch', state: 'missed',
    detected_at: ago(26 * DAY), dispatched_at: ago(26 * DAY - 6), read_at: null,
    channels: ['push'], listing_url: null, price_cents: 3500, created_at: ago(26 * DAY),
  },
  {
    id: 'alr_arigato', user_id: 'usr_test', release_id: 'rel_arigato', watch_id: null,
    kind: 'drop', state: 'watching',
    detected_at: ago(5 * DAY), dispatched_at: null, read_at: null,
    channels: [], listing_url: null, price_cents: null, created_at: ago(5 * DAY),
  },
];

// -------------------------------------------------------------------- crate

/** @type {import('./types.js').CrateItem[]} */
export const crateItems = [
  { id: 'crt_1', user_id: 'usr_test', release_id: 'rel_wheredoi', condition: 'M',   paid_cents: 3200, acquired_at: ago(2 * DAY),   notes: 'Caught from the alert in about a minute.', created_at: ago(2 * DAY) },
  { id: 'crt_2', user_id: 'usr_test', release_id: 'rel_atgh',     condition: 'M',   paid_cents: 4800, acquired_at: ago(9 * DAY),   notes: null, created_at: ago(9 * DAY) },
  { id: 'crt_3', user_id: 'usr_test', release_id: 'rel_return',   condition: 'NM',  paid_cents: 5400, acquired_at: ago(21 * DAY),  notes: 'Splatter, sleeve has a corner ding.', created_at: ago(21 * DAY) },
  { id: 'crt_4', user_id: 'usr_test', release_id: 'rel_utopia',   condition: 'NM',  paid_cents: 6200, acquired_at: ago(140 * DAY), notes: null, created_at: ago(140 * DAY) },
  { id: 'crt_5', user_id: 'usr_test', release_id: 'rel_deltarune', condition: 'M',  paid_cents: 12000, acquired_at: ago(180 * DAY), notes: 'Box set, still sealed.', created_at: ago(180 * DAY) },
  { id: 'crt_6', user_id: 'usr_test', release_id: 'rel_shutup',   condition: 'VG+', paid_cents: 2800, acquired_at: ago(110 * DAY), notes: null, created_at: ago(110 * DAY) },
  { id: 'crt_7', user_id: 'usr_test', release_id: 'rel_xscape',   condition: 'VG+', paid_cents: 1900, acquired_at: ago(260 * DAY), notes: null, created_at: ago(260 * DAY) },
  { id: 'crt_8', user_id: 'usr_test', release_id: 'rel_exile2',   condition: 'NM',  paid_cents: 2400, acquired_at: ago(200 * DAY), notes: null, created_at: ago(200 * DAY) },

  // Neighbours' crates, for the taste-overlap figure on the profile screen.
  { id: 'crt_k1', user_id: 'usr_kestrel', release_id: 'rel_syro',      condition: 'NM', paid_cents: 7800, acquired_at: ago(90 * DAY), notes: null, created_at: ago(90 * DAY) },
  { id: 'crt_k2', user_id: 'usr_kestrel', release_id: 'rel_atgh',      condition: 'M',  paid_cents: 4800, acquired_at: ago(8 * DAY),  notes: null, created_at: ago(8 * DAY) },
  { id: 'crt_k3', user_id: 'usr_kestrel', release_id: 'rel_return',    condition: 'M',  paid_cents: 5400, acquired_at: ago(20 * DAY), notes: null, created_at: ago(20 * DAY) },
  { id: 'crt_k4', user_id: 'usr_kestrel', release_id: 'rel_tbu',       condition: 'NM', paid_cents: 9500, acquired_at: ago(300 * DAY), notes: null, created_at: ago(300 * DAY) },
  { id: 'crt_m1', user_id: 'usr_marisol', release_id: 'rel_xscape',    condition: 'M',  paid_cents: 2200, acquired_at: ago(150 * DAY), notes: null, created_at: ago(150 * DAY) },
  { id: 'crt_m2', user_id: 'usr_marisol', release_id: 'rel_utopia',    condition: 'NM', paid_cents: 6000, acquired_at: ago(100 * DAY), notes: null, created_at: ago(100 * DAY) },
  { id: 'crt_m3', user_id: 'usr_marisol', release_id: 'rel_gentlemens', condition: 'M', paid_cents: 4000, acquired_at: ago(30 * DAY), notes: null, created_at: ago(30 * DAY) },
  { id: 'crt_d1', user_id: 'usr_dial',    release_id: 'rel_arigato',   condition: 'M',  paid_cents: 2600, acquired_at: ago(4 * DAY),  notes: null, created_at: ago(4 * DAY) },
  { id: 'crt_d2', user_id: 'usr_dial',    release_id: 'rel_deltarune', condition: 'M',  paid_cents: 11000, acquired_at: ago(170 * DAY), notes: null, created_at: ago(170 * DAY) },
  { id: 'crt_d3', user_id: 'usr_dial',    release_id: 'rel_shutup',    condition: 'VG', paid_cents: 2000, acquired_at: ago(90 * DAY), notes: null, created_at: ago(90 * DAY) },
];

/** @type {import('./types.js').WantlistItem[]} */
export const wantlistItems = [
  { id: 'wnt_1', user_id: 'usr_test', release_id: 'rel_tbu',        target_price_cents: 12000, created_at: ago(90 * DAY) },
  { id: 'wnt_2', user_id: 'usr_test', release_id: 'rel_syro',       target_price_cents: 9000,  created_at: ago(30 * DAY) },
  { id: 'wnt_3', user_id: 'usr_test', release_id: 'rel_fragments',  target_price_cents: 4500,  created_at: ago(6 * DAY) },
  { id: 'wnt_4', user_id: 'usr_test', release_id: 'rel_gentlemens', target_price_cents: 3800,  created_at: ago(20 * DAY) },
  { id: 'wnt_5', user_id: 'usr_test', release_id: 'rel_arigato',    target_price_cents: 2500,  created_at: ago(5 * DAY) },
];

// ------------------------------------------------------------- price points

/**
 * Current listing spreads. One observation per release — enough for the price
 * watch to render a range and a marker without pretending to a history the
 * demo does not have.
 *
 * @type {import('./types.js').PricePoint[]}
 */
export const pricePoints = [
  { id: 'prc_1',  release_id: 'rel_tbu',        observed_at: ago(600),  low_cents: 13500, median_cents: 18900, high_cents: 31000, listing_count: 7 },
  { id: 'prc_2',  release_id: 'rel_syro',       observed_at: ago(38),   low_cents: 8400,  median_cents: 10400, high_cents: 15800, listing_count: 12 },
  { id: 'prc_3',  release_id: 'rel_fragments',  observed_at: ago(1420), low_cents: 4200,  median_cents: 5100,  high_cents: 7400,  listing_count: 24 },
  { id: 'prc_4',  release_id: 'rel_gentlemens', observed_at: ago(3600), low_cents: 3900,  median_cents: 4600,  high_cents: 6800,  listing_count: 15 },
  { id: 'prc_5',  release_id: 'rel_arigato',    observed_at: ago(7200), low_cents: 2600,  median_cents: 4900,  high_cents: 11000, listing_count: 3 },
  { id: 'prc_6',  release_id: 'rel_wheredoi',   observed_at: ago(4000), low_cents: 3200,  median_cents: 5800,  high_cents: 9000,  listing_count: 4 },
  { id: 'prc_7',  release_id: 'rel_atgh',       observed_at: ago(5000), low_cents: 4800,  median_cents: 6200,  high_cents: 8900,  listing_count: 9 },
  { id: 'prc_8',  release_id: 'rel_return',     observed_at: ago(9000), low_cents: 5400,  median_cents: 7100,  high_cents: 12000, listing_count: 6 },
  { id: 'prc_9',  release_id: 'rel_utopia',     observed_at: ago(12000), low_cents: 5900, median_cents: 7400,  high_cents: 11500, listing_count: 31 },
  { id: 'prc_10', release_id: 'rel_deltarune',  observed_at: ago(14000), low_cents: 11000, median_cents: 16500, high_cents: 24000, listing_count: 5 },
  { id: 'prc_11', release_id: 'rel_shutup',     observed_at: ago(20000), low_cents: 2800, median_cents: 3900,  high_cents: 6200,  listing_count: 8 },
  { id: 'prc_12', release_id: 'rel_xscape',     observed_at: ago(26000), low_cents: 1900, median_cents: 2600,  high_cents: 4100,  listing_count: 42 },
  { id: 'prc_13', release_id: 'rel_exile2',     observed_at: ago(30000), low_cents: 2400, median_cents: 3100,  high_cents: 4800,  listing_count: 11 },
  { id: 'prc_14', release_id: 'rel_denchai',    observed_at: ago(40000), low_cents: 1600, median_cents: 2200,  high_cents: 3900,  listing_count: 6 },
];

// ----------------------------------------------------------------- activity

/** @type {import('./types.js').Activity[]} */
export const activity = [
  { id: 'act_1', user_id: 'usr_test',    verb: 'caught',    object_type: 'release', object_id: 'rel_wheredoi', created_at: ago(2 * DAY) },
  { id: 'act_2', user_id: 'usr_test',    verb: 'played',    object_type: 'track',   object_id: 'trk_slow',     created_at: ago(2 * DAY - 60) },
  { id: 'act_3', user_id: 'usr_kestrel', verb: 'added',     object_type: 'release', object_id: 'rel_syro',     created_at: ago(3 * DAY) },
  { id: 'act_4', user_id: 'usr_test',    verb: 'wanted',    object_type: 'release', object_id: 'rel_fragments', created_at: ago(6 * DAY) },
  { id: 'act_5', user_id: 'usr_test',    verb: 'caught',    object_type: 'release', object_id: 'rel_atgh',     created_at: ago(9 * DAY) },
  { id: 'act_6', user_id: 'usr_marisol', verb: 'added',     object_type: 'release', object_id: 'rel_gentlemens', created_at: ago(30 * DAY) },
  { id: 'act_7', user_id: 'usr_test',    verb: 'followed',  object_type: 'user',    object_id: 'usr_kestrel',  created_at: ago(40 * DAY) },
  { id: 'act_8', user_id: 'usr_dial',    verb: 'commented', object_type: 'release', object_id: 'rel_arigato',  created_at: ago(4 * DAY) },
];

/**
 * The complete dataset, in the shape {@link import('./store.js').createStore}
 * expects. Every collection here maps 1:1 to a table in `schema.sql`.
 */
export const seed = {
  users,
  profiles,
  follows,
  artists,
  releases,
  tracks,
  watches,
  alerts,
  crateItems,
  wantlistItems,
  pricePoints,
  activity,
};
