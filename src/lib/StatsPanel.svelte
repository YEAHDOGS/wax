<script>
  import { appState } from './store.svelte.js';
  import { BarChart3, Disc, Heart, Calendar } from '@lucide/svelte';

  // Calculations for stats
  let totalRecords = $derived(appState.crate.length);
  
  let colorVariantsCount = $derived(
    appState.crate.filter(item => 
      item.variant && 
      item.variant.toLowerCase().includes('vinyl') && 
      !item.variant.toLowerCase().includes('black')
    ).length
  );
  
  let averageRating = $derived(
    totalRecords > 0
      ? (appState.crate.reduce((acc, curr) => acc + curr.rating, 0) / totalRecords).toFixed(1)
      : '0.0'
  );

  // Genre distribution
  let genreStats = $derived.by(() => {
    const stats = {};
    appState.crate.forEach(item => {
      stats[item.genre] = (stats[item.genre] || 0) + 1;
    });
    return Object.entries(stats).map(([name, count]) => ({
      name,
      count,
      percentage: totalRecords > 0 ? Math.round((count / totalRecords) * 100) : 0
    })).sort((a, b) => b.count - a.count);
  });

  // Color profiles distribution (using the HEX color field)
  let colorStats = $derived.by(() => {
    const stats = {};
    appState.crate.forEach(item => {
      // Group by hex color
      const color = item.color || '#3b82f6';
      stats[color] = (stats[color] || 0) + 1;
    });
    let offsetAccum = 0;
    return Object.entries(stats).map(([colorHex, count]) => {
      const percentage = totalRecords > 0 ? Math.round((count / totalRecords) * 100) : 0;
      const stroke = percentage * 2.51; // 2 * pi * r = 251.2
      const currentOffset = offsetAccum;
      offsetAccum += stroke;
      return {
        color: colorHex,
        count,
        percentage,
        stroke,
        offset: currentOffset
      };
    });
  });

  // Year breakdown (Decades)
  let decadeStats = $derived.by(() => {
    const stats = {};
    appState.crate.forEach(item => {
      const decade = Math.floor(item.year / 10) * 10 + 's';
      stats[decade] = (stats[decade] || 0) + 1;
    });
    return Object.entries(stats).map(([name, count]) => ({
      name,
      count
    })).sort((a, b) => b.name.localeCompare(a.name));
  });
</script>

<div class="space-y-6">
  <div class="space-y-1 text-center sm:text-left">
    <h1 class="text-3xl font-bold tracking-tight">Crate Analytics</h1>
    <p class="text-sm text-neutral-content">
      A beautiful breakdowns of your library by genre, color profiles, release decade, and pressing ratings.
    </p>
  </div>

  <!-- Metric Overview Cards -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    <!-- Card 1 -->
    <div class="stat bg-base-200 border border-base-300 rounded-2xl shadow-md p-4 flex flex-col justify-between">
      <div class="flex items-center justify-between text-neutral-content">
        <span class="text-xs font-semibold uppercase tracking-wider">Total Crate</span>
        <Disc class="h-5 w-5 text-primary" />
      </div>
      <div class="mt-2">
        <div class="text-3xl font-bold">{totalRecords}</div>
        <p class="text-[10px] text-neutral-content mt-1">Releases cataloged</p>
      </div>
    </div>

    <!-- Card 2 -->
    <div class="stat bg-base-200 border border-base-300 rounded-2xl shadow-md p-4 flex flex-col justify-between">
      <div class="flex items-center justify-between text-neutral-content">
        <span class="text-xs font-semibold uppercase tracking-wider">Variants Ratio</span>
        <BarChart3 class="h-5 w-5 text-secondary" />
      </div>
      <div class="mt-2">
        <div class="text-3xl font-bold">
          {totalRecords > 0 ? Math.round((colorVariantsCount / totalRecords) * 100) : 0}%
        </div>
        <p class="text-[10px] text-neutral-content mt-1">{colorVariantsCount} colored variants</p>
      </div>
    </div>

    <!-- Card 3 -->
    <div class="stat bg-base-200 border border-base-300 rounded-2xl shadow-md p-4 flex flex-col justify-between">
      <div class="flex items-center justify-between text-neutral-content">
        <span class="text-xs font-semibold uppercase tracking-wider">Avg Quality</span>
        <Heart class="h-5 w-5 text-accent" />
      </div>
      <div class="mt-2">
        <div class="text-3xl font-bold">{averageRating} / 5.0</div>
        <p class="text-[10px] text-neutral-content mt-1">Average pressing rating</p>
      </div>
    </div>

    <!-- Card 4 -->
    <div class="stat bg-base-200 border border-base-300 rounded-2xl shadow-md p-4 flex flex-col justify-between">
      <div class="flex items-center justify-between text-neutral-content">
        <span class="text-xs font-semibold uppercase tracking-wider">Decades Spanned</span>
        <Calendar class="h-5 w-5 text-warning" />
      </div>
      <div class="mt-2">
        <div class="text-3xl font-bold">{decadeStats.length}</div>
        <p class="text-[10px] text-neutral-content mt-1">Eras in collection</p>
      </div>
    </div>
  </div>

  {#if totalRecords === 0}
    <div class="py-16 text-center bg-base-200 border border-base-300 rounded-2xl">
      <p class="text-neutral-content">No stats to display yet. Add albums to your crate to populate analytics.</p>
    </div>
  {:else}
    <!-- Graphs Row -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Color Variant Profiles SVG Doughnut Chart -->
      <div class="card bg-base-200 border border-base-300 shadow-xl">
        <div class="card-body">
          <h2 class="card-title border-b border-base-300 pb-2 flex items-center gap-2">
            <span class="w-3 h-3 rounded-full bg-accent"></span>
            Crate Colorway Profile
          </h2>
          
          <div class="flex flex-col sm:flex-row items-center justify-around gap-6 py-4">
            <!-- SVG Circle Chart -->
            <div class="relative w-40 h-40">
              <svg viewBox="0 0 100 100" class="w-full h-full transform -rotate-90">
                <circle cx="50" cy="50" r="40" fill="transparent" stroke="rgba(255, 255, 255, 0.08)" stroke-width="12" />
                
                <!-- Construct segments dynamic -->
                {#each colorStats as segment}
                  <circle 
                    cx="50" 
                    cy="50" 
                    r="40" 
                    fill="transparent" 
                    stroke={segment.color} 
                    stroke-width="12" 
                    stroke-dasharray="{segment.stroke} 251" 
                    stroke-dashoffset={-segment.offset}
                    stroke-linecap="round"
                    class="transition-all duration-500 hover:stroke-[14px]"
                  />
                {/each}
              </svg>

              <!-- Central label -->
              <div class="absolute inset-0 flex flex-col items-center justify-center">
                <span class="text-[10px] text-neutral-content font-bold uppercase">Colorways</span>
                <span class="text-2xl font-bold">{colorStats.length}</span>
              </div>
            </div>

            <!-- Legend -->
            <div class="space-y-2">
              {#each colorStats as segment}
                <div class="flex items-center gap-3 text-xs font-semibold">
                  <span class="w-4 h-4 rounded-full border border-black/20" style="background-color: {segment.color}"></span>
                  <span class="text-neutral-content flex-grow">{segment.percentage}% ({segment.count} LPs)</span>
                </div>
              {/each}
            </div>
          </div>
        </div>
      </div>

      <!-- Genres Bar Breakdown -->
      <div class="card bg-base-200 border border-base-300 shadow-xl">
        <div class="card-body">
          <h2 class="card-title border-b border-base-300 pb-2">Genre Distributions</h2>
          
          <div class="space-y-4 py-2">
            {#each genreStats as genre}
              <div class="space-y-1">
                <div class="flex justify-between items-center text-xs font-bold">
                  <span>{genre.name}</span>
                  <span class="text-neutral-content">{genre.count} Records ({genre.percentage}%)</span>
                </div>
                <div class="w-full bg-base-300 rounded-full h-2.5 overflow-hidden">
                  <div 
                    class="bg-gradient-to-r from-primary to-secondary h-2.5 rounded-full" 
                    style="width: {genre.percentage}%"
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      </div>

      <!-- Decade Era Breakdown -->
      <div class="card bg-base-200 border border-base-300 shadow-xl lg:col-span-2">
        <div class="card-body">
          <h2 class="card-title border-b border-base-300 pb-2">Release Eras</h2>
          
          <div class="flex flex-wrap items-end justify-between gap-4 py-4 min-h-36">
            {#each decadeStats as decade}
              <div class="flex-grow flex flex-col items-center gap-2">
                <!-- Calculated height dynamically -->
                <div class="text-xs font-bold text-neutral-content">{decade.count} LPs</div>
                <div 
                  class="w-full max-w-20 rounded-t-lg bg-gradient-to-t from-purple-500/30 to-pink-500 text-center text-white flex items-end justify-center font-bold text-xs pb-1 transition-all duration-300 hover:opacity-95" 
                  style="height: {Math.max(30, decade.count * 30)}px;"
                >
                </div>
                <div class="text-xs font-semibold uppercase">{decade.name}</div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
