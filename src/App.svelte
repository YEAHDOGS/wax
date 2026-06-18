<script>
  import Navbar from './lib/Navbar.svelte';
  import AlertsEngine from './lib/AlertsEngine.svelte';
  import CrateCatalog from './lib/CrateCatalog.svelte';
  import StatsPanel from './lib/StatsPanel.svelte';
  import SocialFeed from './lib/SocialFeed.svelte';
  import Achievements from './lib/Achievements.svelte';
  import Settings from './lib/Settings.svelte';
  import { appState } from './lib/store.svelte.js';
</script>

<div class="min-h-screen bg-base-300 flex flex-col font-sans transition-all duration-300">
  <Navbar />
  
  <main class="flex-grow p-4 md:p-8 max-w-7xl w-full mx-auto pb-16">
    {#if appState.currentView === 'dashboard'}
      <AlertsEngine />
    {:else if appState.currentView === 'crate'}
      <CrateCatalog />
    {:else if appState.currentView === 'stats'}
      <StatsPanel />
    {:else if appState.currentView === 'feed'}
      <SocialFeed />
    {:else if appState.currentView === 'achievements'}
      <Achievements />
    {:else if appState.currentView === 'settings'}
      <Settings />
    {/if}
  </main>
  
  <!-- Sticky Footer -->
  <footer class="footer footer-center p-6 bg-base-200 text-base-content border-t border-base-300 mt-auto">
    <aside class="space-y-1">
      <div class="flex items-center gap-1.5 justify-center font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-pink-500">
        <span>WaxOnWax</span>
      </div>
      <p class="text-xs text-neutral-content">© 2026 WaxOnWax Engine - Designed for audiophiles and vinyl variant collectors.</p>
    </aside>
  </footer>
</div>
