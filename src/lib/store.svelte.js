// Shared reactive state for WaxOnWax using Svelte 5 runes
import { initSurreal, dbOperations } from './db.js';

export const appState = $state({
  currentView: 'dashboard',
  theme: (typeof window !== 'undefined' ? localStorage.getItem('wax_theme') : 'night') || 'night',
  favorites: ['Daft Punk', 'Taylor Swift', 'Kendrick Lamar', 'Pink Floyd', 'Tame Impala'],
  keywords: ['Limited', 'Liquid Filled', 'Numbered', 'Colored', 'Box Set', 'Picture Disc', 'Alternative Cover'],
  spotifyConnected: false,
  spotifyUser: null,
  appleMusicConnected: false,
  appleMusicUser: null,
  discogsConnected: (typeof window !== 'undefined' ? !!localStorage.getItem('discogs_access_token') : false),
  discogsUsername: (typeof window !== 'undefined' ? localStorage.getItem('discogs_username') : null),
  checklistArtist: null,
  checklistReleases: [],
  checklistLoading: false,
  checklistError: null,
  
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

const isLive = typeof import.meta !== 'undefined' && import.meta.env.MODE === 'live';

// Helper actions to modify the state
export const actions = {
  setView(view) {
    appState.currentView = view;
  },

  setTheme(themeName) {
    appState.theme = themeName;
    if (typeof window !== 'undefined') {
      localStorage.setItem('wax_theme', themeName);
      document.documentElement.setAttribute('data-theme', themeName);
    }
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

  async addToCrate(record) {
    const id = 'c_' + Date.now();
    const newRecord = {
      id,
      rating: 5,
      ...record
    };
    appState.crate = [newRecord, ...appState.crate];
    this.checkAchievements();

    if (isLive) {
      await dbOperations.createRecord(newRecord);
    }
  },

  async removeFromCrate(id) {
    appState.crate = appState.crate.filter(r => r.id !== id);
    this.checkAchievements();

    if (isLive) {
      await dbOperations.deleteRecord(id);
    }
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

  async connectDiscogs(username = 'DiggingDreamer') {
    appState.discogsConnected = true;
    appState.discogsUsername = username;

    // Unlock Discogs Power User achievement
    this.unlockAchievement('a3');

    if (isLive) {
      try {
        const key = process.env.DISCOGS_CONSUMER_KEY || '';
        const secret = process.env.DISCOGS_CONSUMER_SECRET || '';
        const url = `https://api.discogs.com/users/${username}/collection/folders/0/releases?key=${key}&secret=${secret}`;
        
        console.log('Fetching live Discogs collection from:', url);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('Failed to fetch from Discogs API');
        }
        
        const data = await response.json();
        const releases = data.releases || [];
        
        const newRecords = [];
        for (const item of releases) {
          const basic = item.basic_information;
          const artist = basic.artists.map(a => a.name).join(', ');
          const album = basic.title;
          const year = basic.year || new Date().getFullYear();
          const genre = basic.genres ? basic.genres[0] : 'General';
          const coverUrl = basic.cover_image || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80';
          
          // Format pressing details from formats
          const formats = basic.formats || [];
          const variant = formats.map(f => f.name + (f.descriptions ? ' (' + f.descriptions.join(', ') + ')' : '')).join(', ') || 'Standard Pressing';
          
          const record = {
            id: 'c_' + Date.now() + Math.random().toString().slice(2, 6),
            artist,
            album,
            variant,
            retailer: 'Discogs Collection',
            year,
            genre,
            rating: 5,
            notes: 'Imported from real Discogs collection.',
            coverUrl,
            color: '#3b82f6'
          };
          
          // Add to SurrealDB
          await dbOperations.createRecord(record);
          newRecords.push(record);
        }
        
        if (newRecords.length > 0) {
          appState.crate = [...newRecords, ...appState.crate];
        }
      } catch (error) {
        console.error('Discogs collection sync error:', error);
      }
    } else {
      // Sync premium records from Discogs to the crate!
      const discogsRecords = [
        {
          artist: 'Gorillaz',
          album: 'Demon Days',
          variant: '2xLP Red Translucent (VMP Exclusive)',
          retailer: 'Vinyl Me, Please',
          year: 2005,
          genre: 'Alternative',
          rating: 5,
          notes: 'Synced from Discogs collection. Sounds extremely dynamic with high bass presence.',
          coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
          color: '#dc2626'
        },
        {
          artist: 'Radiohead',
          album: 'Kid A Mnesia',
          variant: '3xLP Red Vinyl Box Set',
          retailer: 'XL Recordings',
          year: 2021,
          genre: 'Rock',
          rating: 5,
          notes: 'Synced from Discogs. Beautiful triple-gatefold book design.',
          coverUrl: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80',
          color: '#b91c1c'
        },
        {
          artist: 'Tame Impala',
          album: 'Lonerism',
          variant: '10th Anniversary 3xLP Box Set',
          retailer: 'Modular Recordings',
          year: 2012,
          genre: 'Alternative',
          rating: 4,
          notes: 'Synced from Discogs. Contains unreleased demos and session recordings.',
          coverUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80',
          color: '#d97706'
        },
        {
          artist: 'Lana Del Rey',
          album: 'Born to Die',
          variant: 'Red Marbled LP (Target Exclusive)',
          retailer: 'Interscope Records',
          year: 2012,
          genre: 'Pop',
          rating: 5,
          notes: 'Synced from Discogs. Marbling is gorgeous.',
          coverUrl: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=400&q=80',
          color: '#ea580c'
        },
        {
          artist: 'Mac Miller',
          album: 'Circles',
          variant: '2xLP Clear Vinyl',
          retailer: 'Warner Records',
          year: 2020,
          genre: 'Hip Hop',
          rating: 4,
          notes: 'Synced from Discogs. Posthumous masterpiece pressing.',
          coverUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
          color: '#f8fafc'
        },
        {
          artist: 'Tyler, The Creator',
          album: 'IGOR',
          variant: 'Mint Green Gatefold (Special Edition)',
          retailer: 'Columbia Records',
          year: 2019,
          genre: 'Hip Hop',
          rating: 5,
          notes: 'Synced from Discogs. Custom cover is highly striking.',
          coverUrl: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80',
          color: '#10b981'
        }
      ];

      discogsRecords.forEach(record => {
        // Add if not already in crate
        const exists = appState.crate.some(r => r.artist === record.artist && r.album === record.album);
        if (!exists) {
          appState.crate.push({
            id: 'c_' + Date.now() + Math.random(),
            ...record
          });
        }
      });
    }

    this.checkAchievements();
  },

  async startDiscogsLogin() {
    if (typeof window === 'undefined') return;

    if (!isLive) {
      this.connectDiscogs('DiggingDreamer');
      return;
    }

    // Open a popup window immediately to prevent popup blockers
    const width = 600;
    const height = 700;
    const left = (window.screen.width / 2) - (width / 2);
    const top = (window.screen.height / 2) - (height / 2);
    const popup = window.open('about:blank', 'Discogs Authorization', `width=${width},height=${height},top=${top},left=${left}`);
    
    if (popup) {
      popup.document.write('<div style="font-family: sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; background:#121214; color:#e1e1e6; font-size:16px;">Connecting to Discogs official login...</div>');
    }

    try {
      const consumerKey = process.env.DISCOGS_CONSUMER_KEY || '';
      const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET || '';
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Math.random().toString(36).substring(2);
      const callbackUrl = encodeURIComponent(window.location.origin + '/?discogs_callback=true');

      const authHeader = `OAuth ` +
        `oauth_consumer_key="${consumerKey}", ` +
        `oauth_nonce="${nonce}", ` +
        `oauth_signature="${consumerSecret}&", ` +
        `oauth_signature_method="PLAINTEXT", ` +
        `oauth_timestamp="${timestamp}", ` +
        `oauth_callback="${callbackUrl}"`;

      console.log('Requesting Discogs Request Token...');
      const response = await fetch('/api/discogs/oauth/request_token', {
        headers: {
          'Authorization': authHeader
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch Discogs request token');
      }

      const text = await response.text();
      const params = new URLSearchParams(text);
      const requestToken = params.get('oauth_token');
      const requestTokenSecret = params.get('oauth_token_secret');

      if (requestToken && requestTokenSecret) {
        localStorage.setItem('discogs_request_token_secret', requestTokenSecret);
        
        // Redirect the popup to the official Discogs authorize page
        if (popup) {
          popup.location.href = `https://www.discogs.com/oauth/authorize?oauth_token=${requestToken}`;
        }
      } else {
        if (popup) popup.close();
      }
    } catch (error) {
      console.error('Error starting Discogs OAuth flow:', error);
      if (popup) popup.close();
    }
  },

  async exchangeDiscogsToken(oauthToken, oauthVerifier) {
    try {
      const consumerKey = process.env.DISCOGS_CONSUMER_KEY || '';
      const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET || '';
      const requestTokenSecret = localStorage.getItem('discogs_request_token_secret') || '';
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Math.random().toString(36).substring(2);

      const authHeader = `OAuth ` +
        `oauth_consumer_key="${consumerKey}", ` +
        `oauth_nonce="${nonce}", ` +
        `oauth_signature="${consumerSecret}&${requestTokenSecret}", ` +
        `oauth_signature_method="PLAINTEXT", ` +
        `oauth_timestamp="${timestamp}", ` +
        `oauth_token="${oauthToken}", ` +
        `oauth_verifier="${oauthVerifier}"`;

      console.log('Exchanging request token for Discogs Access Token...');
      const response = await fetch('/api/discogs/oauth/access_token', {
        headers: {
          'Authorization': authHeader
        }
      });

      if (!response.ok) {
        throw new Error('Failed to exchange Discogs access token');
      }

      const text = await response.text();
      const params = new URLSearchParams(text);
      const accessToken = params.get('oauth_token');
      const accessTokenSecret = params.get('oauth_token_secret');

      if (accessToken && accessTokenSecret) {
        localStorage.setItem('discogs_access_token', accessToken);
        localStorage.setItem('discogs_access_token_secret', accessTokenSecret);
        appState.discogsConnected = true;

        // Sync the collection now
        await this.syncDiscogsCollection();
      }
    } catch (error) {
      console.error('Error exchanging access token:', error);
    }
  },

  async syncDiscogsCollection() {
    try {
      const consumerKey = process.env.DISCOGS_CONSUMER_KEY || '';
      const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET || '';
      const accessToken = localStorage.getItem('discogs_access_token') || '';
      const accessTokenSecret = localStorage.getItem('discogs_access_token_secret') || '';
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Math.random().toString(36).substring(2);

      // 1. Fetch User Identity
      let authHeader = `OAuth ` +
        `oauth_consumer_key="${consumerKey}", ` +
        `oauth_nonce="${nonce}", ` +
        `oauth_signature="${consumerSecret}&${accessTokenSecret}", ` +
        `oauth_signature_method="PLAINTEXT", ` +
        `oauth_timestamp="${timestamp}", ` +
        `oauth_token="${accessToken}"`;

      console.log('Fetching Discogs user identity...');
      const identityResponse = await fetch('/api/discogs/oauth/identity', {
        headers: {
          'Authorization': authHeader
        }
      });

      if (!identityResponse.ok) {
        throw new Error('Failed to fetch user identity');
      }

      const identityData = await identityResponse.json();
      const username = identityData.username;

      if (!username) {
        throw new Error('Username not returned from identity');
      }

      appState.discogsUsername = username;
      localStorage.setItem('discogs_username', username);
      this.unlockAchievement('a3');

      // 2. Fetch User Collection (paginated)
      let page = 1;
      let pages = 1;
      const newRecords = [];

      while (page <= pages) {
        const nextTimestamp = Math.floor(Date.now() / 1000);
        const nextNonce = Math.random().toString(36).substring(2);
        
        authHeader = `OAuth ` +
          `oauth_consumer_key="${consumerKey}", ` +
          `oauth_nonce="${nextNonce}", ` +
          `oauth_signature="${consumerSecret}&${accessTokenSecret}", ` +
          `oauth_signature_method="PLAINTEXT", ` +
          `oauth_timestamp="${nextTimestamp}", ` +
          `oauth_token="${accessToken}"`;

        console.log(`Fetching collection releases for Discogs user ${username} (page ${page}/${pages})...`);
        const collectionResponse = await fetch(`/api/discogs/users/${username}/collection/folders/0/releases?per_page=50&page=${page}`, {
          headers: {
            'Authorization': authHeader
          }
        });

        if (!collectionResponse.ok) {
          throw new Error(`Failed to fetch collection releases (page ${page})`);
        }

        const collectionData = await collectionResponse.json();
        
        if (collectionData.pagination) {
          pages = collectionData.pagination.pages || 1;
        }

        const releases = collectionData.releases || [];
        console.log(`Loaded ${releases.length} releases from page ${page} of collection API.`);

        for (const item of releases) {
          const basic = item.basic_information;
          const artist = basic.artists.map(a => a.name).join(', ');
          const album = basic.title;
          const year = basic.year || new Date().getFullYear();
          const genre = basic.genres ? basic.genres[0] : 'General';
          const coverUrl = basic.cover_image || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80';
          
          // Format pressing details from formats
          const formats = basic.formats || [];
          const variant = formats.map(f => f.name + (f.descriptions ? ' (' + f.descriptions.join(', ') + ')' : '')).join(', ') || 'Standard Pressing';
          
          // Determine theme color from variant names
          let color = '#3b82f6';
          const vLower = variant.toLowerCase();
          if (vLower.includes('red')) color = '#dc2626';
          else if (vLower.includes('orange')) color = '#f97316';
          else if (vLower.includes('pink')) color = '#ec4899';
          else if (vLower.includes('green')) color = '#10b981';
          else if (vLower.includes('yellow')) color = '#eab308';
          else if (vLower.includes('purple')) color = '#a855f7';
          else if (vLower.includes('clear') || vLower.includes('transparent')) color = '#f8fafc';
          else if (vLower.includes('black')) color = '#09090b';

          const record = {
            id: 'c_' + Date.now() + Math.random().toString().slice(2, 6),
            artist,
            album,
            variant,
            retailer: 'Discogs Collection',
            year,
            genre,
            rating: 5,
            notes: `Synced from Discogs collection. Catalog ID: ${basic.id}`,
            coverUrl,
            discogsUrl: `https://www.discogs.com/release/${basic.id}`,
            color
          };

          if (isLive) {
            await dbOperations.createRecord(record);
          }
          newRecords.push(record);
        }
        
        page++;
      }

      if (newRecords.length > 0) {
        const existingKeys = new Set(appState.crate.map(r => r.artist.toLowerCase() + '::' + r.album.toLowerCase()));
        const uniqueNew = newRecords.filter(r => !existingKeys.has(r.artist.toLowerCase() + '::' + r.album.toLowerCase()));
        appState.crate = [...uniqueNew, ...appState.crate];
      }
    } catch (error) {
      console.error('Error syncing Discogs collection:', error);
    }
  },

  async fetchArtistDiscography(artistName) {
    appState.checklistLoading = true;
    appState.checklistArtist = artistName;
    appState.checklistReleases = [];
    appState.checklistError = null;

    const query = artistName.trim();
    if (!query) {
      appState.checklistLoading = false;
      return;
    }

    const consumerKey = process.env.DISCOGS_CONSUMER_KEY || '';
    const consumerSecret = process.env.DISCOGS_CONSUMER_SECRET || '';
    const accessToken = localStorage.getItem('discogs_access_token') || '';
    const accessTokenSecret = localStorage.getItem('discogs_access_token_secret') || '';

    const getMockDiscography = (artist) => {
      const lower = artist.toLowerCase();
      if (lower.includes('dylan')) {
        return [
          { id: 4056, title: 'Bob Dylan - Highway 61 Revisited', year: '1965', cover_image: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/4056' },
          { id: 3986, title: 'Bob Dylan - Blonde on Blonde', year: '1966', cover_image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/3986' },
          { id: 3823, title: 'Bob Dylan - Blood on the Tracks', year: '1975', cover_image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/3823' },
          { id: 3795, title: 'Bob Dylan - The Freewheelin\' Bob Dylan', year: '1963', cover_image: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/3795' },
          { id: 4016, title: 'Bob Dylan - Bringing It All Back Home', year: '1965', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/4016' },
          { id: 18884, title: 'Bob Dylan - Time Out of Mind', year: '1997', cover_image: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/18884' },
          { id: 28122, title: 'Bob Dylan - Desire', year: '1976', cover_image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/28122' }
        ];
      } else if (lower.includes('punk')) {
        return [
          { id: 26647, title: 'Daft Punk - Homework', year: '1997', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/26647' },
          { id: 26824, title: 'Daft Punk - Discovery', year: '2001', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/26824' },
          { id: 26978, title: 'Daft Punk - Human After All', year: '2005', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/26978' },
          { id: 538799, title: 'Daft Punk - Random Access Memories', year: '2013', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/538799' }
        ];
      } else {
        return [
          { id: 10001, title: `${artistName} - Greatest Hits Vol. 1`, year: '2010', cover_image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/10001' },
          { id: 10002, title: `${artistName} - Debut Album`, year: '2012', cover_image: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/10002' },
          { id: 10003, title: `${artistName} - Live Sessions`, year: '2015', cover_image: 'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/10003' },
          { id: 10004, title: `${artistName} - The Remixes`, year: '2018', cover_image: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=400&q=80', resource_url: 'https://www.discogs.com/master/10004' }
        ];
      }
    };

    if (!isLive || (!accessToken && !consumerKey)) {
      setTimeout(() => {
        appState.checklistReleases = getMockDiscography(query);
        appState.checklistLoading = false;
      }, 600);
      return;
    }

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = Math.random().toString(36).substring(2);
      
      let authHeader;
      if (accessToken && accessTokenSecret) {
        authHeader = `OAuth ` +
          `oauth_consumer_key="${consumerKey}", ` +
          `oauth_nonce="${nonce}", ` +
          `oauth_signature="${consumerSecret}&${accessTokenSecret}", ` +
          `oauth_signature_method="PLAINTEXT", ` +
          `oauth_timestamp="${timestamp}", ` +
          `oauth_token="${accessToken}"`;
      } else {
        authHeader = `Discogs key=${consumerKey}, secret=${consumerSecret}`;
      }

      const url = `/api/discogs/database/search?artist=${encodeURIComponent(query)}&type=master&per_page=40`;
      console.log('Searching artist discography:', url);
      
      const response = await fetch(url, {
        headers: {
          'Authorization': authHeader
        }
      });

      if (!response.ok) {
        throw new Error('Discogs search failed');
      }

      const data = await response.json();
      const results = data.results || [];
      
      appState.checklistReleases = results.map(r => ({
        id: r.id,
        title: r.title,
        year: r.year || 'Unknown',
        cover_image: r.cover_image || r.thumb || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
        resource_url: r.uri ? `https://www.discogs.com${r.uri}` : `https://www.discogs.com/master/${r.id}`
      }));
    } catch (err) {
      console.error('Checklist search error:', err);
      appState.checklistError = err.message;
      appState.checklistReleases = getMockDiscography(query);
    } finally {
      appState.checklistLoading = false;
    }
  },

  disconnectDiscogs() {
    appState.discogsConnected = false;
    appState.discogsUsername = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('discogs_access_token');
      localStorage.removeItem('discogs_access_token_secret');
      localStorage.removeItem('discogs_username');
    }
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

if (typeof window !== 'undefined') {
  // Listen for the callback message from our OAuth popup
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'DISCOGS_CALLBACK') {
      const { oauthToken, oauthVerifier } = event.data;
      actions.exchangeDiscogsToken(oauthToken, oauthVerifier);
    }
  });

  // Handle popup closure when redirected back from Discogs
  if (window.opener && window.location.search.includes('oauth_verifier')) {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('oauth_token');
    const oauthVerifier = params.get('oauth_verifier');
    
    // Post the tokens back to the parent window
    window.opener.postMessage({
      type: 'DISCOGS_CALLBACK',
      oauthToken,
      oauthVerifier
    }, window.location.origin);
    
    // Close the popup window
    window.close();
  }
}

if (isLive) {
  (async () => {
    try {
      const db = await initSurreal();
      if (db) {
        const dbRecords = await dbOperations.getAllRecords();
        if (dbRecords && dbRecords.length > 0) {
          // Map database IDs to Svelte crate records
          appState.crate = dbRecords;
        } else {
          // Seed default mock records into SurrealDB if empty
          for (const item of appState.crate) {
            await dbOperations.createRecord(item);
          }
        }

        // If Discogs is connected on startup, automatically sync collection updates
        if (appState.discogsConnected) {
          actions.syncDiscogsCollection();
        }
      }
    } catch (err) {
      console.error('SurrealDB initialization error inside store:', err);
    }
  })();
}
