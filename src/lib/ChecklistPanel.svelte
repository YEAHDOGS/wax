<script>
  import { appState, actions } from './store.svelte.js';
  import { 
    Search, 
    CheckCircle, 
    ShoppingCart, 
    ExternalLink, 
    Disc, 
    Sparkles, 
    PlusCircle,
    Lock
  } from '@lucide/svelte';
  import MatrixText from './MatrixText.svelte';

  let searchQuery = $state('');
  
  // Calculate ownership metrics dynamically
  let artistReleases = $derived(appState.checklistReleases);
  let artistName = $derived(appState.checklistArtist || '');
  
  // Helper to parse title (e.g. "Bob Dylan - Highway 61 Revisited" -> "Highway 61 Revisited")
  function getAlbumTitle(fullTitle) {
    if (!fullTitle) return '';
    const parts = fullTitle.split(' - ');
    return parts.length > 1 ? parts.slice(1).join(' - ') : fullTitle;
  }

  // Helper to determine if a checklist item is owned in appState.crate
  function checkOwnership(title) {
    const albumName = getAlbumTitle(title).toLowerCase();
    const artistLower = artistName.toLowerCase();
    
    return appState.crate.some(item => {
      const isArtistMatch = item.artist.toLowerCase().includes(artistLower) || 
                            artistLower.includes(item.artist.toLowerCase());
      const isAlbumMatch = item.album.toLowerCase() === albumName || 
                           item.album.toLowerCase().includes(albumName) ||
                           albumName.includes(item.album.toLowerCase());
      return isArtistMatch && isAlbumMatch;
    });
  }

  let ownedCount = $derived(
    artistReleases.filter(r => checkOwnership(r.title)).length
  );
  let totalCount = $derived(artistReleases.length);
  let percentOwned = $derived(
    totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0
  );

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    await actions.fetchArtistDiscography(searchQuery);
  }

  function handleQuickAdd(release) {
    const album = getAlbumTitle(release.title);
    actions.addToCrate({
      artist: artistName,
      album: album,
      variant: 'Standard Vinyl Pressing',
      retailer: 'Manual Ingestion',
      year: release.year !== 'Unknown' ? parseInt(release.year) : new Date().getFullYear(),
      genre: 'Rock',
      rating: 5,
      notes: 'Added from checklist tracker.',
      coverUrl: release.cover_image,
      color: '#a855f7'
    });
  }
</script>

<div class="space-y-6">
  <!-- Title card -->
  <div class="space-y-1 text-center sm:text-left">
    <h1 class="text-3xl font-bold tracking-tight">Artist Checklists</h1>
    <p class="text-sm text-neutral-content">
      Check off official discographies, see what you own vs what you're missing, and find redirects to purchase missing variants.
    </p>
  </div>

  <!-- Search input -->
  <div class="flex flex-col sm:flex-row gap-3 bg-base-200 border border-base-300 p-4 rounded-xl shadow-md">
    <div class="relative flex-grow">
      <Search class="absolute left-3.5 top-3.5 h-4 w-4 text-neutral-content" />
      <input 
        type="text" 
        placeholder="Enter artist (e.g. Bob Dylan, Daft Punk...)" 
        class="input input-bordered pl-10 w-full"
        bind:value={searchQuery}
        onkeydown={(e) => e.key === 'Enter' && handleSearch()}
      />
    </div>
    <button onclick={handleSearch} class="btn btn-primary neon-glow-primary w-full sm:w-32">
      Search
    </button>
  </div>

  <!-- Quick Artist Suggestions -->
  <div class="flex flex-wrap gap-2 items-center text-xs">
    <span class="font-semibold text-neutral-content/60">Quick Suggestions:</span>
    <button onclick={() => { searchQuery = 'Bob Dylan'; handleSearch(); }} class="badge badge-primary badge-outline hover:bg-primary hover:text-white transition-colors cursor-pointer">Bob Dylan</button>
    <button onclick={() => { searchQuery = 'Daft Punk'; handleSearch(); }} class="badge badge-primary badge-outline hover:bg-primary hover:text-white transition-colors cursor-pointer">Daft Punk</button>
  </div>

  <!-- Loading State -->
  {#if appState.checklistLoading}
    <div class="py-20 text-center space-y-3 bg-base-200 border border-base-300 rounded-2xl shadow-inner">
      <div class="loading loading-spinner loading-lg text-primary"></div>
      <p class="text-sm font-semibold text-neutral-content">Scanning Discogs database for master releases...</p>
    </div>
  {:else if artistReleases.length > 0}
    <!-- Checklist Stats Card -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 bg-neutral/20 border border-base-300 p-6 rounded-2xl shadow-xl backdrop-blur-md">
      <div class="md:col-span-2 space-y-4">
        <div>
          <span class="text-xs uppercase font-bold tracking-wider text-primary">Collector Stats</span>
          <h2 class="text-3xl font-black text-white flex items-center gap-2 mt-1">
            <MatrixText text={artistName} /> Discography
          </h2>
        </div>
        
        <!-- Progress bar visual -->
        <div class="space-y-2">
          <div class="flex justify-between text-sm font-bold">
            <span class="text-neutral-content">Owned Pressings</span>
            <span class="text-primary">{ownedCount} / {totalCount} Releases ({percentOwned}%)</span>
          </div>
          <div class="w-full bg-base-300 rounded-full h-3 border border-base-300 overflow-hidden shadow-inner">
            <div 
              class="bg-primary h-full transition-all duration-700 shadow-md"
              style="width: {percentOwned}%"
            ></div>
          </div>
        </div>
      </div>

      <!-- Achievements indicator inside Checklist -->
      <div class="flex flex-col items-center justify-center bg-base-300/60 p-4 rounded-xl border border-base-300 text-center">
        <div class="text-4xl">🏆</div>
        <p class="text-sm font-bold text-white mt-2">
          {percentOwned === 100 ? 'Discography Mastered!' : 'Keep Digging!'}
        </p>
        <p class="text-xs text-neutral-content/70 mt-1 max-w-[180px]">
          {percentOwned === 100 
            ? `You cataloged every single release of ${artistName}!` 
            : `Add ${totalCount - ownedCount} more albums to unlock ultimate discography badges.`}
        </p>
      </div>
    </div>

    <!-- Checklist Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      {#each artistReleases as release (release.id)}
        {@const isOwned = checkOwnership(release.title)}
        {@const albumTitle = getAlbumTitle(release.title)}
        
        <div class="flex p-4 gap-4 items-center bg-base-200 border {isOwned ? 'border-success/30' : 'border-base-300'} rounded-xl shadow hover:shadow-md transition-all">
          <!-- Album Thumbnail -->
          <img 
            src={release.cover_image} 
            alt={albumTitle} 
            class="w-16 h-16 rounded object-cover shadow border border-base-300 flex-shrink-0"
          />

          <!-- details -->
          <div class="flex-grow min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-xs font-semibold text-neutral-content">({release.year})</span>
              {#if isOwned}
                <span class="badge badge-success badge-sm font-bold flex gap-0.5 items-center">
                  Owned
                </span>
              {:else}
                <span class="badge badge-neutral badge-sm font-bold flex gap-0.5 items-center">
                  Missing
                </span>
              {/if}
            </div>
            <h3 class="font-bold text-base leading-snug line-clamp-1 mt-1">{albumTitle}</h3>
            
            <!-- Quick Actions -->
            <div class="flex flex-wrap gap-2 mt-2">
              {#if isOwned}
                <button 
                  class="btn btn-xs btn-success btn-outline pointer-events-none"
                  disabled
                >
                  <CheckCircle class="h-3 w-3" />
                  In Crate
                </button>
              {:else}
                <button 
                  onclick={() => handleQuickAdd(release)}
                  class="btn btn-xs btn-neutral flex items-center gap-1"
                  title="Catalog a standard copy directly to Crate"
                >
                  <PlusCircle class="h-3 w-3 text-primary" />
                  Quick Catalog
                </button>
                
                <a 
                  href="https://www.discogs.com/sell/list?q={encodeURIComponent(release.title)}&format=Vinyl" 
                  target="_blank" 
                  rel="noreferrer" 
                  class="btn btn-xs btn-primary btn-outline flex items-center gap-1"
                >
                  <ShoppingCart class="h-3 w-3" />
                  Buy Vinyl
                </a>

                <a 
                  href="https://www.ebay.com/sch/i.html?_nkw={encodeURIComponent(release.title)}+vinyl" 
                  target="_blank" 
                  rel="noreferrer" 
                  class="btn btn-xs btn-ghost text-neutral-content flex items-center gap-1 hover:bg-neutral/15"
                >
                  <ExternalLink class="h-3 w-3" />
                  eBay
                </a>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="py-20 text-center space-y-4 bg-base-200 border border-base-300 rounded-2xl shadow-inner max-w-4xl mx-auto">
      <Disc class="h-14 w-14 text-neutral-content/40 mx-auto animate-spin-slow-paused" />
      <div class="space-y-1">
        <p class="font-bold text-lg text-white">No Discography Synced Yet</p>
        <p class="text-xs text-neutral-content/60 max-w-sm mx-auto">
          Type an artist name (e.g. <strong>Bob Dylan</strong> or <strong>Daft Punk</strong>) above to query their release history and match your owned library.
        </p>
      </div>
      <div class="flex justify-center gap-3 mt-2">
        <button onclick={() => { searchQuery = 'Bob Dylan'; handleSearch(); }} class="btn btn-primary btn-sm flex items-center gap-1">
          <Sparkles class="h-3.5 w-3.5" />
          Track Bob Dylan
        </button>
        <button onclick={() => { searchQuery = 'Daft Punk'; handleSearch(); }} class="btn btn-neutral btn-sm flex items-center gap-1">
          Track Daft Punk
        </button>
      </div>
    </div>
  {/if}
</div>
