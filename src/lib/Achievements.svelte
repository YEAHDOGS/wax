<script>
  import { appState } from './store.svelte.js';
  import { Trophy, Star, ShieldAlert, Calendar } from '@lucide/svelte';

  // Calculate stats for level
  let totalUnlocked = $derived(appState.achievements.filter(a => a.unlocked).length);
  let totalAchievements = $derived(appState.achievements.length);
  let levelProgress = $derived(Math.round((totalUnlocked / totalAchievements) * 100));

  // Determine user title/tier based on collection
  let userTier = $derived.by(() => {
    const count = appState.crate.length;
    if (count >= 10) return 'Archivist Master';
    if (count >= 5) return 'Groove Guru';
    if (count >= 1) return 'Active Digger';
    return 'Novice Collector';
  });
</script>

<div class="space-y-6">
  <div class="space-y-1 text-center sm:text-left">
    <h1 class="text-3xl font-bold tracking-tight">Collector Milestones</h1>
    <p class="text-sm text-neutral-content">
      Earn badges and increase your collector level by cataloging rare variants, linking streaming accounts, and matching forum alerts.
    </p>
  </div>

  <!-- Gamification Level Summary Panel -->
  <div class="card bg-base-200 border border-base-300 shadow-xl overflow-hidden">
    <div class="bg-gradient-to-r from-purple-600 via-pink-600 to-amber-500 p-6 text-white flex flex-col md:flex-row items-center justify-between gap-6">
      <div class="flex items-center gap-4 text-center md:text-left">
        <div class="w-16 h-16 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/30 text-3xl font-bold">
          4
        </div>
        <div class="space-y-0.5">
          <div class="badge badge-warning text-xs font-extrabold tracking-wider">{userTier}</div>
          <h2 class="text-2xl font-black">Collector Level 4</h2>
          <p class="text-xs text-white/80">Keep cataloging variants to unlock Level 5</p>
        </div>
      </div>

      <div class="w-full md:w-80 space-y-2">
        <div class="flex justify-between items-center text-xs font-bold">
          <span>Achievements Unlocked:</span>
          <span>{totalUnlocked} / {totalAchievements} ({levelProgress}%)</span>
        </div>
        <progress class="progress progress-warning w-full" value={totalUnlocked} max={totalAchievements}></progress>
      </div>
    </div>
  </div>

  <!-- Achievements Badge Grid -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    {#each appState.achievements as badge (badge.id)}
      <div 
        class="card bg-base-200 border shadow-xl relative overflow-hidden transition-all duration-300 {badge.unlocked ? 'border-amber-500/40 bg-gradient-to-br from-base-200 to-amber-500/5' : 'border-base-300 opacity-60'}"
      >
        {#if badge.unlocked}
          <!-- Golden corner ribbon for unlocked badge -->
          <div class="absolute -right-12 -top-12 w-24 h-24 bg-amber-500 transform rotate-45 flex items-end justify-center pb-1 text-[10px] text-black font-extrabold uppercase tracking-wider z-20 shadow-md">
            <span>Win</span>
          </div>
        {/if}

        <div class="card-body p-6 flex flex-row items-start gap-4">
          <!-- Badge Icon -->
          <div 
            class="w-14 h-14 rounded-2xl flex-shrink-0 text-3xl flex items-center justify-center border-2 shadow-inner {badge.unlocked ? 'bg-amber-500/10 border-amber-500 animate-pulse-slow' : 'bg-base-300 border-base-300'}"
          >
            {badge.icon}
          </div>

          <!-- Description -->
          <div class="space-y-1.5 flex-grow">
            <h3 class="font-bold text-lg leading-none flex items-center gap-1.5">
              {badge.title}
              {#if !badge.unlocked}
                <span class="badge badge-neutral badge-xs text-neutral-content">Locked</span>
              {/if}
            </h3>
            
            <p class="text-xs text-neutral-content leading-relaxed pr-6">{badge.description}</p>

            {#if badge.unlocked}
              <div class="flex items-center gap-1 text-[10px] text-amber-500 font-bold uppercase pt-1">
                <Calendar class="h-3 w-3" />
                <span>Unlocked on: {badge.unlockedAt}</span>
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>
