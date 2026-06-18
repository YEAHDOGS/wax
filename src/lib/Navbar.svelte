<script>
  import { appState, actions } from './store.svelte.js';
  import { 
    Disc, 
    Bell, 
    Settings as SettingsIcon, 
    Grid, 
    BarChart3, 
    MessageSquare, 
    Trophy, 
    Menu, 
    Music
  } from '@lucide/svelte';

  const menuItems = [
    { id: 'dashboard', label: 'Engine Alerts', icon: Disc },
    { id: 'crate', label: 'My Crate', icon: Grid },
    { id: 'stats', label: 'Crate Stats', icon: BarChart3 },
    { id: 'feed', label: 'Social Feed', icon: MessageSquare },
    { id: 'achievements', label: 'Badges', icon: Trophy },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  // Count unread matches (we simulate notifications)
  let notificationCount = $derived(appState.notificationLogs.length);
</script>

<div class="navbar bg-base-200 border-b border-base-300 sticky top-0 z-50 px-4 md:px-8">
  <div class="navbar-start">
    <!-- Mobile Menu Drawer Toggle -->
    <div class="dropdown lg:hidden">
      <button class="btn btn-ghost btn-circle" aria-label="Toggle Navigation Menu">
        <Menu class="h-6 w-6" />
      </button>
      <ul class="menu menu-sm dropdown-content mt-3 z-[1] p-2 shadow bg-base-200 rounded-box w-52 border border-base-300">
        {#each menuItems as item}
          {@const Icon = item.icon}
          <li>
            <button 
              class:active={appState.currentView === item.id}
              onclick={() => actions.setView(item.id)}
            >
              <Icon class="h-4 w-4" />
              {item.label}
            </button>
          </li>
        {/each}
      </ul>
    </div>
    
    <!-- Logo -->
    <button onclick={() => actions.setView('dashboard')} class="flex items-center gap-2 font-bold text-xl md:text-2xl text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-pink-500">
      <Disc class="h-6 w-6 text-purple-500 animate-spin-slow-paused" />
      <span>WaxOnWax</span>
    </button>
  </div>

  <!-- Desktop Menu Items -->
  <div class="navbar-center hidden lg:flex">
    <ul class="menu menu-horizontal px-1 gap-2">
      {#each menuItems as item}
        {@const Icon = item.icon}
        <li>
          <button 
            class="px-4 py-2 rounded-lg font-medium transition-all duration-200 flex items-center gap-2 {appState.currentView === item.id ? 'bg-primary text-primary-content neon-glow-primary' : 'hover:bg-base-300'}"
            onclick={() => actions.setView(item.id)}
          >
            <Icon class="h-4 w-4" />
            {item.label}
          </button>
        </li>
      {/each}
    </ul>
  </div>

  <div class="navbar-end gap-3">
    <!-- Active streaming integrations icons -->
    <div class="hidden sm:flex items-center gap-2">
      {#if appState.spotifyConnected}
        <div class="tooltip tooltip-bottom" data-tip="Spotify Synced">
          <div class="badge badge-success gap-1 text-xs text-white">
            <span class="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span>
            Spotify
          </div>
        </div>
      {/if}
      {#if appState.appleMusicConnected}
        <div class="tooltip tooltip-bottom" data-tip="Apple Music Synced">
          <div class="badge badge-error gap-1 text-xs text-white">
            <span class="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span>
            Apple Music
          </div>
        </div>
      {/if}
    </div>

    <!-- Notification Log Trigger / Dropdown -->
    <div class="dropdown dropdown-end">
      <button class="btn btn-ghost btn-circle" aria-label="View Alerts Notification history">
        <div class="indicator">
          <Bell class="h-5 w-5" />
          {#if notificationCount > 0}
            <span class="badge badge-xs badge-secondary indicator-item">{notificationCount}</span>
          {/if}
        </div>
      </button>
      <div class="card card-compact dropdown-content w-80 shadow-2xl bg-base-200 border border-base-300 mt-3 z-[50]">
        <div class="card-body">
          <h3 class="font-bold text-lg border-b border-base-300 pb-2 flex items-center justify-between">
            <span>Recent Alerts</span>
            <span class="badge badge-secondary">{notificationCount} sent</span>
          </h3>
          <div class="max-h-60 overflow-y-auto space-y-2 py-1">
            {#if appState.notificationLogs.length === 0}
              <p class="text-center py-4 text-xs text-neutral-content">No notification logs recorded</p>
            {:else}
              {#each appState.notificationLogs.slice(0, 5) as log}
                <div class="text-xs border-b border-base-300/40 pb-2 last:border-0">
                  <div class="flex justify-between font-bold text-neutral-content mb-1">
                    <span>{log.type} to {log.recipient.substring(0, 12)}...</span>
                    <span>{log.time}</span>
                  </div>
                  <p class="line-clamp-2 text-base-content">{log.message}</p>
                </div>
              {/each}
            {/if}
          </div>
          <div class="card-actions mt-2">
            <button onclick={() => actions.setView('dashboard')} class="btn btn-primary btn-sm btn-block">Go to Alert Dashboard</button>
          </div>
        </div>
      </div>
    </div>

    <!-- User Profile Dropdown -->
    <div class="dropdown dropdown-end">
      <div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar border border-base-300/50">
        <div class="w-10 rounded-full bg-base-300">
          <img 
            alt="User profile avatar" 
            src={appState.spotifyUser?.avatar || appState.appleMusicUser?.avatar || "https://api.dicebear.com/7.x/pixel-art/svg?seed=cratemaster"} 
          />
        </div>
      </div>
      <ul class="menu menu-sm dropdown-content mt-3 z-[50] p-2 shadow bg-base-200 rounded-box w-52 border border-base-300">
        <li class="menu-title text-neutral-content">Collector Profile</li>
        <li>
          <div class="flex flex-col items-start gap-0.5">
            <span class="font-bold">{appState.spotifyUser?.name || appState.appleMusicUser?.name || "CrateMaster"}</span>
            <span class="text-xs text-secondary font-medium">Level 4 Crate Digger</span>
          </div>
        </li>
        <div class="divider my-1"></div>
        <li><button onclick={() => actions.setView('crate')}>My Collection</button></li>
        <li><button onclick={() => actions.setView('achievements')}>My Badges</button></li>
        <li><button onclick={() => actions.setView('settings')}>Alert Settings</button></li>
      </ul>
    </div>
  </div>
</div>
