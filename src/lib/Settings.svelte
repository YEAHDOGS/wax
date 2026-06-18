<script>
  import { appState, actions } from './store.svelte.js';
  import { 
    Smartphone, 
    Mail, 
    Key, 
    Plus, 
    X, 
    Music, 
    Settings as SettingsIcon,
    Volume2,
    Check
  } from '@lucide/svelte';

  // Local inputs
  let newArtist = $state('');
  let newKeyword = $state('');

  let smsRecipient = $state('+1 (555) 932-9290');
  let emailRecipient = $state('digging@crateking.com');

  // API credentials mock values
  let twilioSid = $state('AC7a32b0f4438...');
  let resendApiKey = $state('re_Lz89A3...');
  let discogsConsumerKey = $state('discogs_consumer_key_6b1a...');
  let discogsConsumerSecret = $state('discogs_consumer_secret_f9a8...');

  function handleAddArtist() {
    if (newArtist.trim()) {
      actions.addFavoriteArtist(newArtist);
      newArtist = '';
    }
  }

  function handleAddKeyword() {
    if (newKeyword.trim()) {
      actions.addKeyword(newKeyword);
      newKeyword = '';
    }
  }

  const themes = [
    { id: 'night', name: 'Night Drop', desc: 'Deep oceanic indigo dark mode (default)' },
    { id: 'dracula', name: 'Goth Dracula', desc: 'Vampire slate dark mode with pink accents' },
    { id: 'synthwave', name: 'Synthwave', desc: '80s arcade neon retro glowing theme' },
    { id: 'cyberpunk', name: 'Cyberpunk', desc: 'High-contrast cyber yellow and teal' },
    { id: 'retro', name: 'Vintage Vinyl', desc: 'Warm cream, peach, and analog brown' },
    { id: 'forest', name: 'Forest Crate', desc: 'Earthy forest greens and warm wood tones' },
    { id: 'cupcake', name: 'Pastel Cupcake', desc: 'Sweet, bright pastel cream colors' },
    { id: 'luxury', name: 'Luxury Crate', desc: 'Sophisticated black and gold premium finish' },
    { id: 'light', name: 'Studio Light', desc: 'Clean, high-visibility classic light mode' }
  ];
</script>

<div class="space-y-6">
  <div class="space-y-1 text-center sm:text-left">
    <h1 class="text-3xl font-bold tracking-tight">System Settings</h1>
    <p class="text-sm text-neutral-content">
      Configure your Twilio and Resend API routing, manage watchwords, and connect streaming accounts.
    </p>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Streaming Integrations Section -->
    <div class="card bg-base-200 border border-base-300 shadow-xl space-y-4">
      <div class="card-body">
        <h2 class="card-title text-xl border-b border-base-300 pb-2 flex items-center gap-2">
          <Music class="h-5 w-5 text-success animate-pulse" />
          Music Streaming Services Sync
        </h2>
        <p class="text-xs text-neutral-content mb-4">
          Connect your streaming profiles to automatically import your top listened and recently played artists, ensuring you are notified as soon as they release a new album.
        </p>

        <!-- Spotify Card -->
        <div class="p-4 rounded-xl border border-base-300 bg-base-300/40 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <span class="w-8 h-8 rounded-full bg-success flex items-center justify-center text-white text-lg font-bold font-sans">S</span>
              <div>
                <h3 class="font-bold text-sm leading-tight">Spotify API Integration</h3>
                <span class="text-[10px] text-success font-semibold flex items-center gap-1">
                  {#if appState.spotifyConnected}
                    <span class="w-1.5 h-1.5 rounded-full bg-success animate-ping"></span>
                    Connected: {appState.spotifyUser.name} ({appState.spotifyUser.product})
                  {:else}
                    <span class="text-neutral-content">Not Connected</span>
                  {/if}
                </span>
              </div>
            </div>
            
            {#if appState.spotifyConnected}
              <button onclick={() => actions.disconnectSpotify()} class="btn btn-xs btn-outline btn-error">
                Disconnect
              </button>
            {:else}
              <button onclick={() => actions.connectSpotify()} class="btn btn-xs btn-success text-white">
                Sync Spotify Artists
              </button>
            {/if}
          </div>
          {#if appState.spotifyConnected}
            <div class="text-[11px] text-neutral-content bg-base-200/50 p-2 rounded-lg flex items-center gap-1.5">
              <Check class="h-3 w-3 text-success" />
              <span>Recently listened artists (Daft Punk, Taylor Swift, Kendrick Lamar, Pink Floyd, Tame Impala) synced to alerts.</span>
            </div>
          {/if}
        </div>

        <!-- Apple Music Card -->
        <div class="p-4 rounded-xl border border-base-300 bg-base-300/40 space-y-3 mt-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <span class="w-8 h-8 rounded-full bg-error flex items-center justify-center text-white text-lg font-bold font-sans">A</span>
              <div>
                <h3 class="font-bold text-sm leading-tight">Apple Music API Integration</h3>
                <span class="text-[10px] text-error font-semibold flex items-center gap-1">
                  {#if appState.appleMusicConnected}
                    <span class="w-1.5 h-1.5 rounded-full bg-error animate-ping"></span>
                    Connected: {appState.appleMusicUser.name}
                  {:else}
                    <span class="text-neutral-content">Not Connected</span>
                  {/if}
                </span>
              </div>
            </div>
            
            {#if appState.appleMusicConnected}
              <button onclick={() => actions.disconnectAppleMusic()} class="btn btn-xs btn-outline btn-error">
                Disconnect
              </button>
            {:else}
              <button onclick={() => actions.connectAppleMusic()} class="btn btn-xs btn-error text-white">
                Sync Apple Music Artists
              </button>
            {/if}
          </div>
          {#if appState.appleMusicConnected}
            <div class="text-[11px] text-neutral-content bg-base-200/50 p-2 rounded-lg flex items-center gap-1.5">
              <Check class="h-3 w-3 text-error" />
              <span>Recently listened artists (Radiohead, Gorillaz, Tame Impala, Daft Punk, Lana Del Rey, Tyler, The Creator, Mac Miller) synced to alerts.</span>
            </div>
          {/if}
        </div>

        <!-- Discogs Collection Integration -->
        <div class="p-4 rounded-xl border border-base-300 bg-base-300/40 space-y-3 mt-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <span class="w-8 h-8 rounded-full bg-neutral flex items-center justify-center text-white text-lg font-bold font-sans">D</span>
              <div>
                <h3 class="font-bold text-sm leading-tight">Discogs Collection Integration</h3>
                <span class="text-[10px] text-neutral-content font-semibold flex items-center gap-1">
                  {#if appState.discogsConnected}
                    <span class="w-1.5 h-1.5 rounded-full bg-success animate-ping"></span>
                    Connected: {appState.discogsUsername}
                  {:else}
                    <span class="text-neutral-content">Not Connected</span>
                  {/if}
                </span>
              </div>
            </div>
            
            {#if appState.discogsConnected}
              <button onclick={() => actions.disconnectDiscogs()} class="btn btn-xs btn-outline btn-error">
                Disconnect
              </button>
            {:else}
              <button onclick={() => actions.startDiscogsLogin()} class="btn btn-xs btn-neutral text-white">
                Sync Discogs Collection
              </button>
            {/if}
          </div>
          {#if appState.discogsConnected}
            <div class="text-[11px] text-neutral-content bg-base-200/50 p-2 rounded-lg flex items-center gap-1.5">
              <Check class="h-3 w-3 text-success" />
              <span>Successfully synced 6 custom releases and rare pressing variants directly to your virtual crate.</span>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Watchlist Managers Section -->
    <div class="card bg-base-200 border border-base-300 shadow-xl space-y-4">
      <div class="card-body">
        <h2 class="card-title text-xl border-b border-base-300 pb-2">Target Match watchlist</h2>

        <!-- Favorite Artists Watchlist -->
        <div class="space-y-2">
          <label class="label-text font-bold" for="add-artist-watchlist">Favorite Artists Watchlist</label>
          <div class="flex gap-2">
            <input 
              id="add-artist-watchlist"
              type="text" 
              placeholder="e.g. Tame Impala, Gorillaz" 
              class="input input-bordered input-sm flex-grow" 
              bind:value={newArtist}
              onkeydown={(e) => e.key === 'Enter' && handleAddArtist()}
            />
            <button onclick={handleAddArtist} class="btn btn-sm btn-primary btn-square" aria-label="Add Favorite Artist">
              <Plus class="h-4 w-4" />
            </button>
          </div>
          <div class="flex flex-wrap gap-1.5 pt-1.5 max-h-36 overflow-y-auto">
            {#each appState.favorites as artist}
              <div class="badge badge-secondary badge-md gap-1 p-3">
                <span>{artist}</span>
                <button 
                  onclick={() => actions.removeFavoriteArtist(artist)}
                  class="btn btn-ghost btn-circle btn-xs hover:bg-red-500/20 p-0 text-white"
                  title="Remove {artist}"
                  aria-label="Remove {artist}"
                >
                  <X class="h-3 w-3" />
                </button>
              </div>
            {/each}
          </div>
        </div>

        <div class="divider my-1"></div>

        <!-- Keyword Match Watchlist -->
        <div class="space-y-2">
          <label class="label-text font-bold" for="add-watch-keyword">Keyword Match Watchlist</label>
          <div class="flex gap-2">
            <input 
              id="add-watch-keyword"
              type="text" 
              placeholder="e.g. Splatter, Box Set, Numbered" 
              class="input input-bordered input-sm flex-grow" 
              bind:value={newKeyword}
              onkeydown={(e) => e.key === 'Enter' && handleAddKeyword()}
            />
            <button onclick={handleAddKeyword} class="btn btn-sm btn-primary btn-square" aria-label="Add Keyword">
              <Plus class="h-4 w-4" />
            </button>
          </div>
          <div class="flex flex-wrap gap-1.5 pt-1.5 max-h-36 overflow-y-auto">
            {#each appState.keywords as kw}
              <div class="badge badge-accent badge-md gap-1 p-3">
                <span>{kw}</span>
                <button 
                  onclick={() => actions.removeKeyword(kw)}
                  class="btn btn-ghost btn-circle btn-xs hover:bg-red-500/20 p-0 text-white"
                  title="Remove {kw}"
                  aria-label="Remove {kw}"
                >
                  <X class="h-3 w-3" />
                </button>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>

    <!-- Global Theme & Style Selection Section -->
    <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-2">
      <div class="card-body">
        <h2 class="card-title text-xl border-b border-base-300 pb-2 flex items-center gap-2">
          <span class="w-5 h-5 rounded-full bg-primary animate-pulse"></span>
          App Theme & Visual Styles
        </h2>
        <p class="text-xs text-neutral-content mb-4">
          Select your preferred colorway theme for WaxOnWax. Container elements, components, and badges will instantly adopt the active palette.
        </p>
        
        <div class="theme-swatch-grid">
          {#each themes as t}
            <button 
              onclick={() => actions.setTheme(t.id)} 
              class="theme-card {appState.theme === t.id ? 'active' : ''}"
              data-theme={t.id}
            >
              <div class="theme-header">
                <span class="theme-name">{t.name}</span>
                {#if appState.theme === t.id}
                  <span class="badge badge-primary badge-xs font-semibold">Active</span>
                {/if}
              </div>
              <p class="theme-desc">{t.desc}</p>
              
              <!-- Live Color Indicator Palette -->
              <div class="theme-colors">
                <span class="dot bg-primary" title="Primary color"></span>
                <span class="dot bg-secondary" title="Secondary color"></span>
                <span class="dot bg-accent" title="Accent color"></span>
                <span class="dot bg-neutral" title="Neutral color"></span>
              </div>
            </button>
          {/each}
        </div>
      </div>
    </div>

    <!-- Reddit Devvit Webhook Configuration Section -->
    <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-2">
      <div class="card-body">
        <h2 class="card-title text-xl border-b border-base-300 pb-2 flex items-center justify-between">
          <span class="flex items-center gap-2">
            <span class="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-xs font-black">D</span>
            Reddit Devvit App Webhook Integration (Free & Official)
          </span>
          <div class="badge badge-accent badge-sm uppercase tracking-wider font-extrabold">Official API</div>
        </h2>
        <p class="text-xs text-neutral-content">
          Instead of running slow background cron pollers using legacy Snoowrap OAuth, run our custom <strong>Reddit Devvit App</strong> in your subreddits. It triggers real-time events on submission and pushes them instantly via webhooks for free.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
          <!-- Webhook Fields -->
          <div class="space-y-4">
            <div class="form-control w-full">
              <label class="label" for="devvit-webhook">
                <span class="label-text font-bold">WaxOnWax Webhook URL</span>
              </label>
              <input 
                id="devvit-webhook"
                type="text" 
                class="input input-bordered w-full input-sm text-success font-mono" 
                value="https://api.waxonwax.io/v1/webhooks/devvit-releases" 
                readonly
              />
            </div>
            
            <div class="form-control w-full">
              <label class="label" for="devvit-secret">
                <span class="label-text font-bold">Devvit Shared Secret Token</span>
              </label>
              <input 
                id="devvit-secret"
                type="password" 
                class="input input-bordered w-full input-sm" 
                value="devvit_sec_8a3f902bc91b" 
                readonly
              />
            </div>

            <div class="bg-base-300/40 p-3 rounded-lg text-xs leading-relaxed text-neutral-content space-y-1">
              <div><strong>Status:</strong> <span class="text-success font-bold">Connected & Listening</span></div>
              <div><strong>Ingested:</strong> 12,940 events routed this month</div>
              <div><strong>Latency:</strong> ~120ms (vs ~5 minutes with cron scraping)</div>
            </div>
          </div>

          <!-- Devvit Script Code -->
          <div class="space-y-2">
            <span class="label-text font-bold">Devvit App Code (Upload to Reddit Platform)</span>
            <div class="bg-base-300 border border-base-300 p-3 rounded-lg text-[10px] font-mono text-neutral-content overflow-y-auto max-h-40">
              <pre>{`import { Devvit } from '@devvit/public-api';

// Trigger alert matching on new post
Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    const post = event.post;
    if (post.subredditName === 'r/VinylReleases') {
      await fetch('https://api.waxonwax.io/webhooks/devvit-releases', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer devvit_sec_8' },
        body: JSON.stringify({
          id: post.id,
          title: post.title,
          flair: post.flairText,
          url: post.url,
          created: post.createdAt
        })
      });
    }
  }
});`}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Twilio & Resend Configuration Section -->
    <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-2">
      <div class="card-body">
        <h2 class="card-title text-xl border-b border-base-300 pb-2 flex items-center gap-2">
          <Key class="h-5 w-5 text-primary" />
          API credentials & Routing Recipients
        </h2>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <!-- Twilio Configuration -->
          <div class="space-y-4">
            <h3 class="font-bold text-sm text-secondary flex items-center gap-1.5">
              <Smartphone class="h-4 w-4" />
              Twilio SMS settings
            </h3>
            
            <div class="form-control w-full">
              <label class="label" for="sms-recipient-num">
                <span class="label-text">SMS Recipient Phone Number</span>
              </label>
              <input 
                id="sms-recipient-num"
                type="text" 
                class="input input-bordered w-full input-sm" 
                bind:value={smsRecipient}
              />
            </div>

            <div class="form-control w-full">
              <label class="label" for="twilio-account-sid">
                <span class="label-text">Twilio Account SID</span>
              </label>
              <input 
                id="twilio-account-sid"
                type="password" 
                class="input input-bordered w-full input-sm" 
                bind:value={twilioSid}
              />
            </div>
          </div>

          <!-- Resend Configuration -->
          <div class="space-y-4">
            <h3 class="font-bold text-sm text-primary flex items-center gap-1.5">
              <Mail class="h-4 w-4" />
              Resend Email settings
            </h3>
            
            <div class="form-control w-full">
              <label class="label" for="email-recipient-addr">
                <span class="label-text">Email Recipient Address</span>
              </label>
              <input 
                id="email-recipient-addr"
                type="email" 
                class="input input-bordered w-full input-sm" 
                bind:value={emailRecipient}
              />
            </div>

            <div class="form-control w-full">
              <label class="label" for="resend-api-key">
                <span class="label-text">Resend API Key</span>
              </label>
              <input 
                id="resend-api-key"
                type="password" 
                class="input input-bordered w-full input-sm" 
                bind:value={resendApiKey}
              />
            </div>
          </div>

          <!-- Discogs Configuration -->
          <div class="space-y-4">
            <h3 class="font-bold text-sm text-neutral-content flex items-center gap-1.5">
              <Music class="h-4 w-4 text-purple-400" />
              Discogs OAuth settings
            </h3>
            
            <div class="form-control w-full">
              <label class="label" for="discogs-key-input">
                <span class="label-text">Application Consumer Key</span>
              </label>
              <input 
                id="discogs-key-input"
                type="text" 
                class="input input-bordered w-full input-sm" 
                bind:value={discogsConsumerKey}
              />
            </div>

            <div class="form-control w-full">
              <label class="label" for="discogs-secret-input">
                <span class="label-text">Application Consumer Secret</span>
              </label>
              <input 
                id="discogs-secret-input"
                type="password" 
                class="input input-bordered w-full input-sm" 
                bind:value={discogsConsumerSecret}
              />
            </div>
          </div>
        </div>

        <div class="card-actions justify-end mt-4">
          <button class="btn btn-primary btn-sm px-6 neon-glow-primary">Save Config</button>
        </div>
      </div>
    </div>
  </div>
</div>

<style lang="scss">
  @reference "../app.css";

  .theme-swatch-grid {
    display: grid;
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 1rem;
    
    @media (min-width: 640px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    @media (min-width: 1024px) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  .theme-card {
    @apply p-4 rounded-xl border-2 text-left transition-all duration-300 bg-base-200 border-base-300 cursor-pointer flex flex-col justify-between h-36 hover:scale-[1.02];
    
    &.active {
      @apply border-primary bg-base-100;
      box-shadow: 0 0 15px var(--color-primary-glow, rgba(168, 85, 247, 0.25));
    }

    .theme-header {
      @apply flex justify-between items-center;
      
      .theme-name {
        @apply font-bold text-xs uppercase text-base-content;
      }
    }

    .theme-desc {
      @apply text-[11px] text-neutral-content leading-tight my-1.5;
    }

    .theme-colors {
      @apply flex gap-1.5 mt-auto pt-2 border-t border-base-300/40;
      
      .dot {
        @apply w-4 h-4 rounded-full border border-black/10;
      }
    }
  }
</style>
