<script>
  import { appState, actions } from './store.svelte.js';
  import { fetchRedditDrops } from './redditService.js';
  import { 
    Disc, 
    RefreshCw, 
    BellRing, 
    Plus, 
    ExternalLink, 
    ShoppingBag, 
    AlertTriangle, 
    Smartphone, 
    Mail,
    Sparkles
  } from '@lucide/svelte';

  let matchOnly = $state(false);
  let isScraping = $state(false);
  let errorMsg = $state('');

  // Local config inputs
  let twilioEnabled = $state(true);
  let resendEnabled = $state(true);

  // Load drops on mount
  async function triggerScrape() {
    isScraping = true;
    errorMsg = '';
    try {
      const liveDrops = await fetchRedditDrops(
        ['VinylReleases', 'vinyl'], 
        appState.favorites, 
        appState.keywords
      );
      
      // Update drops list
      appState.drops = liveDrops;
      appState.lastScrapeTime = new Date().toLocaleTimeString();

      // Check if any new matched drops occurred to trigger simulated Twilio/Resend dispatches
      const matchedNew = liveDrops.filter(d => d.isMatched);
      
      // Simulate notifications for newly matched ones if logs are sparse
      if (matchedNew.length > 0) {
        // Trigger notification for the top matched drop if it isn't logged yet
        const topMatch = matchedNew[0];
        const logExists = appState.notificationLogs.some(log => log.message.includes(topMatch.album));
        
        if (!logExists) {
          const storeName = topMatch.retailer !== 'General Release' ? topMatch.retailer : 'Official Retailer';
          
          if (twilioEnabled) {
            actions.addNotification({
              type: 'SMS',
              recipient: '+1 (555) 932-9290',
              message: `🚨 WAX MATCH: "${topMatch.artist} - ${topMatch.album}" (${topMatch.variant}) is live! Buy at: ${storeName}. Link: ${topMatch.url}`
            });
          }
          if (resendEnabled) {
            actions.addNotification({
              type: 'Email',
              recipient: 'digging@crateking.com',
              message: `📬 WaxOnWax Alert: A new release by ${topMatch.artist} - "${topMatch.album}" has dropped. Format: ${topMatch.variant}. Available at ${storeName}. Purchase URL: ${topMatch.url}`
            });
          }
        }
      }
    } catch (e) {
      errorMsg = 'Failed to fetch drops from Reddit JSON feed. Falling back to local data.';
      console.error(e);
    } finally {
      isScraping = false;
    }
  }

  // Fallback / mock triggers if Reddit is rate limiting or offline
  function simulateMockMatch() {
    const mockArtists = [...appState.favorites, 'Gorillaz', 'Tame Impala', 'Radiohead'];
    const selectedArtist = mockArtists[Math.floor(Math.random() * mockArtists.length)];
    const albums = ['Cracker Island', 'Currents (Collector Edition)', 'Kid A Mnesia', 'Midnights', 'Random Access Memories'];
    const selectedAlbum = albums[Math.floor(Math.random() * albums.length)];
    const variants = ['Splatter Edition LP', 'Liquid Filled Blue Disc', '180g Pink Pressing', '2xLP Orange Marbled'];
    const selectedVariant = variants[Math.floor(Math.random() * variants.length)];
    const retailers = ['Rough Trade', 'Blood Records', 'Official Store', 'Bandcamp'];
    const selectedRetailer = retailers[Math.floor(Math.random() * retailers.length)];
    
    const flairs = ['New Release', 'Restock', 'Pre-Order', 'Limited Stock', 'Out of Stock', 'Covers / Variants'];
    const selectedFlair = flairs[Math.floor(Math.random() * flairs.length)];

    const id = 'mock_' + Date.now();
    const newDrop = {
      id,
      title: `${selectedArtist} - ${selectedAlbum} (${selectedVariant}) [${selectedRetailer}]`,
      artist: selectedArtist,
      album: selectedAlbum,
      variant: selectedVariant,
      retailer: selectedRetailer,
      url: 'https://www.roughtrade.com',
      permalink: 'https://reddit.com',
      subreddit: 'VinylReleases',
      createdUtc: Date.now(),
      thumbnail: null,
      isMatched: true,
      matchReason: `Favorite Artist: "${selectedArtist}"`,
      selftext: 'This is a mocked vinyl drop matching your favorite tracking list!',
      flair: selectedFlair
    };

    appState.drops = [newDrop, ...appState.drops];
    appState.lastScrapeTime = new Date().toLocaleTimeString();

    // Trigger dispatches
    if (twilioEnabled) {
      actions.addNotification({
        type: 'SMS',
        recipient: '+1 (555) 932-9290',
        message: `🚨 MATCHED [${selectedFlair}]: "${selectedArtist} - ${selectedAlbum}" (${selectedVariant}) at ${selectedRetailer}! Buy now: https://www.roughtrade.com`
      });
    }
    if (resendEnabled) {
      actions.addNotification({
        type: 'Email',
        recipient: 'digging@crateking.com',
        message: `📬 WaxOnWax [${selectedFlair}]: New drop detected for favorite artist ${selectedArtist} - ${selectedAlbum} (${selectedVariant}). Available at ${selectedRetailer}.`
      });
    }
  }

  // Auto-scrape on load if empty
  $effect(() => {
    if (appState.drops.length === 0) {
      triggerScrape();
    }
  });

  // Derived filtered drops list
  let displayedDrops = $derived(
    matchOnly 
      ? appState.drops.filter(d => d.isMatched) 
      : appState.drops
  );

  function handleAddToCrate(drop) {
    actions.addToCrate({
      artist: drop.artist,
      album: drop.album,
      variant: drop.variant,
      retailer: drop.retailer,
      year: new Date(drop.createdUtc).getFullYear(),
      genre: drop.subreddit === 'VinylReleases' ? 'Alternative' : 'General',
      coverUrl: drop.thumbnail || 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80',
      notes: `Matched via alerts engine. Source: r/${drop.subreddit}. Link: ${drop.url}`
    });
  }
</script>

<div class="space-y-6">
  <!-- Top Stats Banner -->
  <div class="flex flex-col md:flex-row gap-4 items-center justify-between bg-base-200 border border-base-300 p-6 rounded-2xl shadow-xl">
    <div class="space-y-2 text-center md:text-left">
      <div class="flex items-center gap-2 justify-center md:justify-start">
        <span class="w-2.5 h-2.5 rounded-full bg-success animate-ping"></span>
        <h1 class="text-2xl font-bold tracking-tight">WaxOnWax Tracking Engine</h1>
      </div>
      <p class="text-sm text-neutral-content max-w-xl">
        Automated scraping pipeline reading <span class="badge badge-outline badge-sm text-secondary">r/VinylReleases</span> and <span class="badge badge-outline badge-sm text-primary">r/vinyl</span>. Matches are routed to SMS/Email instantly.
      </p>
    </div>
    
    <div class="flex flex-wrap gap-2 justify-center">
      <button 
        class="btn btn-outline btn-neutral" 
        onclick={simulateMockMatch}
        title="Simulate a real-time Reddit drop event matching user parameters"
      >
        <Sparkles class="h-4 w-4 text-accent" />
        Simulate Drop Match
      </button>

      <button 
        class="btn btn-primary neon-glow-primary" 
        onclick={triggerScrape} 
        disabled={isScraping}
      >
        <RefreshCw class="h-4 w-4 {isScraping ? 'animate-spin' : ''}" />
        {isScraping ? 'Scraping...' : 'Scan Forums'}
      </button>
    </div>
  </div>

  <!-- Matching Engine Configurations & Alerts -->
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- Config Card -->
    <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-1">
      <div class="card-body gap-4">
        <h2 class="card-title text-xl flex items-center gap-2 border-b border-base-300 pb-2">
          <Smartphone class="h-5 w-5 text-secondary" />
          Alert Routing Info
        </h2>
        
        <div class="form-control">
          <label class="label cursor-pointer flex justify-between">
            <span class="label-text font-medium flex items-center gap-2">
              <Smartphone class="h-4 w-4 text-neutral-content" />
              Twilio SMS Alerts
            </span>
            <input type="checkbox" class="toggle toggle-secondary" bind:checked={twilioEnabled} />
          </label>
        </div>

        <div class="form-control">
          <label class="label cursor-pointer flex justify-between">
            <span class="label-text font-medium flex items-center gap-2">
              <Mail class="h-4 w-4 text-neutral-content" />
              Resend Email Alerts
            </span>
            <input type="checkbox" class="toggle toggle-primary" bind:checked={resendEnabled} />
          </label>
        </div>

        <div class="divider my-1"></div>

        <div class="space-y-2">
          <h3 class="text-xs font-bold uppercase tracking-wider text-neutral-content">Active Watchlist</h3>
          <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
            {#each appState.favorites as artist}
              <span class="badge badge-secondary badge-sm">{artist}</span>
            {/each}
            {#each appState.keywords as kw}
              <span class="badge badge-accent badge-sm">{kw}</span>
            {/each}
          </div>
          <p class="text-[10px] text-neutral-content leading-relaxed mt-1">
            You can modify target lists, add phone numbers, and customize credentials in the <strong>Settings</strong> tab.
          </p>
        </div>

        <div class="bg-base-300/40 rounded-xl p-3 text-xs space-y-1">
          <div class="flex justify-between">
            <span class="text-neutral-content">Active Workers:</span>
            <span class="text-success font-medium">Node Scraper (Active)</span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-content">Last Scan:</span>
            <span class="font-medium">{appState.lastScrapeTime || 'Never'}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-neutral-content">Tracks Monitored:</span>
            <span class="font-medium">{appState.favorites.length} Artists</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Notification Logs Card -->
    <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-2">
      <div class="card-body">
        <h2 class="card-title text-xl flex items-center justify-between border-b border-base-300 pb-2">
          <span class="flex items-center gap-2">
            <BellRing class="h-5 w-5 text-primary" />
            Live Dispatch Logs
          </span>
          <span class="text-xs font-normal text-neutral-content">Twilio & Resend Integration</span>
        </h2>

        <div class="space-y-3 max-h-[300px] overflow-y-auto pr-1">
          {#if appState.notificationLogs.length === 0}
            <div class="text-center py-12 text-neutral-content">
              <p>No alert dispatches logged yet.</p>
              <p class="text-xs mt-1">Add matching words or trigger "Simulate Drop Match" to fire alerts.</p>
            </div>
          {:else}
            {#each appState.notificationLogs as log}
              <div class="p-3 bg-base-300 rounded-xl border border-base-300/60 flex items-start gap-3">
                <div class="p-2 rounded-lg bg-base-100 mt-1">
                  {#if log.type === 'SMS'}
                    <Smartphone class="h-4 w-4 text-secondary" />
                  {:else}
                    <Mail class="h-4 w-4 text-primary" />
                  {/if}
                </div>
                <div class="flex-grow space-y-1">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-bold text-neutral-content">{log.type} sent to {log.recipient}</span>
                    <span class="text-[10px] text-neutral-content">{log.time}</span>
                  </div>
                  <p class="text-sm font-medium">{log.message}</p>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- Error Alerts -->
  {#if errorMsg}
    <div class="alert alert-warning shadow-lg">
      <AlertTriangle class="h-5 w-5" />
      <div>
        <h3 class="font-bold">Notice</h3>
        <div class="text-xs">{errorMsg}</div>
      </div>
    </div>
  {/if}

  <!-- Drops Feed Listing -->
  <div class="space-y-4">
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-base-300 pb-3">
      <h2 class="text-xl font-bold flex items-center gap-2">
        <Disc class="h-5 w-5 text-purple-500 animate-spin-slow-paused" />
        Reddit Forum Ingestion (Live Feed)
      </h2>
      
      <div class="flex items-center gap-2">
        <span class="text-xs text-neutral-content">Filter matched only:</span>
        <input type="checkbox" class="checkbox checkbox-primary checkbox-sm" bind:checked={matchOnly} />
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
      {#if displayedDrops.length === 0}
        <div class="col-span-full py-16 text-center bg-base-200 border border-base-300 rounded-2xl shadow-inner space-y-2">
          <Disc class="h-10 w-10 text-neutral-content/40 mx-auto animate-spin" />
          <p class="font-semibold text-neutral-content">No releases found</p>
          <p class="text-xs text-neutral-content/60">Press "Scan Forums" to poll new vinyl data.</p>
        </div>
      {:else}
        {#each displayedDrops as drop (drop.id)}
          <div 
            class="card bg-base-200 shadow-xl overflow-hidden border transition-all duration-300 hover:-translate-y-1 {drop.isMatched ? 'border-primary/50 neon-glow-primary' : 'border-base-300'}"
          >
            <!-- Badge overlay -->
            {#if drop.isMatched}
              <div class="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-[10px] uppercase font-bold py-1 px-3 flex items-center gap-1">
                <Sparkles class="h-3.5 w-3.5" />
                <span>ALERT MATCHED: {drop.matchReason}</span>
              </div>
            {/if}
            
            <div class="card-body p-5 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-1">
                  <span class="badge badge-neutral text-[10px]">r/{drop.subreddit}</span>
                  {#if drop.flair}
                    <span class="badge text-[9px] font-extrabold uppercase tracking-wide
                      {drop.flair.toLowerCase().includes('new release') ? 'badge-success text-white' : 
                       drop.flair.toLowerCase().includes('restock') ? 'badge-info text-white' :
                       drop.flair.toLowerCase().includes('pre-order') ? 'badge-primary text-white' :
                       drop.flair.toLowerCase().includes('limited') ? 'badge-error text-white' :
                       drop.flair.toLowerCase().includes('out of stock') ? 'badge-error text-white' :
                       'badge-secondary text-white'}"
                    >
                      {drop.flair}
                    </span>
                  {/if}
                </div>
                <span class="text-[10px] text-neutral-content font-medium">{new Date(drop.createdUtc).toLocaleTimeString()}</span>
              </div>

              <div class="space-y-1">
                <h3 class="font-bold text-lg leading-snug line-clamp-1" title={drop.artist}>{drop.artist}</h3>
                <h4 class="text-md font-medium text-neutral-content line-clamp-2" title={drop.album}>{drop.album}</h4>
              </div>

              <!-- Extra details -->
              <div class="text-xs space-y-1 bg-base-300/50 p-2.5 rounded-xl border border-base-300/40">
                <div><span class="text-neutral-content font-medium">Variant:</span> <span class="text-base-content line-clamp-1">{drop.variant}</span></div>
                <div><span class="text-neutral-content font-medium">Retailer:</span> <span class="text-base-content line-clamp-1">{drop.retailer}</span></div>
              </div>

              <!-- Display full title for context -->
              <p class="text-xs text-neutral-content/80 line-clamp-2 border-t border-base-300/50 pt-2 italic">
                "{drop.title}"
              </p>

              <!-- Actions -->
              <div class="card-actions flex justify-between items-center gap-2 pt-2 border-t border-base-300/50">
                <a 
                  href={drop.url} 
                  target="_blank" 
                  rel="noreferrer" 
                  class="btn btn-sm btn-ghost gap-1 px-2 text-xs"
                >
                  <ShoppingBag class="h-3.5 w-3.5" />
                  Buy Drop
                  <ExternalLink class="h-3 w-3" />
                </a>

                <div class="flex gap-1.5">
                  <a 
                    href={drop.permalink} 
                    target="_blank" 
                    rel="noreferrer" 
                    class="btn btn-sm btn-circle btn-neutral"
                    title="View original Reddit thread"
                    aria-label="Reddit Thread"
                  >
                    <ExternalLink class="h-3.5 w-3.5" />
                  </a>

                  <button 
                    onclick={() => handleAddToCrate(drop)}
                    class="btn btn-sm btn-primary btn-square"
                    title="Add directly to your Crate"
                    aria-label="Add to Crate"
                  >
                    <Plus class="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
