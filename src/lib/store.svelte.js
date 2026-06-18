// Shared reactive state for WaxOnWax using Svelte 5 runes
export const appState = $state({
  currentView: 'dashboard',
  favorites: ['Daft Punk', 'Taylor Swift', 'Kendrick Lamar', 'Pink Floyd', 'Tame Impala'],
  keywords: ['Limited', 'Liquid Filled', 'Numbered', 'Colored', 'Box Set', 'Picture Disc', 'Alternative Cover'],
  spotifyConnected: false,
  spotifyUser: null,
  appleMusicConnected: false,
  appleMusicUser: null,
  
  // Seeded vinyl collection
  crate: [
    {
      id: 'c1',
      artist: 'Daft Punk',
      album: 'Discovery',
      variant: '2xLP Orange Translucent Vinyl',
      retailer: 'Toyokasei Japan',
      year: 2001,
      genre: 'Electronic',
      rating: 5,
      notes: 'Extremely rare colored Japanese pressing. Sounds absolute gold!',
      coverUrl: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80',
      color: '#f97316'
    },
    {
      id: 'c2',
      artist: 'Taylor Swift',
      album: 'Midnights',
      variant: 'Liquid-Filled Blue Variant (Hand-crafted)',
      retailer: 'Blood Records',
      year: 2022,
      genre: 'Pop',
      rating: 5,
      notes: 'Only 500 copies made. Visually stunning liquid center.',
      coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
      color: '#0284c7'
    },
    {
      id: 'c3',
      artist: 'Kendrick Lamar',
      album: 'Good Kid, M.A.A.D City',
      variant: '10th Anniversary Clear Vinyl',
      retailer: 'Interscope Records',
      year: 2012,
      genre: 'Hip Hop',
      rating: 4,
      notes: 'Classic gatefold clear variant. Repress sounds pristine.',
      coverUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80',
      color: '#e2e8f0'
    },
    {
      id: 'c4',
      artist: 'Pink Floyd',
      album: 'The Dark Side of the Moon',
      variant: 'UV-Printed Picture Disc (50th Ann.)',
      retailer: 'Harvest Records',
      year: 1973,
      genre: 'Rock',
      rating: 5,
      notes: 'Prism artwork printed directly on the grooves. Playback has slight surface noise but looks incredible.',
      coverUrl: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80',
      color: '#8b5cf6'
    }
  ],

  // Live Reddit drops
  drops: [],
  isLoadingDrops: false,
  lastScrapeTime: null,
  
  // Notification history
  notificationLogs: [
    {
      id: 'l1',
      time: new Date(Date.now() - 3600000).toLocaleTimeString(),
      type: 'SMS',
      recipient: '+1 (555) 932-9290',
      message: '🚨 MATCHED: Taylor Swift - Midnights [Liquid Filled] is back in stock at Blood Records!',
      status: 'Delivered'
    },
    {
      id: 'l2',
      time: new Date(Date.now() - 7200000).toLocaleTimeString(),
      type: 'Email',
      recipient: 'digging@crateking.com',
      message: '📬 WaxOnWax Alert: Daft Punk - Discovery Orange Translucent restock detected!',
      status: 'Sent'
    }
  ],

  // Social feed posts
  feedPosts: [
    {
      id: 'p1',
      user: 'VinylViking',
      avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=viking',
      time: '2 hours ago',
      content: 'Just arrived! The Blood Records liquid-filled variant of Midnights. It is even prettier in person. The liquid flows smoothly and the pressing sounds surprisingly quiet for a specialty disc!',
      image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=600&q=80',
      likes: 24,
      comments: 7,
      hasLiked: false
    },
    {
      id: 'p2',
      user: 'CrateDigger42',
      avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=digger',
      time: '5 hours ago',
      content: 'Looking for a trade! I have an extra copy of Kendrick Lamar\'s clear anniversary variant. Looking for any Daft Punk colored pressings or cool vaporwave variants. DM me!',
      likes: 12,
      comments: 3,
      hasLiked: false
    }
  ],

  // Digital Achievements
  achievements: [
    {
      id: 'a1',
      title: 'First Press Fanatic',
      description: 'Add your first rare variant to your crate.',
      icon: '🏆',
      unlocked: true,
      unlockedAt: '2026-06-10'
    },
    {
      id: 'a2',
      title: 'Color Variant King',
      description: 'Catalog 3 or more colored vinyl records.',
      icon: '🎨',
      unlocked: true,
      unlockedAt: '2026-06-12'
    },
    {
      id: 'a3',
      title: 'Discogs Power User',
      description: 'Link your collection account and sync 10+ releases.',
      icon: '🔌',
      unlocked: false,
      unlockedAt: null
    },
    {
      // Streaming related achievement
      id: 'a4',
      title: 'Streaming Sync Explorer',
      description: 'Connect Spotify or Apple Music to import your recently played and favorite artists.',
      icon: '🟢',
      unlocked: false,
      unlockedAt: null
    },
    {
      id: 'a5',
      title: 'First Alert Match',
      description: 'Have one of your favorite artists trigger a real-time Reddit drop match.',
      icon: '⚡',
      unlocked: false,
      unlockedAt: null
    }
  ]
});

// Helper actions to modify the state
export const actions = {
  setView(view) {
    appState.currentView = view;
  },

  addFavoriteArtist(artist) {
    const trimmed = artist.trim();
    if (trimmed && !appState.favorites.includes(trimmed)) {
      appState.favorites = [...appState.favorites, trimmed];
      this.checkAchievements();
    }
  },

  removeFavoriteArtist(artist) {
    appState.favorites = appState.favorites.filter(a => a !== artist);
  },

  addKeyword(keyword) {
    const trimmed = keyword.trim();
    if (trimmed && !appState.keywords.includes(trimmed)) {
      appState.keywords = [...appState.keywords, trimmed];
    }
  },

  removeKeyword(keyword) {
    appState.keywords = appState.keywords.filter(k => k !== keyword);
  },

  addToCrate(record) {
    const newRecord = {
      id: 'c_' + Date.now(),
      rating: 5,
      ...record
    };
    appState.crate = [newRecord, ...appState.crate];
    this.checkAchievements();
  },

  removeFromCrate(id) {
    appState.crate = appState.crate.filter(r => r.id !== id);
    this.checkAchievements();
  },

  addNotification(log) {
    const newLog = {
      id: 'l_' + Date.now(),
      time: new Date().toLocaleTimeString(),
      status: 'Sent',
      ...log
    };
    appState.notificationLogs = [newLog, ...appState.notificationLogs];
    
    // Unlock match achievement on first alert match
    const matchAch = appState.achievements.find(a => a.id === 'a5');
    if (matchAch && !matchAch.unlocked) {
      this.unlockAchievement('a5');
    }
  },

  addFeedPost(content, image = null) {
    const newPost = {
      id: 'p_' + Date.now(),
      user: 'Me (CrateMaster)',
      avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=me',
      time: 'Just now',
      content,
      image,
      likes: 0,
      comments: 0,
      hasLiked: false
    };
    appState.feedPosts = [newPost, ...appState.feedPosts];
  },

  likePost(id) {
    const post = appState.feedPosts.find(p => p.id === id);
    if (post) {
      if (post.hasLiked) {
        post.likes--;
        post.hasLiked = false;
      } else {
        post.likes++;
        post.hasLiked = true;
      }
    }
  },

  connectSpotify() {
    appState.spotifyConnected = true;
    appState.spotifyUser = {
      name: 'user',
      product: 'Premium',
      avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=user'
    };

    // Unlock Streaming Sync Explorer achievement
    this.unlockAchievement('a4');

    // Auto-sync a premium set of artists
    const spotifyArtists = ['Daft Punk', 'Taylor Swift', 'Kendrick Lamar', 'Pink Floyd', 'Tame Impala', 'Gorillaz', 'Radiohead', 'Billie Eilish'];
    spotifyArtists.forEach(artist => {
      if (!appState.favorites.includes(artist)) {
        appState.favorites = [...appState.favorites, artist];
      }
    });
  },

  disconnectSpotify() {
    appState.spotifyConnected = false;
    appState.spotifyUser = null;
  },

  connectAppleMusic() {
    appState.appleMusicConnected = true;
    appState.appleMusicUser = {
      name: 'user',
      product: 'Apple Music Individual',
      avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=brandox'
    };

    // Unlock Streaming Sync Explorer achievement
    this.unlockAchievement('a4');

    // Auto-sync top Apple Music recently listened artists
    const appleArtists = ['Radiohead', 'Gorillaz', 'Tame Impala', 'Daft Punk', 'Lana Del Rey', 'Tyler, The Creator', 'Mac Miller'];
    appleArtists.forEach(artist => {
      if (!appState.favorites.includes(artist)) {
        appState.favorites = [...appState.favorites, artist];
      }
    });
  },

  disconnectAppleMusic() {
    appState.appleMusicConnected = false;
    appState.appleMusicUser = null;
  },

  unlockAchievement(id) {
    const ach = appState.achievements.find(a => a.id === id);
    if (ach && !ach.unlocked) {
      ach.unlocked = true;
      ach.unlockedAt = new Date().toISOString().split('T')[0];
    }
  },

  checkAchievements() {
    // Check Color Variant King
    const colorCount = appState.crate.filter(r => r.variant && r.variant.toLowerCase().includes('vinyl') && !r.variant.toLowerCase().includes('black')).length;
    if (colorCount >= 3) {
      this.unlockAchievement('a2');
    }

    // Check First Press Fanatic
    if (appState.crate.length > 0) {
      this.unlockAchievement('a1');
    }
  }
};
