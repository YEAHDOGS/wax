<script>
  import { appState, actions } from './store.svelte.js';
  import { 
    Search, 
    Plus, 
    Trash2, 
    Disc, 
    Star, 
    Music, 
    FileText, 
    Calendar,
    Globe,
    Compass,
    Radio
  } from '@lucide/svelte';

  let searchQuery = $state('');
  let selectedGenre = $state('All');

  // Modal State
  let showModal = $state(false);
  let recordForm = $state({
    artist: '',
    album: '',
    variant: '',
    retailer: '',
    year: new Date().getFullYear(),
    genre: 'Alternative',
    rating: 5,
    coverUrl: '',
    notes: '',
    color: '#3b82f6'
  });

  // Spotify/Apple Music Search integration inside Add Modal
  let streamingSearchQuery = $state('');
  let activeSearchService = $state('spotify'); // 'spotify' or 'apple'
  let searchResults = $state([]);
  let isSearchingStreaming = $state(false);

  // Filtered crate collection
  let filteredCrate = $derived(
    appState.crate.filter(item => {
      const matchesSearch = 
        item.artist.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.album.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.variant && item.variant.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesGenre = selectedGenre === 'All' || item.genre === selectedGenre;
      return matchesSearch && matchesGenre;
    })
  );

  // Extract all unique genres for filter options
  let genres = $derived(['All', ...new Set(appState.crate.map(item => item.genre))]);

  function handleSaveRecord() {
    actions.addToCrate({ ...recordForm });
    showModal = false;
    // Reset form
    recordForm = {
      artist: '',
      album: '',
      variant: 'Standard Black Pressing',
      retailer: 'General Retailer',
      year: new Date().getFullYear(),
      genre: 'Alternative',
      rating: 5,
      coverUrl: '',
      notes: '',
      color: '#3b82f6'
    };
    searchResults = [];
    streamingSearchQuery = '';
  }

  // Simulate Spotify/Apple Music album lookup
  function searchStreamingAlbums() {
    if (!streamingSearchQuery.trim()) return;
    isSearchingStreaming = true;
    searchResults = [];

    setTimeout(() => {
      // Mock results based on query
      const query = streamingSearchQuery.toLowerCase();
      const db = [
        {
          artist: 'Daft Punk',
          album: 'Random Access Memories',
          year: 2013,
          genre: 'Electronic',
          coverUrl: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80',
          color: '#fbbf24'
        },
        {
          artist: 'Gorillaz',
          album: 'Demon Days',
          year: 2005,
          genre: 'Alternative',
          coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
          color: '#ef4444'
        },
        {
          artist: 'Tame Impala',
          album: 'Currents',
          year: 2015,
          genre: 'Alternative',
          coverUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80',
          color: '#ec4899'
        },
        {
          artist: 'Radiohead',
          album: 'OK Computer',
          year: 1997,
          genre: 'Rock',
          coverUrl: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80',
          color: '#3b82f6'
        },
        {
          artist: 'Lana Del Rey',
          album: 'Norman Fucking Rockwell!',
          year: 2019,
          genre: 'Pop',
          coverUrl: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=400&q=80',
          color: '#10b981'
        }
      ];

      // Simple match
      searchResults = db.filter(item => 
        item.artist.toLowerCase().includes(query) || 
        item.album.toLowerCase().includes(query)
      );

      // Default result if no match
      if (searchResults.length === 0) {
        searchResults = [{
          artist: streamingSearchQuery,
          album: 'Self Titled Album',
          year: new Date().getFullYear(),
          genre: 'Alternative',
          coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
          color: '#6b7280',
          isCustom: true
        }];
      }
      isSearchingStreaming = false;
    }, 1000);
  }

  function selectSearchResult(result) {
    recordForm.artist = result.artist;
    recordForm.album = result.album;
    recordForm.year = result.year;
    recordForm.genre = result.genre;
    recordForm.coverUrl = result.coverUrl;
    recordForm.color = result.color || '#3b82f6';
    searchResults = [];
    streamingSearchQuery = '';
  }
</script>

<div class="space-y-6">
  <!-- Header Control Row -->
  <div class="flex flex-col sm:flex-row gap-4 items-center justify-between">
    <div class="space-y-1 text-center sm:text-left">
      <h1 class="text-3xl font-bold tracking-tight">Virtual Crate</h1>
      <p class="text-sm text-neutral-content">
        Manage, query, and browse your digital library. Showcase pressing colors, quality notes, and rotation.
      </p>
    </div>

    <button onclick={() => showModal = true} class="btn btn-primary neon-glow-primary w-full sm:w-auto">
      <Plus class="h-4 w-4" />
      Catalog Vinyl
    </button>
  </div>

  <!-- Filters Row -->
  <div class="flex flex-col md:flex-row gap-4 items-center bg-base-200 border border-base-300 p-4 rounded-xl shadow-md">
    <!-- Search -->
    <div class="relative w-full md:flex-grow">
      <Search class="absolute left-3.5 top-3.5 h-4 w-4 text-neutral-content" />
      <input 
        type="text" 
        placeholder="Search crate (artist, album, pressing color...)" 
        class="input input-bordered pl-10 w-full" 
        bind:value={searchQuery}
      />
    </div>

    <!-- Genre Select -->
    <div class="w-full md:w-48">
      <select class="select select-bordered w-full" bind:value={selectedGenre}>
        <option disabled selected>Filter by Genre</option>
        {#each genres as genre}
          <option value={genre}>{genre}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Catalog Card Grid -->
  {#if filteredCrate.length === 0}
    <div class="py-20 text-center bg-base-200 border border-base-300 rounded-2xl shadow-inner space-y-3">
      <Disc class="h-12 w-12 text-neutral-content/40 mx-auto animate-spin-slow-paused" />
      <p class="font-semibold text-neutral-content">Your Crate is Empty</p>
      <p class="text-xs text-neutral-content/60 max-w-sm mx-auto">
        Search and add custom records manually, import from Discogs, or click "Add to Crate" directly from matched drop alerts!
      </p>
      <button onclick={() => showModal = true} class="btn btn-primary btn-sm mt-2">Add First Record</button>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
      {#each filteredCrate as item (item.id)}
        <div class="card bg-base-200 border border-base-300 shadow-xl overflow-hidden group hover:border-primary/50 transition-all duration-300">
          <div class="flex p-4 gap-4 items-center relative">
            <!-- Vinyl Album Jacket Cover -->
            <div class="relative w-28 h-28 flex-shrink-0 z-10 transition-transform duration-300 group-hover:scale-105">
              <img 
                src={item.coverUrl || 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80'} 
                alt="Album Cover" 
                class="w-full h-full object-cover rounded shadow-lg border border-base-300 relative z-10" 
              />
              
              <!-- Micro-animation: Vinyl record sliding out from cover on hover -->
              <div 
                class="absolute inset-y-0 w-28 h-28 rounded-full z-0 flex items-center justify-center transition-all duration-500 transform group-hover:translate-x-8 animate-spin-slow-paused group-hover:animate-spin-slow"
                style="background: radial-gradient(circle, #2e1065 15%, #09090b 25%, #18181b 35%, #09090b 45%, #1e293b 55%, #09090b 70%); border: 1px solid #1e293b; left: 0;"
              >
                <!-- Vinyl center colorway tag matching the physical variant color -->
                <div 
                  class="w-8 h-8 rounded-full border-2 border-black"
                  style="background-color: {item.color || '#f43f5e'}"
                ></div>
              </div>
            </div>

            <!-- Details Block -->
            <div class="flex-grow min-w-0 z-10">
              <div class="flex items-center gap-1.5 justify-between">
                <span class="badge badge-sm badge-neutral">{item.genre}</span>
                <span class="text-[10px] text-neutral-content">{item.year}</span>
              </div>
              <h2 class="font-bold text-lg leading-snug line-clamp-1 mt-1">{item.album}</h2>
              <p class="text-sm font-semibold text-neutral-content line-clamp-1">{item.artist}</p>
              
              <div class="text-xs text-neutral-content/90 line-clamp-1 mt-1.5 flex items-center gap-1.5">
                <span 
                  class="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                  style="background-color: {item.color || '#3b82f6'}"
                ></span>
                <span class="line-clamp-1">{item.variant}</span>
              </div>

              <!-- Rating -->
              <div class="flex gap-0.5 mt-2">
                {#each Array(5) as _, i}
                  <Star class="h-3.5 w-3.5 {i < item.rating ? 'text-warning fill-warning' : 'text-neutral-content/30'}" />
                {/each}
              </div>
            </div>
          </div>

          <!-- Bottom Action Drawer -->
          <div class="bg-base-300/60 border-t border-base-300 px-4 py-2.5 flex justify-between items-center">
            <span class="text-[10px] text-neutral-content font-medium line-clamp-1 flex items-center gap-1">
              <Globe class="h-3 w-3" />
              Source: {item.retailer}
            </span>
            <button 
              onclick={() => actions.removeFromCrate(item.id)}
              class="btn btn-ghost btn-xs text-error btn-square hover:bg-error/15"
              title="Remove from Crate"
              aria-label="Remove from Crate"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- Hover expansion: pressing notes -->
          {#if item.notes}
            <div class="px-4 pb-3 pt-1 bg-base-300/60 text-xs text-neutral-content border-t border-base-300/30">
              <p class="italic leading-relaxed">"{item.notes}"</p>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Catalog Modal -->
  {#if showModal}
    <div class="modal modal-open">
      <div class="modal-box w-11/12 max-w-2xl bg-base-200 border border-base-300">
        <h3 class="font-bold text-xl mb-4 border-b border-base-300 pb-2 flex items-center gap-2">
          <Disc class="h-6 w-6 text-primary" />
          Catalog Vinyl Release
        </h3>

        <!-- Streaming Music Search Bar (Spotify & Apple Music metadata syncing) -->
        <div class="bg-base-300/50 p-4 rounded-xl border border-base-300/60 mb-6 space-y-3">
          <label class="text-xs font-bold uppercase tracking-wider text-neutral-content flex items-center gap-1.5" for="meta-search">
            <Music class="h-3.5 w-3.5 text-success" />
            Import Metadata from Streaming Service (Autocomplete)
          </label>
          <div class="flex gap-2">
            <!-- Service Selector Toggle -->
            <div class="join">
              <button 
                onclick={() => activeSearchService = 'spotify'} 
                class="btn btn-sm join-item {activeSearchService === 'spotify' ? 'btn-success text-white' : 'btn-neutral'}"
              >
                Spotify
              </button>
              <button 
                onclick={() => activeSearchService = 'apple'} 
                class="btn btn-sm join-item {activeSearchService === 'apple' ? 'btn-error text-white' : 'btn-neutral'}"
              >
                Apple Music
              </button>
            </div>

            <!-- Input -->
            <div class="relative flex-grow">
              <input 
                id="meta-search"
                type="text" 
                placeholder="Search artist or album name..." 
                class="input input-bordered input-sm w-full"
                bind:value={streamingSearchQuery}
                onkeydown={(e) => e.key === 'Enter' && searchStreamingAlbums()}
              />
            </div>
            <button onclick={searchStreamingAlbums} class="btn btn-sm btn-primary">Search</button>
          </div>

          <!-- Dropdown Search Results -->
          {#if isSearchingStreaming}
            <div class="text-center py-2 text-xs text-neutral-content">
              <span class="loading loading-spinner loading-xs mr-2"></span>
              Searching {activeSearchService === 'spotify' ? 'Spotify' : 'Apple Music'} database...
            </div>
          {/if}

          {#if searchResults.length > 0}
            <div class="bg-base-200 rounded-lg p-2 max-h-40 overflow-y-auto border border-base-300 space-y-1">
              {#each searchResults as result}
                <button 
                  onclick={() => selectSearchResult(result)}
                  class="flex items-center gap-3 w-full p-2 hover:bg-base-300 rounded text-left transition-colors"
                >
                  <img src={result.coverUrl} alt="Preview cover" class="w-8 h-8 rounded object-cover shadow" />
                  <div class="flex-grow min-w-0">
                    <p class="text-sm font-bold truncate">{result.album}</p>
                    <p class="text-xs text-neutral-content truncate">{result.artist}</p>
                  </div>
                  <span class="badge badge-outline badge-xs text-neutral-content">{result.year}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Catalog Form -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="form-control w-full">
            <label class="label" for="artist-name">
              <span class="label-text font-bold">Artist Name</span>
            </label>
            <input 
              id="artist-name"
              type="text" 
              placeholder="e.g. Daft Punk" 
              class="input input-bordered w-full" 
              bind:value={recordForm.artist}
            />
          </div>

          <div class="form-control w-full">
            <label class="label" for="album-title">
              <span class="label-text font-bold">Album Title</span>
            </label>
            <input 
              id="album-title"
              type="text" 
              placeholder="e.g. Discovery" 
              class="input input-bordered w-full" 
              bind:value={recordForm.album}
            />
          </div>

          <div class="form-control w-full">
            <label class="label" for="colorway-details">
              <span class="label-text font-bold">Colorway / Pressing Details</span>
            </label>
            <input 
              id="colorway-details"
              type="text" 
              placeholder="e.g. Orange Translucent Vinyl" 
              class="input input-bordered w-full" 
              bind:value={recordForm.variant}
            />
          </div>

          <div class="form-control w-full">
            <label class="label" for="vinyl-color">
              <span class="label-text font-bold">Jacket Spine/Vinyl Color HEX</span>
            </label>
            <div class="flex gap-2">
              <input 
                id="vinyl-color"
                type="color" 
                class="input input-bordered p-1 w-16 h-12" 
                bind:value={recordForm.color}
              />
              <input 
                type="text" 
                class="input input-bordered flex-grow" 
                bind:value={recordForm.color}
              />
            </div>
          </div>

          <div class="form-control w-full">
            <label class="label" for="retailer-outlet">
              <span class="label-text font-bold">Retailer / Outlet</span>
            </label>
            <input 
              id="retailer-outlet"
              type="text" 
              placeholder="e.g. Rough Trade, Blood Records" 
              class="input input-bordered w-full" 
              bind:value={recordForm.retailer}
            />
          </div>

          <div class="form-control w-full">
            <label class="label" for="press-year">
              <span class="label-text font-bold">Pressing Year</span>
            </label>
            <input 
              id="press-year"
              type="number" 
              class="input input-bordered w-full" 
              bind:value={recordForm.year}
            />
          </div>

          <div class="form-control w-full">
            <label class="label" for="genre-select">
              <span class="label-text font-bold">Genre</span>
            </label>
            <select class="select select-bordered" bind:value={recordForm.genre} id="genre-select">
              <option>Alternative</option>
              <option>Electronic</option>
              <option>Hip Hop</option>
              <option>Pop</option>
              <option>Rock</option>
              <option>Jazz</option>
              <option>Vaporwave</option>
            </select>
          </div>

          <div class="form-control w-full">
            <label class="label" for="rating-select">
              <span class="label-text font-bold">Collector Rating</span>
            </label>
            <select class="select select-bordered" bind:value={recordForm.rating} id="rating-select">
              <option value={5}>⭐⭐⭐⭐⭐ (Perfect Pressing)</option>
              <option value={4}>⭐⭐⭐⭐ (Great sound)</option>
              <option value={3}>⭐⭐⭐ (Average Pressing)</option>
              <option value={2}>⭐⭐ (Surface Noise)</option>
              <option value={1}>⭐ (Bad pressing/warped)</option>
            </select>
          </div>

          <div class="form-control w-full col-span-full">
            <label class="label" for="cover-art-url">
              <span class="label-text font-bold">Cover Art Image URL</span>
            </label>
            <input 
              id="cover-art-url"
              type="text" 
              placeholder="Paste image URL (or leave empty for default)" 
              class="input input-bordered w-full" 
              bind:value={recordForm.coverUrl}
            />
          </div>

          <div class="form-control w-full col-span-full">
            <label class="label" for="notes-textbox">
              <span class="label-text font-bold">Pressing Notes / Flex Description</span>
            </label>
            <textarea 
              id="notes-textbox"
              class="textarea textarea-bordered h-20" 
              placeholder="e.g. Sounds super crisp, gatefold artwork is beautiful, numbered #24/500..." 
              bind:value={recordForm.notes}
            ></textarea>
          </div>
        </div>

        <div class="modal-action">
          <button onclick={() => showModal = false} class="btn btn-neutral">Cancel</button>
          <button onclick={handleSaveRecord} class="btn btn-primary neon-glow-primary">Save to Crate</button>
        </div>
      </div>
    </div>
  {/if}
</div>
